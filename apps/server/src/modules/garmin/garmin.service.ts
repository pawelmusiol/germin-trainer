import { PrismaClient } from '@prisma/client';
import {
  GarminActivitySummary,
  GarminConnectionStatus,
  GarminDailySummary,
  GarminSessionTokens,
  GarminWorkoutPayload,
  WorkoutData,
  WorkoutStatus,
  WorkoutStep,
  WorkoutType,
  convertWorkoutModality,
} from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';
import {
  EncryptionService,
  IEncryptionService,
  getEncryptionService,
} from '../encryption/encryption.service';
import {
  GarminConnectClient,
  IGarminConnectClient,
  defaultGarminClient,
} from './garmin.client';

export interface ConnectGarminInput {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface SyncMetricsInput {
  date?: string; // YYYY-MM-DD, defaults to today
  perceivedFatigue?: number; // 1-5 subjective physical work / fatigue slider
  note?: string;
}

export class GarminService {
  private readonly prisma: PrismaClient;
  private readonly encryption: IEncryptionService;
  private readonly client: IGarminConnectClient;

  constructor(
    prismaClient: PrismaClient = defaultPrisma,
    encryptionService?: IEncryptionService,
    garminClient: IGarminConnectClient = defaultGarminClient
  ) {
    this.prisma = prismaClient;
    this.encryption =
      encryptionService ||
      new EncryptionService(
        process.env.GARMIN_ENCRYPTION_KEY ||
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      );
    this.client = garminClient;
  }

  /**
   * Connects a user's Garmin Connect account.
   * Encrypts session tokens (or pending MFA state) with AES-256-GCM before saving to GarminAuth.
   */
  public async connectAccount(
    userId: string,
    input: ConnectGarminInput
  ): Promise<GarminConnectionStatus> {
    const authResult = await this.client.authenticate(
      input.email,
      input.password,
      input.mfaCode
    );

    const encrypted = this.encryption.encryptJson(authResult.session);
    const expiresAt = authResult.session.oauth2ExpiresAt
      ? new Date(authResult.session.oauth2ExpiresAt)
      : null;

    await this.prisma.garminAuth.upsert({
      where: { userId },
      create: {
        userId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        expiresAt,
      },
      update: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        expiresAt,
      },
    });

    return {
      connected: !authResult.mfaRequired,
      mfaPending: authResult.mfaRequired,
      garminEmail: authResult.session.garminEmail,
      displayName: authResult.session.displayName || null,
      expiresAt: authResult.session.oauth2ExpiresAt || null,
      lastSyncAt: authResult.session.lastSyncAt || null,
    };
  }

  /**
   * Completes 2FA/MFA verification for a pending Garmin Connect login.
   */
  public async verifyMfa(
    userId: string,
    mfaCode: string
  ): Promise<GarminConnectionStatus> {
    const pendingSession = await this.loadDecryptedSession(userId, true);

    const activeSession = await this.client.verifyMfa(pendingSession, mfaCode);
    const encrypted = this.encryption.encryptJson(activeSession);
    const expiresAt = activeSession.oauth2ExpiresAt
      ? new Date(activeSession.oauth2ExpiresAt)
      : null;

    await this.prisma.garminAuth.update({
      where: { userId },
      data: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        expiresAt,
      },
    });

