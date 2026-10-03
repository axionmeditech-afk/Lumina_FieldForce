import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState, PermissionsAndroid, Platform, type AppStateStatus } from 'react-native';
import {
  resumeAttendanceWatchdogAfterFieldTracking,
  suspendAttendanceWatchdogForFieldTracking,
} from '@/lib/attendance-background';
import { fieldTrackingConfig } from '../config';
import type { TrackingSession } from '../types';
import { persistFieldLocation, waitForFieldCaptures } from './capture';
import { completeActiveSession, createSession, getActiveSession, setSessionCompanyIfMissing, setState } from './database';
import { syncFieldOutbox } from './sync';

let foregroundSubscription: Location.LocationSubscription | null = null;
let appStateSubscription: { remove: () => void } | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

export async function readFieldPermissions() {
  const foreground = await Location.getForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync().catch(() => null);
  const locationServicesEnabled = await Location.hasServicesEnabledAsync();
  const taskManagerAvailable = await TaskManager.isAvailableAsync().catch(() => false);
  const backgroundCapable = !fieldTrackingConfig.isExpoGo && taskManagerAvailable;
  return {
    precisePermission: foreground.granted && (Platform.OS !== 'android' || !foreground.android?.accuracy || foreground.android.accuracy === 'fine'),
    backgroundPermission: backgroundCapable ? Boolean(background?.granted) : false,
    locationServicesEnabled,
    backgroundCapable,
  };
}

async function requestPermissions() {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) return readFieldPermissions();
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33 && !fieldTrackingConfig.isExpoGo) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => undefined);
  }
  let current = await readFieldPermissions();
  if (!current.locationServicesEnabled && Platform.OS === 'android') {
    await Location.enableNetworkProviderAsync().catch(() => undefined);
    current = await readFieldPermissions();
  }
  if (current.backgroundCapable && !current.backgroundPermission) {
    await Location.requestBackgroundPermissionsAsync();
  }
  return readFieldPermissions();
}

async function getInitialFix(): Promise<Location.LocationObject> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: Location.LocationSubscription | null = null;
    let best: Location.LocationObject | null = null;
    const finish = (location: Location.LocationObject | null, error?: Error) => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      clearTimeout(timeout);
      if (location) resolve(location);
      else reject(error ?? new Error('initial_gps_unavailable'));
    };
    const timeout = setTimeout(() => {
      const accuracy = best?.coords.accuracy ?? Number.POSITIVE_INFINITY;
      finish(best && accuracy <= fieldTrackingConfig.initialFixFallbackM ? best : null, new Error('Move outdoors and retry; a reliable GPS fix was not available.'));
    }, 30_000);
    void Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1_000, distanceInterval: 0, mayShowUserSettingsDialog: true },
      (location) => {
        if ((location.coords.accuracy ?? Infinity) < (best?.coords.accuracy ?? Infinity)) best = location;
        if ((location.coords.accuracy ?? Infinity) <= fieldTrackingConfig.initialFixTargetM) finish(location);
      },
      () => finish(null, new Error('Live GPS location is unavailable.')),
    ).then((value) => {
      subscription = value;
      if (settled) value.remove();
    }).catch(() => finish(null, new Error('Live GPS location is unavailable.')));
  });
}

async function startForegroundWatcher(): Promise<void> {
  if (foregroundSubscription) return;
  foregroundSubscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: fieldTrackingConfig.captureTimeMs,
      distanceInterval: fieldTrackingConfig.captureDistanceM,
      mayShowUserSettingsDialog: true,
    },
    (location) => {
      void persistFieldLocation(location)
        .then(() => setState('tracker_state', 'tracking'))
        .catch((error: unknown) => setState('last_tracker_error', error instanceof Error ? error.message : 'foreground_capture_failed'));
    },
    (message) => void setState('last_tracker_error', message || 'foreground_location_error'),
  );
}

function stopForegroundWatcher() {
  foregroundSubscription?.remove();
  foregroundSubscription = null;
}

function installExpoGoLifecycle() {
  if (appStateSubscription) return;
  appStateSubscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void getActiveSession().then((session) => session ? startForegroundWatcher() : undefined);
  });
}

function startSyncTimer() {
  if (!syncTimer) syncTimer = setInterval(() => void syncFieldOutbox(), fieldTrackingConfig.syncIntervalMs);
}

function stopSyncTimer() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

