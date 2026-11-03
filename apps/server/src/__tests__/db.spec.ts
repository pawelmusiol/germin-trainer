import { prisma } from '../db';
import {
  UserRole,
  GoalDistance,
  TrainingPreference,
  WorkoutType,
  WorkoutStatus,
} from '@prisma/client';

describe('Database Schema & Prisma Client', () => {
  it('exports singleton PrismaClient instance with all required model delegates', () => {
    expect(prisma).toBeDefined();
    expect(prisma.user).toBeDefined();
    expect(typeof prisma.user.findMany).toBe('function');
    expect(prisma.garminAuth).toBeDefined();
    expect(typeof prisma.garminAuth.findUnique).toBe('function');
    expect(prisma.trainingGoal).toBeDefined();
    expect(typeof prisma.trainingGoal.findFirst).toBe('function');
    expect(prisma.dailyMetric).toBeDefined();
    expect(typeof prisma.dailyMetric.findUnique).toBe('function');
    expect(prisma.workout).toBeDefined();
    expect(typeof prisma.workout.findMany).toBe('function');
    expect(prisma.techniqueAnalysis).toBeDefined();
    expect(typeof prisma.techniqueAnalysis.findMany).toBe('function');
  });

  it('exports all 5 required enum types matching domain specifications', () => {
    // UserRole
    expect(UserRole.USER).toBe('USER');
    expect(UserRole.ADMIN).toBe('ADMIN');

    // GoalDistance
    expect(GoalDistance.FIVE_K).toBe('FIVE_K');
    expect(GoalDistance.TEN_K).toBe('TEN_K');
    expect(GoalDistance.HALF_MARATHON).toBe('HALF_MARATHON');
    expect(GoalDistance.MARATHON).toBe('MARATHON');
    expect(GoalDistance.CUSTOM).toBe('CUSTOM');

    // TrainingPreference
    expect(TrainingPreference.RUN_ONLY).toBe('RUN_ONLY');
    expect(TrainingPreference.HYBRID_BIKE_RUN).toBe('HYBRID_BIKE_RUN');

    // WorkoutType
    expect(WorkoutType.RUN).toBe('RUN');
    expect(WorkoutType.BIKE).toBe('BIKE');
    expect(WorkoutType.TREADMILL).toBe('TREADMILL');
    expect(WorkoutType.STRENGTH).toBe('STRENGTH');
    expect(WorkoutType.OTHER).toBe('OTHER');

    // WorkoutStatus
    expect(WorkoutStatus.PLANNED).toBe('PLANNED');
    expect(WorkoutStatus.COMPLETED).toBe('COMPLETED');
    expect(WorkoutStatus.SKIPPED).toBe('SKIPPED');
    expect(WorkoutStatus.MODIFIED).toBe('MODIFIED');
  });
});
