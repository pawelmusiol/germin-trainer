import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import { UserRole, TargetDistance } from '@garmin-trainer/shared';
import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './db';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createGarminRouter } from './modules/garmin/garmin.routes';
import { IGarminConnectClient, defaultGarminClient } from './modules/garmin/garmin.client';
import { createAiRouter } from './modules/ai/ai.routes';
import { createIndoorRouter } from './modules/fit/indoor.routes';
import { createGoalsRouter } from './modules/goals/goals.routes';

export function createApp(
  prismaClient: PrismaClient = defaultPrisma,
  garminClient: IGarminConnectClient = defaultGarminClient
): Application {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health check endpoint validating shared package linkage
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'garmin-trainer-server',
      timestamp: new Date().toISOString(),
      meta: {
        supportedRoles: [UserRole.USER, UserRole.ADMIN],
        defaultDistance: TargetDistance.TEN_K,
      },
    });
  });

  // User Authentication endpoints (/register, /login, /me)
  app.use('/api/auth', createAuthRouter(prismaClient));

  // Goals & Zero-Registration Bootstrap endpoints (/bootstrap, /active, POST /)
  app.use('/api/goals', createGoalsRouter(prismaClient, garminClient));

  // Garmin Connect Integration endpoints (/status, /connect, /mfa, /sync/*, /workouts/:id/push, /workouts/:id/convert)
  app.use('/api/garmin', createGarminRouter(prismaClient, garminClient));

  // Phase 3: AI Coaching Engine, Morning Adaptation & Video Gait Analysis endpoints
  app.use('/api/ai', createAiRouter(prismaClient));

  // Phase 4: Matrix BLE FTMS Indoor Bike/Treadmill & Binary .FIT Generator endpoints
  app.use('/api/indoor', createIndoorRouter(prismaClient));

  return app;
}
