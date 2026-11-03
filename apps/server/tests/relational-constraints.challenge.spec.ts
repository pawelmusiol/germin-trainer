import { PrismaClient, Prisma, UserRole, GoalDistance, TrainingPreference, WorkoutType, WorkoutStatus } from '@prisma/client';
import {
  UserRole as SharedUserRole,
  TargetDistance as SharedTargetDistance,
  TrainingPreference as SharedTrainingPreference,
  WorkoutType as SharedWorkoutType,
  WorkoutStatus as SharedWorkoutStatus,
} from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../src/db';
import prismaExport from '../src/db';

describe('Challenger M2-2: Relational Constraints, Model Typing & Singleton Harness', () => {
  describe('1. db.ts PrismaClient Singleton Verification', () => {
    it('verifies default export and named export refer to the exact same instance', () => {
      expect(defaultPrisma).toBeDefined();
      expect(prismaExport).toBeDefined();
      expect(defaultPrisma).toBe(prismaExport);
    });

    it('verifies globalThis caching holds the exact instance in non-production mode', () => {
      const globalObject = globalThis as unknown as { prisma?: PrismaClient };
      expect(globalObject.prisma).toBeDefined();
      expect(globalObject.prisma).toBe(defaultPrisma);
    });

    it('verifies subsequent dynamic module imports return the same singleton reference', () => {
      // Re-requiring db module to test singleton caching preservation
      const reimported = require('../src/db');
      expect(reimported.prisma).toBe(defaultPrisma);
      expect(reimported.default).toBe(defaultPrisma);
    });

    it('verifies all 6 model delegates exist and expose standard Prisma query methods', () => {
      const delegates = [
        { name: 'user', delegate: defaultPrisma.user },
        { name: 'garminAuth', delegate: defaultPrisma.garminAuth },
        { name: 'trainingGoal', delegate: defaultPrisma.trainingGoal },
        { name: 'dailyMetric', delegate: defaultPrisma.dailyMetric },
        { name: 'workout', delegate: defaultPrisma.workout },
        { name: 'techniqueAnalysis', delegate: defaultPrisma.techniqueAnalysis },
      ];

      for (const { name, delegate } of delegates) {
        expect(delegate).toBeDefined();
        expect(typeof (delegate as any).findMany).toBe('function');
        expect(typeof (delegate as any).findFirst).toBe('function');
        expect(typeof (delegate as any).create).toBe('function');
        expect(typeof (delegate as any).update).toBe('function');
        expect(typeof (delegate as any).delete).toBe('function');
      }
    });
  });

  describe('2. DMMF Model Metadata & Field Structure Verification', () => {
    const models = Prisma.dmmf.datamodel.models;
    const modelNames = models.map((m) => m.name);

    it('defines exactly the 6 required domain models in Prisma datamodel', () => {
      const expectedModels = [
        'User',
        'GarminAuth',
        'TrainingGoal',
        'DailyMetric',
        'Workout',
        'TechniqueAnalysis',
      ];
      for (const expected of expectedModels) {
        expect(modelNames).toContain(expected);
      }
    });

    it('verifies User model fields and types', () => {
      const userModel = models.find((m) => m.name === 'User')!;
      expect(userModel).toBeDefined();
      const fields = Object.fromEntries(userModel.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.email).toMatchObject({ type: 'String', isUnique: true, isRequired: true });
      expect(fields.passwordHash).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.name).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.role).toMatchObject({ type: 'UserRole', isRequired: true });
      expect(fields.createdAt).toMatchObject({ type: 'DateTime', isRequired: true });
      expect(fields.updatedAt).toMatchObject({ type: 'DateTime', isRequired: true });
    });

    it('verifies GarminAuth model fields and types', () => {
      const model = models.find((m) => m.name === 'GarminAuth')!;
      expect(model).toBeDefined();
      const fields = Object.fromEntries(model.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.userId).toMatchObject({ type: 'String', isUnique: true, isRequired: true });
      expect(fields.ciphertext).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.iv).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.authTag).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.expiresAt).toMatchObject({ type: 'DateTime', isRequired: false });
    });

    it('verifies TrainingGoal model fields and types', () => {
      const model = models.find((m) => m.name === 'TrainingGoal')!;
      expect(model).toBeDefined();
      const fields = Object.fromEntries(model.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.userId).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.targetDistance).toMatchObject({ type: 'GoalDistance', isRequired: true });
      expect(fields.customDistanceMeters).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.targetTime).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.eventDate).toMatchObject({ type: 'DateTime', isRequired: false });
      expect(fields.preference).toMatchObject({ type: 'TrainingPreference', isRequired: true });
      expect(fields.currentVdot).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.isActive).toMatchObject({ type: 'Boolean', isRequired: true });
      expect(fields.notes).toMatchObject({ type: 'String', isRequired: false });
    });

    it('verifies DailyMetric model fields and types', () => {
      const model = models.find((m) => m.name === 'DailyMetric')!;
      expect(model).toBeDefined();
      const fields = Object.fromEntries(model.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.userId).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.date).toMatchObject({ type: 'DateTime', isRequired: true });
      expect(fields.hrv).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.sleepScore).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.restingHeartRate).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.bodyBattery).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.steps).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.perceivedFatigue).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.note).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.rawGarminData).toMatchObject({ type: 'Json', isRequired: false });
    });

    it('verifies Workout model fields and types', () => {
      const model = models.find((m) => m.name === 'Workout')!;
      expect(model).toBeDefined();
      const fields = Object.fromEntries(model.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.userId).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.date).toMatchObject({ type: 'DateTime', isRequired: true });
      expect(fields.type).toMatchObject({ type: 'WorkoutType', isRequired: true });
      expect(fields.title).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.description).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.steps).toMatchObject({ type: 'Json', isRequired: true });
      expect(fields.status).toMatchObject({ type: 'WorkoutStatus', isRequired: true });
      expect(fields.garminWorkoutId).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.garminActivityId).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.durationSeconds).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.distanceMeters).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.averageHeartRate).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.averagePowerWatts).toMatchObject({ type: 'Int', isRequired: false });
      expect(fields.notes).toMatchObject({ type: 'String', isRequired: false });
    });

    it('verifies TechniqueAnalysis model fields and types', () => {
      const model = models.find((m) => m.name === 'TechniqueAnalysis')!;
      expect(model).toBeDefined();
      const fields = Object.fromEntries(model.fields.map((f) => [f.name, f]));

      expect(fields.id).toMatchObject({ type: 'String', isId: true });
      expect(fields.userId).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.date).toMatchObject({ type: 'DateTime', isRequired: true });
      expect(fields.videoUrl).toMatchObject({ type: 'String', isRequired: true });
      expect(fields.biomechanicalFlaws).toMatchObject({ type: 'Json', isRequired: true });
      expect(fields.correctiveExercises).toMatchObject({ type: 'Json', isRequired: true });
      expect(fields.summary).toMatchObject({ type: 'String', isRequired: false });
      expect(fields.cadenceObserved).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.verticalOscillation).toMatchObject({ type: 'Float', isRequired: false });
      expect(fields.groundContactTime).toMatchObject({ type: 'Float', isRequired: false });
    });
  });

  describe('3. Referential Cascading Delete (onDelete: Cascade) Verification', () => {
    const models = Prisma.dmmf.datamodel.models;
    const childModels = [
      'GarminAuth',
      'TrainingGoal',
      'DailyMetric',
      'Workout',
      'TechniqueAnalysis',
    ];

    it.each(childModels)(
      'enforces onDelete: Cascade on foreign key relation to User in model %s',
      (modelName) => {
        const model = models.find((m) => m.name === modelName);
        expect(model).toBeDefined();

        const userRelation = model!.fields.find((f) => f.name === 'user' && f.type === 'User');
        expect(userRelation).toBeDefined();
        expect(userRelation!.relationFromFields).toContain('userId');
        expect(userRelation!.relationToFields).toContain('id');
        expect(userRelation!.relationOnDelete).toBe('Cascade');
      }
    );
  });

  describe('4. Unique Constraints & Indexing Verification', () => {
    const models = Prisma.dmmf.datamodel.models;

    it('verifies compound unique constraint @@unique([userId, date]) on DailyMetric', () => {
      const dailyMetricModel = models.find((m) => m.name === 'DailyMetric')!;
      expect(dailyMetricModel).toBeDefined();

      const compoundUnique = dailyMetricModel.uniqueFields.find(
        (fields) => fields.includes('userId') && fields.includes('date')
      );
      expect(compoundUnique).toEqual(['userId', 'date']);
    });

    it('verifies DailyMetricWhereUniqueInput compound selector typing', () => {
      // Compile-time and runtime check of compound selector object shape
      const queryWhere: Prisma.DailyMetricWhereUniqueInput = {
        userId_date: {
          userId: 'test-user-cuid',
          date: new Date('2026-11-02T00:00:00.000Z'),
        },
      };

      expect(queryWhere.userId_date).toBeDefined();
      expect(queryWhere.userId_date?.userId).toBe('test-user-cuid');
    });

    it('verifies GarminAuth enforces 1:1 uniqueness on userId', () => {
      const garminAuthModel = models.find((m) => m.name === 'GarminAuth')!;
      const userIdField = garminAuthModel.fields.find((f) => f.name === 'userId')!;
      expect(userIdField.isUnique).toBe(true);
    });

    it('verifies User enforces unique constraint on email', () => {
      const userModel = models.find((m) => m.name === 'User')!;
      const emailField = userModel.fields.find((f) => f.name === 'email')!;
      expect(emailField.isUnique).toBe(true);
    });

    it('verifies compound uniqueIndexes and secondary performance indexes', () => {
      const dailyMetric = models.find((m) => m.name === 'DailyMetric')!;
      expect(dailyMetric.uniqueIndexes).toEqual([
        { name: null, fields: ['userId', 'date'] },
      ]);

      const garminAuth = models.find((m) => m.name === 'GarminAuth')!;
      const gaUserIdField = garminAuth.fields.find((f) => f.name === 'userId')!;
      expect(gaUserIdField.isUnique).toBe(true);

      // Verify secondary indexes directly in schema.prisma definition
      const fs = require('fs');
      const path = require('path');
      const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');

      expect(schemaContent).toContain('@@index([expiresAt])');
      expect(schemaContent).toContain('@@index([userId, isActive])');
      expect(schemaContent).toContain('@@index([isActive])');
      expect(schemaContent).toContain('@@index([userId])');
      expect(schemaContent).toContain('@@index([date])');
      expect(schemaContent).toContain('@@index([status])');
      expect(schemaContent).toContain('@@index([garminWorkoutId])');
    });
  });

  describe('5. Generated TypeScript Interface Compatibility & Enum Divergence Analysis', () => {
    it('verifies that mock objects satisfying Prisma model types compile cleanly', () => {
      const mockUser: import('@prisma/client').User = {
        id: 'cuid_u1',
        email: 'athlete@example.com',
        passwordHash: '$2b$10$hashedstring',
        name: 'Runner',
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(mockUser.id).toBe('cuid_u1');

      const mockDailyMetric: import('@prisma/client').DailyMetric = {
        id: 'cuid_dm1',
        userId: mockUser.id,
        date: new Date('2026-11-02'),
        hrv: 65.5,
        sleepScore: 88,
        restingHeartRate: 48,
        bodyBattery: 92,
        steps: 12500,
        perceivedFatigue: 2,
        note: 'Feeling recovered and ready for interval session',
        rawGarminData: { sleepQuality: 'EXCELLENT', remMinutes: 110 },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(mockDailyMetric.hrv).toBe(65.5);

      const mockGoal: import('@prisma/client').TrainingGoal = {
        id: 'cuid_tg1',
        userId: mockUser.id,
        targetDistance: GoalDistance.MARATHON,
        customDistanceMeters: null,
        targetTime: 10800,
        eventDate: new Date('2027-04-15'),
        preference: TrainingPreference.RUN_ONLY,
        currentVdot: 54.2,
        isActive: true,
        notes: 'Sub-3 hour marathon attempt',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(mockGoal.targetDistance).toBe('MARATHON');

      const mockWorkout: import('@prisma/client').Workout = {
        id: 'cuid_w1',
        userId: mockUser.id,
        date: new Date('2026-11-03'),
        type: WorkoutType.RUN,
        title: '5x1000m VO2max Intervals',
        description: 'Warm-up 2km, 5x1km @ 3:35/km with 2:30 recovery jog, cooldown 2km',
        steps: [
          { step: 1, type: 'WARMUP', durationSeconds: 600 },
          { step: 2, type: 'INTERVAL', distanceMeters: 1000, targetPace: '3:35' },
        ],
        status: WorkoutStatus.PLANNED,
        garminWorkoutId: 'gw-987654',
        garminActivityId: null,
        durationSeconds: 3600,
        distanceMeters: 10000,
        averageHeartRate: null,
        averagePowerWatts: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(mockWorkout.type).toBe('RUN');

      const mockAnalysis: import('@prisma/client').TechniqueAnalysis = {
        id: 'cuid_ta1',
        userId: mockUser.id,
        date: new Date('2026-11-01'),
        videoUrl: 'https://storage.example.com/videos/gait_analysis_01.mp4',
        biomechanicalFlaws: [{ flaw: 'Overstriding', severity: 'MODERATE' }],
        correctiveExercises: [{ drill: 'A-Skips', frequency: 'Daily warm-up' }],
        summary: 'Slight overstriding detected at 4:00/km pace. Increase cadence by 5 spm.',
        cadenceObserved: 168.0,
        verticalOscillation: 8.5,
        groundContactTime: 245.0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(mockAnalysis.cadenceObserved).toBe(168.0);
    });

    it('adversarially documents and tests enum value divergence between @garmin-trainer/shared and @prisma/client', () => {
      // 1. UserRole is 1:1 compatible
      expect(UserRole.USER).toBe(SharedUserRole.USER);
      expect(UserRole.ADMIN).toBe(SharedUserRole.ADMIN);

      // 2. TrainingPreference: Shared has HYBRID, Prisma has HYBRID_BIKE_RUN
      expect(TrainingPreference.RUN_ONLY).toBe(SharedTrainingPreference.RUN_ONLY);
      // Adversarial observation: Prisma is HYBRID_BIKE_RUN while Shared is HYBRID
      expect(TrainingPreference.HYBRID_BIKE_RUN).toBe('HYBRID_BIKE_RUN');
      expect((SharedTrainingPreference as any).HYBRID).toBe('HYBRID');

      // 3. GoalDistance: Shared has '5K' string value, Prisma has 'FIVE_K'
      expect(GoalDistance.FIVE_K).toBe('FIVE_K');
      expect(SharedTargetDistance.FIVE_K).toBe('5K');
      expect(GoalDistance.TEN_K).toBe('TEN_K');
      expect(SharedTargetDistance.TEN_K).toBe('10K');

      // 4. WorkoutType: Prisma includes OTHER (superset)
      expect(WorkoutType.RUN).toBe(SharedWorkoutType.RUN);
      expect(WorkoutType.OTHER).toBe('OTHER');

      // 5. WorkoutStatus: Prisma includes MODIFIED (superset)
      expect(WorkoutStatus.PLANNED).toBe(SharedWorkoutStatus.PLANNED);
      expect(WorkoutStatus.MODIFIED).toBe('MODIFIED');
    });
  });
});