async function startNativeTask(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(fieldTrackingConfig.locationTaskName).catch(() => false);
  if (started) return;
  await suspendAttendanceWatchdogForFieldTracking();
  await Location.startLocationUpdatesAsync(fieldTrackingConfig.locationTaskName, {
    accuracy: Location.Accuracy.High,
    timeInterval: fieldTrackingConfig.captureTimeMs,
    distanceInterval: fieldTrackingConfig.captureDistanceM,
    activityType: Location.ActivityType.OtherNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Field tracking is active',
      notificationBody: 'Your work route is being recorded securely.',
      notificationColor: '#1769D2',
      killServiceOnDestroy: false,
    },
  });
}

export async function restoreFieldTracker(employeeId?: string): Promise<void> {
  const session = await getActiveSession(employeeId);
  if (!session) return;
  const permissions = await readFieldPermissions();
  if (!permissions.locationServicesEnabled || !permissions.precisePermission) {
    await setState('tracker_state', 'degraded');
    return;
  }
  if (permissions.backgroundCapable && !permissions.backgroundPermission) {
    await setState('tracker_state', 'degraded');
    await setState('last_tracker_error', 'background_location_required_allow_all_the_time');
    return;
  }
  if (permissions.backgroundCapable) await startNativeTask();
  else if (!permissions.backgroundCapable) {
    installExpoGoLifecycle();
    if (AppState.currentState === 'active') await startForegroundWatcher();
  }
  startSyncTimer();
  await setState('tracker_state', 'tracking');
}

export async function startFieldTracking(employeeId: string, companyId: string): Promise<TrackingSession> {
  if (!companyId.trim()) throw new Error('Select a workspace before starting field tracking.');
  const existing = await getActiveSession();
  if (existing) {
    if (existing.employeeId !== employeeId) {
      await stopNativeTrackingProducer();
      await completeActiveSession(new Date().toISOString(), existing.employeeId);
    } else {
      await setSessionCompanyIfMissing(existing.id, companyId);
      await restoreFieldTracker(employeeId);
      return { ...existing, companyId: existing.companyId || companyId };
    }
  }
  await setState('tracker_state', 'starting');
  await setState('last_tracker_error', '');
  const permissions = await requestPermissions();
  if (!permissions.locationServicesEnabled) throw new Error('Turn on device location and retry.');
  if (!permissions.precisePermission) throw new Error('Precise location permission is required.');
  if (permissions.backgroundCapable && !permissions.backgroundPermission) throw new Error('Choose Allow all the time for reliable background tracking.');

  const session: TrackingSession = {
    id: Crypto.randomUUID(),
    employeeId,
    companyId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'active',
  };
  await createSession(session);
  try {
    await persistFieldLocation(await getInitialFix());
    if (permissions.backgroundCapable) await startNativeTask();
    else {
      installExpoGoLifecycle();
      await startForegroundWatcher();
    }
    startSyncTimer();
    await setState('tracker_state', 'tracking');
    await syncFieldOutbox(employeeId, true);
    return session;
  } catch (error) {
    stopForegroundWatcher();
    stopSyncTimer();
    await resumeAttendanceWatchdogAfterFieldTracking();
    await completeActiveSession(new Date().toISOString());
    await setState('tracker_state', 'degraded');
    throw error;
  }
}

export async function stopFieldTracking(employeeId?: string): Promise<void> {
  const session = await getActiveSession(employeeId);
  if (!session) return;
  await setState('tracker_state', 'stopping');
  await stopNativeTrackingProducer();
  await waitForFieldCaptures();
  const finalLocation = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null);
  if (finalLocation) await persistFieldLocation(finalLocation);
  await waitForFieldCaptures();
  await completeActiveSession(new Date().toISOString(), session.employeeId);
  await syncFieldOutbox(session.employeeId, true);
  await resumeAttendanceWatchdogAfterFieldTracking();
  await setState('tracker_state', 'stopped');
}

async function stopNativeTrackingProducer(): Promise<void> {
  if (!fieldTrackingConfig.isExpoGo) {
    const started = await Location.hasStartedLocationUpdatesAsync(fieldTrackingConfig.locationTaskName).catch(() => false);
    if (started) await Location.stopLocationUpdatesAsync(fieldTrackingConfig.locationTaskName).catch(() => undefined);
  }
  stopForegroundWatcher();
  stopSyncTimer();
  await waitForFieldCaptures();
}
