import {
  WorkoutType,
  WorkoutStatus,
  StepType,
  WorkoutData,
  evaluateMorningReadiness,
  convertWorkoutModality,
  mapWorkoutToGarminPayload,
  ReadinessInput,
} from '@garmin-trainer/shared';

describe('Adversarial Stress Test: Milestone 2 (Requirements R4 & R6)', () => {
  const baselineGarmin = {
    hrv: 61,
    hrvBaselineLow: 52,
    hrvStatus: 'BALANCED' as const,
    sleepScore: 84,
    restingHeartRate: 49,
    bodyBattery: 82,
    steps: 11420,
  };

  const INITIAL_WORKOUT: WorkoutData = {
    id: 'wkt-today-01',
    date: '2026-11-02',
    type: WorkoutType.RUN,
    title: 'Interwały 5x 1km @ 4:12/km',
    description: 'Kluczowy akcent pod cel 10 km (VDOT 46)',
    status: WorkoutStatus.PLANNED,
    steps: [
      {
        stepNumber: 1,
        type: StepType.WARMUP,
        durationSeconds: 900,
        targetPace: '5:30 /km',
        targetHeartRateZone: 2,
        notes: 'Spokojny trucht rozgrzewkowy',
      },
      {
        stepNumber: 2,
        type: StepType.ACTIVE,
        durationSeconds: 1500,
        targetPace: '4:12 /km',
        targetHeartRateZone: 5,
        notes: '5x 1km w tempie I (przerwa 2 min trucht)',
      },
      {
        stepNumber: 3,
        type: StepType.COOLDOWN,
        durationSeconds: 600,
        targetPace: '5:45 /km',
        targetHeartRateZone: 1,
        notes: 'Schłodzenie',
      },
    ],
  };

  /**
   * Helper mimicking App.tsx conditional alert rendering predicate
   */
  const shouldRenderAiAlertCard = (readiness: ReturnType<typeof evaluateMorningReadiness>): boolean => {
    return !readiness.allowHighIntensity || readiness.recommendBikeSwap;
  };

  /**
   * Helper mimicking App.tsx isWorkoutModified evaluation logic
   */
  const computeIsWorkoutModified = (
    currentWorkout: WorkoutData,
    originalWorkout?: WorkoutData
  ): boolean => {
    return (
      currentWorkout.status === WorkoutStatus.MODIFIED ||
      (originalWorkout !== undefined &&
        (currentWorkout.title !== originalWorkout.title ||
          currentWorkout.type !== originalWorkout.type ||
          (currentWorkout.steps?.length ?? 0) !== (originalWorkout.steps?.length ?? 0))) ||
      currentWorkout.title.includes('[Adaptacja AI]') ||
      currentWorkout.title.includes('[Rower]') ||
      currentWorkout.title.includes('[Hybryda')
    );
  };

  describe('Part 1: Bi-Directional Fatigue Adjustment Stress Testing', () => {
    it('ADV-M2-1: Step UP to 5 (exhaustion) penalizes readiness, sets allowHighIntensity=false, recommendBikeSwap=true, and shows AI alert card', () => {
      // Step to 5
      const evalFatigue5 = evaluateMorningReadiness({
        garmin: baselineGarmin,
        perceivedFatigue: 5,
      });

      expect(evalFatigue5.readinessScore).toBe(50); // 85 - 35 = 50
      expect(evalFatigue5.allowHighIntensity).toBe(false);
      expect(evalFatigue5.recommendBikeSwap).toBe(true);
      expect(evalFatigue5.volumeMultiplier).toBe(0.6);
      expect(evalFatigue5.status).toBe('MODERATE_FATIGUE');
      expect(evalFatigue5.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('skrajne zmęczenie fizyczne (5/5)'),
        ])
      );

      // Verify AI recommendation alert card MUST be shown in UI
      expect(shouldRenderAiAlertCard(evalFatigue5)).toBe(true);
    });

    it('ADV-M2-2: Immediate Step DOWN from 5 to 1 (freshness) removes all penalties, grants freshness bonus, and instantly clears AI alert card', () => {
      // Step to 5 first
      const eval5 = evaluateMorningReadiness({
        garmin: baselineGarmin,
        perceivedFatigue: 5,
      });
      expect(shouldRenderAiAlertCard(eval5)).toBe(true);

      // Immediately step down to 1
      const eval1 = evaluateMorningReadiness({
        garmin: baselineGarmin,
        perceivedFatigue: 1,
      });

      // Verification of score jump and penalty clearing
      expect(eval1.readinessScore).toBe(90); // 85 + 5 = 90 (40-point leap from 50!)
      expect(eval1.allowHighIntensity).toBe(true);
      expect(eval1.recommendBikeSwap).toBe(false);
      expect(eval1.volumeMultiplier).toBe(1.0);
      expect(eval1.status).toBe('OPTIMAL');
      expect(eval1.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('pełną świeżość fizyczną (1/5)'),
        ])
      );

      // CRITICAL UI CHECK: Alert card MUST instantly clear when stepping down from 5 to 1
      expect(shouldRenderAiAlertCard(eval1)).toBe(false);
    });

    it('ADV-M2-3: Monotonic bi-directional ladder verification across full range [1, 2, 3, 4, 5] and back', () => {
      const fatigueLevels = [1, 2, 3, 4, 5];
      const ascendingResults = fatigueLevels.map((lvl) =>
        evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: lvl })
      );

      // Score progression: 90 -> 85 -> 75 -> 65 -> 50
      expect(ascendingResults.map((r) => r.readinessScore)).toEqual([90, 85, 75, 65, 50]);
      // allowHighIntensity: true -> true -> true -> false -> false
      expect(ascendingResults.map((r) => r.allowHighIntensity)).toEqual([true, true, true, false, false]);
      // recommendBikeSwap: false -> false -> false -> true -> true
      expect(ascendingResults.map((r) => r.recommendBikeSwap)).toEqual([false, false, false, true, true]);
      // volumeMultiplier: 1.0 -> 1.0 -> 0.9 -> 0.75 -> 0.6
      expect(ascendingResults.map((r) => r.volumeMultiplier)).toEqual([1.0, 1.0, 0.9, 0.75, 0.6]);
      // Alert card condition: false -> false -> false -> true -> true
      expect(ascendingResults.map((r) => shouldRenderAiAlertCard(r))).toEqual([
        false,
        false,
        false,
        true,
        true,
      ]);

      // Step back down: 5 -> 4 -> 3 -> 2 -> 1
      const descendingLevels = [5, 4, 3, 2, 1];
      const descendingResults = descendingLevels.map((lvl) =>
        evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: lvl })
      );

      expect(descendingResults.map((r) => r.readinessScore)).toEqual([50, 65, 75, 85, 90]);
      expect(descendingResults.map((r) => shouldRenderAiAlertCard(r))).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
    });

    it('ADV-M2-4: Boundary and adversarial inputs for perceivedFatigue do not crash or produce invalid scores', () => {
      // Undefined perceivedFatigue
      const evalUndef = evaluateMorningReadiness({ garmin: baselineGarmin });
      expect(evalUndef.readinessScore).toBe(85);
      expect(evalUndef.allowHighIntensity).toBe(true);

      // Null perceivedFatigue
      const evalNull = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: null });
      expect(evalNull.readinessScore).toBe(85);

      // Zero or negative perceivedFatigue
      const evalZero = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 0 });
      expect(evalZero.readinessScore).toBe(85); // treated as neutral baseline

      const evalNeg = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: -5 });
      expect(evalNeg.readinessScore).toBe(85);

      // Extreme high fatigue (e.g. 10)
      const evalHigh = evaluateMorningReadiness({ garmin: baselineGarmin, perceivedFatigue: 10 });
      expect(evalHigh.readinessScore).toBe(50); // triggers >= 5 branch safely
      expect(evalHigh.allowHighIntensity).toBe(false);

      // Score clamping floor check under multiple heavy fatigue penalties
      const evalWorstCase = evaluateMorningReadiness({
        garmin: {
          hrvStatus: 'LOW', // -30
          sleepScore: 40, // -25
          bodyBattery: 20, // -20
          steps: 22000, // -15
        },
        perceivedFatigue: 5, // -35
      });
      // 85 - 30 - 25 - 20 - 15 - 35 = -40, clamped to floor 10
      expect(evalWorstCase.readinessScore).toBe(10);
      expect(evalWorstCase.status).toBe('HIGH_FATIGUE_RECOVERY_NEEDED');
    });

    it('ADV-M2-5: Objective telemetry primacy — poor HRV or poor sleep retains AI alert even if user self-rates fatigue as 1', () => {
      // User says perceivedFatigue = 1 (fresh), but overnight HRV was critically low
      const evalConflicted = evaluateMorningReadiness({
        garmin: {
          ...baselineGarmin,
          hrv: 32,
          hrvBaselineLow: 52,
          hrvStatus: 'LOW',
        },
        perceivedFatigue: 1,
      });

      // HRV penalty (-30) + fatigue bonus (+5) = 85 - 30 + 5 = 60
      expect(evalConflicted.readinessScore).toBe(60);
      // Objective telemetry blocks high intensity regardless of subjective feeling
      expect(evalConflicted.allowHighIntensity).toBe(false);
      // UI alert card MUST remain visible to protect the athlete
      expect(shouldRenderAiAlertCard(evalConflicted)).toBe(true);
    });
  });

  describe('Part 2: Original Workout Preservation and Reset Stress Testing', () => {
    let workoutsList: WorkoutData[];
    let originalWorkouts: Record<string, WorkoutData>;
    let selectedWorkoutIdx: number;
    let pushedGarminId: string | null;

    beforeEach(() => {
      workoutsList = [JSON.parse(JSON.stringify(INITIAL_WORKOUT))];
      originalWorkouts = {
        [INITIAL_WORKOUT.id!]: JSON.parse(JSON.stringify(INITIAL_WORKOUT)),
      };
      selectedWorkoutIdx = 0;
      pushedGarminId = null;
    });

    const getSelectedWorkout = () => workoutsList[selectedWorkoutIdx];
    const getOriginal = () => originalWorkouts[getSelectedWorkout().id!];

    it('ADV-M2-6: Initial state has isWorkoutModified=false, reset button hidden, pushedGarminId=null', () => {
      const current = getSelectedWorkout();
      const orig = getOriginal();

      expect(computeIsWorkoutModified(current, orig)).toBe(false);
      expect(pushedGarminId).toBeNull();
      expect(current.title).toBe('Interwały 5x 1km @ 4:12/km');
      expect(current.status).toBe(WorkoutStatus.PLANNED);
      expect(current.type).toBe(WorkoutType.RUN);
      expect(current.steps).toHaveLength(3);
    });

    it('ADV-M2-7: Switching modality to BIKE sets title [Rower]..., status MODIFIED, shows reset button; Reset restores exact original workout, clears pushedGarminId, and hides reset button', () => {
      const origSnapshot = JSON.parse(JSON.stringify(INITIAL_WORKOUT));

      // 1. Switch to BIKE
      const convertedBike = convertWorkoutModality(
        getSelectedWorkout(),
        WorkoutType.BIKE,
        46,
        74
      );
      workoutsList[selectedWorkoutIdx] = convertedBike;
      pushedGarminId = 'gc-wkt-bike-test-111';

      const current = getSelectedWorkout();
      expect(current.type).toBe(WorkoutType.BIKE);
      expect(current.title).toContain('[Rower]');
      expect(current.status).toBe(WorkoutStatus.MODIFIED);
      expect(current.steps.every((s) => (s.targetWatts ?? 0) > 0)).toBe(true);
      expect(computeIsWorkoutModified(current, getOriginal())).toBe(true);

      // 2. Click Reset
      workoutsList[selectedWorkoutIdx] = JSON.parse(JSON.stringify(getOriginal()));
      pushedGarminId = null;

      const resetWorkout = getSelectedWorkout();
      expect(resetWorkout.title).toBe(origSnapshot.title);
      expect(resetWorkout.type).toBe(origSnapshot.type);
      expect(resetWorkout.description).toBe(origSnapshot.description);
      expect(resetWorkout.status).toBe(origSnapshot.status);
      expect(resetWorkout.steps).toEqual(origSnapshot.steps);
      expect(pushedGarminId).toBeNull();
      // Reset button disappears
      expect(computeIsWorkoutModified(resetWorkout, getOriginal())).toBe(false);
    });

    it('ADV-M2-8: Switching modality to HYBRID configures Brick workout; Reset cleanly restores original RUN session and hides reset button', () => {
      const origSnapshot = JSON.parse(JSON.stringify(INITIAL_WORKOUT));

      // 1. Switch to HYBRID
      const convertedHybrid = convertWorkoutModality(
        getSelectedWorkout(),
        WorkoutType.HYBRID,
        46,
        74
      );
      workoutsList[selectedWorkoutIdx] = convertedHybrid;

      const current = getSelectedWorkout();
      expect(current.type).toBe(WorkoutType.HYBRID);
      expect(current.title).toContain('[Hybryda Bieg+Rower]');
      expect(current.status).toBe(WorkoutStatus.MODIFIED);
      expect(current.steps).toHaveLength(4); // 2 run + 2 bike steps
      expect(computeIsWorkoutModified(current, getOriginal())).toBe(true);

      // Verify multi-segment Garmin payload mapping
      const payload = mapWorkoutToGarminPayload(current);
      expect(payload.workoutSegments).toHaveLength(2);
      expect(payload.workoutSegments[0].sportType.sportTypeKey).toBe('running');
      expect(payload.workoutSegments[1].sportType.sportTypeKey).toBe('cycling');

      // 2. Perform Reset
      workoutsList[selectedWorkoutIdx] = JSON.parse(JSON.stringify(getOriginal()));
      pushedGarminId = null;

      const resetWorkout = getSelectedWorkout();
      expect(resetWorkout.title).toBe(origSnapshot.title);
      expect(resetWorkout.type).toBe(WorkoutType.RUN);
      expect(resetWorkout.status).toBe(WorkoutStatus.PLANNED);
      expect(resetWorkout.steps).toHaveLength(3);
      expect(computeIsWorkoutModified(resetWorkout, getOriginal())).toBe(false);

      // Verify single-segment payload after reset
      const resetPayload = mapWorkoutToGarminPayload(resetWorkout);
      expect(resetPayload.workoutSegments).toHaveLength(1);
      expect(resetPayload.workoutSegments[0].sportType.sportTypeKey).toBe('running');
    });

    it('ADV-M2-9: Multi-hop transitions (RUN -> HYBRID -> BIKE -> HYBRID -> BIKE) preserve true original baseline upon Reset', () => {
      const origSnapshot = JSON.parse(JSON.stringify(INITIAL_WORKOUT));

      // Multi-hop transitions
      const toHybrid1 = convertWorkoutModality(getSelectedWorkout(), WorkoutType.HYBRID, 46, 74);
      workoutsList[selectedWorkoutIdx] = toHybrid1;

      const toBike1 = convertWorkoutModality(getSelectedWorkout(), WorkoutType.BIKE, 46, 74);
      workoutsList[selectedWorkoutIdx] = toBike1;

      const toHybrid2 = convertWorkoutModality(getSelectedWorkout(), WorkoutType.HYBRID, 46, 74);
      workoutsList[selectedWorkoutIdx] = toHybrid2;

      const toBike2 = convertWorkoutModality(getSelectedWorkout(), WorkoutType.BIKE, 46, 74);
      workoutsList[selectedWorkoutIdx] = toBike2;

      expect(getSelectedWorkout().type).toBe(WorkoutType.BIKE);
      expect(computeIsWorkoutModified(getSelectedWorkout(), getOriginal())).toBe(true);

      // Reset
      workoutsList[selectedWorkoutIdx] = JSON.parse(JSON.stringify(getOriginal()));
      pushedGarminId = null;

      const afterReset = getSelectedWorkout();
      expect(afterReset.title).toBe(origSnapshot.title);
      expect(afterReset.type).toBe(WorkoutType.RUN);
      expect(afterReset.status).toBe(WorkoutStatus.PLANNED);
      expect(afterReset.steps).toEqual(origSnapshot.steps);
      expect(computeIsWorkoutModified(afterReset, getOriginal())).toBe(false);
    });

    it('ADV-M2-10: Applying AI Adaptation marks session MODIFIED and pushedGarminId is set; Reset restores original and clears Garmin push ID', () => {
      const origSnapshot = JSON.parse(JSON.stringify(INITIAL_WORKOUT));

      // Simulate applying AI adaptation (as in App.tsx handleApplyAiAdaptation)
      const converted = convertWorkoutModality(
        getSelectedWorkout(),
        WorkoutType.BIKE,
        46,
        74
      );
      workoutsList[selectedWorkoutIdx] = {
        ...converted,
        title: '[Adaptacja AI] Regeneracyjny Rower Matrix Z1/Z2',
        description: 'Zmodyfikowano przez AI (Zgłoszono skrajne zmęczenie fizyczne)',
        status: WorkoutStatus.MODIFIED,
      };
      pushedGarminId = 'gc-wkt-pushed-after-ai-adapt';

      expect(computeIsWorkoutModified(getSelectedWorkout(), getOriginal())).toBe(true);

      // Reset
      workoutsList[selectedWorkoutIdx] = JSON.parse(JSON.stringify(getOriginal()));
      pushedGarminId = null;

      const afterReset = getSelectedWorkout();
      expect(afterReset.title).toBe(origSnapshot.title);
      expect(afterReset.type).toBe(WorkoutType.RUN);
      expect(afterReset.status).toBe(WorkoutStatus.PLANNED);
      expect(pushedGarminId).toBeNull();
      expect(computeIsWorkoutModified(afterReset, getOriginal())).toBe(false);
    });

    it('ADV-M2-11: Deep clone isolation — in-place mutation of active workout does not contaminate originalWorkouts cache', () => {
      const origSnapshot = JSON.parse(JSON.stringify(INITIAL_WORKOUT));

      // Maliciously mutate current workout in place
      const current = getSelectedWorkout();
      current.steps.push({
        stepNumber: 99,
        type: StepType.ACTIVE,
        durationSeconds: 9999,
        targetPace: '1:00 /km',
      });
      current.title = 'MUTATED IN PLACE BY DRILLS';
      current.steps[0].targetPace = 'CORRUPTED PACE';

      // Verify originalWorkouts was NOT contaminated
      const cachedOriginal = getOriginal();
      expect(cachedOriginal.title).toBe(origSnapshot.title);
      expect(cachedOriginal.steps).toHaveLength(3);
      expect(cachedOriginal.steps[0].targetPace).toBe('5:30 /km');

      // Reset restores clean state
      workoutsList[selectedWorkoutIdx] = JSON.parse(JSON.stringify(cachedOriginal));
      expect(getSelectedWorkout().steps).toHaveLength(3);
      expect(getSelectedWorkout().title).toBe(origSnapshot.title);
      expect(computeIsWorkoutModified(getSelectedWorkout(), cachedOriginal)).toBe(false);
    });

    it('ADV-M2-12: Multi-day plan isolation — resetting one day preserves other modified days in weekly schedule', () => {
      const day1: WorkoutData = {
        id: 'day-1',
        date: '2026-11-02',
        type: WorkoutType.RUN,
        title: 'Bieg spokojny Z2',
        status: WorkoutStatus.PLANNED,
        steps: [{ stepNumber: 1, type: StepType.ACTIVE, durationSeconds: 1800, targetPace: '5:30' }],
      };
      const day2: WorkoutData = {
        id: 'day-2',
        date: '2026-11-04',
        type: WorkoutType.RUN,
        title: 'Interwały VO2max',
        status: WorkoutStatus.PLANNED,
        steps: [{ stepNumber: 1, type: StepType.ACTIVE, distanceMeters: 5000, targetPace: '4:10' }],
      };

      workoutsList = [JSON.parse(JSON.stringify(day1)), JSON.parse(JSON.stringify(day2))];
      originalWorkouts = {
        'day-1': JSON.parse(JSON.stringify(day1)),
        'day-2': JSON.parse(JSON.stringify(day2)),
      };

      // Modify Day 1 to HYBRID
      workoutsList[0] = convertWorkoutModality(workoutsList[0], WorkoutType.HYBRID, 46, 74);
      // Modify Day 2 to BIKE
      workoutsList[1] = convertWorkoutModality(workoutsList[1], WorkoutType.BIKE, 46, 74);

      expect(computeIsWorkoutModified(workoutsList[0], originalWorkouts['day-1'])).toBe(true);
      expect(computeIsWorkoutModified(workoutsList[1], originalWorkouts['day-2'])).toBe(true);

      // Reset Day 1 ONLY
      workoutsList[0] = JSON.parse(JSON.stringify(originalWorkouts['day-1']));

      // Day 1 must be clean and unmodified
      expect(computeIsWorkoutModified(workoutsList[0], originalWorkouts['day-1'])).toBe(false);
      expect(workoutsList[0].type).toBe(WorkoutType.RUN);
      expect(workoutsList[0].title).toBe('Bieg spokojny Z2');

      // Day 2 must remain MODIFIED BIKE
      expect(computeIsWorkoutModified(workoutsList[1], originalWorkouts['day-2'])).toBe(true);
      expect(workoutsList[1].type).toBe(WorkoutType.BIKE);
    });
  });
});
