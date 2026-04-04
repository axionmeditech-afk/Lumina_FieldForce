import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { AppCanvas } from "@/components/AppCanvas";
import { RouteMapNative, type PlannedStopPoint } from "@/components/RouteMapNative";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import {
  getAdminLiveMapPoints,
  getAdminLiveMapRoutes,
  getAdminRouteTimeline,
  getRemoteState,
  type LiveMapPoint,
  type AdminRouteTimelineResponse,
} from "@/lib/attendance-api";
import { getBatteryLevelPercent } from "@/lib/battery";
import { flushBackgroundLocationQueue, queueLocationPoint } from "@/lib/background-location";
import {
  formatMumbaiDateKey,
  formatMumbaiDateTime,
  formatMumbaiTime,
  getMumbaiDateKeyByOffset,
  isMumbaiDateKey,
  MUMBAI_TIMEZONE_LABEL,
  toMumbaiDateKey,
} from "@/lib/ist-time";
import {
  ensureLocationServicesEnabled,
  getLocationPermissionSnapshot,
  getVerifiedLocationEvidence,
} from "@/lib/location-service";
import { buildRouteTimeline } from "@/lib/route-analytics";
import { addLocationLog, getAttendance, getLocationLogs, getTasks } from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
import type { AttendanceRecord, Employee, LocationLog, Task } from "@/lib/types";

function toShortDate(dateKey: string): string {
  return formatMumbaiDateKey(dateKey);
}

function toTime(value: string): string {
  return formatMumbaiTime(value);
}

function toBatteryLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value <= 1 ? value * 100 : value;
  const rounded = Math.round(Math.max(0, Math.min(100, normalized)));
  return `${rounded}%`;
}

function toLocationKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}_${longitude.toFixed(4)}`;
}

function formatReverseGeocodeName(
  address: Location.LocationGeocodedAddress | undefined
): string | null {
  if (!address) return null;
  const compact = (value: string | null | undefined) => (value || "").trim();
  const unique = new Set<string>();
  const labels = [
    compact(address.name),
    compact(address.street),
    compact(address.district),
    compact(address.city),
    compact(address.subregion),
    compact(address.region),
  ].filter((value) => {
    if (!value) return false;
    const normalized = value.toLowerCase();
    if (unique.has(normalized)) return false;
    unique.add(normalized);
    return true;
  });
  if (!labels.length) return null;
  return labels.slice(0, 3).join(", ");
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function resolveCarryoverAttendanceRecord(
  records: AttendanceRecord[],
  selectedDate: string
): AttendanceRecord | null {
  const ordered = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let activeCheckIn: AttendanceRecord | null = null;

  for (const entry of ordered) {
    const entryDateKey = toMumbaiDateKey(new Date(entry.timestamp));
    if (entryDateKey >= selectedDate) {
      break;
    }

    if (entry.type === "checkin") {
      activeCheckIn = entry;
      continue;
    }

    if (entry.type === "checkout" && activeCheckIn) {
      activeCheckIn = null;
    }
  }

  return activeCheckIn;
}

function addTrackedUserIdAliases(bucket: Set<string>, value: string | null | undefined): void {
  const normalized = (value || "").trim();
  if (!normalized) return;
  bucket.add(normalized);
  if (/^\d+$/.test(normalized)) {
    bucket.add(`dolibarr_${normalized}`);
  }
  const dolibarrMatch = normalized.match(/^dolibarr_(.+)$/i);
  const rawDolibarrId = dolibarrMatch?.[1]?.trim() || "";
  if (rawDolibarrId) {
    bucket.add(rawDolibarrId);
  }
}

function dedupeById<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const entry of entries) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function filterCompanyScoped<T extends { companyId?: string | null }>(
  entries: T[],
  companyId: string | null | undefined
): T[] {
  if (!companyId) return entries;
  return entries.filter((entry) => !entry.companyId || entry.companyId === companyId);
}

function buildUserIdCandidates(...values: (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    addTrackedUserIdAliases(ids, value);
  }
  return Array.from(ids);
}

function buildSelectedUserAliases(
  selectedEmployee: Employee | null,
  currentUser: { id: string; name: string; email: string } | null,
  attendance: AttendanceRecord[],
  selectedUserId: string
): Set<string> {
  const aliases = new Set<string>();
  const selectedIdAliases = new Set<string>();
  addTrackedUserIdAliases(selectedIdAliases, selectedUserId);
  addTrackedUserIdAliases(selectedIdAliases, selectedEmployee?.id);
  for (const alias of selectedIdAliases) {
    aliases.add(alias);
  }
  const employeeName = normalizeIdentity(selectedEmployee?.name);
  const employeeEmail = normalizeIdentity(selectedEmployee?.email);

  for (const entry of attendance) {
    if (!entry?.userId) continue;
    if (selectedIdAliases.has(entry.userId)) {
      addTrackedUserIdAliases(aliases, entry.userId);
      continue;
    }
    if (employeeName && normalizeIdentity(entry.userName) === employeeName) {
      addTrackedUserIdAliases(aliases, entry.userId);
    }
  }

  if (currentUser) {
    const userMatchesEmployee =
      (employeeEmail && normalizeIdentity(currentUser.email) === employeeEmail) ||
      (employeeName && normalizeIdentity(currentUser.name) === employeeName) ||
      selectedIdAliases.has(currentUser.id);
    if (userMatchesEmployee) {
      addTrackedUserIdAliases(aliases, currentUser.id);
    }
  }

  return aliases;
}

const ROUTE_POINT_INTERVAL_MINUTES = 1;

interface RouteSessionWindow {
  startAt: string | null;
  endAt: string | null;
}

function toMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function resolveRouteSessionWindow(attendanceEvents: AttendanceRecord[]): RouteSessionWindow {
  const ordered = [...attendanceEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let activeStartAt: string | null = null;
  let lastCompletedWindow: RouteSessionWindow = { startAt: null, endAt: null };

  for (const entry of ordered) {
    if (entry.type === "checkin") {
      activeStartAt = entry.timestamp;
      continue;
    }
    if (entry.type === "checkout" && activeStartAt) {
      lastCompletedWindow = {
        startAt: activeStartAt,
        endAt: entry.timestamp,
      };
      activeStartAt = null;
    }
  }

  if (activeStartAt) {
    return { startAt: activeStartAt, endAt: null };
  }
  return lastCompletedWindow;
}

function filterPointsToSessionWindow(
  points: LocationLog[],
  sessionWindow: RouteSessionWindow
): LocationLog[] {
  if (!sessionWindow.startAt && !sessionWindow.endAt) return points;
  return points.filter((point) => {
    if (sessionWindow.startAt && point.capturedAt < sessionWindow.startAt) return false;
    if (sessionWindow.endAt && point.capturedAt > sessionWindow.endAt) return false;
    return true;
  });
}

function downsamplePointsByInterval(points: LocationLog[], intervalMinutes: number): LocationLog[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const sampled: LocationLog[] = [];
  let lastIncludedMs = Number.NaN;

  for (const point of sorted) {
    const pointMs = toMs(point.capturedAt);
    if (!Number.isFinite(pointMs)) continue;
    if (!sampled.length) {
      sampled.push(point);
      lastIncludedMs = pointMs;
      continue;
    }
    if (pointMs - lastIncludedMs >= intervalMs) {
      sampled.push(point);
      lastIncludedMs = pointMs;
    }
  }
  return sampled;
}

function normalizePointsForInterval(points: LocationLog[], intervalMinutes: number): LocationLog[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const deduped: LocationLog[] = [];
  const seen = new Set<string>();

  for (const point of sorted) {
    const ms = toMs(point.capturedAt);
    if (!Number.isFinite(ms)) continue;
    const key = `${Math.round(ms / 1000)}_${point.latitude.toFixed(6)}_${point.longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }

  return downsamplePointsByInterval(deduped, intervalMinutes);
}

