import {
  GarminEndCondition,
  GarminExecutableStepDto,
  GarminSportType,
  GarminStepType,
  GarminTargetType,
  GarminWorkoutPayload,
  GarminWorkoutSegment,
  StepType,
  WorkoutData,
  WorkoutStep,
  WorkoutStatus,
  WorkoutType,
} from './types';
import {
  calculateVdotPaces,
  convertRunToBikeDuration,
  convertRunToBikeWatts,
  parsePace,
} from './vdot';

/**
 * Maps internal WorkoutType to Garmin SportType metadata.
 */
export function resolveGarminSportType(type: WorkoutType): GarminSportType {
  switch (type) {
    case WorkoutType.RUN:
    case WorkoutType.TREADMILL:
      return { sportTypeId: 1, sportTypeKey: 'running' };
    case WorkoutType.BIKE:
      return { sportTypeId: 2, sportTypeKey: 'cycling' };
    case WorkoutType.STRENGTH:
      return { sportTypeId: 5, sportTypeKey: 'strength_training' };
    case WorkoutType.HYBRID:
      return { sportTypeId: 1, sportTypeKey: 'running' };
    default:
      return { sportTypeId: 1, sportTypeKey: 'running' };
  }
}

/**
 * Maps internal StepType to Garmin StepType metadata.
 */
export function resolveGarminStepType(stepType: StepType): GarminStepType {
  switch (stepType) {
    case StepType.WARMUP:
      return { stepTypeId: 1, stepTypeKey: 'warmup' };
    case StepType.COOLDOWN:
      return { stepTypeId: 2, stepTypeKey: 'cooldown' };
    case StepType.ACTIVE:
    case StepType.REPEAT:
      return { stepTypeId: 3, stepTypeKey: 'interval' };
    case StepType.RECOVERY:
      return { stepTypeId: 4, stepTypeKey: 'recovery' };
    default:
      return { stepTypeId: 3, stepTypeKey: 'interval' };
  }
}

/**
 * Converts a pace string (e.g. "4:30 /km" or "5:15 /km - 5:40 /km")
 * into Garmin speed range in meters per second (m/s).
 * Note: Slower pace (more sec/km) = lower speed (targetValueOne),
 * Faster pace (fewer sec/km) = higher speed (targetValueTwo).
 */
export function paceRangeToMetersPerSecond(
  paceStr: string,
  toleranceSeconds: number = 5
): { minSpeedMps: number; maxSpeedMps: number } | null {
  if (!paceStr || typeof paceStr !== 'string') {
    return null;
  }

  if (paceStr.includes('-')) {
    const parts = paceStr.split('-').map((p) => parsePace(p));
    if (parts.length === 2 && parts[0] > 0 && parts[1] > 0) {
      const fasterSec = Math.min(parts[0], parts[1]);
      const slowerSec = Math.max(parts[0], parts[1]);
      return {
        minSpeedMps: Number((1000 / slowerSec).toFixed(3)),
        maxSpeedMps: Number((1000 / fasterSec).toFixed(3)),
      };
    }
  }

  const baseSec = parsePace(paceStr);
  if (baseSec <= 0) {
    return null;
  }

  const fasterSec = Math.max(120, baseSec - toleranceSeconds);
  const slowerSec = baseSec + toleranceSeconds;

  return {
    minSpeedMps: Number((1000 / slowerSec).toFixed(3)),
    maxSpeedMps: Number((1000 / fasterSec).toFixed(3)),
  };
}

/**
 * Converts a single WorkoutStep into a GarminExecutableStepDto.
 */
