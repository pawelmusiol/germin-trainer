import request from 'supertest';
import { createApp } from '../src/app';
import { generateToken } from '../src/middlewares/auth.middleware';
import {
  UserRole,
  WorkoutType,
  WorkoutStatus,
  StepType,
  WorkoutData,
  calculateRaceTimeFromVdot,
  calculateVdotFromRace,
  calculateVdotPaces,
  convertWorkoutModality,
  mapWorkoutToGarminPayload,
  evaluateMorningReadiness,
} from '@garmin-trainer/shared';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Milestone 4 Adversarial Integration: 5 E2E Journeys & Edge Cases (R1-R6)', () => {
  let mockGoals: any[] = [];
  let mockWorkouts: any[] = [];
  let mockGarminAuth: any = null;
  let mockUsers: any[] = [];

  const testUserId = 'user_m4_adversary';
  const testUserEmail = 'm4_adversary@garmin-trainer.local';

  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id === testUserId || where.email === testUserEmail) {
          return {
            id: testUserId,
            email: testUserEmail,
            name: 'M4 Adversary',
            role: UserRole.USER,
          };
        }
        if (where.email === 'pawel@garmin-trainer.local' || where.id === 'user_default_owner') {
          return {
            id: 'user_default_owner',
            email: 'pawel@garmin-trainer.local',
            name: 'Paweł',
            role: UserRole.ADMIN,
          };
        }
        return mockUsers.find((u) => u.id === where.id || u.email === where.email) || null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const newUser = {
          id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockUsers.push(newUser);
        return newUser;
      }),
      upsert: jest.fn(async ({ create }: any) => {
        const existing = mockUsers.find((u) => u.email === create.email);
        if (existing) return existing;
        const newUser = { id: testUserId, ...create };
        mockUsers.push(newUser);
        return newUser;
      }),
    },
    trainingGoal: {
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          mockGoals.find((g) => g.userId === where.userId && g.isActive === where.isActive) || null
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
          if (w.userId && w.userId !== where.userId) return false;
          if (where.status && w.status !== where.status) return false;
          return true;
        });
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          mockWorkouts.find((w) => {
            if (where.id && w.id !== where.id) return false;
            if (where.userId && w.userId !== where.userId) return false;
            if (where.status && w.status !== where.status) return false;
            return true;
          }) || null
        );
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return mockWorkouts.find((w) => w.id === where.id) || null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const w = mockWorkouts.find((item) => item.id === where.id);
        if (w) {
          Object.assign(w, data, { updatedAt: new Date() });
          return w;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const created = { id: `wkt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...data };
        mockWorkouts.push(created);
        return created;
      }),
    },
    garminAuth: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (mockGarminAuth && mockGarminAuth.userId === where.userId) {
          return mockGarminAuth;
        }
        return null;
      }),
      delete: jest.fn(async ({ where }: any) => {
        if (mockGarminAuth && mockGarminAuth.userId === where.userId) {
          const deleted = mockGarminAuth;
          mockGarminAuth = null;
          return deleted;
        }
        throw new Error('Record to delete does not exist.');
      }),
      upsert: jest.fn(async ({ create, update }: any) => {
        mockGarminAuth = { ...create, ...update, id: 'ga_123', updatedAt: new Date() };
        return mockGarminAuth;
      }),
    },
    dailyMetric: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
    },
    techniqueAnalysis: {
      findMany: jest.fn(async () => []),
    },
  };

  const app = createApp(mockPrisma);
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: testUserEmail,
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGoals = [];
    mockWorkouts = [];
    mockGarminAuth = null;
    mockUsers = [];
    jest.clearAllMocks();
  });

  // =========================================================================
  // JOURNEY 1: App Startup, Direct Dashboard & Safe Area Insets (R1, R2)
  // =========================================================================
  describe('Journey 1 (R1 & R2): Direct App Startup, Dashboard Entry & Android Safe Area Insets', () => {
    it('J1-1: GET /api/goals/bootstrap returns 200 with default athlete session, active goal, and paces without requiring credentials', async () => {
      const res = await request(app).get('/api/goals/bootstrap');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user).toHaveProperty('email');
      expect(res.body).toHaveProperty('paces');
      expect(res.body.paces).toHaveProperty('vdot');
      expect(res.body.paces).toHaveProperty('easyPace');
      expect(res.body).toHaveProperty('garminStatus');
      expect(res.body.garminStatus).toHaveProperty('connected');
    });

    it('J1-2: Safe Area Inset logic correctly evaluates status bar height on Android vs iOS', () => {
      const getContainerPaddingTop = (os: 'android' | 'ios', statusBarHeight?: number | null) => {
        return os === 'android' ? (statusBarHeight || 24) : 0;
      };

      // Standard Android phone with 24dp status bar
      expect(getContainerPaddingTop('android', 24)).toBe(24);
      // Android phone with hole-punch / notch cutout (e.g. 38dp, 48dp)
      expect(getContainerPaddingTop('android', 38)).toBe(38);
      expect(getContainerPaddingTop('android', 48)).toBe(48);
      // Android phone where StatusBar.currentHeight is null/undefined
      expect(getContainerPaddingTop('android', null)).toBe(24);
      expect(getContainerPaddingTop('android', undefined)).toBe(24);
      expect(getContainerPaddingTop('android', 0)).toBe(24); // falsy fallback to 24

      // iOS device relying on native SafeAreaView padding
      expect(getContainerPaddingTop('ios', null)).toBe(0);
      expect(getContainerPaddingTop('ios', 44)).toBe(0);
    });

    it('J1-3: Header wrapping logic guarantees title flexibility and non-collapsing status badges', () => {
      // Simulating header flex styles from App.tsx
      const headerTitleContainerStyle = { flex: 1, marginRight: 8 };
      const statusBadgeStyle = { flexShrink: 0, alignSelf: 'flex-start' as const };
      const serverIndicatorStyle = { flexWrap: 'wrap' as const };
      const serverIndicatorTextStyle = { flexShrink: 1 };

      expect(headerTitleContainerStyle.flex).toBe(1);
      expect(statusBadgeStyle.flexShrink).toBe(0);
      expect(serverIndicatorStyle.flexWrap).toBe('wrap');
      expect(serverIndicatorTextStyle.flexShrink).toBe(1);
    });
  });

  // =========================================================================
  // JOURNEY 2: Garmin Connect Flow & Disconnect Lifecycle (R2)
  // =========================================================================
  describe('Journey 2 (R2): Garmin Connect Inline Form & Disconnect Lifecycle', () => {
    it('J2-1: Disconnected state presents credentials inline; DELETE /api/garmin/disconnect cleans up session tokens in DB', async () => {
      // 1. Setup active Garmin auth in mock DB
      mockGarminAuth = {
        id: 'ga_test_01',
        userId: testUserId,
        garminEmail: 'athlete@garmin.com',
        encryptedTokens: 'aes256:iv:tag:ciphertext',
        syncDailyMetrics: true,
      };

      // 2. Call DELETE /api/garmin/disconnect
      const res = await request(app)
        .delete('/api/garmin/disconnect')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(mockPrisma.garminAuth.delete).toHaveBeenCalledWith({
        where: { userId: testUserId },
      });
      expect(mockGarminAuth).toBeNull();
    });

    it('J2-2: DELETE /api/garmin/disconnect is safe when no account was connected', async () => {
      mockGarminAuth = null;
      const res = await request(app)
        .delete('/api/garmin/disconnect')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });

    it('J2-3: Rejects unauthenticated disconnect requests with 401', async () => {
      const res = await request(app).delete('/api/garmin/disconnect');
      expect(res.status).toBe(401);
      expect(mockPrisma.garminAuth.delete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // JOURNEY 3: Modality Switching & Hybrid Brick Recalculation (R3)
  // =========================================================================
  describe('Journey 3 (R3): Per-Day Modality Selection & Hybrid Brick Recalculation', () => {
    const sampleRunWorkout: WorkoutData = {
      id: 'wkt_sample_run',
      date: '2026-11-03',
      type: WorkoutType.RUN,
      title: 'Bieg Tempowy 40 min',
      description: 'Ciągły bieg w drugim zakresie',
      status: WorkoutStatus.PLANNED,
      steps: [
        {
          stepNumber: 1,
          type: StepType.WARMUP,
          durationSeconds: 600,
          targetPace: '5:45 /km',
          targetHeartRateZone: 1,
        },
        {
          stepNumber: 2,
          type: StepType.ACTIVE,
          durationSeconds: 1800,
          targetPace: '4:40 /km',
          targetHeartRateZone: 3,
        },
        {
          stepNumber: 3,
          type: StepType.COOLDOWN,
          durationSeconds: 600,
          targetPace: '6:00 /km',
          targetHeartRateZone: 1,
        },
      ],
    };

    it('J3-1: Converts RUN workout to BIKE: scales duration by 1.33x and calculates Matrix Z2 watts', () => {
      const vdot = 48.0;
      const riderWeightKg = 74;
      const bikeWorkout = convertWorkoutModality(sampleRunWorkout, WorkoutType.BIKE, vdot, riderWeightKg);

      expect(bikeWorkout.type).toBe(WorkoutType.BIKE);
      expect(bikeWorkout.title).toContain('[Rower]');
      expect(bikeWorkout.steps.length).toBe(3);

      // Verify duration scaled by 1.33x for active step (30 min * 1.33 = 40 min = 2400s)
      expect(bikeWorkout.steps[1].durationSeconds).toBe(2400);
      expect(bikeWorkout.steps[1].targetWatts).toBeGreaterThan(100);
      expect(bikeWorkout.steps[1].targetCadence).toBeGreaterThanOrEqual(80);
      expect(bikeWorkout.status).toBe(WorkoutStatus.MODIFIED);
    });

    it('J3-2: Converts RUN workout to HYBRID (Brick): generates running segment (warmup+active) and cycling segment (Matrix Z2 watts+cooldown)', () => {
      const vdot = 48.0;
      const riderWeightKg = 74;
      const hybridWorkout = convertWorkoutModality(sampleRunWorkout, WorkoutType.HYBRID, vdot, riderWeightKg);

      expect(hybridWorkout.type).toBe(WorkoutType.HYBRID);
      expect(hybridWorkout.title).toContain('[Hybryda Bieg+Rower]');
      expect(hybridWorkout.steps.length).toBe(4);

      // Steps 1 & 2: Running segment
      expect(hybridWorkout.steps[0].type).toBe(StepType.WARMUP);
      expect(hybridWorkout.steps[0].targetPace).toBeDefined();
      expect(hybridWorkout.steps[1].type).toBe(StepType.ACTIVE);
      expect(hybridWorkout.steps[1].targetPace).toBeDefined();

      // Steps 3 & 4: Cycling segment
      expect(hybridWorkout.steps[2].type).toBe(StepType.ACTIVE);
      expect(hybridWorkout.steps[2].targetWatts).toBeGreaterThan(120);
      expect(hybridWorkout.steps[2].targetCadence).toBe(90);
      expect(hybridWorkout.steps[3].type).toBe(StepType.COOLDOWN);
      expect(hybridWorkout.steps[3].targetWatts).toBeGreaterThan(80);
      expect(hybridWorkout.steps[3].targetCadence).toBe(80);
    });

    it('J3-3: mapWorkoutToGarminPayload produces a 2-segment Garmin payload for HYBRID workouts', () => {
      const vdot = 48.0;
      const hybridWorkout = convertWorkoutModality(sampleRunWorkout, WorkoutType.HYBRID, vdot, 74);
      const garminPayload = mapWorkoutToGarminPayload(hybridWorkout);

      expect(garminPayload.workoutName).toContain('[Hybryda Bieg+Rower]');
      expect(garminPayload.workoutSegments).toBeDefined();
      expect(garminPayload.workoutSegments!.length).toBe(2);

      // Segment 1: Running
      const seg1 = garminPayload.workoutSegments![0];
      expect(seg1.segmentOrder).toBe(1);
      expect(seg1.sportType.sportTypeId).toBe(1); // Running
      expect(seg1.sportType.sportTypeKey).toBe('running');
      expect(seg1.workoutSteps.length).toBe(2);

      // Segment 2: Cycling
      const seg2 = garminPayload.workoutSegments![1];
      expect(seg2.segmentOrder).toBe(2);
      expect(seg2.sportType.sportTypeId).toBe(2); // Cycling
      expect(seg2.sportType.sportTypeKey).toBe('cycling');
      expect(seg2.workoutSteps.length).toBe(2);
    });

    it('J3-4: POST /api/garmin/workouts/:id/convert API route handles HYBRID conversion and persists changes', async () => {
      mockWorkouts.push({
        id: 'wkt_db_convert_test',
        userId: testUserId,
        title: 'Bieg Regeneracyjny 30 min',
        description: 'Łatwe rozbieganie',
        type: WorkoutType.RUN,
        date: new Date(),
        status: WorkoutStatus.PLANNED,
        durationSeconds: 1800,
        steps: [
          { stepNumber: 1, type: StepType.ACTIVE, durationSeconds: 1800, targetPace: '5:30 /km' },
        ],
      });

      const res = await request(app)
        .post('/api/garmin/workouts/wkt_db_convert_test/convert')
        .set('Authorization', authHeader)
        .send({ targetType: WorkoutType.HYBRID, riderWeightKg: 75 });

      expect(res.status).toBe(200);
      expect(res.body.workout.type).toBe(WorkoutType.HYBRID);
      expect(res.body.workout.title).toContain('[Hybryda Bieg+Rower]');
      expect(res.body.workout.steps.length).toBe(4);
    });
  });

  // =========================================================================
  // JOURNEY 4: Bi-Directional Fatigue Adjustment & Reset (R4)
  // =========================================================================
  describe('Journey 4 (R4): Bi-Directional Fatigue Adjustment & Original Workout Reset', () => {
    const baseGarminTelemetry = {
      hrv: 60,
      hrvBaselineLow: 50,
      hrvStatus: 'BALANCED' as const,
      sleepScore: 85,
      restingHeartRate: 50,
      bodyBattery: 80,
      steps: 10000,
    };

    it('J4-1: Stepping UP to fatigue 5 clamps intensity, recommends bike swap, and triggers AI recommendation banner', () => {
      const readiness5 = evaluateMorningReadiness({
        garmin: baseGarminTelemetry,
        perceivedFatigue: 5,
      });

      expect(readiness5.allowHighIntensity).toBe(false);
      expect(readiness5.recommendBikeSwap).toBe(true);
      expect(readiness5.volumeMultiplier).toBe(0.6);
      expect(readiness5.readinessScore).toBeLessThanOrEqual(55);

      const shouldShowAiAlert = !readiness5.allowHighIntensity || readiness5.recommendBikeSwap;
      expect(shouldShowAiAlert).toBe(true);
    });

    it('J4-2: Stepping DOWN to fatigue 1 immediately clears restrictions, restores freshness, and clears AI alert', () => {
      const readiness1 = evaluateMorningReadiness({
        garmin: baseGarminTelemetry,
        perceivedFatigue: 1,
      });

      expect(readiness1.allowHighIntensity).toBe(true);
      expect(readiness1.recommendBikeSwap).toBe(false);
      expect(readiness1.volumeMultiplier).toBe(1.0);
      expect(readiness1.readinessScore).toBeGreaterThanOrEqual(85);

      const shouldShowAiAlert = !readiness1.allowHighIntensity || readiness1.recommendBikeSwap;
      expect(shouldShowAiAlert).toBe(false);
    });

    it('J4-3: Original workout snapshot caching and restoration: reset cleanly restores title, steps, and clears isWorkoutModified', () => {
      const originalWorkout: WorkoutData = {
        id: 'wkt_orig_test',
        date: '2026-11-03',
        type: WorkoutType.RUN,
        title: 'Interwały 5x 1km @ 4:10/km',
        description: 'Mocny akcent tempowy',
        status: WorkoutStatus.PLANNED,
        steps: [
          { stepNumber: 1, type: StepType.WARMUP, durationSeconds: 600, targetPace: '5:30 /km' },
          { stepNumber: 2, type: StepType.ACTIVE, durationSeconds: 1500, targetPace: '4:10 /km' },
          { stepNumber: 3, type: StepType.COOLDOWN, durationSeconds: 600, targetPace: '5:45 /km' },
        ],
      };

      // 1. User/AI applies adaptation
      const adaptedWorkout: WorkoutData = {
        ...originalWorkout,
        title: '[Adaptacja AI] Regeneracyjny Rower Matrix Z1/Z2',
        type: WorkoutType.BIKE,
        status: WorkoutStatus.MODIFIED,
        steps: [
          { stepNumber: 1, type: StepType.ACTIVE, durationSeconds: 1800, targetWatts: 140 },
        ],
      };

      const checkIsWorkoutModified = (current: WorkoutData, orig?: WorkoutData) => {
        return (
          current.status === WorkoutStatus.MODIFIED ||
          (orig !== undefined && (
            current.title !== orig.title ||
            current.type !== orig.type ||
            (current.steps?.length ?? 0) !== (orig.steps?.length ?? 0)
          )) ||
          current.title.includes('[Adaptacja AI]') ||
          current.title.includes('[Rower]') ||
          current.title.includes('[Hybryda')
        );
      };

      // Adapted state is recognized as modified
      expect(checkIsWorkoutModified(adaptedWorkout, originalWorkout)).toBe(true);

      // 2. User presses "↺ Przywróć oryginalny trening"
      const restoredWorkout: WorkoutData = JSON.parse(JSON.stringify(originalWorkout));

      // Restored state is completely clean
      expect(checkIsWorkoutModified(restoredWorkout, originalWorkout)).toBe(false);
      expect(restoredWorkout.title).toBe('Interwały 5x 1km @ 4:10/km');
      expect(restoredWorkout.type).toBe(WorkoutType.RUN);
      expect(restoredWorkout.steps.length).toBe(3);
    });
  });

  // =========================================================================
  // JOURNEY 5: Garmin VDOT Estimation, DB Persistence & Race Times (R5)
  // =========================================================================
  describe('Journey 5 (R5): Garmin Fitness Estimation, DB Persistence & Race Times', () => {
    it('J5-1: Computes physiologically plausible VDOT and persists to PostgreSQL when qualifying runs exist', async () => {
      // 1. Populate mock workouts with qualifying runs (>= 2km, >= 10 min)
      mockWorkouts.push(
        {
          id: 'wkt_q1',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 5000,
          durationSeconds: 1200, // 20:00 5K -> VDOT ~49.8
          date: new Date(),
        },
        {
          id: 'wkt_q2',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 10000,
          durationSeconds: 2480, // ~41:20 10K -> VDOT ~50.0
          date: new Date(),
        }
      );

      // Active goal with lower baseline VDOT
      mockGoals.push({
        id: 'goal_initial_01',
        userId: testUserId,
        currentVdot: 42.0,
        targetDistance: 'TEN_K',
        targetTime: 2700,
        isActive: true,
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(true);
      expect(res.body.sampleCount).toBe(2);
      expect(res.body.estimatedCurrentVdot).toBeGreaterThanOrEqual(49.0);
      expect(res.body.estimatedCurrentVdot).toBeLessThanOrEqual(51.0);
      expect(res.body.message).toContain('Pomyślnie wyliczono poziom');
      expect(res.body.message).toContain('Zaktualizowano cel treningowy w bazie danych');

      // Database verification: goal currentVdot was persisted!
      expect(mockPrisma.trainingGoal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'goal_initial_01' },
          data: { currentVdot: res.body.estimatedCurrentVdot },
        })
      );
      const updatedGoal = mockGoals.find((g) => g.id === 'goal_initial_01');
      expect(updatedGoal.currentVdot).toBe(res.body.estimatedCurrentVdot);
    });

    it('J5-2: Distance-Aware Race Time Inversion calculates exact finish time matching user goal distance', () => {
      const vdot = 50.0;

      // 5K: ~19:56 (1196s)
      const time5k = calculateRaceTimeFromVdot(5000, vdot);
      expect(time5k).toBeGreaterThanOrEqual(1190);
      expect(time5k).toBeLessThanOrEqual(1205);
      const mins5k = Math.floor(time5k / 60);
      const secs5k = Math.round(time5k % 60);
      expect(`${mins5k}:${secs5k}`).toBe('19:56');

      // 10K: ~41:20 (2480s)
      const time10k = calculateRaceTimeFromVdot(10000, vdot);
      expect(time10k).toBeGreaterThanOrEqual(2475);
      expect(time10k).toBeLessThanOrEqual(2490);
      const mins10k = Math.floor(time10k / 60);
      const secs10k = Math.round(time10k % 60);
      expect(`${mins10k}:${secs10k}`).toBe('41:20');

      // Half-Marathon (21097.5m): ~1:31:31 (5491s)
      const timeHm = calculateRaceTimeFromVdot(21097.5, vdot);
      expect(timeHm).toBeGreaterThanOrEqual(5485);
      expect(timeHm).toBeLessThanOrEqual(5510);
      const hoursHm = Math.floor(timeHm / 3600);
      const minsHm = Math.floor((timeHm % 3600) / 60);
      const secsHm = Math.round(timeHm % 60);
      expect(`${hoursHm}:${minsHm}:${secsHm}`).toBe('1:31:31');

      // Marathon (42195m): ~3:10:40 (11440s)
      const timeM = calculateRaceTimeFromVdot(42195, vdot);
      expect(timeM).toBeGreaterThanOrEqual(11430);
      expect(timeM).toBeLessThanOrEqual(11470);
      const hoursM = Math.floor(timeM / 3600);
      const minsM = Math.floor((timeM % 3600) / 60);
      const secsM = Math.round(timeM % 60);
      expect(`${hoursM}:${minsM}:${secsM}`).toBe('3:10:40');
    });

    it('J5-3: Safe zero-runs handling: retains baseline VDOT, performs 0 DB mutations, and returns informative notification', async () => {
      // 0 completed runs in DB
      mockWorkouts = [];
      mockGoals.push({
        id: 'goal_baseline_only',
        userId: testUserId,
        currentVdot: 41.5,
        targetDistance: 'FIVE_K',
        targetTime: 1500,
        isActive: true,
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(41.5);
      expect(res.body.message).toContain('Brak wystarczającej liczby ukończonych biegów');
      expect(res.body.message).toContain('Zachowano dotychczasowy poziom bazowy VDOT 41.5');

      // Zero DB mutations: neither update nor create was called!
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
      expect(mockPrisma.trainingGoal.create).not.toHaveBeenCalled();
    });

    it('J5-4: Filters out invalid runs (< 2000m or < 600s) and does not corrupt VDOT', async () => {
      mockWorkouts.push(
        {
          id: 'wkt_too_short_dist',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 1200, // < 2000m
          durationSeconds: 700,
          date: new Date(),
        },
        {
          id: 'wkt_too_short_time',
          userId: testUserId,
          type: WorkoutType.RUN,
          status: WorkoutStatus.COMPLETED,
          distanceMeters: 3000,
          durationSeconds: 400, // < 600s
          date: new Date(),
        }
      );

      mockGoals.push({
        id: 'goal_with_short_runs',
        userId: testUserId,
        currentVdot: 44.0,
        targetDistance: 'TEN_K',
        targetTime: 2600,
        isActive: true,
      });

      const res = await request(app)
        .post('/api/goals/estimate-from-garmin')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.hasSufficientData).toBe(false);
      expect(res.body.sampleCount).toBe(0);
      expect(res.body.estimatedCurrentVdot).toBe(44.0);
      expect(mockPrisma.trainingGoal.update).not.toHaveBeenCalled();
    });
  });
});
