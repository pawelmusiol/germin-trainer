import { WorkoutType } from './types';

export const FTMS_SERVICE_UUID = '00001826-0000-1000-8000-00805f9b34fb';
export const INDOOR_BIKE_DATA_CHAR_UUID = '00002ad2-0000-1000-8000-00805f9b34fb';
export const TREADMILL_DATA_CHAR_UUID = '00002acd-0000-1000-8000-00805f9b34fb';
export const CYCLING_POWER_SERVICE_UUID = '00001818-0000-1000-8000-00805f9b34fb';

export interface MatrixIndoorSample {
  timestampOffsetSeconds: number;
  speedKmh: number;
  cadenceRpm?: number;
  powerWatts?: number;
  inclinePercent?: number;
  distanceMeters?: number;
  heartRateBpm?: number;
}

export interface MatrixSessionSummary {
  equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL;
  durationSeconds: number;
  distanceMeters: number;
  averageSpeedKmh: number;
  averagePowerWatts: number | null;
  maxPowerWatts: number | null;
  averageCadenceRpm: number | null;
  averageHeartRateBpm: number | null;
  maxHeartRateBpm: number | null;
  averageInclinePercent: number | null;
  estimatedCalories: number;
}

/**
 * Encodes a Matrix Indoor Bike telemetry sample into an official Bluetooth SIG
 * GATT FTMS Indoor Bike Data (0x2AD2) binary packet (Uint8Array).
 *
 * Flags set:
 * - Bit 0 = 0 (Instantaneous Speed present, uint16, 0.01 km/h)
 * - Bit 2 = 1 (Instantaneous Cadence present, uint16, 0.5 RPM)
 * - Bit 4 = 1 (Total Distance present, uint24, 1 meter)
 * - Bit 6 = 1 (Instantaneous Power present, sint16, 1 Watt)
 * - Bit 9 = 1 (Heart Rate present, uint8, 1 BPM)
 */
export function encodeIndoorBikeDataFrame(sample: {
  speedKmh: number;
  cadenceRpm: number;
  distanceMeters: number;
  powerWatts: number;
  heartRateBpm?: number;
}): Uint8Array {
  const hasHr = typeof sample.heartRateBpm === 'number' && sample.heartRateBpm > 0;
  // Bit 2 (4) | Bit 4 (16) | Bit 6 (64) | optional Bit 9 (512)
  const flags = (1 << 2) | (1 << 4) | (1 << 6) | (hasHr ? 1 << 9 : 0);
  const length = 2 + 2 + 2 + 3 + 2 + (hasHr ? 1 : 0);
  const buf = new Uint8Array(length);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint16(offset, flags, true);
  offset += 2;

  // Instantaneous Speed (0.01 km/h)
  const rawSpeed = Math.max(0, Math.round(sample.speedKmh * 100));
  view.setUint16(offset, rawSpeed, true);
  offset += 2;

  // Instantaneous Cadence (0.5 RPM)
  const rawCadence = Math.max(0, Math.round(sample.cadenceRpm * 2));
  view.setUint16(offset, rawCadence, true);
  offset += 2;

  // Total Distance (uint24 little-endian, meters)
  const dist = Math.max(0, Math.round(sample.distanceMeters));
  buf[offset] = dist & 0xff;
  buf[offset + 1] = (dist >> 8) & 0xff;
  buf[offset + 2] = (dist >> 16) & 0xff;
  offset += 3;

  // Instantaneous Power (sint16, Watts)
  const watts = Math.max(0, Math.round(sample.powerWatts));
  view.setInt16(offset, watts, true);
  offset += 2;

  if (hasHr) {
    buf[offset] = Math.min(255, Math.max(30, Math.round(sample.heartRateBpm!)));
  }

  return buf;
}

/**
 * Parses a Bluetooth SIG GATT FTMS Indoor Bike Data (0x2AD2) binary packet
 * transmitted by a Matrix stationary bike console.
 */
