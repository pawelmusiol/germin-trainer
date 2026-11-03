import {
  BiomechanicalFlaw,
  CorrectiveExercise,
  FlawSeverity,
  GarminDailySummary,
  StepType,
  WorkoutData,
  WorkoutStep,
  WorkoutType,
} from './types';
import { calculateVdotPaces } from './vdot';

export interface ReadinessEvaluation {
  readinessScore: number; // 0 - 100
  status: 'OPTIMAL' | 'MODERATE_FATIGUE' | 'HIGH_FATIGUE_RECOVERY_NEEDED';
  allowHighIntensity: boolean;
  volumeMultiplier: number; // e.g. 1.0 (100%), 0.8 (80%), 0.6 (60%)
  recommendBikeSwap: boolean;
  reasons: string[];
}

export interface ReadinessInput {
  garmin?: Partial<GarminDailySummary> | null;
  perceivedFatigue?: number | null; // 1 (fresh) to 5 (exhausted from physical work)
  note?: string | null;
}

/**
 * Enforces the 10% weekly volume progression guardrail (sports science injury prevention rule).
 *
 * @param previousWeekDistanceMeters Total distance run in the previous 7 days (meters)
 * @param baselineMinimumMeters Minimum floor for beginners (default 15,000m = 15km)
 * @returns Maximum safe weekly distance in meters
 */
export function calculateSafeWeeklyVolumeLimit(
  previousWeekDistanceMeters: number,
  baselineMinimumMeters: number = 15000
): number {
  if (previousWeekDistanceMeters <= 0) {
    return baselineMinimumMeters;
  }
  return Math.round(Math.max(baselineMinimumMeters, previousWeekDistanceMeters * 1.1));
}

/**
 * Deterministic physiological guardrail engine evaluating morning recovery
 * (HRV, Sleep Score, Body Battery) + previous day physical work load (Steps, Stress, Perceived Fatigue 1-5).
 */
