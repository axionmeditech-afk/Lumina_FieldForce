import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { postLocationBatch } from "@/lib/attendance-api";
import { getBatteryLevelPercent } from "@/lib/battery";
import { maybeSendLocationReminder } from "@/lib/location-reminders";
import { addLocationLog, getCurrentUser, getSettings } from "@/lib/storage";
import {
  recordGpsDisabledDuringCheckIn,
  recordGpsRestoredDuringCheckIn,
} from "@/lib/gps-tracking-alerts";

const BACKGROUND_LOCATION_TASK = "trackforce-background-location-task-v1";
const BACKGROUND_QUEUE_KEY = "@trackforce_background_location_queue";
const BACKGROUND_RECOVERY_CAPTURE_KEY = "@trackforce_background_recovery_capture_v1";
const MAX_BATCH_SIZE = 25;
const RECOVERY_CAPTURE_MIN_INTERVAL_MS = 20 * 1000;

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
  5
);

interface QueuedLocationPoint {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  capturedAt: string;
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
  queue.push(...entries);
  const bounded = queue.slice(-1500);
  await writeQueue(bounded);
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
    },
  ]);
}

export async function flushBackgroundLocationQueue(options?: { force?: boolean }): Promise<void> {
  const settings = await getSettings();
  if (!options?.force && (settings.offlineMode === "true" || settings.autoSync === "false")) {
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
        }))
      );
      remaining.splice(0, batch.length);
    } catch {
      break;
    }
  }

  await writeQueue(remaining);
}

async function handleBackgroundLocations(data: unknown): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return;

  const settings = await getSettings();
  if (settings.locationTracking === "false") return;

  const payload = data as { locations?: Location.LocationObject[] } | undefined;
  const locations = Array.isArray(payload?.locations) ? payload.locations : [];
  if (!locations.length) return;

  const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
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
    });
  }

  if (settings.notifications !== "false") {
    const latestPoint = queuePoints[queuePoints.length - 1];
    if (latestPoint) {
      await maybeSendLocationReminder({
        latitude: latestPoint.latitude,
        longitude: latestPoint.longitude,
        userId: currentUser.id,
        companyId: currentUser.companyId ?? null,
      });
    }
  }

  if (settings.autoSync !== "false" && settings.offlineMode !== "true") {
    await flushBackgroundLocationQueue();
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

  const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
  const point = toQueuePoint(user.id, location, batteryLevel);
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

export async function ensureBackgroundLocationTracking(): Promise<{
  started: boolean;
  reason?: string;
}> {
  if (Platform.OS === "web") {
    return { started: false, reason: "Background location not supported on web." };
  }

  const currentUser = await getCurrentUser();
  if (!currentUser) {
    await stopBackgroundLocationTracking();
    return { started: false, reason: "No authenticated user." };
  }

  const settings = await getSettings();
  if (settings.locationTracking === "false") {
    await stopBackgroundLocationTracking();
    return { started: false, reason: "Tracking disabled in settings." };
  }

  let foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted && foreground.canAskAgain) {
    foreground = await Location.requestForegroundPermissionsAsync();
  }
  if (!foreground.granted) {
    return { started: false, reason: "Foreground location permission denied." };
  }

  let background = await Location.getBackgroundPermissionsAsync();
  if (!background.granted && background.canAskAgain) {
    background = await Location.requestBackgroundPermissionsAsync();
  }
  if (!background.granted) {
    return { started: false, reason: "Background location permission denied." };
  }

  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    await recordGpsDisabledDuringCheckIn(currentUser, "Device location services are off.");
    return { started: false, reason: "Location services disabled." };
  }

  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      timeInterval: BACKGROUND_LOCATION_INTERVAL_MS,
      distanceInterval: BACKGROUND_LOCATION_DISTANCE_METERS,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.OtherNavigation,
      foregroundService: {
        notificationTitle: "Lumina FieldForce",
        notificationBody: "App is running",
        killServiceOnDestroy: false,
      },
    });
  }

  await recordGpsRestoredDuringCheckIn(currentUser);
  await captureForegroundRecoveryPoint(currentUser);
  await flushBackgroundLocationQueue();
  return { started: true };
}

export async function stopBackgroundLocationTracking(): Promise<void> {
  if (Platform.OS === "web") return;
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
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
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  return { started, queuedPoints };
}
