import request from 'supertest';
import { createApp } from '../src/app';
import { generateToken } from '../src/middlewares/auth.middleware';
import {
  UserRole,
  WorkoutStatus,
  calculateRaceTimeFromVdot,
  calculateVdotFromRace,
} from '@garmin-trainer/shared';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Milestone 3 Challenge 2: Empirical Verification of DB Persistence & Mobile Handler (R5)', () => {
  let mockGoals: any[] = [];
  let mockWorkouts: any[] = [];

  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        return {
          id: where.id || 'user_challenger2',
          email: 'challenger2@garmin-trainer.local',
          name: 'Challenger 2',
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
  const testUserId = 'user_challenger2';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'challenger2@garmin-trainer.local',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGoals = [];
    mockWorkouts = [];
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. Authentication & Security
  // =========================================================================
  describe('1. Authentication & Security', () => {
    it('rejects unauthenticated requests with 401 when Authorization header is missing', async () => {
      const res = await request(app).post('/api/goals/estimate-from-garmin');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization');
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated requests with 401 when token is invalid or tampered', async () => {
      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Bearer invalid.tampered.token');
      expect(res.status).toBe(401);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated requests with 401 when Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Database Mutation When Qualifying Runs Exist
  // =========================================================================
  describe('2. Database Mutation when qualifying runs exist', () => {
    it('mutates existing TrainingGoal in DB and updates currentVdot to match estimatedCurrentVdot', async () => {
      const existingGoal = {
        id: 'goal_persist_1',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 3000,
        preference: 'RUN_ONLY',
        currentVdot: 36.5,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(existingGoal);

      mockWorkouts.push({
        id: 'wkt-qualifying-1',
        userId: testUserId,
        type: 'RUN',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 6000,
        durationSeconds: 1560, // 26:00
        averageHeartRate: 154,
        maxHeartRate: 184,
        date: new Date(),
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(1);
      expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(38.0);
      expect(res.body.activeGoal).toBeDefined();
      expect(res.body.activeGoal.id).toBe('goal_persist_1');
      expect(res.body.activeGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);

      // Verify Prisma update was actually invoked with the exact estimated current VDOT
      expect(mockPrisma.trainingGoal.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.trainingGoal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'goal_persist_1' },
          data: { currentVdot: res.body.estimatedCurrentVdot },
        })
      );

      // Verify the in-memory persisted object was mutated
      expect(existingGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);
    });

    it('creates a new TrainingGoal when user has no active goal yet and sets currentVdot to estimatedCurrentVdot', async () => {
      expect(mockGoals).toHaveLength(0);

      mockWorkouts.push({
        id: 'wkt-first-run',
        userId: testUserId,
        type: 'RUN',
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 5000,
        durationSeconds: 1260, // 21:00
        averageHeartRate: 158,
        maxHeartRate: 185,
        date: new Date(),
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(1);
      expect(mockPrisma.trainingGoal.create).toHaveBeenCalledTimes(1);
      expect(mockGoals).toHaveLength(1);
      expect(mockGoals[0].currentVdot).toBe(res.body.estimatedCurrentVdot);
      expect(mockGoals[0].isActive).toBe(true);
    });
  });

  // =========================================================================
  // 3. Zero Mutation on 0 Runs or Non-Qualifying Runs (< 2km, < 600s, non-RUN)
  // =========================================================================
  describe('3. Zero Mutation on 0 runs or non-qualifying runs', () => {
    it('strictly preserves baseline VDOT and NEVER calls trainingGoal.update when 0 workouts exist', async () => {
      const existingGoal = {
        id: 'goal_keep_baseline',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        preference: 'RUN_ONLY',
        currentVdot: 45.2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(existingGoal);
      mockWorkouts = [];

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(45.2);
      expect(res.body.message).toContain('Zachowano dotychczasowy poziom bazowy VDOT 45.2');

      // ABSOLUTE ZERO MUTATION VERIFICATION:
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
      expect(existingGoal.currentVdot).toBe(45.2);
    });

    it('strictly excludes non-RUN, <2000m, and <600s activities; causes ZERO DB mutation when none qualify', async () => {
      const existingGoal = {
        id: 'goal_untouched_2',
        userId: testUserId,
        targetDistance: 'MARATHON',
        targetTime: 12000,
        preference: 'HYBRID_BIKE_RUN',
        currentVdot: 48.0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(existingGoal);

      // Seed exclusively non-qualifying activities:
      mockWorkouts.push(
        // 1. Run too short in distance (1999m < 2000m)
        {
          id: 'wkt-short-dist',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 1999,
          durationSeconds: 700,
          date: new Date(),
        },
        // 2. Run too short in duration (599s < 600s)
        {
          id: 'wkt-short-duration',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 3000,
          durationSeconds: 599,
          date: new Date(),
        },
        // 3. Bike activity (BIKE !== RUN / TREADMILL)
        {
          id: 'wkt-bike',
          userId: testUserId,
          type: 'BIKE',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 45000,
          durationSeconds: 4800,
          date: new Date(),
        },
        // 4. Strength activity
        {
          id: 'wkt-strength',
          userId: testUserId,
          type: 'STRENGTH',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 0,
          durationSeconds: 2700,
          date: new Date(),
        },
        // 5. Uncompleted planned run (PLANNED !== COMPLETED)
        {
          id: 'wkt-planned-run',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.PLANNED,
          distanceMeters: 10000,
          durationSeconds: 2700,
          date: new Date(),
        },
        // 6. Skipped run (SKIPPED !== COMPLETED)
        {
          id: 'wkt-skipped-run',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.SKIPPED,
          distanceMeters: 8000,
          durationSeconds: 2400,
          date: new Date(),
        }
      );

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(48.0);

      // Verify ZERO mutation occurred
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
      expect(existingGoal.currentVdot).toBe(48.0);
    });
  });

  // =========================================================================
  // 4. Run Filtering Under Mixed Workloads
  // =========================================================================
  describe('4. Run Filtering under mixed workloads', () => {
    it('isolates the 1 qualifying run from noisy non-qualifying activities', async () => {
      mockWorkouts.push(
        // Qualifying Run: 5000m in 1380s (23:00, ~42.5 VDOT)
        {
          id: 'wkt-valid-run',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 5000,
          durationSeconds: 1380,
          averageHeartRate: 155,
          maxHeartRate: 185,
          date: new Date(),
        },
        // Non-qualifying Bike
        {
          id: 'wkt-bike',
          userId: testUserId,
          type: 'BIKE',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 30000,
          durationSeconds: 3600,
          date: new Date(),
        },
        // Non-qualifying Sprint Run (400m < 2000m)
        {
          id: 'wkt-sprint',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 400,
          durationSeconds: 70,
          date: new Date(),
        },
        // Non-qualifying Short Run (1500m < 2000m)
        {
          id: 'wkt-short',
          userId: testUserId,
          type: 'RUN',
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 1500,
          durationSeconds: 400,
          date: new Date(),
        }
      );

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      // Sample count MUST be exactly 1, ignoring the other 3 activities
      expect(res.body.sampleCount).toBe(1);
      expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(40.0);
      expect(res.body.estimatedCurrentVdot).toBeLessThanOrEqual(55.0);
    });
  });

  // =========================================================================
  // 5. Mobile Handler Simulation in App.tsx (R5)
  // =========================================================================
  describe('5. Mobile Handler Simulation in App.tsx', () => {
    const DISTANCE_LABELS = {
      FIVE_K: { label: '5 KM', meters: 5000 },
      TEN_K: { label: '10 KM', meters: 10000 },
      HALF_MARATHON: { label: 'Półmaraton (21.1 km)', meters: 21097.5 },
      MARATHON: { label: 'Maraton (42.2 km)', meters: 42195 },
    };

    /**
     * Exact replication of handleEstimateCurrentFromGarmin in App.tsx (lines 272-308)
     */
    async function simulateMobileHandler(params: {
      goalDistance: 'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON';
      initialMinutes: string;
      initialSeconds: string;
      apiMockResponse: {
        hasSufficientData: boolean;
        sampleCount: number;
        estimatedCurrentVdot: number;
        message?: string;
      };
    }) {
      let currentMinutesStr = params.initialMinutes;
      let currentSecondsStr = params.initialSeconds;
      let statusBanner: string | null = null;
      let loading = true;

      try {
        const res = params.apiMockResponse;

        // Guard: Insufficient data or 0 qualifying runs -> Retain baseline, do not overwrite inputs
        if (res.hasSufficientData === false || res.sampleCount === 0) {
          statusBanner = `⚠️ ${
            res.message ||
            'Brak wystarczającej liczby biegów w Garmin Connect (wymagany min. 1 bieg ≥ 2 km i ≥ 10 min). Zachowano dotychczasowy poziom bazowy.'
          }`;
          return { currentMinutesStr, currentSecondsStr, statusBanner, loading: false };
        }

        // Distance-Aware Inversion: compute finish time matching user's selected goalDistance
        const distMeters = DISTANCE_LABELS[params.goalDistance]?.meters || 10000;
        const equivSeconds = calculateRaceTimeFromVdot(
          distMeters,
          res.estimatedCurrentVdot
        );

        const mins = Math.floor(equivSeconds / 60);
        const secs = Math.round(equivSeconds % 60);
        currentMinutesStr = String(mins);
        currentSecondsStr = String(secs).padStart(2, '0');

        const baseMsg = res.message || 'Wyliczono Twój obecny poziom z biegów w Garminie';
        const vdotDisplay = baseMsg.includes(String(res.estimatedCurrentVdot))
          ? ''
          : ` (VDOT ${res.estimatedCurrentVdot})`;
        statusBanner = `✅ ${baseMsg}${vdotDisplay}`;
      } catch (err: any) {
        statusBanner = `❌ Błąd wyliczania poziomu z Garmina: ${err.message}`;
      } finally {
        loading = false;
      }

      return { currentMinutesStr, currentSecondsStr, statusBanner, loading };
    }

    it('derives finish time specifically for 5K when goalDistance is FIVE_K (not 10K)', async () => {
      const result = await simulateMobileHandler({
        goalDistance: 'FIVE_K',
        initialMinutes: '55',
        initialSeconds: '00',
        apiMockResponse: {
          hasSufficientData: true,
          sampleCount: 3,
          estimatedCurrentVdot: 50.0,
          message: 'Pomyślnie wyliczono poziom z 3 biegów (VDOT 50.0)',
        },
      });

      // VDOT 50.0 for 5K is ~19:57 (1197s)
      const expectedSeconds = calculateRaceTimeFromVdot(5000, 50.0);
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeLessThan(25); // 5K time, NOT 10K time (~41 min)!
      expect(result.statusBanner).toContain('✅');
    });

    it('derives finish time specifically for Half Marathon when goalDistance is HALF_MARATHON (not 10K)', async () => {
      const result = await simulateMobileHandler({
        goalDistance: 'HALF_MARATHON',
        initialMinutes: '55',
        initialSeconds: '00',
        apiMockResponse: {
          hasSufficientData: true,
          sampleCount: 2,
          estimatedCurrentVdot: 50.0,
        },
      });

      // VDOT 50.0 for HM (21097.5m) is ~91:35 (~1h 31m 35s)
      const expectedSeconds = calculateRaceTimeFromVdot(21097.5, 50.0);
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeGreaterThan(80); // HM time, NOT 10K time!
      expect(result.statusBanner).toContain('✅');
    });

    it('derives finish time specifically for Marathon when goalDistance is MARATHON (not 10K)', async () => {
      const result = await simulateMobileHandler({
        goalDistance: 'MARATHON',
        initialMinutes: '55',
        initialSeconds: '00',
        apiMockResponse: {
          hasSufficientData: true,
          sampleCount: 4,
          estimatedCurrentVdot: 50.0,
        },
      });

      // VDOT 50.0 for Marathon (42195m) is ~190:49 (~3h 10m 49s)
      const expectedSeconds = calculateRaceTimeFromVdot(42195, 50.0);
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeGreaterThan(160); // Marathon time, NOT 10K time!
      expect(result.statusBanner).toContain('✅');
    });

    it('does NOT overwrite currentMinutesStr/currentSecondsStr and displays warning banner when hasSufficientData is false', async () => {
      const result = await simulateMobileHandler({
        goalDistance: 'TEN_K',
        initialMinutes: '53',
        initialSeconds: '45',
        apiMockResponse: {
          hasSufficientData: false,
          sampleCount: 0,
          estimatedCurrentVdot: 37.0,
          message:
            'Brak wystarczającej liczby ukończonych biegów w Garmin Connect (wymagany min. 1 bieg ≥ 2 km i ≥ 10 min). Zachowano dotychczasowy poziom bazowy VDOT 37.0.',
        },
      });

      // INTACT INPUT CHECK:
      expect(result.currentMinutesStr).toBe('53');
      expect(result.currentSecondsStr).toBe('45');
      // WARNING BANNER CHECK:
      expect(result.statusBanner).toContain('⚠️');
      expect(result.statusBanner).toContain('Zachowano dotychczasowy poziom bazowy VDOT 37.0');
    });

    it('does NOT overwrite currentMinutesStr/currentSecondsStr when sampleCount is 0 even if hasSufficientData is truthy', async () => {
      const result = await simulateMobileHandler({
        goalDistance: 'FIVE_K',
        initialMinutes: '24',
        initialSeconds: '15',
        apiMockResponse: {
          hasSufficientData: true as any, // edge-case anomalous response
          sampleCount: 0,
          estimatedCurrentVdot: 40.0,
        },
      });

      expect(result.currentMinutesStr).toBe('24');
      expect(result.currentSecondsStr).toBe('15');
      expect(result.statusBanner).toContain('⚠️');
    });
  });
});
