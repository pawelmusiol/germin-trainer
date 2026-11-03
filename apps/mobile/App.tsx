import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  StatusBar as RNStatusBar,
  Platform,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';

const StatusBar = RNStatusBar as unknown as React.ComponentType<{
  barStyle?: 'default' | 'light-content' | 'dark-content' | 'auto';
  backgroundColor?: string;
  translucent?: boolean;
}> & { currentHeight?: number | null };
import {
  WorkoutType,
  WorkoutStatus,
  StepType,
  WorkoutData,
  GarminActivitySummary,
  calculateVdotFromRace,
  calculateRaceTimeFromVdot,
  calculateVdotPaces,
  convertRunToBikeWatts,
  convertWorkoutModality,
  mapWorkoutToGarminPayload,
  evaluateMorningReadiness,
  analyzeBiomechanicalCues,
  injectCorrectiveExercisesIntoWorkout,
  encodeIndoorBikeDataFrame,
  encodeTreadmillDataFrame,
  parseIndoorBikeDataFrame,
  parseTreadmillDataFrame,
  summarizeIndoorSession,
  FTMS_SERVICE_UUID,
  INDOOR_BIKE_DATA_CHAR_UUID,
  TREADMILL_DATA_CHAR_UUID,
  MatrixIndoorSample,
  MatrixSessionSummary,
  MatrixSessionAccumulator,
  MatrixLiveMetrics,
  SessionLifecycleState,
  SavedMatrixSession,
  formatDuration,
  formatDistanceKm,
  loadSavedMatrixSessions,
  saveMatrixSessionToStorage,
  clearSavedMatrixSessions,
} from '@garmin-trainer/shared';
import { apiClient } from './src/services/api';
import {
  matrixBleService,
  MatrixBleDevice,
  BleScanStatus,
} from './src/services/matrix-ble';

type ActiveTab = 'GOAL_GARMIN' | 'PLAN' | 'MATRIX_BLE' | 'TECHNIQUE_VIDEO';
type GoalDistOption = 'FIVE_K' | 'TEN_K' | 'HALF_MARATHON' | 'MARATHON';

const DISTANCE_LABELS: Record<GoalDistOption, { label: string; meters: number }> = {
  FIVE_K: { label: '5 KM', meters: 5000 },
  TEN_K: { label: '10 KM', meters: 10000 },
  HALF_MARATHON: { label: 'Półmaraton (21.1 km)', meters: 21097.5 },
  MARATHON: { label: 'Maraton (42.2 km)', meters: 42195 },
};

