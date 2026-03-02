import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { postLocationBatch } from "@/lib/attendance-api";
import { getBatteryLevelPercent } from "@/lib/battery";
import { getCurrentUser, getSettings } from "@/lib/storage";

const BACKGROUND_LOCATION_TASK = "trackforce-background-location-task-v1";
const BACKGROUND_QUEUE_KEY = "@trackforce_background_location_queue";
const MAX_BATCH_SIZE = 25;

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

export async function flushBackgroundLocationQueue(): Promise<void> {
  const settings = await getSettings();
  if (settings.offlineMode === "true" || settings.autoSync === "false") {
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

  const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 30_000 });
  const queuePoints = locations.map((location) =>
    toQueuePoint(currentUser.id, location, batteryLevel)
  );
  await enqueueBackgroundLocationPoints(queuePoints);

  if (settings.autoSync !== "false" && settings.offlineMode !== "true") {
    await flushBackgroundLocationQueue();
  }
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

  const alreadyStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!alreadyStarted) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 90_000,
      distanceInterval: 45,
      deferredUpdatesInterval: 120_000,
      deferredUpdatesDistance: 110,
      pausesUpdatesAutomatically: true,
      showsBackgroundLocationIndicator: false,
      activityType: Location.ActivityType.OtherNavigation,
      foregroundService: {
        notificationTitle: "TrackForce route tracking active",
        notificationBody: "Background GPS is running during your shift.",
        killServiceOnDestroy: false,
      },
    });
  }

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
