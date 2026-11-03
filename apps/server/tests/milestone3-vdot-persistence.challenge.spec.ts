import request from 'supertest';
import { createApp } from '../src/app';
import { generateToken } from '../src/middlewares/auth.middleware';
import {
  UserRole,
  WorkoutStatus,
  calculateVdotFromRace,
  calculateRaceTimeFromVdot,
} from '@garmin-trainer/shared';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Milestone 3 Challenge: Garmin VDOT Estimation, Database Persistence & Inversion Fidelity', () => {
  let mockGoals: any[] = [];
  let mockWorkouts: any[] = [];

  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        return {
          id: where.id || 'user_m3_test',
          email: 'm3.test@garmin-trainer.local',
          name: 'M3 Tester',
          role: UserRole.USER,
        };
      }),
    },
    trainingGoal: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          mockGoals.find((g) => g.userId === where.userId && g.isActive === where.isActive) ||
          null
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const goal = mockGoals.find((g) => g.id === where.id);
        if (goal) {
          Object.assign(goal, data, { updatedAt: new Date() });
          return goal;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = {
          id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockGoals.push(created);
        return created;
      }),
    },
    workout: {
      findMany: jest.fn(async ({ where }: any) => {
        return mockWorkouts.filter((w) => {
          if (w.userId !== where.userId) return false;
          if (where.status && w.status !== where.status) return false;
          return true;
        });
      }),
    },
    dailyMetric: {
      findMany: jest.fn(async () => []),
    },
    garminAuth: {
      findUnique: jest.fn(async () => null),
    },
    techniqueAnalysis: {
      findMany: jest.fn(async () => []),
    },
  };

  const app = createApp(mockPrisma);
  const testUserId = 'user_m3_test';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'm3.test@garmin-trainer.local',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGoals = [];
    mockWorkouts = [];
    jest.clearAllMocks();
  });

  it('CHALLENGE-1: qualifying Garmin runs update the existing active goal in PostgreSQL with newly estimated VDOT', async () => {
    // Existing active goal with baseline VDOT 38.0
    const existingGoal = {
      id: 'active_goal_1',
      userId: testUserId,
      targetDistance: 'TEN_K',
      targetTime: 3200,
      preference: 'RUN_ONLY',
      currentVdot: 38.0,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockGoals.push(existingGoal);

    // Seed completed qualifying runs (5K and 10K)
    mockWorkouts.push(
      {
        id: 'wkt-run-1',
        userId: testUserId,
        type: 'RUN',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 5000,
        durationSeconds: 1380, // 23:00 (VDOT ~42.5)
        averageHeartRate: 155,
        maxHeartRate: 185,
        date: new Date(Date.now() - 86400000 * 2),
      },
      {
        id: 'wkt-run-2',
        userId: testUserId,
        type: 'RUN',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 10000,
        durationSeconds: 2820, // 47:00 (VDOT ~43.0)
        averageHeartRate: 158,
        maxHeartRate: 185,
        date: new Date(Date.now() - 86400000),
      }
    );

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(true);
    expect(res.body.sampleCount).toBe(2);
    expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(40.0);
    expect(res.body.estimatedCurrentVdot).toBeLessThanOrEqual(55.0);
    expect(res.body.activeGoal).toBeDefined();
    expect(res.body.activeGoal.id).toBe('active_goal_1');
    expect(res.body.activeGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);

    // Verify DB update call
    expect(mockPrisma.trainingGoal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'active_goal_1' },
        data: { currentVdot: res.body.estimatedCurrentVdot },
      })
    );

    // Verify that the updated object in mockGoals contains the new VDOT
    const persisted = mockGoals.find((g) => g.id === 'active_goal_1');
    expect(persisted.currentVdot).toBe(res.body.estimatedCurrentVdot);
  });

  it('CHALLENGE-2: qualifying Garmin runs create a new active goal when user has no active goal yet', async () => {
    expect(mockGoals).toHaveLength(0);

    mockWorkouts.push({
      id: 'wkt-run-solo',
      userId: testUserId,
      type: 'RUN',
      status: WorkoutStatus.COMPLETED,
      distanceMeters: 8000,
      durationSeconds: 2400, // 40:00 (5:00/km)
      averageHeartRate: 152,
      maxHeartRate: 185,
      date: new Date(),
    });

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(true);
    expect(res.body.sampleCount).toBe(1);
    expect(res.body.activeGoal).toBeDefined();
    expect(res.body.activeGoal.isActive).toBe(true);
    expect(res.body.activeGoal.userId).toBe(testUserId);
    expect(res.body.activeGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);

    // Verify DB create was invoked
    expect(mockPrisma.trainingGoal.create).toHaveBeenCalled();
    expect(mockGoals).toHaveLength(1);
  });

  it('CHALLENGE-3: retains existing active goal baseline VDOT without DB mutation when 0 qualifying runs exist', async () => {
    const existingGoal = {
      id: 'active_goal_retain',
      userId: testUserId,
      targetDistance: 'HALF_MARATHON',
      targetTime: 6000,
      preference: 'RUN_ONLY',
      currentVdot: 47.8,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockGoals.push(existingGoal);

    // Seed only non-qualifying runs (< 2000m or < 600s or non-RUN)
    mockWorkouts.push(
      {
        id: 'wkt-too-short',
        userId: testUserId,
        type: 'RUN',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 1500, // < 2000m
        durationSeconds: 500, // < 600s
        date: new Date(),
      },
      {
        id: 'wkt-bike',
        userId: testUserId,
        type: 'BIKE',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 30000,
        durationSeconds: 3600,
        date: new Date(),
      }
    );

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(false);
    expect(res.body.sampleCount).toBe(0);
    expect(res.body.estimatedCurrentVdot).toBe(47.8);
    expect(res.body.message).toContain('Zachowano dotychczasowy poziom bazowy VDOT 47.8');

    // DB must NOT be modified
    expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
    expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    expect(existingGoal.currentVdot).toBe(47.8);
  });

  it('CHALLENGE-4: falls back to 37.0 default without DB creation when no active goal and no qualifying runs exist', async () => {
    expect(mockGoals).toHaveLength(0);
    mockWorkouts = [];

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(false);
    expect(res.body.sampleCount).toBe(0);
    expect(res.body.estimatedCurrentVdot).toBe(37.0);
    expect(res.body.activeGoal).toBeNull();

    // Verify no DB mutations occurred
    expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
    expect(mockGoals).toHaveLength(0);
  });

  it('CHALLENGE-5: estimated 10k finish time matches calculateRaceTimeFromVdot and achieves round-trip VDOT fidelity', async () => {
    mockWorkouts.push({
      id: 'wkt-benchmark',
      userId: testUserId,
      type: 'RUN',
      status: WorkoutStatus.COMPLETED,
      distanceMeters: 10000,
      durationSeconds: 2480, // ~41:20 -> VDOT ~50.0
      averageHeartRate: 168,
      maxHeartRate: 185,
      date: new Date(),
    });

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    const { estimatedCurrentVdot, estimated10kSeconds } = res.body;

    // Check consistency with shared calculateRaceTimeFromVdot
    const expected10k = calculateRaceTimeFromVdot(10000, estimatedCurrentVdot);
    expect(estimated10kSeconds).toBe(expected10k);

    // Check round-trip fidelity: calculateVdotFromRace(10000, estimated10kSeconds) == estimatedCurrentVdot
    const roundTripVdot = calculateVdotFromRace(10000, estimated10kSeconds);
    expect(Math.abs(roundTripVdot - estimatedCurrentVdot)).toBeLessThanOrEqual(0.1);
  });
});
