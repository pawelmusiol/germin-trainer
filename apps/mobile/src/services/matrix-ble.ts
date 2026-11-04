import { Platform, PermissionsAndroid, Permission } from 'react-native';
import { BleManager, Device, Subscription, BleError } from 'react-native-ble-plx';
import {
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHAR_UUID,
  TREADMILL_DATA_CHAR_UUID,
  WorkoutType,
  encodeIndoorBikeDataFrame,
  encodeTreadmillDataFrame,
} from '@garmin-trainer/shared';

export interface MatrixBleDevice {
  id: string;
  name: string;
  rssi?: number;
  equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL;
  serviceUuid: string;
  charUuid: string;
  isNativeBle?: boolean;
  isNativeWebBluetooth?: boolean;
  rawDevice?: any;
}

export type BleScanStatus = 'IDLE' | 'SCANNING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';

/**
 * Converts a Base64 string into a Uint8Array binary frame buffer.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64 || typeof base64 !== 'string') {
    return new Uint8Array(0);
  }
  const Buf = (globalThis as any).Buffer;
  if (typeof Buf !== 'undefined') {
    const buf = Buf.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let buffer = 0;
  let bits = 0;
  const output: number[] = [];
  for (let i = 0; i < base64.length; i++) {
    const c = base64[i];
    if (c === '=') break;
    const val = chars.indexOf(c);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

/**
 * Converts a Uint8Array binary buffer into a Base64 string.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (!bytes || !(bytes instanceof Uint8Array) || bytes.length === 0) {
    return '';
  }
  const Buf = (globalThis as any).Buffer;
  if (typeof Buf !== 'undefined') {
    return Buf.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return result;
}

/**
 * Requests required runtime Android Bluetooth & Location permissions.
 * On Android 12+ (API >= 31): BLUETOOTH_SCAN, BLUETOOTH_CONNECT, ACCESS_FINE_LOCATION.
 * On Android < 12 (API < 31): ACCESS_FINE_LOCATION.
 */