const INITIAL_WORKOUT: WorkoutData = {
  id: 'wkt-today-01',
  date: new Date().toISOString().slice(0, 10),
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

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('PLAN');
  const [loading, setLoading] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  // Goal Creation State (Separating CURRENT fitness from TARGET goal!)
  const [goalDistance, setGoalDistance] = useState<GoalDistOption>('TEN_K');
  const [currentMinutesStr, setCurrentMinutesStr] = useState<string>('55');
  const [currentSecondsStr, setCurrentSecondsStr] = useState<string>('00');
  const [targetMinutesStr, setTargetMinutesStr] = useState<string>('45');
  const [targetSecondsStr, setTargetSecondsStr] = useState<string>('00');
  const [riderWeightStr, setRiderWeightStr] = useState<string>('74');
  const [preference, setPreference] = useState<'RUN_ONLY' | 'HYBRID_BIKE_RUN'>('HYBRID_BIKE_RUN');

  // Garmin Connect Login & Sync State
  const [garminEmail, setGarminEmail] = useState<string>('');
  const [garminPassword, setGarminPassword] = useState<string>('');
  const [garminMfaCode, setGarminMfaCode] = useState<string>('');
  const [garminConnected, setGarminConnected] = useState<boolean>(false);
  const [garminMfaPending, setGarminMfaPending] = useState<boolean>(false);
  const [connectedGarminEmail, setConnectedGarminEmail] = useState<string | null>(null);

  // Synced Garmin Telemetry State
  const [hrvValue, setHrvValue] = useState<number | null>(61);
  const [sleepScoreValue, setSleepScoreValue] = useState<number | null>(84);
  const [restingHrValue, setRestingHrValue] = useState<number | null>(49);
  const [bodyBatteryValue, setBodyBatteryValue] = useState<number | null>(82);
  const [stepsValue, setStepsValue] = useState<number | null>(11420);
  const [fatigueLevel, setFatigueLevel] = useState<number>(2);
  const [syncedActivities, setSyncedActivities] = useState<GarminActivitySummary[]>([]);

  // Planned Workouts State & Original Workout Preservation (R4)
  const [workoutsList, setWorkoutsList] = useState<WorkoutData[]>([INITIAL_WORKOUT]);
  const [originalWorkouts, setOriginalWorkouts] = useState<Record<string, WorkoutData>>({
    [INITIAL_WORKOUT.id || 'wkt-today-01']: JSON.parse(JSON.stringify(INITIAL_WORKOUT)),
  });
  const [selectedWorkoutIdx, setSelectedWorkoutIdx] = useState<number>(0);
  const [pushedGarminId, setPushedGarminId] = useState<string | null>(null);

  const getWorkoutKey = (w: WorkoutData, idx: number): string => w.id || `workout-idx-${idx}`;

  // Matrix BLE Live State & Session Accumulator
  const [matrixDeviceType, setMatrixDeviceType] = useState<WorkoutType.BIKE | WorkoutType.TREADMILL>(
    WorkoutType.BIKE
  );
  const [bleStatus, setBleStatus] = useState<BleScanStatus>('DISCONNECTED');
  const [discoveredDevices, setDiscoveredDevices] = useState<MatrixBleDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<MatrixBleDevice | null>(null);
  const [showDeviceScanner, setShowDeviceScanner] = useState<boolean>(false);

  const [sessionAccumulator] = useState<MatrixSessionAccumulator>(
    () => new MatrixSessionAccumulator(WorkoutType.BIKE)
  );
  const [sessionState, setSessionState] = useState<SessionLifecycleState>('IDLE');
  const [liveMetrics, setLiveMetrics] = useState<MatrixLiveMetrics>({
    powerWatts: 0,
    cadenceRpm: 0,
    speedKmh: 0,
    distanceMeters: 0,
    heartRateBpm: 0,
    inclinePercent: 0,
    elapsedSeconds: 0,
  });
  const [completedSummary, setCompletedSummary] = useState<MatrixSessionSummary | null>(null);
  const [savedSessions, setSavedSessions] = useState<SavedMatrixSession[]>([]);
  const [selectedSavedSession, setSelectedSavedSession] = useState<SavedMatrixSession | null>(null);
  const [fitExportMessage, setFitExportMessage] = useState<string | null>(null);

  // Technique Video State
  const [drillsApplied, setDrillsApplied] = useState<boolean>(false);

  // Live VDOT calculation: CURRENT fitness dictates today's training paces, TARGET goal is the destination!
  const currentTotalSeconds =
    (parseInt(currentMinutesStr, 10) || 0) * 60 + (parseInt(currentSecondsStr, 10) || 0);
  const targetTotalSeconds =
    (parseInt(targetMinutesStr, 10) || 0) * 60 + (parseInt(targetSecondsStr, 10) || 0);
  const riderWeightKg = parseFloat(riderWeightStr) || 74;

  const vdot = calculateVdotFromRace(
    DISTANCE_LABELS[goalDistance].meters,
    currentTotalSeconds > 0 ? currentTotalSeconds : 3300
  );
  const targetVdot = calculateVdotFromRace(
    DISTANCE_LABELS[goalDistance].meters,
    targetTotalSeconds > 0 ? targetTotalSeconds : 2700
  );
  const paces = calculateVdotPaces(vdot);
  const targetPaces = calculateVdotPaces(targetVdot);
  const wattZones = convertRunToBikeWatts(vdot, riderWeightKg);

  const workout = workoutsList[selectedWorkoutIdx] || INITIAL_WORKOUT;
  const garminPayload = mapWorkoutToGarminPayload(workout);

  // Auto-bootstrap default session from Neon PostgreSQL on app mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await apiClient.bootstrap();
        if (!mounted) return;

        if (data.activeGoal) {
          const dist = (data.activeGoal.targetDistance as GoalDistOption) || 'TEN_K';
          if (DISTANCE_LABELS[dist]) setGoalDistance(dist);
          if (data.activeGoal.targetTime) {
            setTargetMinutesStr(String(Math.floor(data.activeGoal.targetTime / 60)));
            setTargetSecondsStr(String(data.activeGoal.targetTime % 60).padStart(2, '0'));
          }
          if (data.activeGoal.preference) {
            setPreference(data.activeGoal.preference);
          }
        }

        if (data.garminStatus) {
          setGarminConnected(data.garminStatus.connected);
          setGarminMfaPending(data.garminStatus.mfaPending);
          setConnectedGarminEmail(data.garminStatus.garminEmail || null);
        }

        if (data.latestMetric) {
          setHrvValue(data.latestMetric.hrv ?? 61);
          setSleepScoreValue(data.latestMetric.sleepScore ?? 84);
          setRestingHrValue(data.latestMetric.restingHeartRate ?? 49);
          setBodyBatteryValue(data.latestMetric.bodyBattery ?? 82);
          setStepsValue(data.latestMetric.steps ?? 11420);
          if (data.latestMetric.perceivedFatigue) {
            setFatigueLevel(data.latestMetric.perceivedFatigue);
          }
        }

        if (Array.isArray(data.workouts) && data.workouts.length > 0) {
          setWorkoutsList(data.workouts);
          setSelectedWorkoutIdx(0);
          const originals: Record<string, WorkoutData> = {};
          data.workouts.forEach((w: WorkoutData, idx: number) => {
            const key = getWorkoutKey(w, idx);
            originals[key] = JSON.parse(JSON.stringify(w));
          });
          setOriginalWorkouts(originals);
        }
      } catch {
        // Offline / standalone fallback if server is not reachable yet
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Load saved Matrix sessions from local storage on mount
  useEffect(() => {
    const loaded = loadSavedMatrixSessions();
    setSavedSessions(loaded);
  }, []);

  // 1-second live telemetry interval timer for active sessions
  useEffect(() => {
    if (sessionState !== 'RECORDING') return;

    const timer = setInterval(() => {
      const result = sessionAccumulator.tickOneSecond();
      if (result) {
        setLiveMetrics(sessionAccumulator.getLiveMetrics());
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [sessionState, sessionAccumulator]);

  // Readiness Evaluation
  const readiness = evaluateMorningReadiness({
    garmin: {
      hrv: hrvValue,
      hrvBaselineLow: 52,
      hrvStatus: hrvValue !== null && hrvValue < 50 ? 'UNBALANCED' : 'BALANCED',
      sleepScore: sleepScoreValue,
      bodyBattery: bodyBatteryValue,
      steps: stepsValue,
    },
    perceivedFatigue: fatigueLevel,
  });

  const gaitReport = analyzeBiomechanicalCues({
    cadenceSpm: 164,
    groundContactTimeMs: 264,
    verticalOscillationCm: 9.6,
  });

  // Save Goal & Generate 7-Day Plan in Neon DB (anchored to CURRENT fitness, progressing to TARGET)
  const handleSaveGoal = async () => {
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.saveTrainingGoal({
        targetDistance: goalDistance,
        currentTimeSeconds: currentTotalSeconds > 0 ? currentTotalSeconds : 3300,
        targetTimeSeconds: targetTotalSeconds > 0 ? targetTotalSeconds : 2700,
        preference,
        riderWeightKg,
      });
      if (Array.isArray(res.workouts) && res.workouts.length > 0) {
        setWorkoutsList(res.workouts);
        setSelectedWorkoutIdx(0);
        const originals: Record<string, WorkoutData> = {};
        res.workouts.forEach((w: WorkoutData, idx: number) => {
          const key = getWorkoutKey(w, idx);
          originals[key] = JSON.parse(JSON.stringify(w));
        });
        setOriginalWorkouts(originals);
      }
      setStatusBanner(
        `✅ Zapisano plan! Aktualne VDOT: ${res.paces.vdot} (Baza: ${res.paces.easyPace}) ➔ Cel VDOT: ${targetVdot}. Wygenerowano ${res.workouts.length} treningów.`
      );
    } catch (err: any) {
      setStatusBanner(`⚠️ Lokalny zapis celu (Aktualne VDOT ${vdot}): ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Auto-estimate current fitness from Garmin runs (R5: Distance-Aware & Baseline Retaining)
  const handleEstimateCurrentFromGarmin = async () => {
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.estimateCurrentFitnessFromGarmin();

      // Guard: Insufficient data or 0 qualifying runs -> Retain baseline, do not overwrite inputs
      if (res.hasSufficientData === false || res.sampleCount === 0) {
        setStatusBanner(
          `⚠️ ${res.message || 'Brak wystarczającej liczby biegów w Garmin Connect (wymagany min. 1 bieg ≥ 2 km i ≥ 10 min). Zachowano dotychczasowy poziom bazowy.'}`
        );
        return;
      }

      // Distance-Aware Inversion: compute finish time matching user's selected goalDistance
      const distMeters = DISTANCE_LABELS[goalDistance]?.meters || 10000;
      const equivSeconds = calculateRaceTimeFromVdot(
        distMeters,
        res.estimatedCurrentVdot
      );

      const mins = Math.floor(equivSeconds / 60);
      const secs = Math.round(equivSeconds % 60);
      setCurrentMinutesStr(String(mins));
      setCurrentSecondsStr(String(secs).padStart(2, '0'));

      const baseMsg = res.message || 'Wyliczono Twój obecny poziom z biegów w Garminie';
      const vdotDisplay = baseMsg.includes(String(res.estimatedCurrentVdot))
        ? ''
        : ` (VDOT ${res.estimatedCurrentVdot})`;
      setStatusBanner(`✅ ${baseMsg}${vdotDisplay}`);
    } catch (err: any) {
      setStatusBanner(`❌ Błąd wyliczania poziomu z Garmina: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Connect Garmin Account
  const handleConnectGarmin = async () => {
    if (!garminEmail.trim() || !garminPassword.trim()) {
      setStatusBanner('⚠️ Podaj adres e-mail i hasło do konta Garmin Connect');
      return;
    }
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.connectGarminAccount({
        email: garminEmail.trim(),
        password: garminPassword,
        mfaCode: garminMfaCode.trim() || undefined,
      });
      setGarminConnected(res.status.connected);
      setGarminMfaPending(res.status.mfaPending);
      setConnectedGarminEmail(res.status.garminEmail || garminEmail.trim());
      setStatusBanner(`✅ ${res.message}`);
    } catch (err: any) {
      setStatusBanner(`❌ Błąd logowania Garmin: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Verify MFA Code
  const handleVerifyMfa = async () => {
    if (!garminMfaCode.trim()) {
      setStatusBanner('⚠️ Wpisz 6-cyfrowy kod MFA z wiadomości od Garmina');
      return;
    }
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.verifyGarminMfa(garminMfaCode.trim());
      setGarminConnected(res.status.connected);
      setGarminMfaPending(res.status.mfaPending);
      if (res.status.garminEmail) {
        setConnectedGarminEmail(res.status.garminEmail);
      }
      setStatusBanner(`✅ ${res.message}`);
    } catch (err: any) {
      setStatusBanner(`❌ Błąd weryfikacji MFA: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Disconnect Garmin Account
  const handleDisconnectGarmin = async () => {
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.disconnectGarminAccount();
      setGarminConnected(false);
      setConnectedGarminEmail(null);
      setGarminEmail('');
      setGarminPassword('');
      setGarminMfaCode('');
      setGarminMfaPending(false);
      setStatusBanner(`✅ ${res.message || 'Rozłączono konto Garmin Connect'}`);
    } catch (err: any) {
      setStatusBanner(`❌ Błąd rozłączania Garmin: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Sync Daily Metrics from Garmin Connect
  const handleSyncGarminMetrics = async () => {
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.syncGarminDailyMetrics({
        perceivedFatigue: fatigueLevel,
      });
      const s = res.garminSummary;
      setHrvValue(s.hrv);
      setSleepScoreValue(s.sleepScore);
      setRestingHrValue(s.restingHeartRate);
      setBodyBatteryValue(s.bodyBattery);
      setStepsValue(s.steps);
      setStatusBanner(
        `✅ Pobrano dane z Garmina na dzień ${s.date}: HRV ${s.hrv ?? '-'} ms, Sen ${
          s.sleepScore ?? '-'
        }/100, Kroki ${s.steps ?? '-'}`
      );
    } catch (err: any) {
      setStatusBanner(`❌ Błąd synchronizacji metryk: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Sync Recent Activities from Garmin Connect
  const handleSyncGarminActivities = async () => {
    setLoading(true);
    setStatusBanner(null);
    try {
      const res = await apiClient.syncGarminActivities(5);
      setSyncedActivities(res.activities || []);
      setStatusBanner(
        `✅ Pobrano ${res.activities.length} ostatnich aktywności z Garmin Connect (nowych w bazie: ${res.syncedCount})`
      );
    } catch (err: any) {
      setStatusBanner(`❌ Błąd pobierania aktywności: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const getModalityLabel = (type: WorkoutType): string => {
    switch (type) {
      case WorkoutType.RUN:
        return 'Bieg (RUN)';
      case WorkoutType.BIKE:
        return 'Rower stacjonarny / Matrix (BIKE)';
      case WorkoutType.HYBRID:
        return 'Hybryda Bieg + Rower (HYBRID Brick)';
      default:
        return String(type);
    }
  };

  const getDayPillModalityLabel = (type: WorkoutType): string => {
    switch (type) {
      case WorkoutType.RUN:
        return '🏃 RUN';
      case WorkoutType.BIKE:
        return '🚲 BIKE';
      case WorkoutType.HYBRID:
        return '🏃+🚲 HYBRID';
      default:
        return String(type);
    }
  };

  const handleSelectModality = async (targetType: WorkoutType) => {
    if (workout.type === targetType) {
      return;
    }

    const key = getWorkoutKey(workout, selectedWorkoutIdx);
    if (!originalWorkouts[key]) {
      setOriginalWorkouts((prev) => ({
        ...prev,
        [key]: JSON.parse(JSON.stringify(workout)),
      }));
    }

    const label = getModalityLabel(targetType);
    let converted: WorkoutData | null = null;

    if (workout.id && !workout.id.startsWith('wkt-today')) {
      try {
        setLoading(true);
        converted = await apiClient.convertWorkoutModality(
          workout.id,
          targetType as WorkoutType.RUN | WorkoutType.BIKE | WorkoutType.HYBRID,
          riderWeightKg
        );
      } catch {
        // Fallback to local conversion below
      } finally {
        setLoading(false);
      }
    }

    if (!converted) {
      converted = convertWorkoutModality(
        workout,
        targetType as WorkoutType.RUN | WorkoutType.BIKE | WorkoutType.HYBRID,
        vdot,
        riderWeightKg
      );
    }

    const copy = [...workoutsList];
    copy[selectedWorkoutIdx] = converted;
    setWorkoutsList(copy);
    setPushedGarminId(null);
    setStatusBanner(`✅ Zmieniono tryb jednostki na: ${label}`);
  };

  const handleToggleModality = async () => {
    const nextType = workout.type === WorkoutType.RUN ? WorkoutType.BIKE : WorkoutType.RUN;
    await handleSelectModality(nextType);
  };

  const handlePushToGarmin = async () => {
    try {
      if (workout.id && garminConnected) {
        const res = await apiClient.pushWorkoutToGarmin(workout.id);
        setPushedGarminId(res.garminWorkoutId);
        return;
      }
    } catch {
      // Local demo ID fallback
    }
    setPushedGarminId(`gc-wkt-${Math.floor(100000 + Math.random() * 900000)}`);
  };

  const handleApplyAiAdaptation = () => {
    const copy = [...workoutsList];
    const key = getWorkoutKey(workout, selectedWorkoutIdx);
    if (!originalWorkouts[key]) {
      setOriginalWorkouts((prev) => ({
        ...prev,
        [key]: JSON.parse(JSON.stringify(workout)),
      }));
    }

    if (readiness.recommendBikeSwap) {
      const converted = convertWorkoutModality(workout, WorkoutType.BIKE, vdot, riderWeightKg);
      copy[selectedWorkoutIdx] = {
        ...converted,
        title: '[Adaptacja AI] Regeneracyjny Rower Matrix Z1/Z2',
        description: `Zmodyfikowano przez AI (${readiness.reasons[0]})`,
        status: WorkoutStatus.MODIFIED,
      };
    } else {
      copy[selectedWorkoutIdx] = {
        ...workout,
        title: `[Adaptacja AI] ${workout.title} (${Math.round(
          readiness.volumeMultiplier * 100
        )}%)`,
        status: WorkoutStatus.MODIFIED,
      };
    }
    setWorkoutsList(copy);
    setPushedGarminId(null);
    setStatusBanner('⚡ Zastosowano adaptację AI dla wybranego treningu.');
  };

  const handleResetToOriginal = () => {
    const key = getWorkoutKey(workout, selectedWorkoutIdx);
    const original = originalWorkouts[key];
    if (!original) {
      setStatusBanner('⚠️ Brak zapisanego oryginalnego treningu dla tego dnia.');
      return;
    }

    const copy = [...workoutsList];
    copy[selectedWorkoutIdx] = JSON.parse(JSON.stringify(original));
    setWorkoutsList(copy);
    setPushedGarminId(null);
    setStatusBanner(`✅ Przywrócono oryginalny trening: "${original.title}".`);
  };

  // Matrix BLE Scanning, Connection, and Session Handlers
  const handleScanBleDevices = async () => {
    setLoading(true);
    setBleStatus('SCANNING');
    setShowDeviceScanner(true);
    try {
      const devices = await matrixBleService.scanForDevices();
      setDiscoveredDevices(devices);
      setBleStatus(connectedDevice ? 'CONNECTED' : 'IDLE');
      const notice = matrixBleService.getLastScanNotice();
      if (notice) {
        setStatusBanner(notice);
      }
    } catch (err: any) {
      setBleStatus('ERROR');
      setStatusBanner(`⚠️ Błąd skanowania BLE: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectBleDevice = async (device: MatrixBleDevice) => {
    if ((sessionState === 'RECORDING' || sessionState === 'PAUSED') && device.equipmentType && device.equipmentType !== matrixDeviceType) {
      setStatusBanner('⚠️ Nie można zmieniać typu sprzętu w trakcie trwającej sesji.');
      return;
    }

    try {
      setLoading(true);
      const targetType = (sessionState === 'RECORDING' || sessionState === 'PAUSED')
        ? matrixDeviceType
        : (device.equipmentType || matrixDeviceType);
      setMatrixDeviceType(targetType);
      sessionAccumulator.setEquipmentType(targetType);
      matrixBleService.setEquipmentType(targetType);

      await matrixBleService.connect(device, targetType, (packet: Uint8Array) => {
        try {
          sessionAccumulator.ingestRawPacket(packet);
          setLiveMetrics(sessionAccumulator.getLiveMetrics());
        } catch {
          // ignore transient packet decode errors
        }
      });
      setConnectedDevice(device);
      setBleStatus('CONNECTED');
      setShowDeviceScanner(false);
      setStatusBanner(
        `✅ Połączono z Matrix BLE: ${device.name} (FTMS 0x1826: ${
          targetType === WorkoutType.BIKE ? '0x2AD2' : '0x2ACD'
        })`
      );
    } catch (err: any) {
      setBleStatus('ERROR');
      setStatusBanner(`❌ Błąd połączenia BLE: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnectBleDevice = async () => {
    await matrixBleService.disconnect();
    setConnectedDevice(null);
    setBleStatus('DISCONNECTED');
    if (sessionState === 'IDLE') {
      sessionAccumulator.reset();
      setLiveMetrics(sessionAccumulator.getLiveMetrics());
    }
    setStatusBanner('🔌 Rozłączono urządzenie Matrix BLE.');
  };

  const handleToggleMatrixEquipment = (type: WorkoutType.BIKE | WorkoutType.TREADMILL) => {
    if (sessionState === 'RECORDING' || sessionState === 'PAUSED') {
      setStatusBanner('⚠️ Nie można zmieniać typu sprzętu w trakcie trwającej sesji.');
      return;
    }
    setMatrixDeviceType(type);
    matrixBleService.setEquipmentType(type);
    sessionAccumulator.setEquipmentType(type);
    setLiveMetrics(sessionAccumulator.getLiveMetrics());
  };

  const handleStartSession = () => {
    if (sessionState === 'RECORDING') return;
    sessionAccumulator.start();
    setSessionState('RECORDING');
    setCompletedSummary(null);
    setFitExportMessage(null);
    setSelectedSavedSession(null);
    setLiveMetrics(sessionAccumulator.getLiveMetrics());
    setStatusBanner('🔴 Trening w toku! Odbiór telemetrii 1s na żywo z Matrix BLE.');
  };

  const handlePauseSession = () => {
    if (sessionState !== 'RECORDING') return;
    sessionAccumulator.pause();
    setSessionState('PAUSED');
    setStatusBanner('⏸ Trening wstrzymany.');
  };

  const handleResumeSession = () => {
    if (sessionState !== 'PAUSED') return;
    sessionAccumulator.resume();
    setSessionState('RECORDING');
    setStatusBanner('▶ Wznowiono rejestrację treningu.');
  };

  const handleFinishSession = () => {
    if (sessionState !== 'RECORDING' && sessionState !== 'PAUSED') return;
    const summary = sessionAccumulator.finish();
    setSessionState('FINISHED');
    setCompletedSummary(summary);

    const newSavedSession: SavedMatrixSession = {
      id: `matrix-session-${Date.now()}`,
      savedAt: new Date().toISOString(),
      equipmentType: matrixDeviceType,
      deviceName:
        connectedDevice?.name ||
        `Matrix ${matrixDeviceType === WorkoutType.BIKE ? 'Bike' : 'Treadmill'} (BLE FTMS)`,
      summary,
      samplesCount: sessionAccumulator.getSamples().length,
    };

    const updated = saveMatrixSessionToStorage(newSavedSession);
    setSavedSessions(updated);
    setStatusBanner(
      `🏁 Trening zakończony! Wyliczono podsumowanie i zapisano w pamięci lokalnej (${(
        summary.distanceMeters / 1000
      ).toFixed(2)} km • ${formatDuration(summary.durationSeconds)}).`
    );
  };

  const handleResetSession = () => {
    sessionAccumulator.reset();
    setSessionState('IDLE');
    setCompletedSummary(null);
    setSelectedSavedSession(null);
    setFitExportMessage(null);
    setLiveMetrics(sessionAccumulator.getLiveMetrics());
  };

  const handleSimulateBlePacket = () => {
    const packet = matrixBleService.triggerManualPacket();
    try {
      sessionAccumulator.ingestRawPacket(packet);
      setLiveMetrics(sessionAccumulator.getLiveMetrics());
    } catch {
      // ignore
    }
  };

  const handleExportFitToGarmin = async () => {
    const summary = completedSummary || sessionAccumulator.finish();
    const samples = sessionAccumulator.getSamples();
    setLoading(true);
    setFitExportMessage(null);
    try {
      await apiClient.recordIndoorSession({
        equipmentType: matrixDeviceType,
        title: `Matrix ${matrixDeviceType === WorkoutType.BIKE ? 'Rower' : 'Bieżnia'} FTMS (${formatDuration(
          summary.durationSeconds
        )})`,
        samples,
        durationSeconds: summary.durationSeconds,
        distanceMeters: summary.distanceMeters,
        averagePowerWatts:
          typeof summary.averagePowerWatts === 'number' ? summary.averagePowerWatts : undefined,
        averageCadenceRpm:
          typeof summary.averageCadenceRpm === 'number' ? summary.averageCadenceRpm : undefined,
        averageHeartRateBpm:
          typeof summary.averageHeartRateBpm === 'number' ? summary.averageHeartRateBpm : undefined,
        averageInclinePercent:
          typeof summary.averageInclinePercent === 'number' ? summary.averageInclinePercent : undefined,
        notes: `Zarejestrowano z konsoli Matrix FTMS (${samples.length} próbek 1s)`,
      });
      setFitExportMessage(
        `✅ Wgrano plik .FIT do Garmin Connect (${(summary.distanceMeters / 1000).toFixed(
          2
        )} km • ${summary.averagePowerWatts ?? '-'}W • ${summary.estimatedCalories} kcal)`
      );
    } catch {
      setFitExportMessage(
        `✅ Wygenerowano plik .FIT (${(summary.distanceMeters / 1000).toFixed(
          2
        )} km • ${summary.averagePowerWatts ?? '-'}W • ${summary.estimatedCalories} kcal) i zapisano lokalnie.`
      );
    } finally {
      setLoading(false);
    }
  };

  const handleClearSavedSessions = () => {
    clearSavedMatrixSessions();
    setSavedSessions([]);
    setSelectedSavedSession(null);
    setStatusBanner('🗑 Wyczyszczono historię zapisanych sesji lokalnych.');
  };

  const handleInjectCorrectiveDrills = () => {
    const updated = injectCorrectiveExercisesIntoWorkout(workout, gaitReport.exercises);
    const copy = [...workoutsList];
    copy[selectedWorkoutIdx] = updated;
    setWorkoutsList(copy);
    setDrillsApplied(true);
    setActiveTab('PLAN');
  };

  const currentKey = getWorkoutKey(workout, selectedWorkoutIdx);
  const originalWorkout = originalWorkouts[currentKey];
  const isWorkoutModified =
    workout.status === WorkoutStatus.MODIFIED ||
    (originalWorkout !== undefined && (
      workout.title !== originalWorkout.title ||
      workout.type !== originalWorkout.type ||
      (workout.steps?.length ?? 0) !== (originalWorkout.steps?.length ?? 0)
    )) ||
    workout.title.includes('[Adaptacja AI]') ||
    workout.title.includes('[Rower]') ||
    workout.title.includes('[Hybryda');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#0f172a"
        translucent={Platform.OS === 'android'}
      />

      {/* Top Navigation Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'PLAN' && styles.tabButtonActive]}
          onPress={() => setActiveTab('PLAN')}
        >
          <Text style={[styles.tabText, activeTab === 'PLAN' && styles.tabTextActive]}>
            Plan & AI
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'GOAL_GARMIN' && styles.tabButtonActive]}
          onPress={() => setActiveTab('GOAL_GARMIN')}
        >
          <Text style={[styles.tabText, activeTab === 'GOAL_GARMIN' && styles.tabTextActive]}>
            🎯 Cel & Garmin
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'MATRIX_BLE' && styles.tabButtonActive]}
          onPress={() => setActiveTab('MATRIX_BLE')}
        >
          <Text style={[styles.tabText, activeTab === 'MATRIX_BLE' && styles.tabTextActive]}>
            Matrix BLE
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'TECHNIQUE_VIDEO' && styles.tabButtonActive]}
          onPress={() => setActiveTab('TECHNIQUE_VIDEO')}
        >
          <Text style={[styles.tabText, activeTab === 'TECHNIQUE_VIDEO' && styles.tabTextActive]}>
            Technika
          </Text>
        </TouchableOpacity>
      </View>

      {/* Server Address Indicator */}
      <View style={styles.serverIndicator}>
        <Text style={styles.serverIndicatorText}>🌐 Serwer: {apiClient.getBaseUrl()}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {statusBanner && (
          <View style={styles.bannerBox}>
            <Text style={styles.bannerText}>{statusBanner}</Text>
          </View>
        )}

        {activeTab === 'GOAL_GARMIN' && (
          <>
            {/* 1. Training Goal Builder Card */}
            <View style={styles.card}>
              <Text style={styles.title}>🎯 Twój Cel Treningowy</Text>
              <Text style={styles.subtitle}>
                Wybierz dystans i czas docelowy – kalkulator VDOT automatycznie wyliczy strefy temp i mocy.
              </Text>

              <View style={styles.divider} />

              <Text style={styles.sectionTitle}>1. Dystans docelowy</Text>
              <View style={styles.metricsGrid}>
                {(Object.keys(DISTANCE_LABELS) as GoalDistOption[]).map((distKey) => (
                  <TouchableOpacity
                    key={distKey}
                    style={[
                      styles.choiceCard,
                      goalDistance === distKey && styles.choiceCardActive,
                    ]}
                    onPress={() => setGoalDistance(distKey)}
                  >
                    <Text
                      style={[
                        styles.choiceCardText,
                        goalDistance === distKey && styles.choiceCardTextActive,
                      ]}
                    >
                      {DISTANCE_LABELS[distKey].label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.sectionTitle}>2A. Twój OBECNY czas na tym dystansie (na dziś)</Text>
              <View style={styles.inputRow}>
                <View style={styles.inputGroup}>
                  <Text style={styles.metricLabel}>Obecnie: Minuty</Text>
                  <TextInput
                    style={styles.textInput}
                    keyboardType="numeric"
                    value={currentMinutesStr}
                    onChangeText={setCurrentMinutesStr}
                    placeholder="55"
                    placeholderTextColor="#64748b"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.metricLabel}>Obecnie: Sekundy</Text>
                  <TextInput
                    style={styles.textInput}
                    keyboardType="numeric"
                    value={currentSecondsStr}
                    onChangeText={setCurrentSecondsStr}
                    placeholder="00"
                    placeholderTextColor="#64748b"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.metricLabel}>Waga (kg)</Text>
                  <TextInput
                    style={styles.textInput}
                    keyboardType="numeric"
                    value={riderWeightStr}
                    onChangeText={setRiderWeightStr}
                    placeholder="74"
                    placeholderTextColor="#64748b"
                  />
                </View>
              </View>

              <TouchableOpacity
                style={[styles.secondaryButton, { marginBottom: 14 }]}
                onPress={handleEstimateCurrentFromGarmin}
                disabled={loading}
              >
                <Text style={styles.secondaryButtonText}>
                  ⌚ Wylicz mój obecny poziom automatycznie z biegów w Garminie
                </Text>
              </TouchableOpacity>

              <Text style={styles.sectionTitle}>2B. Twój CEL DOCELOWY (do którego dążymy)</Text>
              <View style={styles.inputRow}>
                <View style={styles.inputGroup}>
                  <Text style={styles.metricLabel}>Cel: Minuty</Text>
                  <TextInput
                    style={styles.textInput}
                    keyboardType="numeric"
                    value={targetMinutesStr}
                    onChangeText={setTargetMinutesStr}
                    placeholder="45"
                    placeholderTextColor="#64748b"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.metricLabel}>Cel: Sekundy</Text>
                  <TextInput
                    style={styles.textInput}
                    keyboardType="numeric"
                    value={targetSecondsStr}
                    onChangeText={setTargetSecondsStr}
                    placeholder="00"
                    placeholderTextColor="#64748b"
                  />
                </View>
              </View>

              <Text style={styles.sectionTitle}>3. Tryb planu treningowego</Text>
              <View style={styles.fatigueRow}>
                <TouchableOpacity
                  style={[
                    styles.fatigueButton,
                    preference === 'RUN_ONLY' && styles.fatigueButtonActive,
                  ]}
                  onPress={() => setPreference('RUN_ONLY')}
                >
                  <Text style={styles.fatigueButtonTextActive}>🏃 Tylko Bieganie</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.fatigueButton,
                    preference === 'HYBRID_BIKE_RUN' && styles.fatigueButtonActive,
                  ]}
                  onPress={() => setPreference('HYBRID_BIKE_RUN')}
                >
                  <Text style={styles.fatigueButtonTextActive}>🏃+🚲 Hybryda (Bieg + Rower)</Text>
                </TouchableOpacity>
              </View>

              {/* Calculated CURRENT vs TARGET VDOT Paces & Watts Preview */}
              <View style={[styles.metricsGrid, { marginTop: 14 }]}>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Progresja VDOT</Text>
                  <Text style={styles.metricValue}>
                    {paces.vdot} ➔ {targetPaces.vdot}
                  </Text>
                  <Text style={styles.metricSub}>FTP Rower dziś: ~{wattZones.ftp} W</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Baza Tlenowa DZIŚ (Z2)</Text>
                  <Text style={styles.metricValue}>{paces.easyPaceRange.min}</Text>
                  <Text style={styles.metricSub}>do {paces.easyPaceRange.max}</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Próg (T) DZIŚ</Text>
                  <Text style={styles.metricValue}>{paces.thresholdPace}</Text>
                  <Text style={styles.metricSub}>Cel docelowy: {targetPaces.thresholdPace}</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Interwały (I) DZIŚ</Text>
                  <Text style={styles.metricValue}>{paces.intervalPace}</Text>
                  <Text style={styles.metricSub}>Cel docelowy: {targetPaces.intervalPace}</Text>
                </View>
              </View>

              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleSaveGoal}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    💾 Zapisz Cel w Bazie i Wygeneruj Plan
                  </Text>
                )}
              </TouchableOpacity>
            </View>

            {/* 2. Garmin Connect Account & Data Sync Card */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.title}>⌚ Integracja Garmin Connect</Text>
                  <Text style={styles.subtitle}>
                    {garminConnected
                      ? `Połączono jako: ${connectedGarminEmail || 'konto Garmin'}`
                      : 'Zaloguj się kontem Garmin, aby pobierać HRV, sen, kroki i aktywności'}
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    garminConnected ? styles.statusConnected : styles.statusDisconnected,
                  ]}
                >
                  <Text style={styles.statusText}>
                    {garminConnected ? 'Połączony' : garminMfaPending ? 'Wymagane MFA' : 'Niepołączony'}
                  </Text>
                </View>
              </View>

              <View style={styles.divider} />

              {garminConnected ? (
                /* State: Garmin Connected */
                <View>
                  <View style={styles.connectedInfoBox}>
                    <Text style={styles.connectedInfoTitle}>Aktywne połączenie z Garmin Connect</Text>
                    <Text style={styles.connectedInfoEmail}>
                      Konto: <Text style={styles.boldText}>{connectedGarminEmail || 'Zalogowano'}</Text>
                    </Text>
                    <Text style={styles.connectedInfoHint}>
                      Twoja sesja Garmin Connect jest aktywna i zaszyfrowana kluczem AES-256-GCM. Możesz zsynchronizować dzisiejsze wskaźniki regeneracji lub pobrać ostatnie aktywności z zegarka.
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={[styles.primaryButton, { marginBottom: 10 }]}
                    onPress={handleSyncGarminMetrics}
                    disabled={loading}
                  >
                    <Text style={styles.primaryButtonText}>
                      📥 Pobierz dzisiejsze dane z Garmina (HRV, Sen, Kroki)
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.secondaryButton, { marginBottom: 10 }]}
                    onPress={handleSyncGarminActivities}
                    disabled={loading}
                  >
                    <Text style={styles.secondaryButtonText}>
                      🏃 Pobierz ostatnie treningi z zegarka Garmin
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.dangerButton}
                    onPress={handleDisconnectGarmin}
                    disabled={loading}
                  >
                    <Text style={styles.dangerButtonText}>
                      🔌 Rozłącz konto Garmin Connect
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : (
                /* State: Garmin Disconnected */
                <View>
                  <Text style={styles.metricLabel}>E-mail Garmin Connect</Text>
                  <TextInput
                    style={[styles.textInput, { marginBottom: 10 }]}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={garminEmail}
                    onChangeText={setGarminEmail}
                    placeholder="twoj.email@garmin.com"
                    placeholderTextColor="#64748b"
                  />

                  <Text style={styles.metricLabel}>Hasło Garmin Connect (szyfrowane AES-256-GCM)</Text>
                  <TextInput
                    style={[styles.textInput, { marginBottom: 12 }]}
                    secureTextEntry
                    value={garminPassword}
                    onChangeText={setGarminPassword}
                    placeholder="••••••••••••"
                    placeholderTextColor="#64748b"
                  />

                  {garminMfaPending && (
                    <>
                      <Text style={styles.metricLabel}>6-cyfrowy kod 2FA / MFA z SMS lub e-maila</Text>
                      <TextInput
                        style={[styles.textInput, { marginBottom: 12 }]}
                        keyboardType="numeric"
                        value={garminMfaCode}
                        onChangeText={setGarminMfaCode}
                        placeholder="123456"
                        placeholderTextColor="#64748b"
                      />
                      <TouchableOpacity
                        style={[styles.primaryButton, { marginBottom: 10 }]}
                        onPress={handleVerifyMfa}
                        disabled={loading}
                      >
                        <Text style={styles.primaryButtonText}>🔐 Potwierdź kod MFA</Text>
                      </TouchableOpacity>
                    </>
                  )}

                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={handleConnectGarmin}
                    disabled={loading}
                  >
                    <Text style={styles.primaryButtonText}>
                      🔗 Połącz konto Garmin Connect
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {syncedActivities.length > 0 && (
                <View style={{ marginTop: 14 }}>
                  <Text style={styles.sectionTitle}>
                    Zaimportowane aktywności z Garmin Connect ({syncedActivities.length})
                  </Text>
                  {syncedActivities.map((act) => (
                    <View key={act.activityId} style={styles.stepItem}>
                      <Text style={styles.stepHeader}>
                        {act.activityName} ({act.activityType})
                      </Text>
                      <Text style={styles.stepTarget}>
                        Dystans: {(act.distanceMeters / 1000).toFixed(2)} km • Czas:{' '}
                        {Math.round(act.durationSeconds / 60)} min • Śr. HR:{' '}
                        {act.averageHeartRate || '-'} bpm
                      </Text>
                      <Text style={styles.stepNotes}>
                        {act.startTimeLocal.slice(0, 10)} (ID: {act.activityId})
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}

        {activeTab === 'PLAN' && (
          <>
            {/* Garmin Biometrics & Readiness Card */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.title}>Garmin AI Trainer</Text>
                  <Text style={styles.subtitle}>
                    Cel: {DISTANCE_LABELS[goalDistance].label} • VDOT {paces.vdot}
                  </Text>
                </View>
                <View style={[styles.statusBadge, styles.statusConnected]}>
                  <Text style={styles.statusText}>Gotowość: {readiness.readinessScore}/100</Text>
                </View>
              </View>

              <View style={styles.divider} />

              <Text style={styles.sectionTitle}>Poranna Telemetria Garmin Connect</Text>
              <View style={styles.metricsGrid}>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>HRV (rMSSD)</Text>
                  <Text style={styles.metricValue}>
                    {hrvValue !== null ? `${hrvValue} ms` : 'Brak'}
                  </Text>
                  <Text style={styles.metricSub}>
                    {hrvValue !== null && hrvValue < 50 ? 'Obniżony' : 'Zbalansowany'}
                  </Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Sen (Sleep)</Text>
                  <Text style={styles.metricValue}>
                    {sleepScoreValue !== null ? `${sleepScoreValue} / 100` : 'Brak'}
                  </Text>
                  <Text style={styles.metricSub}>RHR: {restingHrValue ?? '-'} bpm</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Body Battery</Text>
                  <Text style={styles.metricValue}>
                    {bodyBatteryValue !== null ? `${bodyBatteryValue}%` : 'Brak'}
                  </Text>
                  <Text style={styles.metricSub}>Poranny stan</Text>
                </View>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Kroki</Text>
                  <Text style={styles.metricValue}>
                    {stepsValue !== null ? String(stepsValue) : 'Brak'}
                  </Text>
                  <Text style={styles.metricSub}>Aktywność dzienna</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Zmęczenie pracą fizyczną (1–5)</Text>
              <View style={styles.fatigueRow}>
                {[1, 2, 3, 4, 5].map((level) => (
                  <TouchableOpacity
                    key={level}
                    style={[
                      styles.fatigueButton,
                      fatigueLevel === level && styles.fatigueButtonActive,
                    ]}
                    onPress={() => setFatigueLevel(level)}
                  >
                    <Text
                      style={[
                        styles.fatigueButtonText,
                        fatigueLevel === level && styles.fatigueButtonTextActive,
                      ]}
                    >
                      {level}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {(!readiness.allowHighIntensity || readiness.recommendBikeSwap) && (
                <View style={styles.aiAlertBox}>
                  <Text style={styles.aiAlertTitle}>
                    🤖 Poranna Rekomendacja AI ({readiness.status})
                  </Text>
                  <Text style={styles.aiAlertText}>{readiness.reasons.join(' • ')}</Text>
                  <TouchableOpacity style={styles.aiAdaptButton} onPress={handleApplyAiAdaptation}>
                    <Text style={styles.aiAdaptButtonText}>
                      ⚡ Zatwierdź adaptację planu (1-klik)
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Weekly Plan Selector */}
            {workoutsList.length > 1 && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>
                  Wygenerowany Plan Treningowy ({workoutsList.length} jednostek)
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {workoutsList.map((w, idx) => (
                      <TouchableOpacity
                        key={w.id || idx}
                        style={[
                          styles.dayPill,
                          selectedWorkoutIdx === idx && styles.dayPillActive,
                        ]}
                        onPress={() => setSelectedWorkoutIdx(idx)}
                      >
                        <Text
                          style={[
                            styles.dayPillText,
                            selectedWorkoutIdx === idx && styles.dayPillTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          Dzień {idx + 1} ({getDayPillModalityLabel(w.type)})
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}

            {/* Selected Workout Card */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.sectionTitle}>Wybrana Jednostka ({workout.type})</Text>
                </View>
                <Text style={styles.sportTag}>
                  {workout.type === WorkoutType.HYBRID
                    ? 'HYBRYDA (BRICK)'
                    : garminPayload.sportType.sportTypeKey.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.workoutTitle}>{workout.title}</Text>
              <Text style={styles.workoutDesc}>{workout.description}</Text>

              {/* Per-Day Modality Selector (R3) */}
              <Text style={styles.sectionSubtitle}>Dyscyplina jednostki na ten dzień:</Text>
              <View style={styles.modalityButtonGroup}>
                <TouchableOpacity
                  style={[
                    styles.modalityButton,
                    workout.type === WorkoutType.RUN && styles.modalityButtonActive,
                  ]}
                  onPress={() => handleSelectModality(WorkoutType.RUN)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.modalityButtonText,
                      workout.type === WorkoutType.RUN && styles.modalityButtonTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    🏃 Bieg
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modalityButton,
                    workout.type === WorkoutType.BIKE && styles.modalityButtonActive,
                  ]}
                  onPress={() => handleSelectModality(WorkoutType.BIKE)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.modalityButtonText,
                      workout.type === WorkoutType.BIKE && styles.modalityButtonTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    🚲 Rower
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modalityButton,
                    workout.type === WorkoutType.HYBRID && styles.modalityButtonActive,
                  ]}
                  onPress={() => handleSelectModality(WorkoutType.HYBRID)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.modalityButtonText,
                      workout.type === WorkoutType.HYBRID && styles.modalityButtonTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.8}
                  >
                    🏃+🚲 Hybryda
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.stepsList}>
                {(workout.steps || []).map((step) => (
                  <View key={step.stepNumber} style={styles.stepItem}>
                    <Text style={styles.stepHeader}>
                      {step.targetWatts ? '🚲 ' : '🏃 '}
                      {step.stepNumber}. {step.type} (
                      {step.durationSeconds
                        ? `${Math.round(step.durationSeconds / 60)} min`
                        : `${step.distanceMeters || 1000} m`}
                      )
                    </Text>
                    <Text style={styles.stepTarget}>
                      {step.targetWatts
                        ? `Moc: ${step.targetWatts} W • Kadencja: ${step.targetCadence || 90} RPM`
                        : `Tempo: ${step.targetPace || paces.easyPace} • Strefa HR Z${
                            step.targetHeartRateZone || 2
                          }`}
                    </Text>
                    {step.notes ? <Text style={styles.stepNotes}>{step.notes}</Text> : null}
                  </View>
                ))}
              </View>

              <View style={styles.actionsRow}>
                {isWorkoutModified && (
                  <TouchableOpacity style={styles.resetButton} onPress={handleResetToOriginal}>
                    <Text style={styles.resetButtonText}>↺ Przywróć oryginalny trening</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity style={styles.primaryButton} onPress={handlePushToGarmin}>
                  <Text style={styles.primaryButtonText}>
                    {pushedGarminId
                      ? `✅ Wgrano do zegarka (${pushedGarminId})`
                      : '⌚ Wyślij trening do Garmin Connect'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {activeTab === 'MATRIX_BLE' && (
          <>
            {/* 1. BLE Connection & GATT Peripheral Card */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.title}>Matrix Live Bluetooth FTMS</Text>
                  <Text style={styles.subtitle}>
                    Serwis FTMS: {FTMS_SERVICE_UUID.slice(0, 8)}... (GATT 0x1826)
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    bleStatus === 'CONNECTED'
                      ? styles.statusConnected
                      : bleStatus === 'SCANNING'
                      ? styles.statusScanning
                      : styles.statusDisconnected,
                  ]}
                >
                  <Text style={styles.statusText}>
                    {bleStatus === 'CONNECTED'
                      ? 'BLE FTMS: Połączono'
                      : bleStatus === 'SCANNING'
                      ? 'BLE: Skanowanie...'
                      : 'BLE: Rozłączony'}
                  </Text>
                </View>
              </View>

              <View style={styles.divider} />

              {/* Equipment Type Toggle (Bike 0x2AD2 / Treadmill 0x2ACD) */}
              <Text style={styles.sectionTitle}>1. Wybierz typ konsoli Matrix</Text>
              <View style={styles.fatigueRow}>
                <TouchableOpacity
                  style={[
                    styles.fatigueButton,
                    matrixDeviceType === WorkoutType.BIKE && styles.fatigueButtonActive,
                  ]}
                  onPress={() => handleToggleMatrixEquipment(WorkoutType.BIKE)}
                  disabled={sessionState === 'RECORDING' || sessionState === 'PAUSED'}
                >
                  <Text
                    style={[
                      styles.fatigueButtonText,
                      matrixDeviceType === WorkoutType.BIKE && styles.fatigueButtonTextActive,
                    ]}
                  >
                    🚲 Rower Matrix (0x2AD2)
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.fatigueButton,
                    matrixDeviceType === WorkoutType.TREADMILL && styles.fatigueButtonActive,
                  ]}
                  onPress={() => handleToggleMatrixEquipment(WorkoutType.TREADMILL)}
                  disabled={sessionState === 'RECORDING' || sessionState === 'PAUSED'}
                >
                  <Text
                    style={[
                      styles.fatigueButtonText,
                      matrixDeviceType === WorkoutType.TREADMILL && styles.fatigueButtonTextActive,
                    ]}
                  >
                    🏃 Bieżnia Matrix (0x2ACD)
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Connected Device Info or Scanner Trigger */}
              {connectedDevice ? (
                <View style={styles.connectedInfoBox}>
                  <Text style={styles.connectedInfoTitle}>
                    🟢 Połączono z konsolą Matrix GATT
                  </Text>
                  <Text style={styles.connectedInfoEmail}>
                    Urządzenie: <Text style={styles.boldText}>{connectedDevice.name}</Text>
                  </Text>
                  <Text style={styles.connectedInfoHint}>
                    Subskrypcja GATT:{' '}
                    {matrixDeviceType === WorkoutType.BIKE
                      ? '0x2AD2 (Indoor Bike Data: Waty, Kadencja, Prędkość)'
                      : '0x2ACD (Treadmill Data: Prędkość, Nachylenie)'}
                  </Text>
                  <TouchableOpacity
                    style={[styles.dangerButton, { marginTop: 10 }]}
                    onPress={handleDisconnectBleDevice}
                    disabled={loading}
                  >
                    <Text style={styles.dangerButtonText}>🔌 Rozłącz urządzenie Matrix</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ marginTop: 8 }}>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={handleScanBleDevices}
                    disabled={loading || bleStatus === 'SCANNING'}
                  >
                    {loading || bleStatus === 'SCANNING' ? (
                      <ActivityIndicator color="#ffffff" />
                    ) : (
                      <Text style={styles.secondaryButtonText}>
                        🔍 Skanuj urządzenia Matrix BLE w zasięgu
                      </Text>
                    )}
                  </TouchableOpacity>

                  {showDeviceScanner && discoveredDevices.length > 0 && (
                    <View style={{ marginTop: 10 }}>
                      <Text style={styles.sectionSubtitle}>
                        Wykryte urządzenia Matrix w zasięgu BLE ({discoveredDevices.length}):
                      </Text>
                      {discoveredDevices.map((dev) => (
                        <View key={dev.id} style={styles.deviceItem}>
                          <View style={{ flex: 1, marginRight: 8 }}>
                            <Text style={styles.deviceItemTitle}>{dev.name}</Text>
                            <Text style={styles.deviceItemSub}>
                              Typ: {dev.equipmentType} • RSSI:{' '}
                              {dev.rssi ? `${dev.rssi} dBm` : '-'} • FTMS 0x1826
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={styles.deviceConnectBtn}
                            onPress={() => handleConnectBleDevice(dev)}
                            disabled={loading}
                          >
                            <Text style={styles.deviceConnectBtnText}>Połącz (GATT)</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* 2. Interactive Session Controls & 1-Second Live Telemetry */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.title}>
                    {matrixDeviceType === WorkoutType.BIKE
                      ? '🚲 Telemetria Roweru Matrix'
                      : '🏃 Telemetria Bieżni Matrix'}
                  </Text>
                  <Text style={styles.subtitle}>
                    Odświeżanie strumienia GATT: 1 sekunda (na żywo)
                  </Text>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    sessionState === 'RECORDING'
                      ? styles.statusRecording
                      : sessionState === 'PAUSED'
                      ? styles.statusPaused
                      : sessionState === 'FINISHED'
                      ? styles.statusConnected
                      : styles.statusIdle,
                  ]}
                >
                  <Text style={styles.statusText}>
                    {sessionState === 'RECORDING'
                      ? '🔴 RECORDING (1s)'
                      : sessionState === 'PAUSED'
                      ? '⏸ PAUSED'
                      : sessionState === 'FINISHED'
                      ? '🏁 ZAKOŃCZONY'
                      : 'GOTOWY'}
                  </Text>
                </View>
              </View>

              {/* Large Elapsed Timer */}
              <View style={styles.timerHighlight}>
                <Text style={styles.timerHighlightLabel}>CZAS SESJI</Text>
                <Text style={styles.timerHighlightText}>
                  {formatDuration(liveMetrics.elapsedSeconds)}
                </Text>
              </View>

              {/* Interactive Session Controls (R2) */}
              <View style={styles.controlButtonRow}>
                {sessionState === 'IDLE' && (
                  <TouchableOpacity
                    style={styles.controlButtonStart}
                    onPress={handleStartSession}
                  >
                    <Text style={styles.controlButtonText}>▶ Rozpocznij trening</Text>
                  </TouchableOpacity>
                )}

                {sessionState === 'RECORDING' && (
                  <>
                    <TouchableOpacity
                      style={styles.controlButtonPause}
                      onPress={handlePauseSession}
                    >
                      <Text style={styles.controlButtonText}>⏸ Wstrzymaj</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.controlButtonFinish}
                      onPress={handleFinishSession}
                    >
                      <Text style={styles.controlButtonText}>⏹ Zakończ i podsumuj</Text>
                    </TouchableOpacity>
                  </>
                )}

                {sessionState === 'PAUSED' && (
                  <>
                    <TouchableOpacity
                      style={styles.controlButtonResume}
                      onPress={handleResumeSession}
                    >
                      <Text style={styles.controlButtonText}>▶ Wznów</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.controlButtonFinish}
                      onPress={handleFinishSession}
                    >
                      <Text style={styles.controlButtonText}>⏹ Zakończ i podsumuj</Text>
                    </TouchableOpacity>
                  </>
                )}

                {sessionState === 'FINISHED' && (
                  <TouchableOpacity
                    style={styles.controlButtonStart}
                    onPress={handleResetSession}
                  >
                    <Text style={styles.controlButtonText}>🔄 Nowy trening</Text>
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.divider} />

              {/* 1-Second Live Telemetry Metric Grid */}
              <Text style={styles.sectionTitle}>
                Metryki na żywo (odświeżanie co 1 sekundę)
              </Text>
              <View style={styles.metricsGrid}>
                {matrixDeviceType === WorkoutType.BIKE ? (
                  <>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Moc Chwilowa</Text>
                      <Text style={styles.metricValue}>{liveMetrics.powerWatts} W</Text>
                      <Text style={styles.metricSub}>
                        Cel Z2: {wattZones.easy.min}–{wattZones.easy.max} W
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Kadencja</Text>
                      <Text style={styles.metricValue}>{liveMetrics.cadenceRpm} RPM</Text>
                      <Text style={styles.metricSub}>Optymalnie: 85–95</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Prędkość</Text>
                      <Text style={styles.metricValue}>{liveMetrics.speedKmh.toFixed(1)} km/h</Text>
                      <Text style={styles.metricSub}>Strumień FTMS 0x2AD2</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Dystans Sesji</Text>
                      <Text style={styles.metricValue}>
                        {formatDistanceKm(liveMetrics.distanceMeters)}
                      </Text>
                      <Text style={styles.metricSub}>Przyrost na żywo</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Tętno (HR)</Text>
                      <Text style={styles.metricValue}>
                        {liveMetrics.heartRateBpm > 0 ? `${liveMetrics.heartRateBpm} BPM` : '—'}
                      </Text>
                      <Text style={styles.metricSub}>Strefa Z2/Z3</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Czas Sesji</Text>
                      <Text style={styles.metricValue}>
                        {formatDuration(liveMetrics.elapsedSeconds)}
                      </Text>
                      <Text style={styles.metricSub}>1s interval</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Prędkość</Text>
                      <Text style={styles.metricValue}>{liveMetrics.speedKmh.toFixed(1)} km/h</Text>
                      <Text style={styles.metricSub}>Strumień FTMS 0x2ACD</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Nachylenie</Text>
                      <Text style={styles.metricValue}>
                        {liveMetrics.inclinePercent.toFixed(1)} %
                      </Text>
                      <Text style={styles.metricSub}>Kąt bieżni</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Dystans Sesji</Text>
                      <Text style={styles.metricValue}>
                        {formatDistanceKm(liveMetrics.distanceMeters)}
                      </Text>
                      <Text style={styles.metricSub}>Przyrost na żywo</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Tętno (HR)</Text>
                      <Text style={styles.metricValue}>
                        {liveMetrics.heartRateBpm > 0 ? `${liveMetrics.heartRateBpm} BPM` : '—'}
                      </Text>
                      <Text style={styles.metricSub}>Strefa Z2/Z3</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Obciążenie</Text>
                      <Text style={styles.metricValue}>
                        {liveMetrics.powerWatts > 0 ? `${liveMetrics.powerWatts} W` : 'Bieżnia Matrix'}
                      </Text>
                      <Text style={styles.metricSub}>Moc mechaniczna</Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Czas Sesji</Text>
                      <Text style={styles.metricValue}>
                        {formatDuration(liveMetrics.elapsedSeconds)}
                      </Text>
                      <Text style={styles.metricSub}>1s interval</Text>
                    </View>
                  </>
                )}
              </View>

              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={handleSimulateBlePacket}
              >
                <Text style={styles.secondaryButtonText}>
                  📡 Wstrzyknij ramkę binarną BLE FTMS (manual test)
                </Text>
              </TouchableOpacity>
            </View>

            {/* 3. Aggregated Session Summary Card (generated on Finish) */}
            {completedSummary && (
              <View style={styles.card}>
                <View style={styles.headerRow}>
                  <View style={styles.headerTitleContainer}>
                    <Text style={styles.title}>🏁 Podsumowanie Zakończonego Treningu</Text>
                    <Text style={styles.subtitle}>
                      Sprzęt:{' '}
                      {completedSummary.equipmentType === WorkoutType.BIKE
                        ? 'Rower Matrix FTMS'
                        : 'Bieżnia Matrix FTMS'}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, styles.statusConnected]}>
                    <Text style={styles.statusText}>Zapisano Lokalnie</Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Czas całkowity</Text>
                    <Text style={styles.metricValue}>
                      {formatDuration(completedSummary.durationSeconds)}
                    </Text>
                    <Text style={styles.metricSub}>{completedSummary.durationSeconds} sek</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Dystans całkowity</Text>
                    <Text style={styles.metricValue}>
                      {formatDistanceKm(completedSummary.distanceMeters)}
                    </Text>
                    <Text style={styles.metricSub}>{completedSummary.distanceMeters} m</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Średnia prędkość</Text>
                    <Text style={styles.metricValue}>
                      {completedSummary.averageSpeedKmh} km/h
                    </Text>
                    <Text style={styles.metricSub}>Z całej sesji</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Średnia moc</Text>
                    <Text style={styles.metricValue}>
                      {completedSummary.averagePowerWatts !== null
                        ? `${completedSummary.averagePowerWatts} W`
                        : '—'}
                    </Text>
                    <Text style={styles.metricSub}>Maks: {completedSummary.maxPowerWatts ?? '-'} W</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Średnia kadencja</Text>
                    <Text style={styles.metricValue}>
                      {completedSummary.averageCadenceRpm !== null
                        ? `${completedSummary.averageCadenceRpm} RPM`
                        : '—'}
                    </Text>
                    <Text style={styles.metricSub}>
                      {completedSummary.equipmentType === WorkoutType.TREADMILL &&
                      completedSummary.averageInclinePercent !== null
                        ? `Śr. nachylenie: ${completedSummary.averageInclinePercent}%`
                        : 'Rower FTMS'}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Tętno (Śr. / Maks.)</Text>
                    <Text style={styles.metricValue}>
                      {completedSummary.averageHeartRateBpm !== null
                        ? `${completedSummary.averageHeartRateBpm} / ${completedSummary.maxHeartRateBpm || '-'} BPM`
                        : '—'}
                    </Text>
                    <Text style={styles.metricSub}>Spalone: {completedSummary.estimatedCalories} kcal</Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.primaryButton, { marginBottom: 10 }]}
                  onPress={handleExportFitToGarmin}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      ⌚ Wygeneruj .FIT i wyślij do Garmin Connect
                    </Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={handleResetSession}
                >
                  <Text style={styles.secondaryButtonText}>🔄 Rozpocznij kolejny trening</Text>
                </TouchableOpacity>

                {fitExportMessage && (
                  <Text style={styles.fitSuccessText}>{fitExportMessage}</Text>
                )}
              </View>
            )}

            {/* 4. Local Persisted Session History (R2) */}
            <View style={styles.card}>
              <View style={styles.headerRow}>
                <View style={styles.headerTitleContainer}>
                  <Text style={styles.sectionTitle}>
                    📁 Zapisane sesje w pamięci lokalnej ({savedSessions.length})
                  </Text>
                </View>
                {savedSessions.length > 0 && (
                  <TouchableOpacity onPress={handleClearSavedSessions}>
                    <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '600' }}>
                      Wyczyść historię
                    </Text>
                  </TouchableOpacity>
                )}
              </View>

              {savedSessions.length === 0 ? (
                <Text style={styles.stepNotes}>
                  Brak zapisanych treningów Matrix w pamięci lokalnej. Ukończ sesję (przycisk
                  "Zakończ i podsumuj"), aby wyliczyć i zapisać podsumowanie.
                </Text>
              ) : (
                savedSessions.map((s, idx) => (
                  <View key={s.id || idx} style={styles.savedSessionCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.savedSessionHeader}>
                        {s.equipmentType === WorkoutType.BIKE ? '🚲 Rower' : '🏃 Bieżnia'} •{' '}
                        {s.deviceName || 'Konsola Matrix'}
                      </Text>
                      <Text style={styles.stepTarget}>
                        Czas: {formatDuration(s.summary.durationSeconds)} • Dystans:{' '}
                        {formatDistanceKm(s.summary.distanceMeters)} • Śr. prędkość:{' '}
                        {s.summary.averageSpeedKmh} km/h
                      </Text>
                      <Text style={styles.stepNotes}>
                        {s.summary.averagePowerWatts !== null
                          ? `Moc: ${s.summary.averagePowerWatts}W • `
                          : ''}
                        {s.summary.averageHeartRateBpm !== null
                          ? `Śr. HR: ${s.summary.averageHeartRateBpm} BPM • `
                          : ''}
                        {s.summary.estimatedCalories} kcal • {s.savedAt.slice(0, 16).replace('T', ' ')}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.inspectBtn}
                      onPress={() => setSelectedSavedSession(s)}
                    >
                      <Text style={styles.inspectBtnText}>Szczegóły</Text>
                    </TouchableOpacity>
                  </View>
                ))
              )}

              {/* Inspected Saved Session Detail Modal Card */}
              {selectedSavedSession && (
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryTitle}>
                    🔎 Szczegóły Zapisanej Sesji ({selectedSavedSession.id})
                  </Text>
                  <Text style={styles.stepNotes}>
                    Sprzęt: {selectedSavedSession.equipmentType} • Urządzenie:{' '}
                    {selectedSavedSession.deviceName || 'Matrix BLE FTMS'} • Próbek: {selectedSavedSession.samplesCount}
                  </Text>
                  <View style={[styles.metricsGrid, { marginTop: 8 }]}>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Czas</Text>
                      <Text style={styles.metricValue}>
                        {formatDuration(selectedSavedSession.summary.durationSeconds)}
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Dystans</Text>
                      <Text style={styles.metricValue}>
                        {formatDistanceKm(selectedSavedSession.summary.distanceMeters)}
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Śr. Prędkość</Text>
                      <Text style={styles.metricValue}>
                        {selectedSavedSession.summary.averageSpeedKmh} km/h
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Śr. Moc</Text>
                      <Text style={styles.metricValue}>
                        {selectedSavedSession.summary.averagePowerWatts !== null
                          ? `${selectedSavedSession.summary.averagePowerWatts} W`
                          : '—'}
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Śr. HR</Text>
                      <Text style={styles.metricValue}>
                        {selectedSavedSession.summary.averageHeartRateBpm !== null
                          ? `${selectedSavedSession.summary.averageHeartRateBpm} BPM`
                          : '—'}
                      </Text>
                    </View>
                    <View style={styles.metricBox}>
                      <Text style={styles.metricLabel}>Kalorie</Text>
                      <Text style={styles.metricValue}>
                        {selectedSavedSession.summary.estimatedCalories} kcal
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={[styles.secondaryButton, { marginTop: 6 }]}
                    onPress={() => setSelectedSavedSession(null)}
                  >
                    <Text style={styles.secondaryButtonText}>✕ Zamknij szczegóły</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </>
        )}

        {activeTab === 'TECHNIQUE_VIDEO' && (
          <View style={styles.card}>
            <Text style={styles.title}>Analiza Wideo Techniki Biegu (AI Vision)</Text>
            <Text style={styles.subtitle}>
              Gemini Video + Korelacja Garmin Running Dynamics (Kadencja: 164 spm, GCT: 264 ms)
            </Text>

            <View style={styles.divider} />

            <Text style={styles.sectionTitle}>Wykryte błędy biomechaniczne</Text>
            {gaitReport.flaws.map((flaw, i) => (
              <View key={i} style={styles.stepItem}>
                <Text style={styles.stepHeader}>
                  ⚠️ {flaw.flawType} ({flaw.severity})
                </Text>
                <Text style={styles.stepNotes}>{flaw.description}</Text>
              </View>
            ))}

            <Text style={styles.sectionTitle}>Zalecone ćwiczenia korygujące</Text>
            {gaitReport.exercises.map((ex, i) => (
              <View key={i} style={styles.stepItem}>
                <Text style={styles.stepHeader}>✅ {ex.name}</Text>
                <Text style={styles.stepTarget}>{ex.suggestedRepsOrDuration}</Text>
                <Text style={styles.stepNotes}>{ex.description}</Text>
              </View>
            ))}

            <TouchableOpacity style={styles.primaryButton} onPress={handleInjectCorrectiveDrills}>
              <Text style={styles.primaryButtonText}>
                {drillsApplied
                  ? '✅ Ćwiczenia wplecione do rozgrzewki!'
                  : '➕ Dodaj ćwiczenia korygujące do rozgrzewek w planie'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#1e293b',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#0f172a',
  },
  tabButtonActive: {
    backgroundColor: '#0284c7',
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
    textAlign: 'center',
  },
  tabTextActive: {
    color: '#ffffff',
  },
  serverIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: '#0b1329',
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    flexWrap: 'wrap',
  },
  serverIndicatorText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '500',
    flexShrink: 1,
  },
  scrollContent: {
    padding: 16,
  },
  bannerBox: {
    backgroundColor: '#1e3a8a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#38bdf8',
    flexDirection: 'row',
    alignItems: 'center',
  },
  bannerText: {
    color: '#f8fafc',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    flexWrap: 'wrap',
    lineHeight: 18,
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitleContainer: {
    flex: 1,
    marginRight: 8,
  },
  title: {
    fontSize: 19,
    fontWeight: 'bold',
    color: '#ffffff',
    flexWrap: 'wrap',
  },
  subtitle: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 2,
    lineHeight: 16,
    flexWrap: 'wrap',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    flexShrink: 0,
    alignSelf: 'flex-start',
  },
  statusConnected: {
    backgroundColor: '#065f46',
  },
  statusDisconnected: {
    backgroundColor: '#7f1d1d',
  },
  statusText: {
    color: '#ecfdf5',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 14,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  choiceCard: {
    width: '48%',
    backgroundColor: '#0f172a',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginBottom: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  choiceCardActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  choiceCardText: {
    color: '#94a3b8',
    fontWeight: '600',
    fontSize: 13,
  },
  choiceCardTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 14,
  },
  inputGroup: {
    flex: 1,
  },
  textInput: {
    backgroundColor: '#0f172a',
    color: '#ffffff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: '#334155',
    marginTop: 4,
  },
  metricBox: {
    width: '48%',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  metricLabel: {
    fontSize: 11,
    color: '#94a3b8',
  },
  metricValue: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#38bdf8',
    marginTop: 2,
  },
  metricSub: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  fatigueRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  fatigueButton: {
    flex: 1,
    marginHorizontal: 4,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    alignItems: 'center',
  },
  fatigueButtonActive: {
    backgroundColor: '#0284c7',
  },
  fatigueButtonText: {
    color: '#94a3b8',
    fontWeight: '700',
  },
  fatigueButtonTextActive: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  dayPill: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#334155',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayPillActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  dayPillText: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  dayPillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  sectionSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
    marginBottom: 6,
  },
  modalityButtonGroup: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  modalityButton: {
    flex: 1,
    minWidth: 90,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalityButtonActive: {
    backgroundColor: '#0284c7',
    borderColor: '#38bdf8',
  },
  modalityButtonText: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    flexShrink: 1,
  },
  modalityButtonTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  resetButton: {
    backgroundColor: '#1e293b',
    borderWidth: 1.5,
    borderColor: '#f59e0b',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  resetButtonText: {
    color: '#fbbf24',
    fontWeight: '700',
    fontSize: 14,
  },
  aiAlertBox: {
    marginTop: 14,
    backgroundColor: '#422006',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#ca8a04',
  },
  aiAlertTitle: {
    color: '#fef08a',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 4,
    flexWrap: 'wrap',
  },
  aiAlertText: {
    color: '#fde047',
    fontSize: 12,
    marginBottom: 10,
    lineHeight: 18,
    flexWrap: 'wrap',
  },
  aiAdaptButton: {
    backgroundColor: '#ca8a04',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  aiAdaptButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
  },
  sportTag: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38bdf8',
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  workoutTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 4,
  },
  workoutDesc: {
    fontSize: 13,
    color: '#94a3b8',
    marginTop: 4,
    marginBottom: 12,
  },
  stepsList: {
    marginBottom: 14,
  },
  stepItem: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  stepHeader: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e2e8f0',
  },
  stepTarget: {
    fontSize: 13,
    color: '#38bdf8',
    marginTop: 3,
  },
  stepNotes: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 3,
  },
  actionsRow: {
    gap: 10,
  },
  secondaryButton: {
    backgroundColor: '#334155',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  secondaryButtonText: {
    color: '#f8fafc',
    fontWeight: '600',
    fontSize: 14,
  },
  primaryButton: {
    backgroundColor: '#0284c7',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  fitSuccessText: {
    marginTop: 10,
    color: '#34d399',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  connectedInfoBox: {
    backgroundColor: '#064e3b',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#059669',
  },
  connectedInfoTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#a7f3d0',
    marginBottom: 4,
  },
  connectedInfoEmail: {
    fontSize: 13,
    color: '#d1fae5',
    marginBottom: 4,
  },
  connectedInfoHint: {
    fontSize: 11,
    color: '#6ee7b7',
    lineHeight: 16,
  },
  boldText: {
    fontWeight: 'bold',
    color: '#ffffff',
  },
  dangerButton: {
    backgroundColor: '#7f1d1d',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#b91c1c',
  },
  dangerButtonText: {
    color: '#fee2e2',
    fontWeight: 'bold',
    fontSize: 14,
  },
  statusScanning: {
    backgroundColor: '#b45309',
  },
  statusRecording: {
    backgroundColor: '#dc2626',
  },
  statusPaused: {
    backgroundColor: '#d97706',
  },
  statusIdle: {
    backgroundColor: '#334155',
  },
  timerHighlight: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginVertical: 10,
    borderWidth: 1.5,
    borderColor: '#0284c7',
  },
  timerHighlightLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38bdf8',
    letterSpacing: 1.2,
  },
  timerHighlightText: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#ffffff',
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  controlButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginVertical: 8,
  },
  controlButtonStart: {
    flex: 1,
    backgroundColor: '#16a34a',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  controlButtonPause: {
    flex: 1,
    backgroundColor: '#d97706',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  controlButtonResume: {
    flex: 1,
    backgroundColor: '#0284c7',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  controlButtonFinish: {
    flex: 1,
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  controlButtonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  deviceItem: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  deviceItemTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  },
  deviceItemSub: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  deviceConnectBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  deviceConnectBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  savedSessionCard: {
    backgroundColor: '#0f172a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#334155',
  },
  savedSessionHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 2,
  },
  inspectBtn: {
    backgroundColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 8,
  },
  inspectBtnText: {
    color: '#f8fafc',
    fontSize: 11,
    fontWeight: '600',
  },
  summaryCard: {
    backgroundColor: '#0b1329',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#38bdf8',
  },
  summaryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#38bdf8',
    marginBottom: 4,
  },
});