export function evaluateMorningReadiness(input: ReadinessInput): ReadinessEvaluation {
  let score = 85;
  let allowHighIntensity = true;
  let volumeMultiplier = 1.0;
  let recommendBikeSwap = false;
  const reasons: string[] = [];

  const g = input.garmin || {};

  // 1. Evaluate HRV status
  if (g.hrvStatus === 'LOW' || g.hrvStatus === 'POOR') {
    score -= 30;
    allowHighIntensity = false;
    volumeMultiplier = Math.min(volumeMultiplier, 0.7);
    reasons.push('Status HRV poniżej normy bazowej (układ nerwowy wymaga regeneracji)');
  } else if (g.hrvStatus === 'UNBALANCED') {
    score -= 15;
    allowHighIntensity = false;
    volumeMultiplier = Math.min(volumeMultiplier, 0.85);
    reasons.push('Niezbalansowane HRV z ostatniej nocy');
  } else if (typeof g.hrv === 'number' && typeof g.hrvBaselineLow === 'number' && g.hrv < g.hrvBaselineLow) {
    score -= 20;
    allowHighIntensity = false;
    volumeMultiplier = Math.min(volumeMultiplier, 0.8);
    reasons.push(`Obniżone HRV (${g.hrv} ms względem progu ${g.hrvBaselineLow} ms)`);
  }

  // 2. Evaluate Sleep Score
  if (typeof g.sleepScore === 'number') {
    if (g.sleepScore < 55) {
      score -= 25;
      allowHighIntensity = false;
      volumeMultiplier = Math.min(volumeMultiplier, 0.7);
      reasons.push(`Słaba regeneracja senna (Sleep Score: ${g.sleepScore}/100)`);
    } else if (g.sleepScore < 70) {
      score -= 10;
      volumeMultiplier = Math.min(volumeMultiplier, 0.9);
      reasons.push(`Umiarkowana jakość snu (Sleep Score: ${g.sleepScore}/100)`);
    }
  }

  // 3. Evaluate Body Battery
  if (typeof g.bodyBattery === 'number' && g.bodyBattery < 45) {
    score -= 20;
    allowHighIntensity = false;
    recommendBikeSwap = true;
    volumeMultiplier = Math.min(volumeMultiplier, 0.75);
    reasons.push(`Niski poziom Body Battery o poranku (${g.bodyBattery}/100)`);
  }

  // 4. Evaluate Previous Day Physical Work & Non-Workout Steps
  if (typeof g.steps === 'number' && g.steps >= 15000) {
    score -= 15;
    recommendBikeSwap = true;
    volumeMultiplier = Math.min(volumeMultiplier, 0.8);
    reasons.push(
      `Wysokie obciążenie pracą fizyczną / krokami z poprzedniego dnia (${g.steps} kroków) – zalecane odciążenie stawów`
    );
  }

  // 5. Evaluate Subjective Physical Work Slider (1-5) with Graduated Physiology (R4)
  if (typeof input.perceivedFatigue === 'number') {
    if (input.perceivedFatigue >= 5) {
      score -= 35;
      allowHighIntensity = false;
      recommendBikeSwap = true;
      volumeMultiplier = Math.min(volumeMultiplier, 0.6);
      reasons.push('Zgłoszono skrajne zmęczenie fizyczne (5/5) – blokada ciężkich akcentów biegowych');
    } else if (input.perceivedFatigue === 4) {
      score -= 20;
      allowHighIntensity = false;
      recommendBikeSwap = true;
      volumeMultiplier = Math.min(volumeMultiplier, 0.75);
      reasons.push('Zgłoszono wysokie zmęczenie pracą fizyczną (4/5) – redukcja intensywności i zalecany rower');
    } else if (input.perceivedFatigue === 3) {
      score -= 10;
      volumeMultiplier = Math.min(volumeMultiplier, 0.9);
      reasons.push('Zgłoszono umiarkowane zmęczenie pracą fizyczną (3/5) – lekka redukcja objętości');
    } else if (input.perceivedFatigue === 1) {
      score += 5;
      reasons.push('Zgłoszono pełną świeżość fizyczną (1/5) – optymalna dyspozycja mięśniowa');
    }
    // Level 2 represents baseline normal load (0 score adjustment, allowHighIntensity: true, recommendBikeSwap: false)
  }

  const clampedScore = Math.max(10, Math.min(100, score));
  let status: ReadinessEvaluation['status'] = 'OPTIMAL';
  if (clampedScore < 55 || !allowHighIntensity) {
    status = clampedScore < 45 ? 'HIGH_FATIGUE_RECOVERY_NEEDED' : 'MODERATE_FATIGUE';
  }

  if (reasons.length === 0) {
    reasons.push('Wszystkie parametry HRV, snu i Body Battery w normie – pełna gotowość do akcentu.');
  }

  return {
    readinessScore: clampedScore,
    status,
    allowHighIntensity,
    volumeMultiplier: Number(volumeMultiplier.toFixed(2)),
    recommendBikeSwap,
    reasons,
  };
}

/**
 * Injects prescribed corrective biomechanical exercises into a running workout's warmup step
 * so that gait flaws detected from video analysis are actively corrected in training.
 */
export function injectCorrectiveExercisesIntoWorkout(
  workout: WorkoutData,
  exercises: CorrectiveExercise[]
): WorkoutData {
  if (!exercises || exercises.length === 0 || workout.type === WorkoutType.BIKE) {
    return { ...workout };
  }

  const drillSummary = exercises
    .map((ex) => `${ex.name} (${ex.suggestedRepsOrDuration})`)
    .join(', ');

  const steps: WorkoutStep[] = workout.steps.map((step) => ({ ...step }));
  const warmupIdx = steps.findIndex((s) => s.type === StepType.WARMUP);

  if (warmupIdx >= 0) {
    const existingNotes = steps[warmupIdx].notes ? `${steps[warmupIdx].notes} | ` : '';
    steps[warmupIdx] = {
      ...steps[warmupIdx],
      durationSeconds: (steps[warmupIdx].durationSeconds || 600) + 300, // +5 min for technique drills
      notes: `${existingNotes}Ćwiczenia techniczne: ${drillSummary}`,
    };
  } else {
    steps.unshift({
      stepNumber: 1,
      type: StepType.WARMUP,
      durationSeconds: 600,
      targetHeartRateZone: 1,
      notes: `Rozgrzewka + ćwiczenia korygujące technikę: ${drillSummary}`,
    });
    steps.forEach((s, i) => {
      s.stepNumber = i + 1;
    });
  }

  return {
    ...workout,
    description: workout.description
      ? `${workout.description} [Wpleciono ćwiczenia techniki biegu: ${drillSummary}]`
      : `Trening z akcentem techniki biegu: ${drillSummary}`,
    steps,
  };
}

