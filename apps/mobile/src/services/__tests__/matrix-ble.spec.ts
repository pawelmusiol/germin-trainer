import { Platform, PermissionsAndroid } from 'react-native';
import {
  WorkoutType,
  encodeIndoorBikeDataFrame,
  encodeTreadmillDataFrame,
  parseIndoorBikeDataFrame,
  parseTreadmillDataFrame,
  MatrixSessionAccumulator,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHAR_UUID,
  TREADMILL_DATA_CHAR_UUID,
} from '@garmin-trainer/shared';
import {
  MatrixBleService,
  MatrixBleDevice,
  requestAndroidBlePermissions,
  base64ToUint8Array,
  uint8ArrayToBase64,
} from '../matrix-ble';

// Mock react-native
jest.mock('react-native', () => {
  return {
    Platform: {
      OS: 'android',
      Version: 33,
      select: jest.fn((dict: any) => dict.android),
    },
    PermissionsAndroid: {
      PERMISSIONS: {
        BLUETOOTH_SCAN: 'android.permission.BLUETOOTH_SCAN',
        BLUETOOTH_CONNECT: 'android.permission.BLUETOOTH_CONNECT',
        ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
        ACCESS_COARSE_LOCATION: 'android.permission.ACCESS_COARSE_LOCATION',
      },
      RESULTS: {
        GRANTED: 'granted',
        DENIED: 'denied',
        NEVER_ASK_AGAIN: 'never_ask_again',
      },
      request: jest.fn(),
      requestMultiple: jest.fn(),
    },
  };
});

// Mock react-native-ble-plx
const mockMonitorRemove = jest.fn();
const mockDeviceDisconnectRemove = jest.fn();

let mockMonitorCallback: ((error: any, characteristic: any) => void) | null = null;
let mockScanCallback: ((error: any, device: any) => void) | null = null;
let mockDisconnectCallback: (() => void) | null = null;

