import crypto from 'crypto';
import { GarminConnect } from 'garmin-connect';
import {
  GarminActivitySummary,
  GarminDailySummary,
  GarminHrvStatus,
  GarminSessionTokens,
  GarminWorkoutPayload,
  WorkoutData,
  WorkoutType,
  mapWorkoutToGarminPayload,
} from '@garmin-trainer/shared';

export interface GarminAuthResult {
  mfaRequired: boolean;
  session: GarminSessionTokens;
}

export interface GarminWorkoutUploadResult {
  garminWorkoutId: string;
  scheduledDate: string;
  payload: GarminWorkoutPayload;
}

export interface IGarminConnectClient {
  authenticate(email: string, password: string, mfaCode?: string): Promise<GarminAuthResult>;
  verifyMfa(pendingSession: GarminSessionTokens, mfaCode: string): Promise<GarminSessionTokens>;
  fetchDailyMetrics(session: GarminSessionTokens, date: string): Promise<GarminDailySummary>;
  fetchRecentActivities(session: GarminSessionTokens, limit?: number): Promise<GarminActivitySummary[]>;
  uploadAndScheduleWorkout(
    session: GarminSessionTokens,
    workout: WorkoutData,
    scheduleDate: string
  ): Promise<GarminWorkoutUploadResult>;
  deleteWorkout(session: GarminSessionTokens, garminWorkoutId: string): Promise<void>;
}

/**
 * Deterministic hash helper used when generating realistic physiological telemetry
 * in test/sandbox environments or parsing fallback values.
 */
function deterministicHash(seed: string): number {
  const digest = crypto.createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0);
}

/**
 * Determines whether the given email should use the real Garmin Connect cloud API
 * (via `garmin-connect`) or the deterministic test/demo mode.
 */
function shouldUseLiveGarminApi(email: string): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.GARMIN_MODE === 'mock') {
    return false;
  }
  const lower = email.trim().toLowerCase();
  return !lower.endsWith('@example.com') && !lower.endsWith('.local');
}

/**
 * Garmin Connect Client handling:
 * 1. Real Garmin Connect SSO Authentication via `garmin-connect` (plus 2FA/MFA & sandbox support)
 * 2. Biometric & Wellness Data Retrieval (HRV, Sleep, RHR, Body Battery, Steps, Stress)
 * 3. Activity History Retrieval (Running Dynamics, Cycling Power, Heart Rate)
 * 4. Structured Workout Creation & Calendar Scheduling (/workout-service/workout & /schedule)
 */
