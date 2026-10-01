import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import type { LocationObject } from "expo-location";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getApiToken, getCurrentUser, getOrCreateDeviceId, setCheckedIn, addAttendance } from "./storage";
import { attendanceCheckOut, getAttendanceStatus, getUserGeofences } from "./attendance-api";
import { getVerifiedLocationEvidence } from "./location-service";
import { getEffectiveGeofenceRadiusMeters, isConfidentlyOutside } from "./geofence";
import type { AttendanceRecord, Geofence } from "./types";

const GEOFENCE_TASK = "BACKGROUND_ATTENDANCE_GEOFENCE_TASK";
const LOCATION_WATCHDOG_TASK = "BACKGROUND_ATTENDANCE_LOCATION_WATCHDOG_TASK";
const KEY = "@attendance_background_session_v2";
type Session = { active: AttendanceRecord; zone: Geofence; pendingExit?: boolean; pendingExitAt?: string };
let running: Promise<void> | null = null;

async function available() {
  if (Platform.OS === "web" || Constants.appOwnership === "expo") return false;
  try {
    return await TaskManager.isAvailableAsync();
  } catch {
    return false;
  }
}

function isFiniteCoordinate(latitude: unknown, longitude: unknown): latitude is number {
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

async function readSession(): Promise<Session | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as Partial<Session> | null;
    if (
      !session?.active?.id ||
      !session.active.userId ||
      !session.active.deviceId ||
      !session.zone?.id ||
      !isFiniteCoordinate(session.zone.latitude, session.zone.longitude)
    ) {
      await AsyncStorage.removeItem(KEY);
      return null;
    }
    return session as Session;
  } catch {
    await AsyncStorage.removeItem(KEY);
    return null;
  }
}

export async function stopAttendanceGeofence() {
  await AsyncStorage.removeItem(KEY);
  try {
    if (await available() && await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch (error) {
    console.warn("Unable to stop attendance geofence", error instanceof Error ? error.message : error);
  }
  try {
    if (await available() && await Location.hasStartedLocationUpdatesAsync(LOCATION_WATCHDOG_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_WATCHDOG_TASK);
    }
  } catch (error) {
    console.warn("Unable to stop attendance location watchdog", error instanceof Error ? error.message : error);
  }
}

async function ensureBackgroundLocationPermission(requestPermission: boolean): Promise<boolean> {
  let foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted && requestPermission) {
    foreground = await Location.requestForegroundPermissionsAsync();
  }
  if (!foreground.granted) return false;

  let background = await Location.getBackgroundPermissionsAsync();
  if (!background.granted && requestPermission) {
    background = await Location.requestBackgroundPermissionsAsync();
  }
  return Boolean(background.granted);
}

async function startAttendanceLocationWatchdog(active: AttendanceRecord, zone: Geofence): Promise<void> {
  const effectiveRadius = getEffectiveGeofenceRadiusMeters(zone);
  const distanceInterval = Math.max(60, Math.min(150, Math.round(effectiveRadius / 4)));
  await Location.startLocationUpdatesAsync(LOCATION_WATCHDOG_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 45_000,
    distanceInterval,
    deferredUpdatesInterval: 60_000,
    deferredUpdatesDistance: distanceInterval,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Attendance auto-checkout active",
      notificationBody: "Lumina is watching your office boundary during this active check-in.",
      notificationColor: "#2563EB",
      killServiceOnDestroy: false,
    },
  });
}

