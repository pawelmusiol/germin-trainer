import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db';
import { authenticateJwt } from '../../middlewares/auth.middleware';
import { AiTrainerService } from './ai.service';

export function createAiRouter(prismaClient: PrismaClient = defaultPrisma): Router {
  const router = Router();
  const aiService = new AiTrainerService(prismaClient);

  router.use(authenticateJwt);

  /**
   * POST /api/ai/plan/generate
   * Generates a 7-day structured training plan with VDOT paces, +10% volume guardrail,
   * hybrid bike option, and corrective technique drills.
   */
  router.post('/plan/generate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const result = await aiService.generateTrainingPlan(userId, req.body || {});
      res.status(201).json(result);
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * POST /api/ai/adapt/:workoutId
   * Evaluates morning readiness (HRV, Sleep, Body Battery, Physical Work fatigue)
   * and returns/applies AI workout adaptation.
   */
  router.post('/adapt/:workoutId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const workoutId = req.params.workoutId;
      const { date, applyImmediately, riderWeightKg } = req.body || {};

      const result = await aiService.evaluateMorningAdaptation(userId, workoutId, {
        date,
        applyImmediately: Boolean(applyImmediately),
        riderWeightKg: riderWeightKg ? Number(riderWeightKg) : undefined,
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
   * POST /api/ai/technique/analyze
   * Analyzes running gait video + Running Dynamics and injects corrective drills into planned runs.
   */
  router.post('/technique/analyze', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const {
        videoUrl,
        cadenceObserved,
        groundContactTime,
        verticalOscillation,
        notes,
        applyToPlannedWorkouts,
      } = req.body || {};

      const result = await aiService.analyzeTechniqueVideo(userId, {
        videoUrl,
        cadenceObserved: cadenceObserved !== undefined ? Number(cadenceObserved) : undefined,
        groundContactTime: groundContactTime !== undefined ? Number(groundContactTime) : undefined,
        verticalOscillation:
          verticalOscillation !== undefined ? Number(verticalOscillation) : undefined,
        notes,
        applyToPlannedWorkouts,
      });

      res.status(201).json(result);
    } catch (err: any) {
      if (err.statusCode) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /api/ai/technique
   * Lists the user's running technique video analyses.
   */
  router.get('/technique', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const analyses = await prismaClient.techniqueAnalysis.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
      });
      res.status(200).json({ analyses });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
