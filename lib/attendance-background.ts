import * as TaskManager from "expo-task-manager";
import * as Location from "expo-location";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getApiToken, getCurrentUser, getOrCreateDeviceId, setCheckedIn, addAttendance } from "./storage";
import { attendanceCheckOut, getAttendanceStatus, getUserGeofences } from "./attendance-api";
import { getVerifiedLocationEvidence } from "./location-service";
import { getEffectiveGeofenceRadiusMeters, isConfidentlyOutside } from "./geofence";
import type { AttendanceRecord, Geofence } from "./types";

const TASK = "BACKGROUND_ATTENDANCE_GEOFENCE_TASK";
const KEY = "@attendance_background_session_v2";
type Session = { active: AttendanceRecord; zone: Geofence; pendingExit?: boolean };
let running: Promise<void> | null = null;

async function available() {
  return Platform.OS !== "web" && Constants.appOwnership !== "expo" && await TaskManager.isAvailableAsync();
}

export async function stopAttendanceGeofence() {
  await AsyncStorage.removeItem(KEY);
  if (await available() && await Location.hasStartedGeofencingAsync(TASK)) await Location.stopGeofencingAsync(TASK);
}

export async function startAttendanceGeofence(active: AttendanceRecord, zones: Geofence[], requestPermission = false): Promise<boolean> {
  if (!await available()) return false;
  let permission = await Location.getBackgroundPermissionsAsync();
  if (!permission.granted && requestPermission) permission = await Location.requestBackgroundPermissionsAsync();
  if (!permission.granted) return false;
  const zone = zones.find(item => item.id === active.geofenceId && item.isActive);
  if (!zone) return false;
  const previous = await AsyncStorage.getItem(KEY);
  const session: Session | null = previous ? JSON.parse(previous) : null;
  if (session?.active.id === active.id && session.zone.updatedAt === zone.updatedAt && await Location.hasStartedGeofencingAsync(TASK)) return true;
  await AsyncStorage.setItem(KEY, JSON.stringify({ active, zone }));
  // Two exit rings provide another OS event if the first GPS verification is inconclusive.
  // Only the checked-in office is monitored, rather than every company office.
  await Location.startGeofencingAsync(TASK, [80, 160].map(margin => ({
    identifier: `${active.id}:${margin}`, latitude: zone.latitude, longitude: zone.longitude,
    radius: getEffectiveGeofenceRadiusMeters(zone) + margin, notifyOnEnter: true, notifyOnExit: true,
  })));
  return true;
}

async function verifyExit() {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return;
  const session: Session = JSON.parse(raw);
  if (!session.pendingExit) return;
  const [user, token, deviceId] = await Promise.all([getCurrentUser(), getApiToken(), getOrCreateDeviceId()]);
  if (!token || !user || user.id !== session.active.userId || deviceId !== session.active.deviceId) return;
  const evidence = await getVerifiedLocationEvidence({ minAccuracyMeters: 50, requiredStableSamples: 2, maxAttempts: 5, maxDriftMeters: 50, timeoutMs: 18000 });
  const fix = evidence.location;
  if (!isConfidentlyOutside(session.zone, fix.coords.latitude, fix.coords.longitude, fix.coords.accuracy!)) return;
  const record = await attendanceCheckOut({
    requestId: `exit_${session.active.id}`, actionSource: "geofence_exit", activeAttendanceId: session.active.id,
    userId: user.id, userName: user.name, deviceId, photoType: "checkout",
    latitude: fix.coords.latitude, longitude: fix.coords.longitude, locationAccuracyMeters: fix.coords.accuracy,
    capturedAtClient: new Date(fix.timestamp).toISOString(), locationSampleCount: evidence.sampleCount,
    locationSampleWindowMs: evidence.sampleWindowMs, mockLocationDetected: false,
    biometricRequired: false, biometricVerified: false, isInsideGeofence: false,
    notes: "Automatic checkout: verified office exit",
  });
  await addAttendance(record);
  await setCheckedIn(false);
  await stopAttendanceGeofence();
}

export async function retryPendingAttendanceExit() {
  if (running) return running;
  running = verifyExit().catch(error => console.warn("Office exit is not yet confirmed", error instanceof Error ? error.message : error)).finally(() => { running = null; });
  return running;
}

TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data) return;
  const event = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return;
  const session: Session = JSON.parse(raw);
  if (!event.region.identifier?.startsWith(`${session.active.id}:`)) return;
  // A later entry does not erase a pending exit: verification decides using fresh GPS.
  if (event.eventType === Location.GeofencingEventType.Exit) {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...session, pendingExit: true }));
    await retryPendingAttendanceExit();
  }
});

export async function reconcileAttendanceGeofence() {
  if (!await available() || !await getApiToken()) return;
  const { active } = await getAttendanceStatus();
  if (!active) { await stopAttendanceGeofence(); return; }
  await startAttendanceGeofence(active, await getUserGeofences(active.userId));
  await retryPendingAttendanceExit();
}
