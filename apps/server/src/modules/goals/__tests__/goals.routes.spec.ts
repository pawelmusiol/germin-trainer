import request from 'supertest';
import { createApp } from '../../../app';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let mockUsers: any[] = [];
let mockGoals: any[] = [];
let mockWorkouts: any[] = [];
let mockDailyMetrics: any[] = [];
let mockGarminAuths: any[] = [];

const mockPrisma: any = {
  user: {
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.email) {
        return mockUsers.find((u) => u.email === where.email) || null;
      }
      if (where.id) {
        return mockUsers.find((u) => u.id === where.id) || null;
      }
      return null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `usr_${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      mockUsers.push(created);
      return created;
    }),
  },
  trainingGoal: {
    findFirst: jest.fn(async ({ where }: any) => {
      return mockGoals.find((g) => g.userId === where.userId && g.isActive === where.isActive) || null;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      mockGoals.forEach((g) => {
        if (g.userId === where.userId && g.isActive === where.isActive) {
          Object.assign(g, data);
        }
      });
    }),
    create: jest.fn(async ({ data }: any) => {
      const created = { id: `goal_${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      mockGoals.push(created);
      return created;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const goal = mockGoals.find((g) => g.id === where.id);
      if (goal) {
        Object.assign(goal, data, { updatedAt: new Date() });
        return goal;
      }
      return null;
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
    deleteMany: jest.fn(async ({ where }: any) => {
      mockWorkouts = mockWorkouts.filter(
        (w) => !(w.userId === where.userId && w.status === where.status)
      );
    }),
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
  },
  dailyMetric: {
    findMany: jest.fn(async ({ where }: any) => {
      return mockDailyMetrics.filter((m) => m.userId === where.userId);
    }),
  },
  garminAuth: {
    findUnique: jest.fn(async ({ where }: any) => {
      return mockGarminAuths.find((g) => g.userId === where.userId) || null;
    }),
  },
  techniqueAnalysis: {
    findMany: jest.fn(async () => []),
  },
};

describe('Goals Creation & Zero-Registration Bootstrap Suite (/api/goals)', () => {
  const app = createApp(mockPrisma);

  beforeEach(() => {
    mockUsers = [];
    mockGoals = [];
    mockWorkouts = [];
    mockDailyMetrics = [];
    mockGarminAuths = [];
    jest.clearAllMocks();
  });

  it('GOAL-1: bootstraps default user session without registration and returns JWT, goal, paces, and initial workouts', async () => {
    const res = await request(app).get('/api/goals/bootstrap');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('pawel@garmin-trainer.local');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.paces.vdot).toBeDefined();
    expect(res.body.wattZones.ftp).toBeGreaterThan(100);
    expect(res.body.workouts.length).toBeGreaterThanOrEqual(5);
  });

  it('GOAL-2: creates a new training goal (e.g. 5K in 20:00), computes VDOT 49.8, and regenerates planned workouts', async () => {
    const boot = await request(app).get('/api/goals/bootstrap');
    const authHeader = `Bearer ${boot.body.token}`;

    const saveRes = await request(app)
      .post('/api/goals')
      .set('Authorization', authHeader)
      .send({
        targetDistance: 'FIVE_K',
        targetTimeSeconds: 1200, // 20:00 for 5K
        preference: 'HYBRID_BIKE_RUN',
        riderWeightKg: 72,
      });

    expect(saveRes.status).toBe(201);
    expect(saveRes.body.goal.targetDistance).toBe('FIVE_K');
    expect(saveRes.body.goal.targetTime).toBe(1200);
    expect(saveRes.body.paces.vdot).toBeCloseTo(49.8, 1);
    expect(saveRes.body.workouts).toHaveLength(5);
  });

  it('GOAL-3: estimates VDOT from Garmin runs and persists to active goal in database', async () => {
    const boot = await request(app).get('/api/goals/bootstrap');
    const authHeader = `Bearer ${boot.body.token}`;
    const user = boot.body.user;

    // Seed completed qualifying workouts for this user
    mockWorkouts.push(
      {
        id: 'wkt-comp-1',
        userId: user.id,
        type: 'RUN',
        status: 'COMPLETED',
        distanceMeters: 5000,
        durationSeconds: 1500, // 25:00
        averageHeartRate: 152,
        date: new Date(),
      },
      {
        id: 'wkt-comp-2',
        userId: user.id,
        type: 'RUN',
        status: 'COMPLETED',
        distanceMeters: 10000,
        durationSeconds: 3000, // 50:00
        averageHeartRate: 156,
        date: new Date(),
      }
    );

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(true);
    expect(res.body.sampleCount).toBe(2);
    expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(40);
    expect(res.body.message).toContain('Pomyślnie wyliczono poziom z 2 biegów Garmin Connect');
    expect(res.body.activeGoal).toBeDefined();
    expect(res.body.activeGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);

    // Verify database state: active goal in mockGoals has persisted currentVdot
    const activeGoal = mockGoals.find((g) => g.userId === user.id && g.isActive);
    expect(activeGoal).toBeDefined();
    expect(activeGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);
  });

  it('GOAL-4: retains active goal baseline VDOT when insufficient Garmin runs exist without modifying database', async () => {
    const boot = await request(app).get('/api/goals/bootstrap');
    const authHeader = `Bearer ${boot.body.token}`;
    const user = boot.body.user;

    // Set an explicit baseline on the active goal
    const activeGoalBefore = mockGoals.find((g) => g.userId === user.id && g.isActive);
    activeGoalBefore.currentVdot = 44.5;

    // Clear workouts so 0 completed runs exist
    mockWorkouts = [];

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(false);
    expect(res.body.sampleCount).toBe(0);
    expect(res.body.estimatedCurrentVdot).toBe(44.5);
    expect(res.body.message).toContain('Zachowano dotychczasowy poziom bazowy VDOT 44.5');

    // Verify DB was NOT updated
    expect(activeGoalBefore.currentVdot).toBe(44.5);
    expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
  });

  it('GOAL-5: returns 401 unauthenticated when Authorization header is missing', async () => {
    const res = await request(app).post('/api/goals/estimate-from-garmin');
    expect(res.status).toBe(401);
  });

  it('GOAL-6: ignores non-running workouts and short sprint activities (<2km)', async () => {
    const boot = await request(app).get('/api/goals/bootstrap');
    const authHeader = `Bearer ${boot.body.token}`;
    const user = boot.body.user;

    // Seed only cycling and short sprint run
    mockWorkouts.push(
      {
        id: 'wkt-bike-1',
        userId: user.id,
        type: 'BIKE',
        status: 'COMPLETED',
        distanceMeters: 25000,
        durationSeconds: 3600,
        date: new Date(),
      },
      {
        id: 'wkt-short-run',
        userId: user.id,
        type: 'RUN',
        status: 'COMPLETED',
        distanceMeters: 1200, // < 2000m
        durationSeconds: 360, // < 600s
        date: new Date(),
      }
    );

    const res = await request(app)
      .post('/api/goals/estimate-from-garmin')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.hasSufficientData).toBe(false);
    expect(res.body.sampleCount).toBe(0);
  });
});