export function parseIndoorBikeDataFrame(
  packet: Uint8Array,
  timestampOffsetSeconds: number = 0
): MatrixIndoorSample {
  if (!packet || packet.byteLength < 4) {
    throw new Error('Invalid FTMS Indoor Bike Data packet: minimum 4 bytes required');
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint16(0, true);
  let offset = 2;

  let speedKmh = 0;
  let cadenceRpm: number | undefined;
  let distanceMeters: number | undefined;
  let powerWatts: number | undefined;
  let heartRateBpm: number | undefined;

  // Bit 0: More Data (0 means Instantaneous Speed is present)
  if ((flags & (1 << 0)) === 0 && offset + 2 <= packet.byteLength) {
    speedKmh = Number((view.getUint16(offset, true) / 100).toFixed(2));
    offset += 2;
  }

  // Bit 1: Average Speed present
  if ((flags & (1 << 1)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 2: Instantaneous Cadence present (0.5 RPM resolution)
  if ((flags & (1 << 2)) !== 0 && offset + 2 <= packet.byteLength) {
    cadenceRpm = Math.round(view.getUint16(offset, true) / 2);
    offset += 2;
  }

  // Bit 3: Average Cadence present
  if ((flags & (1 << 3)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 4: Total Distance present (uint24, meters)
  if ((flags & (1 << 4)) !== 0 && offset + 3 <= packet.byteLength) {
    distanceMeters =
      packet[offset] | (packet[offset + 1] << 8) | (packet[offset + 2] << 16);
    offset += 3;
  }

  // Bit 5: Resistance Level present (sint16)
  if ((flags & (1 << 5)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 6: Instantaneous Power present (sint16, Watts)
  if ((flags & (1 << 6)) !== 0 && offset + 2 <= packet.byteLength) {
    powerWatts = view.getInt16(offset, true);
    offset += 2;
  }

  // Bit 7: Average Power present (sint16)
  if ((flags & (1 << 7)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 8: Expended Energy present (total uint16 + per hour uint16 + per min uint8 = 5 bytes)
  if ((flags & (1 << 8)) !== 0 && offset + 5 <= packet.byteLength) {
    offset += 5;
  }

  // Bit 9: Heart Rate present (uint8, BPM)
  if ((flags & (1 << 9)) !== 0 && offset + 1 <= packet.byteLength) {
    heartRateBpm = packet[offset];
    offset += 1;
  }

  return {
    timestampOffsetSeconds,
    speedKmh,
    cadenceRpm,
    distanceMeters,
    powerWatts,
    heartRateBpm,
  };
}

/**
 * Encodes a Matrix Treadmill telemetry sample into an official Bluetooth SIG
 * GATT FTMS Treadmill Data (0x2ACD) binary packet.
 */
export function encodeTreadmillDataFrame(sample: {
  speedKmh: number;
  distanceMeters: number;
  inclinePercent: number;
  heartRateBpm?: number;
  powerWatts?: number;
}): Uint8Array {
  const hasHr = typeof sample.heartRateBpm === 'number' && sample.heartRateBpm > 0;
  const hasPower = typeof sample.powerWatts === 'number' && sample.powerWatts > 0;
  // Bit 2 (Total Distance = 4) | Bit 3 (Inclination & Ramp Angle = 8) | optional Bit 8 (Heart Rate = 256) | optional Bit 12 (Force & Power = 4096)
  const flags = (1 << 2) | (1 << 3) | (hasHr ? 1 << 8 : 0) | (hasPower ? 1 << 12 : 0);
  const length = 2 + 2 + 3 + 4 + (hasHr ? 1 : 0) + (hasPower ? 4 : 0);
  const buf = new Uint8Array(length);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint16(offset, flags, true);
  offset += 2;

  // Instantaneous Speed (0.01 km/h)
  view.setUint16(offset, Math.max(0, Math.round(sample.speedKmh * 100)), true);
  offset += 2;

  // Total Distance (uint24, meters)
  const dist = Math.max(0, Math.round(sample.distanceMeters));
  buf[offset] = dist & 0xff;
  buf[offset + 1] = (dist >> 8) & 0xff;
  buf[offset + 2] = (dist >> 16) & 0xff;
  offset += 3;

  // Inclination (0.1 %) + Ramp Angle (0.1 deg)
  const rawIncline = Math.round(sample.inclinePercent * 10);
  view.setInt16(offset, rawIncline, true);
  view.setInt16(offset + 2, rawIncline, true);
  offset += 4;

  if (hasHr) {
    buf[offset] = Math.min(255, Math.max(30, Math.round(sample.heartRateBpm!)));
    offset += 1;
  }

  if (hasPower) {
    // Force on Belt (sint16 = 0) + Power Output (sint16 Watts)
    view.setInt16(offset, 0, true);
    view.setInt16(offset + 2, Math.round(sample.powerWatts!), true);
    offset += 4;
  }

  return buf;
}

/**
 * Parses a Bluetooth SIG GATT FTMS Treadmill Data (0x2ACD) binary packet
 * transmitted by a Matrix treadmill console.
 */
export function parseTreadmillDataFrame(
  packet: Uint8Array,
  timestampOffsetSeconds: number = 0
): MatrixIndoorSample {
  if (!packet || packet.byteLength < 4) {
    throw new Error('Invalid FTMS Treadmill Data packet: minimum 4 bytes required');
  }

  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const flags = view.getUint16(0, true);
  let offset = 2;

  let speedKmh = 0;
  let distanceMeters: number | undefined;
  let inclinePercent: number | undefined;
  let heartRateBpm: number | undefined;
  let powerWatts: number | undefined;

  // Bit 0: More Data (0 = Instantaneous Speed present, 0.01 km/h)
  if ((flags & (1 << 0)) === 0 && offset + 2 <= packet.byteLength) {
    speedKmh = Number((view.getUint16(offset, true) / 100).toFixed(2));
    offset += 2;
  }

  // Bit 1: Average Speed present (uint16)
  if ((flags & (1 << 1)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 2: Total Distance present (uint24)
  if ((flags & (1 << 2)) !== 0 && offset + 3 <= packet.byteLength) {
    distanceMeters =
      packet[offset] | (packet[offset + 1] << 8) | (packet[offset + 2] << 16);
    offset += 3;
  }

  // Bit 3: Inclination & Ramp Angle present (2x sint16)
  if ((flags & (1 << 3)) !== 0 && offset + 4 <= packet.byteLength) {
    inclinePercent = Number((view.getInt16(offset, true) / 10).toFixed(1));
    offset += 4;
  }

  // Bit 4: Elevation Gain present (2x sint16 = 4 bytes)
  if ((flags & (1 << 4)) !== 0 && offset + 4 <= packet.byteLength) {
    offset += 4;
  }

  // Bit 5: Instantaneous Pace present (uint8 = 1 byte)
  if ((flags & (1 << 5)) !== 0 && offset + 1 <= packet.byteLength) {
    offset += 1;
  }

  // Bit 6: Average Pace present (uint8 = 1 byte)
  if ((flags & (1 << 6)) !== 0 && offset + 1 <= packet.byteLength) {
    offset += 1;
  }

  // Bit 7: Expended Energy present (uint16 + uint16 + uint8 = 5 bytes)
  if ((flags & (1 << 7)) !== 0 && offset + 5 <= packet.byteLength) {
    offset += 5;
  }

  // Bit 8: Heart Rate present (uint8)
  if ((flags & (1 << 8)) !== 0 && offset + 1 <= packet.byteLength) {
    heartRateBpm = packet[offset];
    offset += 1;
  }

  // Bit 9: Metabolic Equivalent present (uint8)
  if ((flags & (1 << 9)) !== 0 && offset + 1 <= packet.byteLength) {
    offset += 1;
  }

  // Bit 10: Elapsed Time present (uint16)
  if ((flags & (1 << 10)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 11: Remaining Time present (uint16)
  if ((flags & (1 << 11)) !== 0 && offset + 2 <= packet.byteLength) {
    offset += 2;
  }

  // Bit 12: Force on Belt & Power Output present (sint16 force + sint16 power = 4 bytes)
  if ((flags & (1 << 12)) !== 0 && offset + 4 <= packet.byteLength) {
    const power = view.getInt16(offset + 2, true);
    if (power > 0) {
      powerWatts = power;
    }
    offset += 4;
  }

  return {
    timestampOffsetSeconds,
    speedKmh,
    distanceMeters,
    inclinePercent,
    heartRateBpm,
    powerWatts,
  };
}

/**
 * Aggregates recorded live BLE samples (or manual fallback inputs) into a session summary.
 */
export function summarizeIndoorSession(
  equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL,
  samples: MatrixIndoorSample[],
  manualOverride?: {
    durationSeconds?: number;
    distanceMeters?: number;
    averagePowerWatts?: number;
    averageHeartRateBpm?: number;
    averageCadenceRpm?: number;
    averageInclinePercent?: number;
  }
): MatrixSessionSummary {
  const count = samples.length;

  const durationSeconds =
    manualOverride?.durationSeconds ??
    (count > 0
      ? samples[count - 1].timestampOffsetSeconds > 0
        ? samples[count - 1].timestampOffsetSeconds
        : count
      : 0);

  let totalSpeed = 0;
  let powerSum = 0;
  let powerCount = 0;
  let maxPower: number | null = null;
  let cadenceSum = 0;
  let cadenceCount = 0;
  let hrSum = 0;
  let hrCount = 0;
  let maxHr: number | null = null;
  let inclineSum = 0;
  let inclineCount = 0;
  let maxDistance = 0;

  for (const s of samples) {
    totalSpeed += s.speedKmh || 0;
    if (typeof s.powerWatts === 'number') {
      powerSum += s.powerWatts;
      powerCount++;
      if (maxPower === null || s.powerWatts > maxPower) maxPower = s.powerWatts;
    }
    if (typeof s.cadenceRpm === 'number' && s.cadenceRpm > 0) {
      cadenceSum += s.cadenceRpm;
      cadenceCount++;
    }
    if (typeof s.heartRateBpm === 'number' && s.heartRateBpm > 0) {
      hrSum += s.heartRateBpm;
      hrCount++;
      if (maxHr === null || s.heartRateBpm > maxHr) maxHr = s.heartRateBpm;
    }
    if (typeof s.inclinePercent === 'number') {
      inclineSum += s.inclinePercent;
      inclineCount++;
    }
    if (typeof s.distanceMeters === 'number' && s.distanceMeters > maxDistance) {
      maxDistance = s.distanceMeters;
    }
  }

  const averagePowerWatts =
    manualOverride?.averagePowerWatts ??
    (powerCount > 0 ? Math.round(powerSum / powerCount) : null);

  const maxPowerWatts =
    powerCount > 0 ? (maxPower !== null ? maxPower : averagePowerWatts) : null;

  const averageCadenceRpm =
    manualOverride?.averageCadenceRpm ??
    (cadenceCount > 0 ? Math.round(cadenceSum / cadenceCount) : null);

  const averageHeartRateBpm =
    manualOverride?.averageHeartRateBpm ??
    (hrCount > 0 ? Math.round(hrSum / hrCount) : null);

  const maxHeartRateBpm =
    hrCount > 0 ? (maxHr !== null ? maxHr : averageHeartRateBpm) : null;

  const averageInclinePercent =
    manualOverride?.averageInclinePercent ??
    (inclineCount > 0 ? Number((inclineSum / inclineCount).toFixed(1)) : null);

  const avgSpeedFromSamples = count > 0 ? totalSpeed / count : 0;
  const distanceMeters =
    manualOverride?.distanceMeters ??
    (maxDistance > 0
      ? maxDistance
      : Math.round((avgSpeedFromSamples * 1000 * durationSeconds) / 3600));

  const averageSpeedKmh =
    durationSeconds > 0
      ? Number(((distanceMeters / 1000) / (durationSeconds / 3600)).toFixed(1))
      : 0;

  // Estimate calories burned (from mechanical work in Watts or running distance: 1 kJ ~ 1 kcal metabolic expenditure at cycling gross efficiency)
  const estimatedCalories =
    averagePowerWatts !== null && averagePowerWatts > 0
      ? Math.round((averagePowerWatts * durationSeconds) / 1000)
      : Math.round((distanceMeters / 1000) * 68);

  return {
    equipmentType,
    durationSeconds,
    distanceMeters,
    averageSpeedKmh,
    averagePowerWatts,
    maxPowerWatts,
    averageCadenceRpm,
    averageHeartRateBpm,
    maxHeartRateBpm,
    averageInclinePercent,
    estimatedCalories,
  };
}

export type SessionLifecycleState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'FINISHED';

export interface MatrixLiveMetrics {
  powerWatts: number;
  cadenceRpm: number;
  speedKmh: number;
  distanceMeters: number;
  heartRateBpm: number;
  inclinePercent: number;
  elapsedSeconds: number;
}

export interface SavedMatrixSession {
  id: string;
  savedAt: string;
  equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL;
  deviceName?: string;
  summary: MatrixSessionSummary;
  samplesCount: number;
}

/**
 * Manages 1-second telemetry data accumulation and session lifecycle
 * for Matrix BLE indoor equipment (Bike 0x2AD2 / Treadmill 0x2ACD).
 */
export class MatrixSessionAccumulator {
  private equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL;
  private state: SessionLifecycleState = 'IDLE';
  private elapsedSeconds: number = 0;
  private samples: MatrixIndoorSample[] = [];

  // Track odometer offset from machine to calculate delta session distance
  private initialMachineDistance: number | null = null;
  private lastMachineDistance: number | null = null;
  private pauseMachineDistance: number | null = null;
  private sessionDistanceMeters: number = 0;
  private hasReceivedPower: boolean = false;
  private odometerUpdatedThisTick: boolean = false;

  private latestTelemetry: MatrixLiveMetrics = {
    powerWatts: 0,
    cadenceRpm: 0,
    speedKmh: 0,
    distanceMeters: 0,
    heartRateBpm: 0,
    inclinePercent: 0,
    elapsedSeconds: 0,
  };

  constructor(equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL = WorkoutType.BIKE) {
    this.equipmentType = equipmentType;
  }

  public getEquipmentType(): WorkoutType.BIKE | WorkoutType.TREADMILL {
    return this.equipmentType;
  }

  public setEquipmentType(equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL): void {
    if (this.equipmentType !== equipmentType) {
      this.equipmentType = equipmentType;
      if (equipmentType === WorkoutType.TREADMILL) {
        this.latestTelemetry.cadenceRpm = 0;
        this.latestTelemetry.powerWatts = 0;
        this.hasReceivedPower = false;
      } else {
        this.latestTelemetry.inclinePercent = 0;
      }
    }
  }

  public getState(): SessionLifecycleState {
    return this.state;
  }

  public getElapsedSeconds(): number {
    return this.elapsedSeconds;
  }

  public getSamples(): MatrixIndoorSample[] {
    return [...this.samples];
  }

  public getLiveMetrics(): MatrixLiveMetrics {
    let speed = this.latestTelemetry.speedKmh;
    if (speed <= 0 && this.equipmentType === WorkoutType.BIKE) {
      if (this.latestTelemetry.cadenceRpm > 0) {
        speed = Number((this.latestTelemetry.cadenceRpm * 0.35).toFixed(2));
      } else if (this.latestTelemetry.powerWatts > 0) {
        // Cycling aerodynamics: P = 0.5 * rho * CdA * v^3 where 0.5*rho*CdA ~ 0.22 - 0.25
        speed = Number(
          Math.max(5.0, Math.min(60.0, Math.pow(this.latestTelemetry.powerWatts / 0.25, 1 / 3) * 3.6)).toFixed(2)
        );
      }
    }

    return {
      ...this.latestTelemetry,
      speedKmh: speed,
      distanceMeters: Math.round(this.sessionDistanceMeters),
      elapsedSeconds: this.elapsedSeconds,
    };
  }

  /**
   * Starts a new session or resets for a new session.
   */
  public start(): void {
    this.state = 'RECORDING';
    this.elapsedSeconds = 0;
    this.samples = [];
    this.initialMachineDistance = null;
    this.lastMachineDistance = null;
    this.pauseMachineDistance = null;
    this.sessionDistanceMeters = 0;
    this.hasReceivedPower = false;
    this.odometerUpdatedThisTick = false;
    this.latestTelemetry = {
      powerWatts: 0,
      cadenceRpm: 0,
      speedKmh: 0,
      distanceMeters: 0,
      heartRateBpm: 0,
      inclinePercent: 0,
      elapsedSeconds: 0,
    };
  }

  public pause(): void {
    if (this.state === 'RECORDING') {
      this.state = 'PAUSED';
      this.pauseMachineDistance = this.lastMachineDistance;
    }
  }

  public resume(): void {
    if (this.state === 'PAUSED') {
      this.state = 'RECORDING';
      // Compensate for any machine odometer distance accumulated while paused
      if (
        this.pauseMachineDistance !== null &&
        this.lastMachineDistance !== null &&
        this.initialMachineDistance !== null
      ) {
        if (this.lastMachineDistance >= this.pauseMachineDistance) {
          this.initialMachineDistance += (this.lastMachineDistance - this.pauseMachineDistance);
        } else {
          // Odometer reset or wrapped around while paused: re-anchor to preserved session distance
          this.initialMachineDistance = this.lastMachineDistance - this.sessionDistanceMeters;
        }
      }
      this.pauseMachineDistance = null;
      this.odometerUpdatedThisTick = false;
    }
  }

  public reset(): void {
    this.state = 'IDLE';
    this.elapsedSeconds = 0;
    this.samples = [];
    this.initialMachineDistance = null;
    this.lastMachineDistance = null;
    this.pauseMachineDistance = null;
    this.sessionDistanceMeters = 0;
    this.hasReceivedPower = false;
    this.odometerUpdatedThisTick = false;
    this.latestTelemetry = {
      powerWatts: 0,
      cadenceRpm: 0,
      speedKmh: 0,
      distanceMeters: 0,
      heartRateBpm: 0,
      inclinePercent: 0,
      elapsedSeconds: 0,
    };
  }

  /**
   * Decodes a raw binary FTMS GATT characteristic frame (0x2AD2 for Bike, 0x2ACD for Treadmill)
   * using parseIndoorBikeDataFrame or parseTreadmillDataFrame.
   */
  public ingestRawPacket(packet: Uint8Array): MatrixIndoorSample {
    const parsed =
      this.equipmentType === WorkoutType.BIKE
        ? parseIndoorBikeDataFrame(packet, this.elapsedSeconds)
        : parseTreadmillDataFrame(packet, this.elapsedSeconds);

    this.ingestSample(parsed);
    return parsed;
  }

  /**
   * Ingests a decoded sample. Updates latest live telemetry and handles odometer distance offset.
   */
  public ingestSample(sample: Partial<MatrixIndoorSample>): void {
    if (typeof sample.powerWatts === 'number') {
      this.latestTelemetry.powerWatts = sample.powerWatts;
      this.hasReceivedPower = true;
    }
    if (typeof sample.cadenceRpm === 'number') {
      this.latestTelemetry.cadenceRpm = sample.cadenceRpm;
    }
    if (typeof sample.speedKmh === 'number') {
      this.latestTelemetry.speedKmh = sample.speedKmh;
    }
    if (typeof sample.heartRateBpm === 'number') {
      this.latestTelemetry.heartRateBpm = sample.heartRateBpm;
    }
    if (typeof sample.inclinePercent === 'number') {
      this.latestTelemetry.inclinePercent = sample.inclinePercent;
    }

    // Distance tracking:
    if (typeof sample.distanceMeters === 'number') {
      const prevMachineDistance = this.lastMachineDistance;
      this.lastMachineDistance = sample.distanceMeters;

      if (this.state === 'RECORDING') {
        this.odometerUpdatedThisTick = true;
        if (
          this.initialMachineDistance === null ||
          (prevMachineDistance !== null && sample.distanceMeters < prevMachineDistance)
        ) {
          // First machine odometer packet OR machine odometer reset/wrapped around mid-session
          this.initialMachineDistance = sample.distanceMeters - this.sessionDistanceMeters;
        }
        this.sessionDistanceMeters = sample.distanceMeters - this.initialMachineDistance;
      }
    }
  }

  /**
   * 1-second live interval tick. Called every 1000ms.
   * If state === 'RECORDING':
   *  - increments elapsedSeconds by 1
   *  - integrates distance from speed if machine odometer is absent
   *  - records a 1-second sample into the session history
   */
  public tickOneSecond(): { elapsedSeconds: number; sample: MatrixIndoorSample } | null {
    if (this.state !== 'RECORDING') {
      return null;
    }

    this.elapsedSeconds += 1;

    // Fallback speed calculation if console transmits power/cadence without speed
    let effectiveSpeedKmh = this.latestTelemetry.speedKmh;
    if (effectiveSpeedKmh <= 0 && this.equipmentType === WorkoutType.BIKE) {
      if (this.latestTelemetry.cadenceRpm > 0) {
        effectiveSpeedKmh = Number((this.latestTelemetry.cadenceRpm * 0.35).toFixed(2));
      } else if (this.latestTelemetry.powerWatts > 0) {
        effectiveSpeedKmh = Number(
          Math.max(5.0, Math.min(60.0, Math.pow(this.latestTelemetry.powerWatts / 0.25, 1 / 3) * 3.6)).toFixed(2)
        );
      }
    }

    // If machine odometer distance wasn't received during this 1-second tick, integrate from speed (km/h -> m/s)
    if (!this.odometerUpdatedThisTick && effectiveSpeedKmh > 0) {
      this.sessionDistanceMeters += (effectiveSpeedKmh * 1000) / 3600;
    }
    this.odometerUpdatedThisTick = false;

    const sample: MatrixIndoorSample = {
      timestampOffsetSeconds: this.elapsedSeconds,
      speedKmh: Number(effectiveSpeedKmh.toFixed(2)),
      cadenceRpm:
        this.equipmentType === WorkoutType.BIKE ? this.latestTelemetry.cadenceRpm : undefined,
      powerWatts:
        this.hasReceivedPower && typeof this.latestTelemetry.powerWatts === 'number' && this.latestTelemetry.powerWatts >= 0
          ? this.latestTelemetry.powerWatts
          : undefined,
      inclinePercent:
        this.equipmentType === WorkoutType.TREADMILL
          ? this.latestTelemetry.inclinePercent
          : undefined,
      distanceMeters: Math.round(this.sessionDistanceMeters),
      heartRateBpm:
        this.latestTelemetry.heartRateBpm > 0 ? this.latestTelemetry.heartRateBpm : undefined,
    };

    this.samples.push(sample);

    return {
      elapsedSeconds: this.elapsedSeconds,
      sample,
    };
  }

  /**
   * Finishes the session, aggregates metrics, and returns the MatrixSessionSummary.
   */
  public finish(): MatrixSessionSummary {
    this.state = 'FINISHED';

    const summary = summarizeIndoorSession(this.equipmentType, this.samples, {
      durationSeconds: this.elapsedSeconds,
      distanceMeters: Math.round(this.sessionDistanceMeters),
    });

    return summary;
  }
}

/**
 * Formats duration in seconds to mm:ss or hh:mm:ss.
 */
export function formatDuration(seconds: number): string {
  const safeSec = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds || 0)) : 0;
  const hrs = Math.floor(safeSec / 3600);
  const mins = Math.floor((safeSec % 3600) / 60);
  const secs = safeSec % 60;

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Formats distance in meters to a readable kilometer string (e.g. "12.45 km").
 */
export function formatDistanceKm(meters: number): string {
  const km = Number.isFinite(meters) ? Math.max(0, meters || 0) / 1000 : 0;
  return `${km.toFixed(2)} km`;
}

export const MATRIX_SESSIONS_STORAGE_KEY = 'garmin_trainer_matrix_sessions_v1';

// In-memory fallback store for native mobile / non-browser environments where localStorage is absent
const inMemoryMatrixStorage: Record<string, string> = {};

function getMatrixStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  try {
    const storage = (globalThis as any)?.localStorage;
    if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
      return storage;
    }
  } catch {
    // fallback to in-memory
  }
  return {
    getItem: (key: string) => inMemoryMatrixStorage[key] || null,
    setItem: (key: string, value: string) => {
      inMemoryMatrixStorage[key] = String(value);
    },
    removeItem: (key: string) => {
      delete inMemoryMatrixStorage[key];
    },
  };
}

/**
 * Loads persisted Matrix BLE session summaries from local storage (or in-memory fallback).
 */
export function loadSavedMatrixSessions(): SavedMatrixSession[] {
  try {
    const storage = getMatrixStorage();
    const data = storage.getItem(MATRIX_SESSIONS_STORAGE_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is SavedMatrixSession =>
            Boolean(
              item &&
              typeof item === 'object' &&
              typeof item.id === 'string' &&
              item.summary &&
              typeof item.summary === 'object' &&
              typeof item.summary.durationSeconds === 'number' &&
              typeof item.summary.distanceMeters === 'number'
            )
        );
      }
      return [];
    }
  } catch {
    // Graceful fallback for non-browser / mock environments
  }
  return [];
}

/**
 * Persists a completed Matrix session summary into local storage (or in-memory fallback).
 */
export function saveMatrixSessionToStorage(session: SavedMatrixSession): SavedMatrixSession[] {
  const current = loadSavedMatrixSessions();
  const updated = [session, ...current.filter((s) => s.id !== session.id)];
  try {
    const storage = getMatrixStorage();
    storage.setItem(MATRIX_SESSIONS_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Graceful fallback
  }
  return updated;
}

/**
 * Clears saved Matrix session summaries from local storage (or in-memory fallback).
 */
export function clearSavedMatrixSessions(): void {
  try {
    const storage = getMatrixStorage();
    storage.removeItem(MATRIX_SESSIONS_STORAGE_KEY);
  } catch {
    // Graceful fallback
  }
}
