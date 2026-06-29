import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  Alert,
  Linking,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import * as ExpoLocation from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LocationObject } from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { RouteMapNative, type PlannedStopPoint } from "@/components/RouteMapNative";
import { evaluateGeofenceStatus, formatDistance } from "@/lib/geofence";
import {
  addAttendance,
  addAttendanceAnomaly,
  addLocationLog,
  getApiToken,
  getAttendance,
  getGeofences,
  getGeofencesForUser,
  getLocationLogs,
  getSettings,
  isCheckedIn,
  setCheckedIn,
  STORAGE_KEYS,
  subscribeStorageUpdates,
  updateAttendanceApproval,
  upsertGeofence,
} from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
import type { AttendanceRecord, Employee, Geofence, GeofenceEvaluation, LocationLog } from "@/lib/types";
import {
  attendanceCheckIn,
  attendanceCheckOut,
  createGeofence as createGeofenceRemote,
  flushAttendanceQueue,
  getApiBaseUrlCandidates,
  getUserGeofences,
  getUsersRemote,
  getCompanyAttendanceToday,
  queueAttendanceRequest,
  searchMapplsAutosuggest,
  searchMapplsTextSearch,
  updateGeofence as updateGeofenceRemote,
  type DolibarrUser,
} from "@/lib/attendance-api";
import {
  ensureBackgroundLocationTracking,
  flushBackgroundLocationQueue,
  queueLocationPoint,
  stopBackgroundLocationTracking,
} from "@/lib/background-location";
import {
  ensureLocationServicesEnabled,
  getLastKnownLocationSafe,
  getVerifiedLocationEvidence,
  getLocationPermissionSnapshot,
  isMockLocation,
  requestLocationPermissionBundle,
  startSignificantLocationTracking,
} from "@/lib/location-service";
import { verifyBiometricForAttendance } from "@/lib/biometric-attendance";
import { getBatteryLevelPercent } from "@/lib/battery";
import {
  recordGpsDisabledDuringCheckIn,
  recordGpsRestoredDuringCheckIn,
} from "@/lib/gps-tracking-alerts";
import { toMumbaiDateKey, formatMumbaiDateKey, getMumbaiDateKeyByOffset } from "@/lib/ist-time";
import { isBackendReachable } from "@/lib/network";
import { getClientSecurityStatus } from "@/lib/security-client";
import { canReviewAttendanceSignIns, isSalesRole } from "@/lib/role-access";
import {
  dedupeAttendanceRosterMembers,
  isAttendanceRosterMember,
  isSystemAdministratorAccount,
} from "@/lib/attendance-roster";

const LOCATION_REFRESH_MS = 15 * 1000;
const STRICT_LOCATION_ACCURACY_METERS = 180;
const RELAXED_LOCATION_ACCURACY_METERS = 220;
const TRACKING_TIME_INTERVAL_MS = 15 * 1000;
const TRACKING_DISTANCE_INTERVAL_METERS = 0;
const ROUTE_POINT_PERSIST_INTERVAL_MS = 15 * 1000;
const MIN_STABLE_LOCATION_SAMPLES = 2;
const STABLE_LOCATION_MAX_DRIFT_METERS = 90;
const OFFICE_ATTENDANCE_RADIUS_METERS = 500;
const OFFICE_LOCATION_SEARCH_LIMIT = 15;
const OFFICE_LOCATION_SEARCH_MIN_CHARS = 2;
const OFFICE_LOCATION_SEARCH_DEBOUNCE_MS = 400;
function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

const ADMIN_ATTENDANCE_REFRESH_MS = readPositiveIntegerEnv(
  "EXPO_PUBLIC_ATTENDANCE_REFRESH_MS",
  5 * 1000
);

type BannerType = "inside" | "outside" | "weak" | "boundary" | "loading";

type OfficeLocationSearchResult = {
  id: string;
  label: string;
  address: string | null;
  latitude: number;
  longitude: number;
};

type AdminAttendanceStatus = {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  role: string;
  status: "checked_in" | "checked_out" | "no_activity";
  checkInAt: string | null;
  checkOutAt: string | null;
  workMinutes: number;
  workHoursLabel: string;
  geofenceName: string | null;
  locationLabel: string | null;
  approvalStatus: AttendanceRecord["approvalStatus"] | null;
};

type AdminAttendanceGroup = {
  id: string;
  name: string;
  entries: AdminAttendanceStatus[];
  checkedInCount: number;
};

type MonthlyAttendanceSummary = {
  monthKey: string;
  monthLabel: string;
  countedDays: number;
  totalUsers: number;
  presentUserDays: number;
  absentUserDays: number;
  checkedOutUserDays: number;
  totalWorkMinutes: number;
  averageWorkMinutes: number;
  topRows: {
    id: string;
    name: string;
    role: string;
    presentDays: number;
    absentDays: number;
    workMinutes: number;
  }[];
};

function getBannerConfig(
  type: BannerType,
  colors: ReturnType<typeof useAppTheme>["colors"],
  isOfficeGeofence: boolean,
  hasGeofences: boolean
) {
  if (type === "loading") {
    return {
      bg: `${colors.textTertiary}12`,
      border: colors.border,
      text: colors.textSecondary,
      icon: "time-outline",
      label: isOfficeGeofence ? "Initializing geofence check..." : "Initializing GPS tracking...",
    };
  }

  if (!isOfficeGeofence) {
    if (type === "weak") {
      return {
        bg: `${colors.warning}1A`,
        border: `${colors.warning}55`,
        text: colors.warning,
        icon: "radio-outline",
        label: "Weak GPS signal",
      };
    }
    return {
      bg: `${colors.success}1C`,
      border: `${colors.success}55`,
      text: colors.success,
      icon: "checkmark-circle",
      label: "GPS Tracking Active",
    };
  }

  if (!hasGeofences) {
    return {
      bg: `${colors.textTertiary}12`,
      border: colors.border,
      text: colors.textSecondary,
      icon: "business-outline",
      label: "No Office Zone Configured",
    };
  }

  if (type === "inside") {
    return {
      bg: `${colors.success}1C`,
      border: `${colors.success}55`,
      text: colors.success,
      icon: "checkmark-circle",
      label: "Inside geofence",
    };
  }
  if (type === "boundary") {
    return {
      bg: `${colors.warning}1A`,
      border: `${colors.warning}55`,
      text: colors.warning,
      icon: "navigate-circle-outline",
      label: "Near geofence boundary",
    };
  }
  if (type === "weak") {
    return {
      bg: `${colors.warning}1A`,
      border: `${colors.warning}55`,
      text: colors.warning,
      icon: "radio-outline",
      label: "Weak GPS signal",
    };
  }
  return {
    bg: `${colors.danger}1A`,
    border: `${colors.danger}55`,
    text: colors.danger,
    icon: "alert-circle",
    label: "Outside geofence",
  };
}

function isConfirmedInsideZone(state: GeofenceEvaluation): boolean {
  return state.inside && state.insideConfirmed !== false;
}

function isWithinZoneShift(zone: Geofence | null): boolean {
  if (!zone?.workingHoursStart || !zone.workingHoursEnd) return true;
  const [sH, sM] = zone.workingHoursStart.split(":").map(Number);
  const [eH, eM] = zone.workingHoursEnd.split(":").map(Number);
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sH * 60 + sM;
  const endMins = eH * 60 + eM;
  if (endMins >= startMins) {
    return nowMins >= startMins && nowMins <= endMins;
  }
  return nowMins >= startMins || nowMins <= endMins;
}

function isFiniteCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

function makeOfficeLocationId(prefix: string, index: number): string {
  return `${prefix}_${Date.now()}_${index}`;
}

function getOfficeLocationResultKey(result: OfficeLocationSearchResult): string {
  return `${result.latitude.toFixed(5)},${result.longitude.toFixed(5)}|${result.label.trim().toLowerCase()}`;
}

function mergeOfficeLocationResults(
  current: OfficeLocationSearchResult[],
  next: OfficeLocationSearchResult[]
): OfficeLocationSearchResult[] {
  const byKey = new Map<string, OfficeLocationSearchResult>();
  for (const result of [...current, ...next]) {
    byKey.set(getOfficeLocationResultKey(result), result);
  }
  return Array.from(byKey.values()).slice(0, OFFICE_LOCATION_SEARCH_LIMIT);
}

function makeLocalAttendanceRecord(
  userId: string,
  userName: string,
  type: "checkin" | "checkout",
  latitude: number,
  longitude: number,
  evaluation: GeofenceEvaluation,
  photoUrl: string | null,
  deviceId: string,
  notes?: string
): AttendanceRecord {
  const now = new Date().toISOString();
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    userName,
    type,
    timestamp: now,
    timestampServer: now,
    location: { lat: latitude, lng: longitude },
    geofenceId: evaluation.activeZone?.id ?? null,
    geofenceName: evaluation.activeZone?.name ?? null,
    photoUrl,
    deviceId,
    isInsideGeofence: isConfirmedInsideZone(evaluation),
    source: "mobile",
    notes,
  };
}

function resolveCheckedInFromRecords(records: AttendanceRecord[], userId: string, userName?: string): boolean | null {
  const normalizedUserName = (userName || "").trim().toLowerCase();
  const latest = records
    .filter(
      (entry) =>
        entry.userId === userId ||
        ((entry.userName || "").trim().toLowerCase() === normalizedUserName && normalizedUserName.length > 0)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!latest) return null;
  return latest.type === "checkin";
}

