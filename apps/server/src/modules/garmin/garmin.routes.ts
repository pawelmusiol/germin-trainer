import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { WorkoutType } from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';
import { authenticateJwt } from '../../middlewares/auth.middleware';
import { IEncryptionService } from '../encryption/encryption.service';
import { IGarminConnectClient, defaultGarminClient } from './garmin.client';
import { GarminService } from './garmin.service';

export function createGarminRouter(
  prismaClient: PrismaClient = defaultPrisma,
  garminClient: IGarminConnectClient = defaultGarminClient,
  encryptionService?: IEncryptionService
): Router {
  const router = Router();
  const garminService = new GarminService(prismaClient, encryptionService, garminClient);

  router.use(authenticateJwt);

  /**
   * GET /api/garmin/status
   * Returns current Garmin Connect connection status for the authenticated user.
   */
  router.get('/status', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const status = await garminService.getConnectionStatus(userId);
      res.status(200).json({ status });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/garmin/connect
   * Authenticates with Garmin Connect (supports MFA challenge flow) and stores AES-256-GCM encrypted session.
   */
  router.post('/connect', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const { email, password, mfaCode } = req.body || {};

      if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
        res.status(400).json({ error: 'Garmin email and password are required' });
        return;
      }

      const status = await garminService.connectAccount(userId, {
        email,
        password,
        mfaCode,
      });

      const httpCode = status.mfaPending ? 202 : 200;
      res.status(httpCode).json({
        status,
        message: status.mfaPending
          ? 'MFA verification required. Please provide the 6-digit code sent by Garmin.'
          : 'Garmin Connect account linked successfully',
      });
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/garmin/mfa
   * Completes pending 2FA/MFA challenge with a 6-digit code.
   */
  router.post('/mfa', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const { mfaCode } = req.body || {};

      if (!mfaCode || typeof mfaCode !== 'string') {
        res.status(400).json({ error: 'mfaCode is required' });
        return;
      }

      const status = await garminService.verifyMfa(userId, mfaCode);
      res.status(200).json({
        status,
        message: 'Garmin MFA verified and account connected',
      });
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * DELETE /api/garmin/disconnect
   * Unlinks Garmin Connect account and deletes encrypted session tokens.
   */
  router.delete('/disconnect', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      await garminService.disconnectAccount(userId);
      res.status(200).json({
        connected: false,
        message: 'Garmin Connect account disconnected',
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/garmin/sync/metrics
   * Fetches HRV, Sleep Score, Resting HR, Body Battery, and Steps from Garmin Connect for a given date.
   */
  router.post('/sync/metrics', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const { date, perceivedFatigue, note } = req.body || {};

      const result = await garminService.syncDailyMetrics(userId, {
        date,
        perceivedFatigue,
        note,
      });

      res.status(200).json(result);
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/garmin/metrics
   * Lists recent DailyMetric records for the authenticated user.
   */
  router.get('/metrics', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const limit = Math.min(90, Math.max(1, Number(req.query.limit) || 14));

      const metrics = await prismaClient.dailyMetric.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        take: limit,
      });

      res.status(200).json({ metrics });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/garmin/sync/activities
   * Pulls recent completed activities from Garmin Connect and persists them into Workout history.
   */
  router.post('/sync/activities', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const limit = req.body?.limit ? Number(req.body.limit) : 5;

      const result = await garminService.syncRecentActivities(userId, limit);
      res.status(200).json(result);
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/garmin/workouts/:id/push
   * Builds GarminWorkoutPayload JSON and uploads + schedules the workout on the user's Garmin Calendar.
   */
  router.post('/workouts/:id/push', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const workoutId = req.params.id;

      const result = await garminService.pushWorkoutToGarmin(userId, workoutId);
      res.status(200).json(result);
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/garmin/workouts/:id/convert
   * 1-Click On-Demand Workout Modality Converter (RUN <-> BIKE).
   */
  router.post('/workouts/:id/convert', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const workoutId = req.params.id;
      const { targetType, riderWeightKg } = req.body || {};

      if (
        targetType !== WorkoutType.BIKE &&
        targetType !== WorkoutType.RUN &&
        targetType !== WorkoutType.HYBRID
      ) {
        res.status(400).json({ error: 'targetType must be RUN, BIKE, or HYBRID' });
        return;
      }

      const updatedWorkout = await garminService.convertWorkoutBetweenRunAndBike(
        userId,
        workoutId,
        targetType,
        riderWeightKg ? Number(riderWeightKg) : 72
      );

      res.status(200).json({ workout: updatedWorkout });
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
