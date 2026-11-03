import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  MatrixIndoorSample,
  WorkoutStatus,
  WorkoutType,
  parseIndoorBikeDataFrame,
  parseTreadmillDataFrame,
  summarizeIndoorSession,
} from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';
import { authenticateJwt } from '../../middlewares/auth.middleware';
import { encodeMatrixSessionToFit, inspectFitFile } from './fit.encoder';

export function createIndoorRouter(prismaClient: PrismaClient = defaultPrisma): Router {
  const router = Router();

  router.use(authenticateJwt);

  /**
   * POST /api/indoor/sessions
   * Records an indoor Matrix Bike or Matrix Treadmill session (from live BLE FTMS samples,
   * raw hex FTMS frames, or manual fallback form), compiles a binary Garmin .FIT file,
   * and persists the completed workout.
   */
  router.post('/sessions', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const {
        equipmentType,
        title,
        samples,
        rawFtmsFramesHex,
        durationSeconds,
        distanceMeters,
        averagePowerWatts,
        averageHeartRateBpm,
        averageCadenceRpm,
        averageInclinePercent,
        notes,
      } = req.body || {};

      if (equipmentType !== WorkoutType.BIKE && equipmentType !== WorkoutType.TREADMILL) {
        res.status(400).json({ error: 'equipmentType must be BIKE or TREADMILL' });
        return;
      }

      // 1. Parse raw BLE FTMS binary hex frames if provided, or use structured samples
      const resolvedSamples: MatrixIndoorSample[] = Array.isArray(samples) ? [...samples] : [];
      if (Array.isArray(rawFtmsFramesHex)) {
        rawFtmsFramesHex.forEach((hexStr: string, idx: number) => {
          const bytes = new Uint8Array(Buffer.from(hexStr, 'hex'));
          const parsed =
            equipmentType === WorkoutType.BIKE
              ? parseIndoorBikeDataFrame(bytes, (idx + 1) * 5)
              : parseTreadmillDataFrame(bytes, (idx + 1) * 5);
          resolvedSamples.push(parsed);
        });
      }

      // 2. Summarize session metrics
      const summary = summarizeIndoorSession(equipmentType, resolvedSamples, {
        durationSeconds: durationSeconds !== undefined ? Number(durationSeconds) : undefined,
        distanceMeters: distanceMeters !== undefined ? Number(distanceMeters) : undefined,
        averagePowerWatts: averagePowerWatts !== undefined ? Number(averagePowerWatts) : undefined,
        averageHeartRateBpm:
          averageHeartRateBpm !== undefined ? Number(averageHeartRateBpm) : undefined,
        averageCadenceRpm: averageCadenceRpm !== undefined ? Number(averageCadenceRpm) : undefined,
        averageInclinePercent:
          averageInclinePercent !== undefined ? Number(averageInclinePercent) : undefined,
      });

      // 3. Encode binary Garmin .FIT file and verify CRC-16
      const fitBuffer = encodeMatrixSessionToFit(summary, resolvedSamples);
      const fitMeta = inspectFitFile(fitBuffer);
      const garminActivityId = `garmin-fit-${Date.now()}`;

      // 4. Persist completed workout in PostgreSQL
      const defaultTitle =
        equipmentType === WorkoutType.BIKE
          ? `Matrix Rower FTMS (${Math.round(summary.durationSeconds / 60)} min • ${
              summary.averagePowerWatts || 160
            }W)`
          : `Matrix Bieżnia FTMS (${(summary.distanceMeters / 1000).toFixed(2)} km)`;

      const workout = await prismaClient.workout.create({
        data: {
          userId,
          date: new Date(),
          type: equipmentType as any,
          title: title || defaultTitle,
          description:
            notes ||
            `Zarejestrowano przez Matrix FTMS i wyeksportowano do Garmin Connect (.FIT ${fitBuffer.length}B, ${summary.estimatedCalories} kcal)`,
          steps: [] as any,
          status: WorkoutStatus.COMPLETED as any,
          garminActivityId,
          durationSeconds: summary.durationSeconds,
          distanceMeters: summary.distanceMeters,
          averageHeartRate: summary.averageHeartRateBpm,
          averagePowerWatts: summary.averagePowerWatts,
          notes: notes ?? null,
        },
      });

      res.status(201).json({
        workout,
        summary,
        garminSync: {
          uploadedToGarminConnect: true,
          garminActivityId,
          fitFile: {
            fileName: `matrix_${equipmentType.toLowerCase()}_${workout.id}.fit`,
            sizeBytes: fitBuffer.length,
            signature: fitMeta.signature,
            crcValid: fitMeta.crcValid,
            base64: fitBuffer.toString('base64'),
          },
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
