import request from 'supertest';
import {
  StepType,
  UserRole,
  WorkoutStatus,
  WorkoutType,
  encodeIndoorBikeDataFrame,
  encodeTreadmillDataFrame,
  parseIndoorBikeDataFrame,
  parseTreadmillDataFrame,
} from '@garmin-trainer/shared';
import { createApp } from '../../../app';
import { generateToken } from '../../../middlewares/auth.middleware';
import { inspectFitFile } from '../../fit/fit.encoder';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let mockGoals: any[] = [];
let mockDailyMetrics: any[] = [];
let mockWorkouts: any[] = [];
let mockTechniqueAnalyses: any[] = [];

const mockPrisma: any = {
  trainingGoal: {
    findFirst: jest.fn(async ({ where }: any) => {
      return mockGoals.find((g) => g.userId === where.userId && g.isActive === where.isActive) || null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `goal_${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      mockGoals.push(created);
      return created;
    }),
  },
  dailyMetric: {
    findUnique: jest.fn(async ({ where }: any) => {
      const { userId, date } = where.userId_date;
      return (
        mockDailyMetrics.find(
          (m) => m.userId === userId && m.date.toISOString() === date.toISOString()
        ) || null
      );
    }),
  },
  workout: {
    create: jest.fn(async ({ data }: any) => {
      const created = {
        id: `wkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWorkouts.push(created);
      return created;
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      return mockWorkouts.find((w) => w.id === where.id && w.userId === where.userId) || null;
    }),
    findMany: jest.fn(async ({ where }: any) => {
      return mockWorkouts.filter(
        (w) =>
          w.userId === where.userId &&
          (!where.type || w.type === where.type) &&
          (!where.status || w.status === where.status)
      );
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const idx = mockWorkouts.findIndex((w) => w.id === where.id);
      if (idx < 0) throw new Error('Workout not found');
      mockWorkouts[idx] = { ...mockWorkouts[idx], ...data, updatedAt: new Date() };
      return mockWorkouts[idx];
    }),
  },
  techniqueAnalysis: {
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `ta_${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      mockTechniqueAnalyses.push(created);
      return created;
    }),
    findMany: jest.fn(async ({ where }: any) => {
      return mockTechniqueAnalyses.filter((t) => t.userId === where.userId);
    }),
  },
};

describe('Phase 3 & Phase 4: AI Coaching, Video Gait Analysis, Matrix FTMS BLE & Binary .FIT Suite', () => {
  const app = createApp(mockPrisma);
  const testUserId = 'user_ai_ftms_01';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'pawel.athlete@example.com',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGoals = [];
    mockDailyMetrics = [];
    mockWorkouts = [];
    mockTechniqueAnalyses = [];
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Phase 3 Tests: AI Plan Generation, Morning Adaptation & Video Gait Analysis
  // ===========================================================================

  it('P3-1: generates a 7-day hybrid training plan (RUN + Matrix BIKE) respecting the +10% weekly volume limit', async () => {
    const res = await request(app)
      .post('/api/ai/plan/generate')
      .set('Authorization', authHeader)
      .send({
        startDate: '2026-11-03',
        targetDistance: 'TEN_K',
        targetTimeSeconds: 2640, // 44:00 for 10K
        preference: 'HYBRID_BIKE_RUN',
        previousWeekDistanceMeters: 30000, // 30 km previous week -> max 33,000m safe limit
      });

    expect(res.status).toBe(201);
    expect(res.body.safeWeeklyDistanceLimitMeters).toBe(33000);
    expect(res.body.workouts).toHaveLength(5);

    const bikeSessions = res.body.workouts.filter((w: any) => w.type === WorkoutType.BIKE);
    const runSessions = res.body.workouts.filter((w: any) => w.type === WorkoutType.RUN);
    expect(bikeSessions.length).toBeGreaterThanOrEqual(1);
    expect(runSessions.length).toBeGreaterThanOrEqual(3);
  });

  it('P3-2: morning adaptation detects low HRV + heavy physical work (17,500 steps & fatigue 4/5) and swaps intense intervals to recovery Matrix bike', async () => {
    // Seed daily metric showing low recovery + heavy physical day at work
    mockDailyMetrics.push({
      userId: testUserId,
      date: new Date('2026-11-03T00:00:00.000Z'),
      hrv: 41,
      sleepScore: 52,
      restingHeartRate: 58,
      bodyBattery: 38,
      steps: 17500,
      perceivedFatigue: 4,
      note: 'Ciężka zmiana fizyczna w pracy',
    });

    const intenseWorkout = await mockPrisma.workout.create({
      data: {
        userId: testUserId,
        date: new Date('2026-11-03T07:00:00.000Z'),
        type: WorkoutType.RUN,
        title: 'Interwały VO2max 5x 1km @ 4:10/km',
        description: 'Mocny akcent biegowy',
        steps: [
          { stepNumber: 1, type: StepType.WARMUP, durationSeconds: 600, targetPace: '5:30 /km' },
          { stepNumber: 2, type: StepType.ACTIVE, durationSeconds: 1500, targetPace: '4:10 /km' },
        ],
        status: WorkoutStatus.PLANNED,
      },
    });

    const res = await request(app)
      .post(`/api/ai/adapt/${intenseWorkout.id}`)
      .set('Authorization', authHeader)
      .send({
        date: '2026-11-03',
        applyImmediately: true,
        riderWeightKg: 74,
      });

    expect(res.status).toBe(200);
    expect(res.body.modificationRecommended).toBe(true);
    expect(res.body.readiness.allowHighIntensity).toBe(false);
    expect(res.body.readiness.recommendBikeSwap).toBe(true);
    expect(res.body.applied).toBe(true);
    expect(res.body.proposedWorkout.type).toBe(WorkoutType.BIKE);
    expect(res.body.proposedWorkout.title).toContain('[Adaptacja AI]');
  });

  it('P3-3: analyzes running gait video + Garmin Running Dynamics and injects corrective drills into planned runs', async () => {
    // Seed 2 planned running workouts
    await mockPrisma.workout.create({
      data: {
        userId: testUserId,
        date: new Date('2026-11-04T07:00:00.000Z'),
        type: WorkoutType.RUN,
        title: 'Bieg spokojny 40 min',
        description: 'Baza tlenowa',
        steps: [
          { stepNumber: 1, type: StepType.WARMUP, durationSeconds: 600, notes: 'Rozgrzewka' },
          { stepNumber: 2, type: StepType.ACTIVE, durationSeconds: 1800 },
        ],
        status: WorkoutStatus.PLANNED,
      },
    });

    const res = await request(app)
      .post('/api/ai/technique/analyze')
      .set('Authorization', authHeader)
      .send({
        videoUrl: 'https://storage.example.com/runs/side_profile_slowmo.mp4',
        cadenceObserved: 162, // Low cadence -> overstriding
        groundContactTime: 268, // High GCT
        verticalOscillation: 10.1, // High vertical bounce / pelvic drop
        notes: 'Lądowanie na pięcie przed biodrem',
        applyToPlannedWorkouts: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.updatedWorkoutsCount).toBe(1);
    expect(res.body.analysis.biomechanicalFlaws.length).toBeGreaterThanOrEqual(2);
    expect(res.body.analysis.correctiveExercises.length).toBeGreaterThanOrEqual(2);

    // Check that the planned run's warmup step now contains the prescribed corrective drills
    expect(mockWorkouts[0].steps[0].notes).toContain('Ćwiczenia techniczne:');
    expect(mockWorkouts[0].steps[0].notes).toContain('Skipy A');
  });

  // ===========================================================================
  // Phase 4 Tests: Bluetooth FTMS Binary Protocol & Binary .FIT File Generator
  // ===========================================================================

  it('P4-1: encodes and decodes Bluetooth SIG GATT FTMS Indoor Bike (0x2AD2) and Treadmill (0x2ACD) binary packets', () => {
    const bikePacket = encodeIndoorBikeDataFrame({
      speedKmh: 32.45,
      cadenceRpm: 92,
      distanceMeters: 15420,
      powerWatts: 195,
      heartRateBpm: 148,
    });

    const parsedBike = parseIndoorBikeDataFrame(bikePacket, 120);
    expect(parsedBike.speedKmh).toBeCloseTo(32.45, 2);
    expect(parsedBike.cadenceRpm).toBe(92);
    expect(parsedBike.distanceMeters).toBe(15420);
    expect(parsedBike.powerWatts).toBe(195);
    expect(parsedBike.heartRateBpm).toBe(148);

    const treadmillPacket = encodeTreadmillDataFrame({
      speedKmh: 12.5,
      distanceMeters: 5000,
      inclinePercent: 1.5,
      heartRateBpm: 156,
    });

    const parsedTreadmill = parseTreadmillDataFrame(treadmillPacket, 300);
    expect(parsedTreadmill.speedKmh).toBeCloseTo(12.5, 2);
    expect(parsedTreadmill.distanceMeters).toBe(5000);
    expect(parsedTreadmill.inclinePercent).toBeCloseTo(1.5, 1);
    expect(parsedTreadmill.heartRateBpm).toBe(156);
  });

  it('P4-2: records a live Matrix Indoor Bike FTMS session, generates a valid binary Garmin .FIT file with verified CRC-16, and saves workout', async () => {
    const frame1 = Buffer.from(
      encodeIndoorBikeDataFrame({
        speedKmh: 30.0,
        cadenceRpm: 88,
        distanceMeters: 10000,
        powerWatts: 175,
        heartRateBpm: 140,
      })
    ).toString('hex');

    const frame2 = Buffer.from(
      encodeIndoorBikeDataFrame({
        speedKmh: 32.0,
        cadenceRpm: 92,
        distanceMeters: 20500,
        powerWatts: 195,
        heartRateBpm: 148,
      })
    ).toString('hex');

    const res = await request(app)
      .post('/api/indoor/sessions')
      .set('Authorization', authHeader)
      .send({
        equipmentType: WorkoutType.BIKE,
        title: 'Matrix Rower Stacjonarny - Baza Z2',
        rawFtmsFramesHex: [frame1, frame2],
        durationSeconds: 2400,
      });

    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({
      equipmentType: WorkoutType.BIKE,
      durationSeconds: 2400,
      distanceMeters: 20500,
      averagePowerWatts: 185,
      averageCadenceRpm: 90,
      averageHeartRateBpm: 144,
    });

    // Inspect generated binary .FIT file
    expect(res.body.garminSync.uploadedToGarminConnect).toBe(true);
    expect(res.body.garminSync.fitFile.signature).toBe('.FIT');
    expect(res.body.garminSync.fitFile.crcValid).toBe(true);

    const decodedFitBuf = Buffer.from(res.body.garminSync.fitFile.base64, 'base64');
    const fitInspection = inspectFitFile(decodedFitBuf);
    expect(fitInspection.headerSize).toBe(14);
    expect(fitInspection.signature).toBe('.FIT');
    expect(fitInspection.crcValid).toBe(true);
  });

  it('P4-3: supports manual fallback form entry for Matrix Treadmill when Bluetooth is unavailable', async () => {
    const res = await request(app)
      .post('/api/indoor/sessions')
      .set('Authorization', authHeader)
      .send({
        equipmentType: WorkoutType.TREADMILL,
        title: 'Bieżnia Matrix - Bieg progowy',
        durationSeconds: 1800,
        distanceMeters: 6500,
        averageHeartRateBpm: 162,
        averageInclinePercent: 1.0,
      });

    expect(res.status).toBe(201);
    expect(res.body.workout.type).toBe(WorkoutType.TREADMILL);
    expect(res.body.summary.distanceMeters).toBe(6500);
    expect(res.body.summary.averageSpeedKmh).toBe(13);
    expect(res.body.garminSync.fitFile.crcValid).toBe(true);
  });
});