export async function requestAndroidBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  try {
    const apiLevel =
      typeof Platform.Version === 'number'
        ? Platform.Version
        : parseInt(String(Platform.Version), 10);

    if (apiLevel >= 31) {
      const scanPerm = (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN ||
        'android.permission.BLUETOOTH_SCAN') as Permission;
      const connectPerm = (PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT ||
        'android.permission.BLUETOOTH_CONNECT') as Permission;
      const fineLocationPerm = (PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION ||
        'android.permission.ACCESS_FINE_LOCATION') as Permission;

      const permissionsToRequest = [scanPerm, connectPerm, fineLocationPerm].filter(Boolean);
      const results = await PermissionsAndroid.requestMultiple(permissionsToRequest);

      const scanGranted = results?.[scanPerm] === PermissionsAndroid.RESULTS.GRANTED;
      const connectGranted = results?.[connectPerm] === PermissionsAndroid.RESULTS.GRANTED;
      const fineLocationGranted = results?.[fineLocationPerm] === PermissionsAndroid.RESULTS.GRANTED;

      return Boolean(scanGranted && connectGranted && fineLocationGranted);
    } else {
      const fineLocationPerm = (PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION ||
        'android.permission.ACCESS_FINE_LOCATION') as Permission;
      const result = await PermissionsAndroid.request(fineLocationPerm, {
        title: 'Wymagane uprawnienia lokalizacji',
        message: 'Lokalizacja jest wymagana na systemie Android do skanowania urządzeń BLE.',
        buttonPositive: 'OK',
      });
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch (err) {
    console.warn('Błąd podczas żądania uprawnień BLE na Androidzie:', err);
    return false;
  }
}

/**
 * Native Bluetooth Low Energy service for Matrix Equipment GATT communication.
 * Interfaces with native BLE module (react-native-ble-plx) on Android/iOS,
 * and provides GATT peripheral simulation stream for development environments.
 */
export class MatrixBleService {
  private status: BleScanStatus = 'DISCONNECTED';
  private connectedDevice: MatrixBleDevice | null = null;
  private equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL = WorkoutType.BIKE;
  private packetCallback: ((packet: Uint8Array) => void) | null = null;
  private gattNotificationInterval: any = null;
  private lastScanNotice: string | null = null;

  private bleManager: BleManager | null = null;
  private activeSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private scanTimeout: any = null;
  private activeScanResolve: (() => void) | null = null;
  private currentScanId = 0;
  private currentConnectionId = 0;
  private onDisconnectCallback: (() => void) | null = null;

  // Realistic baseline telemetry state for live GATT stream
  private currentWatts = 180;
  private currentCadence = 90;
  private currentSpeed = 31.2;
  private currentIncline = 1.5;
  private currentHeartRate = 142;
  private cumulativeDistanceMeters = 12000;

  constructor(bleManager?: BleManager) {
    if (bleManager) {
      this.bleManager = bleManager;
    }
  }

  public getBleManager(): BleManager {
    if (!this.bleManager) {
      this.bleManager = new BleManager();
    }
    return this.bleManager;
  }

  public getStatus(): BleScanStatus {
    return this.status;
  }

  public getConnectedDevice(): MatrixBleDevice | null {
    return this.connectedDevice;
  }

  public getEquipmentType(): WorkoutType.BIKE | WorkoutType.TREADMILL {
    return this.equipmentType;
  }

  public getLastScanNotice(): string | null {
    return this.lastScanNotice;
  }

  public isWebBluetoothSupported(): boolean {
    return false;
  }

  public isNativeBleSupported(): boolean {
    return Platform.OS === 'android' || Platform.OS === 'ios';
  }

  /**
   * Scans for nearby Matrix fitness peripherals advertising FTMS (0x1826) via native BLE.
   */
  public async scanForDevices(scanDurationMs: number = 2000): Promise<MatrixBleDevice[]> {
    const scanId = ++this.currentScanId;
    this.status = 'SCANNING';
    this.lastScanNotice = null;

    // Halt any active scanning timeout/operation before starting a new scan
    if (this.activeScanResolve) {
      this.activeScanResolve();
      this.activeScanResolve = null;
    }
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
    if (this.bleManager) {
      try {
        this.bleManager.stopDeviceScan();
      } catch {
        // ignore scan stop error
      }
    }

    const discovered: MatrixBleDevice[] = [];

    // 1. Request Android runtime BLE permissions if running on Android
    const hasPermissions = await requestAndroidBlePermissions();
    if (this.currentScanId !== scanId) {
      return [];
    }
    if (!hasPermissions) {
      this.lastScanNotice = 'Brak wymaganych uprawnień Bluetooth/lokalizacji na Androidzie.';
      this.status = 'ERROR';
      return [];
    }

    // 2. Perform native BLE scan via BleManager
    try {
      const manager = this.getBleManager();

      await new Promise<void>((resolve) => {
        let scanDone = false;
        const finishScan = () => {
          if (scanDone) return;
          scanDone = true;
          this.activeScanResolve = null;
          if (this.scanTimeout) {
            clearTimeout(this.scanTimeout);
            this.scanTimeout = null;
          }
          try {
            manager.stopDeviceScan();
          } catch {
            // ignore scan stop error
          }
          resolve();
        };

        this.activeScanResolve = finishScan;
        const duration = Math.max(500, Number.isFinite(scanDurationMs) ? scanDurationMs : 2000);
        this.scanTimeout = setTimeout(finishScan, duration);

        manager.startDeviceScan(
          null,
          { allowDuplicates: false },
          (error: BleError | null, device: Device | null) => {
            if (error) {
              // Attempt to prompt user to enable Bluetooth on Android if disabled
              if (Platform.OS === 'android' && typeof manager.enable === 'function') {
                try {
                  manager.enable().catch(() => {});
                } catch {
                  // ignore
                }
              }
              this.lastScanNotice = `Błąd skanowania BLE: ${error?.message || String(error)}`;
              finishScan();
              return;
            }
            if (device && typeof device.id === 'string' && device.id.trim()) {
              const name =
                (typeof device.name === 'string'
                  ? device.name
                  : typeof (device as any).localName === 'string'
                  ? (device as any).localName
                  : '') || '';
              const allUuids = [
                ...(device.serviceUUIDs || []),
                ...((device as any).overflowServiceUUIDs || []),
                ...((device as any).solicitedServiceUUIDs || []),
              ];
              const isFtms =
                allUuids.some(
                  (uuid) => typeof uuid === 'string' && uuid.toLowerCase().includes('1826')
                ) || /matrix|icr50|t70|u50|ftms/i.test(name);

              if (isFtms) {
                const existing = discovered.find((d) => d.id === device.id);
                if (!existing) {
                  const isTreadmill = /treadmill|t70|t50|run/i.test(name);
                  const equipmentType = isTreadmill ? WorkoutType.TREADMILL : WorkoutType.BIKE;
                  discovered.push({
                    id: device.id,
                    name: name || `Matrix Console [${device.id.slice(-6)}]`,
                    rssi: device.rssi ?? -60,
                    equipmentType,
                    serviceUuid: FTMS_SERVICE_UUID,
                    charUuid:
                      equipmentType === WorkoutType.BIKE
                        ? INDOOR_BIKE_DATA_CHAR_UUID
                        : TREADMILL_DATA_CHAR_UUID,
                    isNativeBle: true,
                    rawDevice: device,
                  });
                } else if (name && (!existing.name || existing.name.startsWith('Matrix Console ['))) {
                  existing.name = name;
                  if (/treadmill|t70|t50|run/i.test(name)) {
                    existing.equipmentType = WorkoutType.TREADMILL;
                    existing.charUuid = TREADMILL_DATA_CHAR_UUID;
                  }
                }
              }
            }
          }
        );
      });

      if (discovered.length > 0) {
        this.lastScanNotice = `Wykryto ${discovered.length} urządzeń Matrix przez Native BLE!`;
      } else if (!this.lastScanNotice) {
        this.lastScanNotice = 'Brak aktywnych urządzeń FTMS w zasięgu radiowym. Dostępne emulowane urządzenia Matrix:';
      }
    } catch (err: any) {
      if (this.scanTimeout) {
        clearTimeout(this.scanTimeout);
        this.scanTimeout = null;
      }
      this.lastScanNotice = `Native BLE niedostępny (${err.message || 'Bluetooth wyłączony'}). Dostępne urządzenia Matrix:`;
    }

    if (this.currentScanId !== scanId) {
      return discovered;
    }

    // 3. Fallback standard Matrix peripherals for emulated/development environments
    const standardPeripherals: MatrixBleDevice[] = [
      {
        id: 'matrix-icr50-ble',
        name: 'Matrix ICR50 Indoor Cycle',
        rssi: -56,
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
      },
      {
        id: 'matrix-t70-ble',
        name: 'Matrix T70 Treadmill',
        rssi: -64,
        equipmentType: WorkoutType.TREADMILL,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: TREADMILL_DATA_CHAR_UUID,
      },
      {
        id: 'matrix-u50-ble',
        name: 'Matrix U50 Upright Bike',
        rssi: -72,
        equipmentType: WorkoutType.BIKE,
        serviceUuid: FTMS_SERVICE_UUID,
        charUuid: INDOOR_BIKE_DATA_CHAR_UUID,
      },
    ];

    standardPeripherals.forEach((dev) => {
      if (!discovered.some((d) => d.id === dev.id)) {
        discovered.push(dev);
      }
    });

    if ((this.status as BleScanStatus) !== 'DISCONNECTED') {
      this.status = this.connectedDevice ? 'CONNECTED' : 'IDLE';
    }
    return discovered;
  }

  /**
   * Establishes GATT connection to the selected peripheral and subscribes to FTMS characteristic.
   */
  public async connect(
    device: MatrixBleDevice,
    equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL,
    onPacket: (packet: Uint8Array) => void,
    onDisconnect?: () => void
  ): Promise<void> {
    if (!device || typeof device.id !== 'string' || !device.id.trim()) {
      throw new Error('Nieprawidłowe urządzenie BLE: brak identyfikatora urządzenia.');
    }

    const connectionId = ++this.currentConnectionId;
    this.stopGattStream();

    // Stop active scanning before connecting to avoid radio contention
    this.currentScanId++;
    if (this.activeScanResolve) {
      this.activeScanResolve();
      this.activeScanResolve = null;
    }
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }
    if (this.bleManager) {
      try {
        this.bleManager.stopDeviceScan();
      } catch {
        // ignore
      }
    }

    if (this.activeSubscription) {
      this.activeSubscription.remove();
      this.activeSubscription = null;
    }
    if (this.disconnectSubscription) {
      this.disconnectSubscription.remove();
      this.disconnectSubscription = null;
    }

    // Free previous native peripheral GATT connection if switching devices
    const previousDevice = this.connectedDevice;
    if (previousDevice?.isNativeBle && previousDevice.id !== device.id && this.bleManager) {
      try {
        await this.bleManager.cancelDeviceConnection(previousDevice.id);
      } catch {
        // ignore cleanup error on previous peripheral
      }
      if (this.currentConnectionId !== connectionId) {
        return;
      }
    }

    this.connectedDevice = device;
    this.equipmentType = equipmentType;
    this.packetCallback = onPacket;
    this.onDisconnectCallback = onDisconnect || null;

    let isNativeSubscribed = false;

    // Connect to real Native BLE peripheral if it's marked as native
    if (device.isNativeBle) {
      const manager = this.getBleManager();
      try {
        const connectedPeripheral = await manager.connectToDevice(device.id);

        if (this.currentConnectionId !== connectionId) {
          try {
            await manager.cancelDeviceConnection(device.id);
          } catch {}
          return;
        }

        if (Platform.OS === 'android') {
          try {
            if (typeof (connectedPeripheral as any).requestMTU === 'function') {
              await (connectedPeripheral as any).requestMTU(512);
            } else if (typeof manager.requestMTUForDevice === 'function') {
              await manager.requestMTUForDevice(device.id, 512);
            }
          } catch {
            // ignore MTU failure
          }
        }

        if (this.currentConnectionId !== connectionId) {
          try {
            await manager.cancelDeviceConnection(device.id);
          } catch {}
          return;
        }

        await connectedPeripheral.discoverAllServicesAndCharacteristics();

        if (this.currentConnectionId !== connectionId) {
          try {
            await manager.cancelDeviceConnection(device.id);
          } catch {}
          return;
        }

        const charUuid =
          this.equipmentType === WorkoutType.BIKE
            ? INDOOR_BIKE_DATA_CHAR_UUID
            : TREADMILL_DATA_CHAR_UUID;

        this.activeSubscription = manager.monitorCharacteristicForDevice(
          device.id,
          FTMS_SERVICE_UUID,
          charUuid,
          (error: BleError | null, characteristic: any) => {
            if (error) {
              console.warn('Błąd odczytu charakterystyki GATT FTMS:', error);
              return;
            }
            if (characteristic?.value && this.packetCallback) {
              try {
                const rawPacket = base64ToUint8Array(characteristic.value);
                this.packetCallback(rawPacket);
              } catch (decodeErr) {
                console.warn('Błąd przetwarzania pakietu BLE:', decodeErr);
              }
            }
          }
        );

        this.disconnectSubscription = manager.onDeviceDisconnected(device.id, () => {
          const userOnDisconnect = this.onDisconnectCallback;
          this.disconnect().catch(() => {});
          if (userOnDisconnect) {
            try {
              userOnDisconnect();
            } catch {
              // ignore user callback error
            }
          }
        });

        isNativeSubscribed = true;
      } catch (err: any) {
        if (this.currentConnectionId !== connectionId) {
          return;
        }
        console.warn('Błąd połączenia Native BLE, przełączanie na strumień emulacji:', err?.message);
        if (this.activeSubscription) {
          this.activeSubscription.remove();
          this.activeSubscription = null;
        }
        if (this.disconnectSubscription) {
          this.disconnectSubscription.remove();
          this.disconnectSubscription = null;
        }
        try {
          await manager.cancelDeviceConnection(device.id);
        } catch {
          // ignore cleanup errors
        }
      }
    }

    if (this.currentConnectionId !== connectionId) {
      return;
    }

    this.status = 'CONNECTED';
    if (!isNativeSubscribed) {
      this.startGattStream();
    }
  }

  /**
   * Updates equipment type and active GATT characteristic subscription.
   */
  public setEquipmentType(equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL): void {
    this.equipmentType = equipmentType;
    if (this.connectedDevice) {
      this.connectedDevice.equipmentType = equipmentType;
      this.connectedDevice.charUuid =
        equipmentType === WorkoutType.BIKE
          ? INDOOR_BIKE_DATA_CHAR_UUID
          : TREADMILL_DATA_CHAR_UUID;

      if (this.connectedDevice.isNativeBle && this.status === 'CONNECTED') {
        if (this.activeSubscription) {
          this.activeSubscription.remove();
          this.activeSubscription = null;
        }
        try {
          const manager = this.getBleManager();
          this.activeSubscription = manager.monitorCharacteristicForDevice(
            this.connectedDevice.id,
            FTMS_SERVICE_UUID,
            this.connectedDevice.charUuid,
            (error: BleError | null, characteristic: any) => {
              if (error) {
                console.warn('Błąd odczytu charakterystyki GATT FTMS po zmianie typu:', error);
                return;
              }
              if (characteristic?.value && this.packetCallback) {
                try {
                  this.packetCallback(base64ToUint8Array(characteristic.value));
                } catch (decodeErr) {
                  console.warn('Błąd dekodowania pakietu FTMS po zmianie typu:', decodeErr);
                }
              }
            }
          );
        } catch {
          // ignore subscription recreate error
        }
      }
    }
  }

  /**
   * Disconnects GATT connection and stops telemetry streams.
   */
  public async disconnect(): Promise<void> {
    this.currentScanId++;
    this.currentConnectionId++;

    this.stopGattStream();

    if (this.activeScanResolve) {
      this.activeScanResolve();
      this.activeScanResolve = null;
    }
    if (this.scanTimeout) {
      clearTimeout(this.scanTimeout);
      this.scanTimeout = null;
    }

    if (this.bleManager) {
      try {
        this.bleManager.stopDeviceScan();
      } catch {
        // Ignore
      }
    }

    if (this.activeSubscription) {
      this.activeSubscription.remove();
      this.activeSubscription = null;
    }

    if (this.disconnectSubscription) {
      this.disconnectSubscription.remove();
      this.disconnectSubscription = null;
    }

    const dev = this.connectedDevice;
    this.connectedDevice = null;
    this.packetCallback = null;
    this.onDisconnectCallback = null;
    this.status = 'DISCONNECTED';

    if (dev?.isNativeBle && this.bleManager) {
      try {
        await this.bleManager.cancelDeviceConnection(dev.id);
      } catch {
        // Ignore disconnect errors
      }
    }
  }

  /**
   * Destroys BleManager instance and releases native resources.
   */
  public async destroy(): Promise<void> {
    await this.disconnect();
    if (this.bleManager) {
      try {
        await this.bleManager.destroy();
      } catch {
        // ignore
      }
      this.bleManager = null;
    }
  }

  /**
   * Generates a single authentic binary FTMS GATT frame matching current equipment type.
   */
  public generateSinglePacket(): Uint8Array {
    const wattsJitter = Math.floor(Math.random() * 9) - 4; // +/- 4W
    this.currentWatts = Math.max(120, Math.min(320, this.currentWatts + wattsJitter));

    const cadenceJitter = Math.floor(Math.random() * 3) - 1; // +/- 1 RPM
    this.currentCadence = Math.max(75, Math.min(105, this.currentCadence + cadenceJitter));

    const speedJitter = Math.random() * 0.4 - 0.2;
    this.currentSpeed = Number(
      Math.max(15.0, Math.min(45.0, this.currentSpeed + speedJitter)).toFixed(2)
    );

    if (this.currentHeartRate < 165) {
      this.currentHeartRate += Math.random() > 0.6 ? 1 : 0;
    }

    if (this.equipmentType === WorkoutType.BIKE) {
      this.cumulativeDistanceMeters += Math.round((this.currentSpeed * 1000) / 3600);
      return encodeIndoorBikeDataFrame({
        speedKmh: this.currentSpeed,
        cadenceRpm: this.currentCadence,
        distanceMeters: this.cumulativeDistanceMeters,
        powerWatts: this.currentWatts,
        heartRateBpm: this.currentHeartRate,
      });
    } else {
      const treadSpeed = Number(
        Math.max(8.0, Math.min(18.0, this.currentSpeed / 2.5)).toFixed(2)
      );
      this.cumulativeDistanceMeters += Math.round((treadSpeed * 1000) / 3600);
      return encodeTreadmillDataFrame({
        speedKmh: treadSpeed,
        distanceMeters: this.cumulativeDistanceMeters,
        inclinePercent: this.currentIncline,
        heartRateBpm: this.currentHeartRate,
      });
    }
  }

  /**
   * Manually dispatches a single binary packet into the callback (useful for testing/simulation).
   */
  public triggerManualPacket(): Uint8Array {
    const packet = this.generateSinglePacket();
    if (this.packetCallback) {
      try {
        this.packetCallback(packet);
      } catch (manualErr) {
        console.warn('Błąd w manualnym wywołaniu pakietu FTMS:', manualErr);
      }
    }
    return packet;
  }

  /**
   * Starts transmitting 1-second GATT binary packets to the subscriber.
   */
  private startGattStream(): void {
    if (this.gattNotificationInterval) return;

    this.gattNotificationInterval = setInterval(() => {
      if (this.status === 'CONNECTED' && this.packetCallback) {
        try {
          const packet = this.generateSinglePacket();
          this.packetCallback(packet);
        } catch (streamErr) {
          console.warn('Błąd w strumieniu emulacji pakietu GATT:', streamErr);
        }
      }
    }, 1000);
  }

  private stopGattStream(): void {
    if (this.gattNotificationInterval) {
      clearInterval(this.gattNotificationInterval);
      this.gattNotificationInterval = null;
    }
  }
}

export const matrixBleService = new MatrixBleService();