export function mapStepToGarminStepDto(
  step: WorkoutStep,
  index: number
): GarminExecutableStepDto {
  const stepType = resolveGarminStepType(step.type);

  // Determine end condition: time (2), distance (3), or lap button (1)
  let endCondition: GarminEndCondition;
  let endConditionValue: number | null = null;

  if (step.durationSeconds && step.durationSeconds > 0) {
    endCondition = { conditionTypeId: 2, conditionTypeKey: 'time' };
    endConditionValue = Math.round(step.durationSeconds);
  } else if (step.distanceMeters && step.distanceMeters > 0) {
    endCondition = { conditionTypeId: 3, conditionTypeKey: 'distance' };
    endConditionValue = Math.round(step.distanceMeters);
  } else {
    endCondition = { conditionTypeId: 1, conditionTypeKey: 'lap.button' };
    endConditionValue = null;
  }

  // Determine target type: Watts (power), Pace, Heart Rate Zone, Cadence, or No Target
  let targetType: GarminTargetType = {
    workoutTargetTypeId: 1,
    workoutTargetTypeKey: 'no.target',
  };
  let targetValueOne: number | null = null;
  let targetValueTwo: number | null = null;
  let zoneNumber: number | null = null;

  if (step.targetWatts && step.targetWatts > 0) {
    targetType = {
      workoutTargetTypeId: 2,
      workoutTargetTypeKey: 'power.zone',
    };
    targetValueOne = Math.max(20, Math.round(step.targetWatts * 0.93));
    targetValueTwo = Math.round(step.targetWatts * 1.07);
  } else if (step.targetPace) {
    const speedRange = paceRangeToMetersPerSecond(step.targetPace);
    if (speedRange) {
      targetType = {
        workoutTargetTypeId: 6,
        workoutTargetTypeKey: 'pace.zone',
      };
      targetValueOne = speedRange.minSpeedMps;
      targetValueTwo = speedRange.maxSpeedMps;
    }
  } else if (
    step.targetHeartRateZone &&
    step.targetHeartRateZone >= 1 &&
    step.targetHeartRateZone <= 5
  ) {
    targetType = {
      workoutTargetTypeId: 4,
      workoutTargetTypeKey: 'heart.rate.zone',
    };
    zoneNumber = Math.round(step.targetHeartRateZone);
  } else if (step.targetCadence && step.targetCadence > 0) {
    targetType = {
      workoutTargetTypeId: 3,
      workoutTargetTypeKey: 'cadence',
    };
    targetValueOne = Math.max(40, Math.round(step.targetCadence - 5));
    targetValueTwo = Math.round(step.targetCadence + 5);
  }

  return {
    type: 'ExecutableStepDTO',
    stepId: null,
    stepOrder: index + 1,
    stepType,
    endCondition,
    endConditionValue,
    targetType,
    targetValueOne,
    targetValueTwo,
    zoneNumber,
    description: step.notes || null,
  };
}

/**
 * Converts a domain WorkoutData into a Garmin Connect compatible GarminWorkoutPayload
 * ready for upload to /workout-service/workout.
 */