    return {
      connected: true,
      mfaPending: false,
      garminEmail: activeSession.garminEmail,
      displayName: activeSession.displayName || null,
      expiresAt: activeSession.oauth2ExpiresAt || null,
      lastSyncAt: activeSession.lastSyncAt || null,
    };
  }

  /**
   * Returns current Garmin Connect connection status for the user.
   */
  public async getConnectionStatus(userId: string): Promise<GarminConnectionStatus> {
    const record = await this.prisma.garminAuth.findUnique({
      where: { userId },
    });

    if (!record) {
      return {
        connected: false,
        mfaPending: false,
      };
    }

    const session = this.encryption.decryptJson<GarminSessionTokens>({
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    });

    return {
      connected: !session.mfaPending && Boolean(session.oauth2AccessToken),
      mfaPending: Boolean(session.mfaPending),
      garminEmail: session.garminEmail,
      displayName: session.displayName || null,
      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : session.oauth2ExpiresAt || null,
      lastSyncAt: session.lastSyncAt || null,
    };
  }

  /**
   * Disconnects the user's Garmin account and removes encrypted credentials.
   */
  public async disconnectAccount(userId: string): Promise<void> {
    const existing = await this.prisma.garminAuth.findUnique({
      where: { userId },
    });
    if (existing) {
      await this.prisma.garminAuth.delete({
        where: { userId },
      });
    }
  }

  /**
   * Pulls daily health metrics (HRV, Sleep Score, Resting HR, Body Battery, Steps, Stress)
   * from Garmin Connect and persists/updates DailyMetric in PostgreSQL.
   */
  public async syncDailyMetrics(
    userId: string,
    input: SyncMetricsInput = {}
  ): Promise<{
    metric: any;
    garminSummary: GarminDailySummary;
  }> {
    const session = await this.loadDecryptedSession(userId, false);
    const dateStr = (input.date || new Date().toISOString()).slice(0, 10);

    if (
      input.perceivedFatigue !== undefined &&
      (input.perceivedFatigue < 1 || input.perceivedFatigue > 5 || !Number.isInteger(input.perceivedFatigue))
    ) {
      const err: any = new Error('perceivedFatigue must be an integer between 1 and 5');
      err.statusCode = 400;
      throw err;
    }

    const summary = await this.client.fetchDailyMetrics(session, dateStr);
    const dateObj = new Date(`${dateStr}T00:00:00.000Z`);

    // Auto-estimate physical work fatigue if user had high non-workout step count (>14k) and didn't provide slider
    let resolvedFatigue = input.perceivedFatigue;
    if (resolvedFatigue === undefined && summary.steps && summary.steps >= 15000) {
      resolvedFatigue = 4;
    }

    const metric = await this.prisma.dailyMetric.upsert({
      where: {
        userId_date: {
          userId,
          date: dateObj,
        },
      },
      create: {
        userId,
        date: dateObj,
        hrv: summary.hrv,
        sleepScore: summary.sleepScore,
        restingHeartRate: summary.restingHeartRate,
        bodyBattery: summary.bodyBattery,
        steps: summary.steps,
        perceivedFatigue: resolvedFatigue ?? null,
        note: input.note ?? null,
        rawGarminData: summary as any,
      },
      update: {
        hrv: summary.hrv,
        sleepScore: summary.sleepScore,
        restingHeartRate: summary.restingHeartRate,
        bodyBattery: summary.bodyBattery,
        steps: summary.steps,
        ...(resolvedFatigue !== undefined ? { perceivedFatigue: resolvedFatigue } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        rawGarminData: summary as any,
      },
    });

    await this.touchLastSync(userId, session);

    return {
      metric,
      garminSummary: summary,
    };
  }

  /**
   * Pulls recent completed activities from Garmin Connect and synchronizes them into Workout history.
   */
  public async syncRecentActivities(
    userId: string,
    limit: number = 5
  ): Promise<{
    syncedCount: number;
    activities: GarminActivitySummary[];
  }> {
    const session = await this.loadDecryptedSession(userId, false);
    const activities = await this.client.fetchRecentActivities(session, limit);

    let syncedCount = 0;
    for (const act of activities) {
      const existing = await this.prisma.workout.findFirst({
        where: {
          userId,
          garminActivityId: act.activityId,
        },
      });

      if (!existing) {
        await this.prisma.workout.create({
          data: {
            userId,
            date: new Date(act.startTimeLocal),
            type: act.activityType as any,
            title: act.activityName,
            description: `Zsynchronizowano z Garmin Connect (${Math.round(act.distanceMeters / 100) / 10} km)`,
            steps: [] as any,
            status: WorkoutStatus.COMPLETED as any,
            garminActivityId: act.activityId,
            durationSeconds: act.durationSeconds,
            distanceMeters: act.distanceMeters,
            averageHeartRate: act.averageHeartRate ?? null,
            averagePowerWatts: act.averagePowerWatts ?? null,
          },
        });
        syncedCount++;
      }
    }

    await this.touchLastSync(userId, session);

    return {
      syncedCount,
      activities,
    };
  }

  /**
   * Pushes a structured workout from our database into the user's Garmin Connect Calendar
   * so that the Garmin watch guides the user through each step (warmup, intervals, pace/HR targets, cooldown).
   */
  public async pushWorkoutToGarmin(
    userId: string,
    workoutId: string
  ): Promise<{
    workout: any;
    garminWorkoutId: string;
    scheduledDate: string;
    garminPayload: GarminWorkoutPayload;
  }> {
    const session = await this.loadDecryptedSession(userId, false);

    const workoutRecord = await this.prisma.workout.findFirst({
      where: {
        id: workoutId,
        userId,
      },
    });

    if (!workoutRecord) {
      const err: any = new Error('Workout not found');
      err.statusCode = 404;
      throw err;
    }

    const steps: WorkoutStep[] = Array.isArray(workoutRecord.steps)
      ? (workoutRecord.steps as unknown as WorkoutStep[])
      : [];

    const workoutDomain: WorkoutData = {
      id: workoutRecord.id,
      userId: workoutRecord.userId,
      date:
        workoutRecord.date instanceof Date
          ? workoutRecord.date.toISOString()
          : String(workoutRecord.date),
      type: workoutRecord.type as WorkoutType,
      title: workoutRecord.title,
      description: workoutRecord.description,
      steps,
      status: workoutRecord.status as WorkoutStatus,
      garminWorkoutId: workoutRecord.garminWorkoutId,
    };

    const scheduleDate = workoutDomain.date.slice(0, 10);
    const uploadResult = await this.client.uploadAndScheduleWorkout(
      session,
      workoutDomain,
      scheduleDate
    );

    const updatedWorkout = await this.prisma.workout.update({
      where: { id: workoutRecord.id },
      data: {
        garminWorkoutId: uploadResult.garminWorkoutId,
      },
    });

    return {
      workout: updatedWorkout,
      garminWorkoutId: uploadResult.garminWorkoutId,
      scheduledDate: uploadResult.scheduledDate,
      garminPayload: uploadResult.payload,
    };
  }

  /**
   * 1-Click On-Demand Workout Converter (RUN <-> BIKE).
   * Converts the workout steps using VDOT physiology and updates the database record.
   */
  public async convertWorkoutBetweenRunAndBike(
    userId: string,
    workoutId: string,
    targetType: WorkoutType.BIKE | WorkoutType.RUN | WorkoutType.HYBRID,
    riderWeightKg: number = 72
  ): Promise<any> {
    const workoutRecord = await this.prisma.workout.findFirst({
      where: {
        id: workoutId,
        userId,
      },
    });

    if (!workoutRecord) {
      const err: any = new Error('Workout not found');
      err.statusCode = 404;
      throw err;
    }

    const activeGoal = await this.prisma.trainingGoal.findFirst({
      where: {
        userId,
        isActive: true,
      },
    });

    const vdot = activeGoal?.currentVdot || 45;
    const steps: WorkoutStep[] = Array.isArray(workoutRecord.steps)
      ? (workoutRecord.steps as unknown as WorkoutStep[])
      : [];

    const converted = convertWorkoutModality(
      {
        id: workoutRecord.id,
        userId: workoutRecord.userId,
        date:
          workoutRecord.date instanceof Date
            ? workoutRecord.date.toISOString()
            : String(workoutRecord.date),
        type: workoutRecord.type as WorkoutType,
        title: workoutRecord.title,
        description: workoutRecord.description,
        steps,
        status: workoutRecord.status as WorkoutStatus,
        garminWorkoutId: workoutRecord.garminWorkoutId,
      },
      targetType,
      vdot,
      riderWeightKg
    );

    const totalDurationSeconds = converted.steps.reduce(
      (acc, s) => acc + (s.durationSeconds || 0),
      0
    );

    return this.prisma.workout.update({
      where: { id: workoutRecord.id },
      data: {
        type: converted.type as any,
        title: converted.title,
        description: converted.description ?? null,
        steps: converted.steps as any,
        status: converted.status as any,
        durationSeconds: totalDurationSeconds > 0 ? totalDurationSeconds : workoutRecord.durationSeconds,
      },
    });
  }

  private async loadDecryptedSession(
    userId: string,
    expectMfaPending: boolean
  ): Promise<GarminSessionTokens> {
    const record = await this.prisma.garminAuth.findUnique({
      where: { userId },
    });

    if (!record) {
      const err: any = new Error('Garmin Connect account is not linked');
      err.statusCode = 404;
      throw err;
    }

    const session = this.encryption.decryptJson<GarminSessionTokens>({
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    });

    if (!expectMfaPending && session.mfaPending) {
      const err: any = new Error('Garmin Connect login awaits MFA verification code');
      err.statusCode = 403;
      throw err;
    }

    return session;
  }

  private async touchLastSync(userId: string, session: GarminSessionTokens): Promise<void> {
    const updatedSession: GarminSessionTokens = {
      ...session,
      lastSyncAt: new Date().toISOString(),
    };
    const encrypted = this.encryption.encryptJson(updatedSession);
    await this.prisma.garminAuth.update({
      where: { userId },
      data: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      },
    });
  }
}
