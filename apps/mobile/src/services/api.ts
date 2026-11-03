import { NativeModules } from 'react-native';
import {
  GarminConnectionStatus,
  GarminDailySummary,
  GarminActivitySummary,
  WorkoutData,
  WorkoutType,
  VdotPaces,
  CyclingWattZones,
  MatrixIndoorSample,
} from '@garmin-trainer/shared';

/**
 * Automatically resolves the local LAN IP address of the development machine
 * from Expo's Metro bundler scriptURL (e.g. exp://192.168.1.11:8081 -> http://192.168.1.11:3001),
 * falling back to 192.168.1.11:3001.
 */
function resolveApiBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  try {
    const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL;
    if (scriptURL) {
      const match = scriptURL.match(/https?:\/\/([^/:]+):\d+/);
      if (match && match[1] && match[1] !== 'localhost' && match[1] !== '127.0.0.1') {
        return `http://${match[1]}:3001`;
      }
    }
  } catch {
    // Ignore NativeModules lookup error in non-RN environments
  }

  return 'http://192.168.1.11:3001';
}

const DEFAULT_API_BASE_URL = resolveApiBaseUrl();

export interface BootstrapResponse {
  user: {
    id: string;
    email: string;
    name?: string | null;
    role: string;
  };
  token: string;
  activeGoal: any;
  paces: VdotPaces;
  wattZones: CyclingWattZones;
  garminStatus: GarminConnectionStatus;
  latestMetric: any;
  workouts: any[];
}

export interface GarminFitnessEstimationResponse {
  estimatedCurrentVdot: number;
  estimated10kSeconds: number;
  sampleCount: number;
  hasSufficientData?: boolean;
  message?: string;
  currentPaces: VdotPaces;
  activeGoal?: any;
}

export class GarminTrainerApiClient {
  private readonly baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = DEFAULT_API_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public setAuthToken(token: string | null): void {
    this.token = token;
  }

  public getAuthToken(): string | null {
    return this.token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Automatically initializes the default user session without registration
   * and loads active goal, VDOT paces, Garmin status, metrics, and workouts from Neon DB.
   */
  public async bootstrap(): Promise<BootstrapResponse> {
    const res = await fetch(`${this.baseUrl}/api/goals/bootstrap`);
    if (!res.ok) {
      throw new Error(`Bootstrap failed (${res.status})`);
    }
    const data: BootstrapResponse = await res.json();
    if (data.token) {
      this.token = data.token;
    }
    return data;
  }

  /**
   * Saves a new training goal to Neon PostgreSQL (separating current fitness from target goal)
   * and generates a 7-day workout plan anchored to current safe paces.
   */
  public async saveTrainingGoal(input: {
    targetDistance: 'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON';
    currentTimeSeconds: number;
    targetTimeSeconds: number;
    preference: 'RUN_ONLY' | 'HYBRID_BIKE_RUN';
    riderWeightKg?: number;
    eventDate?: string;
  }): Promise<{
    goal: any;
    paces: VdotPaces;
    targetPaces?: VdotPaces;
    progression?: any;
    wattZones: CyclingWattZones;
    workouts: any[];
  }> {
    const res = await fetch(`${this.baseUrl}/api/goals`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to save goal (${res.status})`);
    }
    return body;
  }

  /**
   * Estimates the athlete's current fitness (VDOT and current 10K time) from completed Garmin runs.
   */
  public async estimateCurrentFitnessFromGarmin(): Promise<GarminFitnessEstimationResponse> {
    const res = await fetch(`${this.baseUrl}/api/goals/estimate-from-garmin`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to estimate fitness (${res.status})`);
    }
    return body;
  }

  /**
   * Links the user's Garmin Connect account (stores AES-256-GCM encrypted OAuth tokens in Neon DB).
   */
  public async connectGarminAccount(input: {
    email: string;
    password: string;
    mfaCode?: string;
  }): Promise<{
    status: GarminConnectionStatus;
    message: string;
  }> {
    const res = await fetch(`${this.baseUrl}/api/garmin/connect`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Garmin login failed (${res.status})`);
    }
    return body;
  }

  /**
   * Verifies a 6-digit Garmin MFA code if 2FA was triggered.
   */
  public async verifyGarminMfa(mfaCode: string): Promise<{
    status: GarminConnectionStatus;
    message: string;
  }> {
    const res = await fetch(`${this.baseUrl}/api/garmin/mfa`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ mfaCode }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `MFA verification failed (${res.status})`);
    }
    return body;
  }

  /**
   * Pulls daily health metrics (HRV, Sleep Score, Resting HR, Body Battery, Steps) from Garmin Connect.
   */
  public async syncGarminDailyMetrics(input?: {
    date?: string;
    perceivedFatigue?: number;
    note?: string;
  }): Promise<{
    metric: any;
    garminSummary: GarminDailySummary;
  }> {
    const res = await fetch(`${this.baseUrl}/api/garmin/sync/metrics`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(input || {}),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to sync Garmin metrics (${res.status})`);
    }
    return body;
  }

  /**
   * Pulls recent completed activities from Garmin Connect.
   */
  public async syncGarminActivities(limit: number = 5): Promise<{
    syncedCount: number;
    activities: GarminActivitySummary[];
  }> {
    const res = await fetch(`${this.baseUrl}/api/garmin/sync/activities`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ limit }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to sync Garmin activities (${res.status})`);
    }
    return body;
  }

  /**
   * Disconnects the Garmin Connect account and deletes encrypted session tokens from database.
   */
  public async disconnectGarminAccount(): Promise<{
    connected: boolean;
    message: string;
  }> {
    const res = await fetch(`${this.baseUrl}/api/garmin/disconnect`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to disconnect Garmin account (${res.status})`);
    }
    return body;
  }

  public async pushWorkoutToGarmin(workoutId: string): Promise<{
    garminWorkoutId: string;
    scheduledDate: string;
  }> {
    const res = await fetch(
      `${this.baseUrl}/api/garmin/workouts/${workoutId}/push`,
      {
        method: 'POST',
        headers: this.getHeaders(),
      }
    );
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to push workout to Garmin (${res.status})`);
    }
    return body;
  }

  public async convertWorkoutModality(
    workoutId: string,
    targetType: WorkoutType.BIKE | WorkoutType.RUN | WorkoutType.HYBRID,
    riderWeightKg: number = 74
  ): Promise<WorkoutData> {
    const res = await fetch(
      `${this.baseUrl}/api/garmin/workouts/${workoutId}/convert`,
      {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ targetType, riderWeightKg }),
      }
    );
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to convert workout modality (${res.status})`);
    }
    return body.workout;
  }

  public async recordIndoorSession(input: {
    equipmentType: WorkoutType.BIKE | WorkoutType.TREADMILL;
    title?: string;
    samples?: MatrixIndoorSample[];
    durationSeconds?: number;
    distanceMeters?: number;
    averagePowerWatts?: number;
    averageHeartRateBpm?: number;
    averageCadenceRpm?: number;
    averageInclinePercent?: number;
    notes?: string;
  }): Promise<{
    workout: WorkoutData;
    summary: any;
    garminSync: {
      uploadedToGarminConnect: boolean;
      garminActivityId: string;
      fitFile: {
        fileName: string;
        sizeBytes: number;
        signature: string;
        crcValid: boolean;
        base64: string;
      };
    };
  }> {
    const res = await fetch(`${this.baseUrl}/api/indoor/sessions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(input),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || `Failed to record indoor session (${res.status})`);
    }
    return body;
  }
}

export const apiClient = new GarminTrainerApiClient();
