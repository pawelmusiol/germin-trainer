import {
  WorkoutType,
  encodeIndoorBikeDataFrame,
  encodeTreadmillDataFrame,
  parseIndoorBikeDataFrame,
  parseTreadmillDataFrame,
  summarizeIndoorSession,
  MatrixSessionAccumulator,
  formatDuration,
  formatDistanceKm,
  loadSavedMatrixSessions,
  saveMatrixSessionToStorage,
  clearSavedMatrixSessions,
  SavedMatrixSession,
} from '../index';

describe('Matrix BLE FTMS Telemetry & Session Lifecycle Suite', () => {
  beforeEach(() => {
    // Clear mock localStorage before each test
    (globalThis as any).localStorage = {
      store: {} as Record<string, string>,
      getItem(key: string) {
        return this.store[key] || null;
      },
      setItem(key: string, val: string) {
        this.store[key] = String(val);
      },
      removeItem(key: string) {
        delete this.store[key];
      },
    };
  });

  afterAll(() => {
    delete (globalThis as any).localStorage;
  });

  describe('1-Second Telemetry Accumulation (Bike 0x2AD2)', () => {
    it('initializes in IDLE state and starts recording on demand', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      expect(accumulator.getState()).toBe('IDLE');
      expect(accumulator.getElapsedSeconds()).toBe(0);
      expect(accumulator.getSamples()).toHaveLength(0);

      accumulator.start();
      expect(accumulator.getState()).toBe('RECORDING');
    });

    it('accumulates 1-second ticks and decodes binary FTMS Indoor Bike packets', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Simulate 5 seconds with live binary frames
      for (let sec = 1; sec <= 5; sec++) {
        const frame = encodeIndoorBikeDataFrame({
          speedKmh: 30.0 + sec * 0.2, // 30.2, 30.4, ...
          cadenceRpm: 90 + sec,       // 91, 92, ...
          distanceMeters: 5000 + sec * 10, // machine odometer
          powerWatts: 180 + sec * 5,  // 185, 190, ...
          heartRateBpm: 140 + sec,    // 141, 142, ...
        });

        const parsed = accumulator.ingestRawPacket(frame);
        expect(parsed.speedKmh).toBeCloseTo(30.0 + sec * 0.2, 1);
        expect(parsed.cadenceRpm).toBe(90 + sec);
        expect(parsed.powerWatts).toBe(180 + sec * 5);

        const tickResult = accumulator.tickOneSecond();
        expect(tickResult).not.toBeNull();
        expect(tickResult!.elapsedSeconds).toBe(sec);
      }

      expect(accumulator.getElapsedSeconds()).toBe(5);
      const samples = accumulator.getSamples();
      expect(samples).toHaveLength(5);
      expect(samples[0].timestampOffsetSeconds).toBe(1);
      expect(samples[4].timestampOffsetSeconds).toBe(5);

      // Distance offset verification: 5010 - 5010 = 0m, 5050 - 5010 = 40m delta
      expect(samples[4].distanceMeters).toBe(40);
    });

    it('integrates distance from speed when machine odometer is not transmitted', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // 36 km/h = 10 m/s
      accumulator.ingestSample({
        speedKmh: 36,
        cadenceRpm: 90,
        powerWatts: 200,
        heartRateBpm: 150,
      });

      for (let i = 0; i < 10; i++) {
        accumulator.tickOneSecond();
      }

      expect(accumulator.getElapsedSeconds()).toBe(10);
      const live = accumulator.getLiveMetrics();
      // 10 seconds at 10 m/s = 100 meters
      expect(live.distanceMeters).toBe(100);
    });
  });

  describe('Treadmill Telemetry Accumulation (0x2ACD)', () => {
    it('decodes Treadmill Data frames and records incline', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.TREADMILL);
      accumulator.start();

      const frame = encodeTreadmillDataFrame({
        speedKmh: 12.0,
        distanceMeters: 100,
        inclinePercent: 2.5,
        heartRateBpm: 155,
      });

      accumulator.ingestRawPacket(frame);
      accumulator.tickOneSecond();

      const live = accumulator.getLiveMetrics();
      expect(live.speedKmh).toBe(12.0);
      expect(live.inclinePercent).toBe(2.5);
      expect(live.heartRateBpm).toBe(155);
      expect(accumulator.getSamples()[0].inclinePercent).toBe(2.5);
    });
  });

  describe('Session Lifecycle Controls: Pause, Resume, Reset, Finish', () => {
    it('freezes timer and accumulation when paused, and resumes cleanly', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      accumulator.ingestSample({ speedKmh: 25, powerWatts: 150 });
      accumulator.tickOneSecond();
      accumulator.tickOneSecond();
      expect(accumulator.getElapsedSeconds()).toBe(2);

      // Pause
      accumulator.pause();
      expect(accumulator.getState()).toBe('PAUSED');
      const tickWhilePaused = accumulator.tickOneSecond();
      expect(tickWhilePaused).toBeNull();
      expect(accumulator.getElapsedSeconds()).toBe(2);
      expect(accumulator.getSamples()).toHaveLength(2);

      // Resume
      accumulator.resume();
      expect(accumulator.getState()).toBe('RECORDING');
      accumulator.tickOneSecond();
      expect(accumulator.getElapsedSeconds()).toBe(3);
      expect(accumulator.getSamples()).toHaveLength(3);
    });

    it('resets accumulator back to IDLE with cleared metrics', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();
      accumulator.tickOneSecond();
      accumulator.reset();

      expect(accumulator.getState()).toBe('IDLE');
      expect(accumulator.getElapsedSeconds()).toBe(0);
      expect(accumulator.getSamples()).toHaveLength(0);
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(0);
    });
  });

  describe('Aggregated Session Summary Calculation', () => {
    it('generates accurate session summary with all required metrics', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Simulate a 30-second steady effort
      for (let sec = 1; sec <= 30; sec++) {
        accumulator.ingestSample({
          speedKmh: 30.0,
          cadenceRpm: 90,
          powerWatts: 200,
          heartRateBpm: 145 + (sec % 5), // 145 - 149
        });
        accumulator.tickOneSecond();
      }

      const summary = accumulator.finish();
      expect(accumulator.getState()).toBe('FINISHED');
      expect(summary.equipmentType).toBe(WorkoutType.BIKE);
      expect(summary.durationSeconds).toBe(30);
      // At 30 km/h for 30s: 30000 m / 3600 * 30 = 250 meters
      expect(summary.distanceMeters).toBe(250);
      expect(summary.averageSpeedKmh).toBe(30.0);
      expect(summary.averagePowerWatts).toBe(200);
      expect(summary.maxPowerWatts).toBe(200);
      expect(summary.averageCadenceRpm).toBe(90);
      expect(summary.averageHeartRateBpm).toBeGreaterThanOrEqual(145);
      expect(summary.maxHeartRateBpm).toBe(149);
      expect(summary.estimatedCalories).toBeGreaterThan(0);
    });

    it('handles immediate finish with 0 samples safely without NaN or division by zero', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();
      const summary = accumulator.finish();

      expect(summary.durationSeconds).toBe(0);
      expect(summary.distanceMeters).toBe(0);
      expect(summary.averageSpeedKmh).toBe(0);
      expect(summary.averagePowerWatts).toBeNull();
      expect(summary.maxPowerWatts).toBeNull();
      expect(summary.averageCadenceRpm).toBeNull();
      expect(summary.averageHeartRateBpm).toBeNull();
      expect(summary.maxHeartRateBpm).toBeNull();
      expect(summary.estimatedCalories).toBe(0);
    });

    it('computes average incline for treadmill session summary', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.TREADMILL);
      accumulator.start();

      for (let i = 1; i <= 4; i++) {
        accumulator.ingestSample({
          speedKmh: 10.0,
          inclinePercent: i * 1.0, // 1, 2, 3, 4 -> avg 2.5
          heartRateBpm: 150,
        });
        accumulator.tickOneSecond();
      }

      const summary = accumulator.finish();
      expect(summary.averageInclinePercent).toBe(2.5);
    });
  });

  describe('Local Session Summary Storage & Formatting', () => {
    it('formats duration and distance cleanly', () => {
      expect(formatDuration(45)).toBe('00:45');
      expect(formatDuration(125)).toBe('02:05');
      expect(formatDuration(3665)).toBe('1:01:05');
      expect(formatDistanceKm(14250)).toBe('14.25 km');
      expect(formatDistanceKm(0)).toBe('0.00 km');
    });

    it('saves and retrieves completed session summaries in local storage', () => {
      clearSavedMatrixSessions();
      expect(loadSavedMatrixSessions()).toHaveLength(0);

      const mockSession: SavedMatrixSession = {
        id: 'test-session-1',
        savedAt: new Date().toISOString(),
        equipmentType: WorkoutType.BIKE,
        deviceName: 'Matrix ICR50 Bike',
        summary: {
          equipmentType: WorkoutType.BIKE,
          durationSeconds: 1800,
          distanceMeters: 15000,
          averageSpeedKmh: 30.0,
          averagePowerWatts: 195,
          maxPowerWatts: 240,
          averageCadenceRpm: 92,
          averageHeartRateBpm: 148,
          maxHeartRateBpm: 165,
          averageInclinePercent: null,
          estimatedCalories: 420,
        },
        samplesCount: 1800,
      };

      const savedList = saveMatrixSessionToStorage(mockSession);
      expect(savedList).toHaveLength(1);
      expect(savedList[0].id).toBe('test-session-1');

      const retrieved = loadSavedMatrixSessions();
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].summary.averagePowerWatts).toBe(195);
      expect(retrieved[0].summary.maxPowerWatts).toBe(240);
      expect(retrieved[0].summary.estimatedCalories).toBe(420);

      clearSavedMatrixSessions();
      expect(loadSavedMatrixSessions()).toHaveLength(0);
    });

    it('gracefully handles malformed or non-array local storage data', () => {
      (globalThis as any).localStorage.setItem(
        'garmin_trainer_matrix_sessions_v1',
        JSON.stringify({ notAnArray: true })
      );
      expect(loadSavedMatrixSessions()).toEqual([]);

      (globalThis as any).localStorage.setItem(
        'garmin_trainer_matrix_sessions_v1',
        'invalid-json-string{{'
      );
      expect(loadSavedMatrixSessions()).toEqual([]);
    });
  });

  describe('Adversarial Edge Cases & Robustness Probing', () => {
    it('properly includes 0 Watts coasting in average power calculations', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // 10 seconds active pedaling at 200W
      for (let i = 0; i < 10; i++) {
        accumulator.ingestSample({ speedKmh: 30, powerWatts: 200, cadenceRpm: 90 });
        accumulator.tickOneSecond();
      }

      // 10 seconds coasting at 0W
      for (let i = 0; i < 10; i++) {
        accumulator.ingestSample({ speedKmh: 28, powerWatts: 0, cadenceRpm: 0 });
        accumulator.tickOneSecond();
      }

      const summary = accumulator.finish();
      expect(summary.durationSeconds).toBe(20);
      // (10 * 200 + 10 * 0) / 20 = 100W
      expect(summary.averagePowerWatts).toBe(100);
      expect(summary.maxPowerWatts).toBe(200);
    });

    it('estimates speed and distance when machine transmits cadence but speed is 0 [R1-4]', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Console transmits cadence 90 RPM and power 200W, but speed 0 km/h and no odometer
      accumulator.ingestSample({
        speedKmh: 0,
        cadenceRpm: 90,
        powerWatts: 200,
      });

      for (let i = 0; i < 10; i++) {
        accumulator.tickOneSecond();
      }

      const live = accumulator.getLiveMetrics();
      // 90 RPM * 0.35 = 31.5 km/h
      expect(live.speedKmh).toBe(31.5);
      // 10 seconds at 31.5 km/h (8.75 m/s) = 87.5m -> 88m
      expect(live.distanceMeters).toBeGreaterThan(80);
      expect(live.distanceMeters).toBeLessThan(95);

      const summary = accumulator.finish();
      expect(summary.distanceMeters).toBe(live.distanceMeters);
      expect(summary.averageSpeedKmh).toBeCloseTo(31.5, 0);
    });

    it('does not inflate session distance when machine odometer moves while paused', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Machine odometer at 5000m. 5 seconds ride -> reaches 5050m (+50m)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5000 });
      for (let i = 1; i <= 5; i++) {
        accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5000 + i * 10 });
        accumulator.tickOneSecond();
      }
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(50);

      // User pauses session
      accumulator.pause();
      expect(accumulator.getState()).toBe('PAUSED');

      // Machine moves another 100m while user is paused (odometer reaches 5150m)
      accumulator.ingestSample({ speedKmh: 0, distanceMeters: 5150 });
      // Tick while paused should not advance distance or samples
      accumulator.tickOneSecond();
      expect(accumulator.getElapsedSeconds()).toBe(5);

      // User resumes
      accumulator.resume();
      expect(accumulator.getState()).toBe('RECORDING');
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(50);

      // User rides another 5 seconds (+50m: odometer reaches 5200m)
      for (let i = 1; i <= 5; i++) {
        accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5150 + i * 10 });
        accumulator.tickOneSecond();
      }

      const summary = accumulator.finish();
      // Total session duration = 10s, total active distance = 100m (50m before pause + 50m after pause)
      expect(summary.durationSeconds).toBe(10);
      expect(summary.distanceMeters).toBe(100);
    });

    it('correctly tracks delta when machine odometer starts at 0 meters', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Initial packet has 0 meters
      accumulator.ingestSample({ speedKmh: 20, distanceMeters: 0 });
      accumulator.tickOneSecond();

      accumulator.ingestSample({ speedKmh: 20, distanceMeters: 15 });
      accumulator.tickOneSecond();

      const live = accumulator.getLiveMetrics();
      expect(live.distanceMeters).toBe(15);
    });

    it('returns duration 0 when summarizeIndoorSession is called with empty samples', () => {
      const summary = summarizeIndoorSession(WorkoutType.BIKE, []);
      expect(summary.durationSeconds).toBe(0);
      expect(summary.distanceMeters).toBe(0);
      expect(summary.averagePowerWatts).toBeNull();
      expect(summary.averageCadenceRpm).toBeNull();
    });

    it('resists invalid rapid lifecycle calls [R1-5]', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      // Calling pause/resume when IDLE is no-op
      accumulator.pause();
      expect(accumulator.getState()).toBe('IDLE');
      accumulator.resume();
      expect(accumulator.getState()).toBe('IDLE');

      accumulator.start();
      expect(accumulator.getState()).toBe('RECORDING');
      // Double resume when already recording is no-op
      accumulator.resume();
      expect(accumulator.getState()).toBe('RECORDING');

      accumulator.pause();
      expect(accumulator.getState()).toBe('PAUSED');
      // Double pause when already paused is no-op
      accumulator.pause();
      expect(accumulator.getState()).toBe('PAUSED');

      accumulator.finish();
      expect(accumulator.getState()).toBe('FINISHED');
    });

    it('accurately parses FTMS Treadmill Data 0x2ACD frame with Elevation Gain and Expended Energy preceding Heart Rate and Power', () => {
      // Build raw binary FTMS 0x2ACD frame manually to test arbitrary manufacturer payloads:
      // Bit 0 = 0 (Instantaneous Speed present: uint16, 12.00 km/h = 1200)
      // Bit 2 = 1 (Total Distance present: uint24, 1500m)
      // Bit 3 = 1 (Inclination present: 2x sint16, 2.5% = 25)
      // Bit 4 = 1 (Elevation Gain present: 2x sint16 = 4 bytes)
      // Bit 5 = 1 (Instantaneous Pace present: uint8 = 1 byte)
      // Bit 7 = 1 (Expended Energy present: uint16 + uint16 + uint8 = 5 bytes: 240 kcal)
      // Bit 8 = 1 (Heart Rate present: uint8, 158 BPM)
      // Bit 12 = 1 (Force & Power present: sint16 force + sint16 power Watts: 210W)
      const flags = (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 12);
      // Length: 2 (flags) + 2 (speed) + 3 (dist) + 4 (incline) + 4 (elev) + 1 (pace) + 5 (energy) + 1 (hr) + 4 (power) = 26 bytes
      const buf = new Uint8Array(26);
      const view = new DataView(buf.buffer);
      let offset = 0;

      view.setUint16(offset, flags, true); offset += 2;
      view.setUint16(offset, 1200, true); offset += 2; // 12.00 km/h

      // Distance 1500m (uint24)
      buf[offset] = 1500 & 0xff;
      buf[offset + 1] = (1500 >> 8) & 0xff;
      buf[offset + 2] = (1500 >> 16) & 0xff;
      offset += 3;

      // Incline 2.5% (25) & Ramp 2.5%
      view.setInt16(offset, 25, true);
      view.setInt16(offset + 2, 25, true);
      offset += 4;

      // Elevation Gain (+50dm, -10dm)
      view.setInt16(offset, 50, true);
      view.setInt16(offset + 2, -10, true);
      offset += 4;

      // Instantaneous Pace (6 min/km)
      buf[offset] = 60;
      offset += 1;

      // Expended Energy (240 kcal total, 100/h, 2/min)
      view.setUint16(offset, 240, true);
      view.setUint16(offset + 2, 100, true);
      buf[offset + 4] = 2;
      offset += 5;

      // Heart Rate: 158 BPM
      buf[offset] = 158;
      offset += 1;

      // Force on Belt (0) + Power Output (210W)
      view.setInt16(offset, 0, true);
      view.setInt16(offset + 2, 210, true);
      offset += 4;

      const sample = parseTreadmillDataFrame(buf, 10);
      expect(sample.speedKmh).toBe(12.0);
      expect(sample.distanceMeters).toBe(1500);
      expect(sample.inclinePercent).toBe(2.5);
      // Heart rate must NOT be corrupted by expended energy bytes
      expect(sample.heartRateBpm).toBe(158);
      // Power Watts must be parsed from Bit 12
      expect(sample.powerWatts).toBe(210);
    });

    it('computes physiologically accurate calories for cycling power without 3.6x inflation', () => {
      // 1 hour (3600 seconds) at 200W mechanical work
      // Mechanical work = 200W * 3600s = 720 kJ
      // At ~24% human gross efficiency, 1 kJ mechanical work ~ 1 kcal metabolic expenditure (~720 kcal)
      const summary = summarizeIndoorSession(WorkoutType.BIKE, [], {
        durationSeconds: 3600,
        averagePowerWatts: 200,
        distanceMeters: 32000,
      });

      expect(summary.estimatedCalories).toBe(720);
    });

    it('preserves accumulated distance when machine odometer appears after initial speed integration', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // For seconds 1 to 3, console transmits 36 km/h (10 m/s) with no odometer
      for (let sec = 1; sec <= 3; sec++) {
        accumulator.ingestSample({ speedKmh: 36 });
        accumulator.tickOneSecond();
      }
      // 3 seconds at 10 m/s = 30 meters
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(30);

      // At second 4, machine odometer appears reporting 5000m (first appearance)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5000 });
      accumulator.tickOneSecond();
      // Distance must NOT drop to 0; it should smoothly preserve the 30m already covered
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(30);

      // At second 5, machine odometer advances to 5010m (+10m)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5010 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(40);
    });

    it('seamlessly handles mid-session odometer reset or wrap-around', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5000 });
      accumulator.tickOneSecond();
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 5050 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(50);

      // Console restarts its odometer to 0 mid-session
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 0 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(50);

      // Odometer advances from 0 to 20m
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 20 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(70);
    });

    it('resets latestTelemetry baseline on start to prevent previous session speed leaking', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();
      accumulator.ingestSample({ speedKmh: 35.0, cadenceRpm: 90, powerWatts: 250 });
      accumulator.tickOneSecond();
      accumulator.finish();

      // Start new session without calling reset()
      accumulator.start();
      const live = accumulator.getLiveMetrics();
      expect(live.speedKmh).toBe(0);
      expect(live.cadenceRpm).toBe(0);
      expect(live.powerWatts).toBe(0);
      expect(live.distanceMeters).toBe(0);

      // Tick 1s with no samples; distance must stay 0 (no ghost integration from 35 km/h)
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(0);
    });

    it('clears modality-specific metrics when switching between Bike and Treadmill', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();
      accumulator.ingestSample({ speedKmh: 30, powerWatts: 220, cadenceRpm: 92 });

      // Switch to Treadmill
      accumulator.setEquipmentType(WorkoutType.TREADMILL);
      const treadMetrics = accumulator.getLiveMetrics();
      expect(treadMetrics.cadenceRpm).toBe(0);
      expect(treadMetrics.powerWatts).toBe(0);

      // Ingest treadmill incline
      accumulator.ingestSample({ speedKmh: 12, inclinePercent: 3.0 });
      expect(accumulator.getLiveMetrics().inclinePercent).toBe(3.0);

      // Switch back to Bike
      accumulator.setEquipmentType(WorkoutType.BIKE);
      expect(accumulator.getLiveMetrics().inclinePercent).toBe(0);
    });

    it('estimates realistic virtual cycling speed from power when cadence and speed are omitted', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      accumulator.ingestSample({
        speedKmh: 0,
        cadenceRpm: 0,
        powerWatts: 200,
      });

      const live = accumulator.getLiveMetrics();
      // Realistic road speed for 200W on a bicycle is ~33-35 km/h (not 13.2 km/h)
      expect(live.speedKmh).toBeGreaterThan(32.0);
      expect(live.speedKmh).toBeLessThan(36.0);
    });

    it('filters corrupted or null elements from local storage without throwing', () => {
      (globalThis as any).localStorage.setItem(
        'garmin_trainer_matrix_sessions_v1',
        JSON.stringify([
          null,
          {},
          { id: 'partial-no-summary' },
          { id: 'bad-summary', summary: {} },
          { id: 'bad-types', summary: { durationSeconds: 'not-a-number' } },
        ])
      );
      const loaded = loadSavedMatrixSessions();
      expect(loaded).toEqual([]);
    });

    it('seamlessly preserves session distance when machine odometer resets or wraps to a value greater than initial odometer', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Initial machine distance is 100m
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 100 });
      accumulator.tickOneSecond();

      // After 10km ride, machine odometer is 10100m (session distance = 10000m)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 10100 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(10000);

      // Console resets/wraps around to 500m (which is GREATER than initial 100m)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 500 });
      accumulator.tickOneSecond();
      // Distance must NOT collapse to 400m; it should stay 10000m
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(10000);

      // Odometer increments to 520m (+20m)
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 520 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(10020);
    });

    it('integrates speed distance during gaps where intermittent machine packets omit distance', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      // Sec 1: machine sends odometer 1000m
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 1000 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(0);

      // Sec 2: packet arrives with speed 36 km/h (10 m/s) but NO distance
      accumulator.ingestSample({ speedKmh: 36 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(10);

      // Sec 3: packet arrives with speed 36 km/h but NO distance
      accumulator.ingestSample({ speedKmh: 36 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(20);

      // Sec 4: machine odometer packet arrives with 1030m
      accumulator.ingestSample({ speedKmh: 36, distanceMeters: 1030 });
      accumulator.tickOneSecond();
      expect(accumulator.getLiveMetrics().distanceMeters).toBe(30);
    });

    it('retains saved sessions in in-memory storage fallback when localStorage is unavailable', () => {
      delete (globalThis as any).localStorage;
      clearSavedMatrixSessions();

      const mockSession: SavedMatrixSession = {
        id: 'in-memory-session-1',
        savedAt: new Date().toISOString(),
        equipmentType: WorkoutType.BIKE,
        deviceName: 'Matrix Bike Standalone',
        summary: {
          equipmentType: WorkoutType.BIKE,
          durationSeconds: 600,
          distanceMeters: 5000,
          averageSpeedKmh: 30.0,
          averagePowerWatts: 210,
          maxPowerWatts: 250,
          averageCadenceRpm: 90,
          averageHeartRateBpm: 150,
          maxHeartRateBpm: 165,
          averageInclinePercent: null,
          estimatedCalories: 126,
        },
        samplesCount: 600,
      };

      const updated = saveMatrixSessionToStorage(mockSession);
      expect(updated).toHaveLength(1);

      const retrieved = loadSavedMatrixSessions();
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].id).toBe('in-memory-session-1');
      expect(retrieved[0].summary.averagePowerWatts).toBe(210);

      clearSavedMatrixSessions();
      expect(loadSavedMatrixSessions()).toHaveLength(0);
    });

    it('safely handles non-finite (NaN, Infinity, negative) inputs in formatDuration and formatDistanceKm', () => {
      expect(formatDuration(NaN)).toBe('00:00');
      expect(formatDuration(Infinity)).toBe('00:00');
      expect(formatDuration(-120)).toBe('00:00');
      expect(formatDuration(3600)).toBe('1:00:00');

      expect(formatDistanceKm(NaN)).toBe('0.00 km');
      expect(formatDistanceKm(Infinity)).toBe('0.00 km');
      expect(formatDistanceKm(-500)).toBe('0.00 km');
      expect(formatDistanceKm(5250)).toBe('5.25 km');
    });

    it('records power output on treadmill when machine transmits Bit 12 power in FTMS 0x2ACD frame', () => {
      const accumulator = new MatrixSessionAccumulator(WorkoutType.TREADMILL);
      accumulator.start();

      accumulator.ingestSample({
        speedKmh: 12.0,
        inclinePercent: 2.0,
        powerWatts: 220,
      });
      const tick = accumulator.tickOneSecond();
      expect(tick).not.toBeNull();
      expect(tick!.sample.powerWatts).toBe(220);
      expect(accumulator.getSamples()[0].powerWatts).toBe(220);
    });
  });
});