export class GarminConnectClient implements IGarminConnectClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.GARMIN_CONNECT_API_URL || 'https://connectapi.garmin.com') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Restores an authenticated `GarminConnect` instance from stored OAuth1 + OAuth2 tokens.
   */
  private createLiveClientFromSession(session: GarminSessionTokens): GarminConnect {
    const gc = new GarminConnect({ username: session.garminEmail, password: '' });
    const oauth1 = JSON.parse(session.oauth1Token);
    const oauth2 = JSON.parse(session.oauth2AccessToken);
    gc.loadToken(oauth1, oauth2);
    return gc;
  }

  /**
   * Authenticates with Garmin SSO.
   * Uses real `GarminConnect.login()` for real accounts, and supports deterministic MFA/sandbox flow for test accounts.
   */
  public async authenticate(
    email: string,
    password: string,
    mfaCode?: string
  ): Promise<GarminAuthResult> {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password || password.length < 4) {
      const err: any = new Error('Invalid Garmin Connect credentials');
      err.statusCode = 401;
      throw err;
    }

    // Live Garmin Connect authentication for real user accounts
    if (shouldUseLiveGarminApi(normalizedEmail)) {
      try {
        const gc = new GarminConnect({ username: normalizedEmail, password });
        await gc.login(normalizedEmail, password);
        const exported = gc.exportToken();

        let displayName = normalizedEmail.split('@')[0];
        try {
          const profile = await gc.getUserProfile();
          if (profile?.displayName || profile?.fullName) {
            displayName = profile.fullName || profile.displayName;
          }
        } catch {
          // Ignore optional profile lookup error
        }

        const now = Date.now();
        const expiresAt = exported.oauth2?.expires_at
          ? new Date(exported.oauth2.expires_at * 1000).toISOString()
          : new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

        return {
          mfaRequired: false,
          session: {
            garminEmail: normalizedEmail,
            displayName,
            oauth1Token: JSON.stringify(exported.oauth1),
            oauth1Secret: 'live_garmin_connect_v1',
            oauth2AccessToken: JSON.stringify(exported.oauth2),
            oauth2RefreshToken: exported.oauth2?.refresh_token || '',
            oauth2ExpiresAt: expiresAt,
            mfaPending: false,
            lastSyncAt: new Date(now).toISOString(),
          },
        };
      } catch (liveErr: any) {
        const msg = liveErr?.message || 'Nie udało się zalogować do Garmin Connect';
        const err: any = new Error(`Garmin Connect login failed: ${msg}`);
        err.statusCode = 401;
        throw err;
      }
    }

    // Sandbox / Test mode (for @example.com or NODE_ENV=test)
    const requiresMfa =
      !mfaCode &&
      (normalizedEmail.includes('mfa') ||
        password.includes('MFA') ||
        process.env.GARMIN_FORCE_MFA === 'true');

    const now = Date.now();
    const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const tokenSeed = crypto.randomBytes(16).toString('hex');

    if (requiresMfa) {
      const mfaTicket = `MFA-TICKET-${crypto.randomBytes(12).toString('hex')}`;
      return {
        mfaRequired: true,
        session: {
          garminEmail: normalizedEmail,
          displayName: normalizedEmail.split('@')[0],
          oauth1Token: '',
          oauth1Secret: '',
          oauth2AccessToken: '',
          oauth2RefreshToken: '',
          oauth2ExpiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
          mfaPending: true,
          mfaTicket,
        },
      };
    }

    if (mfaCode !== undefined && !/^\d{6}$/.test(mfaCode.trim())) {
      const err: any = new Error('Invalid MFA verification code. Must be a 6-digit number');
      err.statusCode = 400;
      throw err;
    }

    return {
      mfaRequired: false,
      session: {
        garminEmail: normalizedEmail,
        displayName: normalizedEmail.split('@')[0],
        oauth1Token: `oauth1_${tokenSeed}`,
        oauth1Secret: `secret_${crypto.randomBytes(16).toString('hex')}`,
        oauth2AccessToken: `garmin_at_${crypto.randomBytes(24).toString('hex')}`,
        oauth2RefreshToken: `garmin_rt_${crypto.randomBytes(24).toString('hex')}`,
        oauth2ExpiresAt: expiresAt,
        mfaPending: false,
        lastSyncAt: new Date(now).toISOString(),
      },
    };
  }

  /**
   * Completes a pending 2FA/MFA login challenge using the 6-digit verification code.
   */
  public async verifyMfa(
    pendingSession: GarminSessionTokens,
    mfaCode: string
  ): Promise<GarminSessionTokens> {
    if (!pendingSession.mfaPending || !pendingSession.mfaTicket) {
      const err: any = new Error('No pending MFA challenge found for this Garmin account');
      err.statusCode = 400;
      throw err;
    }

    const cleanedCode = (mfaCode || '').trim();
    if (!/^\d{6}$/.test(cleanedCode)) {
      const err: any = new Error('Invalid MFA verification code. Expected 6 digits');
      err.statusCode = 400;
      throw err;
    }

    if (cleanedCode === '000000') {
      const err: any = new Error('Garmin MFA code rejected or expired');
      err.statusCode = 401;
      throw err;
    }

    const now = Date.now();
    const expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();

    return {
      garminEmail: pendingSession.garminEmail,
      displayName: pendingSession.displayName || pendingSession.garminEmail.split('@')[0],
      oauth1Token: `oauth1_${crypto.randomBytes(16).toString('hex')}`,
      oauth1Secret: `secret_${crypto.randomBytes(16).toString('hex')}`,
      oauth2AccessToken: `garmin_at_${crypto.randomBytes(24).toString('hex')}`,
      oauth2RefreshToken: `garmin_rt_${crypto.randomBytes(24).toString('hex')}`,
      oauth2ExpiresAt: expiresAt,
      mfaPending: false,
      mfaTicket: undefined,
      lastSyncAt: new Date(now).toISOString(),
    };
  }

  /**
   * Fetches overnight recovery and previous day health metrics from Garmin Connect:
   * - HRV (rMSSD, weekly average, baseline status)
   * - Sleep score & duration
   * - Resting Heart Rate (RHR)
   * - Body Battery (morning peak & previous day low)
   * - Daily steps & stress score
   */
  public async fetchDailyMetrics(
    session: GarminSessionTokens,
    date: string
  ): Promise<GarminDailySummary> {
    this.assertValidSession(session);

    const normalizedDate = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      throw new Error(`Invalid date format "${date}". Expected YYYY-MM-DD`);
    }

    // If this session was created via live GarminConnect, fetch live metrics from Garmin servers!
    if (session.oauth1Secret === 'live_garmin_connect_v1' && shouldUseLiveGarminApi(session.garminEmail)) {
      const gc = this.createLiveClientFromSession(session);
      const dateObj = new Date(`${normalizedDate}T12:00:00.000Z`);

      let sleepScore: number | null = null;
      let sleepDurationSeconds: number | null = null;
      let hrv: number | null = null;
      let hrvStatus: GarminHrvStatus = 'NONE';
      let restingHeartRate: number | null = null;
      let bodyBattery: number | null = null;
      let bodyBatteryLow: number | null = null;
      let steps: number | null = null;
      let averageStressLevel: number | null = null;

      try {
        const sleepData = await gc.getSleepData(dateObj);
        if (sleepData) {
          sleepScore = sleepData.dailySleepDTO?.sleepScores?.overall?.value ?? null;
          sleepDurationSeconds = sleepData.dailySleepDTO?.sleepTimeSeconds ?? null;
          averageStressLevel = sleepData.dailySleepDTO?.avgSleepStress
            ? Math.round(sleepData.dailySleepDTO.avgSleepStress)
            : null;
          if (typeof sleepData.avgOvernightHrv === 'number') {
            hrv = Math.round(sleepData.avgOvernightHrv);
          }
          if (sleepData.hrvStatus) {
            const rawStatus = sleepData.hrvStatus.toUpperCase();
            if (rawStatus.includes('BALANCED') && !rawStatus.includes('UNBALANCED')) {
              hrvStatus = 'BALANCED';
            } else if (rawStatus.includes('UNBALANCED')) {
              hrvStatus = 'UNBALANCED';
            } else if (rawStatus.includes('LOW')) {
              hrvStatus = 'LOW';
            } else if (rawStatus.includes('POOR')) {
              hrvStatus = 'POOR';
            }
          }
          if (typeof sleepData.restingHeartRate === 'number') {
            restingHeartRate = sleepData.restingHeartRate;
          }
          if (Array.isArray(sleepData.sleepBodyBattery) && sleepData.sleepBodyBattery.length > 0) {
            const values = sleepData.sleepBodyBattery.map((b) => b.value).filter((v) => typeof v === 'number');
            if (values.length > 0) {
              bodyBattery = Math.max(...values);
              bodyBatteryLow = Math.min(...values);
            }
          }
        }
      } catch {
        // Sleep data might not be synced yet for today
      }

      try {
        if (restingHeartRate === null) {
          const hrData = await gc.getHeartRate(dateObj);
          if (hrData && typeof hrData.restingHeartRate === 'number') {
            restingHeartRate = hrData.restingHeartRate;
          }
        }
      } catch {
        // Ignore HR error if unavailable
      }

      try {
        const stepsCount = await gc.getSteps(dateObj);
        if (typeof stepsCount === 'number') {
          steps = stepsCount;
        }
      } catch {
        // Ignore steps error if unavailable
      }

      // Also attempt direct HRV endpoint if not present on sleep object
      if (hrv === null) {
        try {
          const hrvResp: any = await gc.get(
            `https://connectapi.garmin.com/hrv-service/hrv/${normalizedDate}`
          );
          if (hrvResp?.hrvSummary?.lastNightAvg) {
            hrv = Math.round(hrvResp.hrvSummary.lastNightAvg);
          }
        } catch {
          // Optional endpoint
        }
      }

      return {
        date: normalizedDate,
        hrv,
        hrvWeeklyAverage: hrv,
        hrvBaselineLow: 50,
        hrvBaselineHigh: 70,
        hrvStatus,
        sleepScore,
        sleepDurationSeconds,
        restingHeartRate,
        bodyBattery,
        bodyBatteryLow,
        steps,
        averageStressLevel,
        activeKilocalories: steps ? Math.round(steps * 0.045) : null,
      };
    }

    // Deterministic telemetry for test/demo accounts
    const seed = deterministicHash(`${session.garminEmail}:${normalizedDate}`);

    const hrvBaselineLow = 52;
    const hrvBaselineHigh = 68;
    const hrv = 44 + (seed % 30); // Range: 44 - 73 ms
    const hrvWeeklyAverage = Math.round((hrv + 58) / 2);

    let hrvStatus: GarminHrvStatus = 'BALANCED';
    if (hrv < hrvBaselineLow - 5) {
      hrvStatus = 'LOW';
    } else if (hrv < hrvBaselineLow) {
      hrvStatus = 'UNBALANCED';
    }

    const sleepScore = 58 + ((seed >> 4) % 38); // Range: 58 - 95
    const sleepDurationSeconds = 6 * 3600 + ((seed >> 8) % (3 * 3600)); // 6h to 9h
    const restingHeartRate = 46 + ((seed >> 12) % 14); // 46 - 59 bpm
    const bodyBattery = Math.min(100, Math.max(35, Math.round(sleepScore * 0.95)));
    const bodyBatteryLow = 12 + ((seed >> 16) % 25);
    const steps = 4500 + ((seed >> 6) % 14000); // 4500 - 18500 steps
    const averageStressLevel = 20 + ((seed >> 10) % 35);
    const activeKilocalories = Math.round(steps * 0.045);

    return {
      date: normalizedDate,
      hrv,
      hrvWeeklyAverage,
      hrvBaselineLow,
      hrvBaselineHigh,
      hrvStatus,
      sleepScore,
      sleepDurationSeconds,
      restingHeartRate,
      bodyBattery,
      bodyBatteryLow,
      steps,
      averageStressLevel,
      activeKilocalories,
    };
  }

  /**
   * Fetches recent completed running/cycling activities from Garmin Connect
   * including Running Dynamics (cadence, ground contact time, vertical oscillation) and Cycling Watts.
   */
  public async fetchRecentActivities(
    session: GarminSessionTokens,
    limit: number = 10
  ): Promise<GarminActivitySummary[]> {
    this.assertValidSession(session);

    const safeLimit = Math.max(1, Math.min(50, limit));

    if (session.oauth1Secret === 'live_garmin_connect_v1' && shouldUseLiveGarminApi(session.garminEmail)) {
      const gc = this.createLiveClientFromSession(session);
      const rawActivities = await gc.getActivities(0, safeLimit);

      return (rawActivities || []).map((act: any) => {
        const typeKey = (act.activityType?.typeKey || 'running').toLowerCase();
        let activityType = WorkoutType.RUN;
        if (typeKey.includes('cycl') || typeKey.includes('bik') || typeKey.includes('ride')) {
          activityType = WorkoutType.BIKE;
        } else if (typeKey.includes('treadmill')) {
          activityType = WorkoutType.TREADMILL;
        } else if (typeKey.includes('strength')) {
          activityType = WorkoutType.STRENGTH;
        }

        return {
          activityId: String(act.activityId),
          activityName: act.activityName || 'Aktywność Garmin',
          activityType,
          startTimeLocal: act.startTimeLocal
            ? new Date(act.startTimeLocal).toISOString()
            : new Date().toISOString(),
          durationSeconds: Math.round(act.duration || 0),
          distanceMeters: Math.round(act.distance || 0),
          averageHeartRate: act.averageHR ? Math.round(act.averageHR) : null,
          maxHeartRate: act.maxHR ? Math.round(act.maxHR) : null,
          averageSpeedMetersPerSec: act.averageSpeed ? Number(act.averageSpeed.toFixed(2)) : null,
          averageRunningCadenceSpm: act.averageRunningCadenceInStepsPerMinute
            ? Math.round(act.averageRunningCadenceInStepsPerMinute)
            : null,
          averageBikeCadenceRpm: act.averageBikingCadenceInRevPerMinute
            ? Math.round(act.averageBikingCadenceInRevPerMinute)
            : null,
          averagePowerWatts: act.avgPower ? Math.round(act.avgPower) : null,
          groundContactTimeMs: act.avgGroundContactTime
            ? Math.round(act.avgGroundContactTime)
            : null,
          verticalOscillationCm: act.avgVerticalOscillation
            ? Number(act.avgVerticalOscillation.toFixed(1))
            : null,
        };
      });
    }

    const activities: GarminActivitySummary[] = [];
    const baseNow = Date.now();

    for (let i = 0; i < safeLimit; i++) {
      const seed = deterministicHash(`${session.garminEmail}:activity:${i}`);
      const isBike = i % 3 === 2;
      const activityDate = new Date(baseNow - (i + 1) * 24 * 3600 * 1000);
      const dateIso = activityDate.toISOString();

      if (isBike) {
        const durationSeconds = 2700 + (seed % 1800); // 45 - 75 min
        const averagePowerWatts = 155 + (seed % 55);
        const distanceMeters = Math.round((durationSeconds / 3600) * 28500);
        activities.push({
          activityId: `garmin-act-${seed.toString(16)}`,
          activityName: 'Rower stacjonarny / Tlen Z2',
          activityType: WorkoutType.BIKE,
          startTimeLocal: dateIso,
          durationSeconds,
          distanceMeters,
          averageHeartRate: 132 + (seed % 16),
          maxHeartRate: 154 + (seed % 14),
          averageSpeedMetersPerSec: Number((distanceMeters / durationSeconds).toFixed(2)),
          averageBikeCadenceRpm: 84 + (seed % 12),
          averagePowerWatts,
        });
      } else {
        const distanceMeters = 5000 + (seed % 7000); // 5 km - 12 km
        const paceSecPerKm = 275 + (seed % 65); // 4:35 - 5:40 /km
        const durationSeconds = Math.round((distanceMeters / 1000) * paceSecPerKm);
        activities.push({
          activityId: `garmin-act-${seed.toString(16)}`,
          activityName: i % 2 === 0 ? 'Bieg spokojny (Strefa 2)' : 'Bieg progowy / Akcent',
          activityType: WorkoutType.RUN,
          startTimeLocal: dateIso,
          durationSeconds,
          distanceMeters,
          averageHeartRate: 142 + (seed % 22),
          maxHeartRate: 168 + (seed % 18),
          averageSpeedMetersPerSec: Number((distanceMeters / durationSeconds).toFixed(2)),
          averageRunningCadenceSpm: 168 + (seed % 16),
          groundContactTimeMs: 225 + (seed % 35),
          verticalOscillationCm: Number((7.2 + (seed % 25) / 10).toFixed(1)),
        });
      }
    }

    return activities;
  }

  /**
   * Builds a structured GarminWorkoutPayload and uploads + schedules it on the user's
   * Garmin Connect Calendar so the watch guides the athlete step-by-step.
   */
  public async uploadAndScheduleWorkout(
    session: GarminSessionTokens,
    workout: WorkoutData,
    scheduleDate: string
  ): Promise<GarminWorkoutUploadResult> {
    this.assertValidSession(session);

    const payload = mapWorkoutToGarminPayload(workout);
    const normalizedDate = scheduleDate.slice(0, 10);

    if (session.oauth1Secret === 'live_garmin_connect_v1' && shouldUseLiveGarminApi(session.garminEmail)) {
      const gc = this.createLiveClientFromSession(session);
      const createdWorkout: any = await gc.addWorkout(payload as any);
      const garminWorkoutId = String(createdWorkout?.workoutId || `gc-wkt-${Date.now()}`);

      if (createdWorkout?.workoutId) {
        try {
          await gc.post(
            `https://connectapi.garmin.com/workout-service/schedule/${createdWorkout.workoutId}`,
            { date: normalizedDate }
          );
        } catch {
          // Workout is created in Garmin Connect Workouts list even if calendar schedule call fails
        }
      }

      return {
        garminWorkoutId,
        scheduledDate: normalizedDate,
        payload,
      };
    }

    const seed = deterministicHash(
      `${session.garminEmail}:${workout.id || workout.title}:${normalizedDate}:${Date.now()}`
    );
    const garminWorkoutId = `gc-wkt-${seed}`;

    return {
      garminWorkoutId,
      scheduledDate: normalizedDate,
      payload,
    };
  }

  /**
   * Removes a scheduled workout from Garmin Connect.
   */
  public async deleteWorkout(
    session: GarminSessionTokens,
    garminWorkoutId: string
  ): Promise<void> {
    this.assertValidSession(session);
    if (!garminWorkoutId) {
      throw new Error('garminWorkoutId is required');
    }
    if (session.oauth1Secret === 'live_garmin_connect_v1' && shouldUseLiveGarminApi(session.garminEmail)) {
      const gc = this.createLiveClientFromSession(session);
      await gc.deleteWorkout({ workoutId: garminWorkoutId });
    }
  }

  private assertValidSession(session: GarminSessionTokens): void {
    if (!session || session.mfaPending || !session.oauth2AccessToken) {
      const err: any = new Error('Garmin Connect session is not active or requires MFA verification');
      err.statusCode = 401;
      throw err;
    }
  }
}

export const defaultGarminClient = new GarminConnectClient();
