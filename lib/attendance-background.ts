import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import type { LocationObject } from "expo-location";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getApiToken, getCurrentUser, getOrCreateDeviceId, setCheckedIn, addAttendance } from "./storage";
import {
  attendanceCheckOut,
  enqueueAttendanceAction,
  getAttendanceStatus,
  getUserGeofences,
  removeQueuedAttendanceAction,
} from "./attendance-api";
import { ensureAttendanceNotificationPermission, notifyAutoCheckoutPending, notifyAutoCheckoutSynced } from "./attendance-notifications";
import { getVerifiedLocationEvidence } from "./location-service";
import { evaluateAutoCheckoutExit, getEffectiveGeofenceRadiusMeters } from "./geofence";
import type { AttendanceCheckPayload, AttendanceRecord, Geofence } from "./types";

const GEOFENCE_TASK = "BACKGROUND_ATTENDANCE_GEOFENCE_TASK";
const LOCATION_WATCHDOG_TASK = "BACKGROUND_ATTENDANCE_LOCATION_WATCHDOG_TASK";
const KEY = "@attendance_background_session_v2";
const AUTO_CHECKOUT_GRACE_MS = 30_000;
const AUTO_CHECKOUT_MIN_SAMPLES = 2;
const AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS = 2 * 60_000;
const WATCHDOG_VERSION = 2;

type ExitSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  timestamp: number;
  distanceMeters: number;
};

type Session = {
  active: AttendanceRecord;
  zone: Geofence;
  pendingExit?: boolean;
  pendingExitAt?: string;
  exitSamples?: ExitSample[];
  confirmedExit?: AttendanceCheckPayload;
  watchdogVersion?: number;
};
let running: Promise<void> | null = null;
let taskEvents: Promise<void> = Promise.resolve();
function serializeTask<T>(action: () => Promise<T>): Promise<T> {
  const result = taskEvents.then(action);
  taskEvents = result.then(() => undefined, error => console.warn("Attendance background event failed", error));
  return result;
}

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
  return serializeTask(stopAttendanceGeofenceInternal);
}

