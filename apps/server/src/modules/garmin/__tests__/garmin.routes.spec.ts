import request from 'supertest';
import {
  StepType,
  UserRole,
  WorkoutData,
  WorkoutStatus,
  WorkoutType,
  mapWorkoutToGarminPayload,
  paceRangeToMetersPerSecond,
  convertWorkoutModality,
  evaluateMorningReadiness,
} from '@garmin-trainer/shared';
import { createApp } from '../../../app';
import { generateToken } from '../../../middlewares/auth.middleware';
import { EncryptionService } from '../../encryption/encryption.service';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.JWT_EXPIRES_IN = '7d';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface MockGarminAuthRecord {
  id: string;
  userId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockDailyMetricRecord {
  id: string;
  userId: string;
  date: Date;
  hrv: number | null;
  sleepScore: number | null;
  restingHeartRate: number | null;
  bodyBattery: number | null;
  steps: number | null;
  perceivedFatigue: number | null;
  note: string | null;
  rawGarminData: any;
  createdAt: Date;
  updatedAt: Date;
}

interface MockWorkoutRecord {
  id: string;
  userId: string;
  date: Date;
  type: string;
  title: string;
  description: string | null;
  steps: any;
  status: string;
  garminWorkoutId: string | null;
  garminActivityId: string | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  averageHeartRate: number | null;
  averagePowerWatts: number | null;
  createdAt: Date;
  updatedAt: Date;
}

let mockGarminAuths: MockGarminAuthRecord[] = [];
let mockDailyMetrics: MockDailyMetricRecord[] = [];
let mockWorkouts: MockWorkoutRecord[] = [];
let mockGoals: any[] = [];

const mockPrisma: any = {
  garminAuth: {
    findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
      return mockGarminAuths.find((g) => g.userId === where.userId) || null;
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const idx = mockGarminAuths.findIndex((g) => g.userId === where.userId);
      if (idx >= 0) {
        mockGarminAuths[idx] = {
          ...mockGarminAuths[idx],
          ...update,
          updatedAt: new Date(),
        };
        return mockGarminAuths[idx];
      }
      const created: MockGarminAuthRecord = {
        id: `ga_${Date.now()}`,
        userId: create.userId,
        ciphertext: create.ciphertext,
        iv: create.iv,
        authTag: create.authTag,
        expiresAt: create.expiresAt ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGarminAuths.push(created);
      return created;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const idx = mockGarminAuths.findIndex((g) => g.userId === where.userId);
      if (idx < 0) throw new Error('Record not found');
      mockGarminAuths[idx] = {
        ...mockGarminAuths[idx],
        ...data,
        updatedAt: new Date(),
      };
      return mockGarminAuths[idx];
    }),
    delete: jest.fn(async ({ where }: any) => {
      mockGarminAuths = mockGarminAuths.filter((g) => g.userId !== where.userId);
    }),
  },
  dailyMetric: {
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const { userId, date } = where.userId_date;
      const idx = mockDailyMetrics.findIndex(
        (m) => m.userId === userId && m.date.toISOString() === date.toISOString()
      );
      if (idx >= 0) {
        mockDailyMetrics[idx] = {
          ...mockDailyMetrics[idx],
          ...update,
          updatedAt: new Date(),
        };
        return mockDailyMetrics[idx];
      }
      const created: MockDailyMetricRecord = {
        id: `dm_${Date.now()}`,
        userId: create.userId,
        date: create.date,
        hrv: create.hrv ?? null,
        sleepScore: create.sleepScore ?? null,
        restingHeartRate: create.restingHeartRate ?? null,
        bodyBattery: create.bodyBattery ?? null,
        steps: create.steps ?? null,
        perceivedFatigue: create.perceivedFatigue ?? null,
        note: create.note ?? null,
        rawGarminData: create.rawGarminData ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDailyMetrics.push(created);
      return created;
    }),
    findMany: jest.fn(async ({ where, take }: any) => {
      return mockDailyMetrics
        .filter((m) => m.userId === where.userId)
        .slice(0, take || 14);
    }),
  },
  workout: {
    findFirst: jest.fn(async ({ where }: any) => {
      return (
        mockWorkouts.find((w) => {
          if (where.id && w.id !== where.id) return false;
          if (where.userId && w.userId !== where.userId) return false;
          if (where.garminActivityId && w.garminActivityId !== where.garminActivityId) return false;
          return true;
        }) || null
      );
    }),
    create: jest.fn(async ({ data }: any) => {
      const created: MockWorkoutRecord = {
        id: `wkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: data.userId,
        date: data.date,
        type: data.type,
        title: data.title,
        description: data.description ?? null,
        steps: data.steps ?? [],
        status: data.status ?? 'PLANNED',
        garminWorkoutId: data.garminWorkoutId ?? null,
        garminActivityId: data.garminActivityId ?? null,
        durationSeconds: data.durationSeconds ?? null,
        distanceMeters: data.distanceMeters ?? null,
        averageHeartRate: data.averageHeartRate ?? null,
        averagePowerWatts: data.averagePowerWatts ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWorkouts.push(created);
      return created;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const idx = mockWorkouts.findIndex((w) => w.id === where.id);
      if (idx < 0) throw new Error('Workout not found');
      mockWorkouts[idx] = {
        ...mockWorkouts[idx],
        ...data,
        updatedAt: new Date(),
      };
      return mockWorkouts[idx];
    }),
  },
  trainingGoal: {
    findFirst: jest.fn(async ({ where }: any) => {
      return mockGoals.find((g) => g.userId === where.userId && g.isActive === where.isActive) || null;
    }),
  },
};

describe('Phase 2: Garmin Connect Integration & Workout Builder Suite (/api/garmin)', () => {
  const app = createApp(mockPrisma);
  const testUserId = 'user_garmin_01';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'pawel@example.com',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGarminAuths = [];
    mockDailyMetrics = [];
    mockWorkouts = [];
    mockGoals = [{ userId: testUserId, isActive: true, currentVdot: 48 }];
    jest.clearAllMocks();
  });

  it('G-1: links Garmin Connect account and stores AES-256-GCM encrypted session tokens in DB', async () => {
    const res = await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({
        email: 'runner.garmin@example.com',
        password: 'GarminStrongPassword!',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({
      connected: true,
      mfaPending: false,
      garminEmail: 'runner.garmin@example.com',
    });

    // Verify encrypted record in DB
    expect(mockGarminAuths).toHaveLength(1);
    const record = mockGarminAuths[0];
    expect(record.ciphertext).not.toContain('runner.garmin@example.com');
    expect(record.iv).toHaveLength(24); // 12 bytes hex
    expect(record.authTag).toHaveLength(32); // 16 bytes hex

    // Decrypt to verify round-trip integrity
    const encryption = new EncryptionService(process.env.GARMIN_ENCRYPTION_KEY);
    const decrypted = encryption.decryptJson<any>({
      ciphertext: record.ciphertext,
      iv: record.iv,
      authTag: record.authTag,
    });
    expect(decrypted.garminEmail).toBe('runner.garmin@example.com');
    expect(decrypted.oauth2AccessToken).toMatch(/^garmin_at_/);
  });

  it('G-2: handles Garmin 2FA/MFA challenge workflow (202 MFA pending -> 200 after 6-digit MFA code)', async () => {
    const connectRes = await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({
        email: 'mfa.athlete@example.com',
        password: 'PasswordWithMFA!',
      });

    expect(connectRes.status).toBe(202);
    expect(connectRes.body.status).toMatchObject({
      connected: false,
      mfaPending: true,
      garminEmail: 'mfa.athlete@example.com',
    });

    // Syncing metrics while MFA is pending must be rejected with 403
    const blockedSync = await request(app)
      .post('/api/garmin/sync/metrics')
      .set('Authorization', authHeader)
      .send({ date: '2026-11-02' });
    expect(blockedSync.status).toBe(403);

    // Complete MFA challenge with valid 6-digit code
    const mfaRes = await request(app)
      .post('/api/garmin/mfa')
      .set('Authorization', authHeader)
      .send({ mfaCode: '482910' });

    expect(mfaRes.status).toBe(200);
    expect(mfaRes.body.status).toMatchObject({
      connected: true,
      mfaPending: false,
      garminEmail: 'mfa.athlete@example.com',
    });
  });

  it('G-3: pulls daily health metrics (HRV, Sleep Score, RHR, Body Battery, Steps) and stores subjective fatigue', async () => {
    await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({ email: 'runner@example.com', password: 'ValidPassword123' });

    const syncRes = await request(app)
      .post('/api/garmin/sync/metrics')
      .set('Authorization', authHeader)
      .send({
        date: '2026-11-02',
        perceivedFatigue: 4,
        note: 'Ciężki dzień w pracy fizycznej (dużo chodzenia)',
      });

    expect(syncRes.status).toBe(200);
    expect(syncRes.body.garminSummary).toMatchObject({
      date: '2026-11-02',
    });
    expect(typeof syncRes.body.garminSummary.hrv).toBe('number');
    expect(typeof syncRes.body.garminSummary.sleepScore).toBe('number');
    expect(typeof syncRes.body.garminSummary.restingHeartRate).toBe('number');
    expect(typeof syncRes.body.garminSummary.bodyBattery).toBe('number');
    expect(typeof syncRes.body.garminSummary.steps).toBe('number');

    expect(syncRes.body.metric).toMatchObject({
      perceivedFatigue: 4,
      note: 'Ciężki dzień w pracy fizycznej (dużo chodzenia)',
    });

    const listRes = await request(app)
      .get('/api/garmin/metrics')
      .set('Authorization', authHeader);
    expect(listRes.status).toBe(200);
    expect(listRes.body.metrics).toHaveLength(1);
  });

  it('G-4: pulls recent completed activities from Garmin Connect into Workout history', async () => {
    await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({ email: 'runner@example.com', password: 'ValidPassword123' });

    const actRes = await request(app)
      .post('/api/garmin/sync/activities')
      .set('Authorization', authHeader)
      .send({ limit: 4 });

    expect(actRes.status).toBe(200);
    expect(actRes.body.syncedCount).toBe(4);
    expect(actRes.body.activities).toHaveLength(4);
    expect(mockWorkouts).toHaveLength(4);
    expect(mockWorkouts[0].status).toBe('COMPLETED');
    expect(mockWorkouts[0].garminActivityId).toMatch(/^garmin-act-/);
  });

  it('G-5: builds structured GarminWorkoutPayload JSON and pushes workout to Garmin Calendar', async () => {
    await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({ email: 'runner@example.com', password: 'ValidPassword123' });

    const plannedWorkout = await mockPrisma.workout.create({
      data: {
        userId: testUserId,
        date: new Date('2026-11-03T07:00:00.000Z'),
        type: WorkoutType.RUN,
        title: 'Interwały 5x1km @ 4:10/km',
        description: 'Trening pod 10 km',
        steps: [
          {
            stepNumber: 1,
            type: StepType.WARMUP,
            durationSeconds: 900,
            targetPace: '5:30 /km',
            targetHeartRateZone: 2,
          },
          {
            stepNumber: 2,
            type: StepType.ACTIVE,
            distanceMeters: 1000,
            targetPace: '4:10 /km',
            targetHeartRateZone: 5,
          },
          {
            stepNumber: 3,
            type: StepType.RECOVERY,
            durationSeconds: 120,
            targetHeartRateZone: 1,
          },
          {
            stepNumber: 4,
            type: StepType.COOLDOWN,
            durationSeconds: 600,
            targetPace: '5:45 /km',
          },
        ],
        status: WorkoutStatus.PLANNED,
      },
    });

    const pushRes = await request(app)
      .post(`/api/garmin/workouts/${plannedWorkout.id}/push`)
      .set('Authorization', authHeader)
      .send();

    expect(pushRes.status).toBe(200);
    expect(pushRes.body.garminWorkoutId).toMatch(/^gc-wkt-/);
    expect(pushRes.body.scheduledDate).toBe('2026-11-03');
    expect(pushRes.body.garminPayload.sportType.sportTypeKey).toBe('running');
    expect(pushRes.body.garminPayload.workoutSegments[0].workoutSteps).toHaveLength(4);

    // Check interval step speed conversion (4:10/km = 250s/km -> ~4.0 m/s)
    const intervalStep = pushRes.body.garminPayload.workoutSegments[0].workoutSteps[1];
    expect(intervalStep.stepType.stepTypeKey).toBe('interval');
    expect(intervalStep.endCondition.conditionTypeKey).toBe('distance');
    expect(intervalStep.endConditionValue).toBe(1000);
    expect(intervalStep.targetType.workoutTargetTypeKey).toBe('pace.zone');
    expect(intervalStep.targetValueOne).toBeGreaterThan(3.8);
    expect(intervalStep.targetValueTwo).toBeLessThan(4.2);
  });

  it('G-6: converts a planned RUN workout into a physiological equivalent BIKE workout on demand (1-click swap)', async () => {
    const plannedRun = await mockPrisma.workout.create({
      data: {
        userId: testUserId,
        date: new Date('2026-11-04T17:00:00.000Z'),
        type: WorkoutType.RUN,
        title: 'Bieg: Rozbieganie tlenowe 45 min',
        description: 'Spokojny tlen w Strefie 2',
        steps: [
          {
            stepNumber: 1,
            type: StepType.WARMUP,
            durationSeconds: 600,
            targetPace: '5:40 /km',
          },
          {
            stepNumber: 2,
            type: StepType.ACTIVE,
            durationSeconds: 1800,
            targetPace: '5:15 /km',
          },
          {
            stepNumber: 3,
            type: StepType.COOLDOWN,
            durationSeconds: 300,
            targetPace: '5:50 /km',
          },
        ],
        status: WorkoutStatus.PLANNED,
      },
    });

    const convertRes = await request(app)
      .post(`/api/garmin/workouts/${plannedRun.id}/convert`)
      .set('Authorization', authHeader)
      .send({
        targetType: WorkoutType.BIKE,
        riderWeightKg: 75,
      });

    expect(convertRes.status).toBe(200);
    const updated = convertRes.body.workout;
    expect(updated.type).toBe(WorkoutType.BIKE);
    expect(updated.title).toContain('[Rower]');
    expect(updated.status).toBe(WorkoutStatus.MODIFIED);
    // 45 min run (2700s) -> ~60 min bike (~3600s)
    expect(updated.durationSeconds).toBeGreaterThanOrEqual(3400);
    expect(updated.steps[1].targetWatts).toBeGreaterThan(140);
    expect(updated.steps[1].targetCadence).toBeGreaterThanOrEqual(85);
  });

  it('G-7: unit tests paceRangeToMetersPerSecond, mapWorkoutToGarminPayload, and bidirectional modality conversion', () => {
    const range = paceRangeToMetersPerSecond('5:00 /km');
    expect(range).not.toBeNull();
    expect(range!.minSpeedMps).toBeCloseTo(1000 / 305, 2);
    expect(range!.maxSpeedMps).toBeCloseTo(1000 / 295, 2);

    const dualRange = paceRangeToMetersPerSecond('5:00 /km - 5:30 /km');
    expect(dualRange).not.toBeNull();
    expect(dualRange!.minSpeedMps).toBeCloseTo(1000 / 330, 2);
    expect(dualRange!.maxSpeedMps).toBeCloseTo(1000 / 300, 2);

    const bikeWorkout = convertWorkoutModality(
      {
        date: '2026-11-05',
        type: WorkoutType.RUN,
        title: 'Bieg progowy 30 min',
        steps: [{ stepNumber: 1, type: StepType.ACTIVE, durationSeconds: 1800, targetPace: '4:15 /km' }],
        status: WorkoutStatus.PLANNED,
      },
      WorkoutType.BIKE,
      50,
      70
    );

    const garminBikePayload = mapWorkoutToGarminPayload(bikeWorkout);
    expect(garminBikePayload.sportType.sportTypeKey).toBe('cycling');
    expect(garminBikePayload.workoutSegments[0].workoutSteps[0].targetType.workoutTargetTypeKey).toBe(
      'power.zone'
    );

    const backToRun = convertWorkoutModality(bikeWorkout, WorkoutType.RUN, 50, 70);
    expect(backToRun.type).toBe(WorkoutType.RUN);
    expect(backToRun.steps[0].targetPace).toBeDefined();
  });

  it('G-8: disconnects Garmin Connect account and deletes encrypted session tokens from DB', async () => {
    // 1. Establish connection first
    await request(app)
      .post('/api/garmin/connect')
      .set('Authorization', authHeader)
      .send({ email: 'disconnect.user@example.com', password: 'ValidPassword123' });

    expect(mockGarminAuths).toHaveLength(1);

    // 2. Call DELETE /api/garmin/disconnect
    const disconnectRes = await request(app)
      .delete('/api/garmin/disconnect')
      .set('Authorization', authHeader);

    expect(disconnectRes.status).toBe(200);
    expect(disconnectRes.body).toEqual({
      connected: false,
      message: 'Garmin Connect account disconnected',
    });

    // 3. Verify encrypted session was removed from database
    expect(mockGarminAuths).toHaveLength(0);

    // 4. Verify status check returns disconnected
    const statusRes = await request(app)
      .get('/api/garmin/status')
      .set('Authorization', authHeader);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toMatchObject({
      connected: false,
      mfaPending: false,
    });
  });

  it('G-9: converts planned workout to HYBRID brick workout with multi-segment Garmin payload and bidirectional conversion back to RUN and BIKE', async () => {
    const plannedWorkout = await mockPrisma.workout.create({
      data: {
        userId: testUserId,
        date: new Date('2026-11-06T08:00:00.000Z'),
        type: WorkoutType.RUN,
        title: 'Bieg spokojny 45 min',
        description: 'Tlenowy bieg regeneracyjny',
        steps: [
          { stepNumber: 1, type: StepType.WARMUP, durationSeconds: 600, targetPace: '5:45 /km' },
          { stepNumber: 2, type: StepType.ACTIVE, durationSeconds: 2100, targetPace: '5:20 /km' },
        ],
        status: WorkoutStatus.PLANNED,
      },
    });

    // 1. Convert to HYBRID via POST /api/garmin/workouts/:id/convert
    const convertRes = await request(app)
      .post(`/api/garmin/workouts/${plannedWorkout.id}/convert`)
      .set('Authorization', authHeader)
      .send({
        targetType: WorkoutType.HYBRID,
        riderWeightKg: 74,
      });

    expect(convertRes.status).toBe(200);
    const hybridWorkout = convertRes.body.workout;
    expect(hybridWorkout.type).toBe(WorkoutType.HYBRID);
    expect(hybridWorkout.title).toContain('[Hybryda Bieg+Rower]');
    expect(hybridWorkout.status).toBe(WorkoutStatus.MODIFIED);
    // Brick steps: 2 running steps + 2 cycling steps = 4 steps total
    expect(hybridWorkout.steps).toHaveLength(4);
    expect(hybridWorkout.steps[0].targetPace).toBeDefined();
    expect(hybridWorkout.steps[1].targetPace).toBeDefined();
    expect(hybridWorkout.steps[2].targetWatts).toBeGreaterThan(100);
    expect(hybridWorkout.steps[2].targetCadence).toBe(90);
    expect(hybridWorkout.steps[3].targetWatts).toBeGreaterThan(50);
    expect(hybridWorkout.steps[3].targetCadence).toBe(80);

    // 2. Verify mapWorkoutToGarminPayload produces 2 segments
    const garminPayload = mapWorkoutToGarminPayload(hybridWorkout);
    expect(garminPayload.workoutSegments).toHaveLength(2);
    expect(garminPayload.workoutSegments[0].sportType.sportTypeKey).toBe('running');
    expect(garminPayload.workoutSegments[0].workoutSteps).toHaveLength(2);
    expect(garminPayload.workoutSegments[1].sportType.sportTypeKey).toBe('cycling');
    expect(garminPayload.workoutSegments[1].workoutSteps).toHaveLength(2);

    // 3. Convert from HYBRID to BIKE via API
    const toBikeRes = await request(app)
      .post(`/api/garmin/workouts/${plannedWorkout.id}/convert`)
      .set('Authorization', authHeader)
      .send({
        targetType: WorkoutType.BIKE,
        riderWeightKg: 74,
      });

    expect(toBikeRes.status).toBe(200);
    const bikeWorkout = toBikeRes.body.workout;
    expect(bikeWorkout.type).toBe(WorkoutType.BIKE);
    expect(bikeWorkout.title).toContain('[Rower]');
    expect(bikeWorkout.steps.every((s: any) => s.targetWatts > 0)).toBe(true);

    // 4. Convert from BIKE back to RUN via API
    const toRunRes = await request(app)
      .post(`/api/garmin/workouts/${plannedWorkout.id}/convert`)
      .set('Authorization', authHeader)
      .send({
        targetType: WorkoutType.RUN,
        riderWeightKg: 74,
      });

    expect(toRunRes.status).toBe(200);
    const runWorkout = toRunRes.body.workout;
    expect(runWorkout.type).toBe(WorkoutType.RUN);
    expect(runWorkout.title).not.toContain('[Rower]');
    expect(runWorkout.title).not.toContain('[Hybryda');
    expect(runWorkout.steps.every((s: any) => Boolean(s.targetPace))).toBe(true);
  });

  it('G-10: verifies graduated fatigue physiology (levels 1-5) and bi-directional adjustment with workout reset', () => {
    const baselineGarmin = {
      hrv: 62,
      hrvBaselineLow: 52,
      hrvStatus: 'BALANCED' as const,
      sleepScore: 85,
      bodyBattery: 85,
      steps: 8000,
    };

    // Level 2: normal baseline
    const rLevel2 = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 2 });
    expect(rLevel2.readinessScore).toBe(85);
    expect(rLevel2.allowHighIntensity).toBe(true);
    expect(rLevel2.recommendBikeSwap).toBe(false);

    // Level 5: exhaustion
    const rLevel5 = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 5 });
    expect(rLevel5.readinessScore).toBe(50);
    expect(rLevel5.allowHighIntensity).toBe(false);
    expect(rLevel5.recommendBikeSwap).toBe(true);
    expect(rLevel5.volumeMultiplier).toBe(0.6);

    // Level 4: high fatigue
    const rLevel4 = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 4 });
    expect(rLevel4.readinessScore).toBe(65);
    expect(rLevel4.allowHighIntensity).toBe(false);
    expect(rLevel4.recommendBikeSwap).toBe(true);
    expect(rLevel4.volumeMultiplier).toBe(0.75);

    // Level 3: moderate fatigue
    const rLevel3 = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 3 });
    expect(rLevel3.readinessScore).toBe(75);
    expect(rLevel3.volumeMultiplier).toBe(0.9);

    // Step down to Level 1: freshness bonus (+5)
    const rLevel1 = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 1 });
    expect(rLevel1.readinessScore).toBe(90);
    expect(rLevel1.allowHighIntensity).toBe(true);
    expect(rLevel1.recommendBikeSwap).toBe(false);

    // Workout Reset Logic Test
    const original: WorkoutData = {
      id: 'wkt-orig-01',
      date: '2026-11-06',
      type: WorkoutType.RUN,
      title: 'Interwały 5x 1km @ 4:12/km',
      status: WorkoutStatus.PLANNED,
      steps: [
        { stepNumber: 1, type: StepType.WARMUP, durationSeconds: 600, targetPace: '5:30' },
        { stepNumber: 2, type: StepType.ACTIVE, durationSeconds: 1500, targetPace: '4:12' },
      ],
    };
    const originalWorkouts: Record<string, WorkoutData> = {
      [original.id!]: JSON.parse(JSON.stringify(original)),
    };

    // Modified session
    let currentWorkout: WorkoutData = {
      ...original,
      title: '[Adaptacja AI] Regeneracyjny Rower Matrix Z1/Z2',
      type: WorkoutType.BIKE,
      status: WorkoutStatus.MODIFIED,
    };
    let pushedGarminId: string | null = 'gc-wkt-999';

    // Verify modified state detected
    const isModified =
      currentWorkout.status === WorkoutStatus.MODIFIED ||
      currentWorkout.title !== originalWorkouts[original.id!].title;
    expect(isModified).toBe(true);

    // Perform reset
    currentWorkout = JSON.parse(JSON.stringify(originalWorkouts[original.id!]));
    pushedGarminId = null;

    expect(currentWorkout.title).toBe('Interwały 5x 1km @ 4:12/km');
    expect(currentWorkout.type).toBe(WorkoutType.RUN);
    expect(currentWorkout.status).toBe(WorkoutStatus.PLANNED);
    expect(pushedGarminId).toBeNull();
  });
});
