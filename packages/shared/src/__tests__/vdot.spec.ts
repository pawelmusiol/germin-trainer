import {
  calculateVdotFromRace,
  calculateRaceTimeFromVdot,
  calculateVdotPaces,
  formatPace,
  parsePace,
  convertRunToBikeWatts,
  convertRunToBikeDuration,
  estimateCurrentVdotFromGarminRuns,
} from '../vdot';

describe('Jack Daniels Physiology Engine — VDOT & Race Inversion', () => {
  describe('calculateRaceTimeFromVdot benchmark times at VDOT 50', () => {
    it('computes 5000m race time close to 19:57 (~1197s)', () => {
      const time = calculateRaceTimeFromVdot(5000, 50.0);
      // Continuous Daniels formula yields 1196s (19:56), within 2s of 1197s
      expect(Math.abs(time - 1197)).toBeLessThanOrEqual(2);
      expect(calculateVdotFromRace(5000, time)).toBe(50.0);
    });

    it('computes 10000m race time close to 41:21 (~2481s)', () => {
      const time = calculateRaceTimeFromVdot(10000, 50.0);
      // Continuous Daniels formula yields 2480s (41:20), within 2s of 2481s
      expect(Math.abs(time - 2481)).toBeLessThanOrEqual(2);
      expect(calculateVdotFromRace(10000, time)).toBe(50.0);
    });

    it('computes Half Marathon (21097.5m) race time close to 1:31:35 (~5495s)', () => {
      const time = calculateRaceTimeFromVdot(21097.5, 50.0);
      // Continuous Daniels formula yields 5491s (1:31:31), within 6s of 5495s
      expect(Math.abs(time - 5495)).toBeLessThanOrEqual(6);
      expect(calculateVdotFromRace(21097.5, time)).toBe(50.0);
    });

    it('computes Marathon (42195m) race time close to 3:10:49 (~11449s)', () => {
      const time = calculateRaceTimeFromVdot(42195, 50.0);
      // Continuous Daniels formula yields 11440s (3:10:40), within 12s of 11449s
      expect(Math.abs(time - 11449)).toBeLessThanOrEqual(12);
      expect(calculateVdotFromRace(42195, time)).toBe(50.0);
    });
  });

  describe('Round-trip fidelity between calculateVdotFromRace and calculateRaceTimeFromVdot', () => {
    const distances = [800, 1000, 1500, 3000, 5000, 10000, 21097.5, 42195];
    const vdots = [30.0, 35.0, 42.0, 50.0, 58.0, 65.0, 75.0, 85.0];

    for (const distance of distances) {
      // Discretization tolerance: For sub-3000m distances, rounding predicted finish time
      // to the nearest integer second creates an expected discretization error of up to 0.3 VDOT
      // (mathematical property of integer seconds on short duration events).
      // For distances >= 3000m, duration is sufficiently long that quantization error is strictly <= 0.1 VDOT.
      const maxAllowedError = distance < 3000 ? 0.3 : 0.1;

      for (const vdot of vdots) {
        it(`preserves VDOT ${vdot} within ${maxAllowedError} for distance ${distance}m`, () => {
          const raceTime = calculateRaceTimeFromVdot(distance, vdot);
          const computedVdot = calculateVdotFromRace(distance, raceTime);
          expect(Math.abs(computedVdot - vdot)).toBeLessThanOrEqual(maxAllowedError);
        });
      }
    }
  });

  describe('Numerical Monotonicity across distances and VDOT range (VDOT ↑ => Race Time ↓)', () => {
    const monotonicityDistances = [800, 1000, 1500, 5000];

    for (const distance of monotonicityDistances) {
      it(`strictly decreases race time as VDOT increases by 1.0 from 30 to 85 for ${distance}m`, () => {
        let prevTime = Infinity;
        for (let vdot = 30.0; vdot <= 85.0; vdot += 1.0) {
          const currentTime = calculateRaceTimeFromVdot(distance, vdot);
          expect(currentTime).toBeLessThan(prevTime);
          prevTime = currentTime;
        }
      });
    }

    it('ensures 800m race time decreases through elite VDOT range 72 to 85 without flatlining', () => {
      let prevTime = calculateRaceTimeFromVdot(800, 71.0);
      for (let vdot = 72.0; vdot <= 85.0; vdot += 1.0) {
        const time = calculateRaceTimeFromVdot(800, vdot);
        expect(time).toBeLessThan(prevTime);
        prevTime = time;
      }
      // At VDOT 85, predicted 800m time must be ~104s (comfortably below legacy 120s floor clamp)
      const time85 = calculateRaceTimeFromVdot(800, 85.0);
      expect(time85).toBeLessThan(120);
      expect(time85).toBe(104);
    });
  });

  describe('Comprehensive Boundary & NaN Handling', () => {
    describe('calculateRaceTimeFromVdot boundary handling', () => {
      it('returns 0 for non-positive distance (0, negative)', () => {
        expect(calculateRaceTimeFromVdot(0, 50)).toBe(0);
        expect(calculateRaceTimeFromVdot(-100, 50)).toBe(0);
        expect(calculateRaceTimeFromVdot(-5000, 50)).toBe(0);
      });

      it('returns 0 for non-finite distance (NaN, Infinity, -Infinity)', () => {
        expect(calculateRaceTimeFromVdot(NaN, 50)).toBe(0);
        expect(calculateRaceTimeFromVdot(Infinity, 50)).toBe(0);
        expect(calculateRaceTimeFromVdot(-Infinity, 50)).toBe(0);
      });

      it('clamps out-of-range numeric VDOT values ([30.0, 85.0])', () => {
        expect(calculateRaceTimeFromVdot(5000, 20.0)).toBe(calculateRaceTimeFromVdot(5000, 30.0));
        expect(calculateRaceTimeFromVdot(5000, 0)).toBe(calculateRaceTimeFromVdot(5000, 30.0));
        expect(calculateRaceTimeFromVdot(5000, -10)).toBe(calculateRaceTimeFromVdot(5000, 30.0));
        expect(calculateRaceTimeFromVdot(5000, 95.0)).toBe(calculateRaceTimeFromVdot(5000, 85.0));
        expect(calculateRaceTimeFromVdot(5000, 150.0)).toBe(calculateRaceTimeFromVdot(5000, 85.0));
      });

      it('safely clamps non-finite VDOT (NaN, Infinity, -Infinity)', () => {
        // vdot = NaN falls back safely to baseline 30.0
        const timeNaN = calculateRaceTimeFromVdot(5000, NaN);
        expect(Number.isFinite(timeNaN)).toBe(true);
        expect(timeNaN).toBe(calculateRaceTimeFromVdot(5000, 30.0));
        expect(timeNaN).not.toBe(120);

        // Infinity and -Infinity clamp to upper (85) and lower (30) bounds
        expect(calculateRaceTimeFromVdot(5000, Infinity)).toBe(calculateRaceTimeFromVdot(5000, 85.0));
        expect(calculateRaceTimeFromVdot(5000, -Infinity)).toBe(calculateRaceTimeFromVdot(5000, 30.0));
      });
    });

    describe('calculateVdotFromRace boundary handling', () => {
      it('returns baseline 30.0 for non-positive distance or finish time', () => {
        expect(calculateVdotFromRace(0, 1200)).toBe(30.0);
        expect(calculateVdotFromRace(-5000, 1200)).toBe(30.0);
        expect(calculateVdotFromRace(5000, 0)).toBe(30.0);
        expect(calculateVdotFromRace(5000, -600)).toBe(30.0);
        expect(calculateVdotFromRace(0, 0)).toBe(30.0);
      });

      it('returns baseline 30.0 for non-finite inputs (NaN, Infinity, -Infinity)', () => {
        expect(calculateVdotFromRace(NaN, 1200)).toBe(30.0);
        expect(calculateVdotFromRace(5000, NaN)).toBe(30.0);
        expect(calculateVdotFromRace(NaN, NaN)).toBe(30.0);
        expect(calculateVdotFromRace(Infinity, 1200)).toBe(30.0);
        expect(calculateVdotFromRace(5000, Infinity)).toBe(30.0);
        expect(calculateVdotFromRace(-Infinity, 1200)).toBe(30.0);
        expect(calculateVdotFromRace(5000, -Infinity)).toBe(30.0);
      });

      it('clamps calculated VDOT between 30.0 and 85.0 for extreme times', () => {
        // Extremely slow race: 5K in 5 hours
        expect(calculateVdotFromRace(5000, 18000)).toBe(30.0);
        // Supersonic race: 5K in 5 minutes (300s)
        expect(calculateVdotFromRace(5000, 300)).toBe(85.0);
      });
    });

    describe('calculateVdotPaces boundary handling', () => {
      it('returns valid paces clamped to baseline 30.0 when given NaN', () => {
        const paces = calculateVdotPaces(NaN);
        expect(paces.vdot).toBe(30.0);
        expect(Number.isFinite(paces.rawSecondsPerKm.easyMin)).toBe(true);
        expect(Number.isFinite(paces.rawSecondsPerKm.marathon)).toBe(true);
        expect(Number.isFinite(paces.rawSecondsPerKm.threshold)).toBe(true);
        expect(Number.isFinite(paces.rawSecondsPerKm.interval)).toBe(true);
        expect(Number.isFinite(paces.rawSecondsPerKm.repetition)).toBe(true);
        expect(paces.easyPace).not.toContain('NaN');
        expect(paces.thresholdPace).not.toContain('NaN');
        expect(paces).toEqual(calculateVdotPaces(30.0));
      });

      it('clamps non-finite extremes (Infinity, -Infinity) to valid ranges', () => {
        const pacesInf = calculateVdotPaces(Infinity);
        expect(pacesInf.vdot).toBe(85.0);
        expect(pacesInf).toEqual(calculateVdotPaces(85.0));

        const pacesNegInf = calculateVdotPaces(-Infinity);
        expect(pacesNegInf.vdot).toBe(30.0);
        expect(pacesNegInf).toEqual(calculateVdotPaces(30.0));
      });

      it('clamps numeric values outside [30.0, 85.0]', () => {
        expect(calculateVdotPaces(15.0)).toEqual(calculateVdotPaces(30.0));
        expect(calculateVdotPaces(99.0)).toEqual(calculateVdotPaces(85.0));
      });
    });
  });

  describe('estimateCurrentVdotFromGarminRuns', () => {
    it('returns null when no qualifying runs exist', () => {
      const result = estimateCurrentVdotFromGarminRuns([]);
      expect(result).toBeNull();
    });

    it('filters out runs shorter than 2000m or 600s', () => {
      const result = estimateCurrentVdotFromGarminRuns([
        { activityType: 'RUN', distanceMeters: 1500, durationSeconds: 400 },
        { activityType: 'RUN', distanceMeters: 2500, durationSeconds: 500 },
      ]);
      expect(result).toBeNull();
    });

    it('estimates physiologically plausible VDOT and sets estimated10kSeconds via inversion', () => {
      // 10K run in 45:00 (2700s) with avgHr 165
      const result = estimateCurrentVdotFromGarminRuns([
        {
          activityType: 'RUN',
          distanceMeters: 10000,
          durationSeconds: 2700,
          averageHeartRate: 165,
          maxHeartRate: 185,
        },
      ]);
      expect(result).not.toBeNull();
      expect(result!.sampleCount).toBe(1);
      expect(result!.estimatedVdot).toBeGreaterThanOrEqual(40);
      expect(result!.estimatedVdot).toBeLessThanOrEqual(55);
      // estimated10kSeconds must match calculateRaceTimeFromVdot(10000, estimatedVdot)
      const expectedTime = calculateRaceTimeFromVdot(10000, result!.estimatedVdot);
      expect(result!.estimated10kSeconds).toBe(expectedTime);
    });

    it('calculates VDOT directly from race performance when heart rate telemetry is missing or null', () => {
      // 5K in 20:00 without HR telemetry -> should calculate race VDOT 49.8
      const result = estimateCurrentVdotFromGarminRuns([
        {
          activityType: 'RUN',
          distanceMeters: 5000,
          durationSeconds: 1200,
        },
      ]);
      expect(result).not.toBeNull();
      expect(result!.sampleCount).toBe(1);
      expect(result!.estimatedVdot).toBe(49.8);
      expect(result!.estimated10kSeconds).toBe(calculateRaceTimeFromVdot(10000, 49.8));

      // 10K in 41:20 with explicit null HR -> should calculate race VDOT 50.0
      const resultNullHr = estimateCurrentVdotFromGarminRuns([
        {
          activityType: 'RUN',
          distanceMeters: 10000,
          durationSeconds: 2480,
          averageHeartRate: null,
          maxHeartRate: null,
        },
      ]);
      expect(resultNullHr).not.toBeNull();
      expect(resultNullHr!.sampleCount).toBe(1);
      expect(resultNullHr!.estimatedVdot).toBe(50.0);
    });
  });

  describe('Pace formatting and Bike conversions', () => {
    it('formats pace correctly', () => {
      expect(formatPace(300)).toBe('5:00 /km');
      expect(formatPace(272)).toBe('4:32 /km');
      expect(formatPace(0)).toBe('0:00 /km');
    });

    it('parses pace correctly', () => {
      expect(parsePace('5:00 /km')).toBe(300);
      expect(parsePace('4:32')).toBe(272);
      expect(parsePace('invalid')).toBe(0);
    });

    it('converts run duration to bike duration (1.33x factor)', () => {
      expect(convertRunToBikeDuration(45)).toBe(60);
    });

    it('calculates cycling watt zones from VDOT and weight', () => {
      const watts = convertRunToBikeWatts(50, 70);
      expect(watts.ftp).toBe(263); // 50 * 70 * 0.075 = 262.5 -> 263
      expect(watts.easy.target).toBe(Math.round(263 * 0.65));
    });
  });
});