/**
 * Maps observed Running Dynamics (cadence, ground contact time, vertical oscillation)
 * and video cues into structured biomechanical flaws and corrective drills.
 */
export function analyzeBiomechanicalCues(params: {
  cadenceSpm?: number;
  groundContactTimeMs?: number;
  verticalOscillationCm?: number;
  userNotes?: string;
}): {
  flaws: BiomechanicalFlaw[];
  exercises: CorrectiveExercise[];
} {
  const flaws: BiomechanicalFlaw[] = [];
  const exercises: CorrectiveExercise[] = [];

  const cadence = params.cadenceSpm ?? 164;
  const gct = params.groundContactTimeMs ?? 265;
  const vertOsc = params.verticalOscillationCm ?? 9.8;
  const notesLower = (params.userNotes || '').toLowerCase();

  // 1. Overstriding / Low Cadence detection
  if (cadence < 170 || gct > 255 || notesLower.includes('pięt') || notesLower.includes('overstrid')) {
    flaws.push({
      flawType: 'OVERSTRIDING',
      description: `Lądowanie na pięcie przed środkiem ciężkości ciała (kadencja ${cadence} spm, czas kontaktu ${gct} ms). Powoduje wyhamowywanie przy każdym kroku i przeciążenie piszczeli/kolan.`,
      severity: cadence < 162 ? FlawSeverity.SEVERE : FlawSeverity.MODERATE,
      timestampSeconds: 2.5,
    });
    exercises.push(
      {
        name: 'Skipy A z wysokim rytmem (High-Cadence A-Skips)',
        description: 'Dynamiczne unoszenie kolana z aktywnym uderzeniem śródstopia dokładnie pod biodrem.',
        targetMuscleGroup: 'Zginacze biodra, łydka, koordynacja nerwowo-mięśniowa',
        suggestedRepsOrDuration: '3x 30 metrów w rozgrzewce',
      },
      {
        name: 'Bieg z metronomem +5% kadencji (176-180 spm)',
        description: 'Krótkie przebieżki skupione na szybkim odrywaniu stopy od podłoża (pawingback).',
        targetMuscleGroup: 'Układ nerwowy, mięsień płaszczkowaty',
        suggestedRepsOrDuration: '4x 100m przed częścią główną',
      }
    );
  }

  // 2. Pelvic drop / Hip instability detection
  if (vertOsc > 9.2 || notesLower.includes('biodr') || notesLower.includes('miednic') || notesLower.includes('kolan')) {
    flaws.push({
      flawType: 'PELVIC_DROP_HIP_INSTABILITY',
      description: `Nadmierna oscylacja pionowa (${vertOsc} cm) oraz opadanie miednicy w fazie pełnego podporu jednonóż (osłabienie mięśnia pośladkowego średniego).`,
      severity: FlawSeverity.MODERATE,
      timestampSeconds: 4.0,
    });
    exercises.push(
      {
        name: 'Monster Walk z taśmą mini-band nad kolanami',
        description: 'Chód boczny w półprzysiadzie aktywujący pośladek średni przed biegiem.',
        targetMuscleGroup: 'Mięsień pośladkowy średni (Gluteus Medius)',
        suggestedRepsOrDuration: '2x 15 kroków na stronę przed biegiem',
      },
      {
        name: 'Jaskółka dynamiczna / Single-Leg RDL',
        description: 'Stabilizacja miednicy w podporze jednonóż z kontrolą osi biodro-kolano-stopa.',
        targetMuscleGroup: 'Pośladki, grupa kulszowo-goleniowa, stabilizatory stawu skokowego',
        suggestedRepsOrDuration: '2x 10 powtórzeń na nogę',
      }
    );
  }

  // 3. Forward trunk collapse / waist bending
  if (notesLower.includes('plec') || notesLower.includes('sylwetk') || flaws.length === 0) {
    flaws.push({
      flawType: 'TRUNK_FLEXION_AT_WAIST',
      description:
        'Zgięcie sylwetki w pasie zamiast lekkiego pochylenia całego ciała z osi stawów skokowych, ograniczające wyprost w biodrze podczas odbicia.',
      severity: FlawSeverity.MILD,
      timestampSeconds: 6.0,
    });
    exercises.push({
      name: 'Podbiegi techniczne + Wall Lean Drills',
      description: 'Nauka opadania w przód z kostek przy zachowaniu stabilnego, wyprostowanego tułowia.',
      targetMuscleGroup: 'Core, pośladek wielki, mięśnie brzucha',
      suggestedRepsOrDuration: '4x 60m podbieg po rozbieganiu',
    });
  }

  return { flaws, exercises };
}