async function stopAttendanceGeofenceInternal() {
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

async function startAttendanceLocationWatchdog(): Promise<void> {
  await Location.startLocationUpdatesAsync(LOCATION_WATCHDOG_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 30_000,
    distanceInterval: 0,
    deferredUpdatesInterval: 0,
    deferredUpdatesDistance: 0,
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
  return serializeTask(() => startAttendanceGeofenceInternal(active, zones, requestPermission));
}

async function startAttendanceGeofenceInternal(active: AttendanceRecord, zones: Geofence[], requestPermission: boolean): Promise<boolean> {
  try {
    if (!await available()) return false;
    if (!await ensureBackgroundLocationPermission(requestPermission)) return false;
    if (requestPermission) await ensureAttendanceNotificationPermission(true).catch(console.warn);
    const zone = zones.find(item => item.id === active.geofenceId && item.isActive);
    if (!zone || !isFiniteCoordinate(zone.latitude, zone.longitude)) return false;
    const session = await readSession();
    const geofenceStarted = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
    const watchdogStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_WATCHDOG_TASK).catch(() => false);
    if (session?.active.id === active.id && session.zone.updatedAt === zone.updatedAt &&
        session.watchdogVersion === WATCHDOG_VERSION && geofenceStarted && watchdogStarted) return true;
    await AsyncStorage.setItem(KEY, JSON.stringify(
      session?.active.id === active.id ? { ...session, active, zone } : { active, zone }
    ));
    // Two exit rings provide another OS event if the first GPS verification is inconclusive.
    // Only the checked-in office is monitored, rather than every company office.
    await Location.startGeofencingAsync(GEOFENCE_TASK, [80, 160].map(margin => ({
      identifier: `${active.id}:${margin}`, latitude: zone.latitude, longitude: zone.longitude,
      radius: getEffectiveGeofenceRadiusMeters(zone) + margin, notifyOnEnter: true, notifyOnExit: true,
    })));
    await startAttendanceLocationWatchdog();
    // Mark configured only after native registration succeeds; retry a partial start.
    const startedSession = await readSession();
    if (startedSession?.active.id === active.id) await saveSession({ ...startedSession, watchdogVersion: WATCHDOG_VERSION });
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

function toExitSample(zone: Geofence, location: LocationObject): ExitSample | null {
  const age = Date.now() - location.timestamp;
  if (!Number.isFinite(age) || age < 0 || age > AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS) return null;
  if (location.mocked || Boolean((location.coords as { mocked?: boolean }).mocked)) return null;
  const decision = evaluateAutoCheckoutExit(
    zone,
    location.coords.latitude,
    location.coords.longitude,
    location.coords.accuracy ?? null
  );
  if (!decision.outside || !decision.accuracyMeters) return null;
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracyMeters: decision.accuracyMeters,
    timestamp: location.timestamp,
    distanceMeters: decision.distanceMeters,
  };
}

function getSampleWindowMs(samples: ExitSample[]): number {
  if (samples.length < 2) return 0;
  const timestamps = samples.map((sample) => sample.timestamp).sort((a, b) => a - b);
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

function mergeOutsideSamples(session: Session, locations: LocationObject[] = []): Session {
  if (session.confirmedExit) return session;
  const now = Date.now();
  const existing = (session.exitSamples ?? []).filter(
    (sample) => now - sample.timestamp >= 0 && now - sample.timestamp <= AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS
  );
  const byKey = new Map<string, ExitSample>();
  for (const sample of existing) {
    byKey.set(`${sample.timestamp}:${sample.latitude.toFixed(6)}:${sample.longitude.toFixed(6)}`, sample);
  }
  for (const location of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    const age = now - location.timestamp;
    if (!Number.isFinite(age) || age < 0 || age > AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS) continue;
    const sample = toExitSample(session.zone, location);
    if (!sample) {
      const decision = evaluateAutoCheckoutExit(session.zone, location.coords.latitude, location.coords.longitude, location.coords.accuracy);
      if (!location.mocked && !Boolean((location.coords as { mocked?: boolean }).mocked) &&
          decision.usable && decision.distanceMeters + (decision.accuracyMeters || 0) <= decision.effectiveRadiusMeters) {
        byKey.clear();
      }
      continue;
    }
    byKey.set(`${sample.timestamp}:${sample.latitude.toFixed(6)}:${sample.longitude.toFixed(6)}`, sample);
  }
  const exitSamples = Array.from(byKey.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-6);
  const pendingExitAt =
    (exitSamples[0] ? new Date(exitSamples[0].timestamp).toISOString() : new Date().toISOString());
  return { ...session, pendingExit: true, pendingExitAt, exitSamples };
}

function isExitReady(session: Session): boolean {
  const samples = session.exitSamples ?? [];
  if (samples.length < AUTO_CHECKOUT_MIN_SAMPLES) return false;
  return getSampleWindowMs(samples) >= AUTO_CHECKOUT_GRACE_MS || samples.length >= 3;
}

function getLatestExitSample(session: Session): ExitSample | null {
  return [...(session.exitSamples ?? [])].sort((a, b) => {
    return b.timestamp - a.timestamp || a.accuracyMeters - b.accuracyMeters;
  })[0] ?? null;
}

async function saveSession(session: Session) {
  await AsyncStorage.setItem(KEY, JSON.stringify(session));
}

async function markPendingExit(locations?: LocationObject[]) {
  const session = await readSession();
  if (!session) return;
  await saveSession(mergeOutsideSamples(session, locations));
}

async function clearPendingExit() {
  const session = await readSession();
  if (!session || session.confirmedExit) return;
  await saveSession({ ...session, pendingExit: false, pendingExitAt: undefined, exitSamples: [] });
}

async function verifyExit(locations?: LocationObject[]) {
  let session = await readSession();
  if (!session) return;
  if (!session.pendingExit && !session.confirmedExit) return;
  if (!session.confirmedExit) {
    session = mergeOutsideSamples(session, locations);
    await saveSession(session);
  }
  const [user, token, deviceId] = await Promise.all([getCurrentUser(), getApiToken(), getOrCreateDeviceId()]);
  if (!user || user.id !== session.active.userId || deviceId !== session.active.deviceId) return;

  if (!session.confirmedExit && !isExitReady(session)) {
    const evidence = await getVerifiedLocationEvidence({
      minAccuracyMeters: 180,
      requiredStableSamples: 1,
      maxAttempts: 2,
      maxDriftMeters: 120,
      sampleWaitMs: 2500,
      timeoutMs: 7000,
    }).catch(() => null);
    if (evidence?.location) {
      session = mergeOutsideSamples(session, [evidence.location]);
      await saveSession(session);
    }
    if (!isExitReady(session)) return;
  }

  const sample = getLatestExitSample(session);
  if (!sample && !session.confirmedExit) return;
  const requestId = `auto_exit_${session.active.id}`;
  const sampleCount = Math.max(AUTO_CHECKOUT_MIN_SAMPLES, session.exitSamples?.length ?? 0);
  const sampleWindowMs = getSampleWindowMs(session.exitSamples ?? []);
  const evidencePayload: AttendanceCheckPayload = session.confirmedExit || {
    requestId, actionSource: "geofence_exit" as const, activeAttendanceId: session.active.id,
    userId: user.id, userName: user.name, deviceId, photoType: "checkout",
    latitude: sample!.latitude, longitude: sample!.longitude, locationAccuracyMeters: sample!.accuracyMeters,
    capturedAtClient: new Date(sample!.timestamp).toISOString(), locationSampleCount: sampleCount,
    locationSampleWindowMs: sampleWindowMs, mockLocationDetected: false,
    biometricRequired: false, biometricVerified: false, isInsideGeofence: false,
    geofenceDistanceMeters: sample!.distanceMeters,
    notes: `Automatic checkout: verified office exit in background | samples:${sampleCount} | window:${Math.round(sampleWindowMs / 1000)}s | distance:${Math.round(sample!.distanceMeters)}m`,
  };
  const newlyConfirmed = !session.confirmedExit;
  const payload = await enqueueAttendanceAction("checkout", evidencePayload);
  await saveSession({ ...session, confirmedExit: payload });
  if (newlyConfirmed) await notifyAutoCheckoutPending({ detectedAt: payload.capturedAtClient!, distanceMeters: payload.geofenceDistanceMeters }).catch(console.warn);
  if (!token) return;
  const record = await attendanceCheckOut(payload);
  await addAttendance(record);
  await setCheckedIn(false);
  await removeQueuedAttendanceAction("checkout", requestId);
  await notifyAutoCheckoutSynced({ detectedAt: payload.capturedAtClient }).catch(() => undefined);
  await stopAttendanceGeofenceInternal();
}

export async function retryPendingAttendanceExit(locations?: LocationObject[]) {
  if (running) return running;
  running = serializeTask(() => verifyExit(locations)).catch(error => console.warn("Auto-checkout sync pending", error instanceof Error ? error.message : error)).finally(() => { running = null; });
  return running;
}

async function handleLocationWatchdog(locations: LocationObject[]) {
  const session = await readSession();
  if (!session || locations.length === 0) return;
  if (session.confirmedExit) { await verifyExit(); return; }
  const hasOutside = locations.some((location) => toExitSample(session.zone, location));
  const hasInside = locations.some((location) => {
    const age = Date.now() - location.timestamp;
    if (!Number.isFinite(age) || age < 0 || age > AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS || location.mocked || Boolean((location.coords as { mocked?: boolean }).mocked)) return false;
    const decision = evaluateAutoCheckoutExit(
      session.zone,
      location.coords.latitude,
      location.coords.longitude,
      location.coords.accuracy ?? null
    );
    return decision.usable && decision.distanceMeters + (decision.accuracyMeters || 0) <= decision.effectiveRadiusMeters;
  });
  if (hasInside && !hasOutside) {
    if (session.pendingExit) await clearPendingExit();
    return;
  }
  if (!hasOutside) return;
  await markPendingExit(locations);
  await verifyExit();
}

try {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => serializeTask(async () => {
    if (error || !data) return;
    const event = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
    const session = await readSession();
    if (!session || !event.region.identifier?.startsWith(`${session.active.id}:`)) return;
    if (event.eventType === Location.GeofencingEventType.Exit) {
      await markPendingExit();
      await verifyExit();
    } else if (event.eventType === Location.GeofencingEventType.Enter) {
      // Entering an expanded exit ring does not prove return inside the office.
      // A fresh GPS sample, not this coarse event, clears unconfirmed evidence.
      await verifyExit();
    }
  }).catch(() => undefined));
  TaskManager.defineTask(LOCATION_WATCHDOG_TASK, async ({ data, error }) => serializeTask(async () => {
    if (error || !data) return;
    const payload = data as { locations?: LocationObject[] };
    await handleLocationWatchdog(Array.isArray(payload.locations) ? payload.locations : []);
  }).catch(() => undefined));
} catch (error) {
  if (__DEV__) {
    console.warn("Attendance background task unavailable", error instanceof Error ? error.message : error);
  }
}

export async function reconcileAttendanceGeofence() {
  if (!await available() || !await getApiToken()) return;
  await retryPendingAttendanceExit();
  const { active } = await getAttendanceStatus();
  if (!active) { await stopAttendanceGeofence(); return; }
  await startAttendanceGeofence(active, await getUserGeofences(active.userId));
  await retryPendingAttendanceExit();
}