export function mapWorkoutToGarminPayload(workout: WorkoutData): GarminWorkoutPayload {
  const steps = Array.isArray(workout.steps) ? workout.steps : [];

  if (workout.type === WorkoutType.HYBRID) {
    const isBikeStep = (step: WorkoutStep) =>
      Boolean((step.targetWatts && step.targetWatts > 0) || (step.targetCadence && !step.targetPace));

    const runSteps = steps.filter((s) => !isBikeStep(s));
    const bikeSteps = steps.filter((s) => isBikeStep(s));

    const runSportType: GarminSportType = { sportTypeId: 1, sportTypeKey: 'running' };
    const bikeSportType: GarminSportType = { sportTypeId: 2, sportTypeKey: 'cycling' };

    const workoutSegments: GarminWorkoutSegment[] = [
      {
        segmentOrder: 1,
        sportType: runSportType,
        workoutSteps:
          runSteps.length > 0
            ? runSteps.map((step, idx) => mapStepToGarminStepDto(step, idx))
            : [
                {
                  type: 'ExecutableStepDTO',
                  stepId: null,
                  stepOrder: 1,
                  stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
                  endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
                  endConditionValue: 1200,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
                  targetValueOne: null,
                  targetValueTwo: null,
                  zoneNumber: null,
                  description: 'Część 1: Bieg tlenowy Z2',
                },
              ],
      },
      {
        segmentOrder: 2,
        sportType: bikeSportType,
        workoutSteps:
          bikeSteps.length > 0
            ? bikeSteps.map((step, idx) => mapStepToGarminStepDto(step, idx))
            : [
                {
                  type: 'ExecutableStepDTO',
                  stepId: null,
                  stepOrder: 1,
                  stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
                  endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
                  endConditionValue: 1800,
                  targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
                  targetValueOne: null,
                  targetValueTwo: null,
                  zoneNumber: null,
                  description: 'Część 2: Rower tlenowy Z2',
                },
              ],
      },
    ];

    return {
      workoutName: workout.title.trim() || 'Garmin Brick Workout',
      description: workout.description || null,
      sportType: runSportType,
      workoutSegments,
    };
  }

  const sportType = resolveGarminSportType(workout.type);
  const executableSteps: GarminExecutableStepDto[] =
    steps.length > 0
      ? steps.map((step, idx) => mapStepToGarminStepDto(step, idx))
      : [
          {
            type: 'ExecutableStepDTO',
            stepId: null,
            stepOrder: 1,
            stepType: { stepTypeId: 3, stepTypeKey: 'interval' },
            endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
            endConditionValue: 1800,
            targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
            targetValueOne: null,
            targetValueTwo: null,
            zoneNumber: null,
            description: workout.description || 'Trening główny',
          },
        ];

  return {
    workoutName: workout.title.trim() || 'Garmin AI Workout',
    description: workout.description || null,
    sportType,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType,
        workoutSteps: executableSteps,
      },
    ],
  };
}

/**
 * Estimates duration in seconds for a running step that only specifies distanceMeters.
 */
function estimateRunStepSeconds(step: WorkoutStep, easySecondsPerKm: number): number {
  if (step.durationSeconds && step.durationSeconds > 0) {
    return step.durationSeconds;
  }
  if (step.distanceMeters && step.distanceMeters > 0) {
    const paceSec = step.targetPace ? parsePace(step.targetPace) || easySecondsPerKm : easySecondsPerKm;
    return Math.round((step.distanceMeters / 1000) * paceSec);
  }
  return 600; // Default 10 minutes
}

/**
 * On-Demand Modality Converter: Converts a scheduled Running workout into a physiologically
 * equivalent Cycling workout (or vice versa) using VDOT and rider weight.
 *
 * - RUN -> BIKE: Scales duration by ~1.33x, translates pace zones into target Watts and cadence (RPM).
 * - BIKE -> RUN: Scales duration by ~0.75x, translates power steps into VDOT target paces.
 */
