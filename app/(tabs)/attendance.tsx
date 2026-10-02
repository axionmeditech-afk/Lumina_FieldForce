import * as Crypto from "expo-crypto";
import { isUsableLocationSample } from "@/lib/location-evidence";
import { useIsFocused } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Modal, ActivityIndicator, AppState, Alert, Linking, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import * as ExpoLocation from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LocationObject } from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { GeofenceMap, type GeofenceMapPoint } from "@/components/GeofenceMap";
import { evaluateAutoCheckoutExit, evaluateGeofenceStatus, formatDistance } from "@/lib/geofence";
import {
  addAttendance,
  addAttendanceAnomaly,
  getApiToken,
  getAttendance,
  getGeofences,
  getGeofencesForUser,
  getSettings,
  isCheckedIn,
  setCheckedIn,
  STORAGE_KEYS,
  subscribeStorageUpdates,
  updateAttendanceApproval,
  upsertGeofence,
} from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
import type { AppUser, AttendanceCheckPayload, AttendanceRecord, Employee, Geofence, GeofenceEvaluation } from "@/lib/types";
import { getAttendanceStatus, getCompanyAttendanceMonth, attendanceCheckIn, attendanceCheckOut, createGeofence as createGeofenceRemote, enqueueAttendanceAction, flushAttendanceQueue, getApiBaseUrlCandidates, getUserGeofences, getUsersRemote, getCompanyAttendanceToday, getCompanyProfilesRemote, removeQueuedAttendanceAction, searchMapplsAutosuggest, searchMapplsTextSearch, updateGeofence as updateGeofenceRemote, type DolibarrUser } from "@/lib/attendance-api";
import {
  ensureLocationServicesEnabled,
  getCurrentPositionWithTimeout,
  getLastKnownLocationSafe,
  getVerifiedLocationEvidence,
  getLocationPermissionSnapshot,
  isMockLocation,
  requestLocationPermissionBundle,
} from "@/lib/location-service";
import { verifyBiometricForAttendance } from "@/lib/biometric-attendance";
import {
  ensureAttendanceNotificationPermission,
  notifyAutoCheckoutPending,
  notifyAutoCheckoutSynced,
} from "@/lib/attendance-notifications";
import { toMumbaiDateKey, formatMumbaiDateKey, getMumbaiDateKeyByOffset } from "@/lib/ist-time";
import { startAttendanceGeofence, stopAttendanceGeofence, retryPendingAttendanceExit } from "@/lib/attendance-background";
import { getClientSecurityStatus } from "@/lib/security-client";
import { canReviewAttendanceSignIns, isSalesRole } from "@/lib/role-access";
import {
  dedupeAttendanceRosterMembers,
  isAttendanceRosterMember,
  isSystemAdministratorAccount,
} from "@/lib/attendance-roster";

const LOCATION_REFRESH_MS = 15 * 1000;
const STRICT_LOCATION_ACCURACY_METERS = 120;
const RELAXED_LOCATION_ACCURACY_METERS = 220;
const MIN_STABLE_LOCATION_SAMPLES = 2;
const STRICT_LOCATION_CACHE_MS = 45 * 1000;
const STRICT_LOCATION_WARMUP_MIN_INTERVAL_MS = 20 * 1000;
const STABLE_LOCATION_MAX_DRIFT_METERS = 90;
const AUTO_CHECKOUT_GRACE_MS = 30 * 1000;
const AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS = 2 * 60 * 1000;
const AUTO_CHECKOUT_MIN_SAMPLES = 2;
const OFFICE_ATTENDANCE_RADIUS_METERS = 500;
const OFFICE_LOCATION_SEARCH_LIMIT = 15;
const OFFICE_LOCATION_SEARCH_MIN_CHARS = 2;
const OFFICE_LOCATION_SEARCH_DEBOUNCE_MS = 400;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

const ADMIN_ATTENDANCE_REFRESH_MS = Math.max(30000, readPositiveIntegerEnv("EXPO_PUBLIC_ATTENDANCE_REFRESH_MS", 30000));

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
  attendanceRatePercent: number;
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

type AutoCheckoutClientSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  timestamp: number;
  distanceMeters: number;
};

function isRecordForCompany(record: AttendanceRecord | null | undefined, companyId: string): boolean {
  if (!record || !companyId) return true;
  return !record.companyId || record.companyId === companyId;
}

