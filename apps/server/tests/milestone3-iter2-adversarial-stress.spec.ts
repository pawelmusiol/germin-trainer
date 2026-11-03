import request from 'supertest';
import { createApp } from '../src/app';
import { generateToken } from '../src/middlewares/auth.middleware';
import {
  UserRole,
  WorkoutStatus,
  WorkoutType,
  calculateRaceTimeFromVdot,
  calculateVdotFromRace,
} from '@garmin-trainer/shared';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Milestone 3 Iteration 2: Deep Adversarial Stress Harness for DB Persistence & Mobile Handler (R5)', () => {
  let mockGoals: any[] = [];
  let mockWorkouts: any[] = [];

  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        return {
          id: where.id || 'user_m3_iter2_challenger',
          email: 'challenger.iter2@garmin-trainer.local',
          name: 'Challenger Iter2',
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
  const testUserId = 'user_m3_iter2_challenger';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'challenger.iter2@garmin-trainer.local',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGoals = [];
    mockWorkouts = [];
    jest.clearAllMocks();
  });

  // =========================================================================
  // SECTION 1: AUTHENTICATION & SECURITY BOUNDARIES
  // =========================================================================
  describe('Section 1: Authentication & Security Boundaries', () => {
    it('AUTH-1: Rejects missing Authorization header with 401 and zero DB calls', async () => {
      const res = await request(app).post('/api/goals/estimate-from-garmin');
      expect(res.status).toBe(401);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('AUTH-2: Rejects empty Bearer token with 401 and zero DB calls', async () => {
      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('AUTH-3: Rejects malformed / corrupted JWT token with 401', async () => {
      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.corrupted.signature');
      expect(res.status).toBe(401);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('AUTH-4: Rejects non-Bearer schemes (Token, Basic) with 401', async () => {
      const res1 = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Token some-api-key');
      expect(res1.status).toBe(401);

      const res2 = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res2.status).toBe(401);

      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // SECTION 2: DATABASE MUTATION INTEGRITY & PERSISTENCE
  // =========================================================================
  describe('Section 2: Database Mutation Integrity & Persistence', () => {
    it('PERSIST-1: Mutates existing active goal, updating currentVdot while preserving all other fields', async () => {
      const initialGoal = {
        id: 'active_goal_preserve_fields',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        preference: 'HYBRID_BIKE_RUN',
        currentVdot: 37.0,
        isActive: true,
        notes: 'Pre-existing custom coach instructions',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      };
      mockGoals.push(initialGoal);

      // Seed 2 qualifying runs: 5K in 23:30, 8K in 38:00
      mockWorkouts.push(
        {
          id: 'wkt-q1',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 5000,
          durationSeconds: 1410,
          averageHeartRate: 154,
          maxHeartRate: 184,
          date: new Date('2026-10-25'),
        },
        {
          id: 'wkt-q2',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 8000,
          durationSeconds: 2280,
          averageHeartRate: 156,
          maxHeartRate: 184,
          date: new Date('2026-10-28'),
        }
      );

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(2);
      expect(typeof res.body.estimatedCurrentVdot).toBe('number');
      expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(40.0);

      // Verify DB update was called once with exact ID
      expect(mockPrisma.trainingGoal.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.trainingGoal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'active_goal_preserve_fields' },
          data: { currentVdot: res.body.estimatedCurrentVdot },
        })
      );

      // Verify that the persisted record retains other goal fields untouched
      const updatedGoal = mockGoals.find((g) => g.id === 'active_goal_preserve_fields');
      expect(updatedGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);
      expect(updatedGoal.targetDistance).toBe('TEN_K');
      expect(updatedGoal.targetTime).toBe(2700);
      expect(updatedGoal.preference).toBe('HYBRID_BIKE_RUN');
      expect(updatedGoal.notes).toBe('Pre-existing custom coach instructions');
    });

    it('PERSIST-2: Creates a new active goal when no active goal exists yet', async () => {
      expect(mockGoals).toHaveLength(0);

      mockWorkouts.push({
        id: 'wkt-first-qualifying',
        userId: testUserId,
        type: WorkoutType.TREADMILL,
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 5000,
        durationSeconds: 1500,
        averageHeartRate: 152,
        maxHeartRate: 180,
        date: new Date(),
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(mockPrisma.trainingGoal.create).toHaveBeenCalledTimes(1);
      expect(mockGoals).toHaveLength(1);
      expect(mockGoals[0].currentVdot).toBe(res.body.estimatedCurrentVdot);
      expect(mockGoals[0].isActive).toBe(true);
      expect(mockGoals[0].userId).toBe(testUserId);
    });

    it('PERSIST-3: Successive estimation calls idempotently update the goal without data corruption', async () => {
      const activeGoal = {
        id: 'active_goal_repeat',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        preference: 'RUN_ONLY',
        currentVdot: 38.0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(activeGoal);

      mockWorkouts.push({
        id: 'wkt-run-idempotent',
        userId: testUserId,
        type: WorkoutType.RUN,
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 5000,
        durationSeconds: 1350,
        averageHeartRate: 155,
        maxHeartRate: 185,
        date: new Date(),
      });

      const res1 = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);
      const res2 = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.estimatedCurrentVdot).toBe(res2.body.estimatedCurrentVdot);
      expect(mockGoals).toHaveLength(1);
      expect(mockGoals[0].currentVdot).toBe(res1.body.estimatedCurrentVdot);
    });
  });

  // =========================================================================
  // SECTION 3: ABSOLUTE ZERO MUTATION ON NON-QUALIFYING ACTIVITIES
  // =========================================================================
  describe('Section 3: Absolute Zero Mutation on Non-Qualifying Activities', () => {
    it('ZERO-MUTATION-1: 0 completed runs retains baseline VDOT and NEVER calls update or create', async () => {
      const activeGoal = {
        id: 'active_goal_untouched_1',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        preference: 'RUN_ONLY',
        currentVdot: 43.7,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(activeGoal);
      mockWorkouts = [];

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(43.7);
      expect(res.body.message).toContain('Zachowano dotychczasowy poziom bazowy VDOT 43.7');

      // ABSOLUTE ZERO MUTATION PROOF
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
      expect(activeGoal.currentVdot).toBe(43.7);
    });

    it('ZERO-MUTATION-2: Boundary distance and duration edge cases strictly excluded from calculation', async () => {
      const activeGoal = {
        id: 'active_goal_boundary',
        userId: testUserId,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        preference: 'RUN_ONLY',
        currentVdot: 41.2,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockGoals.push(activeGoal);

      // Seed borderline non-qualifying activities:
      mockWorkouts.push(
        // 1999m (just under 2000m threshold)
        {
          id: 'wkt-dist-1999',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 1999,
          durationSeconds: 650,
          date: new Date(),
        },
        // 599s (just under 600s threshold)
        {
          id: 'wkt-dur-599',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 2500,
          durationSeconds: 599,
          date: new Date(),
        },
        // 0 distance
        {
          id: 'wkt-dist-0',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 0,
          durationSeconds: 1200,
          date: new Date(),
        },
        // 0 duration
        {
          id: 'wkt-dur-0',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 5000,
          durationSeconds: 0,
          date: new Date(),
        },
        // Negative distance
        {
          id: 'wkt-neg-dist',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: -5000,
          durationSeconds: 1500,
          date: new Date(),
        },
        // Non-RUN modalities
        {
          id: 'wkt-bike',
          userId: testUserId,
          type: WorkoutType.BIKE,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 30000,
          durationSeconds: 3600,
          date: new Date(),
        },
        {
          id: 'wkt-strength',
          userId: testUserId,
          type: WorkoutType.STRENGTH,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 0,
          durationSeconds: 2400,
          date: new Date(),
        },
        {
          id: 'wkt-hybrid',
          userId: testUserId,
          type: WorkoutType.HYBRID,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 15000,
          durationSeconds: 2700,
          date: new Date(),
        },
        // Non-COMPLETED statuses
        {
          id: 'wkt-planned',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.PLANNED,
          distanceMeters: 10000,
          durationSeconds: 3000,
          date: new Date(),
        },
        {
          id: 'wkt-skipped',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.SKIPPED,
          distanceMeters: 5000,
          durationSeconds: 1500,
          date: new Date(),
        }
      );

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(41.2);

      // Verify ZERO mutation occurred across all adversarial activities
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
      expect(activeGoal.currentVdot).toBe(41.2);
    });

    it('ZERO-MUTATION-3: Qualifies exact boundaries: distance >= 2000m AND duration >= 600s', async () => {
      mockWorkouts.push({
        id: 'wkt-exact-boundary',
        userId: testUserId,
        type: WorkoutType.RUN,
        status: WorkoutStatus.COMPLETED,
        distanceMeters: 2000, // EXACT 2000m
        durationSeconds: 600, // EXACT 600s (10:00)
        averageHeartRate: 150,
        maxHeartRate: 180,
        date: new Date(),
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(1);
      expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(30.0);
    });
  });

  // =========================================================================
  // SECTION 4: RUN FILTERING & NOISE ISOLATION
  // =========================================================================
  describe('Section 4: Run Filtering & Noise Isolation', () => {
    it('FILTER-1: Accurately filters 2 qualifying runs from 7 noisy non-qualifying activities', async () => {
      mockWorkouts.push(
        // Valid 1: RUN 5000m, 1440s
        {
          id: 'wkt-v1',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 5000,
          durationSeconds: 1440,
          averageHeartRate: 152,
          date: new Date(),
        },
        // Valid 2: TREADMILL 6000m, 1800s
        {
          id: 'wkt-v2',
          userId: testUserId,
          type: WorkoutType.TREADMILL,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 6000,
          durationSeconds: 1800,
          averageHeartRate: 155,
          date: new Date(),
        },
        // Noise 1: BIKE
        {
          id: 'wkt-n1',
          userId: testUserId,
          type: WorkoutType.BIKE,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 20000,
          durationSeconds: 2400,
          date: new Date(),
        },
        // Noise 2: STRENGTH
        {
          id: 'wkt-n2',
          userId: testUserId,
          type: WorkoutType.STRENGTH,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 0,
          durationSeconds: 1800,
          date: new Date(),
        },
        // Noise 3: Too short RUN (1800m)
        {
          id: 'wkt-n3',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 1800,
          durationSeconds: 700,
          date: new Date(),
        },
        // Noise 4: Too short duration (500s)
        {
          id: 'wkt-n4',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 3000,
          durationSeconds: 500,
          date: new Date(),
        },
        // Noise 5: Planned run
        {
          id: 'wkt-n5',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.PLANNED,
          distanceMeters: 10000,
          durationSeconds: 3000,
          date: new Date(),
        }
      );

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(2);
      expect(res.body.estimatedCurrentVdot).toBeGreaterThan(35);
      expect(res.body.estimatedCurrentVdot).toBeLessThan(70);
    });
  });

  // =========================================================================
  // SECTION 5: MOBILE HANDLER SIMULATION IN App.tsx (R5)
  // =========================================================================
  describe('Section 5: Mobile Handler Simulation in App.tsx (R5)', () => {
    const DISTANCE_LABELS = {
      FIVE_K: { label: '5 KM', meters: 5000 },
      TEN_K: { label: '10 KM', meters: 10000 },
      HALF_MARATHON: { label: 'Półmaraton (21.1 km)', meters: 21097.5 },
      MARATHON: { label: 'Maraton (42.2 km)', meters: 42195 },
    };

    /**
     * Exact simulation of handleEstimateCurrentFromGarmin in App.tsx (lines 272-308)
     */
    async function simulateAppHandler(params: {
      goalDistance: 'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON';
      initialMinutes: string;
      initialSeconds: string;
      apiCall: () => Promise<any>;
    }) {
      let currentMinutesStr = params.initialMinutes;
      let currentSecondsStr = params.initialSeconds;
      let statusBanner: string | null = null;
      let loading = true;

      try {
        const res = await params.apiCall();

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

    it('MOBILE-1: Derives 5K finish time specifically for FIVE_K (not 10K time)', async () => {
      const vdot = 48.0;
      const expectedSeconds = calculateRaceTimeFromVdot(5000, vdot); // ~20:46
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      const result = await simulateAppHandler({
        goalDistance: 'FIVE_K',
        initialMinutes: '55',
        initialSeconds: '00',
        apiCall: async () => ({
          hasSufficientData: true,
          sampleCount: 3,
          estimatedCurrentVdot: vdot,
          message: 'Pomyślnie wyliczono poziom z 3 biegów',
        }),
      });

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeLessThan(25);
      expect(result.statusBanner).toContain('✅');
    });

    it('MOBILE-2: Derives Half Marathon finish time specifically for HALF_MARATHON (not 10K time)', async () => {
      const vdot = 48.0;
      const expectedSeconds = calculateRaceTimeFromVdot(21097.5, vdot); // ~1h 35m
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      const result = await simulateAppHandler({
        goalDistance: 'HALF_MARATHON',
        initialMinutes: '55',
        initialSeconds: '00',
        apiCall: async () => ({
          hasSufficientData: true,
          sampleCount: 2,
          estimatedCurrentVdot: vdot,
        }),
      });

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeGreaterThan(80);
      expect(result.statusBanner).toContain('✅');
    });

    it('MOBILE-3: Derives Marathon finish time specifically for MARATHON (not 10K time)', async () => {
      const vdot = 48.0;
      const expectedSeconds = calculateRaceTimeFromVdot(42195, vdot); // ~3h 19m
      const expectedMins = Math.floor(expectedSeconds / 60);
      const expectedSecs = Math.round(expectedSeconds % 60);

      const result = await simulateAppHandler({
        goalDistance: 'MARATHON',
        initialMinutes: '55',
        initialSeconds: '00',
        apiCall: async () => ({
          hasSufficientData: true,
          sampleCount: 4,
          estimatedCurrentVdot: vdot,
        }),
      });

      expect(result.currentMinutesStr).toBe(String(expectedMins));
      expect(result.currentSecondsStr).toBe(String(expectedSecs).padStart(2, '0'));
      expect(Number(result.currentMinutesStr)).toBeGreaterThan(180);
      expect(result.statusBanner).toContain('✅');
    });

    it('MOBILE-4: Strictly obeys monotonicity: 5K < 10K < Half Marathon < Marathon times for identical VDOT', async () => {
      const vdot = 45.0;
      const distances: Array<'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON'> = [
        'FIVE_K',
        'TEN_K',
        'HALF_MARATHON',
        'MARATHON',
      ];
      const results: number[] = [];

      for (const dist of distances) {
        const res = await simulateAppHandler({
          goalDistance: dist,
          initialMinutes: '0',
          initialSeconds: '0',
          apiCall: async () => ({
            hasSufficientData: true,
            sampleCount: 2,
            estimatedCurrentVdot: vdot,
          }),
        });
        const totalSecs = parseInt(res.currentMinutesStr, 10) * 60 + parseInt(res.currentSecondsStr, 10);
        results.push(totalSecs);
      }

      // Ensure strictly ascending: 5K < 10K < HM < Marathon
      expect(results[0]).toBeLessThan(results[1]); // 5K < 10K
      expect(results[1]).toBeLessThan(results[2]); // 10K < HM
      expect(results[2]).toBeLessThan(results[3]); // HM < Marathon
    });

    it('MOBILE-5: When hasSufficientData is false, inputs are NOT overwritten and warning banner is displayed', async () => {
      const result = await simulateAppHandler({
        goalDistance: 'MARATHON',
        initialMinutes: '210',
        initialSeconds: '45',
        apiCall: async () => ({
          hasSufficientData: false,
          sampleCount: 0,
          estimatedCurrentVdot: 37.0,
          message: 'Brak wystarczającej liczby ukończonych biegów w Garmin Connect.',
        }),
      });

      expect(result.currentMinutesStr).toBe('210');
      expect(result.currentSecondsStr).toBe('45');
      expect(result.statusBanner).toContain('⚠️');
      expect(result.statusBanner).toContain('Brak wystarczającej liczby ukończonych biegów');
    });

    it('MOBILE-6: When network error occurs, inputs are NOT overwritten and error banner is displayed', async () => {
      const result = await simulateAppHandler({
        goalDistance: 'FIVE_K',
        initialMinutes: '22',
        initialSeconds: '30',
        apiCall: async () => {
          throw new Error('Network timeout connecting to backend server');
        },
      });

      expect(result.currentMinutesStr).toBe('22');
      expect(result.currentSecondsStr).toBe('30');
      expect(result.statusBanner).toContain('❌');
      expect(result.statusBanner).toContain('Network timeout');
    });
  });
});