export function convertWorkoutModality(
  workout: WorkoutData,
  targetType: WorkoutType.BIKE | WorkoutType.RUN | WorkoutType.HYBRID,
  vdot: number = 45,
  riderWeightKg: number = 72
): WorkoutData {
  if (workout.type === targetType) {
    return { ...workout };
  }

  const paces = calculateVdotPaces(vdot);
  const wattZones = convertRunToBikeWatts(vdot, riderWeightKg);

  // -------------------------------------------------------------------------
  // TARGET: HYBRID (Brick Workout: Run + Bike)
  // -------------------------------------------------------------------------
  if (targetType === WorkoutType.HYBRID) {
    // 1. Running segment: Warmup + Active @ VDOT Easy pace
    const runSteps: WorkoutStep[] = [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 600,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
        notes: 'Część 1: Rozgrzewka biegowa w tempie konwersacyjnym',
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        durationSeconds: 1200,
        targetPace: paces.easyPaceRange.min,
        targetHeartRateZone: 2,
        notes: `Część 1: Bieg tlenowy Z2 (${paces.easyPace})`,
      },
    ];

    // 2. Cycling segment: Active @ Matrix Z2 watts + Cooldown
    const bikeSteps: WorkoutStep[] = [
      {
        stepNumber: 3,
        type: StepType.ACTIVE,
        durationSeconds: 1800,
        targetWatts: wattZones.easy.target,
        targetCadence: 90,
        targetHeartRateZone: 2,
        notes: `Część 2 (Rower Matrix): Stała moc tlenowa ${wattZones.easy.target}W (90 RPM)`,
      },
      {
        stepNumber: 4,
        type: StepType.COOLDOWN,
        durationSeconds: 300,
        targetWatts: wattZones.recovery.target,
        targetCadence: 80,
        targetHeartRateZone: 1,
        notes: 'Część 2 (Rower): Spokojne schłodzenie i obniżenie tętna',
      },
    ];

    const cleanTitle = workout.title
      .replace(/^\[Hybryda Bieg\+Rower\]\s*/i, '')
      .replace(/^\[Rower\]\s*/i, '')
      .replace(/^\[Adaptacja AI\]\s*/i, '')
      .replace(/^Bieg:\s*/i, '');

    return {
      ...workout,
      type: WorkoutType.HYBRID,
      title: `[Hybryda Bieg+Rower] ${cleanTitle}`,
      description: `Trening łączony (Brick): 30 min biegu Z2 @ ${paces.easyPace} + 35 min roweru Matrix @ ${wattZones.easy.target}W.`,
      steps: [...runSteps, ...bikeSteps],
      status: WorkoutStatus.MODIFIED,
    };
  }

  // -------------------------------------------------------------------------
  // TARGET: BIKE (from RUN or HYBRID)
  // -------------------------------------------------------------------------
  if (targetType === WorkoutType.BIKE) {
    const convertedSteps: WorkoutStep[] = workout.steps.map((step, idx) => {
      // If step already has targetWatts (e.g. from HYBRID bike steps), preserve duration & targets
      if (step.targetWatts && step.targetWatts > 0) {
        return {
          ...step,
          stepNumber: idx + 1,
          notes: step.notes || `Ekwiwalent kolarski: ${step.targetWatts}W`,
        };
      }

      const baseRunSec = estimateRunStepSeconds(step, paces.rawSecondsPerKm.easyMin);
      const bikeDurationMinutes = convertRunToBikeDuration(baseRunSec / 60);
      const bikeDurationSeconds = Math.max(60, Math.round(bikeDurationMinutes * 60));

      let targetWatts = wattZones.easy.target;
      let targetHrZone = step.targetHeartRateZone || 2;
      let targetCadence = 88;

      if (step.type === StepType.WARMUP || step.type === StepType.COOLDOWN) {
        targetWatts = wattZones.recovery.target;
        targetHrZone = 1;
        targetCadence = 85;
      } else if (step.type === StepType.RECOVERY) {
        targetWatts = wattZones.recovery.target;
        targetHrZone = 1;
        targetCadence = 80;
      } else if (step.type === StepType.ACTIVE || step.type === StepType.REPEAT) {
        const stepPaceSec = step.targetPace ? parsePace(step.targetPace) : 0;
        if (stepPaceSec > 0 && stepPaceSec <= paces.rawSecondsPerKm.interval + 5) {
          targetWatts = wattZones.interval.target;
          targetHrZone = 5;
          targetCadence = 95;
        } else if (stepPaceSec > 0 && stepPaceSec <= paces.rawSecondsPerKm.threshold + 10) {
          targetWatts = wattZones.threshold.target;
          targetHrZone = 4;
          targetCadence = 92;
        } else if (stepPaceSec > 0 && stepPaceSec <= paces.rawSecondsPerKm.marathon + 10) {
          targetWatts = wattZones.tempo.target;
          targetHrZone = 3;
          targetCadence = 90;
        } else {
          targetWatts = wattZones.easy.target;
          targetHrZone = 2;
          targetCadence = 88;
        }
      }

      return {
        stepNumber: idx + 1,
        type: step.type,
        durationSeconds: bikeDurationSeconds,
        targetWatts,
        targetHeartRateZone: targetHrZone,
        targetCadence,
        notes: step.notes
          ? `${step.notes} (Ekwiwalent kolarski: ${targetWatts}W)`
          : `Ekwiwalent kolarski: utrzymuj ~${targetWatts}W (${targetCadence} RPM)`,
      };
    });

    const baseTitle = workout.title
      .replace(/^\[Hybryda Bieg\+Rower\]\s*/i, '')
      .replace(/^\[Rower\]\s*/i, '')
      .replace(/^\[Adaptacja AI\]\s*/i, '')
      .replace(/^Bieg:\s*/i, '');

    return {
      ...workout,
      type: WorkoutType.BIKE,
      title: `[Rower] ${baseTitle}`,
      description: workout.description
        ? `${workout.description} | Przeliczono na rower (VDOT ${paces.vdot}, FTP ~${wattZones.ftp}W).`
        : `Ekwiwalent kolarski dla VDOT ${paces.vdot} (szacowane FTP: ${wattZones.ftp}W).`,
      steps: convertedSteps,
      status: workout.status === WorkoutStatus.PLANNED ? WorkoutStatus.MODIFIED : workout.status,
    };
  }

  // -------------------------------------------------------------------------
  // TARGET: RUN (from BIKE or HYBRID)
  // -------------------------------------------------------------------------
  const convertedRunSteps: WorkoutStep[] = workout.steps.map((step, idx) => {
    // If step was already a running step (has targetPace and no targetWatts), preserve it
    if (step.targetPace && (!step.targetWatts || step.targetWatts === 0)) {
      return {
        ...step,
        stepNumber: idx + 1,
        notes: step.notes || `Ekwiwalent biegowy: tempo ${step.targetPace}`,
      };
    }

    const bikeSec = step.durationSeconds && step.durationSeconds > 0 ? step.durationSeconds : 1200;
    const runDurationSeconds = Math.max(60, Math.round(bikeSec / 1.33));

    let targetPace = paces.easyPace;
    let targetHrZone = step.targetHeartRateZone || 2;

    if (step.type === StepType.WARMUP || step.type === StepType.COOLDOWN || step.type === StepType.RECOVERY) {
      targetPace = paces.easyPaceRange.max;
      targetHrZone = 1;
    } else if (step.targetWatts && step.targetWatts >= wattZones.interval.min) {
      targetPace = paces.intervalPace;
      targetHrZone = 5;
    } else if (step.targetWatts && step.targetWatts >= wattZones.threshold.min) {
      targetPace = paces.thresholdPace;
      targetHrZone = 4;
    } else if (step.targetWatts && step.targetWatts >= wattZones.tempo.min) {
      targetPace = paces.marathonPace;
      targetHrZone = 3;
    }

    return {
      stepNumber: idx + 1,
      type: step.type,
      durationSeconds: runDurationSeconds,
      targetPace,
      targetHeartRateZone: targetHrZone,
      targetCadence: 176,
      notes: `Ekwiwalent biegowy: tempo ${targetPace}`,
    };
  });

  const baseRunTitle = workout.title
    .replace(/^\[Hybryda Bieg\+Rower\]\s*/i, '')
    .replace(/^\[Rower\]\s*/i, '')
    .replace(/^\[Adaptacja AI\]\s*/i, '');

  return {
    ...workout,
    type: WorkoutType.RUN,
    title: baseRunTitle,
    description: workout.description
      ? workout.description.replace(/\s*\|\s*Przeliczono.*$/, '')
      : `Trening biegowy (VDOT ${paces.vdot})`,
    steps: convertedRunSteps,
    status: workout.status === WorkoutStatus.PLANNED ? WorkoutStatus.MODIFIED : workout.status,
  };
}
