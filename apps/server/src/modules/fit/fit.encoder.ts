import {
  MatrixIndoorSample,
  MatrixSessionSummary,
  WorkoutType,
} from '@garmin-trainer/shared';

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0); // Garmin FIT epoch: 1989-12-31T00:00:00Z

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/**
 * Computes the official Garmin ANT+ FIT 16-bit CRC checksum over a byte buffer.
 */
export function calculateFitCrc16(buffer: Uint8Array, length: number = buffer.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    const byte = buffer[i];
    // Lower nibble
    let tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0x0f];
    // Upper nibble
    tmp = CRC_TABLE[crc & 0x0f];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0x0f];
  }
  return crc & 0xffff;
}

export interface FitHeaderInfo {
  headerSize: number;
  protocolVersion: number;
  profileVersion: number;
  dataSize: number;
  signature: string;
  headerCrc: number;
  fileCrc: number;
  crcValid: boolean;
}

/**
 * Encodes an indoor Matrix Bike or Matrix Treadmill workout session into a valid binary
 * Garmin ANT+ .FIT Activity file ready for upload to Garmin Connect.
 */
export function encodeMatrixSessionToFit(
  summary: MatrixSessionSummary,
  samples: MatrixIndoorSample[] = [],
  startTime: Date = new Date()
): Buffer {
  const startFitTimestamp = Math.max(
    0,
    Math.floor((startTime.getTime() - FIT_EPOCH_MS) / 1000)
  );

  const chunks: Buffer[] = [];

  // 1. Definition Message for file_id (Local Msg 0, Global Msg 0)
  // Fields: type (0, enum=1B), manufacturer (1, uint16=2B), time_created (4, uint32=4B)
  const fileIdDef = Buffer.from([
    0x40, // Definition header, local msg 0
    0x00, // Reserved
    0x00, // Little-endian
    0x00, 0x00, // Global Msg 0 (file_id)
    0x03, // 3 fields
    0x00, 0x01, 0x00, // Field 0: type (enum)
    0x01, 0x02, 0x84, // Field 1: manufacturer (uint16)
    0x04, 0x04, 0x86, // Field 4: time_created (uint32)
  ]);
  chunks.push(fileIdDef);

  const fileIdData = Buffer.alloc(1 + 1 + 2 + 4);
  fileIdData.writeUInt8(0x00, 0); // Data header, local msg 0
  fileIdData.writeUInt8(4, 1); // type = 4 (Activity)
  fileIdData.writeUInt16LE(1, 2); // manufacturer = 1 (Garmin)
  fileIdData.writeUInt32LE(startFitTimestamp, 4);
  chunks.push(fileIdData);

  // 2. Definition Message for record (Local Msg 1, Global Msg 20)
  // Fields: timestamp (253, uint32=4B), distance (5, uint32=4B in 100*m), speed (6, uint16=2B in 1000*m/s),
  // power (7, uint16=2B in W), heart_rate (3, uint8=1B in bpm), cadence (4, uint8=1B in rpm)
  const recordDef = Buffer.from([
    0x41, // Definition header, local msg 1
    0x00,
    0x00, // Little-endian
    0x14, 0x00, // Global Msg 20 (record)
    0x06, // 6 fields
    253, 0x04, 0x86, // timestamp (uint32)
    0x05, 0x04, 0x86, // distance (uint32, scale 100)
    0x06, 0x02, 0x84, // speed (uint16, scale 1000 m/s)
    0x07, 0x02, 0x84, // power (uint16, Watts)
    0x03, 0x01, 0x02, // heart_rate (uint8, bpm)
    0x04, 0x01, 0x02, // cadence (uint8, rpm)
  ]);
  chunks.push(recordDef);

  const effectiveSamples: MatrixIndoorSample[] =
    samples.length > 0
      ? samples
      : [
          {
            timestampOffsetSeconds: Math.round(summary.durationSeconds / 2),
            speedKmh: summary.averageSpeedKmh,
            powerWatts: summary.averagePowerWatts ?? 0,
            cadenceRpm: summary.averageCadenceRpm ?? 85,
            heartRateBpm: summary.averageHeartRateBpm ?? 140,
            distanceMeters: Math.round(summary.distanceMeters / 2),
          },
          {
            timestampOffsetSeconds: summary.durationSeconds,
            speedKmh: summary.averageSpeedKmh,
            powerWatts: summary.averagePowerWatts ?? 0,
            cadenceRpm: summary.averageCadenceRpm ?? 85,
            heartRateBpm: summary.averageHeartRateBpm ?? 142,
            distanceMeters: summary.distanceMeters,
          },
        ];

  for (const s of effectiveSamples) {
    const rec = Buffer.alloc(1 + 4 + 4 + 2 + 2 + 1 + 1);
    rec.writeUInt8(0x01, 0); // Data header, local msg 1
    rec.writeUInt32LE(startFitTimestamp + Math.max(0, Math.round(s.timestampOffsetSeconds)), 1);
    rec.writeUInt32LE(Math.max(0, Math.round((s.distanceMeters || 0) * 100)), 5);
    const speedMpsScaled = Math.max(0, Math.round(((s.speedKmh || 0) / 3.6) * 1000));
    rec.writeUInt16LE(Math.min(65535, speedMpsScaled), 9);
    rec.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(s.powerWatts || 0))), 11);
    rec.writeUInt8(Math.min(255, Math.max(0, Math.round(s.heartRateBpm || 135))), 13);
    rec.writeUInt8(Math.min(255, Math.max(0, Math.round(s.cadenceRpm || 85))), 14);
    chunks.push(rec);
  }

  // 3. Definition Message for session (Local Msg 2, Global Msg 18)
  // Fields: timestamp (253, uint32), total_elapsed_time (7, uint32 in 1000*s),
  // total_distance (9, uint32 in 100*m), avg_power (20, uint16 in W),
  // total_calories (11, uint16 in kcal), sport (5, enum: 1=running, 2=cycling), avg_heart_rate (16, uint8)
  const sessionDef = Buffer.from([
    0x42, // Definition header, local msg 2
    0x00,
    0x00,
    0x12, 0x00, // Global Msg 18 (session)
    0x07, // 7 fields
    253, 0x04, 0x86, // timestamp
    0x07, 0x04, 0x86, // total_elapsed_time (ms)
    0x09, 0x04, 0x86, // total_distance (cm)
    0x14, 0x02, 0x84, // avg_power (W)
    0x0b, 0x02, 0x84, // total_calories (kcal)
    0x05, 0x01, 0x00, // sport (enum)
    0x10, 0x01, 0x02, // avg_heart_rate (bpm)
  ]);
  chunks.push(sessionDef);

  const sessionData = Buffer.alloc(1 + 4 + 4 + 4 + 2 + 2 + 1 + 1);
  sessionData.writeUInt8(0x02, 0); // Data header, local msg 2
  sessionData.writeUInt32LE(startFitTimestamp + summary.durationSeconds, 1);
  sessionData.writeUInt32LE(Math.max(1000, summary.durationSeconds * 1000), 5);
  sessionData.writeUInt32LE(Math.max(0, Math.round(summary.distanceMeters * 100)), 9);
  sessionData.writeUInt16LE(Math.max(0, Math.round(summary.averagePowerWatts || 0)), 13);
  sessionData.writeUInt16LE(Math.max(0, Math.round(summary.estimatedCalories || 0)), 15);
  sessionData.writeUInt8(summary.equipmentType === WorkoutType.BIKE ? 2 : 1, 17);
  sessionData.writeUInt8(Math.min(255, Math.max(0, Math.round(summary.averageHeartRateBpm || 140))), 18);
  chunks.push(sessionData);

  const dataBuffer = Buffer.concat(chunks);

  // Build 14-byte FIT Header
  const header = Buffer.alloc(14);
  header.writeUInt8(14, 0); // Header size = 14 bytes
  header.writeUInt8(0x20, 1); // Protocol version 2.0
  header.writeUInt16LE(2113, 2); // Profile version 21.13
  header.writeUInt32LE(dataBuffer.length, 4); // Data payload size
  header.write('.FIT', 8, 4, 'ascii'); // ".FIT" signature
  const headerCrc = calculateFitCrc16(header, 12);
  header.writeUInt16LE(headerCrc, 12);

  // Compute full file CRC-16 over header + data
  const bodyWithHeader = Buffer.concat([header, dataBuffer]);
  const fileCrc = calculateFitCrc16(bodyWithHeader, bodyWithHeader.length);
  const crcFooter = Buffer.alloc(2);
  crcFooter.writeUInt16LE(fileCrc, 0);

  return Buffer.concat([bodyWithHeader, crcFooter]);
}

/**
 * Parses and validates a binary .FIT file header and its 16-bit CRC checksum.
 */
export function inspectFitFile(fitBuffer: Buffer): FitHeaderInfo {
  if (!fitBuffer || fitBuffer.length < 16) {
    throw new Error('Invalid FIT file: buffer smaller than minimum 16 bytes');
  }

  const headerSize = fitBuffer.readUInt8(0);
  const protocolVersion = fitBuffer.readUInt8(1);
  const profileVersion = fitBuffer.readUInt16LE(2);
  const dataSize = fitBuffer.readUInt32LE(4);
  const signature = fitBuffer.toString('ascii', 8, 12);
  const headerCrc = headerSize === 14 ? fitBuffer.readUInt16LE(12) : 0;

  const fileCrcOffset = headerSize + dataSize;
  const fileCrc = fitBuffer.readUInt16LE(fileCrcOffset);
  const computedFileCrc = calculateFitCrc16(fitBuffer, fileCrcOffset);

  return {
    headerSize,
    protocolVersion,
    profileVersion,
    dataSize,
    signature,
    headerCrc,
    fileCrc,
    crcValid: signature === '.FIT' && fileCrc === computedFileCrc,
  };
}
