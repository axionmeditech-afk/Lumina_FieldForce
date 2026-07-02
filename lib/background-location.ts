import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { postLocationBatch, postTrackingStatus } from "@/lib/attendance-api";
import { getBatteryLevelPercent } from "@/lib/battery";
import { maybeSendLocationReminder } from "@/lib/location-reminders";
import { addLocationLog, getCurrentUser, getSettings, isCheckedIn } from "@/lib/storage";
import {
  hasGpsDisabledDuringCheckIn,
  recordGpsDisabledDuringCheckIn,
  recordGpsRestoredDuringCheckIn,
} from "@/lib/gps-tracking-alerts";

const BACKGROUND_LOCATION_TASK = "trackforce-background-location-task-v1";
const BACKGROUND_QUEUE_KEY = "@trackforce_background_location_queue";
const BACKGROUND_RECOVERY_CAPTURE_KEY = "@trackforce_background_recovery_capture_v1";
const BACKGROUND_LAST_TASK_EVENT_KEY = "@trackforce_background_last_task_event_v1";
const BACKGROUND_LAST_ENQUEUED_KEY = "@trackforce_background_last_enqueued_v1";
const BACKGROUND_LAST_FLUSH_ERROR_KEY = "@trackforce_background_last_flush_error_v1";
const BACKGROUND_TRACKER_STATE_KEY = "@trackforce_background_tracker_state_v1";
const MAX_BATCH_SIZE = 25;
const RECOVERY_CAPTURE_MIN_INTERVAL_MS = 20 * 1000;
const BACKGROUND_STALE_EVENT_MS = readPositiveIntegerEnv(
  "EXPO_PUBLIC_FIELD_FORCE_BACKGROUND_STALE_EVENT_MS",
  3 * 60 * 1000
);

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

const BACKGROUND_LOCATION_INTERVAL_MS = readPositiveIntegerEnv(
  "EXPO_PUBLIC_FIELD_FORCE_LOCATION_INTERVAL_MS",
  15 * 1000
);
const BACKGROUND_LOCATION_DISTANCE_METERS = readPositiveIntegerEnv(
  "EXPO_PUBLIC_FIELD_FORCE_LOCATION_DISTANCE_METERS",
  1
);

export type BackgroundTrackerState =
  | "checked_out"
  | "starting"
  | "active"
  | "degraded"
  | "offline_queueing"
  | "permission_blocked"
  | "stopped";

interface TrackerStateSnapshot {
  state: BackgroundTrackerState;
  reason: string | null;
  updatedAt: string;
}

interface QueuedLocationPoint {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  capturedAt: string;
  trackerStatus?: BackgroundTrackerState;
  trackerStatusReason?: string | null;
  trackerStateUpdatedAt?: string | null;
  queuedPoints?: number | null;
  lastClientSyncErrorAt?: string | null;
}

export interface LocationQueuePointPayload {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  capturedAt?: string | null;
  trackerStatus?: BackgroundTrackerState;
  trackerStatusReason?: string | null;
}