const createMockBleManager = () => {
  return {
    state: jest.fn().mockResolvedValue('PoweredOn'),
    enable: jest.fn().mockResolvedValue(undefined),
    startDeviceScan: jest.fn(
      (_uuids: any, _options: any, listener: (error: any, device: any) => void) => {
        mockScanCallback = listener;
      }
    ),
    stopDeviceScan: jest.fn().mockResolvedValue(undefined),
    connectToDevice: jest.fn().mockImplementation((id: string) => {
      return Promise.resolve({
        id,
        name: 'Matrix ICR50 Bike',
        discoverAllServicesAndCharacteristics: jest.fn().mockResolvedValue(undefined),
        requestMTU: jest.fn().mockResolvedValue(512),
      });
    }),
    monitorCharacteristicForDevice: jest.fn(
      (
        _id: string,
        _serviceUuid: string,
        _charUuid: string,
        listener: (error: any, characteristic: any) => void
      ) => {
        mockMonitorCallback = listener;
        return { remove: mockMonitorRemove };
      }
    ),
    cancelDeviceConnection: jest.fn().mockResolvedValue(undefined),
    onDeviceDisconnected: jest.fn((_id: string, listener: () => void) => {
      mockDisconnectCallback = listener;
      return { remove: mockDeviceDisconnectRemove };
    }),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
};

let activeMockBleManager = createMockBleManager();

jest.mock('react-native-ble-plx', () => {
  return {
    BleManager: jest.fn().mockImplementation(() => activeMockBleManager),
    BleError: class BleError extends Error {},
  };
});

describe('Matrix BLE Native Module & FTMS Telemetry Suite', () => {
  let mockBleManager: ReturnType<typeof createMockBleManager>;
  let bleService: MatrixBleService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    (Platform as any).OS = 'android';
    (Platform as any).Version = 33;

    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
      'android.permission.BLUETOOTH_SCAN': 'granted',
      'android.permission.BLUETOOTH_CONNECT': 'granted',
      'android.permission.ACCESS_FINE_LOCATION': 'granted',
    });

    (PermissionsAndroid.request as jest.Mock).mockResolvedValue('granted');

    mockBleManager = createMockBleManager();
    bleService = new MatrixBleService(mockBleManager as any);
  });

  afterEach(async () => {
    await bleService.disconnect();
    jest.useRealTimers();
  });

  describe('Android BLE Runtime Permissions', () => {
    it('requests BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and ACCESS_FINE_LOCATION on Android 12+ (API 31+)', async () => {
      (Platform as any).Version = 31;
      const granted = await requestAndroidBlePermissions();

      expect(granted).toBe(true);
      expect(PermissionsAndroid.requestMultiple).toHaveBeenCalledWith([
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.ACCESS_FINE_LOCATION',
      ]);
      expect(PermissionsAndroid.request).not.toHaveBeenCalled();
    });

    it('returns false if BLUETOOTH_SCAN is denied on Android 12+', async () => {
      (Platform as any).Version = 33;
      (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
        'android.permission.BLUETOOTH_SCAN': 'denied',
        'android.permission.BLUETOOTH_CONNECT': 'granted',
        'android.permission.ACCESS_FINE_LOCATION': 'granted',
      });

      const granted = await requestAndroidBlePermissions();
      expect(granted).toBe(false);
    });

    it('returns false if BLUETOOTH_CONNECT is denied on Android 12+', async () => {
      (Platform as any).Version = 33;
      (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
        'android.permission.BLUETOOTH_SCAN': 'granted',
        'android.permission.BLUETOOTH_CONNECT': 'denied',
        'android.permission.ACCESS_FINE_LOCATION': 'granted',
      });

      const granted = await requestAndroidBlePermissions();
      expect(granted).toBe(false);
    });

    it('returns false if ACCESS_FINE_LOCATION is denied on Android 12+', async () => {
      (Platform as any).Version = 33;
      (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
        'android.permission.BLUETOOTH_SCAN': 'granted',
        'android.permission.BLUETOOTH_CONNECT': 'granted',
        'android.permission.ACCESS_FINE_LOCATION': 'denied',
      });

      const granted = await requestAndroidBlePermissions();
      expect(granted).toBe(false);
    });

    it('requests ACCESS_FINE_LOCATION on Android < 12 (API 29)', async () => {
      (Platform as any).Version = 29;
      const granted = await requestAndroidBlePermissions();

      expect(granted).toBe(true);
      expect(PermissionsAndroid.request).toHaveBeenCalledWith(
        'android.permission.ACCESS_FINE_LOCATION',
        expect.objectContaining({
          title: expect.any(String),
          message: expect.any(String),
        })
      );
      expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
    });

    it('returns false if ACCESS_FINE_LOCATION is denied on Android < 12', async () => {
      (Platform as any).Version = 29;
      (PermissionsAndroid.request as jest.Mock).mockResolvedValue('denied');

      const granted = await requestAndroidBlePermissions();
      expect(granted).toBe(false);
    });

    it('bypasses permission request on non-Android platforms (iOS)', async () => {
      (Platform as any).OS = 'ios';
      const granted = await requestAndroidBlePermissions();

      expect(granted).toBe(true);
      expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
      expect(PermissionsAndroid.request).not.toHaveBeenCalled();
    });

    it('handles unexpected nullish response from requestMultiple safely', async () => {
      (Platform as any).Version = 33;
      (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue(null);

      const granted = await requestAndroidBlePermissions();
      expect(granted).toBe(false);
    });
  });

  describe('Base64 & Binary GATT Frame Conversion', () => {
    it('correctly converts binary FTMS frame to base64 and back', () => {
      const originalFrame = encodeIndoorBikeDataFrame({
        speedKmh: 34.2,
        cadenceRpm: 92,
        distanceMeters: 8500,
        powerWatts: 245,
        heartRateBpm: 154,
      });

      const base64 = uint8ArrayToBase64(originalFrame);
      expect(typeof base64).toBe('string');
      expect(base64.length).toBeGreaterThan(0);

      const decodedBytes = base64ToUint8Array(base64);
      expect(decodedBytes).toEqual(originalFrame);

      const decodedMetrics = parseIndoorBikeDataFrame(decodedBytes);
      expect(decodedMetrics.speedKmh).toBeCloseTo(34.2, 1);
      expect(decodedMetrics.cadenceRpm).toBe(92);
      expect(decodedMetrics.powerWatts).toBe(245);
      expect(decodedMetrics.heartRateBpm).toBe(154);
    });

    it('handles empty byte array and edge values gracefully', () => {
      const empty = new Uint8Array(0);
      const b64 = uint8ArrayToBase64(empty);
      expect(b64).toBe('');
      const restored = base64ToUint8Array(b64);
      expect(restored.length).toBe(0);

      const allBytes = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
      const roundTrip = base64ToUint8Array(uint8ArrayToBase64(allBytes));
      expect(roundTrip).toEqual(allBytes);
    });

    it('safely handles null, undefined, or non-string base64 and invalid bytes', () => {
      expect(base64ToUint8Array(null as any)).toEqual(new Uint8Array(0));
      expect(base64ToUint8Array(undefined as any)).toEqual(new Uint8Array(0));
      expect(base64ToUint8Array('' as any)).toEqual(new Uint8Array(0));
      expect(uint8ArrayToBase64(null as any)).toBe('');
      expect(uint8ArrayToBase64(undefined as any)).toBe('');
      expect(uint8ArrayToBase64([] as any)).toBe('');
    });
  });

  describe('Native BLE Peripheral Scanning', () => {
    it('discovers native Matrix FTMS peripherals advertising FTMS service or Matrix name', async () => {
      const scanPromise = bleService.scanForDevices(1000);

      // Flush microtasks for requestAndroidBlePermissions
      await Promise.resolve();
      await Promise.resolve();

      expect(mockBleManager.startDeviceScan).toHaveBeenCalled();

      // Trigger simulated BLE advertising discovery packet
      if (mockScanCallback) {
        mockScanCallback(null, {
          id: 'matrix-console-99A',
          name: 'Matrix ICR50 Bike',
          rssi: -52,
          serviceUUIDs: [FTMS_SERVICE_UUID],
        });
      }

      // Advance timers to finish scan
      jest.advanceTimersByTime(1100);

      const devices = await scanPromise;
      expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();

      // Discovered native peripheral should be present
      const nativeDev = devices.find((d) => d.id === 'matrix-console-99A');
      expect(nativeDev).toBeDefined();
      expect(nativeDev?.name).toBe('Matrix ICR50 Bike');
      expect(nativeDev?.equipmentType).toBe(WorkoutType.BIKE);
      expect(nativeDev?.charUuid).toBe(INDOOR_BIKE_DATA_CHAR_UUID);
      expect(nativeDev?.isNativeBle).toBe(true);

      // Standard fallback devices should also be present
      expect(devices.some((d) => d.id === 'matrix-icr50-ble')).toBe(true);
      expect(devices.some((d) => d.id === 'matrix-t70-ble')).toBe(true);
    });

    it('aborts scan and sets ERROR status if Android permissions are denied', async () => {
      (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValue({
        'android.permission.BLUETOOTH_SCAN': 'denied',
        'android.permission.BLUETOOTH_CONNECT': 'denied',
        'android.permission.ACCESS_FINE_LOCATION': 'denied',
      });

      const devices = await bleService.scanForDevices(1000);
      expect(devices).toHaveLength(0);
      expect(bleService.getStatus()).toBe('ERROR');
      expect(bleService.getLastScanNotice()).toContain('Brak wymaganych uprawnień');
      expect(mockBleManager.startDeviceScan).not.toHaveBeenCalled();
    });

    it('prompts user to enable Bluetooth when scan receives error on Android', async () => {
      const scanPromise = bleService.scanForDevices(1000);
      await Promise.resolve();
      await Promise.resolve();

      if (mockScanCallback) {
        mockScanCallback(new Error('Bluetooth is powered off') as any, null);
      }

      const devices = await scanPromise;
      expect(mockBleManager.enable).toHaveBeenCalled();
      expect(devices.length).toBeGreaterThan(0);
    });

    it('halts active device scan and preserves DISCONNECTED status if disconnect is called while scanning', async () => {
      const scanPromise = bleService.scanForDevices(2000);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockBleManager.startDeviceScan).toHaveBeenCalled();

      await bleService.disconnect();
      expect(mockBleManager.stopDeviceScan).toHaveBeenCalled();
      expect(bleService.getStatus()).toBe('DISCONNECTED');

      jest.advanceTimersByTime(2100);
      await scanPromise;
      expect(bleService.getStatus()).toBe('DISCONNECTED');
    });

    it('preserves SCANNING status when a previous scan finishes while a new scan is active', async () => {
      const scan1Promise = bleService.scanForDevices(2000);
      await Promise.resolve();
      await Promise.resolve();

      const scan2Promise = bleService.scanForDevices(2000);
      await Promise.resolve();
      await Promise.resolve();

      // Scan 1 resolves immediately as superseded
      await scan1Promise;
      expect(bleService.getStatus()).toBe('SCANNING');

      jest.advanceTimersByTime(2100);
      await scan2Promise;
      expect(bleService.getStatus()).toBe('IDLE');
    });

    it('tolerates null, undefined, or non-string entries in advertising UUIDs', async () => {
      const scanPromise = bleService.scanForDevices(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(() => {
        if (mockScanCallback) {
          mockScanCallback(null, {
            id: 'matrix-weird-uuids',
            name: 'Matrix Console Weird',
            rssi: -50,
            serviceUUIDs: [null as any, undefined as any, 12345 as any, '00001826-0000-1000-8000-00805f9b34fb'],
          });
        }
      }).not.toThrow();

      jest.advanceTimersByTime(1100);
      const devices = await scanPromise;
      expect(devices.some((d) => d.id === 'matrix-weird-uuids')).toBe(true);
    });

    it('safely handles NaN or non-finite scanDurationMs with standard minimum duration', async () => {
      const scanPromise = bleService.scanForDevices(NaN);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockBleManager.startDeviceScan).toHaveBeenCalled();
      jest.advanceTimersByTime(2100);
      const devices = await scanPromise;
      expect(devices.length).toBeGreaterThan(0);
    });
  });

  describe('Native BLE GATT Connection & FTMS Telemetry Decoding', () => {
    it('connects to native bike peripheral and streams decoded FTMS 0x2AD2 packets into accumulator', async () => {
      const nativeBikeDevice: MatrixBleDevice = {
        id: 'matrix-bike-01',
        name: 'Matrix ICR50 Indoor Cycle',
        rssi: -55,
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      const receivedPackets: Uint8Array[] = [];
      await bleService.connect(nativeBikeDevice, WorkoutType.BIKE, (packet) => {
        receivedPackets.push(packet);
        accumulator.ingestRawPacket(packet);
      });

      expect(bleService.getStatus()).toBe('CONNECTED');
      expect(mockBleManager.connectToDevice).toHaveBeenCalledWith('matrix-bike-01');
      expect(mockBleManager.monitorCharacteristicForDevice).toHaveBeenCalledWith(
        'matrix-bike-01',
        FTMS_SERVICE_UUID,
        INDOOR_BIKE_DATA_CHAR_UUID,
        expect.any(Function)
      );

      // Simulate incoming BLE characteristic notification with binary FTMS Indoor Bike frame
      const bikeFrame = encodeIndoorBikeDataFrame({
        speedKmh: 31.8,
        cadenceRpm: 94,
        distanceMeters: 6200,
        powerWatts: 220,
        heartRateBpm: 148,
      });

      const base64Payload = uint8ArrayToBase64(bikeFrame);
      if (mockMonitorCallback) {
        mockMonitorCallback(null, { value: base64Payload });
      }

      expect(receivedPackets).toHaveLength(1);
      expect(receivedPackets[0]).toEqual(bikeFrame);

      // Verify accumulator live metrics decoded from binary FTMS frame
      const live = accumulator.getLiveMetrics();
      expect(live.speedKmh).toBeCloseTo(31.8, 1);
      expect(live.cadenceRpm).toBe(94);
      expect(live.powerWatts).toBe(220);
      expect(live.heartRateBpm).toBe(148);
    });

    it('connects to native treadmill peripheral and streams decoded FTMS 0x2ACD packets into accumulator', async () => {
      const nativeTreadDevice: MatrixBleDevice = {
        id: 'matrix-treadmill-01',
        name: 'Matrix T70 Treadmill',
        rssi: -62,
        equipmentType: WorkoutType.TREADMILL,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: TREADMILL_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const accumulator = new MatrixSessionAccumulator(WorkoutType.TREADMILL);
      accumulator.start();

      const receivedPackets: Uint8Array[] = [];
      await bleService.connect(nativeTreadDevice, WorkoutType.TREADMILL, (packet) => {
        receivedPackets.push(packet);
        accumulator.ingestRawPacket(packet);
      });

      expect(bleService.getStatus()).toBe('CONNECTED');
      expect(mockBleManager.connectToDevice).toHaveBeenCalledWith('matrix-treadmill-01');
      expect(mockBleManager.monitorCharacteristicForDevice).toHaveBeenCalledWith(
        'matrix-treadmill-01',
        FTMS_SERVICE_UUID,
        TREADMILL_DATA_CHAR_UUID,
        expect.any(Function)
      );

      // Simulate incoming FTMS Treadmill binary notification
      const treadFrame = encodeTreadmillDataFrame({
        speedKmh: 14.5,
        distanceMeters: 3100,
        inclinePercent: 3.0,
        heartRateBpm: 160,
      });

      const base64Payload = uint8ArrayToBase64(treadFrame);
      if (mockMonitorCallback) {
        mockMonitorCallback(null, { value: base64Payload });
      }

      expect(receivedPackets).toHaveLength(1);
      const live = accumulator.getLiveMetrics();
      expect(live.speedKmh).toBeCloseTo(14.5, 1);
      expect(live.inclinePercent).toBe(3.0);
      expect(live.heartRateBpm).toBe(160);
    });

    it('switches equipment type dynamically and resubscribes to appropriate characteristic', async () => {
      const nativeDevice: MatrixBleDevice = {
        id: 'matrix-hybrid-01',
        name: 'Matrix Multi Console',
        rssi: -58,
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      await bleService.connect(nativeDevice, WorkoutType.BIKE, jest.fn());
      expect(bleService.getEquipmentType()).toBe(WorkoutType.BIKE);

      // Switch to treadmill
      bleService.setEquipmentType(WorkoutType.TREADMILL);
      expect(bleService.getEquipmentType()).toBe(WorkoutType.TREADMILL);
      expect(mockMonitorRemove).toHaveBeenCalled();
      expect(mockBleManager.monitorCharacteristicForDevice).toHaveBeenLastCalledWith(
        'matrix-hybrid-01',
        FTMS_SERVICE_UUID,
        TREADMILL_DATA_CHAR_UUID,
        expect.any(Function)
      );
    });

    it('disconnects and cleans up subscriptions and GATT connections', async () => {
      const nativeDevice: MatrixBleDevice = {
        id: 'matrix-bike-02',
        name: 'Matrix Bike',
        rssi: -50,
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      await bleService.connect(nativeDevice, WorkoutType.BIKE, jest.fn());
      expect(bleService.getStatus()).toBe('CONNECTED');

      await bleService.disconnect();
      expect(bleService.getStatus()).toBe('DISCONNECTED');
      expect(bleService.getConnectedDevice()).toBeNull();
      expect(mockMonitorRemove).toHaveBeenCalled();
      expect(mockDeviceDisconnectRemove).toHaveBeenCalled();
      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('matrix-bike-02');
    });

    it('handles unexpected peripheral disconnect event gracefully', async () => {
      const nativeDevice: MatrixBleDevice = {
        id: 'matrix-bike-03',
        name: 'Matrix Bike 03',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      await bleService.connect(nativeDevice, WorkoutType.BIKE, jest.fn());
      expect(bleService.getStatus()).toBe('CONNECTED');

      // Trigger unexpected disconnect event from BLE peripheral radio
      if (mockDisconnectCallback) {
        mockDisconnectCallback();
      }

      expect(bleService.getStatus()).toBe('DISCONNECTED');
      expect(bleService.getConnectedDevice()).toBeNull();
    });

    it('invokes user onDisconnect callback when unexpected peripheral disconnect occurs', async () => {
      const nativeDevice: MatrixBleDevice = {
        id: 'matrix-bike-04',
        name: 'Matrix Bike 04',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const onDisconnectMock = jest.fn();
      await bleService.connect(nativeDevice, WorkoutType.BIKE, jest.fn(), onDisconnectMock);
      expect(bleService.getStatus()).toBe('CONNECTED');

      if (mockDisconnectCallback) {
        mockDisconnectCallback();
      }

      expect(onDisconnectMock).toHaveBeenCalledTimes(1);
      expect(bleService.getStatus()).toBe('DISCONNECTED');
    });

    it('cancels GATT connection and maintains DISCONNECTED status when disconnect interrupts in-flight connect', async () => {
      let resolveConnect: any;
      mockBleManager.connectToDevice.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          })
      );

      const slowDevice: MatrixBleDevice = {
        id: 'matrix-slow-01',
        name: 'Matrix Slow Device',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const connectPromise = bleService.connect(slowDevice, WorkoutType.BIKE, jest.fn());
      await Promise.resolve();

      // Interrupted by explicit user disconnect
      await bleService.disconnect();
      expect(bleService.getStatus()).toBe('DISCONNECTED');

      // Now the pending hardware connection completes
      resolveConnect({
        id: 'matrix-slow-01',
        name: 'Matrix Slow Device',
        discoverAllServicesAndCharacteristics: jest.fn().mockResolvedValue(undefined),
      });

      await connectPromise;
      expect(bleService.getStatus()).toBe('DISCONNECTED');
      expect(bleService.getConnectedDevice()).toBeNull();
      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('matrix-slow-01');
    });

    it('rejects connect cleanly when device or device.id is invalid', async () => {
      await expect(bleService.connect(null as any, WorkoutType.BIKE, jest.fn())).rejects.toThrow(
        'Nieprawidłowe urządzenie BLE'
      );
      await expect(bleService.connect({} as any, WorkoutType.BIKE, jest.fn())).rejects.toThrow(
        'Nieprawidłowe urządzenie BLE'
      );
    });

    it('handles exceptions thrown by the characteristic packet callback gracefully', async () => {
      const nativeDevice: MatrixBleDevice = {
        id: 'matrix-bike-05',
        name: 'Matrix Bike 05',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const faultyCallback = jest.fn(() => {
        throw new Error('Callback failed');
      });

      await bleService.connect(nativeDevice, WorkoutType.BIKE, faultyCallback);

      const bikeFrame = encodeIndoorBikeDataFrame({
        speedKmh: 28.0,
        cadenceRpm: 85,
        powerWatts: 190,
        distanceMeters: 2500,
      });

      // Simulating characteristic emit should not throw or crash
      expect(() => {
        if (mockMonitorCallback) {
          mockMonitorCallback(null, { value: uint8ArrayToBase64(bikeFrame) });
        }
      }).not.toThrow();

      expect(faultyCallback).toHaveBeenCalled();
    });

    it('cleans up half-open GATT connection if connection fails midway', async () => {
      const failingDevice: MatrixBleDevice = {
        id: 'matrix-fail-01',
        name: 'Matrix Broken Console',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      mockBleManager.connectToDevice.mockRejectedValueOnce(new Error('GATT connection timeout 133'));

      await bleService.connect(failingDevice, WorkoutType.BIKE, jest.fn());

      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('matrix-fail-01');
      // Falls back to emulated gatt stream
      expect(bleService.getStatus()).toBe('CONNECTED');
    });

    it('cancels previous peripheral GATT connection when connecting to a new native device', async () => {
      const nativeDevA: MatrixBleDevice = {
        id: 'matrix-device-A',
        name: 'Matrix Bike A',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      const nativeDevB: MatrixBleDevice = {
        id: 'matrix-device-B',
        name: 'Matrix Bike B',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
        isNativeBle: true,
      };

      await bleService.connect(nativeDevA, WorkoutType.BIKE, jest.fn());
      expect(bleService.getConnectedDevice()?.id).toBe('matrix-device-A');

      // Now connect to Device B
      await bleService.connect(nativeDevB, WorkoutType.BIKE, jest.fn());
      expect(mockBleManager.cancelDeviceConnection).toHaveBeenCalledWith('matrix-device-A');
      expect(bleService.getConnectedDevice()?.id).toBe('matrix-device-B');
    });

    it('does not attempt characteristic monitor in setEquipmentType if status is not CONNECTED', () => {
      bleService.setEquipmentType(WorkoutType.TREADMILL);
      expect(mockBleManager.monitorCharacteristicForDevice).not.toHaveBeenCalled();
    });

    it('destroys BleManager and releases native resources cleanly', async () => {
      await bleService.destroy();
      expect(mockBleManager.destroy).toHaveBeenCalled();
    });
  });

  describe('1-Second Telemetry Accumulation Stream (Simulation Fallback)', () => {
    it('streams 1-second binary FTMS packets and accumulates session distance/power over time', async () => {
      const emulatedDevice: MatrixBleDevice = {
        id: 'matrix-icr50-ble',
        name: 'Matrix ICR50 Indoor Cycle',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
      };

      const accumulator = new MatrixSessionAccumulator(WorkoutType.BIKE);
      accumulator.start();

      let packetCount = 0;
      await bleService.connect(emulatedDevice, WorkoutType.BIKE, (packet) => {
        packetCount++;
        accumulator.ingestRawPacket(packet);
      });

      expect(bleService.getStatus()).toBe('CONNECTED');
      // Should not call native connect for emulated fallback device
      expect(mockBleManager.connectToDevice).not.toHaveBeenCalled();

      // Advance timers by 3 seconds
      jest.advanceTimersByTime(3000);

      expect(packetCount).toBe(3);
      const metrics = accumulator.getLiveMetrics();
      expect(metrics.speedKmh).toBeGreaterThanOrEqual(15.0);
      expect(metrics.cadenceRpm).toBeGreaterThanOrEqual(75);
      expect(metrics.powerWatts).toBeGreaterThanOrEqual(120);
      expect(metrics.heartRateBpm).toBeGreaterThanOrEqual(140);
    });

    it('safeguards 1-second interval against unhandled exceptions from packet callback', async () => {
      const emulatedDevice: MatrixBleDevice = {
        id: 'matrix-icr50-ble',
        name: 'Matrix ICR50 Indoor Cycle',
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
      };

      const faultyCallback = jest.fn(() => {
        throw new Error('Simulation callback crash');
      });

      await bleService.connect(emulatedDevice, WorkoutType.BIKE, faultyCallback);

      expect(() => {
        jest.advanceTimersByTime(2000);
      }).not.toThrow();

      expect(faultyCallback).toHaveBeenCalled();
    });

    it('triggers manual packet immediately with valid FTMS binary frame', () => {
      let received: Uint8Array | null = null;
      bleService.setEquipmentType(WorkoutType.BIKE);

      const emitted = bleService.triggerManualPacket();
      expect(emitted).toBeInstanceOf(Uint8Array);

      // Verify binary frame structure with parser
      const parsed = parseIndoorBikeDataFrame(emitted);
      expect(parsed.speedKmh).toBeGreaterThan(0);
      expect(parsed.cadenceRpm).toBeGreaterThan(0);
      expect(parsed.powerWatts).toBeGreaterThan(0);
    });

    it('safeguards triggerManualPacket against callback exceptions', () => {
      bleService.setEquipmentType(WorkoutType.BIKE);
      (bleService as any).packetCallback = () => {
        throw new Error('Manual packet callback explosion');
      };

      expect(() => {
        const packet = bleService.triggerManualPacket();
        expect(packet).toBeInstanceOf(Uint8Array);
      }).not.toThrow();
    });
  });
});