function normalizeTimelineForInterval(
  timeline: AdminRouteTimelineResponse,
  intervalMinutes: number
): AdminRouteTimelineResponse {
  const normalizedPoints = normalizePointsForInterval(timeline.points || [], intervalMinutes);
  const rebuilt = buildRouteTimeline(timeline.userId, timeline.date, normalizedPoints);
  return {
    ...timeline,
    ...rebuilt,
    attendanceEvents: timeline.attendanceEvents || [],
  };
}

type RouteAttendanceStatusEvent = AdminRouteTimelineResponse["attendanceEvents"][number];

function mergeRouteAttendanceEvents(
  ...lists: RouteAttendanceStatusEvent[][]
): RouteAttendanceStatusEvent[] {
  const merged = new Map<string, RouteAttendanceStatusEvent>();
  for (const list of lists) {
    for (const event of list) {
      if (!event) continue;
      const key = event.id || `${event.type}_${event.at}_${event.latitude ?? ""}_${event.longitude ?? ""}`;
      if (!merged.has(key)) {
        merged.set(key, event);
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.at.localeCompare(b.at));
}

function getLatestRouteAttendanceEvent(
  events: RouteAttendanceStatusEvent[]
): RouteAttendanceStatusEvent | null {
  return events.length ? [...events].sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null : null;
}

function getTimelineLatestActivityAt(timeline: AdminRouteTimelineResponse | null | undefined): string {
  if (!timeline) return "";
  const latestPointAt = [...(timeline.points || [])]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .at(-1)?.capturedAt;
  const latestAttendanceAt = [...(timeline.attendanceEvents || [])]
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1)?.at;
  return [latestPointAt, latestAttendanceAt]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b))
    .at(-1) || "";
}

function mapLivePointToLocationLog(point: LiveMapPoint): LocationLog {
  return {
    id: point.id,
    userId: point.userId,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: null,
    speed: null,
    heading: null,
    batteryLevel: point.batteryLevel ?? null,
    geofenceId: null,
    geofenceName: point.geofenceName ?? null,
    isInsideGeofence: point.isInsideGeofence,
    capturedAt: point.capturedAt,
  };
}

function getVisitStatus(task: Task): "pending" | "in_progress" | "completed" {
  if (task.departureAt || task.status === "completed") return "completed";
  if (task.arrivalAt || task.status === "in_progress") return "in_progress";
  return "pending";
}

function getVisitLabel(task: Task): string {
  return task.visitLocationLabel?.trim() || task.title.trim() || "Field Visit";
}

type TimelineRow =
  | {
      id: string;
      type: "attendance";
      at: string;
      text: string;
      icon: keyof typeof Ionicons.glyphMap;
      iconColor: string;
    }
  | {
      id: string;
      type: "moving" | "halt";
      startAt: string;
      endAt: string;
      text: string;
      icon: keyof typeof Ionicons.glyphMap;
      iconColor: string;
    };

