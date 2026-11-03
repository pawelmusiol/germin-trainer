import { PrismaClient } from '@prisma/client';
import {
  BiomechanicalFlaw,
  CorrectiveExercise,
  ReadinessEvaluation,
  StepType,
  TargetDistance,
  TrainingPreference,
  WorkoutData,
  WorkoutStatus,
  WorkoutStep,
  WorkoutType,
  analyzeBiomechanicalCues,
  buildStructuredWeeklyMicrocycle,
  calculateSafeWeeklyVolumeLimit,
  calculateVdotFromRace,
  convertWorkoutModality,
  evaluateMorningReadiness,
  injectCorrectiveExercisesIntoWorkout,
} from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';

export interface GeneratePlanInput {
  startDate?: string;
  targetDistance?: string;
  targetTimeSeconds?: number;
  eventDate?: string;
  preference?: 'RUN_ONLY' | 'HYBRID_BIKE_RUN' | 'HYBRID';
  currentVdot?: number;
  riderWeightKg?: number;
  previousWeekDistanceMeters?: number;
}

export interface MorningAdaptationResult {
  readiness: ReadinessEvaluation;
  modificationRecommended: boolean;
  coachExplanation: string;
  originalWorkout: any;
  proposedWorkout: WorkoutData;
  applied: boolean;
}

export interface AnalyzeVideoInput {
  videoUrl: string;
  cadenceObserved?: number;
  groundContactTime?: number;
  verticalOscillation?: number;
  notes?: string;
  applyToPlannedWorkouts?: boolean;
}

export class AiTrainerService {
  private readonly prisma: PrismaClient;
  private readonly geminiApiKey: string;

  constructor(
    prismaClient: PrismaClient = defaultPrisma,
    geminiApiKey: string = process.env.GEMINI_API_KEY || ''
  ) {
    this.prisma = prismaClient;
    this.geminiApiKey = geminiApiKey;
  }

  /**
   * Builds a compact, token-efficient JSON prompt (<300 tokens) for Gemini Flash.
   */
  public buildCompactAdaptationPrompt(context: {
    vdot: number;
    readiness: ReadinessEvaluation;
    metrics: any;
    plannedTitle: string;
  }): string {
    return JSON.stringify({
      task: 'Adapt daily endurance workout based on Garmin recovery & physical work fatigue',
      vdot: context.vdot,
      readinessScore: context.readiness.readinessScore,
      status: context.readiness.status,
      allowHighIntensity: context.readiness.allowHighIntensity,
      recommendBikeSwap: context.readiness.recommendBikeSwap,
      reasons: context.readiness.reasons,
      metrics: {
        hrv: context.metrics?.hrv ?? null,
        sleepScore: context.metrics?.sleepScore ?? null,
        bodyBattery: context.metrics?.bodyBattery ?? null,
        steps: context.metrics?.steps ?? null,
        fatigueSlider: context.metrics?.perceivedFatigue ?? null,
      },
      plannedWorkout: context.plannedTitle,
    });
  }