async function readQueue(): Promise<QueuedLocationPoint[]> {
  const raw = await AsyncStorage.getItem(BACKGROUND_QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as QueuedLocationPoint[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(entries: QueuedLocationPoint[]): Promise<void> {
  await AsyncStorage.setItem(BACKGROUND_QUEUE_KEY, JSON.stringify(entries));
}

async function rememberLocationHealth(key: string, value?: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value ?? new Date().toISOString());
  } catch {
    // Health metadata must never break location capture.
  }
}

async function readLocationHealth(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setBackgroundTrackerState(
  state: BackgroundTrackerState,
  reason?: string | null
): Promise<void> {
  const snapshot: TrackerStateSnapshot = {
    state,
    reason: reason?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  try {
    await AsyncStorage.setItem(BACKGROUND_TRACKER_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Tracker state is diagnostic metadata; never block GPS capture.
  }
  void reportBackgroundTrackerState(snapshot).catch(() => {
    // Status upload is best-effort; GPS queue remains the source of truth.
  });
}

export async function getBackgroundTrackerState(): Promise<TrackerStateSnapshot> {
  const raw = await readLocationHealth(BACKGROUND_TRACKER_STATE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TrackerStateSnapshot>;
      if (parsed?.state) {
        return {
          state: parsed.state,
          reason: parsed.reason ?? null,
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    } catch {
      // fall through to a stable default
    }
  }
  return {
    state: "stopped",
    reason: null,
    updatedAt: new Date().toISOString(),
  };
}

async function reportBackgroundTrackerState(snapshot?: TrackerStateSnapshot): Promise<void> {
  const currentUser = await getCurrentUser().catch(() => null);
  if (!currentUser?.id) return;
  const [queue, lastClientSyncErrorAt] = await Promise.all([
    readQueue().catch(() => []),
    readLocationHealth(BACKGROUND_LAST_FLUSH_ERROR_KEY),
  ]);
  const resolvedSnapshot = snapshot ?? (await getBackgroundTrackerState());
  await postTrackingStatus({
    userId: currentUser.id,
    trackerStatus: resolvedSnapshot.state,
    trackerStatusReason: resolvedSnapshot.reason,
    queuedPoints: queue.length,
    lastClientSyncErrorAt,
    updatedAt: resolvedSnapshot.updatedAt,
  });
}

function isUsableLocation(location: Location.LocationObject | null | undefined): location is Location.LocationObject {
  return Boolean(
    location &&
      Number.isFinite(location.coords.latitude) &&
      Number.isFinite(location.coords.longitude)
  );
}

async function shouldCaptureRecoveryPoint(userId: string): Promise<boolean> {
  const raw = await AsyncStorage.getItem(`${BACKGROUND_RECOVERY_CAPTURE_KEY}_${userId}`);
  const lastCaptureMs = raw ? Number(raw) : 0;
  return !Number.isFinite(lastCaptureMs) || Date.now() - lastCaptureMs >= RECOVERY_CAPTURE_MIN_INTERVAL_MS;
}

async function markRecoveryPointCaptured(userId: string): Promise<void> {
  await AsyncStorage.setItem(`${BACKGROUND_RECOVERY_CAPTURE_KEY}_${userId}`, String(Date.now()));
}

async function enrichQueuePoint(point: QueuedLocationPoint): Promise<QueuedLocationPoint> {
  const [trackerState, queuedRaw, lastSyncErrorAt] = await Promise.all([
    getBackgroundTrackerState(),
    readQueue().catch(() => []),
    readLocationHealth(BACKGROUND_LAST_FLUSH_ERROR_KEY),
  ]);
  return {
    ...point,
    trackerStatus: point.trackerStatus ?? trackerState.state,
    trackerStatusReason: point.trackerStatusReason ?? trackerState.reason,
    trackerStateUpdatedAt: trackerState.updatedAt,
    queuedPoints: Array.isArray(queuedRaw) ? queuedRaw.length : null,
    lastClientSyncErrorAt: lastSyncErrorAt,
  };
}

function toQueuePoint(
  userId: string,
  location: Location.LocationObject,
  batteryLevel: number | null
): QueuedLocationPoint {
  return {
    userId,
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: typeof location.coords.accuracy === "number" ? location.coords.accuracy : null,
    speed: typeof location.coords.speed === "number" ? location.coords.speed : null,
    heading: typeof location.coords.heading === "number" ? location.coords.heading : null,
    batteryLevel,
    capturedAt: new Date(location.timestamp || Date.now()).toISOString(),
  };
}

export async function enqueueBackgroundLocationPoints(entries: QueuedLocationPoint[]): Promise<void> {
  if (!entries.length) return;
  const queue = await readQueue();
  const trackerState = await getBackgroundTrackerState();
  const lastSyncErrorAt = await readLocationHealth(BACKGROUND_LAST_FLUSH_ERROR_KEY);
  const enriched = entries.map((entry, index) => ({
    ...entry,
    trackerStatus: entry.trackerStatus ?? trackerState.state,
    trackerStatusReason: entry.trackerStatusReason ?? trackerState.reason,
    trackerStateUpdatedAt: trackerState.updatedAt,
    queuedPoints: queue.length + index + 1,
    lastClientSyncErrorAt: lastSyncErrorAt,
  }));
  queue.push(...enriched);
  const bounded = queue.slice(-1500);
  await writeQueue(bounded);
  await rememberLocationHealth(BACKGROUND_LAST_ENQUEUED_KEY, enriched[enriched.length - 1]?.capturedAt);
  void reportBackgroundTrackerState().catch(() => {
    // Keep queue writes fast and reliable even if status upload waits.
  });
}

export async function queueLocationPoint(payload: LocationQueuePointPayload): Promise<void> {
  const capturedAt =
    typeof payload.capturedAt === "string" && payload.capturedAt.trim()
      ? payload.capturedAt
      : new Date().toISOString();
  await enqueueBackgroundLocationPoints([
    {
      userId: payload.userId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: payload.accuracy ?? null,
      speed: payload.speed ?? null,
      heading: payload.heading ?? null,
      batteryLevel: payload.batteryLevel ?? null,
      capturedAt,
      trackerStatus: payload.trackerStatus,
      trackerStatusReason: payload.trackerStatusReason ?? null,
    },
  ]);
}

export async function flushBackgroundLocationQueue(options?: { force?: boolean }): Promise<void> {
  const settings = await getSettings().catch(() => null);
  if (!options?.force && (settings?.offlineMode === "true" || settings?.autoSync === "false")) {
    return;
  }

  const queue = await readQueue();
  if (!queue.length) return;

  const remaining = [...queue];
  while (remaining.length) {
    const batch = remaining.slice(0, MAX_BATCH_SIZE);
    try {
      await postLocationBatch(
        batch.map((item) => ({
          userId: item.userId,
          latitude: item.latitude,
          longitude: item.longitude,
          accuracy: item.accuracy ?? null,
          speed: item.speed ?? null,
          heading: item.heading ?? null,
          batteryLevel: item.batteryLevel ?? null,
          capturedAt: item.capturedAt,
          trackerStatus: item.trackerStatus ?? "active",
          trackerStatusReason: item.trackerStatusReason ?? null,
          trackerStateUpdatedAt: item.trackerStateUpdatedAt ?? null,
          queuedPoints: Math.max(0, remaining.length - batch.length),
          lastClientSyncErrorAt: item.lastClientSyncErrorAt ?? null,
        }))
      );
      remaining.splice(0, batch.length);
      if (!remaining.length) {
        await setBackgroundTrackerState("active", null);
      }
    } catch {
      await setBackgroundTrackerState("offline_queueing", "Location upload failed; points are queued.");
      await rememberLocationHealth(BACKGROUND_LAST_FLUSH_ERROR_KEY);
      break;
    }
  }

  await writeQueue(remaining);
}

async function handleBackgroundLocations(data: unknown): Promise<void> {
  await rememberLocationHealth(BACKGROUND_LAST_TASK_EVENT_KEY);
  const currentUser = await getCurrentUser().catch(() => null);
  if (!currentUser) return;

  const settings = await getSettings().catch(() => null);
  if (settings?.locationTracking === "false") return;

  const payload = data as { locations?: Location.LocationObject[] } | undefined;
  const locations = Array.isArray(payload?.locations) ? payload.locations : [];
  if (!locations.length) return;

  const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 }).catch(() => null);
  const queuePoints = locations.map((location) =>
    toQueuePoint(currentUser.id, location, batteryLevel)
  );
  await enqueueBackgroundLocationPoints(queuePoints);

  for (const point of queuePoints) {
    await addLocationLog({
      id: `bg_loc_${new Date(point.capturedAt).getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: point.userId,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: point.accuracy ?? null,
      speed: point.speed ?? null,
      heading: point.heading ?? null,
      batteryLevel: point.batteryLevel ?? null,
      geofenceId: null,
      geofenceName: null,
      isInsideGeofence: false,
      capturedAt: point.capturedAt,
    }).catch(() => {
      // The server queue above is the source of truth; local log failures should not stop tracking.
    });
  }

  if (settings?.notifications !== "false") {
    const latestPoint = queuePoints[queuePoints.length - 1];
    if (latestPoint) {
      await maybeSendLocationReminder({
        latitude: latestPoint.latitude,
        longitude: latestPoint.longitude,
        userId: currentUser.id,
        companyId: currentUser.companyId ?? null,
      }).catch(() => {
        // Reminder delivery is optional; GPS capture is not.
      });
    }
  }

  if (settings?.autoSync !== "false" && settings?.offlineMode !== "true") {
    await flushBackgroundLocationQueue().catch(() => {
      // Keep the task alive; queued points will retry on the next wake/resume.
    });
  }
}

async function captureForegroundRecoveryPoint(user: { id: string }): Promise<boolean> {
  if (!(await shouldCaptureRecoveryPoint(user.id))) return false;

  let location: Location.LocationObject | null = null;
  try {
    location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
    });
  } catch {
    try {
      location = await Location.getLastKnownPositionAsync({
        maxAge: 60 * 1000,
      });
    } catch {
      location = null;
    }
  }

  if (!isUsableLocation(location)) return false;

  const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 }).catch(() => null);
  const point = await enrichQueuePoint(toQueuePoint(user.id, location, batteryLevel));
  await enqueueBackgroundLocationPoints([point]);
  await addLocationLog({
    id: `fg_loc_${new Date(point.capturedAt).getTime()}_${Math.random().toString(36).slice(2, 8)}`,
    userId: point.userId,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy ?? null,
    speed: point.speed ?? null,
    heading: point.heading ?? null,
    batteryLevel: point.batteryLevel ?? null,
    geofenceId: null,
    geofenceName: null,
    isInsideGeofence: false,
    capturedAt: point.capturedAt,
  }).catch(() => {
    // Recovery point is already queued for backend sync.
  });
  await markRecoveryPointCaptured(user.id);
  return true;
}

if (Platform.OS !== "web" && !TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      return;
    }
    try {
      await handleBackgroundLocations(data);
    } catch {
      // swallow background failures to keep task alive
    }
  });
}

async function hasStartedBackgroundLocationUpdates(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    return false;
  }
}

export async function ensureBackgroundLocationTracking(options?: {
  forceRecoveryCapture?: boolean;
}): Promise<{
  started: boolean;
  reason?: string;
}> {
  if (Platform.OS === "web") {
    return { started: false, reason: "Background location not supported on web." };
  }

  await setBackgroundTrackerState("starting", "Starting background route tracking.");
  const currentUser = await getCurrentUser().catch(() => null);
  if (!currentUser) {
    await setBackgroundTrackerState("stopped", "No authenticated user.");
    await stopBackgroundLocationTracking();
    return { started: false, reason: "No authenticated user." };
  }

  const settings = await getSettings().catch(() => null);
  if (settings?.locationTracking === "false") {
    await setBackgroundTrackerState("stopped", "Tracking disabled in settings.");
    await stopBackgroundLocationTracking();
    return { started: false, reason: "Tracking disabled in settings." };
  }

  let foreground = await Location.getForegroundPermissionsAsync().catch(() => null);
  if (!foreground?.granted && foreground?.canAskAgain) {
    foreground = await Location.requestForegroundPermissionsAsync().catch(() => foreground);
  }
  if (!foreground?.granted) {
    await setBackgroundTrackerState("permission_blocked", "Foreground location permission denied.");
    return { started: false, reason: "Foreground location permission denied." };
  }

  let background = await Location.getBackgroundPermissionsAsync().catch(() => null);
  if (!background?.granted && background?.canAskAgain) {
    background = await Location.requestBackgroundPermissionsAsync().catch(() => background);
  }
  if (!background?.granted) {
    await setBackgroundTrackerState("permission_blocked", "Background location permission denied.");
    return { started: false, reason: "Background location permission denied." };
  }

  const servicesEnabled = await Location.hasServicesEnabledAsync().catch(() => false);
  if (!servicesEnabled) {
    await setBackgroundTrackerState("degraded", "Device location services are off.");
    await recordGpsDisabledDuringCheckIn(currentUser, "Device location services are off.");
    return { started: false, reason: "Location services disabled." };
  }

  const alreadyStarted = await hasStartedBackgroundLocationUpdates();
  const hadGpsDisabledState = await hasGpsDisabledDuringCheckIn(currentUser.id);
  if (!alreadyStarted) {
    try {
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        mayShowUserSettingsDialog: true,
        timeInterval: BACKGROUND_LOCATION_INTERVAL_MS,
        distanceInterval: BACKGROUND_LOCATION_DISTANCE_METERS,
        deferredUpdatesInterval: BACKGROUND_LOCATION_INTERVAL_MS,
        deferredUpdatesDistance: 0,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        activityType: Location.ActivityType.OtherNavigation,
        foregroundService: {
          notificationTitle: "Lumina FieldForce route tracking",
          notificationBody: "Keep this notification active for complete live route tracking.",
          killServiceOnDestroy: false,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start background location.";
      await setBackgroundTrackerState("degraded", message);
      return { started: false, reason: message };
    }
  }

  await recordGpsRestoredDuringCheckIn(currentUser);
  await setBackgroundTrackerState("active", null);
  if (options?.forceRecoveryCapture || hadGpsDisabledState || !alreadyStarted) {
    await captureForegroundRecoveryPoint(currentUser);
  }
  await flushBackgroundLocationQueue().catch(() => {
    // Recovery should still report started even if upload waits for network.
  });
  return { started: true };
}

export async function recoverStaleBackgroundLocationTracking(): Promise<{
  recovered: boolean;
  reason?: string;
}> {
  if (Platform.OS === "web") {
    return { recovered: false, reason: "Background location not supported on web." };
  }
  const currentUser = await getCurrentUser().catch(() => null);
  if (!currentUser) {
    return { recovered: false, reason: "No authenticated user." };
  }
  const checkedIn = await isCheckedIn().catch(() => false);
  if (!checkedIn) {
    return { recovered: false, reason: "User is not checked in." };
  }
  const settings = await getSettings().catch(() => null);
  if (settings?.locationTracking === "false") {
    return { recovered: false, reason: "Tracking disabled in settings." };
  }
  const [lastTaskEventAt, lastEnqueuedAt, trackingStatus] = await Promise.all([
    readLocationHealth(BACKGROUND_LAST_TASK_EVENT_KEY),
    readLocationHealth(BACKGROUND_LAST_ENQUEUED_KEY),
    getBackgroundLocationTrackingStatus(),
  ]);
  const latestHealthAt = [lastTaskEventAt, lastEnqueuedAt]
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const stale =
    !Number.isFinite(latestHealthAt) || Date.now() - latestHealthAt > BACKGROUND_STALE_EVENT_MS;
  if (trackingStatus.started && !stale) {
    return { recovered: false, reason: "Background tracker is fresh." };
  }

  await setBackgroundTrackerState(
    "degraded",
    stale
      ? "No fresh background GPS event received; restarting tracker and capturing recovery point."
      : "Background location service was not running; restarting tracker."
  );
  const result = await ensureBackgroundLocationTracking({ forceRecoveryCapture: true });
  return {
    recovered: result.started,
    reason: result.reason,
  };
}

export async function stopBackgroundLocationTracking(options?: {
  state?: BackgroundTrackerState;
  reason?: string | null;
}): Promise<void> {
  await setBackgroundTrackerState(options?.state ?? "stopped", options?.reason ?? "Tracking stopped.");
  if (Platform.OS === "web") return;
  const started = await hasStartedBackgroundLocationUpdates();
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => {
      // Stopping is best-effort; stale native state will be rechecked on next launch.
    });
  }
}

export async function getBackgroundLocationTrackingStatus(): Promise<{
  started: boolean;
  queuedPoints: number;
}> {
  const queuedPoints = (await readQueue()).length;
  if (Platform.OS === "web") {
    return { started: false, queuedPoints };
  }
  const started = await hasStartedBackgroundLocationUpdates();
  return { started, queuedPoints };
}