/**
 * Generates a structured 7-day microcycle of workouts tailored to VDOT, preference (RUN_ONLY vs HYBRID),
 * and any active corrective exercises.
 */
export function buildStructuredWeeklyMicrocycle(params: {
  startDateIso: string;
  vdot: number;
  preference: 'RUN_ONLY' | 'HYBRID_BIKE_RUN' | 'HYBRID';
  riderWeightKg?: number;
  correctiveExercises?: CorrectiveExercise[];
}): WorkoutData[] {
  const paces = calculateVdotPaces(params.vdot);
  const isHybrid = params.preference === 'HYBRID_BIKE_RUN' || params.preference === 'HYBRID';
  const startDate = new Date(`${params.startDateIso.slice(0, 10)}T07:00:00.000Z`);
  const exercises = params.correctiveExercises || [];

  const addDays = (days: number): string => {
    const d = new Date(startDate.getTime() + days * 24 * 3600 * 1000);
    return d.toISOString();
  };

  // Day 1: Easy Aerobic + Technique Drills
  let day1: WorkoutData = {
    date: addDays(0),
    type: WorkoutType.RUN,
    title: 'Bieg spokojny Z2 + Rytmy techniczne',
    description: `Budowanie bazy tlenowej w tempie konwersacyjnym (${paces.easyPace}).`,
    status: 'PLANNED' as any,
    steps: [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 600,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
        notes: 'Spokojne wprowadzenie',
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        durationSeconds: 1800,
        targetPace: paces.easyPaceRange.min,
        targetHeartRateZone: 2,
        notes: 'Bieg tlenowy w Strefie 2',
      },
      {
        stepNumber: 3,
        type: StepType.COOLDOWN,
        durationSeconds: 300,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
        notes: 'Trucht i rozciąganie',
      },
    ],
  };
  day1 = injectCorrectiveExercisesIntoWorkout(day1, exercises);

  // Day 2: Quality Interval Session (VO2max)
  let day2: WorkoutData = {
    date: addDays(2),
    type: WorkoutType.RUN,
    title: `Interwały VO2max 5x 1000m @ ${paces.intervalPace}`,
    description: 'Kluczowy akcent kształtujący pułap tlenowy i ekonomię biegu.',
    status: 'PLANNED' as any,
    steps: [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 900,
        targetPace: paces.easyPaceRange.min,
        targetHeartRateZone: 2,
        notes: 'Rozgrzewka + wymachy i skipy',
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        distanceMeters: 5000,
        targetPace: paces.intervalPace,
        targetHeartRateZone: 5,
        notes: `5x 1km w tempie ${paces.intervalPace} na przerwie 2 min trucht`,
      },
      {
        stepNumber: 3,
        type: StepType.COOLDOWN,
        durationSeconds: 600,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
        notes: 'Schłodzenie',
      },
    ],
  };
  day2 = injectCorrectiveExercisesIntoWorkout(day2, exercises);

  // Day 3: Hybrid Bike Base (if HYBRID) or Easy Recovery Run (if RUN_ONLY)
  const day3: WorkoutData = isHybrid
    ? {
        date: addDays(3),
        type: WorkoutType.BIKE,
        title: '[Matrix Rower] Baza tlenowa bez obciążania stawów (60 min)',
        description:
          'Sesja cross-trainingowa na rowerze stacjonarnym Matrix FTMS budująca kapilaryzację przy zerowym stresie mechanicznym.',
        status: 'PLANNED' as any,
        steps: [
          {
            stepNumber: 1,
            type: StepType.WARMUP,
            durationSeconds: 600,
            targetWatts: Math.round(params.vdot * 2.5),
            targetCadence: 85,
            targetHeartRateZone: 1,
            notes: 'Rozkręcenie na wysokiej kadencji',
          },
          {
            stepNumber: 2,
            type: StepType.ACTIVE,
            durationSeconds: 2400,
            targetWatts: Math.round(params.vdot * 3.5),
            targetCadence: 90,
            targetHeartRateZone: 2,
            notes: 'Stała moc tlenowa Z2',
          },
          {
            stepNumber: 3,
            type: StepType.COOLDOWN,
            durationSeconds: 600,
            targetWatts: Math.round(params.vdot * 2.2),
            targetCadence: 80,
            targetHeartRateZone: 1,
            notes: 'Schłodzenie',
          },
        ],
      }
    : {
        date: addDays(3),
        type: WorkoutType.RUN,
        title: 'Bieg regeneracyjny Z1/Z2 (35 min)',
        description: 'Krótki bieg kompensacyjny po akcencie interwałowym.',
        status: 'PLANNED' as any,
        steps: [
          {
            stepNumber: 1,
            type: StepType.ACTIVE,
            durationSeconds: 2100,
            targetPace: paces.easyPaceRange.max,
            targetHeartRateZone: 2,
            notes: 'Bardzo lekki trucht regeneracyjny',
          },
        ],
      };

  // Day 4: Threshold Run (T)
  const day4: WorkoutData = {
    date: addDays(5),
    type: WorkoutType.RUN,
    title: `Bieg progowy 3x 10 min @ ${paces.thresholdPace}`,
    description: 'Podnoszenie progu mleczanowego pod docelowe tempo startowe.',
    status: 'PLANNED' as any,
    steps: [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 900,
        targetPace: paces.easyPaceRange.min,
        targetHeartRateZone: 2,
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        durationSeconds: 1800,
        targetPace: paces.thresholdPace,
        targetHeartRateZone: 4,
        notes: `3x 10 min w tempie progowym ${paces.thresholdPace} (p. 2 min trucht)`,
      },
      {
        stepNumber: 3,
        type: StepType.COOLDOWN,
        durationSeconds: 600,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
      },
    ],
  };

  // Day 5: Weekend Long Run
  const day5: WorkoutData = {
    date: addDays(6),
    type: WorkoutType.RUN,
    title: 'Długie wybieganie tlenowe (75 min)',
    description: 'Kształtowanie wytrzymałości długiego czasu i gospodarki lipidowej.',
    status: 'PLANNED' as any,
    steps: [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 600,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        durationSeconds: 3600,
        targetPace: paces.easyPaceRange.min,
        targetHeartRateZone: 2,
      },
      {
        stepNumber: 3,
        type: StepType.COOLDOWN,
        durationSeconds: 300,
        targetPace: paces.easyPaceRange.max,
        targetHeartRateZone: 1,
      },
    ],
  };

  return [day1, day2, day3, day4, day5];
}
