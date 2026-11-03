import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  UserRole,
  WorkoutStatus,
  calculateProgressiveVdot,
  calculateRaceTimeFromVdot,
  calculateVdotFromRace,
  calculateVdotPaces,
  convertRunToBikeWatts,
  estimateCurrentVdotFromGarminRuns,
} from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';
import { authenticateJwt, generateToken } from '../../middlewares/auth.middleware';
import { GarminService } from '../garmin/garmin.service';
import { IGarminConnectClient, defaultGarminClient } from '../garmin/garmin.client';
import { AiTrainerService } from '../ai/ai.service';

const DEFAULT_OWNER_EMAIL = 'pawel@garmin-trainer.local';

function resolveDistanceMeters(
  targetDistance: string,
  customDistanceMeters?: number | null
): number {
  switch (targetDistance) {
    case 'FIVE_K':
    case '5K':
      return 5000;
    case 'TEN_K':
    case '10K':
      return 10000;
    case 'HALF_MARATHON':
      return 21097.5;
    case 'MARATHON':
      return 42195;
    case 'CUSTOM':
      return customDistanceMeters && customDistanceMeters > 0 ? customDistanceMeters : 10000;
    default:
      return 10000;
  }
}

function normalizeGoalDistanceEnum(
  dist: string
): 'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON' | 'CUSTOM' {
  const upper = (dist || '').toUpperCase().trim();
  if (upper === '5K' || upper === 'FIVE_K') return 'FIVE_K';
  if (upper === '10K' || upper === 'TEN_K') return 'TEN_K';
  if (upper === 'HALF_MARATHON' || upper === '21K') return 'HALF_MARATHON';
  if (upper === 'MARATHON' || upper === '42K') return 'MARATHON';
  return 'CUSTOM';
}