function selectCurrentWorkspaceGeofences(zones: Geofence[], companyId: string): Geofence[] {
  const activeZones = zones.filter((zone) => zone.isActive !== false);
  if (!companyId) return activeZones;
  const expectedOfficeId = `office_${companyId}`;
  return activeZones
    .filter((zone) => zone.companyId === companyId || zone.id === expectedOfficeId)
    .sort((a, b) => {
      if (a.id === expectedOfficeId && b.id !== expectedOfficeId) return -1;
      if (b.id === expectedOfficeId && a.id !== expectedOfficeId) return 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

function normalizeWorkspaceIds(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.map((value) => (value || "").trim()).filter(Boolean)));
}

async function resolveAttendanceWorkspaceIds(
  user: AppUser | null,
  activeCompanyId: string,
  includeAllWorkspaces: boolean,
): Promise<string[]> {
  const profileIds = normalizeWorkspaceIds([
    ...(Array.isArray(user?.companyIds) ? user?.companyIds || [] : []),
    user?.companyId,
  ]);
  const assignedIds = profileIds.length ? profileIds : normalizeWorkspaceIds([activeCompanyId]);
  if (includeAllWorkspaces && user?.role === "admin") {
    // Admins are the workspace owners for Secure Attendance. The companies
    // endpoint is authenticated and returns the complete workspace catalogue
    // for admins; include it so a newly created workspace appears immediately
    // without forcing the admin to re-login or manually assign themselves.
    const companies = await getCompanyProfilesRemote();
    return normalizeWorkspaceIds([
      ...assignedIds,
      ...companies.map((company) => company.id),
    ]);
  }
  return includeAllWorkspaces
    ? assignedIds
    : normalizeWorkspaceIds([activeCompanyId, user?.companyId]);
}

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
      label: isOfficeGeofence ? "Initializing geofence check..." : "Checking location...",
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
      label: "Location Verified",
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

function getAutoCheckoutSampleWindowMs(samples: AutoCheckoutClientSample[]): number {
  if (samples.length < 2) return 0;
  const timestamps = samples.map((sample) => sample.timestamp).sort((a, b) => a - b);
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

function getLatestAutoCheckoutSample(samples: AutoCheckoutClientSample[]): AutoCheckoutClientSample | null {
  return [...samples].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
}

function appendAutoCheckoutSample(
  current: AutoCheckoutClientSample[],
  sample: AutoCheckoutClientSample
): AutoCheckoutClientSample[] {
  const now = Date.now();
  const byKey = new Map<string, AutoCheckoutClientSample>();
  for (const item of current) {
    if (now - item.timestamp <= AUTO_CHECKOUT_MAX_SAMPLE_AGE_MS) {
      byKey.set(`${item.timestamp}:${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}`, item);
    }
  }
  byKey.set(`${sample.timestamp}:${sample.latitude.toFixed(6)}:${sample.longitude.toFixed(6)}`, sample);
  return Array.from(byKey.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-6);
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

function buildAttendanceUserIdAliases(value: string | null | undefined): Set<string> {
  const aliases = new Set<string>();
  const normalized = (value || "").trim();
  if (!normalized) return aliases;
  aliases.add(normalized);
  aliases.add(normalized.toLowerCase());
  if (/^\d+$/.test(normalized)) {
    aliases.add(`dolibarr_${normalized}`);
    aliases.add(`dolibarr_${normalized}`.toLowerCase());
  }
  const dolibarrMatch = normalized.match(/^dolibarr_(.+)$/i);
  const rawDolibarrId = dolibarrMatch?.[1]?.trim();
  if (rawDolibarrId) {
    aliases.add(rawDolibarrId);
    aliases.add(rawDolibarrId.toLowerCase());
  }
  return aliases;
}

function resolveCheckedInFromRecords(records: AttendanceRecord[], userId: string, userName?: string): boolean | null {
  const normalizedUserName = (userName || "").trim().toLowerCase();
  const userIdAliases = buildAttendanceUserIdAliases(userId);
  const latest = records
    .filter(
      (entry) =>
        userIdAliases.has((entry.userId || "").trim()) ||
        userIdAliases.has((entry.userId || "").trim().toLowerCase()) ||
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
    const groupKey = `id:${employee.id.replace(/^dolibarr_/, "")}`;
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
    let workMinutes = 0;
    for (const dateKey of dateKeys) {
      const entries = attendance.filter(
        (entry) =>
          toMumbaiDateKey(entry.timestamp) === dateKey &&
          Array.from(ids).some(id => id.replace(/^dolibarr_/, "") === entry.userId.replace(/^dolibarr_/, ""))
      );
      if (entries.some((entry) => entry.type === "checkin")) {
        presentDays += 1;
        presentUserDays += 1;
      }
      if (entries.some((entry) => entry.type === "checkout")) {
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
    attendanceRatePercent:
      totalExpectedUserDays > 0 ? Math.round((presentUserDays / totalExpectedUserDays) * 100) : 0,
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
      : user.role === "admin" || user.role === "manager" || user.role === "hr" || user.role === "employee"
        ? user.role
        : rawCategory === "fixed_location"
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
    department:
      role === "salesperson"
        ? "On Field Employees"
        : role === "admin"
          ? "Administration"
          : role === "manager"
            ? "Management"
            : role === "hr"
              ? "HR"
              : "Office Employees",
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

async function loadAttendanceRoster(fallbackCompany?: {
  id?: string;
  name?: string;
  allCompanies?: boolean;
  companyIds?: string[];
}): Promise<Employee[]> {
  // Keep a transport failure distinguishable from a valid empty roster. The
  // caller can then retain the last confirmed admin view instead of replacing
  // it with a misleading empty state during a short network outage.
  const users = await getUsersRemote(
    fallbackCompany?.allCompanies
      ? { allCompanies: true }
      : { companyId: fallbackCompany?.id },
  );
  const allowedCompanyIds = new Set((fallbackCompany?.companyIds || []).map((id) => id.trim()).filter(Boolean));
  // In all-workspace mode each API row already carries its authoritative
  // companyId. Do not pass the active workspace as a fallback, otherwise the
  // mapper would discard every employee assigned to another workspace.
  const mappingFallback = fallbackCompany?.allCompanies
    ? { name: fallbackCompany.name }
    : fallbackCompany;
  const userEmployees = users
    .map((entry) => mapAttendanceUserToEmployee(entry, mappingFallback))
    .filter((entry): entry is Employee => Boolean(entry))
    .filter((entry) => !allowedCompanyIds.size || allowedCompanyIds.has((entry.companyId || "").trim()));
  if (userEmployees.length > 0 || fallbackCompany?.allCompanies || fallbackCompany?.id) {
    // Authoritative roster: only users approved through this app's registration
    // flow should appear in Secure Attendance. Do not fall back to legacy cached
    // employees, because those can include demo/dummy Dolibarr records.
    return dedupeAttendanceRosterMembers(userEmployees);
  }

  const employees = await getEmployees().catch(() => [] as Employee[]);
  return dedupeAttendanceRosterMembers(
    employees.filter((employee) => !allowedCompanyIds.size || allowedCompanyIds.has((employee.companyId || "").trim())),
  );
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
    if (!employee.companyId || employee.companyId === "workspace_default") continue;
    const nameKey = normalizeAttendanceIdentity(employee.name);
    const companyKey = (employee.companyId || "workspace_default").trim() || "workspace_default";
    const groupKey = `company:${companyKey}:id:${employee.id.replace(/^dolibarr_/, "")}`;
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
          isRecordForCompany(entry, employee.companyId || "") &&
          Array.from(ids).some(id => id.replace(/^dolibarr_/, "") === entry.userId.replace(/^dolibarr_/, ""))
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
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let pongTimeout: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let connecting = false;
    let attempt = 0;

    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      clearHeartbeat();
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
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
          // Heartbeat: ping every 25s, expect pong within 10s
          heartbeatInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
              pongTimeout = setTimeout(() => {
                // No pong received — connection is stale, force reconnect
                ws?.close();
              }, 10000);
            }
          }, 25000);
          void loadBaseData();
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            // Clear pong timeout on any message (server is alive)
            if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
            if (data.type === "attendance_update") {
              void loadBaseData();
            }
          } catch (e) {
            console.error("WS parse error", e);
          }
        };

        ws.onclose = () => {
          clearTimeout(openTimeout);
          clearHeartbeat();
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
      clearHeartbeat();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; 
        ws.close();
      }
    };
  }, [isAdminOrManager, loadBaseData]);
}
// === WEBSOCKET HOOK DEFINITION END ===
type AttendanceScreenErrorBoundaryProps = {
  children: React.ReactNode;
  onReset: () => void;
};

type AttendanceScreenErrorBoundaryState = {
  error: Error | null;
};

class AttendanceScreenErrorBoundary extends React.PureComponent<
  AttendanceScreenErrorBoundaryProps,
  AttendanceScreenErrorBoundaryState
> {
  state: AttendanceScreenErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AttendanceScreenErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("Attendance screen recovered from a render error", error.message);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <AppCanvas>
        <View style={styles.recoveryWrap}>
          <View style={styles.recoveryCard}>
            <Ionicons name="shield-checkmark-outline" size={34} color="#2563EB" />
            <Text style={styles.recoveryTitle}>Attendance recovered safely</Text>
            <Text style={styles.recoveryText}>
              The page hit a temporary rendering issue. Your attendance data is safe. Tap retry to reload the screen.
            </Text>
            <Pressable style={styles.recoveryButton} onPress={this.reset}>
              <Text style={styles.recoveryButtonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </AppCanvas>
    );
  }
}

export default function AttendanceScreen() {
  const [screenKey, setScreenKey] = useState(0);
  return (
    <AttendanceScreenErrorBoundary onReset={() => setScreenKey((value) => value + 1)}>
      <AttendanceScreenContent key={screenKey} />
    </AttendanceScreenErrorBoundary>
  );
}