export default function RouteTrackingScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [dayOffset, setDayOffset] = useState(0);
  const [mapMode, setMapMode] = useState<"tracking" | "polyline">("tracking");
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<AdminRouteTimelineResponse | null>(null);
  const [plannedStops, setPlannedStops] = useState<PlannedStopPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [placeNameByLocationKey, setPlaceNameByLocationKey] = useState<Record<string, string>>({});
  const [mumbaiNowLabel, setMumbaiNowLabel] = useState(() =>
    formatMumbaiDateTime(new Date(), { withSeconds: true })
  );
  const resolvingLocationKeysRef = useRef(new Set<string>());
  const LIVE_REFRESH_INTERVAL_MS = 15 * 1000;
  const isExpoGo = Constants.appOwnership === "expo";
  const configuredMapProvider = (process.env.EXPO_PUBLIC_MAP_PROVIDER || "osm")
    .trim()
    .toLowerCase();
  const mapProvider =
    configuredMapProvider === "mappls" && isExpoGo ? "osm" : configuredMapProvider;

  const isPrivilegedViewer =
    user?.role === "admin" || user?.role === "manager" || user?.role === "hr";
  const canViewTracking = isPrivilegedViewer;
  const selectedDate = useMemo(() => getMumbaiDateKeyByOffset(dayOffset), [dayOffset, mumbaiNowLabel]);
  const visibleEmployees = useMemo(() => {
    if (!user) return [];
    if (isPrivilegedViewer) {
      return employees.filter((entry) => entry.role === "salesperson");
    }

    const selfById = employees.find((entry) => entry.id === user.id);
    if (selfById) return [selfById];

    const selfByEmail = employees.find(
      (entry) => normalizeIdentity(entry.email) === normalizeIdentity(user.email)
    );
    if (selfByEmail) return [selfByEmail];

    const fallbackEmployee: Employee = {
      id: user.id,
      companyId: user.companyId,
      name: user.name,
      role: user.role,
      department: user.department,
      status: "active",
      email: user.email,
      phone: user.phone,
      branch: user.branch,
      joinDate: user.joinDate,
    };
    return [fallbackEmployee];
  }, [employees, isPrivilegedViewer, user]);
  const selectedEmployee = useMemo(
    () => visibleEmployees.find((entry) => entry.id === selectedUserId) ?? null,
    [selectedUserId, visibleEmployees]
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const employeeData = await getEmployees();
      if (!mounted) return;
      const dedup = new Map<string, Employee>();
      for (const item of employeeData) dedup.set(item.id, item);
      const merged = Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(merged);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!visibleEmployees.length) {
      setSelectedUserId("");
      return;
    }
    setSelectedUserId((current) =>
      visibleEmployees.some((entry) => entry.id === current) ? current : visibleEmployees[0].id
    );
  }, [visibleEmployees]);

  useEffect(() => {
    if (mapProvider !== "mappls") {
      setMapMode("polyline");
    }
  }, [mapProvider]);

  useEffect(() => {
    const timer = setInterval(() => {
      setMumbaiNowLabel(formatMumbaiDateTime(new Date(), { withSeconds: true }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const persistCurrentLocationPointIfMoved = useCallback(
    async (
      existingDayPoints: LocationLog[],
      aliases: Set<string>,
      isTrackingActive: boolean
    ): Promise<boolean> => {
      if (!user || !selectedEmployee) return false;
      const todayKey = toMumbaiDateKey(new Date());
      if (selectedDate !== todayKey) return false;
      if (!isTrackingActive) return false;
      const canUseDeviceLocation = selectedUserId === user.id || aliases.has(user.id);
      if (!canUseDeviceLocation) return false;

      const permission = await getLocationPermissionSnapshot();
      let hasForegroundPermission = permission.foreground;
      if (!hasForegroundPermission && permission.foregroundCanAskAgain) {
        const request = await Location.requestForegroundPermissionsAsync();
        hasForegroundPermission = request.granted;
      }
      if (!hasForegroundPermission) return false;
      const gpsEnabled = await ensureLocationServicesEnabled();
      if (!gpsEnabled) return false;

      let coords:
        | {
            latitude: number;
            longitude: number;
            accuracy: number | null;
            speed: number | null;
            heading: number | null;
          }
        | null = null;
      try {
        const evidence = await getVerifiedLocationEvidence({
          minAccuracyMeters: 260,
          maxAttempts: 2,
          requiredStableSamples: 1,
          sampleWaitMs: 500,
          maxDriftMeters: 220,
        });
        coords = {
          latitude: evidence.location.coords.latitude,
          longitude: evidence.location.coords.longitude,
          accuracy: evidence.location.coords.accuracy ?? null,
          speed: evidence.location.coords.speed ?? null,
          heading: evidence.location.coords.heading ?? null,
        };
      } catch {
        try {
          const current = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            mayShowUserSettingsDialog: true,
          });
          coords = {
            latitude: current.coords.latitude,
            longitude: current.coords.longitude,
            accuracy: current.coords.accuracy ?? null,
            speed: current.coords.speed ?? null,
            heading: current.coords.heading ?? null,
          };
        } catch {
          const lastKnown = await Location.getLastKnownPositionAsync({
            maxAge: 20 * 60 * 1000,
            requiredAccuracy: 1000,
          });
          if (!lastKnown) return false;
          coords = {
            latitude: lastKnown.coords.latitude,
            longitude: lastKnown.coords.longitude,
            accuracy: lastKnown.coords.accuracy ?? null,
            speed: lastKnown.coords.speed ?? null,
            heading: lastKnown.coords.heading ?? null,
          };
        }
      }

      if (!coords) return false;
      const lastPoint = existingDayPoints[existingDayPoints.length - 1];
      if (lastPoint) {
        const nowMs = Date.now();
        const lastPointMs = toMs(lastPoint.capturedAt);
        const elapsedMs =
          Number.isFinite(lastPointMs) && lastPointMs > 0 ? Math.max(0, nowMs - lastPointMs) : Number.POSITIVE_INFINITY;
        if (elapsedMs < ROUTE_POINT_INTERVAL_MINUTES * 60_000) {
          return false;
        }
      }

      const capturedAt = new Date().toISOString();
      const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
      const userIdForLog = user.id;

      await addLocationLog({
        id: `route_point_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: userIdForLog,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        speed: coords.speed,
        heading: coords.heading,
        batteryLevel,
        geofenceId: null,
        geofenceName: selectedEmployee.branch || null,
        isInsideGeofence: true,
        capturedAt,
      });

      await queueLocationPoint({
        userId: userIdForLog,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        speed: coords.speed,
        heading: coords.heading,
        batteryLevel,
        capturedAt,
      });
      void flushBackgroundLocationQueue({ force: true }).catch(() => {
        // offline/API failure: queued point will be retried later.
      });

      return true;
    },
    [selectedDate, selectedEmployee, selectedUserId, user]
  );

  const loadTimeline = useCallback(async () => {
    if (!selectedUserId || !canViewTracking || authExpired) {
      if (!selectedUserId) {
        setPlannedStops([]);
      }
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const taskSnapshot = await getTasks();
      const selectedEmployeeName = normalizeIdentity(selectedEmployee?.name);
      const currentUserName = normalizeIdentity(user?.name);
      const plannedStopsForDay: PlannedStopPoint[] = taskSnapshot
        .filter((task) => task.taskType === "field_visit")
        .filter(
          (task) =>
            typeof task.visitLatitude === "number" && typeof task.visitLongitude === "number"
        )
        .filter((task) => (task.visitPlanDate || task.dueDate) === selectedDate)
        .filter((task) => {
          const assignedToName = normalizeIdentity(task.assignedToName);
          if (isPrivilegedViewer) {
            return (
              task.assignedTo === selectedUserId ||
              (selectedEmployeeName && assignedToName === selectedEmployeeName)
            );
          }
          return (
            task.assignedTo === selectedUserId ||
            (user?.id ? task.assignedTo === user.id : false) ||
            (selectedEmployee?.id ? task.assignedTo === selectedEmployee.id : false) ||
            (selectedEmployeeName && assignedToName === selectedEmployeeName) ||
            (currentUserName && assignedToName === currentUserName)
          );
        })
        .sort((a, b) => {
          const seqA = typeof a.visitSequence === "number" ? a.visitSequence : Number.POSITIVE_INFINITY;
          const seqB = typeof b.visitSequence === "number" ? b.visitSequence : Number.POSITIVE_INFINITY;
          if (seqA !== seqB) return seqA - seqB;
          return a.createdAt.localeCompare(b.createdAt);
        })
        .map((task) => ({
          id: task.id,
          label:
            typeof task.visitSequence === "number"
              ? `#${task.visitSequence} ${getVisitLabel(task)}`
              : getVisitLabel(task),
          latitude: task.visitLatitude as number,
          longitude: task.visitLongitude as number,
          status: getVisitStatus(task),
        }));
      setPlannedStops(plannedStopsForDay);

      const [
        logsSnapshot,
        attendanceSnapshot,
        remoteLogsState,
        remoteAttendanceState,
      ] = await Promise.all([
        getLocationLogs(),
        getAttendance(),
        isPrivilegedViewer
          ? getRemoteState<LocationLog[]>("@trackforce_location_logs").catch(() => ({ value: null }))
          : Promise.resolve({ value: null }),
        isPrivilegedViewer
          ? getRemoteState<AttendanceRecord[]>("@trackforce_attendance").catch(() => ({ value: null }))
          : Promise.resolve({ value: null }),
      ]);
      const remoteLogs = Array.isArray(remoteLogsState.value)
        ? filterCompanyScoped(remoteLogsState.value, user?.companyId)
        : [];
      const remoteAttendance = Array.isArray(remoteAttendanceState.value)
        ? filterCompanyScoped(remoteAttendanceState.value, user?.companyId)
        : [];
      const mergedLogsSnapshot = dedupeById([...remoteLogs, ...logsSnapshot]);
      const mergedAttendanceSnapshot = dedupeById([...remoteAttendance, ...attendanceSnapshot]);
      const aliases = buildSelectedUserAliases(
        selectedEmployee,
        user ? { id: user.id, name: user.name, email: user.email } : null,
        mergedAttendanceSnapshot,
        selectedUserId
      );
      const selectedEmployeeNameForAttendance = normalizeIdentity(selectedEmployee?.name);
      const selectedUserAttendanceAll = mergedAttendanceSnapshot
        .filter(
          (entry) =>
            aliases.has(entry.userId) ||
            (selectedEmployeeNameForAttendance &&
              normalizeIdentity(entry.userName) === selectedEmployeeNameForAttendance)
        )
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const carryoverAttendance = resolveCarryoverAttendanceRecord(
        selectedUserAttendanceAll,
        selectedDate
      );
      const selectedUserAttendance = dedupeById(
        [
          ...(carryoverAttendance ? [carryoverAttendance] : []),
          ...selectedUserAttendanceAll.filter((entry) => isMumbaiDateKey(entry.timestamp, selectedDate)),
        ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      );
      const sessionWindow = resolveRouteSessionWindow(selectedUserAttendance);
      const latestLocalSelectedAttendance =
        selectedUserAttendance.length > 0
          ? selectedUserAttendance[selectedUserAttendance.length - 1]
          : null;
      const isLocallyTrackingActive = latestLocalSelectedAttendance?.type === "checkin";

      let allLocalLogsForAliases = mergedLogsSnapshot
        .filter((log) => aliases.has(log.userId))
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      let dayLocalPointsRaw = allLocalLogsForAliases.filter((log) =>
        isMumbaiDateKey(log.capturedAt, selectedDate)
      );
      let dayLocalPoints = normalizePointsForInterval(
        filterPointsToSessionWindow(dayLocalPointsRaw, sessionWindow),
        ROUTE_POINT_INTERVAL_MINUTES
      );

      const createdCurrentPoint = await persistCurrentLocationPointIfMoved(
        dayLocalPoints,
        aliases,
        isLocallyTrackingActive
      );
      if (createdCurrentPoint) {
        const refreshedLogs = await getLocationLogs();
        allLocalLogsForAliases = refreshedLogs
          .filter((log) => aliases.has(log.userId))
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
        dayLocalPointsRaw = allLocalLogsForAliases.filter((log) =>
          isMumbaiDateKey(log.capturedAt, selectedDate)
        );
        dayLocalPoints = normalizePointsForInterval(
          filterPointsToSessionWindow(dayLocalPointsRaw, sessionWindow),
          ROUTE_POINT_INTERVAL_MINUTES
        );
      }

      if (
        !dayLocalPoints.length &&
        selectedDate === toMumbaiDateKey(new Date()) &&
        allLocalLogsForAliases.length &&
        isLocallyTrackingActive
      ) {
        // Show at least latest known user location on today's map even before movement timeline forms.
        dayLocalPoints = [allLocalLogsForAliases[allLocalLogsForAliases.length - 1]];
      }

      const localTimeline = buildRouteTimeline(selectedUserId, selectedDate, dayLocalPoints);
      const localAttendanceEvents = selectedUserAttendance
        .map((entry) => ({
          id: entry.id,
          type: entry.type,
          at: entry.timestamp,
          geofenceName: entry.geofenceName ?? null,
          latitude: entry.location?.lat ?? null,
          longitude: entry.location?.lng ?? null,
        }))
        .sort((a, b) => a.at.localeCompare(b.at));

      const localResolvedTimeline: AdminRouteTimelineResponse = {
        ...localTimeline,
        attendanceEvents: localAttendanceEvents,
      };

      const remoteCandidates = buildUserIdCandidates(
        selectedUserId,
        selectedEmployee?.id,
        ...Array.from(aliases)
      );
      let remoteTimeline: AdminRouteTimelineResponse | null = null;
      let remoteFailure: unknown = null;
      for (const candidateUserId of remoteCandidates) {
        try {
          const currentRemote = await getAdminRouteTimeline(
            candidateUserId,
            selectedDate,
            ROUTE_POINT_INTERVAL_MINUTES
          );
          const currentLatestActivity = getTimelineLatestActivityAt(currentRemote);
          const resolvedLatestActivity = getTimelineLatestActivityAt(remoteTimeline);
          const currentPointCount = currentRemote.points?.length ?? 0;
          const resolvedPointCount = remoteTimeline?.points?.length ?? 0;
          if (
            !remoteTimeline ||
            currentLatestActivity.localeCompare(resolvedLatestActivity) > 0 ||
            (currentLatestActivity === resolvedLatestActivity && currentPointCount > resolvedPointCount)
          ) {
            remoteTimeline = currentRemote;
          }
        } catch (candidateError) {
          remoteFailure = candidateError;
        }
      }

      const mergedAttendanceEvents = mergeRouteAttendanceEvents(
        localAttendanceEvents,
        remoteTimeline?.attendanceEvents || []
      );
      const latestEffectiveAttendance = getLatestRouteAttendanceEvent(mergedAttendanceEvents);
      const isTrackingActive = latestEffectiveAttendance?.type === "checkin";

      if (!isTrackingActive) {
        setTimeline({
          ...buildRouteTimeline(selectedUserId, selectedDate, []),
          attendanceEvents: mergedAttendanceEvents,
        });
        setError(null);
        return;
      }

      if (remoteTimeline && (remoteTimeline.points?.length ?? 0) > 0) {
        setTimeline(
          normalizeTimelineForInterval(
            {
              ...remoteTimeline,
              attendanceEvents: mergedAttendanceEvents,
            },
            ROUTE_POINT_INTERVAL_MINUTES
          )
        );
        return;
      }

      const hasLocalData =
        (localResolvedTimeline.points?.length ?? 0) > 0 ||
        mergedAttendanceEvents.length > 0;

      if (hasLocalData) {
        setTimeline(
          normalizeTimelineForInterval(
            {
              ...localResolvedTimeline,
              attendanceEvents: mergedAttendanceEvents,
            },
            ROUTE_POINT_INTERVAL_MINUTES
          )
        );
        setError("Showing current/local route points while live API catches up.");
        return;
      }

      if (isPrivilegedViewer) {
        const fallbackAttendanceEvents = mergedAttendanceEvents;

        // Fallback for alias mismatch or delayed route timeline API hydration:
        // resolve selected salesperson route from all admin routes for selected date.
        try {
          const liveRoutes = await getAdminLiveMapRoutes(selectedDate, ROUTE_POINT_INTERVAL_MINUTES);
          const matchingRoute = (liveRoutes.routes || [])
            .filter((route) => aliases.has(route.userId) && (route.points?.length ?? 0) > 0)
            .sort((a, b) => {
              const aTime = a.latestPoint?.capturedAt || "";
              const bTime = b.latestPoint?.capturedAt || "";
              return bTime.localeCompare(aTime);
            })[0];
          if (matchingRoute && matchingRoute.points.length > 0) {
            const normalizedRoutePoints = normalizePointsForInterval(
              matchingRoute.points,
              ROUTE_POINT_INTERVAL_MINUTES
            );
            const fallbackTimeline = buildRouteTimeline(
              selectedUserId,
              selectedDate,
              normalizedRoutePoints
            );
            setTimeline({
              ...fallbackTimeline,
              attendanceEvents: fallbackAttendanceEvents,
            });
            setError("Showing synced route points from admin live map feed.");
            return;
          }
        } catch {
          // best-effort fallback, continue to latest point fallback below
        }

        if (selectedDate === toMumbaiDateKey(new Date())) {
          try {
            const livePoints = await getAdminLiveMapPoints();
            const latestPoint = livePoints
              .filter((point) => aliases.has(point.userId))
              .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
            if (latestPoint) {
              const mappedPoint = mapLivePointToLocationLog(latestPoint);
              const fallbackTimeline = buildRouteTimeline(
                selectedUserId,
                selectedDate,
                normalizePointsForInterval([mappedPoint], ROUTE_POINT_INTERVAL_MINUTES)
              );
              setTimeline({
                ...fallbackTimeline,
                attendanceEvents: fallbackAttendanceEvents,
              });
              setError("Showing latest current GPS point while route history syncs.");
              return;
            }
          } catch {
            // continue with remote timeline fallback/error handling
          }
        }
      }

      if (remoteTimeline) {
        setTimeline(
          normalizeTimelineForInterval(
            {
              ...remoteTimeline,
              attendanceEvents: mergedAttendanceEvents,
            },
            ROUTE_POINT_INTERVAL_MINUTES
          )
        );
        return;
      }

      throw remoteFailure instanceof Error ? remoteFailure : new Error("Unable to load route timeline.");
    } catch (routeError) {
      const message =
        routeError instanceof Error ? routeError.message : "Unable to load route timeline.";
      if (/session expired|invalid or expired token|missing authorization bearer token/i.test(message)) {
        setAuthExpired(true);
        setError("Session expired. Please log out and sign in again.");
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [
    authExpired,
    canViewTracking,
    persistCurrentLocationPointIfMoved,
    isPrivilegedViewer,
    selectedDate,
    selectedEmployee,
    selectedUserId,
    user,
  ]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  useEffect(() => {
    if (!selectedUserId || !canViewTracking || authExpired) return undefined;
    const timer = setInterval(() => {
      void loadTimeline();
    }, LIVE_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authExpired, canViewTracking, loadTimeline, selectedUserId, LIVE_REFRESH_INTERVAL_MS]);

  useEffect(() => {
    if (mapMode === "tracking" && (timeline?.points?.length ?? 0) < 2) {
      setMapMode("polyline");
    }
  }, [mapMode, timeline?.points?.length]);

  const rows = useMemo<TimelineRow[]>(() => {
    if (!timeline) return [];
    const halts = timeline.halts ?? [];
    const segments = timeline.segments ?? [];
    const attendanceEvents = timeline.attendanceEvents ?? [];
    const haltById = new Map(halts.map((halt) => [halt.id, halt]));
    const attendanceRows: TimelineRow[] = attendanceEvents.map((event) => ({
      id: `att_${event.id}`,
      type: "attendance",
      at: event.at,
      icon: event.type === "checkin" ? "log-in-outline" : "log-out-outline",
      iconColor: event.type === "checkin" ? colors.success : colors.danger,
      text: `${event.type === "checkin" ? "Checked In" : "Checked Out"} at ${event.geofenceName || "Unknown Zone"}`,
    }));

    const segmentRows: TimelineRow[] = segments.map((segment) => {
      if (segment.type === "halt") {
        const halt = segment.haltId ? haltById.get(segment.haltId) : undefined;
        const startBattery = toBatteryLabel(halt?.startBatteryLevel);
        const endBattery = toBatteryLabel(halt?.endBatteryLevel);
        const averageBattery = toBatteryLabel(halt?.averageBatteryLevel);
        const batteryText =
          startBattery && endBattery
            ? ` | Battery ${startBattery} -> ${endBattery}`
            : averageBattery
              ? ` | Battery ${averageBattery}`
              : "";
        return {
          id: `seg_${segment.id}`,
          type: "halt",
          startAt: segment.startAt,
          endAt: segment.endAt,
          icon: "pause-circle-outline",
          iconColor: colors.warning,
          text: `Halt at ${segment.fromLabel} (${segment.durationMinutes} mins)${batteryText}`,
        };
      }
      const km = (segment.distanceMeters / 1000).toFixed(2);
      return {
        id: `seg_${segment.id}`,
        type: "moving",
        startAt: segment.startAt,
        endAt: segment.endAt,
        icon: "navigate-outline",
        iconColor: colors.primary,
        text: `Moving (${km} km, ${segment.durationMinutes} mins)`,
      };
    });

    const merged = [...attendanceRows, ...segmentRows];
    return merged.sort((a, b) => {
      const aStart = a.type === "attendance" ? a.at : a.startAt;
      const bStart = b.type === "attendance" ? b.at : b.startAt;
      return aStart.localeCompare(bStart);
    });
  }, [colors.danger, colors.primary, colors.success, colors.warning, timeline]);

  const summary = useMemo(() => {
    const raw = timeline?.summary;
    const totalDistanceKm =
      typeof raw?.totalDistanceKm === "number" && Number.isFinite(raw.totalDistanceKm)
        ? raw.totalDistanceKm
        : 0;
    const totalMovingMinutes =
      typeof raw?.totalMovingMinutes === "number" && Number.isFinite(raw.totalMovingMinutes)
        ? raw.totalMovingMinutes
        : 0;
    const totalHaltMinutes =
      typeof raw?.totalHaltMinutes === "number" && Number.isFinite(raw.totalHaltMinutes)
        ? raw.totalHaltMinutes
        : 0;
    const haltCount =
      typeof raw?.haltCount === "number" && Number.isFinite(raw.haltCount)
        ? raw.haltCount
        : 0;
    const pointCount =
      typeof raw?.pointCount === "number" && Number.isFinite(raw.pointCount)
        ? raw.pointCount
        : 0;
    return {
      totalDistanceKm,
      totalMovingMinutes,
      totalHaltMinutes,
      haltCount,
      pointCount,
    };
  }, [timeline?.summary]);

  const routePointRows = useMemo(() => {
    if (!timeline?.points?.length) return [];
    return [...timeline.points]
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .map((point) => ({
        id: point.id,
        at: point.capturedAt,
        geofenceName: point.geofenceName || null,
        latitude: point.latitude,
        longitude: point.longitude,
        locationKey: toLocationKey(point.latitude, point.longitude),
        locationName: placeNameByLocationKey[toLocationKey(point.latitude, point.longitude)] ?? null,
        battery: toBatteryLabel(point.batteryLevel),
      }));
  }, [placeNameByLocationKey, timeline?.points]);

  useEffect(() => {
    if (!routePointRows.length) return;
    let cancelled = false;

    const unresolved = routePointRows.filter(
      (point) =>
        !point.locationName && !resolvingLocationKeysRef.current.has(point.locationKey)
    );
    if (!unresolved.length) return;

    const resolveNames = async () => {
      for (const point of unresolved) {
        if (cancelled) break;
        resolvingLocationKeysRef.current.add(point.locationKey);
        try {
          const geoResults = await Location.reverseGeocodeAsync({
            latitude: point.latitude,
            longitude: point.longitude,
          });
          const resolvedName =
            formatReverseGeocodeName(geoResults[0]) ||
            point.geofenceName ||
            "Location unavailable";
          if (!cancelled) {
            setPlaceNameByLocationKey((current) =>
              current[point.locationKey]
                ? current
                : { ...current, [point.locationKey]: resolvedName }
            );
          }
        } catch {
          const fallbackName = point.geofenceName || "Location unavailable";
          if (!cancelled) {
            setPlaceNameByLocationKey((current) =>
              current[point.locationKey]
                ? current
                : { ...current, [point.locationKey]: fallbackName }
            );
          }
        } finally {
          resolvingLocationKeysRef.current.delete(point.locationKey);
        }
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [routePointRows]);
  const latestRoutePoint = routePointRows.length
    ? routePointRows[routePointRows.length - 1]
    : null;
  const latestAttendanceEvent = useMemo(() => {
    const events = timeline?.attendanceEvents ?? [];
    if (!events.length) return null;
    return [...events].sort((a, b) => a.at.localeCompare(b.at))[events.length - 1];
  }, [timeline?.attendanceEvents]);
  const isTrackingVisible = latestAttendanceEvent?.type === "checkin";
  const isCheckedOutView = latestAttendanceEvent?.type === "checkout";
  const mapStatusTitle = isCheckedOutView ? "Checked Out" : "Not Checked In";
  const mapStatusText = isCheckedOutView
    ? `${selectedEmployee?.name || "This salesperson"} checked out${
        latestAttendanceEvent?.at ? ` at ${toTime(latestAttendanceEvent.at)}` : ""
      }. Map is hidden until next check-in.`
    : `${selectedEmployee?.name || "This salesperson"} is not checked in for this date.`;

  if (!canViewTracking) {
    return (
      <AppCanvas>
        <View style={[styles.deniedWrap, { paddingTop: insets.top + 24 }]}>
          <Ionicons name="shield-outline" size={42} color={colors.textTertiary} />
          <Text style={[styles.deniedTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Access restricted
          </Text>
          <Text style={[styles.deniedText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            Route tracking dashboard is available for Admin, Manager, and HR roles.
          </Text>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.primary }]}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </Pressable>
        </View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 14 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <View style={styles.headerCenter}>
            <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Route & Halt Tracking
            </Text>
            <Text style={[styles.headerClock, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {MUMBAI_TIMEZONE_LABEL}: {mumbaiNowLabel}
            </Text>
          </View>
          <Pressable onPress={() => void loadTimeline()} hitSlop={12}>
            <Ionicons name="refresh-outline" size={22} color={colors.primary} />
          </Pressable>
        </View>

        <Animated.View entering={FadeInDown.duration(350)} style={styles.controlsCard}>
          <Text style={[styles.label, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {isPrivilegedViewer ? "Salesperson" : "Your Route"}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {visibleEmployees.map((employee) => {
              const active = employee.id === selectedUserId;
              return (
                <Pressable
                  key={employee.id}
                  onPress={() => setSelectedUserId(employee.id)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : colors.backgroundElevated,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color: active ? "#FFFFFF" : colors.textSecondary,
                        fontFamily: "Inter_500Medium",
                      },
                    ]}
                  >
                    {employee.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.dateRow}>
            <Pressable
              onPress={() => setDayOffset((value) => value - 1)}
              style={[styles.dateButton, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
            >
              <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
            </Pressable>
            <View style={[styles.dateLabelWrap, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
              <Text style={[styles.dateLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                {toShortDate(selectedDate)}
              </Text>
            </View>
            <Pressable
              onPress={() => setDayOffset((value) => Math.min(0, value + 1))}
              style={[styles.dateButton, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
            >
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </Pressable>
            <Pressable
              onPress={() => setDayOffset(0)}
              style={[styles.todayButton, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
          </View>
        </Animated.View>

        {loading ? (
          <View style={[styles.loadingWrap, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Loading route timeline...
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.errorWrap, { backgroundColor: colors.warning + "14", borderColor: colors.warning + "55" }]}>
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={[styles.errorText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>{error}</Text>
          </View>
        ) : null}

        {mapProvider === "osm" || mapProvider === "openstreetmap" ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.primary + "16", borderColor: colors.primary + "55" }]}>
            <Ionicons name="map-outline" size={16} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
              Map provider: OpenStreetMap (free tiles). Route points will render on the map.
            </Text>
          </View>
        ) : null}

        {mapProvider === "maptiler" ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.primary + "16", borderColor: colors.primary + "55" }]}>
            <Ionicons name="map-outline" size={16} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
              Map provider: MapTiler Streets (vector). 3D disabled for better performance.
            </Text>
          </View>
        ) : null}

        {mapProvider === "mappls" ? (
          <View style={styles.sourceRow}>
            <Pressable
              onPress={() => setMapMode("tracking")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    mapMode === "tracking" ? colors.success : colors.backgroundElevated,
                  borderColor: mapMode === "tracking" ? colors.success : colors.border,
                },
              ]}
            >
              <Ionicons
                name="car-sport-outline"
                size={14}
                color={mapMode === "tracking" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: mapMode === "tracking" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Tracking Widget
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setMapMode("polyline")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    mapMode === "polyline" ? colors.primary : colors.backgroundElevated,
                  borderColor: mapMode === "polyline" ? colors.primary : colors.border,
                },
              ]}
            >
              <Ionicons
                name="git-network-outline"
                size={14}
                color={mapMode === "polyline" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: mapMode === "polyline" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Polyline
              </Text>
            </Pressable>
          </View>
        ) : null}

        {timeline?.directions?.enabled ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.success + "16", borderColor: colors.success + "55" }]}>
            <Ionicons name="git-network-outline" size={16} color={colors.success} />
            <Text style={[styles.infoText, { color: colors.success, fontFamily: "Inter_500Medium" }]}>
              Road route: {timeline.directions.resource}/{timeline.directions.profile}
              {typeof timeline.directions.distanceMeters === "number"
                ? ` | ${(timeline.directions.distanceMeters / 1000).toFixed(2)} km`
                : ""}
              {typeof timeline.directions.durationSeconds === "number"
                ? ` | ${Math.max(1, Math.round(timeline.directions.durationSeconds / 60))} mins`
                : ""}
              {timeline.directions.error ? " | API fallback to sampled GPS" : ""}
            </Text>
          </View>
        ) : null}

        <Animated.View entering={FadeInDown.duration(350).delay(50)} style={styles.mapShell}>
          <RouteMapNative
            points={timeline?.points ?? []}
            halts={timeline?.halts ?? []}
            plannedStops={plannedStops}
            routePath={timeline?.directions?.path ?? undefined}
            mapMode={mapMode}
            colors={colors}
            height={Platform.OS === "web" ? 240 : 270}
          />
          {!isTrackingVisible ? (
            <View style={styles.mapOverlay}>
              <View
                style={[
                  styles.mapOverlayCard,
                  {
                    borderColor: colors.warning + "55",
                    backgroundColor: colors.backgroundElevated + "F2",
                  },
                ]}
              >
                <Text
                  style={[styles.mapOverlayTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}
                >
                  {mapStatusTitle}
                </Text>
                <Text
                  style={[
                    styles.mapOverlayText,
                    { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                  ]}
                >
                  {mapStatusText}
                </Text>
              </View>
            </View>
          ) : null}
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(80)} style={styles.summaryRow}>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {summary.totalDistanceKm.toFixed(2)} km
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Distance
            </Text>
          </View>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {summary.totalHaltMinutes} mins
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Halt Time
            </Text>
          </View>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {summary.haltCount}
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Halts
            </Text>
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(350).delay(95)}
          style={[styles.currentLocationCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
        >
          <View style={[styles.currentLocationIcon, { backgroundColor: `${colors.primary}18` }]}>
            <Ionicons name="locate-outline" size={16} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.currentLocationTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              {isTrackingVisible ? "Current Location" : "Attendance Status"}
            </Text>
            <Text style={[styles.currentLocationMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {!isTrackingVisible
                ? mapStatusText
                : latestRoutePoint
                ? `${latestRoutePoint.locationName || latestRoutePoint.geofenceName || "Resolving location..."} | ${toTime(
                    latestRoutePoint.at
                  )}${latestRoutePoint.battery ? ` | ${latestRoutePoint.battery}` : ""}`
                : "Waiting for live GPS point..."}
            </Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(120)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Route Points (GPS + Battery)
          </Text>
          <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            {routePointRows.length ? (
              <ScrollView
                style={styles.timelineScroll}
                contentContainerStyle={styles.timelineContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
              >
                {routePointRows.map((point, idx) => (
                  <View
                    key={`point_${point.id}`}
                    style={[
                      styles.row,
                      idx < routePointRows.length - 1 && {
                        borderBottomColor: colors.borderLight,
                        borderBottomWidth: 0.5,
                      },
                    ]}
                  >
                    <View style={[styles.rowIconWrap, { backgroundColor: `${colors.secondary}18` }]}>
                      <Ionicons name="location-outline" size={16} color={colors.secondary} />
                    </View>
                    <View style={styles.rowTextWrap}>
                      <Text style={[styles.rowTime, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {toTime(point.at)} | {point.battery || "--"}
                      </Text>
                      <Text style={[styles.rowText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {point.locationName || point.geofenceName || "Resolving location..."}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={styles.emptyTimeline}>
                <Text style={[styles.emptyTimelineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No route points available.
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(140)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Detailed Timeline {selectedEmployee ? `- ${selectedEmployee.name}` : ""}
          </Text>
          <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            {rows.length ? (
              <ScrollView
                style={styles.timelineScroll}
                contentContainerStyle={styles.timelineContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
              >
                {rows.map((row, idx) => {
                  const startLabel =
                    row.type === "attendance" ? toTime(row.at) : `${toTime(row.startAt)} - ${toTime(row.endAt)}`;
                  return (
                    <View
                      key={row.id}
                      style={[
                        styles.row,
                        idx < rows.length - 1 && { borderBottomColor: colors.borderLight, borderBottomWidth: 0.5 },
                      ]}
                    >
                      <View style={[styles.rowIconWrap, { backgroundColor: `${row.iconColor}18` }]}>
                        <Ionicons name={row.icon} size={16} color={row.iconColor} />
                      </View>
                      <View style={styles.rowTextWrap}>
                        <Text style={[styles.rowTime, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          {startLabel}
                        </Text>
                        <Text style={[styles.rowText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                          {row.text}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <View style={styles.emptyTimeline}>
                <Text style={[styles.emptyTimelineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No movement timeline generated for this date.
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        <View style={{ height: 38 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 18,
    paddingBottom: 24,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  headerCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 10,
  },
  headerTitle: {
    fontSize: 19,
    letterSpacing: -0.25,
  },
  headerClock: {
    fontSize: 11,
  },
  controlsCard: {
    gap: 10,
  },
  label: {
    fontSize: 12,
  },
  chipRow: {
    gap: 8,
    paddingRight: 20,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12.5,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sourceRow: {
    flexDirection: "row",
    gap: 8,
  },
  sourceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 34,
    paddingHorizontal: 10,
  },
  sourceChipText: {
    fontSize: 12,
  },
  dateButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabelWrap: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabel: {
    fontSize: 13,
  },
  todayButton: {
    borderRadius: 10,
    minHeight: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  todayText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  loadingWrap: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 62,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
  },
  errorWrap: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    flex: 1,
  },
  infoWrap: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  infoText: {
    fontSize: 12,
    flex: 1,
  },
  mapShell: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 22,
  },
  mapOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  mapOverlayCard: {
    width: "100%",
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  mapOverlayTitle: {
    fontSize: 18,
    textAlign: "center",
  },
  mapOverlayText: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
    gap: 2,
  },
  summaryValue: {
    fontSize: 15,
  },
  summaryLabel: {
    fontSize: 11,
  },
  currentLocationCard: {
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  currentLocationIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  currentLocationTitle: {
    fontSize: 12.5,
  },
  currentLocationMeta: {
    marginTop: 2,
    fontSize: 11.8,
    lineHeight: 17,
  },
  sectionTitle: {
    fontSize: 15,
    marginBottom: 8,
  },
  timelineCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  timelineScroll: {
    maxHeight: 260,
  },
  timelineContent: {
    paddingVertical: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTextWrap: {
    flex: 1,
    gap: 2,
  },
  rowTime: {
    fontSize: 12.5,
  },
  rowText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  emptyTimeline: {
    minHeight: 88,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  emptyTimelineText: {
    fontSize: 13,
    textAlign: "center",
  },
  deniedWrap: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 12,
  },
  deniedTitle: {
    fontSize: 20,
  },
  deniedText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  backButton: {
    marginTop: 6,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