export async function startAttendanceGeofence(active: AttendanceRecord, zones: Geofence[], requestPermission = false): Promise<boolean> {
  try {
    if (!await available()) return false;
    if (!await ensureBackgroundLocationPermission(requestPermission)) return false;
    const zone = zones.find(item => item.id === active.geofenceId && item.isActive);
    if (!zone || !isFiniteCoordinate(zone.latitude, zone.longitude)) return false;
    const session = await readSession();
    const geofenceStarted = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    const watchdogStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_WATCHDOG_TASK).catch(() => false);
    if (session?.active.id === active.id && session.zone.updatedAt === zone.updatedAt && geofenceStarted && watchdogStarted) return true;
    await AsyncStorage.setItem(KEY, JSON.stringify({ active, zone }));
    // Two exit rings provide another OS event if the first GPS verification is inconclusive.
    // Only the checked-in office is monitored, rather than every company office.
    await Location.startGeofencingAsync(GEOFENCE_TASK, [80, 160].map(margin => ({
      identifier: `${active.id}:${margin}`, latitude: zone.latitude, longitude: zone.longitude,
      radius: getEffectiveGeofenceRadiusMeters(zone) + margin, notifyOnEnter: true, notifyOnExit: true,
    })));
    await startAttendanceLocationWatchdog(active, zone);
    return true;
  } catch (error) {
    console.warn("Unable to start attendance geofence", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function getAttendanceGeofenceRuntimeStatus(): Promise<{
  available: boolean;
  hasActiveSession: boolean;
  geofenceStarted: boolean;
  locationWatchdogStarted: boolean;
  fullyEnabled: boolean;
}> {
  const runtimeAvailable = await available();
  const session = await readSession();
  let geofenceStarted = false;
  let locationWatchdogStarted = false;
  if (runtimeAvailable) {
    geofenceStarted = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    locationWatchdogStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_WATCHDOG_TASK).catch(() => false);
  }
  return {
    available: runtimeAvailable,
    hasActiveSession: Boolean(session),
    geofenceStarted,
    locationWatchdogStarted,
    fullyEnabled: Boolean(session && geofenceStarted && locationWatchdogStarted),
  };
}

function getBestOutsideFix(zone: Geofence, locations: LocationObject[]): LocationObject | null {
  const outside = locations
    .filter((location) =>
      isConfidentlyOutside(
        zone,
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy ?? Number.POSITIVE_INFINITY
      )
    )
    .sort((a, b) => (a.coords.accuracy ?? Number.POSITIVE_INFINITY) - (b.coords.accuracy ?? Number.POSITIVE_INFINITY));
  return outside[0] ?? null;
}

function getSampleWindowMs(locations: LocationObject[]): number {
  if (locations.length < 2) return 0;
  const timestamps = locations.map((location) => location.timestamp).sort((a, b) => a - b);
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

async function markPendingExit() {
  const session = await readSession();
  if (!session) return;
  await AsyncStorage.setItem(KEY, JSON.stringify({ ...session, pendingExit: true, pendingExitAt: new Date().toISOString() }));
}

async function verifyExit(locations?: LocationObject[]) {
  const session = await readSession();
  if (!session) return;
  if (!session.pendingExit) return;
  const [user, token, deviceId] = await Promise.all([getCurrentUser(), getApiToken(), getOrCreateDeviceId()]);
  if (!token || !user || user.id !== session.active.userId || deviceId !== session.active.deviceId) return;
  const freshLocations = (locations ?? []).filter((location) => Date.now() - location.timestamp <= 2 * 60_000);
  let fix = getBestOutsideFix(session.zone, freshLocations);
  let sampleCount = Math.max(1, freshLocations.length);
  let sampleWindowMs = getSampleWindowMs(freshLocations);

  if (!fix) {
    const evidence = await getVerifiedLocationEvidence({
      minAccuracyMeters: 100,
      requiredStableSamples: 1,
      maxAttempts: 3,
      maxDriftMeters: 80,
      timeoutMs: 12_000,
    });
    fix = evidence.location;
    sampleCount = Math.max(1, evidence.sampleCount);
    sampleWindowMs = evidence.sampleWindowMs;
  }

  if (!isConfidentlyOutside(session.zone, fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy ?? Number.POSITIVE_INFINITY)) return;
  const record = await attendanceCheckOut({
    requestId: `exit_${session.active.id}`, actionSource: "geofence_exit", activeAttendanceId: session.active.id,
    userId: user.id, userName: user.name, deviceId, photoType: "checkout",
    latitude: fix.coords.latitude, longitude: fix.coords.longitude, locationAccuracyMeters: fix.coords.accuracy,
    capturedAtClient: new Date(fix.timestamp).toISOString(), locationSampleCount: sampleCount,
    locationSampleWindowMs: sampleWindowMs, mockLocationDetected: false,
    biometricRequired: false, biometricVerified: false, isInsideGeofence: false,
    notes: "Automatic checkout: verified office exit in background",
  });
  await addAttendance(record);
  await setCheckedIn(false);
  await stopAttendanceGeofence();
}

export async function retryPendingAttendanceExit(locations?: LocationObject[]) {
  if (running) return running;
  running = verifyExit(locations).catch(error => console.warn("Office exit is not yet confirmed", error instanceof Error ? error.message : error)).finally(() => { running = null; });
  return running;
}

async function handleLocationWatchdog(locations: LocationObject[]) {
  const session = await readSession();
  if (!session || locations.length === 0) return;
  if (!getBestOutsideFix(session.zone, locations)) {
    if (session.pendingExit) await retryPendingAttendanceExit(locations);
    return;
  }
  await markPendingExit();
  await retryPendingAttendanceExit(locations);
}

try {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const event = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
    const session = await readSession();
    if (!session || !event.region.identifier?.startsWith(`${session.active.id}:`)) return;
    // A later entry does not erase a pending exit: verification decides using fresh GPS.
    if (event.eventType === Location.GeofencingEventType.Exit) {
      await markPendingExit();
      await retryPendingAttendanceExit();
    }
  });
  TaskManager.defineTask(LOCATION_WATCHDOG_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const payload = data as { locations?: LocationObject[] };
    await handleLocationWatchdog(Array.isArray(payload.locations) ? payload.locations : []);
  });
} catch (error) {
  if (__DEV__) {
    console.warn("Attendance background task unavailable", error instanceof Error ? error.message : error);
  }
}

export async function reconcileAttendanceGeofence() {
  if (!await available() || !await getApiToken()) return;
  const { active } = await getAttendanceStatus();
  if (!active) { await stopAttendanceGeofence(); return; }
  await startAttendanceGeofence(active, await getUserGeofences(active.userId));
  await retryPendingAttendanceExit();
}