function formatAttendanceTime(value: string | null): string {
  if (!value) return "--";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function parseDateKeyParts(dateKey: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function dateKeyToLocalDate(dateKey: string): Date {
  const parts = parseDateKeyParts(dateKey) ?? parseDateKeyParts(toMumbaiDateKey(new Date()))!;
  return new Date(parts.year, parts.month - 1, parts.day);
}

function toLocalDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftDateKey(dateKey: string, dayDelta: number): string {
  const date = dateKeyToLocalDate(dateKey);
  date.setDate(date.getDate() + dayDelta);
  return toLocalDateKey(date);
}

function getMonthKey(dateKey: string): string {
  const parts = parseDateKeyParts(dateKey) ?? parseDateKeyParts(toMumbaiDateKey(new Date()))!;
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function getMonthDateKeys(monthKey: string): string[] {
  const [yearRaw, monthRaw] = monthKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return [];
  const totalDays = new Date(year, month, 0).getDate();
  const todayKey = toMumbaiDateKey(new Date());
  const keys: string[] = [];
  for (let day = 1; day <= totalDays; day += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (key > todayKey) break;
    keys.push(key);
  }
  return keys;
}

function formatWorkDuration(minutesValue: number): string {
  const safeMinutes = Math.max(0, Math.floor(Number.isFinite(minutesValue) ? minutesValue : 0));
  return `${Math.floor(safeMinutes / 60)}h ${safeMinutes % 60}m`;
}

function computeAttendanceWorkMinutes(entries: AttendanceRecord[], dateKey: string): number {
  const sorted = entries
    .filter((entry) => toMumbaiDateKey(entry.timestamp) === dateKey)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let minutes = 0;
  let checkInAt: Date | null = null;
  const todayKey = toMumbaiDateKey(new Date());
  for (const entry of sorted) {
    if (entry.type === "checkin") {
      checkInAt = new Date(entry.timestamp);
    } else if (entry.type === "checkout" && checkInAt) {
      const checkoutAt = new Date(entry.timestamp);
      minutes += Math.max(0, checkoutAt.getTime() - checkInAt.getTime()) / 60000;
      checkInAt = null;
    }
  }
  if (checkInAt && dateKey === todayKey) {
    minutes += Math.max(0, Date.now() - checkInAt.getTime()) / 60000;
  }
  return Math.max(0, Math.floor(minutes));
}

function buildMonthlyAttendanceSummary(
  monthKey: string,
  attendance: AttendanceRecord[],
  employees: Employee[]
): MonthlyAttendanceSummary {
  const dateKeys = getMonthDateKeys(monthKey);
  const roster = employees.filter(
    (employee) => isAttendanceRosterMember(employee) && Boolean(employee.companyId) && employee.companyId !== "workspace_default"
  );
  const employeeGroups = new Map<string, { employee: Employee; ids: Set<string>; names: Set<string> }>();
  for (const employee of roster) {
    const nameKey = normalizeAttendanceIdentity(employee.name);
    const roleKey = normalizeAttendanceIdentity(employee.role);
    const groupKey = nameKey ? `name:${roleKey}:${nameKey}` : `id:${employee.id}`;
    const existing = employeeGroups.get(groupKey);
    if (existing) {
      existing.ids.add(employee.id);
      if (nameKey) existing.names.add(nameKey);
      continue;
    }
    employeeGroups.set(groupKey, {
      employee,
      ids: new Set([employee.id]),
      names: nameKey ? new Set([nameKey]) : new Set(),
    });
  }

  let presentUserDays = 0;
  let checkedOutUserDays = 0;
  let totalWorkMinutes = 0;
  const topRows = Array.from(employeeGroups.values()).map(({ employee, ids, names }) => {
    let presentDays = 0;
    let checkedOutDays = 0;
    let workMinutes = 0;
    for (const dateKey of dateKeys) {
      const entries = attendance.filter(
        (entry) =>
          toMumbaiDateKey(entry.timestamp) === dateKey &&
          (ids.has(entry.userId) || names.has(normalizeAttendanceIdentity(entry.userName)))
      );
      if (entries.some((entry) => entry.type === "checkin")) {
        presentDays += 1;
        presentUserDays += 1;
      }
      if (entries.some((entry) => entry.type === "checkout")) {
        checkedOutDays += 1;
        checkedOutUserDays += 1;
      }
      workMinutes += computeAttendanceWorkMinutes(entries, dateKey);
    }
    totalWorkMinutes += workMinutes;
    return {
      id: employee.id,
      name: employee.name,
      role: employee.role || "employee",
      presentDays,
      absentDays: Math.max(0, dateKeys.length - presentDays),
      workMinutes,
    };
  });

  const totalUsers = topRows.length;
  const totalExpectedUserDays = totalUsers * dateKeys.length;
  const monthDate = dateKeyToLocalDate(`${monthKey}-01`);
  return {
    monthKey,
    monthLabel: monthDate.toLocaleDateString([], { month: "long", year: "numeric" }),
    countedDays: dateKeys.length,
    totalUsers,
    presentUserDays,
    absentUserDays: Math.max(0, totalExpectedUserDays - presentUserDays),
    checkedOutUserDays,
    totalWorkMinutes,
    averageWorkMinutes: presentUserDays > 0 ? Math.floor(totalWorkMinutes / presentUserDays) : 0,
    topRows: topRows.sort((a, b) => b.presentDays - a.presentDays || b.workMinutes - a.workMinutes).slice(0, 8),
  };
}

function normalizeAttendanceIdentity(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeRosterStatus(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) return numeric === 1;
  const text = String(value).trim().toLowerCase();
  return text !== "0" && text !== "false" && text !== "disabled";
}

function mapAttendanceUserToEmployee(user: DolibarrUser, fallbackCompany?: { id?: string; name?: string }): Employee | null {
  if (!normalizeRosterStatus(user.statut ?? user.status)) return null;
  if (isSystemAdministratorAccount(user)) return null;
  const activeCompanyId = (fallbackCompany?.id || "").trim();
  const assignedCompanyIds = Array.isArray(user.assignedCompanyIds)
    ? user.assignedCompanyIds.map((id) => id.trim()).filter(Boolean)
    : [];
  if (assignedCompanyIds.length > 0 && activeCompanyId && !assignedCompanyIds.includes(activeCompanyId)) {
    return null;
  }
  if (Array.isArray(user.assignedCompanyIds) && assignedCompanyIds.length === 0) {
    return null;
  }

  const first = (user.firstname || "").trim();
  const last = (user.lastname || "").trim();
  const name = (user.name || `${first} ${last}`.trim() || user.login || "").trim();
  if (!name) return null;

  const rawCategory = normalizeAttendanceIdentity(user.employeeCategory || user.employee_category);
  const role =
    user.role === "salesperson" || rawCategory === "on_field"
      ? "salesperson"
      : user.role === "employee" || rawCategory === "fixed_location"
        ? "employee"
        : null;
  if (!role) return null;

  const idValue =
    String(user.id || user.rowid || user.user_id || user.login || user.email || name).trim();
  if (!idValue) return null;

  const employee: Employee & { companyName?: string } = {
    id: String(user.id || user.rowid || user.user_id || `user_${idValue}`),
    companyId: (user.companyId || fallbackCompany?.id || "workspace_default").trim(),
    companyName: (user.companyName || fallbackCompany?.name || "").trim(),
    name,
    role,
    employeeCategory: role === "salesperson" ? "on_field" : "fixed_location",
    department: role === "salesperson" ? "On Field Employees" : "Office Employees",
    status: "active",
    email: (user.email || "").trim().toLowerCase(),
    phone: (user.phone || "").trim(),
    branch: (user.branch || "Main Branch").trim(),
    joinDate: new Date().toISOString().slice(0, 10),
  };
  return employee;
}

function mergeAttendanceRoster(primary: Employee[], extra: Employee[]): Employee[] {
  return dedupeAttendanceRosterMembers([...primary, ...extra]);
}

async function loadAttendanceRoster(fallbackCompany?: { id?: string; name?: string }): Promise<Employee[]> {
  const [employees, users] = await Promise.all([
    getEmployees().catch(() => [] as Employee[]),
    getUsersRemote({ companyId: fallbackCompany?.id }).catch(() => [] as DolibarrUser[]),
  ]);
  const userEmployees = users
    .map((entry) => mapAttendanceUserToEmployee(entry, fallbackCompany))
    .filter((entry): entry is Employee => Boolean(entry));
  if (userEmployees.length > 0) {
    // The backend list is the authoritative set of users currently assigned to
    // this company. Do not let stale cached employees inflate the denominator.
    return dedupeAttendanceRosterMembers(userEmployees);
  }

  const companyId = (fallbackCompany?.id || "").trim();
  const scopedFallback = companyId
    ? employees.filter((employee) => (employee.companyId || "").trim() === companyId)
    : employees;
  return dedupeAttendanceRosterMembers(scopedFallback);
}

function buildAdminAttendanceStatuses(
  attendance: AttendanceRecord[],
  employees: Employee[],
  currentUserId?: string,
  selectedDateKey?: string
): AdminAttendanceStatus[] {
  const today = selectedDateKey || toMumbaiDateKey(new Date());
  const employeeGroups = new Map<
    string,
    {
      employee: Employee;
      ids: Set<string>;
      names: Set<string>;
    }
  >();

  for (const employee of employees) {
    if (!isAttendanceRosterMember(employee)) continue;
    const employeeRole = employee.role;
    if (!employee.companyId || employee.companyId === "workspace_default") continue;
    const nameKey = normalizeAttendanceIdentity(employee.name);
    const roleKey = normalizeAttendanceIdentity(employeeRole);
    const groupKey = nameKey ? `name:${roleKey}:${nameKey}` : `id:${employee.id}`;
    const existing = employeeGroups.get(groupKey);
    if (existing) {
      existing.ids.add(employee.id);
      if (nameKey) existing.names.add(nameKey);
      existing.employee = {
        ...employee,
        ...existing.employee,
        id: existing.employee.id || employee.id,
        email: existing.employee.email || employee.email,
        phone: existing.employee.phone || employee.phone,
        branch: existing.employee.branch || employee.branch,
      };
      continue;
    }
    employeeGroups.set(groupKey, {
      employee,
      ids: new Set([employee.id]),
      names: nameKey ? new Set([nameKey]) : new Set(),
    });
  }

  const rows = Array.from(employeeGroups.values()).map((group): AdminAttendanceStatus => {
    const { employee, ids, names } = group;
    const entries = attendance
      .filter(
        (entry) =>
          toMumbaiDateKey(entry.timestamp) === today &&
          (ids.has(entry.userId) || names.has(normalizeAttendanceIdentity(entry.userName)))
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const latest = entries[entries.length - 1] ?? null;
    const latestCheckIn = [...entries].reverse().find((entry) => entry.type === "checkin") ?? null;
    const latestCheckOut = [...entries].reverse().find((entry) => entry.type === "checkout") ?? null;
    const workMinutes = computeAttendanceWorkMinutes(entries, today);
    const location = latest?.location ?? latestCheckIn?.location ?? latestCheckOut?.location ?? null;
    const locationLabel = location ? `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}` : null;

    return {
      id: employee.id,
      companyId: employee.companyId || "workspace_default",
      companyName:
        typeof (employee as { companyName?: unknown }).companyName === "string"
          ? ((employee as { companyName?: string }).companyName || "").trim() || employee.companyId || "Workspace"
          : employee.companyId || "Workspace",
      name: employee.name,
      role: employee.role || "employee",
      status: latest ? (latest.type === "checkin" ? "checked_in" : "checked_out") : "no_activity",
      checkInAt: latestCheckIn?.timestamp ?? null,
      checkOutAt: latestCheckOut?.timestamp ?? null,
      workMinutes,
      workHoursLabel: formatWorkDuration(workMinutes),
      geofenceName: latest?.geofenceName ?? latestCheckIn?.geofenceName ?? latestCheckOut?.geofenceName ?? null,
      locationLabel,
      approvalStatus: latestCheckIn?.approvalStatus ?? null,
    };
  });

  const statusRank = { checked_in: 0, checked_out: 1, no_activity: 2 };
  return rows.sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      (b.checkInAt || b.checkOutAt || "").localeCompare(a.checkInAt || a.checkOutAt || "") ||
      a.name.localeCompare(b.name)
  );
}

function getAttendanceWsUrl(apiBase: string, token: string): string | null {
  try {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/ws/attendance`;
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}

// === WEBSOCKET HOOK DEFINITION ===
function useAttendanceWebSocket(
  isAdminOrManager: boolean, 
  loadBaseData: () => Promise<void>
) {
  useEffect(() => {
    if (!isAdminOrManager) return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let connecting = false;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      attempt++;
      reconnectTimeout = setTimeout(() => {
        void connect(0);
      }, delay);
    };

    const connect = async (candidateIndex = 0) => {
      if (closed || connecting) return;
      connecting = true;
      try {
        const [token, apiBases] = await Promise.all([getApiToken(), getApiBaseUrlCandidates()]);
        if (closed) return;
        if (!token) {
          scheduleReconnect();
          return;
        }

        const wsUrls = apiBases
          .map((apiBase) => getAttendanceWsUrl(apiBase, token))
          .filter((url): url is string => Boolean(url));
        if (wsUrls.length === 0) {
          scheduleReconnect();
          return;
        }

        const wsUrl = wsUrls[Math.min(candidateIndex, wsUrls.length - 1)];
        ws = new WebSocket(wsUrl);
        let opened = false;
        const openTimeout = setTimeout(() => {
          if (!opened) ws?.close();
        }, 8000);

        ws.onopen = () => {
          opened = true;
          clearTimeout(openTimeout);
          attempt = 0; 
          void loadBaseData();
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "attendance_update") {
              void loadBaseData();
            }
          } catch (e) {
            console.error("WS parse error", e);
          }
        };

        ws.onclose = () => {
          clearTimeout(openTimeout);
          if (closed) return;
          if (!opened && candidateIndex < wsUrls.length - 1) {
            void connect(candidateIndex + 1);
            return;
          }
          scheduleReconnect();
        };

        ws.onerror = () => {
          ws?.close();
        };
      } catch (error) {
        console.error("WS connection setup failed", error);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    };

    void connect();

    return () => {
      closed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; 
        ws.close();
      }
    };
  }, [isAdminOrManager, loadBaseData]);
}
// === WEBSOCKET HOOK DEFINITION END ===
export default function AttendanceScreen() {
  const { user, company, updateCompany } = useAuth();
  const [selectedDate, setSelectedDate] = useState(() => toMumbaiDateKey(new Date()));
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [datePickerMonthKey, setDatePickerMonthKey] = useState(() => getMonthKey(toMumbaiDateKey(new Date())));
  const [monthlySummary, setMonthlySummary] = useState<MonthlyAttendanceSummary | null>(null);
  const [monthlySummaryLoading, setMonthlySummaryLoading] = useState(false);
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [pendingSignIns, setPendingSignIns] = useState<AttendanceRecord[]>([]);
  const [adminAttendanceStatuses, setAdminAttendanceStatuses] = useState<AdminAttendanceStatus[]>([]);
  const [collapsedAttendanceCompanyIds, setCollapsedAttendanceCompanyIds] = useState<Set<string>>(new Set());
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [geofencesLoaded, setGeofencesLoaded] = useState(false);
  const [evaluation, setEvaluation] = useState<GeofenceEvaluation>({
    inside: false,
    insideConfirmed: false,
    activeZone: null,
    nearestDistanceMeters: Number.POSITIVE_INFINITY,
    confidenceBufferMeters: 15,
    distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
    signalWeak: true,
    warning: "Waiting for GPS",
  });
  const [checkedInState, setCheckedInState] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(true);
  const [gpsEvidence, setGpsEvidence] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const consecutiveOutsideRef = useRef(0);
  const attendanceSubmissionInProgressRef = useRef<"checkin" | "checkout" | null>(null);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionExplainerOpen, setPermissionExplainerOpen] = useState(true);
  const [autoPromptVisible, setAutoPromptVisible] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const [officeZone, setOfficeZone] = useState<Geofence | null>(null);
  const [officeLocationName, setOfficeLocationName] = useState("");
  const [officeSearchQuery, setOfficeSearchQuery] = useState("");
  const [officeSearchResults, setOfficeSearchResults] = useState<OfficeLocationSearchResult[]>([]);
  const [officeSearchBusy, setOfficeSearchBusy] = useState(false);
  const [officeLocationDraft, setOfficeLocationDraft] = useState<OfficeLocationSearchResult | null>(null);
  const [adminCurrentLocation, setAdminCurrentLocation] = useState<OfficeLocationSearchResult | null>(null);
  const [adminCurrentLocationBusy, setAdminCurrentLocationBusy] = useState(false);
  const [officeSaving, setOfficeSaving] = useState(false);
  const [lastStoredLocationLog, setLastStoredLocationLog] = useState<LocationLog | null>(null);
  const prevInsideRef = useRef(false);
  const locationWatchRef = useRef<{ remove: () => void } | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const routePersistLastAtMsRef = useRef<number>(0);
  const latestEvidenceRef = useRef<{
    sampleCount: number;
    sampleWindowMs: number;
    bestAccuracyMeters: number | null;
  } | null>(null);
  const latestLocationRef = useRef<LocationObject | null>(null);
  const latestLocationCapturedAtMsRef = useRef<number>(0);
  const officeSearchRequestIdRef = useRef(0);
  const loadBaseDataRequestRef = useRef(0);
  const successScale = useSharedValue(1);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: successScale.value }],
  }));

  const canReviewSignIns = canReviewAttendanceSignIns(user?.role);
  const isEmployeeOfficeAttendance = user?.role === "employee";
  const isOfficeGeofenceAttendance = isEmployeeOfficeAttendance || geofences.length > 0;
  const isSalespersonFieldCheckIn = isSalesRole(user?.role) && !isOfficeGeofenceAttendance;
  const isAdminAttendanceManager = user?.role === "admin";
  const showAttendanceOfficeAdminPanel = false;
  const todayHeading = "Today's Log";

  const openAppSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const applyAhmedabadOfficeLocationLock = useCallback(
    (location: LocationObject): LocationObject => location,
    []
  );

  const showPermissionBlockedAlert = useCallback(() => {
    Alert.alert(
      "Location Permission Blocked",
      "Please enable location permission from device settings to continue.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: openAppSettings },
      ]
    );
  }, [openAppSettings]);

  const loadBaseData = useCallback(async () => {
    if (!user?.id) return;
    const requestId = ++loadBaseDataRequestRef.current;
    const shouldLoadRoster = canReviewSignIns || isAdminAttendanceManager;
    const dateKey = selectedDate;
    const companyId = company?.id || undefined;

    // SVR Cache Phase
    if (isAdminAttendanceManager) {
      try {
        const cacheKey = `@attendance_cache_status_${companyId || "workspace"}_${dateKey}`;
        const rosterKey = `@attendance_cache_roster_${companyId || "workspace"}`;
        const [cachedStatusRaw, cachedRosterRaw] = await Promise.all([
          AsyncStorage.getItem(cacheKey),
          AsyncStorage.getItem(rosterKey),
        ]);
        if (requestId === loadBaseDataRequestRef.current) {
          let cachedRecords: AttendanceRecord[] = [];
          let cachedEmployees: Employee[] = [];
          if (cachedStatusRaw) cachedRecords = JSON.parse(cachedStatusRaw);
          if (cachedRosterRaw) cachedEmployees = JSON.parse(cachedRosterRaw);
          if (cachedEmployees.length > 0) {
            setAdminAttendanceStatuses(buildAdminAttendanceStatuses(cachedRecords, cachedEmployees, user.id, dateKey));
          } else {
            setAdminAttendanceStatuses([]);
          }
        }
      } catch (e) {
        console.warn("AsyncStorage get cache failed", e);
      }
    }

    const [localAttendance, companyAttendance, currentCheckIn, employees] = await Promise.all([
      getAttendance(),
      isAdminAttendanceManager
        ? getCompanyAttendanceToday(companyId, dateKey).catch(() => [] as AttendanceRecord[])
        : Promise.resolve([] as AttendanceRecord[]),
      isCheckedIn(),
      shouldLoadRoster
        ? loadAttendanceRoster({ id: companyId, name: company?.name }).catch(() => [] as Employee[])
        : Promise.resolve([] as Employee[]),
    ]);
    if (requestId !== loadBaseDataRequestRef.current) return;

    // Filter local user records to match selected date
    const userRecords = localAttendance.filter(
      (entry) =>
        (entry.userId === user.id ||
        normalizeAttendanceIdentity(entry.userName) === normalizeAttendanceIdentity(user.name)) &&
        toMumbaiDateKey(entry.timestamp) === dateKey
    );
    setRecords(userRecords);

    if (shouldLoadRoster) {
      if (isAdminAttendanceManager) {
        setAdminAttendanceStatuses(buildAdminAttendanceStatuses(companyAttendance, employees, user.id, dateKey));
        // Save SVR Cache
        try {
          const cacheKey = `@attendance_cache_status_${companyId || "workspace"}_${dateKey}`;
          const rosterKey = `@attendance_cache_roster_${companyId || "workspace"}`;
          await Promise.all([
            AsyncStorage.setItem(cacheKey, JSON.stringify(companyAttendance)),
            AsyncStorage.setItem(rosterKey, JSON.stringify(employees)),
          ]);
        } catch (e) {}
      }
      if (!canReviewSignIns) {
        setPendingSignIns([]);
      } else {
        const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
        const employeeByName = new Map(
          employees.map((employee) => [normalizeAttendanceIdentity(employee.name), employee])
        );
        const pending = localAttendance
          .filter((entry) => {
            if (entry.type !== "checkin") return false;
            if (toMumbaiDateKey(entry.timestamp) !== dateKey) return false;
            if ((entry.approvalStatus ?? "approved") !== "pending") return false;
            if (entry.userId === user.id) return false;
            const matchedEmployee =
              employeeById.get(entry.userId) ?? employeeByName.get(normalizeAttendanceIdentity(entry.userName));
            if (!matchedEmployee) return false;
            const recordRole = matchedEmployee.role;
            return recordRole !== "admin" && recordRole !== "manager";
          })
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        setPendingSignIns(pending);
      }
    } else {
      setPendingSignIns([]);
      setAdminAttendanceStatuses([]);
    }
    const derivedCheckIn = resolveCheckedInFromRecords(localAttendance, user.id, user.name);
    const resolvedCheckIn = derivedCheckIn ?? currentCheckIn;
    setCheckedInState(resolvedCheckIn);
    if (resolvedCheckIn !== currentCheckIn) {
      await setCheckedIn(resolvedCheckIn);
    }
  }, [canReviewSignIns, company?.id, company?.name, isAdminAttendanceManager, user?.id, user?.name, selectedDate]);
  // === WEBSOCKET HOOK CALL ===
  // Note: user?.role 'admin' ya 'manager' dono ke liye check kiya hai
  useAttendanceWebSocket(isAdminAttendanceManager || user?.role === "manager", loadBaseData);
  // ============================

  useEffect(() => {
    return subscribeStorageUpdates((event) => {
      if (event.key !== STORAGE_KEYS.ATTENDANCE && event.key !== STORAGE_KEYS.EMPLOYEES) return;
      void loadBaseData();
    });
  }, [loadBaseData]);

  useEffect(() => {
    if (!user?.id || (!canReviewSignIns && !isAdminAttendanceManager)) return;
    const interval = setInterval(() => {
      void loadBaseData();
    }, ADMIN_ATTENDANCE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [canReviewSignIns, isAdminAttendanceManager, loadBaseData, user?.id]);

  useEffect(() => {
    setRecords([]);
    setPendingSignIns([]);
    if (isAdminAttendanceManager) {
      setAdminAttendanceStatuses([]);
    }
    void loadBaseData();
  }, [isAdminAttendanceManager, selectedDate, loadBaseData]);

  const loadMonthlySummary = useCallback(
    async (monthKey = datePickerMonthKey) => {
      if (!isAdminAttendanceManager) return;
      setMonthlySummaryLoading(true);
      try {
        const companyId = company?.id || undefined;
        const [employees, recordsByDay] = await Promise.all([
          loadAttendanceRoster({ id: companyId, name: company?.name }).catch(() => [] as Employee[]),
          Promise.all(
            getMonthDateKeys(monthKey).map((dateKey) =>
              getCompanyAttendanceToday(companyId, dateKey).catch(() => [] as AttendanceRecord[])
            )
          ),
        ]);
        setMonthlySummary(buildMonthlyAttendanceSummary(monthKey, recordsByDay.flat(), employees));
      } catch (error) {
        Alert.alert(
          "Monthly Summary Failed",
          error instanceof Error ? error.message : "Unable to load monthly attendance summary."
        );
      } finally {
        setMonthlySummaryLoading(false);
      }
    },
    [company?.id, company?.name, datePickerMonthKey, isAdminAttendanceManager]
  );

  useEffect(() => {
    if (!datePickerOpen || !isAdminAttendanceManager) return;
    void loadMonthlySummary(datePickerMonthKey);
  }, [datePickerMonthKey, datePickerOpen, isAdminAttendanceManager, loadMonthlySummary]);

  const loadGeofenceAssignments = useCallback(async () => {
    if (!user?.id) return;
    try {
      const cached = await getGeofencesForUser(user.id);
      try {
        const online = await isBackendReachable();
        if (online) {
          const zones = await getUserGeofences(user.id);
          if (zones.length > 0) {
            setGeofences(zones);
            return;
          }
        }
      } catch {
        // fallback handled below
      }
      setGeofences(cached);
    } finally {
      setGeofencesLoaded(true);
    }
  }, [user?.id]);

  const loadLatestStoredLocation = useCallback(async () => {
    if (!user?.id || !isOfficeGeofenceAttendance) {
      setLastStoredLocationLog(null);
      return;
    }
    try {
      const logs = await getLocationLogs();
      const latest = logs
        .filter((log) => log.userId === user.id)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0] ?? null;
      setLastStoredLocationLog(latest);
    } catch {
      setLastStoredLocationLog(null);
    }
  }, [isOfficeGeofenceAttendance, user?.id]);

  const loadOfficeZone = useCallback(async () => {
    if (!company?.id) return;
    const zones = await getGeofences();
    const expectedId = `office_${company.id}`;
    const currentOfficeZone =
      zones.find((zone) => zone.id === expectedId) ||
      zones.find((zone) => zone.companyId === company.id && zone.name === `${company.name} Main Office`) ||
      null;
    setOfficeZone(currentOfficeZone);
    if (currentOfficeZone) {
      setOfficeLocationName(currentOfficeZone.name);
      setOfficeLocationDraft({
        id: currentOfficeZone.id,
        label: currentOfficeZone.name,
        address: null,
        latitude: currentOfficeZone.latitude,
        longitude: currentOfficeZone.longitude,
      });
    }
  }, [company?.id, company?.name]);

  useEffect(() => {
    let active = true;
    (async () => {
      const locationPermissions = await getLocationPermissionSnapshot();
      if (!active) return;
      if (locationPermissions.foreground) {
        setPermissionExplainerOpen(false);
      }
    })().catch(() => {
      // fallback: keep modal visible and allow explicit retry
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    routePersistLastAtMsRef.current = 0;
  }, [user?.id]);

  const handleLocationUpdate = useCallback(
    async (location: LocationObject, options?: { skipRoutePersistence?: boolean }) => {
      if (!user?.id) return;
      const effectiveLocation = applyAhmedabadOfficeLocationLock(location);
      latestLocationRef.current = effectiveLocation;
      latestLocationCapturedAtMsRef.current = Date.now();
      const nextEvaluation = evaluateGeofenceStatus(
        geofences,
        effectiveLocation.coords.latitude,
        effectiveLocation.coords.longitude,
        effectiveLocation.coords.accuracy ?? undefined
      );
      const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
      setEvaluation(nextEvaluation);
      setGpsLoading(false);
      setLocationReady(true);

      // AUTO CHECKOUT: if checked in, but GPS is confirmed >500m away with good accuracy
      const canTriggerAutoCheckout =
        checkedInState &&
        isOfficeGeofenceAttendance &&
        geofencesLoaded &&
        geofences.length > 0 &&
        nextEvaluation.nearestDistanceMeters !== Number.POSITIVE_INFINITY;

      if (canTriggerAutoCheckout && !nextEvaluation.inside && !nextEvaluation.signalWeak && (effectiveLocation.coords.accuracy ?? 100) < 50) {
        if (nextEvaluation.nearestDistanceMeters > 500) {
          consecutiveOutsideRef.current += 1;
          if (consecutiveOutsideRef.current >= 5) {
            void submitAttendance("checkout", { isAuto: true, silent: true });
            consecutiveOutsideRef.current = 0;
          }
        } else {
          consecutiveOutsideRef.current = 0;
        }
      } else {
        consecutiveOutsideRef.current = 0;
      }

      const shouldPersistRoutePoint =
        (!isSalespersonFieldCheckIn || checkedInState) && !options?.skipRoutePersistence;
      const nowMs = Date.now();
      const canPersistRoutePoint =
        shouldPersistRoutePoint &&
        (routePersistLastAtMsRef.current <= 0 ||
          nowMs - routePersistLastAtMsRef.current >= ROUTE_POINT_PERSIST_INTERVAL_MS);
      if (canPersistRoutePoint) {
        routePersistLastAtMsRef.current = nowMs;
        void (async () => {
          const capturedAt = new Date(nowMs).toISOString();
          const locationLog: LocationLog = {
            id: `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            userId: user.id,
            latitude: effectiveLocation.coords.latitude,
            longitude: effectiveLocation.coords.longitude,
            accuracy: effectiveLocation.coords.accuracy ?? null,
            speed: effectiveLocation.coords.speed ?? null,
            heading: effectiveLocation.coords.heading ?? null,
            batteryLevel,
            geofenceId: nextEvaluation.activeZone?.id ?? null,
            geofenceName: nextEvaluation.activeZone?.name ?? null,
            isInsideGeofence: nextEvaluation.inside,
            capturedAt,
          };
          try {
            await addLocationLog(locationLog);
            setLastStoredLocationLog(locationLog);
          } catch {
            // never fail active session because local location persistence failed
          }
          try {
            await queueLocationPoint({
              userId: user.id,
              latitude: effectiveLocation.coords.latitude,
              longitude: effectiveLocation.coords.longitude,
              accuracy: effectiveLocation.coords.accuracy ?? null,
              speed: effectiveLocation.coords.speed ?? null,
              heading: effectiveLocation.coords.heading ?? null,
              batteryLevel,
              capturedAt,
            });
            await flushBackgroundLocationQueue({ force: true });
          } catch {
            // offline/API failure: point is persisted in queue for retry.
          }
        })();
      }

      const shouldPrompt =
        isConfirmedInsideZone(nextEvaluation) &&
        !checkedInState &&
        !prevInsideRef.current &&
        isWithinZoneShift(nextEvaluation.activeZone);
      prevInsideRef.current = isConfirmedInsideZone(nextEvaluation);
      if (shouldPrompt) {
        void (async () => {
          try {
            const settings = await getSettings();
            if (settings.notifications !== "false") {
               setAutoPromptVisible(true);
            }
          } catch {
            // ignore settings read failure for passive prompt
          }
        })();
      }
    },
    [
      applyAhmedabadOfficeLocationLock,
      checkedInState,
      geofences,
      geofencesLoaded,
      isOfficeGeofenceAttendance,
      isSalespersonFieldCheckIn,
      user?.id,
    ]
  );

  const refreshLocation = useCallback(
    async (strict = false, options?: { skipRoutePersistence?: boolean }) => {
      const enabled = await ensureLocationServicesEnabled();
      if (!enabled) {
        if (checkedInState && user?.id) {
          void recordGpsDisabledDuringCheckIn(user, "Device location services are off.").catch(() => {
            // GPS-off audit/notification must not block attendance UI recovery.
          });
        }
        latestEvidenceRef.current = null;
        latestLocationRef.current = null;
        latestLocationCapturedAtMsRef.current = 0;
        setGpsEvidence("");
        setLocationReady(false);
        setEvaluation({
          inside: false,
          insideConfirmed: false,
          activeZone: null,
          nearestDistanceMeters: Number.POSITIVE_INFINITY,
          confidenceBufferMeters: 15,
          distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
          signalWeak: true,
          warning: "GPS services are disabled",
        });
        return null;
      }

      try {
        const evidence = await getVerifiedLocationEvidence({
          minAccuracyMeters: strict ? STRICT_LOCATION_ACCURACY_METERS : RELAXED_LOCATION_ACCURACY_METERS,
          maxAttempts: strict ? 8 : 5,
          requiredStableSamples: strict ? MIN_STABLE_LOCATION_SAMPLES : 1,
          maxDriftMeters: strict ? Math.max(STABLE_LOCATION_MAX_DRIFT_METERS, 120) : 180,
        });
        const effectiveLocation = applyAhmedabadOfficeLocationLock(evidence.location);
        const effectiveEvidence = {
          ...evidence,
          location: effectiveLocation,
        };
        if (checkedInState && user?.id) {
          void recordGpsRestoredDuringCheckIn(user).catch(() => {
            // GPS restore audit is best-effort.
          });
        }
        latestEvidenceRef.current = {
          sampleCount: effectiveEvidence.sampleCount,
          sampleWindowMs: effectiveEvidence.sampleWindowMs,
          bestAccuracyMeters: effectiveEvidence.bestAccuracyMeters,
        };
        latestLocationRef.current = effectiveEvidence.location;
        latestLocationCapturedAtMsRef.current = Date.now();
        setGpsEvidence(
          `GPS lock: ${effectiveEvidence.sampleCount} samples / ${Math.max(
            1,
            Math.round(effectiveEvidence.sampleWindowMs / 1000)
          )}s | best +/-${effectiveEvidence.bestAccuracyMeters ?? "?"}m | avg +/-${
            effectiveEvidence.averageAccuracyMeters ?? "?"
          }m`
        );
        await handleLocationUpdate(effectiveEvidence.location, options);
        return effectiveEvidence;
      } catch {
        let fallbackLocation: LocationObject | null = null;
        try {
          fallbackLocation = await ExpoLocation.getCurrentPositionAsync({
            accuracy: strict ? ExpoLocation.Accuracy.Balanced : ExpoLocation.Accuracy.Low,
            mayShowUserSettingsDialog: true,
          });
        } catch {
          // fall through to last-known fallback
        }

        if (!fallbackLocation) {
          fallbackLocation = await getLastKnownLocationSafe({
            maxAgeMs: 20 * 60 * 1000,
            requiredAccuracy: strict ? 450 : 1200,
          });
        }

        if (fallbackLocation) {
          const effectiveFallbackLocation = applyAhmedabadOfficeLocationLock(fallbackLocation);
          if (checkedInState && user?.id) {
            void recordGpsRestoredDuringCheckIn(user).catch(() => {
              // GPS restore audit is best-effort.
            });
          }
          const fallbackAccuracy =
            typeof effectiveFallbackLocation.coords.accuracy === "number" &&
            Number.isFinite(effectiveFallbackLocation.coords.accuracy)
              ? Math.round(effectiveFallbackLocation.coords.accuracy)
              : null;
          latestEvidenceRef.current = {
            sampleCount: 1,
            sampleWindowMs: 0,
            bestAccuracyMeters: fallbackAccuracy,
          };
          latestLocationRef.current = effectiveFallbackLocation;
          latestLocationCapturedAtMsRef.current = Date.now();
          setGpsEvidence(
            `GPS fallback: ${
              fallbackAccuracy !== null ? `+/-${fallbackAccuracy}m` : "accuracy unknown"
            }`
          );
          await handleLocationUpdate(effectiveFallbackLocation, options);
          return {
            location: effectiveFallbackLocation,
            sampleCount: 1,
            sampleWindowMs: 0,
            averageAccuracyMeters: fallbackAccuracy,
            bestAccuracyMeters: fallbackAccuracy,
          };
        }

        latestEvidenceRef.current = null;
        latestLocationRef.current = null;
        latestLocationCapturedAtMsRef.current = 0;
        setGpsEvidence("");
        setLocationReady(false);
        setEvaluation({
          inside: false,
          insideConfirmed: false,
          activeZone: null,
          nearestDistanceMeters: Number.POSITIVE_INFINITY,
          confidenceBufferMeters: 15,
          distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
          signalWeak: true,
          warning: "Unable to fetch current GPS location",
        });
        return null;
      }
    },
    [applyAhmedabadOfficeLocationLock, checkedInState, handleLocationUpdate, user]
  );

  const beginTracking = useCallback(async () => {
    if (!user?.id) return;
    if (locationWatchRef.current || heartbeatRef.current) return;
    void ensureBackgroundLocationTracking().catch(() => {
      // foreground tracking can still continue even if background registration fails
    });
    try {
      locationWatchRef.current = await startSignificantLocationTracking(handleLocationUpdate, {
        timeIntervalMs: TRACKING_TIME_INTERVAL_MS,
        distanceIntervalMeters: TRACKING_DISTANCE_INTERVAL_METERS,
      });
    } catch {
      // watch fallback: periodic polling only
    }
    if (!heartbeatRef.current) {
      heartbeatRef.current = setInterval(() => {
        void refreshLocation().catch(() => {
          // keep heartbeat alive even if one refresh attempt fails
        });
      }, LOCATION_REFRESH_MS);
    }
  }, [handleLocationUpdate, refreshLocation, user?.id]);

  const stopTracking = useCallback(() => {
    locationWatchRef.current?.remove();
    locationWatchRef.current = null;
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    void stopBackgroundLocationTracking().catch(() => {
      // keep UI stable if background task stop fails
    });
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    void loadBaseData();
    void loadGeofenceAssignments();
    void loadLatestStoredLocation();
    if (isAdminAttendanceManager) {
      void loadOfficeZone();
    }
    void flushAttendanceQueue();
  }, [
    isAdminAttendanceManager,
    loadBaseData,
    loadGeofenceAssignments,
    loadLatestStoredLocation,
    loadOfficeZone,
    user?.id,
  ]);

  useEffect(() => {
    if (!user?.id) return;
    const shouldTrackEmployeeOffice =
      isOfficeGeofenceAttendance && geofences.length > 0 && !checkedInState;
    const shouldTrackLive = checkedInState || !locationReady || shouldTrackEmployeeOffice;
    if (shouldTrackLive) {
      void refreshLocation();
      void beginTracking();
    } else {
      stopTracking();
    }
    return () => {
      stopTracking();
    };
  }, [
    beginTracking,
    checkedInState,
    geofences.length,
    isOfficeGeofenceAttendance,
    locationReady,
    refreshLocation,
    stopTracking,
    user?.id,
  ]);

  const requestPermissions = useCallback(async () => {
    setPermissionLoading(true);
    try {
      const locationPermission = await requestLocationPermissionBundle({ requireBackground: true });
      if (!locationPermission.foreground) {
        if (!locationPermission.foregroundCanAskAgain) {
          showPermissionBlockedAlert();
        } else {
          Alert.alert(
            "Location Required",
            "Foreground location permission is mandatory for secure attendance."
          );
        }
        return;
      }

      const gpsEnabled = await ensureLocationServicesEnabled();
      if (!gpsEnabled) {
        Alert.alert(
          "Turn On GPS",
          "Please enable device location services, then tap Grant Permissions again."
        );
        return;
      }

      setPermissionExplainerOpen(false);
      const strictLocation = await refreshLocation(true);
      if (!strictLocation) {
        Alert.alert("Location Unavailable", "Could not fetch live GPS location. Please try again.");
      }
    } finally {
      setPermissionLoading(false);
    }
  }, [refreshLocation, showPermissionBlockedAlert]);

  const animateSuccess = useCallback(() => {
    successScale.value = withSequence(withTiming(1.04, { duration: 140 }), withTiming(1, { duration: 160 }));
  }, [successScale]);

  const triggerPostCheckInServices = useCallback(() => {
    const jobs: Promise<unknown>[] = [flushAttendanceQueue(), beginTracking(), refreshLocation()];
    void Promise.allSettled(jobs);
  }, [beginTracking, refreshLocation]);

  const getFastAttendanceEvidence = useCallback(async () => {
    const cachedLocation = latestLocationRef.current;
    const cachedAgeMs = Date.now() - latestLocationCapturedAtMsRef.current;
    const cachedAccuracy =
      typeof cachedLocation?.coords.accuracy === "number" && Number.isFinite(cachedLocation.coords.accuracy)
        ? cachedLocation.coords.accuracy
        : Number.POSITIVE_INFINITY;

    if (cachedLocation && cachedAgeMs <= 20_000 && cachedAccuracy <= 250) {
      const roundedAccuracy = Number.isFinite(cachedAccuracy) ? Math.round(cachedAccuracy) : null;
      return {
        location: cachedLocation,
        sampleCount: latestEvidenceRef.current?.sampleCount ?? 1,
        sampleWindowMs: latestEvidenceRef.current?.sampleWindowMs ?? 0,
        averageAccuracyMeters: latestEvidenceRef.current?.bestAccuracyMeters ?? roundedAccuracy,
        bestAccuracyMeters: latestEvidenceRef.current?.bestAccuracyMeters ?? roundedAccuracy,
      };
    }

    return refreshLocation(false, { skipRoutePersistence: true });
  }, [refreshLocation]);

  const searchOfficeLocations = useCallback(async (
    queryInput?: string,
    options?: { showAlerts?: boolean; allowDeviceGeocode?: boolean }
  ) => {
    const query = (queryInput ?? officeSearchQuery).trim();
    const showAlerts = options?.showAlerts ?? false;
    const allowDeviceGeocode = options?.allowDeviceGeocode ?? showAlerts;
    const requestId = officeSearchRequestIdRef.current + 1;
    officeSearchRequestIdRef.current = requestId;

    if (query.length < OFFICE_LOCATION_SEARCH_MIN_CHARS) {
      setOfficeSearchResults([]);
      if (showAlerts) {
        Alert.alert("Search Required", "Enter at least 2 characters of the office name, area, landmark, or address.");
      }
      return;
    }

    setOfficeSearchBusy(true);
    try {
      let results: OfficeLocationSearchResult[] = [];
      let mapplsFailureMessage = "";

      try {
        const autosuggest = await searchMapplsAutosuggest(query, {
          region: "ind",
          limit: OFFICE_LOCATION_SEARCH_LIMIT,
        });
        const autosuggestResults = (autosuggest.suggestions || [])
          .map((suggestion, index): OfficeLocationSearchResult | null => {
            const latitude = suggestion.latitude;
            const longitude = suggestion.longitude;
            if (!isFiniteCoordinate(latitude, longitude)) return null;
            return {
              id: suggestion.id || makeOfficeLocationId("office_mappls", index),
              label: suggestion.label,
              address: suggestion.address,
              latitude: latitude as number,
              longitude: longitude as number,
            };
          })
          .filter((item): item is OfficeLocationSearchResult => Boolean(item));
        results = mergeOfficeLocationResults(results, autosuggestResults);

        const textSearch = await searchMapplsTextSearch(query, {
          region: "ind",
          limit: OFFICE_LOCATION_SEARCH_LIMIT,
        });
        const textSearchResults = (textSearch.suggestions || [])
          .map((suggestion, index): OfficeLocationSearchResult | null => {
            const latitude = suggestion.latitude;
            const longitude = suggestion.longitude;
            if (!isFiniteCoordinate(latitude, longitude)) return null;
            return {
              id: suggestion.id || makeOfficeLocationId("office_mappls_text", index),
              label: suggestion.label,
              address: suggestion.address,
              latitude: latitude as number,
              longitude: longitude as number,
            };
          })
          .filter((item): item is OfficeLocationSearchResult => Boolean(item));
        results = mergeOfficeLocationResults(results, textSearchResults);

        if (!results.length && textSearch.error) {
          mapplsFailureMessage = textSearch.error;
        } else if (!results.length && autosuggest.error) {
          mapplsFailureMessage = autosuggest.error;
        }
      } catch (error) {
        mapplsFailureMessage =
          error instanceof Error ? error.message : "Mappls place search is unavailable right now.";
      }

      try {
        if (query.length >= 4 && results.length < OFFICE_LOCATION_SEARCH_LIMIT) {
          const params = new URLSearchParams({
            q: query,
            format: "jsonv2",
            addressdetails: "1",
            limit: String(Math.max(OFFICE_LOCATION_SEARCH_LIMIT, 10)),
            countrycodes: "in",
          });
          const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
            method: "GET",
            headers: {
              Accept: "application/json",
              "Accept-Language": "en-IN,en",
              "User-Agent": "LuminaFieldForce/1.0 (office-geofence)",
            },
          });
          if (response.ok) {
            const payload = (await response.json()) as {
              lat?: string;
              lon?: string;
              name?: string;
              display_name?: string;
            }[];
            if (Array.isArray(payload)) {
              const osmResults = payload
                .map((item, index): OfficeLocationSearchResult | null => {
                  const latitude = Number.parseFloat(item.lat || "");
                  const longitude = Number.parseFloat(item.lon || "");
                  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
                  const displayName = (item.display_name || "").trim();
                  return {
                    id: makeOfficeLocationId("office_osm", index),
                    label: (item.name || "").trim() || displayName.split(",")[0]?.trim() || query,
                    address: displayName || null,
                    latitude,
                    longitude,
                  };
                })
                .filter((item): item is OfficeLocationSearchResult => Boolean(item));
              results = mergeOfficeLocationResults(results, osmResults);
            }
          }
        }
      } catch {
        // fallback below
      }

      if (!results.length && allowDeviceGeocode) {
        const geocoded = await ExpoLocation.geocodeAsync(query);
        const deviceResults = geocoded
          .slice(0, OFFICE_LOCATION_SEARCH_LIMIT)
          .map((entry, index): OfficeLocationSearchResult => ({
            id: makeOfficeLocationId("office_geo", index),
            label: query,
            address: null,
            latitude: entry.latitude,
            longitude: entry.longitude,
          }));
        results = mergeOfficeLocationResults(results, deviceResults);
      }

      if (officeSearchRequestIdRef.current !== requestId) return;
      setOfficeSearchResults(results);
      if (!results.length && showAlerts) {
        const suffix = mapplsFailureMessage ? `\n\nMappls: ${mapplsFailureMessage}` : "";
        Alert.alert("No Results", `No matching office locations found. Try a more specific address.${suffix}`);
      }
    } catch (error) {
      if (showAlerts) {
        Alert.alert(
          "Search Failed",
          error instanceof Error ? error.message : "Unable to search office location right now."
        );
      }
    } finally {
      if (officeSearchRequestIdRef.current === requestId) {
        setOfficeSearchBusy(false);
      }
    }
  }, [officeSearchQuery]);

  useEffect(() => {
    if (!isAdminAttendanceManager) return;
    const query = officeSearchQuery.trim();
    if (query.length < OFFICE_LOCATION_SEARCH_MIN_CHARS) {
      officeSearchRequestIdRef.current += 1;
      setOfficeSearchResults([]);
      setOfficeSearchBusy(false);
      return;
    }

    const timer = setTimeout(() => {
      void searchOfficeLocations(query, { showAlerts: false, allowDeviceGeocode: false });
    }, OFFICE_LOCATION_SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [isAdminAttendanceManager, officeSearchQuery, searchOfficeLocations]);

  const captureAdminCurrentLocation = useCallback(async () => {
    if (!isAdminAttendanceManager) return;
    setAdminCurrentLocationBusy(true);
    try {
      const permission = await requestLocationPermissionBundle({ requireBackground: false });
      if (!permission.foreground) {
        if (!permission.foregroundCanAskAgain) {
          showPermissionBlockedAlert();
        } else {
          Alert.alert("Location Required", "Allow location permission to show your current position on the map.");
        }
        return;
      }

      const gpsEnabled = await ensureLocationServicesEnabled();
      if (!gpsEnabled) {
        Alert.alert("Turn On GPS", "Please enable device location services and try again.");
        return;
      }

      const position = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
        mayShowUserSettingsDialog: true,
      });
      const accuracy =
        typeof position.coords.accuracy === "number" && Number.isFinite(position.coords.accuracy)
          ? Math.round(position.coords.accuracy)
          : null;
      const currentLocation: OfficeLocationSearchResult = {
        id: "admin_current_location",
        label: "Current Location",
        address: accuracy === null ? null : `GPS accuracy +/-${accuracy}m`,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      const currentLocationDraft: OfficeLocationSearchResult = {
        ...currentLocation,
        id: "admin_current_location_draft",
        label: officeLocationName.trim() || `${company?.name || "Company"} Main Office`,
      };
      setAdminCurrentLocation(currentLocation);
      setOfficeLocationDraft(currentLocationDraft);
    } catch (error) {
      Alert.alert(
        "Current Location Failed",
        error instanceof Error ? error.message : "Unable to fetch current location."
      );
    } finally {
      setAdminCurrentLocationBusy(false);
    }
  }, [company?.name, isAdminAttendanceManager, officeLocationName, showPermissionBlockedAlert]);

  const saveOfficeLocation = useCallback(async (selectedLocation: OfficeLocationSearchResult) => {
    if (!user?.id || !company?.id || !isAdminAttendanceManager) return;
    setOfficeSaving(true);
    try {
      const employees = await getEmployees();
      const assignedEmployeeIds = employees
        .filter((employee) => employee.role === "employee")
        .map((employee) => employee.id);
      const now = new Date().toISOString();
      const officeName = officeLocationName.trim() || selectedLocation.label || `${company.name || "Company"} Main Office`;
      const nextOfficeZone: Geofence = {
        id: officeZone?.id || `office_${company.id}`,
        companyId: company.id,
        name: officeName,
        radiusMeters: OFFICE_ATTENDANCE_RADIUS_METERS,
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        assignedEmployeeIds,
        isActive: true,
        allowOverride: false,
        workingHoursStart: officeZone?.workingHoursStart ?? null,
        workingHoursEnd: officeZone?.workingHoursEnd ?? null,
        createdAt: officeZone?.createdAt || now,
        updatedAt: now,
      };

      await upsertGeofence(nextOfficeZone);
      try {
        if (officeZone?.id) {
          await updateGeofenceRemote(nextOfficeZone.id, nextOfficeZone);
        } else {
          await createGeofenceRemote(nextOfficeZone);
        }
      } catch {
        await createGeofenceRemote(nextOfficeZone).catch(() => undefined);
      }
      await updateCompany({
        attendanceZoneLabel: nextOfficeZone.name,
        primaryBranch: company.primaryBranch || "Main Branch",
      });
      setOfficeZone(nextOfficeZone);
      setOfficeLocationName(officeName);
      setOfficeSearchResults([]);
      setOfficeLocationDraft({
        ...selectedLocation,
        label: officeName,
      });
      Alert.alert(
        "Office Location Saved",
        `Employee check-in is now enabled within ${OFFICE_ATTENDANCE_RADIUS_METERS}m of ${nextOfficeZone.name}.`
      );
    } catch (error) {
      Alert.alert(
        "Office Location Failed",
        error instanceof Error ? error.message : "Unable to save office location."
      );
    } finally {
      setOfficeSaving(false);
    }
  }, [
    company,
    isAdminAttendanceManager,
    officeLocationName,
    officeZone,
    updateCompany,
    user?.id,
  ]);

  const selectOfficeLocationDraft = useCallback((result: OfficeLocationSearchResult) => {
    setOfficeLocationDraft(result);
    setOfficeSearchQuery(result.label);
setOfficeLocationName((current) => current.trim() || result.label);
    setOfficeSearchResults([]);
  }, []);

  const submitAttendance = useCallback(
    async (type: "checkin" | "checkout", options?: { isAuto?: boolean, silent?: boolean }) => {
      if (!user?.id) return;
      if (attendanceSubmissionInProgressRef.current !== null) return;
      if (type === "checkout" && !checkedInState) return;
      if (type === "checkin" && checkedInState) return;

      attendanceSubmissionInProgressRef.current = type;
      if (!options?.silent) setActionLoading(true);
      try {
        const isAuto = options?.isAuto === true;
        const biometricRequired = !isAuto;
        let biometricVerified = false;
        let biometricType: string | null = null;
        let biometricFailureReason: string | null = null;

        const preCaptureEvidence = await getFastAttendanceEvidence();
        if (!preCaptureEvidence) {
          if (!options?.silent) Alert.alert("Location Unavailable", "Unable to fetch live GPS location. Please try again.");
          return;
        }

        const securityPromise = getClientSecurityStatus(isMockLocation(preCaptureEvidence.location));

        if (biometricRequired) {
          const biometricResult = await verifyBiometricForAttendance(type, {
            userId: user.id,
            // Always ask biometric for each action (check-in and check-out).
            enforceDaily: false,
          });
          biometricType = biometricResult.method;
          biometricVerified = biometricResult.success;
          if (!biometricResult.success) {
            biometricFailureReason =
              biometricResult.errorMessage || biometricResult.errorCode || "Biometric verification failed";
            await addAttendanceAnomaly({
              id: `anomaly_${Date.now()}`,
              userId: user.id,
              attendanceId: null,
              type: "biometric_failed",
              severity: "high",
              details: `${type.toUpperCase()} blocked: ${biometricFailureReason}`,
              createdAt: new Date().toISOString(),
            });
            const canOpenSecuritySettings =
              biometricResult.errorCode === "passcode_not_set" ||
              biometricResult.errorCode === "not_enrolled" ||
              biometricResult.errorCode === "not_available";
            Alert.alert("Identity Verification Failed", biometricFailureReason, [
              { text: "Cancel", style: "cancel" },
              ...(canOpenSecuritySettings
                ? [{ text: "Open Settings", onPress: openAppSettings }]
                : []),
            ]);
            return;
          }
        }

        if (type === "checkin") {
          // Start location tracking immediately after successful device authentication.
          void Promise.allSettled([beginTracking(), refreshLocation()]);
        }

        const postCaptureEvidence = preCaptureEvidence;
        const postCaptureLocation = postCaptureEvidence.location;

        const finalEvaluation = evaluateGeofenceStatus(
          geofences,
          postCaptureLocation.coords.latitude,
          postCaptureLocation.coords.longitude,
          postCaptureLocation.coords.accuracy ?? undefined
        );
        const finalZoneName = finalEvaluation.activeZone?.name ?? "Unassigned Zone";

        const security = await securityPromise;
        const capturedAtClient = new Date().toISOString();
        const accuracyMeters = postCaptureLocation.coords.accuracy;
        const roundedAccuracyMeters =
          typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters)
            ? Math.round(accuracyMeters)
            : null;
        const metadataNote = [
          `GPS ${postCaptureLocation.coords.latitude.toFixed(5)}, ${postCaptureLocation.coords.longitude.toFixed(5)}`,
          roundedAccuracyMeters === null ? "accuracy:unknown" : `+/-${roundedAccuracyMeters}m`,
          capturedAtClient,
          finalZoneName,
          biometricRequired && biometricVerified
            ? `Identity:${biometricType || "verified"}`
            : "Identity:optional_or_off",
        ].join(" | ");
        const payload = {
          userId: user.id,
          userName: user.name,
          latitude: postCaptureLocation.coords.latitude,
          longitude: postCaptureLocation.coords.longitude,
          geofenceId: finalEvaluation.activeZone?.id ?? null,
          geofenceName: finalZoneName,
          photoBase64: null,
          photoMimeType: null,
          photoType: type,
          deviceId: security.deviceId,
          isInsideGeofence: isConfirmedInsideZone(finalEvaluation),
          notes: metadataNote,
          mockLocationDetected: security.mockLocationSuspected,
          locationAccuracyMeters: postCaptureLocation.coords.accuracy ?? null,
          capturedAtClient,
          photoCapturedAt: null,
          geofenceDistanceMeters: finalEvaluation.nearestDistanceMeters,
          faceDetected: false,
          faceCount: null,
          faceDetector: null,
          locationSampleCount: postCaptureEvidence.sampleCount,
          locationSampleWindowMs: postCaptureEvidence.sampleWindowMs,
          biometricRequired,
          biometricVerified,
          biometricType,
          biometricFailureReason,
        } as const;

        let record: AttendanceRecord;
        try {
          record = type === "checkin" ? await attendanceCheckIn(payload) : await attendanceCheckOut(payload);
        } catch {
          await queueAttendanceRequest({ type, payload });
          record = makeLocalAttendanceRecord(
            user.id,
            user.name,
            type,
            payload.latitude,
            payload.longitude,
            finalEvaluation,
            null,
            payload.deviceId,
            payload.notes
          );
          await addAttendanceAnomaly({
            id: `anomaly_${Date.now()}`,
            userId: user.id,
            attendanceId: record.id,
            type: "offline_backfill",
            severity: "medium",
            details: `${type.toUpperCase()} queued after API sync fallback`,
            createdAt: new Date().toISOString(),
          });
        }

        // Attendance approvals are disabled; onboarding approval already happens at signup request stage.
        const requiresApproval = false;
        const approvalAwareRecord: AttendanceRecord = {
          ...record,
          approvalStatus: requiresApproval ? "pending" : "approved",
          approvalReviewedById: requiresApproval ? null : user.id,
          approvalReviewedByName: requiresApproval ? null : user.name,
          approvalReviewedAt: requiresApproval ? null : new Date().toISOString(),
          approvalComment: null,
        };

        await addAttendance(approvalAwareRecord);
        await setCheckedIn(type === "checkin");
        setCheckedInState(type === "checkin");
        if (type === "checkin") {
          try {
            // Seed first route point from the same check-in coordinates for admin route timeline.
            const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
            const checkInLocationLog: LocationLog = {
              id: `loc_checkin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              userId: user.id,
              latitude: payload.latitude,
              longitude: payload.longitude,
              accuracy: payload.locationAccuracyMeters ?? null,
              speed: null,
              heading: null,
              batteryLevel,
              geofenceId: payload.geofenceId ?? null,
              geofenceName: payload.geofenceName ?? null,
              isInsideGeofence: payload.isInsideGeofence,
              capturedAt: capturedAtClient,
            };
            await addLocationLog(checkInLocationLog);
            setLastStoredLocationLog(checkInLocationLog);
            await queueLocationPoint({
              userId: user.id,
              latitude: payload.latitude,
              longitude: payload.longitude,
              accuracy: payload.locationAccuracyMeters ?? null,
              speed: null,
              heading: null,
              batteryLevel,
              capturedAt: capturedAtClient,
            });
            void flushBackgroundLocationQueue({ force: true }).catch(() => {
              // queue will retry sync on next heartbeat/background flush.
            });
            const seededAtMs = new Date(capturedAtClient).getTime();
            if (Number.isFinite(seededAtMs)) {
              routePersistLastAtMsRef.current = seededAtMs;
            }
          } catch {
            // Route seeding must never block attendance check-in completion.
          }
          triggerPostCheckInServices();
        }
        if (type === "checkout" && isSalespersonFieldCheckIn) {
          stopTracking();
        }
        void loadBaseData();
        if (requiresApproval) {
          Alert.alert(
            "Sign-in Submitted",
            "Your check-in was captured and is now pending manager/admin approval."
          );
        }
        if (!options?.silent) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          animateSuccess();
        }
      } catch (error) {
        if (!options?.silent) Alert.alert("Attendance Failed", error instanceof Error ? error.message : "Unknown error");
      } finally {
        attendanceSubmissionInProgressRef.current = null;
        if (!options?.silent) setActionLoading(false);
      }
    },
    [
      animateSuccess,
      beginTracking,
      checkedInState,
      geofences,
      getFastAttendanceEvidence,
      isSalespersonFieldCheckIn,
      loadBaseData,
      openAppSettings,
      refreshLocation,
      stopTracking,
      triggerPostCheckInServices,
      user?.id,
      user?.name,
    ]
  );

  const handleSignInApproval = useCallback(
    async (attendanceId: string, status: "approved" | "rejected") => {
      if (!user?.id || !canReviewSignIns) return;
      setApprovalActionId(attendanceId);
      try {
        const updated = await updateAttendanceApproval(attendanceId, status, {
          id: user.id,
          name: user.name,
        });
        if (!updated) {
          Alert.alert("Not Found", "This sign-in request is no longer available.");
        }
        await loadBaseData();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
          // ignore haptics runtime failures
        });
      } catch (error) {
        Alert.alert("Action Failed", error instanceof Error ? error.message : "Unable to update request.");
      } finally {
        setApprovalActionId(null);
      }
    },
    [canReviewSignIns, loadBaseData, user?.id, user?.name]
  );

  const workingHours = useMemo(() => {
    if (!records.length) return "0h 0m";
    const today = toMumbaiDateKey(new Date());
    const todayEntries = records
      .filter((entry) => toMumbaiDateKey(entry.timestamp) === today)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let minutes = 0;
    let checkInTime: Date | null = null;
    for (const entry of todayEntries) {
      if (entry.type === "checkin") {
        checkInTime = new Date(entry.timestamp);
      } else if (entry.type === "checkout" && checkInTime) {
        minutes += (new Date(entry.timestamp).getTime() - checkInTime.getTime()) / 60000;
        checkInTime = null;
      }
    }
    if (checkInTime) {
      minutes += (Date.now() - checkInTime.getTime()) / 60000;
    }
    return `${Math.max(0, Math.floor(minutes / 60))}h ${Math.max(0, Math.floor(minutes % 60))}m`;
  }, [records]);

  const employeeHasOfficeZone = !isOfficeGeofenceAttendance || geofences.length > 0;
  const employeeInsideOfficeZone = !isOfficeGeofenceAttendance || evaluation.inside;
  const bannerType: BannerType = (!geofencesLoaded || !locationReady)
    ? "loading"
    : evaluation.signalWeak
    ? "weak"
    : evaluation.inside
      ? isConfirmedInsideZone(evaluation)
        ? "inside"
        : "boundary"
      : "outside";
  const banner = getBannerConfig(bannerType, colors, isOfficeGeofenceAttendance, geofences.length > 0);
  const zoneName = isSalespersonFieldCheckIn
    ? "Field Route Tracking"
    : evaluation.activeZone?.name ?? (isOfficeGeofenceAttendance ? "Office not set" : "No zone");
  const canCheckIn = locationReady && employeeHasOfficeZone && employeeInsideOfficeZone;
  const canSubmitAction = (selectedDate === toMumbaiDateKey(new Date())) && (checkedInState ? locationReady : canCheckIn);
  const employeeDistanceLabel =
    isOfficeGeofenceAttendance && Number.isFinite(evaluation.nearestDistanceMeters)
      ? formatDistance(evaluation.nearestDistanceMeters)
      : null;
  const lastStoredLocationLabel =
    isOfficeGeofenceAttendance && lastStoredLocationLog
      ? `${lastStoredLocationLog.latitude.toFixed(5)}, ${lastStoredLocationLog.longitude.toFixed(5)}`
      : null;
  const adminCheckedInCount = adminAttendanceStatuses.filter((entry) => entry.status === "checked_in").length;
  const adminCheckedOutCount = adminAttendanceStatuses.filter((entry) => entry.status === "checked_out").length;
  const adminNoActivityCount = adminAttendanceStatuses.filter((entry) => entry.status === "no_activity").length;
  const adminTotalWorkMinutes = adminAttendanceStatuses.reduce((sum, entry) => sum + entry.workMinutes, 0);
  const adminAttendanceGroups = useMemo<AdminAttendanceGroup[]>(() => {
    const groupsByCompany = new Map<string, AdminAttendanceStatus[]>();
    for (const entry of adminAttendanceStatuses) {
      const groupId = entry.companyId || company?.id || "workspace_default";
      const existing = groupsByCompany.get(groupId) || [];
      existing.push({
        ...entry,
        companyId: groupId,
        companyName:
          groupId === company?.id
            ? company?.name || entry.companyName || "Workspace"
            : entry.companyName && entry.companyName !== entry.companyId
              ? entry.companyName
              : `Workspace ${groupsByCompany.size + 1}`,
      });
      groupsByCompany.set(groupId, existing);
    }
    return Array.from(groupsByCompany.entries()).map(([id, entries]) => ({
      id,
      name: entries[0]?.companyName || (id === company?.id ? company?.name : null) || "Workspace",
      entries,
      checkedInCount: entries.filter((entry) => entry.status === "checked_in" || entry.status === "checked_out").length,
    }));
  }, [adminAttendanceStatuses, company?.id, company?.name]);
  const hasMultipleAttendanceGroups = adminAttendanceGroups.length > 1;
  const toggleAttendanceGroup = useCallback((groupId: string) => {
    setCollapsedAttendanceCompanyIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (company?.id && adminAttendanceGroups.length > 0) {
      setCollapsedAttendanceCompanyIds((current) => {
        const next = new Set(current);
        // Ensure active company is open (not collapsed)
        next.delete(company.id);
        // Collapse other groups by default
        for (const g of adminAttendanceGroups) {
          if (g.id !== company.id) {
            next.add(g.id);
          }
        }
        return next;
      });
    }
  }, [company?.id, adminAttendanceGroups]);
  const officeMapPlannedStops = useMemo<PlannedStopPoint[]>(() => {
    const stops: PlannedStopPoint[] = [];
    if (officeLocationDraft) {
      const officeMarkerName = officeLocationName.trim() || officeLocationDraft.label;
      stops.push({
        id: "attendance_office_location",
        label: officeMarkerName,
        customerName: officeMarkerName,
        latitude: officeLocationDraft.latitude,
        longitude: officeLocationDraft.longitude,
        status: "in_progress",
        markerKind: "planned_stop",
        summary: `Office geofence radius: ${OFFICE_ATTENDANCE_RADIUS_METERS}m`,
        detail: officeLocationDraft.address || `${officeLocationDraft.latitude.toFixed(5)}, ${officeLocationDraft.longitude.toFixed(5)}`,
      });
    }
    const currentMatchesOffice = Boolean(
      officeLocationDraft &&
      adminCurrentLocation &&
      Math.abs(officeLocationDraft.latitude - adminCurrentLocation.latitude) <= 0.000001 &&
      Math.abs(officeLocationDraft.longitude - adminCurrentLocation.longitude) <= 0.000001
    );
    if (adminCurrentLocation && !currentMatchesOffice) {
      stops.push({
        id: "attendance_current_location",
        label: "Current Location",
        customerName: "Current Location",
        latitude: adminCurrentLocation.latitude,
        longitude: adminCurrentLocation.longitude,
        status: "pending",
        markerKind: "planned_stop",
        summary: "Your device GPS position",
        detail: adminCurrentLocation.address || `${adminCurrentLocation.latitude.toFixed(5)}, ${adminCurrentLocation.longitude.toFixed(5)}`,
      });
    }
    return stops;
  }, [adminCurrentLocation, officeLocationDraft, officeLocationName]);
  const officeLocationToSave = officeLocationDraft ?? adminCurrentLocation;

  return (
    <AppCanvas>
      <Modal visible={datePickerOpen} transparent animationType="fade" onRequestClose={() => setDatePickerOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.datePickerCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.datePickerHeader}>
              <Pressable
                style={[styles.datePickerIconButton, { borderColor: colors.border }]}
                onPress={() => {
                  const date = dateKeyToLocalDate(`${datePickerMonthKey}-01`);
                  date.setMonth(date.getMonth() - 1);
                  setDatePickerMonthKey(getMonthKey(toLocalDateKey(date)));
                }}
              >
                <Ionicons name="chevron-back" size={18} color={colors.primary} />
              </Pressable>
              <View style={{ flex: 1, alignItems: "center" }}>
                <Text style={[styles.datePickerTitle, { color: colors.text }]}>
                  {dateKeyToLocalDate(`${datePickerMonthKey}-01`).toLocaleDateString([], { month: "long", year: "numeric" })}
                </Text>
                <Text style={[styles.datePickerSubtitle, { color: colors.textSecondary }]}>Select date or review month</Text>
              </View>
              <Pressable
                disabled={datePickerMonthKey >= getMonthKey(toMumbaiDateKey(new Date()))}
                style={[
                  styles.datePickerIconButton,
                  { borderColor: colors.border },
                  datePickerMonthKey >= getMonthKey(toMumbaiDateKey(new Date())) && { opacity: 0.35 },
                ]}
                onPress={() => {
                  const date = dateKeyToLocalDate(`${datePickerMonthKey}-01`);
                  date.setMonth(date.getMonth() + 1);
                  const nextMonthKey = getMonthKey(toLocalDateKey(date));
                  if (nextMonthKey <= getMonthKey(toMumbaiDateKey(new Date()))) {
                    setDatePickerMonthKey(nextMonthKey);
                  }
                }}
              >
                <Ionicons name="chevron-forward" size={18} color={colors.primary} />
              </Pressable>
            </View>

            <View style={styles.calendarWeekRow}>
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <Text key={day} style={[styles.calendarWeekText, { color: colors.textTertiary }]}>{day}</Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {(() => {
                const firstDate = dateKeyToLocalDate(`${datePickerMonthKey}-01`);
                const leadingBlanks = firstDate.getDay();
                const days = getMonthDateKeys(datePickerMonthKey);
                const cells = [
                  ...Array.from({ length: leadingBlanks }, (_, index) => ({ key: `blank_${index}`, dateKey: "" })),
                  ...days.map((dateKey) => ({ key: dateKey, dateKey })),
                ];
                return cells.map((cell) => {
                  if (!cell.dateKey) return <View key={cell.key} style={styles.calendarDayCell} />;
                  const day = parseDateKeyParts(cell.dateKey)?.day ?? 1;
                  const selected = cell.dateKey === selectedDate;
                  return (
                    <Pressable
                      key={cell.key}
                      style={[
                        styles.calendarDayCell,
                        {
                          backgroundColor: selected ? colors.primary : colors.surfaceSecondary,
                          borderColor: selected ? colors.primary : colors.borderLight,
                        },
                      ]}
                      onPress={() => {
                        setSelectedDate(cell.dateKey);
                        setDatePickerOpen(false);
                        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                    >
                      <Text style={[styles.calendarDayText, { color: selected ? "#fff" : colors.text }]}>
                        {day}
                      </Text>
                    </Pressable>
                  );
                });
              })()}
            </View>

            {isAdminAttendanceManager ? (
            <View style={[styles.monthSummaryPanel, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
              <View style={styles.monthSummaryHeader}>
                <Text style={[styles.monthSummaryTitle, { color: colors.text }]}>Monthly Summary</Text>
                <Pressable
                  style={[styles.monthSummaryRefresh, { backgroundColor: colors.primary }]}
                  onPress={() => void loadMonthlySummary(datePickerMonthKey)}
                  disabled={monthlySummaryLoading}
                >
                  {monthlySummaryLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Ionicons name="refresh-outline" size={16} color="#fff" />
                  )}
                </Pressable>
              </View>
              {monthlySummaryLoading && !monthlySummary ? (
                <View style={styles.monthSummaryLoading}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[styles.monthSummaryMeta, { color: colors.textSecondary }]}>Loading month...</Text>
                </View>
              ) : monthlySummary ? (
                <>
                  <View style={styles.monthSummaryGrid}>
                    <View style={[styles.monthSummaryChip, { borderColor: colors.borderLight }]}>
                      <Text style={[styles.monthSummaryValue, { color: colors.text }]}>{monthlySummary.totalUsers}</Text>
                      <Text style={[styles.monthSummaryLabel, { color: colors.textSecondary }]}>Users</Text>
                    </View>
                    <View style={[styles.monthSummaryChip, { borderColor: colors.borderLight }]}>
                      <Text style={[styles.monthSummaryValue, { color: colors.success }]}>{monthlySummary.presentUserDays}</Text>
                      <Text style={[styles.monthSummaryLabel, { color: colors.textSecondary }]}>Present Days</Text>
                    </View>
                    <View style={[styles.monthSummaryChip, { borderColor: colors.borderLight }]}>
                      <Text style={[styles.monthSummaryValue, { color: colors.danger }]}>{monthlySummary.absentUserDays}</Text>
                      <Text style={[styles.monthSummaryLabel, { color: colors.textSecondary }]}>Absent Days</Text>
                    </View>
                    <View style={[styles.monthSummaryChip, { borderColor: colors.borderLight }]}>
                      <Text style={[styles.monthSummaryValue, { color: colors.primary }]}>{formatWorkDuration(monthlySummary.totalWorkMinutes)}</Text>
                      <Text style={[styles.monthSummaryLabel, { color: colors.textSecondary }]}>Work Hours</Text>
                    </View>
                  </View>
                  <Text style={[styles.monthSummaryMeta, { color: colors.textSecondary }]}>
                    Counted {monthlySummary.countedDays} calendar day(s). Avg present-day hours: {formatWorkDuration(monthlySummary.averageWorkMinutes)}.
                  </Text>
                  {monthlySummary.topRows.slice(0, 4).map((row) => (
                    <View key={`month_row_${row.id}`} style={[styles.monthUserRow, { borderTopColor: colors.borderLight }]}>
                      <Text style={[styles.monthUserName, { color: colors.text }]} numberOfLines={1}>{row.name}</Text>
                      <Text style={[styles.monthUserMeta, { color: colors.textSecondary }]}>
                        P {row.presentDays} | A {row.absentDays} | {formatWorkDuration(row.workMinutes)}
                      </Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={[styles.monthSummaryMeta, { color: colors.textSecondary }]}>Tap refresh to load summary.</Text>
              )}
            </View>
            ) : null}

            <Pressable
              style={[styles.datePickerCloseButton, { backgroundColor: colors.primary }]}
              onPress={() => setDatePickerOpen(false)}
            >
              <Text style={styles.datePickerCloseText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={permissionExplainerOpen && !isAdminAttendanceManager} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Enable Secure Attendance</Text>
            <Text style={[styles.modalText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Tap Grant Permissions to allow location. Sales check-in will start live GPS route tracking with battery level."
                : isOfficeGeofenceAttendance
                  ? `Tap Grant Permissions to allow location. Check-in unlocks only within ${OFFICE_ATTENDANCE_RADIUS_METERS}m of the company office.`
                : "Tap Grant Permissions to allow location. Secure check-in uses face unlock, fingerprint, or device PIN/password verification and starts live location tracking."}
            </Text>
            <Pressable
              style={[styles.modalButton, { backgroundColor: colors.primary, opacity: permissionLoading ? 0.86 : 1 }]}
              onPress={requestPermissions}
              disabled={permissionLoading}
            >
              {permissionLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.modalButtonText}>Grant Permissions</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={autoPromptVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              You arrived at {zoneName}
            </Text>
            <Text style={[styles.modalText, { color: colors.textSecondary }]}>
              Check in now to record geo-verified attendance.
            </Text>
            <View style={styles.modalRow}>
              <Pressable
                style={[styles.modalGhostButton, { borderColor: colors.border }]}
                onPress={() => setAutoPromptVisible(false)}
              >
                <Text style={[styles.modalGhostText, { color: colors.textSecondary }]}>Later</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, { backgroundColor: colors.primary, flex: 1 }]}
                onPress={() => {
                  setAutoPromptVisible(false);
                  void submitAttendance("checkin");
                }}
              >
                <Text style={styles.modalButtonText}>Check In</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Secure Attendance</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {isSalespersonFieldCheckIn
            ? `${company?.name || "Company"} time-based check-in with live GPS + battery tracking`
            : isOfficeGeofenceAttendance
              ? `${company?.name || "Company"} office check-in within ${OFFICE_ATTENDANCE_RADIUS_METERS}m of assigned location`
            : `${company?.name || "Company"} device-authenticated secure check-in with live location tracking`}
        </Text>

        {/* Date Selector UI */}
        <View style={[styles.dateNavContainer, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          <Pressable
            style={({ pressed }) => [styles.dateNavButton, pressed && { opacity: 0.7 }]}
            onPress={() => {
              const nextDate = shiftDateKey(selectedDate, -1);
              setSelectedDate(nextDate);
              setDatePickerMonthKey(getMonthKey(nextDate));
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.dateNavLabelContainer, pressed && { opacity: 0.82 }]}
            onPress={() => {
              setDatePickerMonthKey(getMonthKey(selectedDate));
              setDatePickerOpen(true);
            }}
          >
            <Text style={[styles.dateNavLabel, { color: colors.text }]}>
              {(() => {
                const todayKey = toMumbaiDateKey(new Date());
                const yesterdayKey = getMumbaiDateKeyByOffset(-1);
                if (selectedDate === todayKey) return "Today, " + formatMumbaiDateKey(selectedDate);
                if (selectedDate === yesterdayKey) return "Yesterday, " + formatMumbaiDateKey(selectedDate);
                return formatMumbaiDateKey(selectedDate);
              })()}
            </Text>
            <Ionicons name="calendar-outline" size={16} color={colors.primary} />
          </Pressable>

          <Pressable
            disabled={selectedDate >= toMumbaiDateKey(new Date())}
            style={({ pressed }) => [
              styles.dateNavButton,
              pressed && { opacity: 0.7 },
              selectedDate >= toMumbaiDateKey(new Date()) && { opacity: 0.3 }
            ]}
            onPress={() => {
              const nextKey = shiftDateKey(selectedDate, 1);
              if (nextKey <= toMumbaiDateKey(new Date())) {
                setSelectedDate(nextKey);
                setDatePickerMonthKey(getMonthKey(nextKey));
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
            }}
          >
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </Pressable>
        </View>

        {/* Past Date Notice for check-in action */}
        {selectedDate !== toMumbaiDateKey(new Date()) && !isAdminAttendanceManager ? (
          <View style={[styles.pastDateNotice, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "44" }]}>
            <Ionicons name="warning-outline" size={18} color={colors.warning} />
            <View style={{ flex: 1, marginLeft: 8 }}>
              <Text style={[styles.pastDateNoticeText, { color: colors.text }]}>
                Viewing logs for {formatMumbaiDateKey(selectedDate)}. Check-in is disabled.
              </Text>
            </View>
            <Pressable
              style={[styles.pastDateReturnButton, { backgroundColor: colors.primary }]}
              onPress={() => {
                setSelectedDate(toMumbaiDateKey(new Date()));
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              }}
            >
              <Text style={styles.pastDateReturnButtonText}>Go to Today</Text>
            </Pressable>
          </View>
        ) : null}

        {isAdminAttendanceManager ? (
          <>
          <View style={styles.adminAttendanceSection}>
            <View style={styles.adminAttendanceHeader}>
              <Text style={[styles.logsTitle, { color: colors.text, marginTop: 0, marginBottom: 0 }]}>
                {selectedDate === toMumbaiDateKey(new Date()) ? "Team Attendance Today" : "Team Attendance for " + formatMumbaiDateKey(selectedDate)}
              </Text>
              <Pressable
                style={[styles.refreshButton, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
                onPress={() => void loadBaseData()}
              >
                <Ionicons name="refresh-outline" size={16} color={colors.primary} />
              </Pressable>
            </View>
            <View style={styles.adminSummaryRow}>
              <View style={[styles.adminSummaryChip, { backgroundColor: colors.success + "16", borderColor: colors.success + "55" }]}>
                <Text style={[styles.adminSummaryValue, { color: colors.success }]}>{adminCheckedInCount}</Text>
                <Text style={[styles.adminSummaryLabel, { color: colors.textSecondary }]}>Checked In</Text>
              </View>
              <View style={[styles.adminSummaryChip, { backgroundColor: colors.primary + "14", borderColor: colors.primary + "44" }]}>
                <Text style={[styles.adminSummaryValue, { color: colors.primary }]}>{adminCheckedOutCount}</Text>
                <Text style={[styles.adminSummaryLabel, { color: colors.textSecondary }]}>Checked Out</Text>
              </View>
              <View style={[styles.adminSummaryChip, { backgroundColor: colors.textTertiary + "12", borderColor: colors.border }]}>
                <Text style={[styles.adminSummaryValue, { color: colors.textSecondary }]}>{adminNoActivityCount}</Text>
                <Text style={[styles.adminSummaryLabel, { color: colors.textSecondary }]}>No Activity</Text>
              </View>
              <View style={[styles.adminSummaryChip, { backgroundColor: colors.secondary + "12", borderColor: colors.secondary + "44" }]}>
                <Text style={[styles.adminSummaryValue, { color: colors.secondary }]}>{formatWorkDuration(adminTotalWorkMinutes)}</Text>
                <Text style={[styles.adminSummaryLabel, { color: colors.textSecondary }]}>Work Hours</Text>
              </View>
            </View>
            <View style={[styles.logList, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {adminAttendanceStatuses.length === 0 ? (
                <View style={styles.emptyLog}>
                  <Ionicons name="people-outline" size={20} color={colors.textTertiary} />
                  <Text style={[styles.emptyLogText, { color: colors.textSecondary }]}>
                    No employee or salesperson found for this company/workspace.
                  </Text>
                </View>
              ) : (
                adminAttendanceGroups.map((group, groupIndex) => {
                  const groupOpen = !collapsedAttendanceCompanyIds.has(group.id);
                  return (
                    <View
                      key={`admin_attendance_group_${group.id}`}
                      style={[
                        groupIndex < adminAttendanceGroups.length - 1 && {
                          borderBottomColor: colors.borderLight,
                          borderBottomWidth: 1,
                        },
                      ]}
                    >
                      <Pressable
                        onPress={() => {
                          if (hasMultipleAttendanceGroups) toggleAttendanceGroup(group.id);
                        }}
                        disabled={!hasMultipleAttendanceGroups}
                        style={({ pressed }) => [
                          styles.companyAttendanceHeader,
                          {
                            backgroundColor: pressed ? colors.surfaceSecondary : "transparent",
                          },
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.companyAttendanceTitle, { color: colors.text }]}>{group.name}</Text>
                          <Text style={[styles.companyAttendanceMeta, { color: colors.textSecondary }]}>
                            {group.checkedInCount} present out of {group.entries.length}
                          </Text>
                        </View>
                        <Text style={[styles.companyAttendanceCount, { color: colors.success }]}>
                          {group.checkedInCount}/{group.entries.length}
                        </Text>
                        {hasMultipleAttendanceGroups ? (
                          <Ionicons
                            name={groupOpen ? "chevron-up-outline" : "chevron-down-outline"}
                            size={18}
                            color={colors.textSecondary}
                          />
                        ) : null}
                      </Pressable>
                      {groupOpen
                        ? group.entries.map((entry, index) => {
                            const isCheckedIn = entry.status === "checked_in";
                            const isCheckedOut = entry.status === "checked_out";
                            const statusColor = isCheckedIn
                              ? colors.success
                              : isCheckedOut
                                ? colors.primary
                                : colors.textTertiary;
                            const statusLabel = isCheckedIn ? "Checked in" : isCheckedOut ? "Checked out" : "No activity";
                            const statusIcon = isCheckedIn
                              ? "log-in-outline"
                              : isCheckedOut
                                ? "log-out-outline"
                                : "time-outline";
                            const metaParts = [
                              entry.checkInAt ? `In ${formatAttendanceTime(entry.checkInAt)}` : null,
                              entry.checkOutAt ? `Out ${formatAttendanceTime(entry.checkOutAt)}` : null,
                              `Work ${entry.workHoursLabel}`,
                              entry.geofenceName ?? entry.locationLabel,
                            ].filter(Boolean);
                            const approvalLabel =
                              entry.approvalStatus === "pending"
                                ? "Pending approval"
                                : entry.approvalStatus === "rejected"
                                  ? "Rejected"
                                  : null;
                            return (
                              <View
                                key={`admin_attendance_${group.id}_${entry.id}_${index}`}
                                style={[
                                  styles.adminAttendanceRow,
                                  index < group.entries.length - 1 && {
                                    borderBottomColor: colors.borderLight,
                                    borderBottomWidth: 1,
                                  },
                                ]}
                              >
                                <View style={[styles.adminStatusIcon, { backgroundColor: statusColor + "18" }]}>
                                  <Ionicons name={statusIcon as never} size={18} color={statusColor} />
                                </View>
                                <View style={{ flex: 1 }}>
                                  <View style={styles.adminAttendanceNameRow}>
                                    <Text style={[styles.logType, { color: colors.text }]}>{entry.name}</Text>
                                    <Text style={[styles.adminRolePill, { color: colors.textSecondary, borderColor: colors.border }]}>
                                      {entry.role.toUpperCase()}
                                    </Text>
                                  </View>
                                  <Text style={[styles.logMeta, { color: colors.textSecondary }]}>
                                    {metaParts.length
                                      ? metaParts.join(" | ")
                                      : selectedDate === toMumbaiDateKey(new Date())
                                        ? "No check-in or checkout today"
                                        : "No check-in or checkout for this date"}
                                    {approvalLabel ? ` | ${approvalLabel}` : ""}
                                  </Text>
                                </View>
                                <Text style={[styles.adminStatusText, { color: statusColor }]}>{statusLabel}</Text>
                              </View>
                            );
                          })
                        : null}
                    </View>
                  );
                })
              )}
            </View>
          </View>
          </>
        ) : (
          <>
        <View style={[styles.banner, { backgroundColor: banner.bg, borderColor: banner.border }]}>
          <Ionicons name={banner.icon as never} size={18} color={banner.text} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerText, { color: banner.text }]}>{banner.label}</Text>
            <Text style={[styles.bannerSubText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Route and battery tracking will start automatically after check-in."
                : isOfficeGeofenceAttendance
                  ? employeeDistanceLabel
                    ? `Office distance: ${employeeDistanceLabel}. Last GPS: ${lastStoredLocationLabel ?? "saving..."}.`
                    : lastStoredLocationLabel
                      ? `Last GPS: ${lastStoredLocationLabel}. Waiting for assigned office location.`
                      : "Waiting for assigned office location and live GPS."
                : "Live route and battery tracking starts immediately after device authentication."}
            </Text>
          </View>
          {gpsLoading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </View>
        {gpsEvidence ? (
          <Text style={[styles.gpsEvidenceText, { color: colors.textSecondary }]}>{gpsEvidence}</Text>
        ) : null}

        <View style={styles.statRow}>
          <View style={[styles.statCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.statValue, { color: colors.text }]}>{workingHours}</Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Today&apos;s Hours</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.statValue, { color: colors.text }]}>{zoneName}</Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Live Zone</Text>
          </View>
        </View>

        {showAttendanceOfficeAdminPanel ? (
          <View style={[styles.officePanel, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.officePanelHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.officePanelTitle, { color: colors.text }]}>Employee Office Geofence</Text>
                <Text style={[styles.officePanelMeta, { color: colors.textSecondary }]}>
                  {officeZone
                    ? `${officeZone.name} - ${officeZone.latitude.toFixed(5)}, ${officeZone.longitude.toFixed(5)} - ${officeZone.radiusMeters}m`
                    : "Search and save the company office location"}
                </Text>
              </View>
              <Ionicons name="business-outline" size={22} color={colors.primary} />
            </View>
            <View style={[styles.officeNameInputWrap, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="business-outline" size={18} color={colors.textTertiary} />
              <TextInput
                style={[styles.officeNameInput, { color: colors.text }]}
                placeholder="Office display name"
                placeholderTextColor={colors.textTertiary}
                value={officeLocationName}
                onChangeText={setOfficeLocationName}
                autoCorrect={false}
              />
            </View>
            <View style={styles.officeSearchRow}>
              <View style={[styles.officeSearchInputWrap, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary }]}>
                <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
                <TextInput
                  style={[styles.officeSearchInput, { color: colors.text }]}
                  placeholder="Search office, area, landmark..."
                  placeholderTextColor={colors.textTertiary}
                  value={officeSearchQuery}
                  onChangeText={setOfficeSearchQuery}
                  returnKeyType="search"
                  autoCorrect={false}
                  onSubmitEditing={() =>
                    void searchOfficeLocations(officeSearchQuery, {
                      showAlerts: true,
                      allowDeviceGeocode: true,
                    })
                  }
                />
              </View>
              <Pressable
                style={[
                  styles.officeSearchButton,
                  { backgroundColor: colors.primary, opacity: officeSearchBusy ? 0.72 : 1 },
                ]}
                onPress={() =>
                  void searchOfficeLocations(officeSearchQuery, {
                    showAlerts: true,
                    allowDeviceGeocode: true,
                  })
                }
                disabled={officeSearchBusy}
              >
                {officeSearchBusy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="search-outline" size={18} color="#fff" />
                )}
              </Pressable>
            </View>
            {officeSearchResults.length ? (
              <View style={[styles.officeResults, { borderColor: colors.borderLight }]}>
                {officeSearchResults.map((result, index) => (
                  <Pressable
                    key={`office_result_${result.id}_${result.latitude.toFixed(6)}_${result.longitude.toFixed(6)}_${index}`}
                    style={[
                      styles.officeResultRow,
                      index < officeSearchResults.length - 1 && { borderBottomColor: colors.borderLight, borderBottomWidth: 1 },
                    ]}
                    onPress={() => selectOfficeLocationDraft(result)}
                    disabled={officeSaving}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.officeResultTitle, { color: colors.text }]}>{result.label}</Text>
                      <Text style={[styles.officeResultMeta, { color: colors.textSecondary }]} numberOfLines={2}>
                        {result.address || `${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)}`}
                      </Text>
                    </View>
                    <Ionicons name="map-outline" size={20} color={colors.primary} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={[styles.officeMapWrap, { borderColor: colors.borderLight, backgroundColor: colors.surfaceSecondary }]}>
              {officeMapPlannedStops.length ? (
                <RouteMapNative
                  points={[]}
                  halts={[]}
                  plannedStops={officeMapPlannedStops}
                  colors={colors}
                  height={220}
                />
              ) : (
                <View style={styles.officeMapFallback}>
                  <Ionicons name="map-outline" size={28} color={colors.primary} />
                  <Text style={[styles.officeMapFallbackTitle, { color: colors.text }]}>
                    Select office location
                  </Text>
                  <Text style={[styles.officeMapFallbackText, { color: colors.textSecondary }]}>
                    Search a place or tap Current Location to preview it on the same map used by Sales AI.
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.officeActionRow}>
              <Pressable
                style={[
                  styles.officeSecondaryButton,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.backgroundElevated,
                    opacity: adminCurrentLocationBusy ? 0.72 : 1,
                  },
                ]}
                onPress={captureAdminCurrentLocation}
                disabled={adminCurrentLocationBusy}
              >
                {adminCurrentLocationBusy ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <>
                    <Ionicons name="locate-outline" size={18} color={colors.primary} />
                    <Text style={[styles.officeSecondaryButtonText, { color: colors.primary }]}>Current Location</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                style={[
                  styles.officeSetButton,
                  {
                    backgroundColor: colors.primary,
                    opacity: !officeLocationToSave || officeSaving ? 0.72 : 1,
                  },
                ]}
                onPress={() => {
                  if (officeLocationToSave) void saveOfficeLocation(officeLocationToSave);
                }}
                disabled={!officeLocationToSave || officeSaving}
              >
                {officeSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-outline" size={18} color="#fff" />
                    <Text style={styles.officeSetButtonText}>Set This Location</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        <Animated.View style={pulseStyle}>
          <Pressable
            disabled={actionLoading || permissionLoading || permissionExplainerOpen || !canSubmitAction}
            onPress={() => void submitAttendance(checkedInState ? "checkout" : "checkin")}
            style={({ pressed }) => [
              { opacity: pressed || actionLoading || !canSubmitAction ? 0.78 : 1 },
            ]}
          >
            <LinearGradient
              colors={
                !canSubmitAction
                  ? ["#94a3b8", "#64748b"]
                  : checkedInState
                  ? isDark
                    ? ["#7f1d1d", "#b91c1c"]
                    : ["#ef4444", "#dc2626"]
                  : isDark
                    ? ["#0b4f6c", "#1d4ed8"]
                    : [colors.heroStart, colors.heroEnd]
              }
              style={styles.actionButton}
            >
              {actionLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons
                    name={checkedInState ? "log-out-outline" : "log-in-outline"}
                    size={24}
                    color="#fff"
                  />
                  <Text style={styles.actionText}>{checkedInState ? "Secure Check-Out" : "Secure Check-In"}</Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>

        {!checkedInState && !canCheckIn ? (
          <Text style={[styles.helperWarning, { color: colors.danger }]}>
            {isOfficeGeofenceAttendance
              ? !employeeHasOfficeZone
                ? "Company office location is not configured yet. Ask admin to add office coordinates in Company creation."
                : "Move within 500m of the assigned office location to enable employee check-in."
              : "Wait for location to be ready, then verify with face unlock, fingerprint, or device PIN/password to complete secure check-in."}
          </Text>
        ) : null}
          </>
        )}

        {canReviewSignIns ? (
          <View style={styles.approvalSection}>
            <View style={styles.approvalHeaderRow}>
              <Text style={[styles.logsTitle, { color: colors.text, marginTop: 4, marginBottom: 0 }]}>
                Pending Sign-ins
              </Text>
              <View style={[styles.approvalCountChip, { backgroundColor: colors.warning + "1A" }]}>
                <Text style={[styles.approvalCountText, { color: colors.warning }]}>
                  {pendingSignIns.length}
                </Text>
              </View>
            </View>
            <View style={[styles.logList, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {pendingSignIns.length === 0 ? (
                <View style={styles.emptyLog}>
                  <Ionicons name="checkmark-done-outline" size={20} color={colors.success} />
                  <Text style={[styles.emptyLogText, { color: colors.textSecondary }]}>
                    No pending sign-in approvals.
                  </Text>
                </View>
              ) : (
                pendingSignIns.slice(0, 8).map((entry, idx) => {
                  const busy = approvalActionId === entry.id;
                  const locationLabel = entry.location
                    ? `${entry.location.lat.toFixed(5)}, ${entry.location.lng.toFixed(5)}`
                    : "Location unavailable";
                  return (
                    <View
                      key={`approval_${entry.id}`}
                      style={[
                        styles.approvalItemRow,
                        idx < Math.min(pendingSignIns.length, 8) - 1 && {
                          borderBottomWidth: 1,
                          borderBottomColor: colors.borderLight,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.logType, { color: colors.text }]}>{entry.userName}</Text>
                        <Text style={[styles.logMeta, { color: colors.textSecondary }]}>
                          {entry.geofenceName ?? locationLabel} -{" "}
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Text>
                      </View>
                      <View style={styles.approvalActionsRow}>
                        <Pressable
                          style={[
                            styles.approvalRejectButton,
                            { borderColor: colors.danger, opacity: busy ? 0.65 : 1 },
                          ]}
                          onPress={() => void handleSignInApproval(entry.id, "rejected")}
                          disabled={Boolean(approvalActionId)}
                        >
                          {busy ? (
                            <ActivityIndicator size="small" color={colors.danger} />
                          ) : (
                            <Text style={[styles.approvalRejectText, { color: colors.danger }]}>
                              Reject
                            </Text>
                          )}
                        </Pressable>
                        <Pressable
                          style={[
                            styles.approvalApproveButton,
                            { backgroundColor: colors.success, opacity: busy ? 0.65 : 1 },
                          ]}
                          onPress={() => void handleSignInApproval(entry.id, "approved")}
                          disabled={Boolean(approvalActionId)}
                        >
                          {busy ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={styles.approvalApproveText}>Accept</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </View>
        ) : null}

        {!isAdminAttendanceManager ? (
          <>
        <Text style={[styles.logsTitle, { color: colors.text }]}>{selectedDate === toMumbaiDateKey(new Date()) ? "Today's Log" : "Log for " + formatMumbaiDateKey(selectedDate)}</Text>
        <View style={[styles.logList, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          {records.length === 0 ? (
            <View style={styles.emptyLog}>
              <Ionicons name="time-outline" size={20} color={colors.textTertiary} />
              <Text style={[styles.emptyLogText, { color: colors.textSecondary }]}>No records yet today</Text>
            </View>
          ) : (
            records.slice(0, 8).map((entry, idx) => {
              const approvalState = entry.type === "checkin" ? entry.approvalStatus ?? "approved" : null;
              const approvalLabel =
                approvalState === "pending"
                  ? "Pending approval"
                  : approvalState === "rejected"
                    ? "Rejected"
                    : approvalState === "approved"
                      ? "Approved"
                      : null;
              return (
                <View
                  key={`attendance_record_${entry.id}_${idx}`}
                  style={[
                    styles.logRow,
                    idx < Math.min(records.length, 8) - 1 && { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
                  ]}
                >
                  <View
                    style={[
                      styles.logDot,
                      { backgroundColor: entry.type === "checkin" ? colors.success : colors.danger },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    {(() => {
                      const locationLabel = entry.location
                        ? `${entry.location.lat.toFixed(5)}, ${entry.location.lng.toFixed(5)}`
                        : "Location unavailable";
                      return (
                        <>
                          <Text style={[styles.logType, { color: colors.text }]}>
                            {entry.type === "checkin" ? "Check In" : "Check Out"}
                          </Text>
                          <Text style={[styles.logMeta, { color: colors.textSecondary }]}>
                            {entry.geofenceName ?? locationLabel} -{" "}
                            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            {approvalLabel ? ` | ${approvalLabel}` : ""}
                          </Text>
                        </>
                      );
                    })()}
                  </View>
                  <Ionicons
                    name={entry.isInsideGeofence ? "shield-checkmark" : "alert-circle"}
                    size={16}
                    color={entry.isInsideGeofence ? colors.success : colors.warning}
                  />
                </View>
              );
            })
          )}
        </View>
          </>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  dateNavContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    marginBottom: 16,
  },
  dateNavButton: {
    padding: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  dateNavLabelContainer: {
    flex: 1,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  dateNavLabel: {
    fontSize: 16,
    fontWeight: "700",
  },
  datePickerCard: {
    width: "92%",
    maxWidth: 460,
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    maxHeight: "88%",
  },
  datePickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  datePickerIconButton: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  datePickerTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  datePickerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: "500",
  },
  calendarWeekRow: {
    flexDirection: "row",
    marginBottom: 8,
  },
  calendarWeekText: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
  },
  calendarGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  calendarDayCell: {
    width: "13.4%",
    aspectRatio: 1,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  calendarDayText: {
    fontSize: 13,
    fontWeight: "700",
  },
  monthSummaryPanel: {
    marginTop: 14,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  monthSummaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  monthSummaryTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  monthSummaryRefresh: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  monthSummaryLoading: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  monthSummaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  monthSummaryChip: {
    flexGrow: 1,
    flexBasis: "47%",
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  monthSummaryValue: {
    fontSize: 17,
    fontWeight: "800",
  },
  monthSummaryLabel: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: "600",
  },
  monthSummaryMeta: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
  },
  monthUserRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  monthUserName: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "700",
  },
  monthUserMeta: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  datePickerCloseButton: {
    marginTop: 14,
    minHeight: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  datePickerCloseText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
  },
  pastDateNotice: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  pastDateNoticeText: {
    fontSize: 14,
    fontWeight: "500",
  },
  pastDateReturnButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  pastDateReturnButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 10,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 4,
    marginBottom: 14,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  banner: {
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    marginBottom: 12,
  },
  bannerText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  bannerSubText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 1,
  },
  gpsEvidenceText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: -6,
    marginBottom: 10,
  },
  adminNoticePanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  adminNoticeIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  adminNoticeTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    marginBottom: 3,
  },
  adminNoticeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  adminAttendanceSection: {
    marginBottom: 18,
  },
  adminAttendanceHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  refreshButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  adminSummaryRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  adminSummaryChip: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  adminSummaryValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  adminSummaryLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    marginTop: 2,
    textTransform: "uppercase",
  },
  companyAttendanceHeader: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  companyAttendanceTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  companyAttendanceMeta: {
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
    marginTop: 2,
  },
  companyAttendanceCount: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  adminAttendanceRow: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  adminStatusIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  adminAttendanceNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginBottom: 2,
  },
  adminRolePill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
  },
  adminStatusText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    textAlign: "right",
    maxWidth: 78,
  },
  statRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  statCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  statValue: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  statLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  officePanel: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 12,
    marginBottom: 14,
  },
  officePanelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  officePanelTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  officePanelMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 3,
  },
  officeNameInputWrap: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  officeNameInput: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    paddingVertical: 0,
  },
  officeSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  officeSearchInputWrap: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  officeSearchInput: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    paddingVertical: 0,
  },
  officeSearchButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  officeResults: {
    borderTopWidth: 1,
  },
  officeResultRow: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  officeResultTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  officeResultMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 2,
    lineHeight: 16,
  },
  officeMapWrap: {
    height: 220,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  officeMap: {
    flex: 1,
  },
  officeMapFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
  },
  officeMapFallbackTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    textAlign: "center",
  },
  officeMapFallbackText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },
  officeActionRow: {
    flexDirection: "row",
    gap: 8,
  },
  officeSecondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10,
  },
  officeSecondaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  officeSetButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10,
  },
  officeSetButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  officeButton: {
    minHeight: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
  },
  officeButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  actionButton: {
    borderRadius: 18,
    minHeight: 64,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    boxShadow: "0px 16px 30px rgba(0,0,0,0.18)",
  },
  actionText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  helperWarning: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: 10,
    marginBottom: 6,
  },
  approvalSection: {
    marginTop: 12,
    marginBottom: 4,
    gap: 10,
  },
  approvalHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  approvalCountChip: {
    minWidth: 34,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 9,
  },
  approvalCountText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  approvalItemRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  approvalActionsRow: {
    flexDirection: "row",
    gap: 8,
  },
  approvalRejectButton: {
    minWidth: 72,
    minHeight: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  approvalApproveButton: {
    minWidth: 72,
    minHeight: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  approvalRejectText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  approvalApproveText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  logsTitle: {
    marginTop: 16,
    marginBottom: 10,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  logList: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  logRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  logType: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  logMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 2,
  },
  emptyLog: {
    padding: 22,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  emptyLogText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 18,
    gap: 12,
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  modalText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  modalButton: {
    borderRadius: 12,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  modalRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  modalGhostButton: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalGhostText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
});
