// =============================================================================
// User & Authentication Enums and Interfaces (R1, R2, R3)
// =============================================================================

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterDto {
  email: string;
  password: string;
  name?: string;
  role?: UserRole;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
}

export interface AuthResponse {
  user: UserProfile;
  token: string;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// =============================================================================
// Encryption & Security Types (R3)
// =============================================================================

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface EncryptedResult extends EncryptedPayload {
  packed: string; // Format: "iv:authTag:ciphertext"
}

export interface GarminAuthData {
  userId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  expiresAt?: string | null;
}

// =============================================================================
// Garmin Connect Integration Types (Phase 2)
// =============================================================================

export interface GarminConnectCredentialsDto {
  email: string;
  password?: string;
  mfaCode?: string;
}

export interface GarminSessionTokens {
  garminEmail: string;
  displayName?: string;
  oauth1Token: string;
  oauth1Secret: string;
  oauth2AccessToken: string;
  oauth2RefreshToken: string;
  oauth2ExpiresAt: string;
  mfaPending?: boolean;
  mfaTicket?: string;
  lastSyncAt?: string;
}

export interface GarminConnectionStatus {
  connected: boolean;
  mfaPending: boolean;
  garminEmail?: string | null;
  displayName?: string | null;
  expiresAt?: string | null;
  lastSyncAt?: string | null;
}

export type GarminHrvStatus = 'BALANCED' | 'UNBALANCED' | 'LOW' | 'POOR' | 'NONE';

export interface GarminDailySummary {
  date: string; // YYYY-MM-DD
  hrv: number | null; // Overnight rMSSD (ms)
  hrvWeeklyAverage?: number | null;
  hrvBaselineLow?: number | null;
  hrvBaselineHigh?: number | null;
  hrvStatus?: GarminHrvStatus;
  sleepScore: number | null; // 0-100
  sleepDurationSeconds?: number | null;
  restingHeartRate: number | null; // bpm
  bodyBattery: number | null; // Morning / peak Body Battery (0-100)
  bodyBatteryLow?: number | null; // Lowest Body Battery from previous day
  steps: number | null;
  averageStressLevel?: number | null; // 0-100
  activeKilocalories?: number | null;
}

export interface GarminActivitySummary {
  activityId: string;
  activityName: string;
  activityType: WorkoutType;
  startTimeLocal: string;
  durationSeconds: number;
  distanceMeters: number;
  averageHeartRate?: number | null;
  maxHeartRate?: number | null;
  averageSpeedMetersPerSec?: number | null;
  averageRunningCadenceSpm?: number | null;
  averageBikeCadenceRpm?: number | null;
  averagePowerWatts?: number | null;
  groundContactTimeMs?: number | null;
  verticalOscillationCm?: number | null;
}

export interface GarminSportType {
  sportTypeId: number;
  sportTypeKey: 'running' | 'cycling' | 'strength_training' | 'other';
}

export interface GarminStepType {
  stepTypeId: number;
  stepTypeKey: 'warmup' | 'cooldown' | 'interval' | 'recovery' | 'rest';
}

export interface GarminEndCondition {
  conditionTypeId: number;
  conditionTypeKey: 'time' | 'distance' | 'lap.button';
}

export interface GarminTargetType {
  workoutTargetTypeId: number;
  workoutTargetTypeKey:
    | 'no.target'
    | 'power.zone'
    | 'cadence'
    | 'heart.rate.zone'
    | 'speed.zone'
    | 'pace.zone';
}

export interface GarminExecutableStepDto {
  type: 'ExecutableStepDTO';
  stepId: number | null;
  stepOrder: number;
  stepType: GarminStepType;
  endCondition: GarminEndCondition;
  endConditionValue: number | null;
  targetType: GarminTargetType;
  targetValueOne?: number | null;
  targetValueTwo?: number | null;
  zoneNumber?: number | null;
  description?: string | null;
}

export interface GarminWorkoutSegment {
  segmentOrder: number;
  sportType: GarminSportType;
  workoutSteps: GarminExecutableStepDto[];
}

export interface GarminWorkoutPayload {
  workoutName: string;
  description?: string | null;
  sportType: GarminSportType;
  workoutSegments: GarminWorkoutSegment[];
}

// =============================================================================
// Training Goals & Preferences (R2)
// =============================================================================

export enum TargetDistance {
  FIVE_K = '5K',
  TEN_K = '10K',
  HALF_MARATHON = 'HALF_MARATHON',
  MARATHON = 'MARATHON',
  CUSTOM = 'CUSTOM',
}

export enum TrainingPreference {
  RUN_ONLY = 'RUN_ONLY',
  HYBRID = 'HYBRID',
}

export interface TrainingGoalData {
  id?: string;
  userId?: string;
  targetDistance: TargetDistance;
  customDistanceMeters?: number | null;
  targetTimeSeconds: number;
  eventDate: string;
  preference: TrainingPreference;
  currentVdot: number;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// Daily Health & Readiness Metrics (R2)
// =============================================================================

export interface DailyMetricData {
  id?: string;
  userId?: string;
  date: string;
  hrv?: number | null;
  sleepScore?: number | null;
  restingHr?: number | null;
  bodyBattery?: number | null;
  steps?: number | null;
  fatigue: number; // Scale: 1 (fresh) to 5 (exhausted)
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// Workouts & Structured Steps (R2)
// =============================================================================

export enum WorkoutType {
  RUN = 'RUN',
  BIKE = 'BIKE',
  HYBRID = 'HYBRID',
  TREADMILL = 'TREADMILL',
  STRENGTH = 'STRENGTH',
  OTHER = 'OTHER',
}

export enum WorkoutStatus {
  PLANNED = 'PLANNED',
  COMPLETED = 'COMPLETED',
  SKIPPED = 'SKIPPED',
  MODIFIED = 'MODIFIED',
}

export enum StepType {
  WARMUP = 'WARMUP',
  ACTIVE = 'ACTIVE',
  RECOVERY = 'RECOVERY',
  COOLDOWN = 'COOLDOWN',
  REPEAT = 'REPEAT',
}

export interface WorkoutStep {
  stepNumber: number;
  type: StepType;
  durationSeconds?: number;
  distanceMeters?: number;
  targetPace?: string;
  targetHeartRateZone?: number;
  targetWatts?: number;
  targetCadence?: number;
  notes?: string;
}

export interface WorkoutData {
  id?: string;
  userId?: string;
  date: string;
  type: WorkoutType;
  title: string;
  description?: string | null;
  steps: WorkoutStep[];
  status: WorkoutStatus;
  garminWorkoutId?: string | null;
  scheduledTime?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// Biomechanical & Technique Video Analysis (R2)
// =============================================================================

export enum FlawSeverity {
  MILD = 'MILD',
  MODERATE = 'MODERATE',
  SEVERE = 'SEVERE',
}

export interface BiomechanicalFlaw {
  flawType: string;
  description: string;
  severity: FlawSeverity;
  timestampSeconds?: number;
}

export interface CorrectiveExercise {
  name: string;
  description: string;
  targetMuscleGroup: string;
  suggestedRepsOrDuration: string;
  videoDemoUrl?: string;
}

export interface TechniqueAnalysisData {
  id?: string;
  userId?: string;
  date: string;
  videoUrl: string;
  biomechanicalFlaws: BiomechanicalFlaw[];
  correctiveExercises: CorrectiveExercise[];
  generalNotes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// =============================================================================
// Standard API Envelope
// =============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