  /**
   * Generates a 7-day training plan tailored to the user's goal, VDOT, modality preference
   * (RUN_ONLY vs HYBRID_BIKE_RUN), +10% volume guardrail, and any active technique drills.
   */
  public async generateTrainingPlan(
    userId: string,
    input: GeneratePlanInput = {}
  ): Promise<{
    goal: any;
    safeWeeklyDistanceLimitMeters: number;
    workouts: any[];
  }> {
    let activeGoal = await this.prisma.trainingGoal.findFirst({
      where: { userId, isActive: true },
    });

    const computedVdot =
      input.currentVdot ||
      activeGoal?.currentVdot ||
      (input.targetTimeSeconds ? calculateVdotFromRace(10000, input.targetTimeSeconds) : 45);

    const resolvedPref =
      input.preference === 'HYBRID' || input.preference === 'HYBRID_BIKE_RUN'
        ? 'HYBRID_BIKE_RUN'
        : input.preference === 'RUN_ONLY'
        ? 'RUN_ONLY'
        : (activeGoal?.preference as 'RUN_ONLY' | 'HYBRID_BIKE_RUN') || 'RUN_ONLY';

    if (!activeGoal && (input.targetDistance || input.currentVdot)) {
      activeGoal = await this.prisma.trainingGoal.create({
        data: {
          userId,
          targetDistance: (input.targetDistance as any) || 'TEN_K',
          targetTime: input.targetTimeSeconds ?? 2700,
          eventDate: input.eventDate ? new Date(input.eventDate) : null,
          preference: resolvedPref as any,
          currentVdot: computedVdot,
          isActive: true,
        },
      });
    }

    // Check most recent technique analysis for corrective drills
    const latestAnalyses = await this.prisma.techniqueAnalysis.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 1,
    });

    const correctiveExercises: CorrectiveExercise[] =
      latestAnalyses.length > 0 && Array.isArray(latestAnalyses[0].correctiveExercises)
        ? (latestAnalyses[0].correctiveExercises as unknown as CorrectiveExercise[])
        : [];

    const safeWeeklyDistanceLimitMeters = calculateSafeWeeklyVolumeLimit(
      input.previousWeekDistanceMeters || 25000
    );

    const startDateIso = input.startDate || new Date().toISOString().slice(0, 10);
    const templates = buildStructuredWeeklyMicrocycle({
      startDateIso,
      vdot: computedVdot,
      preference: resolvedPref,
      riderWeightKg: input.riderWeightKg || 72,
      correctiveExercises,
    });

    const createdWorkouts: any[] = [];
    for (const tpl of templates) {
      const durationSeconds = tpl.steps.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
      const distanceMeters = tpl.steps.reduce((sum, s) => sum + (s.distanceMeters || 0), 0);

      const created = await this.prisma.workout.create({
        data: {
          userId,
          date: new Date(tpl.date),
          type: tpl.type as any,
          title: tpl.title,
          description: tpl.description ?? null,
          steps: tpl.steps as any,
          status: WorkoutStatus.PLANNED as any,
          durationSeconds: durationSeconds > 0 ? durationSeconds : null,
          distanceMeters: distanceMeters > 0 ? distanceMeters : null,
        },
      });
      createdWorkouts.push(created);
    }

    return {
      goal: activeGoal || { currentVdot: computedVdot, preference: resolvedPref },
      safeWeeklyDistanceLimitMeters,
      workouts: createdWorkouts,
    };
  }

  /**
   * Morning AI & Physiology Adaptation Engine (7:00 AM workflow):
   * Inspects overnight Garmin recovery (HRV, Sleep, Body Battery) + previous day physical work
   * (Steps, Stress, Perceived Fatigue 1-5) and adapts the scheduled workout.
   */
  public async evaluateMorningAdaptation(
    userId: string,
    workoutId: string,
    options: { date?: string; applyImmediately?: boolean; riderWeightKg?: number } = {}
  ): Promise<MorningAdaptationResult> {
    const workoutRecord = await this.prisma.workout.findFirst({
      where: { id: workoutId, userId },
    });

    if (!workoutRecord) {
      const err: any = new Error('Workout not found');
      err.statusCode = 404;
      throw err;
    }

    const dateStr = (
      options.date ||
      (workoutRecord.date instanceof Date
        ? workoutRecord.date.toISOString()
        : String(workoutRecord.date))
    ).slice(0, 10);
    const dateObj = new Date(`${dateStr}T00:00:00.000Z`);

    const dailyMetric = await this.prisma.dailyMetric.findUnique({
      where: {
        userId_date: {
          userId,
          date: dateObj,
        },
      },
    });

    const activeGoal = await this.prisma.trainingGoal.findFirst({
      where: { userId, isActive: true },
    });
    const vdot = activeGoal?.currentVdot || 45;

    const readiness = evaluateMorningReadiness({
      garmin: {
        hrv: dailyMetric?.hrv ?? null,
        sleepScore: dailyMetric?.sleepScore ?? null,
        restingHeartRate: dailyMetric?.restingHeartRate ?? null,
        bodyBattery: dailyMetric?.bodyBattery ?? null,
        steps: dailyMetric?.steps ?? null,
      },
      perceivedFatigue: dailyMetric?.perceivedFatigue ?? null,
      note: dailyMetric?.note ?? null,
    });

    const currentSteps: WorkoutStep[] = Array.isArray(workoutRecord.steps)
      ? (workoutRecord.steps as unknown as WorkoutStep[])
      : [];

    let proposedWorkout: WorkoutData = {
      id: workoutRecord.id,
      userId: workoutRecord.userId,
      date:
        workoutRecord.date instanceof Date
          ? workoutRecord.date.toISOString()
          : String(workoutRecord.date),
      type: workoutRecord.type as WorkoutType,
      title: workoutRecord.title,
      description: workoutRecord.description,
      steps: currentSteps,
      status: workoutRecord.status as WorkoutStatus,
      garminWorkoutId: workoutRecord.garminWorkoutId,
    };

    const modificationRecommended =
      !readiness.allowHighIntensity ||
      readiness.recommendBikeSwap ||
      readiness.volumeMultiplier < 1.0;

    let coachExplanation = `Gotowość poranna: ${readiness.readinessScore}/100 (${readiness.status}). ${readiness.reasons.join(' ')}`;

    if (modificationRecommended) {
      if (readiness.recommendBikeSwap && proposedWorkout.type === WorkoutType.RUN) {
        const convertedBike = convertWorkoutModality(
          proposedWorkout,
          WorkoutType.BIKE,
          vdot,
          options.riderWeightKg || 72
        );
        // Scale down bike duration & power to recovery/aerobic Zone 1-2
        const scaledSteps = convertedBike.steps.map((s) => ({
          ...s,
          durationSeconds: s.durationSeconds
            ? Math.max(300, Math.round(s.durationSeconds * readiness.volumeMultiplier))
            : 1200,
          targetWatts: s.targetWatts ? Math.round(s.targetWatts * 0.8) : 135,
          targetHeartRateZone: Math.min(2, s.targetHeartRateZone || 2),
        }));
        proposedWorkout = {
          ...convertedBike,
          title: `[Adaptacja AI] Regeneracyjny Rower Matrix Z1/Z2`,
          description: `Zmodyfikowano z treningu "${workoutRecord.title}" ze względu na: ${readiness.reasons.join('; ')}.`,
          steps: scaledSteps,
          status: WorkoutStatus.MODIFIED,
        };
        coachExplanation +=
          ' Zalecam zamianę dzisiejszego biegu na odciążający stawy trening tlenowy na rowerze stacjonarnym Matrix.';
      } else {
        // Keep running modality, but scale volume & cap intensity at Zone 2
        const adaptedSteps = currentSteps.map((s) => ({
          ...s,
          durationSeconds: s.durationSeconds
            ? Math.max(180, Math.round(s.durationSeconds * readiness.volumeMultiplier))
            : undefined,
          distanceMeters: s.distanceMeters
            ? Math.max(400, Math.round(s.distanceMeters * readiness.volumeMultiplier))
            : undefined,
          targetHeartRateZone: !readiness.allowHighIntensity
            ? Math.min(2, s.targetHeartRateZone || 2)
            : s.targetHeartRateZone,
          notes: !readiness.allowHighIntensity
            ? 'Obniżona intensywność (Strefa 2) – ochrona przed przetrenowaniem'
            : s.notes,
        }));
        proposedWorkout = {
          ...proposedWorkout,
          title: `[Adaptacja AI] ${workoutRecord.title} (${Math.round(readiness.volumeMultiplier * 100)}% objętości)`,
          description: `Adaptacja poranna AI: ${readiness.reasons.join('; ')}`,
          steps: adaptedSteps,
          status: WorkoutStatus.MODIFIED,
        };
        coachExplanation += ` Zredukowano objętość do ${Math.round(readiness.volumeMultiplier * 100)}% i obniżono intensywność do bezpiecznej Strefy 2.`;
      }
    }

    let applied = false;
    if (options.applyImmediately && modificationRecommended) {
      const totalDuration = proposedWorkout.steps.reduce(
        (acc, s) => acc + (s.durationSeconds || 0),
        0
      );
      await this.prisma.workout.update({
        where: { id: workoutRecord.id },
        data: {
          type: proposedWorkout.type as any,
          title: proposedWorkout.title,
          description: proposedWorkout.description ?? null,
          steps: proposedWorkout.steps as any,
          status: WorkoutStatus.MODIFIED as any,
          durationSeconds: totalDuration > 0 ? totalDuration : workoutRecord.durationSeconds,
        },
      });
      applied = true;
    }

    return {
      readiness,
      modificationRecommended,
      coachExplanation,
      originalWorkout: workoutRecord,
      proposedWorkout,
      applied,
    };
  }

  /**
   * AI Biomechanical Running Gait Video Analysis (Phase 3):
   * Analyzes video recording + Garmin Running Dynamics (cadence, GCT, vertical oscillation),
   * stores TechniqueAnalysis in DB, and automatically injects corrective drills into planned workouts.
   */
  public async analyzeTechniqueVideo(
    userId: string,
    input: AnalyzeVideoInput
  ): Promise<{
    analysis: any;
    updatedWorkoutsCount: number;
  }> {
    if (!input.videoUrl || typeof input.videoUrl !== 'string') {
      const err: any = new Error('videoUrl is required for technique analysis');
      err.statusCode = 400;
      throw err;
    }

    const { flaws, exercises } = analyzeBiomechanicalCues({
      cadenceSpm: input.cadenceObserved,
      groundContactTimeMs: input.groundContactTime,
      verticalOscillationCm: input.verticalOscillation,
      userNotes: input.notes,
    });

    const summary = `Analiza biomechaniczna wideo wykryła ${flaws.length} obszary do korekty (${flaws
      .map((f) => f.flawType)
      .join(', ')}). Przypisano ${exercises.length} dedykowane ćwiczenia korygujące do rozgrzewek biegowych.`;

    const analysisRecord = await this.prisma.techniqueAnalysis.create({
      data: {
        userId,
        date: new Date(),
        videoUrl: input.videoUrl,
        biomechanicalFlaws: flaws as any,
        correctiveExercises: exercises as any,
        summary,
        cadenceObserved: input.cadenceObserved ?? null,
        groundContactTime: input.groundContactTime ?? null,
        verticalOscillation: input.verticalOscillation ?? null,
      },
    });

    let updatedWorkoutsCount = 0;
    if (input.applyToPlannedWorkouts !== false) {
      const plannedRuns = await this.prisma.workout.findMany({
        where: {
          userId,
          type: WorkoutType.RUN as any,
          status: WorkoutStatus.PLANNED as any,
        },
      });

      for (const run of plannedRuns) {
        const domainWorkout: WorkoutData = {
          id: run.id,
          userId: run.userId,
          date: run.date instanceof Date ? run.date.toISOString() : String(run.date),
          type: run.type as WorkoutType,
          title: run.title,
          description: run.description,
          steps: Array.isArray(run.steps) ? (run.steps as unknown as WorkoutStep[]) : [],
          status: run.status as WorkoutStatus,
        };

        const enriched = injectCorrectiveExercisesIntoWorkout(domainWorkout, exercises);
        await this.prisma.workout.update({
          where: { id: run.id },
          data: {
            description: enriched.description ?? null,
            steps: enriched.steps as any,
          },
        });
        updatedWorkoutsCount++;
      }
    }

    return {
      analysis: analysisRecord,
      updatedWorkoutsCount,
    };
  }
}