export function createGoalsRouter(
  prismaClient: PrismaClient = defaultPrisma,
  garminClient: IGarminConnectClient = defaultGarminClient
): Router {
  const router = Router();
  const garminService = new GarminService(prismaClient, undefined, garminClient);
  const aiService = new AiTrainerService(prismaClient);

  /**
   * GET /api/goals/bootstrap
   * Zero-registration bootstrap endpoint: automatically finds or creates the default owner account
   * in PostgreSQL, issues a valid JWT token, and returns the active goal, current & target VDOT paces,
   * Garmin connection status, latest daily metric, and scheduled workouts.
   */
  router.get('/bootstrap', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let user = await prismaClient.user.findUnique({
        where: { email: DEFAULT_OWNER_EMAIL },
      });

      if (!user) {
        user = await prismaClient.user.create({
          data: {
            email: DEFAULT_OWNER_EMAIL,
            passwordHash: 'bootstrap_no_password_login',
            name: 'Paweł',
            role: 'ADMIN' as any,
          },
        });
      }

      const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role as UserRole,
      });

      let activeGoal = await prismaClient.trainingGoal.findFirst({
        where: { userId: user.id, isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      let workouts = await prismaClient.workout.findMany({
        where: { userId: user.id },
        orderBy: { date: 'asc' },
        take: 14,
      });

      // Default to realistic current VDOT (37.0 -> ~53:30 10K, Easy pace ~6:00-6:38/km) aiming for 45:00
      if (!activeGoal || workouts.length === 0) {
        const defaultCurrentVdot = activeGoal?.currentVdot || 37.0;
        const generated = await aiService.generateTrainingPlan(user.id, {
          targetDistance: activeGoal?.targetDistance || 'TEN_K',
          targetTimeSeconds: activeGoal?.targetTime || 2700,
          preference: (activeGoal?.preference as any) || 'HYBRID_BIKE_RUN',
          currentVdot: defaultCurrentVdot,
        });
        activeGoal = generated.goal;
        workouts = generated.workouts;
      }

      const currentVdot = activeGoal?.currentVdot || 37.0;
      const distMeters = resolveDistanceMeters(
        activeGoal?.targetDistance || 'TEN_K',
        activeGoal?.customDistanceMeters
      );
      const targetVdot = activeGoal?.targetTime
        ? calculateVdotFromRace(distMeters, activeGoal.targetTime)
        : Math.max(currentVdot, 45.0);

      const progression = calculateProgressiveVdot(currentVdot, targetVdot, 1, 12);
      const paces = progression.currentPaces;
      const targetPaces = progression.targetPaces;
      const wattZones = convertRunToBikeWatts(progression.activeTrainingVdot, 74);
      const garminStatus = await garminService.getConnectionStatus(user.id);

      const latestMetrics = await prismaClient.dailyMetric.findMany({
        where: { userId: user.id },
        orderBy: { date: 'desc' },
        take: 1,
      });

      res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
        token,
        activeGoal,
        paces,
        targetPaces,
        progression,
        wattZones,
        garminStatus,
        latestMetric: latestMetrics[0] || null,
        workouts,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/goals/estimate-from-garmin
   * Analyzes the user's completed running workouts from Garmin Connect to estimate
   * their true CURRENT VDOT and current easy/base pace.
   * Persists newly estimated VDOT to the active TrainingGoal in PostgreSQL if qualifying runs exist.
   * Retains existing baseline VDOT without mutating the database if insufficient runs exist.
   */
  router.post(
    '/estimate-from-garmin',
    authenticateJwt,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const userId = req.user!.userId;

        // Fetch user's current active goal to determine baseline VDOT
        let activeGoal = await prismaClient.trainingGoal.findFirst({
          where: { userId, isActive: true },
          orderBy: { createdAt: 'desc' },
        });

        const baselineVdot =
          typeof activeGoal?.currentVdot === 'number' && activeGoal.currentVdot > 0
            ? activeGoal.currentVdot
            : 37.0;

        // Try pulling fresh activities from Garmin Connect if connected
        try {
          await garminService.syncRecentActivities(userId, 8);
        } catch {
          // Use already stored completed workouts if Garmin is not connected yet
        }

        const completedRuns = await prismaClient.workout.findMany({
          where: {
            userId,
            status: WorkoutStatus.COMPLETED as any,
          },
          orderBy: { date: 'desc' },
          take: 15,
        });

        const estimation = estimateCurrentVdotFromGarminRuns(
          completedRuns.map((w) => ({
            activityType: w.type,
            distanceMeters: w.distanceMeters || 0,
            durationSeconds: w.durationSeconds || 0,
            averageHeartRate: w.averageHeartRate,
          }))
        );

        if (estimation) {
          const resolvedVdot = estimation.estimatedVdot;

          if (activeGoal) {
            activeGoal = await prismaClient.trainingGoal.update({
              where: { id: activeGoal.id },
              data: { currentVdot: resolvedVdot },
            });
          } else {
            activeGoal = await prismaClient.trainingGoal.create({
              data: {
                userId,
                targetDistance: 'TEN_K',
                targetTime: estimation.estimated10kSeconds,
                preference: 'RUN_ONLY',
                currentVdot: resolvedVdot,
                isActive: true,
                notes: `Wyliczono automatycznie z biegów Garmin Connect (VDOT ${resolvedVdot})`,
              },
            });
          }

          const currentPaces = calculateVdotPaces(resolvedVdot);

          res.status(200).json({
            estimatedCurrentVdot: resolvedVdot,
            estimated10kSeconds: estimation.estimated10kSeconds,
            sampleCount: estimation.sampleCount,
            hasSufficientData: true,
            message: `Pomyślnie wyliczono poziom z ${estimation.sampleCount} biegów Garmin Connect (VDOT ${resolvedVdot}). Zaktualizowano cel treningowy w bazie danych.`,
            currentPaces,
            activeGoal,
          });
          return;
        }

        // Insufficient qualifying runs: retain baseline VDOT without DB mutation
        const resolvedVdot = baselineVdot;
        const currentPaces = calculateVdotPaces(resolvedVdot);
        const estimated10kSeconds = calculateRaceTimeFromVdot(10000, resolvedVdot);
        const formattedVdot = resolvedVdot.toFixed(1);

        res.status(200).json({
          estimatedCurrentVdot: resolvedVdot,
          estimated10kSeconds,
          sampleCount: 0,
          hasSufficientData: false,
          message: `Brak wystarczającej liczby ukończonych biegów w Garmin Connect (wymagany min. 1 bieg ≥ 2 km i ≥ 10 min). Zachowano dotychczasowy poziom bazowy VDOT ${formattedVdot}.`,
          currentPaces,
          activeGoal: activeGoal || null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * GET /api/goals/active
   * Returns the authenticated user's active goal, current training paces, and target goal paces.
   */
  router.get(
    '/active',
    authenticateJwt,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const userId = req.user!.userId;
        const activeGoal = await prismaClient.trainingGoal.findFirst({
          where: { userId, isActive: true },
          orderBy: { createdAt: 'desc' },
        });

        const currentVdot = activeGoal?.currentVdot || 37.0;
        const distMeters = resolveDistanceMeters(
          activeGoal?.targetDistance || 'TEN_K',
          activeGoal?.customDistanceMeters
        );
        const targetVdot = activeGoal?.targetTime
          ? calculateVdotFromRace(distMeters, activeGoal.targetTime)
          : currentVdot;

        const progression = calculateProgressiveVdot(currentVdot, targetVdot, 1, 12);

        res.status(200).json({
          activeGoal,
          paces: progression.currentPaces,
          targetPaces: progression.targetPaces,
          progression,
          wattZones: convertRunToBikeWatts(progression.activeTrainingVdot, 74),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * POST /api/goals
   * Creates or updates the user's training goal.
   * Separates CURRENT fitness (`currentTimeSeconds` / `currentVdot`) from TARGET goal (`targetTimeSeconds` / `targetVdot`),
   * generating immediate workouts strictly at the athlete's CURRENT safe training paces!
   */
  router.post(
    '/',
    authenticateJwt,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const userId = req.user!.userId;
        const {
          targetDistance,
          customDistanceMeters,
          currentTimeSeconds,
          targetTimeSeconds,
          weekNumber,
          totalWeeks,
          eventDate,
          preference,
          riderWeightKg,
          notes,
        } = req.body || {};

        const distanceEnum = normalizeGoalDistanceEnum(targetDistance || 'TEN_K');
        const distanceMeters = resolveDistanceMeters(
          distanceEnum,
          customDistanceMeters ? Number(customDistanceMeters) : null
        );

        const targetSec =
          typeof targetTimeSeconds === 'number' && targetTimeSeconds > 0
            ? Math.round(targetTimeSeconds)
            : 2700; // Default target: 45:00

        // If currentTimeSeconds is provided, compute currentVdot from it;
        // otherwise if only targetTimeSeconds was provided in legacy test calls, use targetSec
        const currentSec =
          typeof currentTimeSeconds === 'number' && currentTimeSeconds > 0
            ? Math.round(currentTimeSeconds)
            : targetSec;

        const currentVdot = calculateVdotFromRace(distanceMeters, currentSec);
        const targetVdot = calculateVdotFromRace(distanceMeters, targetSec);

        const progression = calculateProgressiveVdot(
          currentVdot,
          targetVdot,
          weekNumber ? Number(weekNumber) : 1,
          totalWeeks ? Number(totalWeeks) : 12
        );

        const resolvedPref =
          preference === 'HYBRID' || preference === 'HYBRID_BIKE_RUN'
            ? 'HYBRID_BIKE_RUN'
            : 'RUN_ONLY';

        // Deactivate previous active goals for this user
        await prismaClient.trainingGoal.updateMany({
          where: { userId, isActive: true },
          data: { isActive: false },
        });

        // Save new goal with currentVdot representing the athlete's present training level
        const newGoal = await prismaClient.trainingGoal.create({
          data: {
            userId,
            targetDistance: distanceEnum as any,
            customDistanceMeters:
              distanceEnum === 'CUSTOM' && customDistanceMeters
                ? Number(customDistanceMeters)
                : null,
            targetTime: targetSec,
            eventDate: eventDate ? new Date(eventDate) : null,
            preference: resolvedPref as any,
            currentVdot: progression.activeTrainingVdot,
            isActive: true,
            notes:
              notes ??
              `Aktualny czas: ${currentSec}s (VDOT ${currentVdot}) -> Cel: ${targetSec}s (VDOT ${targetVdot})`,
          },
        });

        // Clear old PLANNED workouts before generating the fresh plan at current safe paces
        await prismaClient.workout.deleteMany({
          where: {
            userId,
            status: WorkoutStatus.PLANNED as any,
          },
        });

        const generated = await aiService.generateTrainingPlan(userId, {
          targetDistance: distanceEnum,
          targetTimeSeconds: targetSec,
          preference: resolvedPref,
          currentVdot: progression.activeTrainingVdot,
          riderWeightKg: riderWeightKg ? Number(riderWeightKg) : 74,
        });

        const paces = progression.currentPaces;
        const targetPaces = progression.targetPaces;
        const wattZones = convertRunToBikeWatts(
          progression.activeTrainingVdot,
          riderWeightKg ? Number(riderWeightKg) : 74
        );

        res.status(201).json({
          goal: newGoal,
          paces,
          targetPaces,
          progression,
          wattZones,
          workouts: generated.workouts,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