function AttendanceScreenContent() {
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
  const [geofenceLoadError, setGeofenceLoadError] = useState<string | null>(null);
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
  const attendanceSubmissionInProgressRef = useRef<"checkin" | "checkout" | null>(null);
  const activeAttendanceRef = useRef<AttendanceRecord | null>(null);
  const autoCheckoutSamplesRef = useRef<AutoCheckoutClientSample[]>([]);
  const autoCheckoutFirstOutsideAtRef = useRef<number | null>(null);
  const autoCheckoutInFlightRef = useRef(false);
  const [autoCheckoutStatus, setAutoCheckoutStatus] = useState<string | null>(null);
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
  const prevInsideRef = useRef(false);
  const latestEvidenceRef = useRef<{
    sampleCount: number;
    sampleWindowMs: number;
    bestAccuracyMeters: number | null;
  } | null>(null);
  const latestLocationRef = useRef<LocationObject | null>(null);
  const latestLocationCapturedAtMsRef = useRef<number>(0);
  const [lastStoredLocationLabel, setLastStoredLocationLabel] = useState<string | null>(null);
  const strictWarmupInFlightRef = useRef(false);
  const lastStrictWarmupAtRef = useRef(0);
  const officeSearchRequestIdRef = useRef(0);
  const loadBaseDataRequestRef = useRef(0);
  const loadInFlightRef = useRef(false);
  const reloadPendingRef = useRef(false);
  const latestLoadRef = useRef<(() => Promise<void>) | null>(null);
  const queuedLoadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rosterCacheRef = useRef<{ key: string; at: number; employees: Employee[] } | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  useEffect(() => { const sub = AppState.addEventListener("change", state => setAppActive(state === "active")); return () => sub.remove(); }, []);
  const canReviewSignIns = canReviewAttendanceSignIns(user?.role);
  const isFocused = useIsFocused();
  const activeUserId = user?.id || "";
  const activeUserName = user?.name || "";
  const activeCompanyId = company?.id || "";
  const activeCompanyName = company?.name || "";
  const isSuperAdminAttendanceExempt = user ? isSystemAdministratorAccount(user) : false;
  const isEmployeeOfficeAttendance = true;
  const isOfficeGeofenceAttendance = true;
  const isSalespersonFieldCheckIn = false;
  const isAdminAttendanceManager = user?.role === "admin";
  const showAttendanceOfficeAdminPanel = isAdminAttendanceManager;
  const todayHeading = "Today's Log";

  useEffect(() => {
    const timer = setInterval(() => setClockNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const openAppSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const rememberLatestLocation = useCallback((location: LocationObject | null) => {
    latestLocationRef.current = location;
    setLastStoredLocationLabel(
      location
        ? `${location.coords.latitude.toFixed(5)}, ${location.coords.longitude.toFixed(5)}`
        : null
    );
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
    if (!activeUserId || !isFocused || !appActive) return;
    if (loadInFlightRef.current) { reloadPendingRef.current = true; return; }
    loadInFlightRef.current = true;
    const requestId = ++loadBaseDataRequestRef.current;
    const companyId = activeCompanyId || undefined;
    try {
      const includeAllWorkspaces = isAdminAttendanceManager || canReviewSignIns;
      const workspaceIds = await resolveAttendanceWorkspaceIds(user, activeCompanyId, includeAllWorkspaces);
      const attendanceCompanyIds = includeAllWorkspaces ? workspaceIds : normalizeWorkspaceIds([companyId]);
      const rosterKey = `${activeUserId}:${includeAllWorkspaces ? attendanceCompanyIds.join("|") : companyId || ""}`;
      const cache = rosterCacheRef.current;
      const ROSTER_CACHE_TTL_MS = 120_000; // 2 minutes (was 5 min)
      const [status, companyAttendance, employees] = await Promise.all([
        getAttendanceStatus(selectedDate),
        isAdminAttendanceManager
          ? getCompanyAttendanceToday(undefined, selectedDate, true)
          : includeAllWorkspaces
          ? Promise.all(attendanceCompanyIds.map((id) => getCompanyAttendanceToday(id, selectedDate))).then((groups) => groups.flat())
          : Promise.resolve([]),
        isAdminAttendanceManager || canReviewSignIns
          ? cache?.key === rosterKey && Date.now() - cache.at < ROSTER_CACHE_TTL_MS
            ? Promise.resolve(cache.employees)
            : loadAttendanceRoster({
                id: companyId,
                name: activeCompanyName,
                allCompanies: includeAllWorkspaces,
                companyIds: attendanceCompanyIds,
              })
          : Promise.resolve([] as Employee[]),
      ]);
      if (requestId !== loadBaseDataRequestRef.current) return;
      const scopedRecords = activeCompanyId
        ? status.records.filter((record) => isRecordForCompany(record, activeCompanyId))
        : status.records;
      const scopedActive = isRecordForCompany(status.active, activeCompanyId) ? status.active : null;
      rosterCacheRef.current = { key: rosterKey, at: cache?.key === rosterKey && cache.employees === employees ? cache.at : Date.now(), employees };
      setRecords(scopedRecords);
      if (scopedActive) await AsyncStorage.removeItem(`@attendance_request:${activeUserId}:checkin`);
      else await AsyncStorage.removeItem(`@attendance_request:${activeUserId}:checkout`);
      activeAttendanceRef.current = scopedActive;
      if (!scopedActive) {
        autoCheckoutSamplesRef.current = [];
        autoCheckoutFirstOutsideAtRef.current = null;
        setAutoCheckoutStatus(null);
      }
      setCheckedInState(Boolean(scopedActive));
      await setCheckedIn(Boolean(scopedActive));
      if (isAdminAttendanceManager || canReviewSignIns) {
        setAdminAttendanceStatuses(buildAdminAttendanceStatuses(companyAttendance, employees, activeUserId, selectedDate));
      }
      setPendingSignIns([]);
      setDataError(null);
    } catch (error) {
      if (requestId === loadBaseDataRequestRef.current) setDataError(error instanceof Error ? error.message : "Attendance refresh failed. Showing last confirmed data.");
    } finally {
      loadInFlightRef.current = false;
      if (reloadPendingRef.current) {
        reloadPendingRef.current = false;
        queuedLoadTimer.current = setTimeout(() => { void latestLoadRef.current?.(); }, 500);
      }
    }
  }, [activeCompanyId, activeCompanyName, activeUserId, selectedDate, isAdminAttendanceManager, canReviewSignIns, isFocused, appActive, user]);

  useEffect(() => {
    latestLoadRef.current = loadBaseData;
    return () => { latestLoadRef.current = null; if (queuedLoadTimer.current) clearTimeout(queuedLoadTimer.current); };
  }, [loadBaseData]);
  useAttendanceWebSocket((isAdminAttendanceManager || canReviewSignIns) && isFocused && appActive, loadBaseData);
  // Smart polling: Admin/manager gets interval polling; employees only refresh on mount + foreground
  useEffect(() => {
    void loadBaseData();
    const needsPolling = isAdminAttendanceManager || canReviewSignIns;
    const timer = needsPolling
      ? setInterval(() => { void loadBaseData(); }, ADMIN_ATTENDANCE_REFRESH_MS)
      : null;
    return () => { ++loadBaseDataRequestRef.current; if (timer) clearInterval(timer); };
  }, [loadBaseData, isAdminAttendanceManager, canReviewSignIns]);
  // Event-driven reload on storage changes (replaces the wasteful 2s retry loop)
  useEffect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeStorageUpdates(event => {
      if (event.key === STORAGE_KEYS.EMPLOYEES) rosterCacheRef.current = null;
      if (event.key === STORAGE_KEYS.ATTENDANCE || event.key === STORAGE_KEYS.EMPLOYEES) {
        // Debounce: wait 500ms after last event before reloading
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { void loadBaseData(); }, 500);
      }
    });
    return () => { unsubscribe(); if (reloadTimer) clearTimeout(reloadTimer); };
  }, [loadBaseData]);

  const loadMonthlySummary = useCallback(
    async (monthKey = datePickerMonthKey) => {
      if (!isAdminAttendanceManager) return;
      setMonthlySummaryLoading(true);
      try {
        const companyId = activeCompanyId || undefined;
        const workspaceIds = await resolveAttendanceWorkspaceIds(user, activeCompanyId, true);
        const attendanceCompanyIds = workspaceIds.length ? workspaceIds : normalizeWorkspaceIds([companyId]);
        const [employees, recordsByDay] = await Promise.all([
          loadAttendanceRoster({
            id: companyId,
            name: activeCompanyName,
            allCompanies: true,
            companyIds: attendanceCompanyIds,
          }),
          getCompanyAttendanceMonth(undefined, monthKey, true),
        ]);
        setMonthlySummary(buildMonthlyAttendanceSummary(monthKey, recordsByDay, employees));
      } catch (error) {
        Alert.alert(
          "Monthly Summary Failed",
          error instanceof Error ? error.message : "Unable to load monthly attendance summary."
        );
      } finally {
        setMonthlySummaryLoading(false);
      }
    },
    [activeCompanyId, activeCompanyName, datePickerMonthKey, isAdminAttendanceManager, user]
  );

  useEffect(() => {
    if (!datePickerOpen || !isAdminAttendanceManager) return;
    const timer = setTimeout(() => {
      void loadMonthlySummary(datePickerMonthKey);
    }, 0);
    return () => clearTimeout(timer);
  }, [datePickerMonthKey, datePickerOpen, isAdminAttendanceManager, loadMonthlySummary]);

  const loadGeofenceAssignments = useCallback(async () => {
    if (!activeUserId) return;
    setGeofencesLoaded(false);
    setGeofenceLoadError(null);
    setGeofences([]);
    setEvaluation((current) => ({
      ...current,
      inside: false,
      insideConfirmed: false,
      activeZone: null,
      signalWeak: true,
      warning: "Loading current workspace office geofence",
    }));
    try {
      const cached = await getGeofencesForUser(activeUserId);
      const cachedForWorkspace = selectCurrentWorkspaceGeofences(cached, activeCompanyId);
      try {
        const zones = await getUserGeofences(activeUserId);
        for (const zone of zones) await upsertGeofence(zone);
        const zonesForWorkspace = selectCurrentWorkspaceGeofences(zones, activeCompanyId);
        setGeofences(zonesForWorkspace);

        if (zonesForWorkspace.length === 0 && cachedForWorkspace.length === 0) {
          setGeofenceLoadError(
            activeCompanyName
              ? `Office location for ${activeCompanyName} is not configured or not assigned to this employee yet.`
              : "Office location is not configured or not assigned to this employee yet."
          );
        }
        return;
      } catch (error) {
        setGeofenceLoadError(
          cachedForWorkspace.length > 0
            ? "Using saved office location because the latest assignment could not be loaded."
            : error instanceof Error
              ? error.message
              : "Office assignment could not be loaded."
        );
      }
      setGeofences(cachedForWorkspace);

    } catch (error) {
      setGeofences([]);
      setGeofenceLoadError(
        error instanceof Error ? error.message : "Office assignment could not be loaded."
      );
    } finally {
      setGeofencesLoaded(true);
    }
  }, [activeCompanyId, activeCompanyName, activeUserId]);

  const loadOfficeZone = useCallback(async () => {
    if (!activeCompanyId) return;
    const zones = await getGeofences();
    const expectedId = `office_${activeCompanyId}`;
    const currentOfficeZone =
      zones.find((zone) => zone.id === expectedId) ||
      zones.find((zone) => zone.companyId === activeCompanyId && zone.name === `${activeCompanyName} Main Office`) ||
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
  }, [activeCompanyId, activeCompanyName]);

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

  const clearForegroundAutoCheckout = useCallback((message: string | null = null) => {
    autoCheckoutSamplesRef.current = [];
    autoCheckoutFirstOutsideAtRef.current = null;
    setAutoCheckoutStatus(message);
  }, []);

  const submitAutoCheckout = useCallback(
    async (active: AttendanceRecord, zone: Geofence, samples: AutoCheckoutClientSample[]) => {
      if (!activeUserId || autoCheckoutInFlightRef.current) return;
      const latestSample = getLatestAutoCheckoutSample(samples);
      if (!latestSample) return;
      autoCheckoutInFlightRef.current = true;
      setAutoCheckoutStatus("Outside office confirmed. Auto-checkout is syncing...");
      const requestId = `auto_exit_${active.id}`;
      try {
        const security = await getClientSecurityStatus(false);
        const sampleWindowMs = Math.max(getAutoCheckoutSampleWindowMs(samples), AUTO_CHECKOUT_GRACE_MS);
        const payload: AttendanceCheckPayload = {
          requestId,
          actionSource: "geofence_exit",
          activeAttendanceId: active.id,
          userId: activeUserId,
          userName: activeUserName,
          latitude: latestSample.latitude,
          longitude: latestSample.longitude,
          geofenceId: zone.id,
          geofenceName: zone.name,
          photoBase64: null,
          photoMimeType: null,
          photoType: "checkout",
          deviceId: security.deviceId,
          isInsideGeofence: false,
          notes: `Automatic checkout: verified office exit in foreground | samples:${samples.length} | window:${Math.round(sampleWindowMs / 1000)}s | distance:${Math.round(latestSample.distanceMeters)}m`,
          mockLocationDetected: security.mockLocationSuspected,
          locationAccuracyMeters: latestSample.accuracyMeters,
          capturedAtClient: new Date(latestSample.timestamp).toISOString(),
          photoCapturedAt: null,
          geofenceDistanceMeters: latestSample.distanceMeters,
          faceDetected: false,
          faceCount: null,
          faceDetector: null,
          locationSampleCount: Math.max(AUTO_CHECKOUT_MIN_SAMPLES, samples.length),
          locationSampleWindowMs: sampleWindowMs,
          biometricRequired: false,
          biometricVerified: false,
          biometricType: null,
          biometricFailureReason: null,
        };
        await enqueueAttendanceAction("checkout", payload);
        const record = await attendanceCheckOut(payload);
        await removeQueuedAttendanceAction("checkout", requestId);
        await addAttendance(record);
        await setCheckedIn(false);
        await notifyAutoCheckoutSynced({ detectedAt: payload.capturedAtClient }).catch(() => undefined);
        activeAttendanceRef.current = null;
        setCheckedInState(false);
        clearForegroundAutoCheckout("Auto-checkout completed after leaving office geofence.");
        await stopAttendanceGeofence().catch(console.warn);
        void loadBaseData();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (error) {
        const latestSample = getLatestAutoCheckoutSample(samples);
        await notifyAutoCheckoutPending({
          detectedAt: latestSample ? new Date(latestSample.timestamp).toISOString() : new Date().toISOString(),
          distanceMeters: latestSample?.distanceMeters ?? null,
        }).catch(() => undefined);
        setAutoCheckoutStatus(
          error instanceof Error
            ? `Auto-checkout queued. Will retry when connection/session is ready. ${error.message}`
            : "Auto-checkout queued. Will retry when connection is ready."
        );
        void flushAttendanceQueue().then(loadBaseData).catch(() => undefined);
      } finally {
        autoCheckoutInFlightRef.current = false;
      }
    },
    [activeUserId, activeUserName, clearForegroundAutoCheckout, loadBaseData]
  );

  const processForegroundAutoCheckout = useCallback(
    async (location: LocationObject, nextEvaluation: GeofenceEvaluation) => {
      if (!checkedInState || !user?.id || isSuperAdminAttendanceExempt) {
        clearForegroundAutoCheckout(null);
        return;
      }
      const active = activeAttendanceRef.current;
      if (!active?.id) {
        setAutoCheckoutStatus("Auto-checkout is waiting for the latest check-in session.");
        return;
      }
      const zone =
        geofences.find((item) => item.id === active.geofenceId) ||
        nextEvaluation.activeZone ||
        geofences[0] ||
        null;
      if (!zone) {
        setAutoCheckoutStatus("Auto-checkout needs an assigned office geofence.");
        return;
      }
      if (isMockLocation(location)) {
        setAutoCheckoutStatus("Auto-checkout paused because mock location is detected.");
        return;
      }
      const decision = evaluateAutoCheckoutExit(
        zone,
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy ?? null
      );
      if (!decision.usable) {
        setAutoCheckoutStatus(
          decision.reason === "accuracy_too_weak"
            ? "Auto-checkout is waiting for better GPS accuracy."
            : "Auto-checkout is waiting for a fresh GPS fix."
        );
        return;
      }
      if (!decision.outside) {
        clearForegroundAutoCheckout("Auto-checkout armed while you are checked in.");
        return;
      }

      const sample: AutoCheckoutClientSample = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: decision.accuracyMeters ?? location.coords.accuracy ?? 0,
        timestamp: location.timestamp,
        distanceMeters: decision.distanceMeters,
      };
      const nextSamples = appendAutoCheckoutSample(autoCheckoutSamplesRef.current, sample);
      autoCheckoutSamplesRef.current = nextSamples;
      if (!autoCheckoutFirstOutsideAtRef.current) {
        autoCheckoutFirstOutsideAtRef.current = Date.now();
      }
      const elapsedMs = Date.now() - autoCheckoutFirstOutsideAtRef.current;
      const ready =
        nextSamples.length >= AUTO_CHECKOUT_MIN_SAMPLES &&
        (elapsedMs >= AUTO_CHECKOUT_GRACE_MS || nextSamples.length >= 3);
      const remainingSeconds = Math.max(0, Math.ceil((AUTO_CHECKOUT_GRACE_MS - elapsedMs) / 1000));
      setAutoCheckoutStatus(
        ready
          ? "Outside office confirmed. Auto-checkout is starting..."
          : `Outside office detected. Confirming for ${remainingSeconds}s (${nextSamples.length}/${AUTO_CHECKOUT_MIN_SAMPLES} GPS samples).`
      );
      if (ready) await submitAutoCheckout(active, zone, nextSamples);
    },
    [
      checkedInState,
      clearForegroundAutoCheckout,
      geofences,
      isSuperAdminAttendanceExempt,
      submitAutoCheckout,
      user?.id,
    ]
  );

  const handleLocationUpdate = useCallback(
    async (location: LocationObject) => {
      if (!user?.id) return;
      const effectiveLocation = applyAhmedabadOfficeLocationLock(location);
      if (!isUsableLocationSample(effectiveLocation, Date.now(), RELAXED_LOCATION_ACCURACY_METERS)) { setLocationReady(false); return; }
      rememberLatestLocation(effectiveLocation);
      latestLocationCapturedAtMsRef.current = effectiveLocation.timestamp;
      const nextEvaluation = evaluateGeofenceStatus(
        geofences,
        effectiveLocation.coords.latitude,
        effectiveLocation.coords.longitude,
        effectiveLocation.coords.accuracy ?? undefined
      );
      setEvaluation(nextEvaluation);
      setGpsLoading(false);
      setLocationReady(true);
      await processForegroundAutoCheckout(effectiveLocation, nextEvaluation);

      const shouldPrompt =
        isConfirmedInsideZone(nextEvaluation) &&
        !checkedInState &&
        !isSuperAdminAttendanceExempt &&
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
      isSuperAdminAttendanceExempt,
      processForegroundAutoCheckout,
      rememberLatestLocation,
      user?.id,
    ]
  );

  const refreshLocation = useCallback(
    async (strict = false) => {
      const enabled = await ensureLocationServicesEnabled();
      if (!enabled) {
        latestEvidenceRef.current = null;
        rememberLatestLocation(null);
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
        setGpsLoading(false);
        return null;
      }

      try {
        const evidence = await getVerifiedLocationEvidence({
          minAccuracyMeters: strict ? STRICT_LOCATION_ACCURACY_METERS : RELAXED_LOCATION_ACCURACY_METERS,
          maxAttempts: strict ? 10 : 5,
          requiredStableSamples: strict ? MIN_STABLE_LOCATION_SAMPLES : 1,
          maxDriftMeters: strict ? 50 : 100,
          sampleWaitMs: strict ? 900 : undefined,
          timeoutMs: strict ? 30_000 : undefined,
        });
        const effectiveLocation = applyAhmedabadOfficeLocationLock(evidence.location);
        const effectiveEvidence = {
          ...evidence,
          location: effectiveLocation,
        };
        latestEvidenceRef.current = {
          sampleCount: effectiveEvidence.sampleCount,
          sampleWindowMs: effectiveEvidence.sampleWindowMs,
          bestAccuracyMeters: effectiveEvidence.bestAccuracyMeters,
        };
        rememberLatestLocation(effectiveEvidence.location);
        latestLocationCapturedAtMsRef.current = effectiveEvidence.location.timestamp;
        setGpsEvidence(
          `GPS lock: ${effectiveEvidence.sampleCount} samples / ${Math.max(
            1,
            Math.round(effectiveEvidence.sampleWindowMs / 1000)
          )}s | best +/-${effectiveEvidence.bestAccuracyMeters ?? "?"}m | avg +/-${
            effectiveEvidence.averageAccuracyMeters ?? "?"
          }m`
        );
        await handleLocationUpdate(effectiveEvidence.location);
        return effectiveEvidence;
      } catch {
        if (strict) { latestEvidenceRef.current = null; return null; }
        let fallbackLocation: LocationObject | null = null;
        try {
          fallbackLocation = await getCurrentPositionWithTimeout(
            {
              accuracy: strict ? ExpoLocation.Accuracy.Balanced : ExpoLocation.Accuracy.Low,
              mayShowUserSettingsDialog: true,
            },
            5000
          );
        } catch {
          // fall through to last-known fallback
        }

        if (!fallbackLocation) {
          fallbackLocation = await getLastKnownLocationSafe({
            maxAgeMs: 20_000,
            requiredAccuracy: strict ? 450 : 1200,
          });
        }

        if (fallbackLocation && isUsableLocationSample(fallbackLocation, Date.now(), RELAXED_LOCATION_ACCURACY_METERS)) {
          const effectiveFallbackLocation = applyAhmedabadOfficeLocationLock(fallbackLocation);
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
          rememberLatestLocation(effectiveFallbackLocation);
          latestLocationCapturedAtMsRef.current = effectiveFallbackLocation.timestamp;
          setGpsEvidence(
            `GPS fallback: ${
              fallbackAccuracy !== null ? `+/-${fallbackAccuracy}m` : "accuracy unknown"
            }`
          );
          await handleLocationUpdate(effectiveFallbackLocation);
          return {
            location: effectiveFallbackLocation,
            sampleCount: 1,
            sampleWindowMs: 0,
            averageAccuracyMeters: fallbackAccuracy,
            bestAccuracyMeters: fallbackAccuracy,
          };
        }

        latestEvidenceRef.current = null;
        rememberLatestLocation(null);
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
        setGpsLoading(false);
        return null;
      }
    },
    [applyAhmedabadOfficeLocationLock, checkedInState, handleLocationUpdate, rememberLatestLocation, user]
  );

  useEffect(() => {
    if (!geofencesLoaded || !latestLocationRef.current) return;
    void handleLocationUpdate(latestLocationRef.current);
  }, [geofencesLoaded, geofences, handleLocationUpdate]);

  useEffect(() => {
    if (!activeUserId) return;
    const timer = setTimeout(() => {
      void loadGeofenceAssignments();
      if (isAdminAttendanceManager) {
        void loadOfficeZone();
      }
    }, 0);

    return () => clearTimeout(timer);
  }, [
    activeUserId,
    isAdminAttendanceManager,
    loadGeofenceAssignments,
    loadOfficeZone,
  ]);

  // Refresh the geofence preview only while this screen is visible and the app is active.
  useEffect(() => {
    if (!user?.id || !isFocused || permissionExplainerOpen || isSuperAdminAttendanceExempt) return;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || attendanceSubmissionInProgressRef.current || AppState.currentState !== "active") return;
      inFlight = true;
      try { await refreshLocation(); } finally { inFlight = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, LOCATION_REFRESH_MS);
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void refresh();
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [isFocused, isSuperAdminAttendanceExempt, permissionExplainerOpen, refreshLocation, user?.id]);

  useEffect(() => {
    if (!user?.id || !isFocused || !appActive) return;
    let cancelled = false;
    const flushQueuedAttendance = async () => {
      try {
        await flushAttendanceQueue();
        if (!cancelled) await loadBaseData();
      } catch {
        // Queue is best-effort; failed items stay stored for the next retry.
      }
    };
    void flushQueuedAttendance();
    const timer = setInterval(() => {
      void flushQueuedAttendance();
    }, 45_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [appActive, isFocused, loadBaseData, user?.id]);

  const requestPermissions = useCallback(async () => {
    setPermissionLoading(true);
    try {
      const locationPermission = await requestLocationPermissionBundle();
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

  const ensureAttendanceLocationPreflight = useCallback(async () => {
    const locationPermission = await requestLocationPermissionBundle();
    if (!locationPermission.foreground) {
      if (!locationPermission.foregroundCanAskAgain) {
        showPermissionBlockedAlert();
      } else {
        Alert.alert(
          "Location Required",
          "Allow precise location permission, then try attendance again."
        );
      }
      return false;
    }

    const gpsEnabled = await ensureLocationServicesEnabled();
    if (!gpsEnabled) {
      Alert.alert(
        "Turn On GPS",
        "Please enable device location services, keep the app open for a few seconds, then try again."
      );
      return false;
    }
    setPermissionExplainerOpen(false);
    return true;
  }, [showPermissionBlockedAlert]);

  const getFastAttendanceEvidence = useCallback(async () => {
    const cachedLocation = latestLocationRef.current;
    const cachedAgeMs = Date.now() - latestLocationCapturedAtMsRef.current;
    const cachedAccuracy =
      typeof cachedLocation?.coords.accuracy === "number" && Number.isFinite(cachedLocation.coords.accuracy)
        ? cachedLocation.coords.accuracy
        : Number.POSITIVE_INFINITY;

    if (cachedLocation && cachedAgeMs <= STRICT_LOCATION_CACHE_MS && cachedAccuracy <= STRICT_LOCATION_ACCURACY_METERS && (latestEvidenceRef.current?.sampleCount ?? 0) >= MIN_STABLE_LOCATION_SAMPLES) {
      const roundedAccuracy = Number.isFinite(cachedAccuracy) ? Math.round(cachedAccuracy) : null;
      return {
        location: cachedLocation,
        sampleCount: latestEvidenceRef.current?.sampleCount ?? 1,
        sampleWindowMs: latestEvidenceRef.current?.sampleWindowMs ?? 0,
        averageAccuracyMeters: latestEvidenceRef.current?.bestAccuracyMeters ?? roundedAccuracy,
        bestAccuracyMeters: latestEvidenceRef.current?.bestAccuracyMeters ?? roundedAccuracy,
      };
    }

    return refreshLocation(true);
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
      const timer = setTimeout(() => {
        setOfficeSearchResults([]);
        setOfficeSearchBusy(false);
      }, 0);
      return () => clearTimeout(timer);
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
      const permission = await requestLocationPermissionBundle();
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

      const { location: position } = await getVerifiedLocationEvidence({ minAccuracyMeters: 50, requiredStableSamples: 2, maxAttempts: 6 });
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
        label: officeLocationName.trim() || `${activeCompanyName || "Company"} Main Office`,
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
  }, [activeCompanyName, isAdminAttendanceManager, officeLocationName, showPermissionBlockedAlert]);

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

      try {
        if (officeZone?.id) {
          await updateGeofenceRemote(nextOfficeZone.id, nextOfficeZone);
        } else {
          await createGeofenceRemote(nextOfficeZone);
        }
      } catch (error) { throw error; }
      await upsertGeofence(nextOfficeZone);
      await loadGeofenceAssignments();
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
    loadGeofenceAssignments,
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

  const lastSubmitRequestIdRef = useRef<string | null>(null);
  const submitAttendance = useCallback(
    async (type: "checkin" | "checkout", options?: { isAuto?: boolean, silent?: boolean }) => {
      if (!user?.id) return;
      if (isSuperAdminAttendanceExempt) return;
      if (attendanceSubmissionInProgressRef.current !== null) return;
      if (type === "checkout" && !checkedInState) return;
      if (type === "checkin" && checkedInState) return;

      attendanceSubmissionInProgressRef.current = type;
      if (!options?.silent) setActionLoading(true);
      try {
        const isAuto = options?.isAuto === true;
        const biometricRequired = true;
        let biometricVerified = false;
        let biometricType: string | null = null;
        let biometricFailureReason: string | null = null;

        const locationReadyForAttendance = await ensureAttendanceLocationPreflight();
        if (!locationReadyForAttendance) {
          return;
        }

        const locationEvidencePromise = getFastAttendanceEvidence();
        const biometricPromise = biometricRequired
          ? verifyBiometricForAttendance(type, {
              userId: user.id,
              enforceDaily: false,
            })
          : Promise.resolve({
              success: true,
              method: null,
              errorMessage: null,
              errorCode: null,
            });

        const [preCaptureEvidence, biometricResult] = await Promise.all([
          locationEvidencePromise,
          biometricPromise,
        ]);
        if (!preCaptureEvidence) {
          if (!options?.silent) {
            Alert.alert(
              "Location Unavailable",
              "Unable to fetch a stable live GPS lock. Keep the app open, move near a window or open area, ensure Precise Location is enabled, then try again."
            );
          }
          return;
        }

        const securityPromise = getClientSecurityStatus(isMockLocation(preCaptureEvidence.location));

        if (biometricRequired) {
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

        // GPS freshness gate: accept only a fresh strict two-sample lock.
        const gpsCacheAgeMs = Date.now() - preCaptureEvidence.location.timestamp;
        const postCaptureEvidence = (
          isUsableLocationSample(preCaptureEvidence.location, Date.now(), STRICT_LOCATION_ACCURACY_METERS) &&
          gpsCacheAgeMs <= STRICT_LOCATION_CACHE_MS &&
          preCaptureEvidence.sampleCount >= MIN_STABLE_LOCATION_SAMPLES
        )
          ? preCaptureEvidence
          : await getVerifiedLocationEvidence({ requiredStableSamples: 2, maxAttempts: 6 });
        const postCaptureLocation = postCaptureEvidence.location;

        const finalEvaluation = evaluateGeofenceStatus(
          geofences,
          postCaptureLocation.coords.latitude,
          postCaptureLocation.coords.longitude,
          postCaptureLocation.coords.accuracy ?? undefined
        );
        if (type === "checkin" && (!geofences.length || !finalEvaluation.insideConfirmed || finalEvaluation.signalWeak)) {
          throw new Error("Move inside your assigned office geofence with a clear GPS signal to check in.");
        }
        if (isMockLocation(postCaptureLocation)) throw new Error("Disable mock location before marking attendance.");
        const finalZoneName = finalEvaluation.activeZone?.name ?? "Unassigned Zone";

        const security = await securityPromise;
        const capturedAtClient = new Date(postCaptureLocation.timestamp).toISOString();
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
        const thisRequestId = Crypto.randomUUID();
        // Client-side dedup: prevent re-submitting the same request
        if (lastSubmitRequestIdRef.current === thisRequestId) return;
        lastSubmitRequestIdRef.current = thisRequestId;
        const payload = {
          requestId: thisRequestId,
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
        } catch (error) {
          throw error;
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
        if (type === "checkout") {
          activeAttendanceRef.current = null;
          clearForegroundAutoCheckout(null);
          await stopAttendanceGeofence().catch(console.warn);
        } else {
          activeAttendanceRef.current = record;
          clearForegroundAutoCheckout("Auto-checkout armed while you are checked in.");
          await ensureAttendanceNotificationPermission(true).catch(() => false);
          const enabled = await startAttendanceGeofence(record, geofences, true).catch(() => false);
          if (!enabled) {
            Alert.alert(
              "Check-in saved",
              "Auto-checkout needs Always/Background location permission. Enable it from Account or Android App Settings so the app can check out while locked."
            );
          }
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

        }
      } catch (error) {
        if (!options?.silent) Alert.alert("Attendance Failed", error instanceof Error ? error.message : "Unknown error");
      } finally {
        attendanceSubmissionInProgressRef.current = null;
        if (!options?.silent) setActionLoading(false);
      }
    },
    [
      checkedInState,
      ensureAttendanceLocationPreflight,
      geofences,
      getFastAttendanceEvidence,
      isSalespersonFieldCheckIn,
      isSuperAdminAttendanceExempt,
      clearForegroundAutoCheckout,
      loadBaseData,
      openAppSettings,
      refreshLocation,
      user?.id,
      user?.name,
    ]
  );

  const handleSignInApproval = useCallback(
    async (attendanceId: string, status: "approved" | "rejected") => {
      if (!activeUserId || !canReviewSignIns) return;
      setApprovalActionId(attendanceId);
      try {
        const updated = await updateAttendanceApproval(attendanceId, status, {
          id: activeUserId,
          name: activeUserName,
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
    [activeUserId, activeUserName, canReviewSignIns, loadBaseData]
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
      minutes += (clockNowMs - checkInTime.getTime()) / 60000;
    }
    return `${Math.max(0, Math.floor(minutes / 60))}h ${Math.max(0, Math.floor(minutes % 60))}m`;
  }, [clockNowMs, records]);

  const employeeHasOfficeZone = !isOfficeGeofenceAttendance || geofences.length > 0;
  const employeeInsideOfficeZone = !isOfficeGeofenceAttendance || evaluation.insideConfirmed;
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
    ? "Office Geofence"
    : evaluation.activeZone?.name ??
      geofences[0]?.name ??
      (isOfficeGeofenceAttendance ? "Office not configured" : "No zone");
  const canCheckIn = locationReady && employeeHasOfficeZone && employeeInsideOfficeZone;
  const canSubmitAction =
    !isSuperAdminAttendanceExempt &&
    !dataError &&
    selectedDate === toMumbaiDateKey(new Date()) &&
    (checkedInState ? locationReady : canCheckIn);

  useEffect(() => {
    if (
      !user?.id ||
      !isFocused ||
      isSuperAdminAttendanceExempt ||
      permissionExplainerOpen ||
      !geofencesLoaded ||
      !employeeHasOfficeZone ||
      selectedDate !== toMumbaiDateKey(new Date())
    ) {
      return;
    }

    const warmStrictLocation = () => {
      if (attendanceSubmissionInProgressRef.current || AppState.currentState !== "active") return;
      const cachedLocation = latestLocationRef.current;
      const cachedAgeMs = Date.now() - latestLocationCapturedAtMsRef.current;
      const cachedAccuracy =
        typeof cachedLocation?.coords.accuracy === "number" && Number.isFinite(cachedLocation.coords.accuracy)
          ? cachedLocation.coords.accuracy
          : Number.POSITIVE_INFINITY;
      const hasFreshStrictEvidence =
        cachedLocation &&
        cachedAgeMs <= STRICT_LOCATION_CACHE_MS &&
        cachedAccuracy <= STRICT_LOCATION_ACCURACY_METERS &&
        (latestEvidenceRef.current?.sampleCount ?? 0) >= MIN_STABLE_LOCATION_SAMPLES;
      if (hasFreshStrictEvidence) return;
      if (strictWarmupInFlightRef.current) return;
      if (Date.now() - lastStrictWarmupAtRef.current < STRICT_LOCATION_WARMUP_MIN_INTERVAL_MS) return;

      strictWarmupInFlightRef.current = true;
      lastStrictWarmupAtRef.current = Date.now();
      void refreshLocation(true).finally(() => {
        strictWarmupInFlightRef.current = false;
      });
    };

    const timer = setTimeout(warmStrictLocation, 700);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") warmStrictLocation();
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [
    employeeHasOfficeZone,
    geofencesLoaded,
    isFocused,
    isSuperAdminAttendanceExempt,
    permissionExplainerOpen,
    refreshLocation,
    selectedDate,
    user?.id,
  ]);

  const employeeDistanceLabel =
    isOfficeGeofenceAttendance && Number.isFinite(evaluation.nearestDistanceMeters)
      ? formatDistance(evaluation.nearestDistanceMeters)
      : null;
  const adminCheckedInCount = adminAttendanceStatuses.filter((entry) => entry.status === "checked_in").length;
  const adminCheckedOutCount = adminAttendanceStatuses.filter((entry) => entry.status === "checked_out").length;
  const adminNoActivityCount = adminAttendanceStatuses.filter((entry) => entry.status === "no_activity").length;
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
      const timer = setTimeout(() => {
      setCollapsedAttendanceCompanyIds((current) => {
        const next = new Set(current);
        // Keep every workspace visible by default; only preserve explicit user collapses.
        next.delete(company.id);
        return next;
      });
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [company?.id, adminAttendanceGroups]);
  const officeMapPlannedStops = useMemo<GeofenceMapPoint[]>(() => {
    const stops: GeofenceMapPoint[] = [];
    if (officeLocationDraft) {
      const officeMarkerName = officeLocationName.trim() || officeLocationDraft.label;
      stops.push({
        id: "attendance_office_location",
        label: officeMarkerName,
        latitude: officeLocationDraft.latitude,
        longitude: officeLocationDraft.longitude,
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
        latitude: adminCurrentLocation.latitude,
        longitude: adminCurrentLocation.longitude,
        summary: "Your device GPS position",
        detail: adminCurrentLocation.address || `${adminCurrentLocation.latitude.toFixed(5)}, ${adminCurrentLocation.longitude.toFixed(5)}`,
      });
    }
    return stops;
  }, [adminCurrentLocation, officeLocationDraft, officeLocationName]);
  const officeLocationToSave = officeLocationDraft ?? adminCurrentLocation;

  return (
    <AppCanvas>
      <Modal
        visible={datePickerOpen}
        transparent
        statusBarTranslucent
        hardwareAccelerated
        animationType="fade"
        onRequestClose={() => setDatePickerOpen(false)}
      >
        <View style={[styles.modalOverlay, styles.datePickerOverlay]}>
          <View
            style={[
              styles.datePickerCard,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.border,
                marginBottom: Math.max(28, insets.bottom + 22),
              },
            ]}
          >
            {dataError ? <Pressable onPress={() => void loadBaseData()}><Text style={{ color: colors.danger, padding: 12 }}>Sync unavailable: {dataError} Tap to retry.</Text></Pressable> : null}
      <ScrollView
              style={styles.datePickerScroll}
              contentContainerStyle={styles.datePickerScrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
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
                      <Text style={[styles.monthSummaryValue, { color: colors.primary }]}>{monthlySummary.attendanceRatePercent}%</Text>
                      <Text style={[styles.monthSummaryLabel, { color: colors.textSecondary }]}>Attendance</Text>
                    </View>
                  </View>
                  <Text style={[styles.monthSummaryMeta, { color: colors.textSecondary }]}>
                    Counted {monthlySummary.countedDays} calendar day(s). Work hours are shown per user below.
                  </Text>
                  {monthlySummary.topRows.map((row) => (
                    <View key={`month_row_${row.id}`} style={[styles.monthUserRow, { borderTopColor: colors.borderLight }]}>
                      <View style={styles.monthUserTextWrap}>
                        <Text style={[styles.monthUserName, { color: colors.text }]} numberOfLines={1}>{row.name}</Text>
                        <Text style={[styles.monthUserMeta, { color: colors.textSecondary }]}>
                          Present {row.presentDays} | Absent {row.absentDays}
                        </Text>
                      </View>
                      <View style={[styles.monthWorkPill, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "44" }]}>
                        <Text style={[styles.monthWorkPillText, { color: colors.primary }]}>{formatWorkDuration(row.workMinutes)}</Text>
                      </View>
                    </View>
                  ))}
                </>
              ) : (
                <Text style={[styles.monthSummaryMeta, { color: colors.textSecondary }]}>Tap refresh to load summary.</Text>
              )}
            </View>
            ) : null}
            </ScrollView>

            <Pressable
              style={[styles.datePickerCloseButton, { backgroundColor: colors.primary }]}
              onPress={() => setDatePickerOpen(false)}
            >
              <Text style={styles.datePickerCloseText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={permissionExplainerOpen && !isSuperAdminAttendanceExempt} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Enable Secure Attendance</Text>
            <Text style={[styles.modalText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Tap Grant Permissions to allow location. Your location is used to verify attendance inside your assigned office."
                : isOfficeGeofenceAttendance
                  ? `Tap Grant Permissions to allow location. Check-in unlocks only within ${OFFICE_ATTENDANCE_RADIUS_METERS}m of the company office.`
                : "Tap Grant Permissions to allow location. Secure check-in uses face unlock, fingerprint, or device PIN/password verification and verifies your office location."}
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
            ? `${company?.name || "Company"} geofenced attendance`
            : isOfficeGeofenceAttendance
              ? `${company?.name || "Company"} office check-in within ${OFFICE_ATTENDANCE_RADIUS_METERS}m of assigned location`
            : `${company?.name || "Company"} secure geofenced attendance`}
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
        {selectedDate !== toMumbaiDateKey(new Date()) && !isSuperAdminAttendanceExempt ? (
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
                                <View style={styles.adminAttendanceSide}>
                                  <Text style={[styles.adminStatusText, { color: statusColor }]}>{statusLabel}</Text>
                                  <View style={[styles.adminWorkPill, { borderColor: colors.secondary + "44", backgroundColor: colors.secondary + "12" }]}>
                                    <Text style={[styles.adminWorkPillText, { color: colors.secondary }]}>
                                      {entry.workHoursLabel}
                                    </Text>
                                  </View>
                                </View>
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
        ) : null}

        {!isSuperAdminAttendanceExempt ? (
          <>
        <View style={[styles.banner, { backgroundColor: banner.bg, borderColor: banner.border }]}>
          <Ionicons name={banner.icon as never} size={18} color={banner.text} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerText, { color: banner.text }]}>{banner.label}</Text>
            <Text style={[styles.bannerSubText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Location is verified when you mark attendance."
                : isOfficeGeofenceAttendance
                  ? employeeDistanceLabel
                    ? `Office distance: ${employeeDistanceLabel}. Last GPS: ${lastStoredLocationLabel ?? "saving..."}.`
                    : geofences.length > 0
                      ? lastStoredLocationLabel
                        ? `Assigned office: ${geofences[0].name}. Last GPS: ${lastStoredLocationLabel}. Waiting for live GPS.`
                        : `Assigned office: ${geofences[0].name}. Waiting for live GPS.`
                    : lastStoredLocationLabel
                      ? `Last GPS: ${lastStoredLocationLabel}. Waiting for assigned office location.`
                      : "Waiting for assigned office location and live GPS."
                : "Your location is verified for attendance after device authentication."}
            </Text>
          </View>
          {gpsLoading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </View>
        {gpsEvidence ? (
          <Text style={[styles.gpsEvidenceText, { color: colors.textSecondary }]}>{gpsEvidence}</Text>
        ) : null}
        {checkedInState && autoCheckoutStatus ? (
          <View style={[styles.autoCheckoutStatus, { borderColor: colors.borderLight, backgroundColor: colors.surfaceSecondary }]}>
            <Ionicons name="navigate-circle-outline" size={16} color={colors.primary} />
            <Text style={[styles.autoCheckoutStatusText, { color: colors.textSecondary }]}>{autoCheckoutStatus}</Text>
          </View>
        ) : null}
        {geofenceLoadError ? (
          <Pressable
            onPress={() => void loadGeofenceAssignments()}
            disabled={!geofencesLoaded}
            style={[styles.geofenceErrorRow, { borderColor: colors.warning + "66" }]}
          >
            <Ionicons name="warning-outline" size={17} color={colors.warning} />
            <Text style={[styles.geofenceErrorText, { color: colors.textSecondary }]}>
              {geofenceLoadError}
            </Text>
            <Ionicons name="refresh-outline" size={18} color={colors.primary} />
          </Pressable>
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
                <GeofenceMap
                  points={officeMapPlannedStops}
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
                    Search a place or tap Current Location to preview it on the office map.
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

        <View>
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
        </View>

        {!checkedInState && !canCheckIn ? (
          <Text style={[styles.helperWarning, { color: colors.danger }]}>
            {isOfficeGeofenceAttendance
              ? !employeeHasOfficeZone
                ? geofenceLoadError || "Company office location is not configured yet. Ask admin to add office coordinates."
                : !locationReady
                  ? "Waiting for a current GPS fix. Check-in will enable after your live location is verified."
                  : "Move within 500m of the assigned office location to enable employee check-in."
              : "Wait for location to be ready, then verify with face unlock, fingerprint, or device PIN/password to complete secure check-in."}
          </Text>
        ) : null}
          </>
        ) : null}

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

        {!isSuperAdminAttendanceExempt ? (
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
  recoveryWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  recoveryCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    padding: 24,
    alignItems: "center",
    gap: 12,
    shadowColor: "#0F172A",
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 5,
  },
  recoveryTitle: {
    fontFamily: "Inter_800ExtraBold",
    fontSize: 20,
    color: "#0F172A",
    textAlign: "center",
  },
  recoveryText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
    color: "#475569",
    textAlign: "center",
  },
  recoveryButton: {
    marginTop: 4,
    borderRadius: 14,
    backgroundColor: "#2563EB",
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  recoveryButtonText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: "#FFFFFF",
  },
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
    width: "94%",
    maxWidth: 460,
    borderRadius: 20,
    borderWidth: 1,
    maxHeight: "78%",
    overflow: "hidden",
  },
  datePickerScroll: {
    flexGrow: 0,
  },
  datePickerScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  datePickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
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
    marginTop: 8,
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
    flexBasis: "30%",
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    minHeight: 72,
    justifyContent: "center",
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
  monthUserTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  monthUserName: {
    fontSize: 12.5,
    fontWeight: "700",
  },
  monthUserMeta: {
    fontSize: 11.5,
    fontWeight: "600",
  },
  monthWorkPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 76,
    alignItems: "center",
  },
  monthWorkPillText: {
    fontSize: 11.5,
    fontWeight: "800",
  },
  datePickerCloseButton: {
    marginHorizontal: 16,
    marginBottom: 12,
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
  autoCheckoutStatus: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: -4,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  autoCheckoutStatusText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
    lineHeight: 16,
  },
  geofenceErrorRow: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  geofenceErrorText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
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
  adminAttendanceSide: {
    alignItems: "flex-end",
    gap: 6,
  },
  adminWorkPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    minWidth: 62,
    alignItems: "center",
  },
  adminWorkPillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10.5,
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
  datePickerOverlay: {
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
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
