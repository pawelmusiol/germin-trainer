// =============================================================================
// Jack Daniels VDOT Physiology Engine & Ergometer Conversions
// =============================================================================

export interface VdotPaces {
  vdot: number;
  easyPace: string;
  easyPaceRange: {
    min: string;
    max: string;
  };
  marathonPace: string;
  thresholdPace: string;
  intervalPace: string;
  repetitionPace: string;
  rawSecondsPerKm: {
    easyMin: number;
    easyMax: number;
    marathon: number;
    threshold: number;
    interval: number;
    repetition: number;
  };
}

export interface CyclingZoneWatts {
  target: number;
  min: number;
  max: number;
}

export interface CyclingWattZones {
  ftp: number;
  recovery: CyclingZoneWatts;
  easy: CyclingZoneWatts;
  tempo: CyclingZoneWatts;
  threshold: CyclingZoneWatts;
  interval: CyclingZoneWatts;
}

/**
 * Formats a pace in seconds per kilometer into "M:SS /km" format.
 */
export function formatPace(secondsPerKm: number): string {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return '0:00 /km';
  }
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60);
  if (seconds === 60) {
    return `${minutes + 1}:00 /km`;
  }
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds} /km`;
}

/**
 * Parses a pace string formatted as "M:SS /km" or "M:SS" into total seconds per kilometer.
 */
export function parsePace(paceStr: string): number {
  if (!paceStr || typeof paceStr !== 'string') {
    return 0;
  }
  const cleaned = paceStr.replace('/km', '').trim();
  const parts = cleaned.split(':');
  if (parts.length !== 2) {
    return 0;
  }
  const minutes = parseInt(parts[0], 10);
  const seconds = parseFloat(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes < 0 || seconds < 0 || seconds >= 60) {
    return 0;
  }
  return minutes * 60 + seconds;
}

/**
 * Calculates Oxygen Cost (VO2 in ml/kg/min) for a given running velocity (meters/minute)
 * using the Daniels & Gilbert (1979) empirical equation.
 */
export function calculateOxygenCost(velocityMetersPerMin: number): number {
  if (!Number.isFinite(velocityMetersPerMin) || velocityMetersPerMin <= 0) {
    return 0;
  }
  return -4.60 + 0.182258 * velocityMetersPerMin + 0.000104 * Math.pow(velocityMetersPerMin, 2);
}

/**
 * Calculates the sustainable fraction of VO2max for a race duration in minutes
 * using the Daniels & Gilbert drop-dead equation.
 */
export function calculateFractionOfVo2Max(durationMinutes: number): number {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return 1.0;
  }
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * durationMinutes) +
    0.2989558 * Math.exp(-0.1932605 * durationMinutes)
  );
}

/**
 * Calculates exact Jack Daniels VDOT from a race performance.
 *
 * @param distanceMeters Race distance in meters (e.g. 5000 for 5K, 10000 for 10K)
 * @param timeSeconds Finish time in seconds (e.g. 1200 for 20:00)
 * @returns Calculated VDOT rounded to 1 decimal place (clamped between 30 and 85)
 */
export function calculateVdotFromRace(distanceMeters: number, timeSeconds: number): number {
  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(timeSeconds) ||
    distanceMeters <= 0 ||
    timeSeconds <= 0
  ) {
    return 30.0;
  }
  const durationMinutes = timeSeconds / 60;
  const velocityMetersPerMin = distanceMeters / durationMinutes;

  const vo2 = calculateOxygenCost(velocityMetersPerMin);
  const fraction = calculateFractionOfVo2Max(durationMinutes);

  const rawVdot = fraction > 0 ? vo2 / fraction : 30.0;
  const clamped = !Number.isFinite(rawVdot)
    ? 30.0
    : Math.max(30.0, Math.min(85.0, rawVdot));
  return Math.round(clamped * 10) / 10;
}

/**
 * Computes the estimated race finish time in seconds for a given distance and VDOT.
 * Inverts the Daniels & Gilbert (1979) empirical formula via monotonic binary search.
 *
 * @param distanceMeters Race distance in meters (e.g. 5000, 10000, 21097.5, 42195)
 * @param vdot Athlete's VDOT value (clamped between 30.0 and 85.0)
 * @returns Predicted finish time in seconds (integer), or 0 if distanceMeters <= 0 or input invalid
 */
export function calculateRaceTimeFromVdot(distanceMeters: number, vdot: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return 0;
  }

  // Safe clamping: handles NaN by falling back to baseline 30.0, while clamping infinite/out-of-range VDOTs
  const safeVdot =
    !Number.isFinite(vdot) && vdot > 85
      ? 85.0
      : !Number.isFinite(vdot) || vdot < 30.0
      ? 30.0
      : Math.min(85.0, vdot);

  let low = 20; // 20 seconds min floor (supports middle distances 200m-800m down to ~104s for 800m @ VDOT 85)
  let high = 86400; // 24 hours max
  let iterations = 0;

  // Binary search: (86400 - 20) / 2^23 ≈ 0.0103s precision (< 0.05s)
  while (high - low > 0.02 && iterations < 30) {
    iterations++;
    const mid = (low + high) / 2;
    const durationMinutes = mid / 60;
    const velocityMetersPerMin = distanceMeters / durationMinutes;

    const vo2 = calculateOxygenCost(velocityMetersPerMin);
    const fraction = calculateFractionOfVo2Max(durationMinutes);
    const midVdot = fraction > 0 ? vo2 / fraction : 30.0;

    if (midVdot > safeVdot) {
      // Faster pace than target VDOT -> athlete needs more time
      low = mid;
    } else {
      // Slower pace than target VDOT -> athlete needs less time
      high = mid;
    }
  }

  return Math.round((low + high) / 2);
}

/**
 * Inverts the Daniels oxygen equation to compute velocity (m/min) for a given VO2 cost.
 * Solves: 0.000104 * v^2 + 0.182258 * v - (4.60 + vo2) = 0
 */
function velocityFromVo2(vo2: number): number {
  if (!Number.isFinite(vo2) || vo2 <= 0) {
    return 0;
  }
  const a = 0.000104;
  const b = 0.182258;
  const c = -(4.60 + vo2);

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return 0;
  }
  return (-b + Math.sqrt(discriminant)) / (2 * a);
}

/**
 * Converts running velocity in meters per minute to seconds per kilometer.
 */
function velocityToSecondsPerKm(velocityMetersPerMin: number): number {
  if (!Number.isFinite(velocityMetersPerMin) || velocityMetersPerMin <= 0) {
    return 0;
  }
  return (1000 / velocityMetersPerMin) * 60;
}

/**
 * Generates training paces for all Jack Daniels training zones based on VDOT:
 * - Easy (E): 65% - 74% VO2max
 * - Marathon (M): 80% VO2max
 * - Threshold (T): 88% VO2max
 * - Interval (I): 98% VO2max
 * - Repetition (R): 108% VO2max
 *
 * @param vdot Athlete's VDOT value (clamped between 30 and 85)
 */
export function calculateVdotPaces(vdot: number): VdotPaces {
  const safeVdot =
    !Number.isFinite(vdot) && vdot > 85
      ? 85.0
      : !Number.isFinite(vdot) || vdot < 30.0
      ? 30.0
      : Math.min(85.0, vdot);

  const easyMinSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 0.74));
  const easyMaxSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 0.65));
  const marathonSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 0.80));
  const thresholdSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 0.88));
  const intervalSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 0.98));
  const repetitionSec = velocityToSecondsPerKm(velocityFromVo2(safeVdot * 1.08));

  return {
    vdot: safeVdot,
    easyPace: `${formatPace(easyMinSec)} - ${formatPace(easyMaxSec)}`,
    easyPaceRange: {
      min: formatPace(easyMinSec),
      max: formatPace(easyMaxSec),
    },
    marathonPace: formatPace(marathonSec),
    thresholdPace: formatPace(thresholdSec),
    intervalPace: formatPace(intervalSec),
    repetitionPace: formatPace(repetitionSec),
    rawSecondsPerKm: {
      easyMin: Math.round(easyMinSec),
      easyMax: Math.round(easyMaxSec),
      marathon: Math.round(marathonSec),
      threshold: Math.round(thresholdSec),
      interval: Math.round(intervalSec),
      repetition: Math.round(repetitionSec),
    },
  };
}

/**
 * Converts a scheduled run duration to an aerobically equivalent indoor cycling duration.
 * Cycling is non-weight-bearing with lower muscular breakdown, requiring ~1.33x duration
 * to produce equivalent cardiovascular stimulation.
 *
 * @param runMinutes Running duration in minutes (e.g. 45 min)
 * @returns Equivalent cycling duration in minutes (e.g. 60 min)
 */
export function convertRunToBikeDuration(runMinutes: number): number {
  if (!Number.isFinite(runMinutes) || runMinutes <= 0) {
    return 0;
  }
  return Math.round(runMinutes * 1.33);
}

/**
 * Calculates cycling power zones (in Watts) for indoor Matrix FTMS equipment
 * based on the runner's VDOT and body weight (kg).
 *
 * Uses physiological correlation between running VO2max and cycling Functional Threshold Power (FTP).
 *
 * @param vdot Athlete's current VDOT (e.g. 45)
 * @param riderWeightKg Athlete's body weight in kg (e.g. 70)
 */
export function convertRunToBikeWatts(vdot: number, riderWeightKg: number): CyclingWattZones {
  const safeVdot =
    !Number.isFinite(vdot) && vdot > 85
      ? 85.0
      : !Number.isFinite(vdot) || vdot < 30.0
      ? 30.0
      : Math.min(85.0, vdot);
  const safeWeight =
    !Number.isFinite(riderWeightKg) || riderWeightKg < 40.0
      ? 70.0
      : Math.min(130.0, riderWeightKg);

  // Estimated Functional Threshold Power (Watts)
  const ftp = Math.round(safeVdot * safeWeight * 0.075);

  return {
    ftp,
    recovery: {
      target: Math.round(ftp * 0.50),
      min: Math.round(ftp * 0.40),
      max: Math.round(ftp * 0.55),
    },
    easy: {
      target: Math.round(ftp * 0.65),
      min: Math.round(ftp * 0.56),
      max: Math.round(ftp * 0.75),
    },
    tempo: {
      target: Math.round(ftp * 0.83),
      min: Math.round(ftp * 0.76),
      max: Math.round(ftp * 0.90),
    },
    threshold: {
      target: Math.round(ftp * 0.98),
      min: Math.round(ftp * 0.91),
      max: Math.round(ftp * 1.05),
    },
    interval: {
      target: Math.round(ftp * 1.15),
      min: Math.round(ftp * 1.06),
      max: Math.round(ftp * 1.20),
    },
  };
}

export interface VdotProgressionSummary {
  currentVdot: number;
  targetVdot: number;
  activeTrainingVdot: number;
  weekNumber: number;
  totalWeeks: number;
  progressPercent: number;
  currentPaces: VdotPaces;
  targetPaces: VdotPaces;
}

/**
 * Calculates progressive VDOT between the athlete's CURRENT fitness (currentVdot)
 * and their GOAL fitness (targetVdot).
 *
 * In Week 1-2, training paces are 100% anchored to currentVdot so aerobic base runs (Zone 2)
 * match current physiology rather than forcing unattainable goal paces prematurely.
 */
export function calculateProgressiveVdot(
  currentVdot: number,
  targetVdot: number,
  weekNumber: number = 1,
  totalWeeks: number = 12
): VdotProgressionSummary {
  const safeCurrent =
    !Number.isFinite(currentVdot) && currentVdot > 85
      ? 85.0
      : !Number.isFinite(currentVdot) || currentVdot < 30.0
      ? 30.0
      : Math.min(85.0, currentVdot);
  const safeTarget =
    !Number.isFinite(targetVdot) || targetVdot < safeCurrent
      ? safeCurrent
      : Math.min(85.0, targetVdot);
  const safeTotalWeeks =
    !Number.isFinite(totalWeeks) || totalWeeks < 1 ? 12 : Math.max(1, totalWeeks);
  const clampedWeek =
    !Number.isFinite(weekNumber) || weekNumber < 1
      ? 1
      : Math.max(1, Math.min(safeTotalWeeks, weekNumber));

  // Start at 0% progression in Week 1, stepping up every 2-3 weeks
  const rawFraction =
    clampedWeek <= 1 ? 0 : Math.min(1, (clampedWeek - 1) / safeTotalWeeks);

  // Physiological adaptation cap: max ~0.4 VDOT gain per week
  const maxSafeGain = (clampedWeek - 1) * 0.4;
  const desiredGain = (safeTarget - safeCurrent) * rawFraction;
  const actualGain = Math.min(desiredGain, maxSafeGain);

  const activeTrainingVdot = Math.round((safeCurrent + actualGain) * 10) / 10;

  return {
    currentVdot: safeCurrent,
    targetVdot: safeTarget,
    activeTrainingVdot,
    weekNumber: clampedWeek,
    totalWeeks: safeTotalWeeks,
    progressPercent: Math.round(rawFraction * 100),
    currentPaces: calculateVdotPaces(activeTrainingVdot),
    targetPaces: calculateVdotPaces(safeTarget),
  };
}

/**
 * Estimates the athlete's current VDOT from recent completed Garmin running activities.
 * Adjusts for submaximal effort using average heart rate (e.g., an easy run at 142 bpm
 * represents ~72% of VO2max velocity rather than a 100% race effort).
 */
export function estimateCurrentVdotFromGarminRuns(
  activities: Array<{
    activityType?: string;
    distanceMeters: number;
    durationSeconds: number;
    averageHeartRate?: number | null;
    maxHeartRate?: number | null;
  }>
): {
  estimatedVdot: number;
  estimated10kSeconds: number;
  sampleCount: number;
} | null {
  if (!activities || !Array.isArray(activities)) {
    return null;
  }

  const runs = activities.filter(
    (a) =>
      a &&
      (!a.activityType || a.activityType === 'RUN' || a.activityType === 'TREADMILL') &&
      Number.isFinite(a.distanceMeters) &&
      a.distanceMeters >= 2000 &&
      Number.isFinite(a.durationSeconds) &&
      a.durationSeconds >= 600
  );

  if (runs.length === 0) {
    return null;
  }

  const vdotEstimates: number[] = [];

  for (const run of runs) {
    const hasHeartRate =
      Number.isFinite(run.averageHeartRate) && (run.averageHeartRate as number) > 0;

    let estimatedVdot: number;

    if (hasHeartRate) {
      const durationMin = run.durationSeconds / 60;
      const velocityMetersPerMin = run.distanceMeters / durationMin;
      const vo2AtPace = calculateOxygenCost(velocityMetersPerMin);

      // Estimate %VO2max from heart rate (assuming typical HRmax ~190 bpm)
      const avgHr = run.averageHeartRate as number;
      const maxHr =
        Number.isFinite(run.maxHeartRate) && (run.maxHeartRate as number) > 0
          ? (run.maxHeartRate as number)
          : 175;
      const estMaxHr = Math.max(185, maxHr + 12);
      const hrRatio = Math.max(0.65, Math.min(0.98, avgHr / estMaxHr));

      // Convert %HRmax to %VO2max (Swain formula: %VO2max ~= 1.28 * %HRmax - 0.29)
      const estimatedFractionVo2Max = Math.max(
        0.62,
        Math.min(0.95, 1.28 * hrRatio - 0.29)
      );

      estimatedVdot = vo2AtPace / estimatedFractionVo2Max;
    } else {
      // In the absence of heart rate telemetry, evaluate VDOT directly from race/effort performance
      // rather than assuming an arbitrary submaximal heart rate that artificially inflates fitness estimates.
      estimatedVdot = calculateVdotFromRace(run.distanceMeters, run.durationSeconds);
    }

    if (Number.isFinite(estimatedVdot) && estimatedVdot > 0) {
      vdotEstimates.push(Math.max(30.0, Math.min(75.0, estimatedVdot)));
    }
  }

  if (vdotEstimates.length === 0) {
    return null;
  }

  const avgVdot =
    Math.round(
      (vdotEstimates.reduce((sum, v) => sum + v, 0) / vdotEstimates.length) * 10
    ) / 10;

  const estimated10kSeconds = calculateRaceTimeFromVdot(10000, avgVdot);

  return {
    estimatedVdot: avgVdot,
    estimated10kSeconds,
    sampleCount: runs.length,
  };
}
