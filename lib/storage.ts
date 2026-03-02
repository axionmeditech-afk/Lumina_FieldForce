import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import type {
  AppUser,
  AppNotification,
  AttendanceRecord,
  Employee,
  SalaryRecord,
  Task,
  Expense,
  Conversation,
  AuditLog,
  Geofence,
  Team,
  AttendanceAnomaly,
  AttendancePhoto,
  LocationLog,
  DolibarrSyncLog,
  CompanyProfile,
  UserRole,
  SupportThread,
  SupportMessage,
  NotificationAudience,
  UserAccessRequest,
} from "./types";
import {
  demoUsers,
  demoPasswords,
  demoEmployees,
  demoAttendance,
  demoSalaries,
  demoTasks,
  demoExpenses,
  demoConversations,
  demoAuditLogs,
  demoGeofences,
  demoTeams,
  demoNotifications,
  demoSupportThreads,
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
} from "./seedData";
import { sendDeviceLocalNotification } from "./device-notifications";

const KEYS = {
  USER: "@trackforce_user",
  AUTH_USERS: "@trackforce_auth_users",
  COMPANIES: "@trackforce_companies",
  EMPLOYEES: "@trackforce_employees",
  ATTENDANCE: "@trackforce_attendance",
  SALARIES: "@trackforce_salaries",
  TASKS: "@trackforce_tasks",
  EXPENSES: "@trackforce_expenses",
  CONVERSATIONS: "@trackforce_conversations",
  AUDIT_LOGS: "@trackforce_audit_logs",
  SEEDED: "@trackforce_seeded",
  CHECKED_IN: "@trackforce_checked_in",
  SETTINGS: "@trackforce_settings",
  GEOFENCES: "@trackforce_geofences",
  TEAMS: "@trackforce_teams",
  ATTENDANCE_PHOTOS: "@trackforce_attendance_photos",
  ATTENDANCE_ANOMALIES: "@trackforce_attendance_anomalies",
  LOCATION_LOGS: "@trackforce_location_logs",
  DOLIBARR_SYNC_LOGS: "@trackforce_dolibarr_sync_logs",
  NOTIFICATIONS: "@trackforce_notifications",
  SUPPORT_THREADS: "@trackforce_support_threads",
  ACCESS_REQUESTS: "@trackforce_access_requests",
  ATTENDANCE_QUEUE: "@trackforce_attendance_queue",
  DEVICE_ID: "@trackforce_device_id",
  API_TOKEN: "@trackforce_api_token",
  SEED_VERSION: "@trackforce_seed_version",
};

const SEED_VERSION = "8";
const MAHAKANT_BRANCH_NAME = "Ahmedabad - Mahakant Complex";
const MAHAKANT_HEADQUARTERS =
  "Mahakant Complex, Paldi, Ashram Road, Ahmedabad, Gujarat, India";
const MAHAKANT_LATITUDE = 23.0252;
const MAHAKANT_LONGITUDE = 72.5713;
const MAHAKANT_GEOFENCE_RADIUS_METERS = 800;
const DHRUV_EMAIL = "ahmedabad@trackforce.ai";

type ThemePreference = "system" | "light" | "dark";
type CompanyScoped = { companyId?: string | null };
type CompanySettingsStore = Record<string, Record<string, string>>;
type SettingsSnapshot = Record<string, string>;
type SettingsListener = (settings: SettingsSnapshot) => void;
type StorageUpdateEvent = {
  key: string;
  updatedAt: string;
};
type StorageUpdateListener = (event: StorageUpdateEvent) => void;

const settingsListeners = new Set<SettingsListener>();
const storageUpdateListeners = new Set<StorageUpdateListener>();
let seedDataPromise: Promise<void> | null = null;

export const STORAGE_KEYS = { ...KEYS } as const;

function readTrimmedEnv(name: string): string {
  // eslint-disable-next-line expo/no-dynamic-env-var -- central helper intentionally resolves env keys by name
  const raw = process.env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

const GEMINI_KEY_FROM_ENV =
  readTrimmedEnv("EXPO_PUBLIC_GEMINI_API_KEY") ||
  readTrimmedEnv("GEMINI_API_KEY") ||
  readTrimmedEnv("EXPO_PUBLIC_GEMINI_API") ||
  readTrimmedEnv("GEMINI_API") ||
  readTrimmedEnv("gemini_API") ||
  readTrimmedEnv("gemini_APi");
const GEMINI_MODEL_FROM_ENV =
  readTrimmedEnv("EXPO_PUBLIC_GEMINI_MODEL") || readTrimmedEnv("GEMINI_MODEL");
const AI_ENV_DEFAULTS = {
  apiKey: GEMINI_KEY_FROM_ENV,
  model: GEMINI_MODEL_FROM_ENV || "gemini-2.5-flash",
  projectId: readTrimmedEnv("EXPO_PUBLIC_GEMINI_PROJECT_ID"),
};

const HUGGINGFACE_ENV_DEFAULTS = {
  apiKey:
    readTrimmedEnv("EXPO_PUBLIC_HUGGINGFACE_API_KEY") ||
    readTrimmedEnv("EXPO_PUBLIC_HF_API_KEY") ||
    readTrimmedEnv("EXPO_PUBLIC_HF_TOKEN") ||
    readTrimmedEnv("HUGGINGFACE_API_KEY") ||
    readTrimmedEnv("HUGGINGFACE_TOKEN"),
};

const BACKEND_ENV_DEFAULTS = {
  apiBaseUrl:
    readTrimmedEnv("EXPO_PUBLIC_API_URL") ||
    readTrimmedEnv("EXPO_PUBLIC_BACKEND_URL") ||
    readTrimmedEnv("EXPO_PUBLIC_DOMAIN"),
};

const DOLIBARR_ENV_DEFAULTS = {
  endpoint:
    readTrimmedEnv("EXPO_PUBLIC_DOLIBARR_ENDPOINT") || readTrimmedEnv("DOLIBARR_ENDPOINT"),
  apiKey:
    readTrimmedEnv("EXPO_PUBLIC_DOLIBARR_API_KEY") || readTrimmedEnv("DOLIBARR_API_KEY"),
};

const REMOTE_STATE_SYNC_DISABLED = readTrimmedEnv("EXPO_PUBLIC_REMOTE_STATE_SYNC") === "false";
const REMOTE_STATE_TIMEOUT_MS = 3200;
const REMOTE_STATE_ALLOWED_KEYS = new Set<string>([
  KEYS.COMPANIES,
  KEYS.EMPLOYEES,
  KEYS.ATTENDANCE,
  KEYS.SALARIES,
  KEYS.TASKS,
  KEYS.EXPENSES,
  KEYS.CONVERSATIONS,
  KEYS.AUDIT_LOGS,
  KEYS.SETTINGS,
  KEYS.GEOFENCES,
  KEYS.TEAMS,
  KEYS.ATTENDANCE_PHOTOS,
  KEYS.ATTENDANCE_ANOMALIES,
  KEYS.LOCATION_LOGS,
  KEYS.DOLIBARR_SYNC_LOGS,
  KEYS.NOTIFICATIONS,
  KEYS.SUPPORT_THREADS,
]);

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((value) => Number(value));
  if (octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function toApiBaseUrls(rawUrl: string): string[] {
  const cleaned = rawUrl.trim().replace(/\/+$/, "");
  if (!cleaned) return [];
  const hasProtocol = /^https?:\/\//i.test(cleaned);
  const normalizedInput = hasProtocol ? cleaned : `https://${cleaned}`;
  let parsed: URL;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    return [];
  }

  const isPrivateHost = isPrivateOrLocalHost(parsed.hostname);
  const pathWithoutSlash = parsed.pathname.replace(/\/+$/, "");
  const hasApiSuffix = /\/api$/i.test(pathWithoutSlash);
  const basePath = hasApiSuffix ? pathWithoutSlash : `${pathWithoutSlash || ""}/api`;
  const allowedProtocol =
    parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.protocol : "https:";
  const protocols: Array<"http:" | "https:"> = isPrivateHost
    ? ["http:", "https:"]
    : allowedProtocol === "http:"
      ? ["http:", "https:"]
      : ["https:", "http:"];

  const candidates = new Set<string>();
  for (const protocol of protocols) {
    const next = new URL(parsed.toString());
    next.protocol = protocol;
    next.pathname = basePath;
    next.search = "";
    next.hash = "";
    candidates.add(next.toString().replace(/\/+$/, ""));
  }
  return Array.from(candidates);
}

function getExpoLanApiBaseUrl(): string | null {
  const hostUriCandidates = [
    Constants.expoConfig?.hostUri,
    (Constants as any)?.expoGoConfig?.debuggerHost,
    (Constants as any)?.manifest?.debuggerHost,
    (Constants as any)?.manifest2?.extra?.expoGo?.debuggerHost,
  ];
  for (const hostUri of hostUriCandidates) {
    if (typeof hostUri !== "string" || !hostUri.trim()) continue;
    const host = hostUri.split(":")[0]?.trim();
    if (!host) continue;
    return `http://${host}:5000/api`;
  }
  return null;
}

function getRemoteStateApiCandidates(): string[] {
  const candidates = new Set<string>();
  const envUrl = BACKEND_ENV_DEFAULTS.apiBaseUrl;
  if (envUrl) {
    for (const apiBase of toApiBaseUrls(envUrl)) {
      candidates.add(apiBase);
    }
  }

  const expoLanBase = getExpoLanApiBaseUrl();
  if (expoLanBase) {
    candidates.add(expoLanBase);
  }

  candidates.add("http://localhost:5000/api");
  return Array.from(candidates);
}

function shouldSyncRemoteStateKey(key: string): boolean {
  if (REMOTE_STATE_SYNC_DISABLED) return false;
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
}

async function fetchStateRemote<T>(key: string): Promise<T | null | undefined> {
  const token = await getApiToken();
  if (!token) return undefined;
  const encodedKey = encodeURIComponent(key);

  for (const apiBase of getRemoteStateApiCandidates()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/state/${encodedKey}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) continue;
        return undefined;
      }
      const payload = (await response.json()) as { value?: unknown };
      return (payload.value ?? null) as T | null;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

async function pushStateRemote<T>(key: string, value: T): Promise<boolean> {
  const token = await getApiToken();
  if (!token) return false;
  const encodedKey = encodeURIComponent(key);
  const body = JSON.stringify({ value });

  for (const apiBase of getRemoteStateApiCandidates()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/state/${encodedKey}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

interface StoredAuthUser {
  user: AppUser;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  approvalStatus?: "pending" | "approved" | "rejected";
  requestedCompanyName?: string;
}

export interface RegisterUserInput {
  name: string;
  email: string;
  password: string;
  companyName: string;
  role?: UserRole;
  department?: string;
  branch?: string;
  phone?: string;
  industry?: string;
  headquarters?: string;
}

export interface RegisterUserResult {
  ok: boolean;
  message?: string;
  user?: AppUser;
  company?: CompanyProfile;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePhone(value?: string): string {
  const cleaned = normalizeWhitespace(value ?? "");
  return cleaned || "+91 00000 00000";
}

function normalizeRole(role?: UserRole): UserRole {
  if (role === "admin" || role === "hr" || role === "manager" || role === "salesperson") {
    return role;
  }
  return "salesperson";
}

function roleToDepartment(role: UserRole): string {
  if (role === "admin") return "Management";
  if (role === "hr") return "Human Resources";
  if (role === "manager") return "Operations";
  return "Sales";
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sanitizeCompanyName(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized || DEFAULT_COMPANY_NAME;
}

function normalizeCompanyIds(companyIds: string[] | undefined, fallbackCompanyId: string): string[] {
  const ids = Array.isArray(companyIds) ? companyIds : [];
  const normalized = ids
    .map((id) => normalizeWhitespace(id))
    .filter((id) => Boolean(id));
  if (!normalized.includes(fallbackCompanyId)) {
    normalized.unshift(fallbackCompanyId);
  }
  return Array.from(new Set(normalized));
}

function buildDefaultCompanyProfile(): CompanyProfile {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_COMPANY_ID,
    name: DEFAULT_COMPANY_NAME,
    legalName: "TrackForce AI Pvt Ltd",
    industry: "Enterprise Workforce Intelligence",
    headquarters: MAHAKANT_HEADQUARTERS,
    primaryBranch: MAHAKANT_BRANCH_NAME,
    supportEmail: "support@trackforce.ai",
    supportPhone: "+91 98765 43210",
    attendanceZoneLabel: MAHAKANT_BRANCH_NAME,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCompanyProfile(input: Partial<CompanyProfile>): CompanyProfile {
  const now = new Date().toISOString();
  const base = buildDefaultCompanyProfile();
  const name = sanitizeCompanyName(input.name ?? base.name);
  const generatedSlug = slugify(name) || "enterprise";
  return {
    id: input.id ?? makeId(`cmp_${generatedSlug}`),
    name,
    legalName: normalizeWhitespace(input.legalName ?? `${name} Pvt Ltd`) || `${name} Pvt Ltd`,
    industry: normalizeWhitespace(input.industry ?? base.industry) || base.industry,
    headquarters: normalizeWhitespace(input.headquarters ?? base.headquarters) || base.headquarters,
    primaryBranch: normalizeWhitespace(input.primaryBranch ?? base.primaryBranch) || base.primaryBranch,
    supportEmail: normalizeEmail(input.supportEmail ?? `support@${generatedSlug}.com`),
    supportPhone: normalizePhone(input.supportPhone ?? base.supportPhone),
    attendanceZoneLabel:
      normalizeWhitespace(input.attendanceZoneLabel ?? `${name} Attendance Zone`) ||
      `${name} Attendance Zone`,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function normalizeUserProfile(user: AppUser): AppUser {
  const companyId =
    normalizeWhitespace(user.companyId || user.companyIds?.[0] || DEFAULT_COMPANY_ID) ||
    DEFAULT_COMPANY_ID;
  const companyIds = normalizeCompanyIds(user.companyIds, companyId);
  const approvalStatus =
    user.approvalStatus === "pending" || user.approvalStatus === "rejected"
      ? user.approvalStatus
      : "approved";
  const managerId = normalizeWhitespace(user.managerId ?? "");
  const managerName = normalizeWhitespace(user.managerName ?? "");
  return {
    ...user,
    companyId,
    companyName: sanitizeCompanyName(user.companyName || DEFAULT_COMPANY_NAME),
    companyIds,
    name: normalizeWhitespace(user.name),
    email: normalizeEmail(user.email),
    department: normalizeWhitespace(user.department),
    branch: normalizeWhitespace(user.branch),
    phone: normalizePhone(user.phone),
    managerId: managerId || undefined,
    managerName: managerName || undefined,
    approvalStatus,
  };
}

function withCompanyId<T extends CompanyScoped>(item: T, companyId: string | null): T {
  if (!companyId || item.companyId) return item;
  return { ...item, companyId } as T;
}

function withDefaultCompanyId<T extends CompanyScoped>(items: T[]): T[] {
  return items.map((item) => withCompanyId(item, DEFAULT_COMPANY_ID));
}

function matchesCompany(item: CompanyScoped, companyId: string | null): boolean {
  if (!companyId) return true;
  if (!item.companyId) return true;
  return item.companyId === companyId;
}

async function getItem<T>(key: string): Promise<T | null> {
  const localRaw = await AsyncStorage.getItem(key);
  const localValue = localRaw ? (JSON.parse(localRaw) as T) : null;
  if (!shouldSyncRemoteStateKey(key)) {
    return localValue;
  }

  const remoteValue = await fetchStateRemote<T>(key);
  if (typeof remoteValue === "undefined") {
    return localValue;
  }

  if (remoteValue === null) {
    if (localValue !== null) {
      // Bootstrap remote state from first successful local value.
      void pushStateRemote(key, localValue);
    }
    return localValue;
  }

  const remoteRaw = JSON.stringify(remoteValue);
  if (remoteRaw !== localRaw) {
    await AsyncStorage.setItem(key, remoteRaw);
  }
  return remoteValue;
}

async function setItem<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
  if (shouldSyncRemoteStateKey(key)) {
    await pushStateRemote(key, value);
  }
  const event: StorageUpdateEvent = {
    key,
    updatedAt: new Date().toISOString(),
  };
  for (const listener of storageUpdateListeners) {
    try {
      listener(event);
    } catch {
      // Keep local write path resilient if one live update subscriber fails.
    }
  }
}

export function subscribeStorageUpdates(listener: StorageUpdateListener): () => void {
  storageUpdateListeners.add(listener);
  return () => {
    storageUpdateListeners.delete(listener);
  };
}

async function getRawList<T>(key: string): Promise<T[]> {
  return (await getItem<T[]>(key)) || [];
}

async function getActiveCompanyId(): Promise<string | null> {
  const currentUser = await getCurrentUser();
  return currentUser?.companyId ?? null;
}

async function getAuthUsersRaw(): Promise<StoredAuthUser[]> {
  return (await getItem<StoredAuthUser[]>(KEYS.AUTH_USERS)) || [];
}

async function setAuthUsersRaw(users: StoredAuthUser[]): Promise<void> {
  await setItem(KEYS.AUTH_USERS, users);
}

function normalizeAccessRequest(entry: UserAccessRequest): UserAccessRequest {
  const assignedManagerId = normalizeWhitespace(entry.assignedManagerId ?? "");
  const assignedManagerName = normalizeWhitespace(entry.assignedManagerName ?? "");
  const approvedRole = entry.approvedRole ? normalizeRole(entry.approvedRole) : null;
  return {
    ...entry,
    name: normalizeWhitespace(entry.name),
    email: normalizeEmail(entry.email),
    approvedRole,
    requestedDepartment: normalizeWhitespace(entry.requestedDepartment),
    requestedBranch: normalizeWhitespace(entry.requestedBranch),
    requestedCompanyName: entry.requestedCompanyName
      ? sanitizeCompanyName(entry.requestedCompanyName)
      : undefined,
    assignedCompanyIds: Array.from(
      new Set((entry.assignedCompanyIds || []).map((id) => normalizeWhitespace(id)).filter(Boolean))
    ),
    assignedManagerId: assignedManagerId || null,
    assignedManagerName: assignedManagerName || null,
  };
}

async function getAccessRequestsRaw(): Promise<UserAccessRequest[]> {
  const requests = (await getItem<UserAccessRequest[]>(KEYS.ACCESS_REQUESTS)) || [];
  return requests.map((entry) => normalizeAccessRequest(entry));
}

async function setAccessRequestsRaw(requests: UserAccessRequest[]): Promise<void> {
  await setItem(KEYS.ACCESS_REQUESTS, requests.map((entry) => normalizeAccessRequest(entry)));
}

async function ensureAccessRequestsSeeded(): Promise<void> {
  const existing = await getItem<UserAccessRequest[]>(KEYS.ACCESS_REQUESTS);
  if (!existing) {
    await setItem(KEYS.ACCESS_REQUESTS, []);
    return;
  }
  await setAccessRequestsRaw(existing);
}

async function hashPassword(password: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `trackforce::${password}`
  );
}

async function buildDemoAuthUsers(): Promise<StoredAuthUser[]> {
  const now = new Date().toISOString();
  const result: StoredAuthUser[] = [];
  for (const user of demoUsers) {
    const password = demoPasswords[user.email] ?? "demo123";
    const passwordHash = await hashPassword(password);
    result.push({
      user: normalizeUserProfile(user),
      passwordHash,
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved",
    });
  }
  return result;
}

async function ensureCompanyProfilesSeeded(): Promise<void> {
  const existing = (await getItem<CompanyProfile[]>(KEYS.COMPANIES)) || [];
  if (!existing.length) {
    await setItem(KEYS.COMPANIES, [buildDefaultCompanyProfile()]);
    return;
  }

  const normalized = existing.map((profile) => normalizeCompanyProfile(profile));
  const hasDefault = normalized.some((profile) => profile.id === DEFAULT_COMPANY_ID);
  if (!hasDefault) {
    normalized.unshift(buildDefaultCompanyProfile());
  }
  await setItem(KEYS.COMPANIES, normalized);
}

async function ensureAuthUsersSeeded(): Promise<void> {
  const existing = await getAuthUsersRaw();
  if (!existing.length) {
    await setAuthUsersRaw(await buildDemoAuthUsers());
    return;
  }

  const normalized: StoredAuthUser[] = [];
  for (const entry of existing) {
    const user = normalizeUserProfile(entry.user);
    let passwordHash = entry.passwordHash;
    if (!passwordHash) {
      const knownPassword = demoPasswords[user.email];
      passwordHash = await hashPassword(knownPassword ?? "changeme123");
    }
    normalized.push({
      user,
      passwordHash,
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || new Date().toISOString(),
      approvalStatus:
        entry.approvalStatus === "pending" || entry.approvalStatus === "rejected"
          ? entry.approvalStatus
          : "approved",
      requestedCompanyName: entry.requestedCompanyName
        ? sanitizeCompanyName(entry.requestedCompanyName)
        : undefined,
    });
  }
  await setAuthUsersRaw(normalized);
}

async function ensureCurrentUserShape(): Promise<void> {
  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (!currentUser) return;
  const normalized = normalizeUserProfile(currentUser);
  await setItem(KEYS.USER, normalized);
}

async function ensureSeedItems<T extends { id: string }>(key: string, items: T[]): Promise<void> {
  if (!items.length) return;
  const existing = (await getItem<T[]>(key)) || [];
  const existingIds = new Set(existing.map((entry) => entry.id));
  let changed = false;
  for (const item of items) {
    if (!existingIds.has(item.id)) {
      existing.push(item);
      changed = true;
    }
  }
  if (changed) {
    await setItem(key, existing);
  }
}

async function migrateCompanyIdOnCollection<T extends CompanyScoped>(key: string): Promise<void> {
  const existing = await getItem<T[]>(key);
  if (!existing || !existing.length) return;
  let changed = false;
  const migrated = existing.map((entry) => {
    if (entry.companyId) return entry;
    changed = true;
    return { ...entry, companyId: DEFAULT_COMPANY_ID };
  });
  if (changed) {
    await setItem(key, migrated);
  }
}

async function alignDhruvMahakantWorkspace(): Promise<void> {
  const now = new Date().toISOString();

  const companies = (await getItem<CompanyProfile[]>(KEYS.COMPANIES)) || [];
  if (companies.length) {
    let companyChanged = false;
    const nextCompanies = companies.map((company) => {
      if (company.id !== DEFAULT_COMPANY_ID) return company;
      const nextCompany = normalizeCompanyProfile({
        ...company,
        headquarters: MAHAKANT_HEADQUARTERS,
        primaryBranch: MAHAKANT_BRANCH_NAME,
        attendanceZoneLabel: MAHAKANT_BRANCH_NAME,
        updatedAt: now,
      });
      if (JSON.stringify(nextCompany) !== JSON.stringify(company)) {
        companyChanged = true;
      }
      return nextCompany;
    });
    if (companyChanged) {
      await setItem(KEYS.COMPANIES, nextCompanies);
      await propagateCompanyName(DEFAULT_COMPANY_ID, DEFAULT_COMPANY_NAME);
    }
  }

  const authUsers = await getAuthUsersRaw();
  if (authUsers.length) {
    let authChanged = false;
    const nextAuthUsers = authUsers.map((entry) => {
      if (normalizeEmail(entry.user.email) !== DHRUV_EMAIL) return entry;
      if (entry.user.branch === MAHAKANT_BRANCH_NAME) return entry;
      authChanged = true;
      return {
        ...entry,
        user: normalizeUserProfile({
          ...entry.user,
          branch: MAHAKANT_BRANCH_NAME,
        }),
        updatedAt: now,
      };
    });
    if (authChanged) {
      await setAuthUsersRaw(nextAuthUsers);
    }
  }

  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (
    currentUser &&
    normalizeEmail(currentUser.email) === DHRUV_EMAIL &&
    currentUser.branch !== MAHAKANT_BRANCH_NAME
  ) {
    await setItem(KEYS.USER, {
      ...currentUser,
      branch: MAHAKANT_BRANCH_NAME,
    });
  }

  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  if (employees.length) {
    let employeeChanged = false;
    const nextEmployees = employees.map((employee) => {
      const isDhruv = employee.id === "e11" || normalizeEmail(employee.email) === DHRUV_EMAIL;
      if (!isDhruv || employee.branch === MAHAKANT_BRANCH_NAME) return employee;
      employeeChanged = true;
      return {
        ...employee,
        branch: MAHAKANT_BRANCH_NAME,
      };
    });
    if (employeeChanged) {
      await setItem(KEYS.EMPLOYEES, nextEmployees);
    }
  }

  const geofences = await getRawList<Geofence>(KEYS.GEOFENCES);
  if (geofences.length) {
    let geofenceChanged = false;
    const nextGeofences = geofences.map((zone) => {
      const isDhruvZone =
        zone.id === "g4" ||
        zone.assignedEmployeeIds.includes("u5") ||
        zone.assignedEmployeeIds.includes("e11");
      if (!isDhruvZone) return zone;
      const nextAssigned = Array.from(new Set([...zone.assignedEmployeeIds, "u5", "e11"]));
      const nextZone: Geofence = {
        ...zone,
        name: MAHAKANT_BRANCH_NAME,
        latitude: MAHAKANT_LATITUDE,
        longitude: MAHAKANT_LONGITUDE,
        radiusMeters: Math.max(zone.radiusMeters || 0, MAHAKANT_GEOFENCE_RADIUS_METERS),
        assignedEmployeeIds: nextAssigned,
        isActive: true,
        updatedAt: now,
      };
      if (JSON.stringify(nextZone) !== JSON.stringify(zone)) {
        geofenceChanged = true;
      }
      return nextZone;
    });
    if (geofenceChanged) {
      await setItem(KEYS.GEOFENCES, nextGeofences);
    }
  }

  const attendance = await getRawList<AttendanceRecord>(KEYS.ATTENDANCE);
  if (attendance.length) {
    let attendanceChanged = false;
    const nextAttendance = attendance.map((entry) => {
      if (entry.id !== "a9") return entry;
      const currentLat = entry.location?.lat;
      const currentLng = entry.location?.lng;
      if (currentLat === MAHAKANT_LATITUDE && currentLng === MAHAKANT_LONGITUDE) {
        return entry;
      }
      attendanceChanged = true;
      return {
        ...entry,
        geofenceName: MAHAKANT_BRANCH_NAME,
        location: {
          lat: MAHAKANT_LATITUDE,
          lng: MAHAKANT_LONGITUDE,
        },
      };
    });
    if (attendanceChanged) {
      await setItem(KEYS.ATTENDANCE, nextAttendance);
    }
  }
}

async function runSeedMigrations(): Promise<void> {
  await ensureCompanyProfilesSeeded();
  await ensureAuthUsersSeeded();
  await ensureAccessRequestsSeeded();
  await ensureCurrentUserShape();

  const appliedVersion = await AsyncStorage.getItem(KEYS.SEED_VERSION);
  if (appliedVersion === SEED_VERSION) return;

  await Promise.all([
    ensureSeedItems(
      KEYS.EMPLOYEES,
      withDefaultCompanyId(demoEmployees.filter((employee) => employee.id === "e11"))
    ),
    ensureSeedItems(
      KEYS.ATTENDANCE,
      withDefaultCompanyId(demoAttendance.filter((record) => record.id === "a9"))
    ),
    ensureSeedItems(
      KEYS.AUDIT_LOGS,
      withDefaultCompanyId(demoAuditLogs.filter((log) => log.id === "al9"))
    ),
    ensureSeedItems(
      KEYS.GEOFENCES,
      withDefaultCompanyId(demoGeofences.filter((zone) => zone.id === "g4"))
    ),
    ensureSeedItems(KEYS.TEAMS, withDefaultCompanyId(demoTeams)),
    ensureSeedItems(KEYS.NOTIFICATIONS, withDefaultCompanyId(demoNotifications)),
    ensureSeedItems(KEYS.SUPPORT_THREADS, withDefaultCompanyId(demoSupportThreads)),
    migrateCompanyIdOnCollection<Employee>(KEYS.EMPLOYEES),
    migrateCompanyIdOnCollection<AttendanceRecord>(KEYS.ATTENDANCE),
    migrateCompanyIdOnCollection<SalaryRecord>(KEYS.SALARIES),
    migrateCompanyIdOnCollection<Task>(KEYS.TASKS),
    migrateCompanyIdOnCollection<Expense>(KEYS.EXPENSES),
    migrateCompanyIdOnCollection<Conversation>(KEYS.CONVERSATIONS),
    migrateCompanyIdOnCollection<AuditLog>(KEYS.AUDIT_LOGS),
    migrateCompanyIdOnCollection<Geofence>(KEYS.GEOFENCES),
    migrateCompanyIdOnCollection<Team>(KEYS.TEAMS),
    migrateCompanyIdOnCollection<AttendancePhoto>(KEYS.ATTENDANCE_PHOTOS),
    migrateCompanyIdOnCollection<AttendanceAnomaly>(KEYS.ATTENDANCE_ANOMALIES),
    migrateCompanyIdOnCollection<LocationLog>(KEYS.LOCATION_LOGS),
    migrateCompanyIdOnCollection<DolibarrSyncLog>(KEYS.DOLIBARR_SYNC_LOGS),
    migrateCompanyIdOnCollection<AppNotification>(KEYS.NOTIFICATIONS),
    migrateCompanyIdOnCollection<SupportThread>(KEYS.SUPPORT_THREADS),
  ]);
  await alignDhruvMahakantWorkspace();

  await AsyncStorage.setItem(KEYS.SEED_VERSION, SEED_VERSION);
}

async function seedDataIfNeededInternal(): Promise<void> {
  const seeded = await AsyncStorage.getItem(KEYS.SEEDED);
  if (seeded) {
    await runSeedMigrations();
    return;
  }

  const defaultCompanyProfile = buildDefaultCompanyProfile();
  const demoAuthUsers = await buildDemoAuthUsers();

  await Promise.all([
    setItem(KEYS.EMPLOYEES, withDefaultCompanyId(demoEmployees)),
    setItem(KEYS.ATTENDANCE, withDefaultCompanyId(demoAttendance)),
    setItem(KEYS.SALARIES, withDefaultCompanyId(demoSalaries)),
    setItem(KEYS.TASKS, withDefaultCompanyId(demoTasks)),
    setItem(KEYS.EXPENSES, withDefaultCompanyId(demoExpenses)),
    setItem(KEYS.CONVERSATIONS, withDefaultCompanyId(demoConversations)),
    setItem(KEYS.AUDIT_LOGS, withDefaultCompanyId(demoAuditLogs)),
    setItem(KEYS.GEOFENCES, withDefaultCompanyId(demoGeofences)),
    setItem(KEYS.TEAMS, withDefaultCompanyId(demoTeams)),
    setItem(KEYS.ATTENDANCE_PHOTOS, []),
    setItem(KEYS.ATTENDANCE_ANOMALIES, []),
    setItem(KEYS.LOCATION_LOGS, []),
    setItem(KEYS.DOLIBARR_SYNC_LOGS, []),
    setItem(KEYS.NOTIFICATIONS, withDefaultCompanyId(demoNotifications)),
    setItem(KEYS.SUPPORT_THREADS, withDefaultCompanyId(demoSupportThreads)),
    setItem(KEYS.ACCESS_REQUESTS, []),
    setItem(KEYS.ATTENDANCE_QUEUE, []),
    setItem(KEYS.COMPANIES, [defaultCompanyProfile]),
    setItem(KEYS.AUTH_USERS, demoAuthUsers),
  ]);

  await AsyncStorage.setItem(KEYS.SEEDED, "true");
  await runSeedMigrations();
}

export async function seedDataIfNeeded(): Promise<void> {
  if (!seedDataPromise) {
    seedDataPromise = seedDataIfNeededInternal().catch((error) => {
      seedDataPromise = null;
      throw error;
    });
  }
  await seedDataPromise;
}

export async function getCompanyProfiles(): Promise<CompanyProfile[]> {
  await ensureCompanyProfilesSeeded();
  return (await getItem<CompanyProfile[]>(KEYS.COMPANIES)) || [];
}

export async function getCompanyProfile(companyId: string): Promise<CompanyProfile | null> {
  const companies = await getCompanyProfiles();
  return companies.find((company) => company.id === companyId) || null;
}

export async function getCurrentCompanyProfile(): Promise<CompanyProfile | null> {
  const user = await getCurrentUser();
  if (!user) {
    const companies = await getCompanyProfiles();
    return companies[0] || null;
  }
  const active = await getCompanyProfile(user.companyId);
  if (active) return active;
  const accessible = await getCurrentUserCompanyProfiles();
  return accessible[0] || null;
}

export async function getCurrentUserCompanyProfiles(): Promise<CompanyProfile[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const companies = await getCompanyProfiles();
  if (user.role === "admin") {
    return companies;
  }
  const allowedCompanyIds = new Set(user.companyIds || [user.companyId]);
  return companies.filter((company) => allowedCompanyIds.has(company.id));
}

export async function switchCurrentUserCompany(companyId: string): Promise<AppUser | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const targetCompanyId = normalizeWhitespace(companyId);
  if (!targetCompanyId) return null;

  const allowedCompanyIds = new Set(user.companyIds || [user.companyId]);
  const isAdmin = user.role === "admin";
  if (!allowedCompanyIds.has(targetCompanyId) && !isAdmin) {
    return null;
  }

  const company = await getCompanyProfile(targetCompanyId);
  if (!company) return null;

  const nextCompanyIds = isAdmin
    ? Array.from(new Set([...(user.companyIds || []), targetCompanyId]))
    : normalizeCompanyIds(user.companyIds, targetCompanyId);

  const nextUser = normalizeUserProfile({
    ...user,
    companyId: company.id,
    companyName: company.name,
    companyIds: nextCompanyIds,
    branch: user.branch || company.primaryBranch,
  });
  await setItem(KEYS.USER, nextUser);

  const authUsers = await getAuthUsersRaw();
  let changed = false;
  const nextAuthUsers = authUsers.map((entry) => {
    if (normalizeEmail(entry.user.email) !== normalizeEmail(nextUser.email)) return entry;
    changed = true;
    return {
      ...entry,
      user: normalizeUserProfile({
        ...entry.user,
        companyId: company.id,
        companyName: company.name,
        companyIds: nextCompanyIds,
      }),
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) {
    await setAuthUsersRaw(nextAuthUsers);
  }

  return nextUser;
}

async function propagateCompanyName(companyId: string, companyName: string): Promise<void> {
  const users = await getAuthUsersRaw();
  let changed = false;
  const nextUsers = users.map((entry) => {
    if (entry.user.companyId !== companyId || entry.user.companyName === companyName) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      user: {
        ...entry.user,
        companyName,
      },
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) {
    await setAuthUsersRaw(nextUsers);
  }

  const current = await getItem<AppUser>(KEYS.USER);
  if (current?.companyId === companyId && current.companyName !== companyName) {
    await setItem(KEYS.USER, { ...current, companyName });
  }
}

export async function updateCompanyProfile(
  companyId: string,
  updates: Partial<Omit<CompanyProfile, "id" | "createdAt" | "updatedAt">>
): Promise<CompanyProfile | null> {
  const companies = await getCompanyProfiles();
  const idx = companies.findIndex((company) => company.id === companyId);
  if (idx === -1) return null;

  const current = companies[idx];
  const next: CompanyProfile = normalizeCompanyProfile({
    ...current,
    ...updates,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  });
  companies[idx] = next;
  await setItem(KEYS.COMPANIES, companies);
  if (current.name !== next.name) {
    await propagateCompanyName(companyId, next.name);
  }
  return next;
}

export async function createCompanyProfile(
  input: Partial<Omit<CompanyProfile, "id" | "createdAt" | "updatedAt">> & { name: string }
): Promise<CompanyProfile | null> {
  await seedDataIfNeeded();
  const name = sanitizeCompanyName(input.name);
  if (!name) return null;

  const companies = await getCompanyProfiles();
  const existing = companies.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    return existing;
  }

  const created = normalizeCompanyProfile({
    ...input,
    id: makeId(`cmp_${slugify(name) || "enterprise"}`),
    name,
    legalName: normalizeWhitespace(input.legalName ?? `${name} Pvt Ltd`) || `${name} Pvt Ltd`,
    headquarters: normalizeWhitespace(input.headquarters ?? "") || "India",
    primaryBranch: normalizeWhitespace(input.primaryBranch ?? "") || "Main Branch",
    supportEmail:
      normalizeEmail(input.supportEmail ?? `support@${slugify(name) || "enterprise"}.com`) ||
      `support@${slugify(name) || "enterprise"}.com`,
    supportPhone: normalizePhone(input.supportPhone),
    attendanceZoneLabel:
      normalizeWhitespace(input.attendanceZoneLabel ?? `${name} Attendance Zone`) ||
      `${name} Attendance Zone`,
  });

  await setItem(KEYS.COMPANIES, [created, ...companies]);

  // If current user is admin, automatically grant access to newly created company environment.
  const currentUser = await getCurrentUser();
  if (currentUser?.role === "admin") {
    const nextCompanyIds = Array.from(new Set([...(currentUser.companyIds || []), created.id]));
    const nextUser = normalizeUserProfile({
      ...currentUser,
      companyIds: nextCompanyIds,
    });
    await setItem(KEYS.USER, nextUser);

    const authUsers = await getAuthUsersRaw();
    let authChanged = false;
    const nextAuthUsers = authUsers.map((entry) => {
      if (normalizeEmail(entry.user.email) !== normalizeEmail(nextUser.email)) return entry;
      authChanged = true;
      return {
        ...entry,
        user: normalizeUserProfile({
          ...entry.user,
          companyIds: nextCompanyIds,
        }),
        updatedAt: new Date().toISOString(),
      };
    });
    if (authChanged) {
      await setAuthUsersRaw(nextAuthUsers);
    }

    await upsertEmployeeForCompany(
      normalizeUserProfile({
        ...nextUser,
        companyId: created.id,
        companyName: created.name,
        branch: nextUser.branch || created.primaryBranch,
      }),
      created
    );
  }

  return created;
}

async function upsertEmployeeForCompany(user: AppUser, company: CompanyProfile): Promise<void> {
  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  const existingIndex = employees.findIndex(
    (employee) =>
      employee.companyId === company.id &&
      normalizeEmail(employee.email) === normalizeEmail(user.email)
  );

  const baseEmployee: Employee = {
    id: existingIndex >= 0 ? employees[existingIndex].id : makeId("e"),
    companyId: company.id,
    name: user.name,
    role: user.role,
    department: user.department,
    status: "active",
    email: user.email,
    phone: user.phone,
    branch: user.branch || company.primaryBranch,
    joinDate: user.joinDate,
    avatar: user.avatar,
    managerId: user.managerId,
    managerName: user.managerName,
  };

  if (existingIndex >= 0) {
    employees[existingIndex] = baseEmployee;
  } else {
    employees.unshift(baseEmployee);
  }
  await setItem(KEYS.EMPLOYEES, employees);
}

export async function registerUser(input: RegisterUserInput): Promise<RegisterUserResult> {
  await seedDataIfNeeded();

  const name = normalizeWhitespace(input.name);
  const email = normalizeEmail(input.email);
  const password = input.password;
  const requestedCompanyName = sanitizeCompanyName(input.companyName);

  if (!name) {
    return { ok: false, message: "Name is required" };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: "Valid email is required" };
  }
  if (!password || password.length < 6) {
    return { ok: false, message: "Password must be at least 6 characters" };
  }

  const authUsers = await getAuthUsersRaw();
  const alreadyExists = authUsers.some((entry) => normalizeEmail(entry.user.email) === email);
  if (alreadyExists) {
    return { ok: false, message: "User already exists for this email" };
  }

  const role = normalizeRole(input.role);
  if (role === "admin") {
    return { ok: false, message: "Admin signup is disabled. Contact an existing admin." };
  }
  const now = new Date().toISOString();
  const companies = await getCompanyProfiles();
  const fallbackCompany = companies[0] || buildDefaultCompanyProfile();

  const pendingUser = normalizeUserProfile({
    id: makeId("u"),
    name,
    email,
    role,
    companyId: fallbackCompany.id,
    companyName: fallbackCompany.name,
    companyIds: [fallbackCompany.id],
    department: normalizeWhitespace(input.department ?? "") || roleToDepartment(role),
    branch: normalizeWhitespace(input.branch ?? "") || fallbackCompany.primaryBranch,
    phone: normalizePhone(input.phone),
    joinDate: now.slice(0, 10),
    approvalStatus: "pending",
  });

  authUsers.unshift({
    user: pendingUser,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
    approvalStatus: "pending",
    requestedCompanyName,
  });
  await setAuthUsersRaw(authUsers);

  const accessRequests = await getAccessRequestsRaw();
  accessRequests.unshift({
    id: makeId("access"),
    name: pendingUser.name,
    email: pendingUser.email,
    requestedRole: pendingUser.role,
    approvedRole: null,
    requestedDepartment: pendingUser.department,
    requestedBranch: pendingUser.branch,
    requestedCompanyName,
    status: "pending",
    requestedAt: now,
    reviewedAt: null,
    reviewedById: null,
    reviewedByName: null,
    reviewComment: null,
    assignedCompanyIds: [],
    assignedManagerId: null,
    assignedManagerName: null,
  });
  await setAccessRequestsRaw(accessRequests);

  return {
    ok: true,
    message: "Signup request submitted. Wait for admin approval before signing in.",
  };
}

export async function getUserAccessRequests(
  status?: UserAccessRequest["status"]
): Promise<UserAccessRequest[]> {
  await seedDataIfNeeded();
  const requests = await getAccessRequestsRaw();
  const filtered = status ? requests.filter((entry) => entry.status === status) : requests;
  return filtered.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function reviewUserAccessRequest(
  requestId: string,
  action: "approved" | "rejected",
  reviewer: { id: string; name: string },
  options?: {
    companyIds?: string[];
    comment?: string;
    managerId?: string;
    managerName?: string;
    role?: UserRole;
  }
): Promise<UserAccessRequest | null> {
  await seedDataIfNeeded();
  const requests = await getAccessRequestsRaw();
  const requestIndex = requests.findIndex((entry) => entry.id === requestId);
  if (requestIndex < 0) return null;

  const currentRequest = requests[requestIndex];
  if (currentRequest.status !== "pending") {
    return currentRequest;
  }

  const now = new Date().toISOString();
  const normalizedCompanyIds = Array.from(
    new Set((options?.companyIds || []).map((id) => normalizeWhitespace(id)).filter(Boolean))
  );
  const approvedRole =
    action === "approved"
      ? normalizeRole(options?.role || currentRequest.requestedRole)
      : null;
  const finalApprovedRole = approvedRole || currentRequest.requestedRole;
  const normalizedManagerId = normalizeWhitespace(options?.managerId ?? "");
  const normalizedManagerName = normalizeWhitespace(options?.managerName ?? "");
  if (action === "approved" && normalizedCompanyIds.length === 0) {
    throw new Error("Select at least one company before approval.");
  }

  const authUsers = await getAuthUsersRaw();
  const authIndex = authUsers.findIndex(
    (entry) => normalizeEmail(entry.user.email) === normalizeEmail(currentRequest.email)
  );
  if (authIndex < 0) {
    throw new Error("User account request is missing. Ask the user to sign up again.");
  }

  const companies = await getCompanyProfiles();
  const companyById = new Map(companies.map((entry) => [entry.id, entry]));
  if (action === "approved") {
    for (const companyId of normalizedCompanyIds) {
      if (!companyById.has(companyId)) {
        throw new Error("One or more selected companies are invalid.");
      }
    }
  }

  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  const selectedManager = normalizedManagerId
    ? employees.find(
        (employee) => employee.id === normalizedManagerId && employee.role === "manager"
      ) || null
    : null;
  if (action === "approved" && normalizedManagerId && !selectedManager) {
    throw new Error("Selected manager is invalid.");
  }
  if (
    action === "approved" &&
    normalizedManagerId &&
    selectedManager &&
    normalizedCompanyIds.length > 0 &&
    !normalizedCompanyIds.includes(selectedManager.companyId)
  ) {
    throw new Error("Selected manager must belong to an assigned company.");
  }
  const needsManagerAssignment = approvedRole === "salesperson";
  if (action === "approved" && needsManagerAssignment && !normalizedManagerId) {
    throw new Error("Select a reporting manager before approval.");
  }
  const assignedManagerId = action === "approved" ? normalizedManagerId || null : null;
  const assignedManagerName =
    action === "approved"
      ? selectedManager?.name || normalizedManagerName || null
      : null;

  const currentAuth = authUsers[authIndex];
  if (action === "approved") {
    const primaryCompany = companyById.get(normalizedCompanyIds[0])!;
    const approvedUser = normalizeUserProfile({
      ...currentAuth.user,
      role: finalApprovedRole,
      department: roleToDepartment(finalApprovedRole),
      companyId: primaryCompany.id,
      companyName: primaryCompany.name,
      companyIds: normalizedCompanyIds,
      branch: currentAuth.user.branch || primaryCompany.primaryBranch,
      managerId: assignedManagerId || undefined,
      managerName: assignedManagerName || undefined,
      approvalStatus: "approved",
    });
    authUsers[authIndex] = {
      ...currentAuth,
      user: approvedUser,
      approvalStatus: "approved",
      updatedAt: now,
      requestedCompanyName: currentRequest.requestedCompanyName,
    };
    await setAuthUsersRaw(authUsers);

    for (const companyId of normalizedCompanyIds) {
      const company = companyById.get(companyId)!;
      await upsertEmployeeForCompany(
        normalizeUserProfile({
          ...approvedUser,
          companyId: company.id,
          companyName: company.name,
          branch: approvedUser.branch || company.primaryBranch,
        }),
        company
      );
    }

    const activeUser = await getItem<AppUser>(KEYS.USER);
    if (activeUser && normalizeEmail(activeUser.email) === normalizeEmail(approvedUser.email)) {
      await setItem(KEYS.USER, approvedUser);
    }
  } else {
    authUsers[authIndex] = {
      ...currentAuth,
      user: normalizeUserProfile({
        ...currentAuth.user,
        approvalStatus: "rejected",
      }),
      approvalStatus: "rejected",
      updatedAt: now,
    };
    await setAuthUsersRaw(authUsers);
  }

  const reviewedRequest: UserAccessRequest = {
    ...currentRequest,
    approvedRole,
    status: action,
    reviewedAt: now,
    reviewedById: reviewer.id,
    reviewedByName: reviewer.name,
    reviewComment: options?.comment?.trim() || null,
    assignedCompanyIds: action === "approved" ? normalizedCompanyIds : [],
    assignedManagerId,
    assignedManagerName,
  };
  requests[requestIndex] = reviewedRequest;
  await setAccessRequestsRaw(requests);
  return reviewedRequest;
}

export async function authenticateUser(email: string, password: string): Promise<AppUser | null> {
  await seedDataIfNeeded();
  const normalizedEmail = normalizeEmail(email);
  const users = await getAuthUsersRaw();
  const match = users.find((entry) => normalizeEmail(entry.user.email) === normalizedEmail);
  if (!match) return null;
  const passwordHash = await hashPassword(password);
  if (match.passwordHash !== passwordHash) return null;
  const approvalStatus =
    match.approvalStatus === "pending" || match.approvalStatus === "rejected"
      ? match.approvalStatus
      : match.user.approvalStatus === "pending" || match.user.approvalStatus === "rejected"
        ? match.user.approvalStatus
        : "approved";
  if (approvalStatus !== "approved") return null;

  const user = normalizeUserProfile({
    ...match.user,
    approvalStatus: "approved",
  });
  const companies = await getCompanyProfiles();
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const activeCompanyId = companyById.has(user.companyId)
    ? user.companyId
    : user.companyIds?.find((companyId) => companyById.has(companyId)) || DEFAULT_COMPANY_ID;
  const activeCompany = companyById.get(activeCompanyId);
  const hydratedUser = normalizeUserProfile({
    ...user,
    companyId: activeCompanyId,
    companyName: activeCompany?.name || user.companyName || DEFAULT_COMPANY_NAME,
    branch: user.branch || activeCompany?.primaryBranch || "Main Branch",
    companyIds: normalizeCompanyIds(user.companyIds, activeCompanyId),
  });
  await setItem(KEYS.USER, hydratedUser);
  return hydratedUser;
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const user = await getItem<AppUser>(KEYS.USER);
  if (!user) return null;
  const normalized = normalizeUserProfile(user);
  if (normalized.approvalStatus !== "approved") {
    await AsyncStorage.removeItem(KEYS.USER);
    return null;
  }
  if (JSON.stringify(user) !== JSON.stringify(normalized)) {
    await setItem(KEYS.USER, normalized);
  }
  return normalized;
}

export async function syncBackendAuthenticatedUser(user: AppUser): Promise<AppUser> {
  await seedDataIfNeeded();
  const normalizedUser = normalizeUserProfile({
    ...user,
    approvalStatus: "approved",
  });

  let companies = await getCompanyProfiles();
  let activeCompany = companies.find((entry) => entry.id === normalizedUser.companyId) || null;
  if (!activeCompany) {
    const now = new Date().toISOString();
    activeCompany = normalizeCompanyProfile({
      id: normalizedUser.companyId || DEFAULT_COMPANY_ID,
      name: normalizedUser.companyName || DEFAULT_COMPANY_NAME,
      legalName: normalizedUser.companyName || DEFAULT_COMPANY_NAME,
      industry: "Healthcare",
      headquarters: "India",
      primaryBranch: normalizedUser.branch || "Main Branch",
      supportEmail: `support@${(normalizedUser.companyName || "company").toLowerCase().replace(/[^a-z0-9]+/g, "") || "trackforce"}.com`,
      supportPhone: normalizedUser.phone || "+91 00000 00000",
      attendanceZoneLabel: `${normalizedUser.companyName || "Company"} Main Office`,
      createdAt: now,
      updatedAt: now,
    });
    companies = [activeCompany, ...companies];
    await setItem(KEYS.COMPANIES, companies);
  }

  const hydratedUser = normalizeUserProfile({
    ...normalizedUser,
    companyId: activeCompany.id,
    companyName: activeCompany.name,
    companyIds: normalizeCompanyIds(normalizedUser.companyIds, activeCompany.id),
    branch: normalizedUser.branch || activeCompany.primaryBranch,
    approvalStatus: "approved",
  });

  await upsertEmployeeForCompany(hydratedUser, activeCompany);
  await setItem(KEYS.USER, hydratedUser);
  return hydratedUser;
}

export async function updateCurrentUserProfile(
  updates: {
    avatar?: string | null;
  }
): Promise<AppUser | null> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return null;

  const normalizedAvatar =
    typeof updates.avatar === "string" ? updates.avatar.trim() : updates.avatar === null ? "" : null;
  const nextUser: AppUser = normalizeUserProfile({
    ...currentUser,
    avatar:
      normalizedAvatar === null
        ? currentUser.avatar
        : normalizedAvatar
          ? normalizedAvatar
          : undefined,
  });

  await setItem(KEYS.USER, nextUser);

  const authUsers = await getAuthUsersRaw();
  let authChanged = false;
  const nextAuthUsers = authUsers.map((entry) => {
    if (
      entry.user.id !== currentUser.id &&
      normalizeEmail(entry.user.email) !== normalizeEmail(currentUser.email)
    ) {
      return entry;
    }
    authChanged = true;
    return {
      ...entry,
      user: {
        ...entry.user,
        avatar: nextUser.avatar,
      },
      updatedAt: new Date().toISOString(),
    };
  });
  if (authChanged) {
    await setAuthUsersRaw(nextAuthUsers);
  }

  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  let employeeChanged = false;
  const nextEmployees = employees.map((employee) => {
    const sameEmail = normalizeEmail(employee.email) === normalizeEmail(currentUser.email);
    const sameIdentity = employee.name === currentUser.name && employee.role === currentUser.role;
    if (!sameEmail && !sameIdentity) return employee;
    employeeChanged = true;
    return {
      ...employee,
      avatar: nextUser.avatar,
    };
  });
  if (employeeChanged) {
    await setItem(KEYS.EMPLOYEES, nextEmployees);
  }

  return nextUser;
}

async function readCheckedInMap(currentUser?: AppUser | null): Promise<Record<string, boolean>> {
  const raw = await AsyncStorage.getItem(KEYS.CHECKED_IN);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "boolean")
      ) as Record<string, boolean>;
    }
  } catch {
    // fallback handled below
  }

  if (raw === "true" || raw === "false") {
    const user = currentUser || (await getItem<AppUser>(KEYS.USER));
    if (!user) return {};
    return { [user.id]: raw === "true" };
  }
  return {};
}

async function writeCheckedInMap(map: Record<string, boolean>): Promise<void> {
  const hasValues = Object.keys(map).length > 0;
  if (!hasValues) {
    await AsyncStorage.removeItem(KEYS.CHECKED_IN);
    return;
  }
  await AsyncStorage.setItem(KEYS.CHECKED_IN, JSON.stringify(map));
}

type ApiTokenStore = Record<string, string>;

async function readApiTokenStore(currentUser?: AppUser | null): Promise<ApiTokenStore> {
  const raw = await AsyncStorage.getItem(KEYS.API_TOKEN);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string")
      ) as ApiTokenStore;
    }
  } catch {
    // fallback handled below
  }

  const user = currentUser || (await getItem<AppUser>(KEYS.USER));
  if (!user) return {};
  return { [user.id]: raw };
}

async function writeApiTokenStore(store: ApiTokenStore): Promise<void> {
  if (!Object.keys(store).length) {
    await AsyncStorage.removeItem(KEYS.API_TOKEN);
    return;
  }
  await AsyncStorage.setItem(KEYS.API_TOKEN, JSON.stringify(store));
}

export async function logoutUser(): Promise<void> {
  const current = await getItem<AppUser>(KEYS.USER);

  const checkedInMap = await readCheckedInMap(current);
  if (current?.id) {
    delete checkedInMap[current.id];
  }
  await writeCheckedInMap(checkedInMap);

  const tokenStore = await readApiTokenStore(current);
  if (current?.id) {
    delete tokenStore[current.id];
  }
  await writeApiTokenStore(tokenStore);

  await AsyncStorage.removeItem(KEYS.USER);
}

export async function getEmployees(): Promise<Employee[]> {
  const companyId = await getActiveCompanyId();
  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  return employees.filter((employee) => matchesCompany(employee, companyId));
}

export async function getAllEmployees(): Promise<Employee[]> {
  await seedDataIfNeeded();
  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  return [...employees];
}

export async function getAttendance(): Promise<AttendanceRecord[]> {
  const companyId = await getActiveCompanyId();
  const records = await getRawList<AttendanceRecord>(KEYS.ATTENDANCE);
  return records.filter((record) => matchesCompany(record, companyId));
}

export async function addAttendance(record: AttendanceRecord): Promise<void> {
  const companyId = await getActiveCompanyId();
  const records = await getRawList<AttendanceRecord>(KEYS.ATTENDANCE);
  records.unshift(
    withCompanyId(
      {
        ...record,
        approvalStatus: record.approvalStatus ?? "approved",
      },
      companyId
    )
  );
  await setItem(KEYS.ATTENDANCE, records);
}

export async function updateAttendanceApproval(
  attendanceId: string,
  status: "approved" | "rejected",
  reviewer: { id: string; name: string },
  comment?: string
): Promise<AttendanceRecord | null> {
  const companyId = await getActiveCompanyId();
  const records = await getRawList<AttendanceRecord>(KEYS.ATTENDANCE);
  const index = records.findIndex(
    (record) => record.id === attendanceId && matchesCompany(record, companyId)
  );
  if (index === -1) return null;

  const now = new Date().toISOString();
  const current = records[index];
  const updated: AttendanceRecord = {
    ...current,
    approvalStatus: status,
    approvalReviewedById: reviewer.id,
    approvalReviewedByName: reviewer.name,
    approvalReviewedAt: now,
    approvalComment: comment?.trim() || null,
  };
  records[index] = updated;
  await setItem(KEYS.ATTENDANCE, records);
  return updated;
}

export async function isCheckedIn(): Promise<boolean> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) return false;
  const checkedInMap = await readCheckedInMap(currentUser);
  return checkedInMap[currentUser.id] === true;
}

export async function setCheckedIn(value: boolean): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) return;
  const checkedInMap = await readCheckedInMap(currentUser);
  checkedInMap[currentUser.id] = value;
  await writeCheckedInMap(checkedInMap);
}

export async function getSalaries(): Promise<SalaryRecord[]> {
  const companyId = await getActiveCompanyId();
  const salaries = await getRawList<SalaryRecord>(KEYS.SALARIES);
  return salaries.filter((salary) => matchesCompany(salary, companyId));
}

export async function updateSalaryStatus(
  salaryId: string,
  status: SalaryRecord["status"]
): Promise<void> {
  const companyId = await getActiveCompanyId();
  const salaries = await getRawList<SalaryRecord>(KEYS.SALARIES);
  const idx = salaries.findIndex((salary) => salary.id === salaryId && matchesCompany(salary, companyId));
  if (idx !== -1) {
    salaries[idx].status = status;
    await setItem(KEYS.SALARIES, salaries);
  }
}

export async function getTasks(): Promise<Task[]> {
  const companyId = await getActiveCompanyId();
  const tasks = await getRawList<Task>(KEYS.TASKS);
  return tasks.filter((task) => matchesCompany(task, companyId));
}

export async function addTask(task: Task): Promise<void> {
  const companyId = await getActiveCompanyId();
  const tasks = await getRawList<Task>(KEYS.TASKS);
  tasks.unshift(withCompanyId(task, companyId));
  await setItem(KEYS.TASKS, tasks);
}

export async function updateTaskStatus(
  taskId: string,
  status: Task["status"]
): Promise<void> {
  const companyId = await getActiveCompanyId();
  const tasks = await getRawList<Task>(KEYS.TASKS);
  const idx = tasks.findIndex((task) => task.id === taskId && matchesCompany(task, companyId));
  if (idx !== -1) {
    tasks[idx].status = status;
    await setItem(KEYS.TASKS, tasks);
  }
}

export async function getExpenses(): Promise<Expense[]> {
  const companyId = await getActiveCompanyId();
  const expenses = await getRawList<Expense>(KEYS.EXPENSES);
  return expenses.filter((expense) => matchesCompany(expense, companyId));
}

export async function addExpense(expense: Expense): Promise<void> {
  const companyId = await getActiveCompanyId();
  const expenses = await getRawList<Expense>(KEYS.EXPENSES);
  expenses.unshift(withCompanyId(expense, companyId));
  await setItem(KEYS.EXPENSES, expenses);
}

export async function updateExpenseStatus(
  expenseId: string,
  status: Expense["status"]
): Promise<void> {
  const companyId = await getActiveCompanyId();
  const expenses = await getRawList<Expense>(KEYS.EXPENSES);
  const idx = expenses.findIndex(
    (expense) => expense.id === expenseId && matchesCompany(expense, companyId)
  );
  if (idx !== -1) {
    expenses[idx].status = status;
    await setItem(KEYS.EXPENSES, expenses);
  }
}

export async function getConversations(): Promise<Conversation[]> {
  const companyId = await getActiveCompanyId();
  const conversations = await getRawList<Conversation>(KEYS.CONVERSATIONS);
  return conversations.filter((conversation) => matchesCompany(conversation, companyId));
}

export async function addConversation(conversation: Conversation): Promise<void> {
  const companyId = await getActiveCompanyId();
  const conversations = await getRawList<Conversation>(KEYS.CONVERSATIONS);
  conversations.unshift(withCompanyId(conversation, companyId));
  await setItem(KEYS.CONVERSATIONS, conversations);
}

export async function updateConversation(
  conversationId: string,
  updates: Partial<Conversation>
): Promise<void> {
  const companyId = await getActiveCompanyId();
  const conversations = await getRawList<Conversation>(KEYS.CONVERSATIONS);
  const index = conversations.findIndex(
    (conversation) => conversation.id === conversationId && matchesCompany(conversation, companyId)
  );
  if (index === -1) return;
  conversations[index] = {
    ...conversations[index],
    ...updates,
  };
  await setItem(KEYS.CONVERSATIONS, conversations);
}

export async function getAuditLogs(): Promise<AuditLog[]> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<AuditLog>(KEYS.AUDIT_LOGS);
  return logs.filter((log) => matchesCompany(log, companyId));
}

export async function addAuditLog(log: AuditLog): Promise<void> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<AuditLog>(KEYS.AUDIT_LOGS);
  logs.unshift(withCompanyId(log, companyId));
  await setItem(KEYS.AUDIT_LOGS, logs);
}

async function getSettingsStore(): Promise<CompanySettingsStore> {
  const raw = (await getItem<Record<string, unknown>>(KEYS.SETTINGS)) || {};
  const isLegacy = Object.values(raw).some((value) => typeof value === "string");
  if (isLegacy) {
    return { [DEFAULT_COMPANY_ID]: raw as Record<string, string> };
  }
  const entries = Object.entries(raw).filter(
    ([, value]) => value && typeof value === "object" && !Array.isArray(value)
  );
  return Object.fromEntries(entries) as CompanySettingsStore;
}

export async function getSettings(): Promise<Record<string, string>> {
  const companyId = (await getActiveCompanyId()) ?? DEFAULT_COMPANY_ID;
  const store = await getSettingsStore();
  const current = store[companyId] || {};
  const offlineMode = current.offlineMode === "true" ? "true" : "false";
  const autoSync = offlineMode === "true" ? "false" : current.autoSync === "false" ? "false" : "true";
  const themeMode =
    current.themeMode === "light" || current.themeMode === "dark" || current.themeMode === "system"
      ? current.themeMode
      : "system";
  const backendApiUrl = (current.backendApiUrl || "").trim() || BACKEND_ENV_DEFAULTS.apiBaseUrl;
  const dolibarrEndpoint =
    (current.dolibarrEndpoint || "").trim() || DOLIBARR_ENV_DEFAULTS.endpoint;
  const dolibarrApiKey = (current.dolibarrApiKey || "").trim() || DOLIBARR_ENV_DEFAULTS.apiKey;
  const aiApiKey = (current.aiApiKey || "").trim() || AI_ENV_DEFAULTS.apiKey;
  const aiModel = (current.aiModel || "").trim() || AI_ENV_DEFAULTS.model;
  const aiProjectId = (current.aiProjectId || "").trim() || AI_ENV_DEFAULTS.projectId;
  const dolibarrEnabled =
    current.dolibarrEnabled === "true"
      ? "true"
      : current.dolibarrEnabled === "false"
        ? "false"
        : dolibarrEndpoint && dolibarrApiKey
          ? "true"
          : "false";

  return {
    ...current,
    notifications: current.notifications === "false" ? "false" : "true",
    locationTracking: current.locationTracking === "false" ? "false" : "true",
    autoSync,
    offlineMode,
    biometricLogin: current.biometricLogin === "false" ? "false" : "true",
    themeMode,
    backendApiUrl,
    dolibarrEnabled,
    dolibarrEndpoint,
    dolibarrApiKey,
    aiApiKey,
    aiModel,
    aiProjectId,
    huggingFaceApiKey: HUGGINGFACE_ENV_DEFAULTS.apiKey,
  };
}

function notifySettingsListeners(settings: SettingsSnapshot): void {
  for (const listener of settingsListeners) {
    try {
      listener(settings);
    } catch {
      // Keep settings updates resilient if one listener fails.
    }
  }
}

export function subscribeSettingsUpdates(listener: SettingsListener): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

export async function updateSettings(
  settings: Record<string, string>
): Promise<void> {
  const companyId = (await getActiveCompanyId()) ?? DEFAULT_COMPANY_ID;
  const store = await getSettingsStore();
  const current = store[companyId] || {};
  const normalized = { ...settings };

  if ("notifications" in normalized) {
    normalized.notifications = normalized.notifications === "false" ? "false" : "true";
  }
  if ("locationTracking" in normalized) {
    normalized.locationTracking = normalized.locationTracking === "false" ? "false" : "true";
  }
  if ("autoSync" in normalized) {
    normalized.autoSync = normalized.autoSync === "false" ? "false" : "true";
  }
  if ("offlineMode" in normalized) {
    normalized.offlineMode = normalized.offlineMode === "true" ? "true" : "false";
  }
  if ("biometricLogin" in normalized) {
    normalized.biometricLogin = normalized.biometricLogin === "false" ? "false" : "true";
  }
  if ("dolibarrEnabled" in normalized) {
    normalized.dolibarrEnabled = normalized.dolibarrEnabled === "true" ? "true" : "false";
  }
  if ("backendApiUrl" in normalized) {
    normalized.backendApiUrl = normalized.backendApiUrl.trim();
  }
  if ("dolibarrEndpoint" in normalized) {
    normalized.dolibarrEndpoint = normalized.dolibarrEndpoint.trim();
  }
  if ("dolibarrApiKey" in normalized) {
    normalized.dolibarrApiKey = normalized.dolibarrApiKey.trim();
  }
  if ("aiApiKey" in normalized) {
    normalized.aiApiKey = normalized.aiApiKey.trim();
  }
  if ("aiModel" in normalized) {
    normalized.aiModel = normalized.aiModel.trim();
  }
  if ("aiProjectId" in normalized) {
    normalized.aiProjectId = normalized.aiProjectId.trim();
  }

  const patch = { ...normalized };
  if (patch.offlineMode === "true") {
    patch.autoSync = "false";
  } else if (patch.autoSync === "true") {
    patch.offlineMode = "false";
  }

  store[companyId] = { ...current, ...patch };
  await setItem(KEYS.SETTINGS, store);
  const snapshot = await getSettings();
  notifySettingsListeners(snapshot);
}

export async function getThemePreference(): Promise<ThemePreference> {
  const settings = await getSettings();
  const mode = settings.themeMode;
  if (mode === "light" || mode === "dark" || mode === "system") {
    return mode;
  }
  return "system";
}

export async function setThemePreference(mode: ThemePreference): Promise<void> {
  await updateSettings({ themeMode: mode });
}

export async function getGeofences(): Promise<Geofence[]> {
  const companyId = await getActiveCompanyId();
  const geofences = await getRawList<Geofence>(KEYS.GEOFENCES);
  return geofences.filter((zone) => matchesCompany(zone, companyId));
}

export async function getGeofencesForUser(userId: string): Promise<Geofence[]> {
  const geofences = await getGeofences();
  return geofences.filter((zone) => zone.isActive && zone.assignedEmployeeIds.includes(userId));
}

export async function upsertGeofence(geofence: Geofence): Promise<void> {
  const companyId = await getActiveCompanyId();
  const geofences = await getRawList<Geofence>(KEYS.GEOFENCES);
  const candidate = withCompanyId(geofence, companyId);
  const existingIndex = geofences.findIndex((zone) => zone.id === candidate.id);
  if (existingIndex >= 0) {
    geofences[existingIndex] = candidate;
  } else {
    geofences.unshift(candidate);
  }
  await setItem(KEYS.GEOFENCES, geofences);
}

export async function getTeams(): Promise<Team[]> {
  const companyId = await getActiveCompanyId();
  const teams = await getRawList<Team>(KEYS.TEAMS);
  return teams.filter((team) => matchesCompany(team, companyId));
}

export async function getTeamById(teamId: string): Promise<Team | null> {
  const teams = await getTeams();
  return teams.find((team) => team.id === teamId) || null;
}

export async function upsertTeam(team: Team): Promise<void> {
  const companyId = await getActiveCompanyId();
  const teams = await getRawList<Team>(KEYS.TEAMS);
  const candidate = withCompanyId(team, companyId);
  const existingIndex = teams.findIndex((item) => item.id === candidate.id);
  if (existingIndex >= 0) {
    teams[existingIndex] = candidate;
  } else {
    teams.unshift(candidate);
  }
  await setItem(KEYS.TEAMS, teams);
}

export async function getAttendancePhotos(): Promise<AttendancePhoto[]> {
  const companyId = await getActiveCompanyId();
  const photos = await getRawList<AttendancePhoto>(KEYS.ATTENDANCE_PHOTOS);
  return photos.filter((photo) => matchesCompany(photo, companyId));
}

export async function addAttendancePhoto(photo: AttendancePhoto): Promise<void> {
  const companyId = await getActiveCompanyId();
  const photos = await getRawList<AttendancePhoto>(KEYS.ATTENDANCE_PHOTOS);
  photos.unshift(withCompanyId(photo, companyId));
  await setItem(KEYS.ATTENDANCE_PHOTOS, photos);
}

export async function getAttendanceAnomalies(): Promise<AttendanceAnomaly[]> {
  const companyId = await getActiveCompanyId();
  const anomalies = await getRawList<AttendanceAnomaly>(KEYS.ATTENDANCE_ANOMALIES);
  return anomalies.filter((anomaly) => matchesCompany(anomaly, companyId));
}

export async function addAttendanceAnomaly(anomaly: AttendanceAnomaly): Promise<void> {
  const companyId = await getActiveCompanyId();
  const anomalies = await getRawList<AttendanceAnomaly>(KEYS.ATTENDANCE_ANOMALIES);
  anomalies.unshift(withCompanyId(anomaly, companyId));
  await setItem(KEYS.ATTENDANCE_ANOMALIES, anomalies);
}

export async function getLocationLogs(): Promise<LocationLog[]> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<LocationLog>(KEYS.LOCATION_LOGS);
  return logs.filter((log) => matchesCompany(log, companyId));
}

export async function addLocationLog(locationLog: LocationLog): Promise<void> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<LocationLog>(KEYS.LOCATION_LOGS);
  logs.unshift(withCompanyId(locationLog, companyId));
  await setItem(KEYS.LOCATION_LOGS, logs.slice(0, 5000));
}

export async function getDolibarrSyncLogs(): Promise<DolibarrSyncLog[]> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<DolibarrSyncLog>(KEYS.DOLIBARR_SYNC_LOGS);
  return logs.filter((log) => matchesCompany(log, companyId));
}

export async function addDolibarrSyncLog(log: DolibarrSyncLog): Promise<void> {
  const companyId = await getActiveCompanyId();
  const logs = await getRawList<DolibarrSyncLog>(KEYS.DOLIBARR_SYNC_LOGS);
  logs.unshift(withCompanyId(log, companyId));
  await setItem(KEYS.DOLIBARR_SYNC_LOGS, logs.slice(0, 2000));
}

function canModerateSupport(role?: UserRole | null): boolean {
  return role === "admin" || role === "manager" || role === "hr";
}

function canReceiveNotification(audience: NotificationAudience, role?: UserRole | null): boolean {
  if (audience === "all") return true;
  return audience === role;
}

export async function getNotificationsForCurrentUser(): Promise<AppNotification[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return [];
  const companyId = await getActiveCompanyId();
  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  return notifications
    .filter(
      (item) =>
        matchesCompany(item, companyId) && canReceiveNotification(item.audience, currentUser.role)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCompanyNotifications(): Promise<AppNotification[]> {
  const companyId = await getActiveCompanyId();
  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  return notifications
    .filter((item) => matchesCompany(item, companyId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getUnreadNotificationsCount(): Promise<number> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return 0;
  const notifications = await getNotificationsForCurrentUser();
  return notifications.filter((item) => !(item.readByIds || []).includes(currentUser.id)).length;
}

export async function addNotification(
  notification: Omit<AppNotification, "companyId" | "readByIds"> & { readByIds?: string[] },
  options?: { companyId?: string | null }
): Promise<AppNotification> {
  const companyId =
    options && "companyId" in options ? options.companyId ?? null : await getActiveCompanyId();
  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  const candidate: AppNotification = withCompanyId<AppNotification>(
    {
      ...notification,
      readByIds: Array.from(new Set(notification.readByIds || [])),
    },
    companyId
  );
  notifications.unshift(candidate);
  await setItem(KEYS.NOTIFICATIONS, notifications.slice(0, 2000));

  try {
    const currentUser = await getCurrentUser();
    if (currentUser) {
      const settings = await getSettings();
      const isNotificationsEnabled = settings.notifications !== "false";
      const activeCompanyId = currentUser.companyId || null;
      const isCompanyMatch = matchesCompany(candidate, activeCompanyId);
      const isAudienceMatch = canReceiveNotification(candidate.audience, currentUser.role);
      const isSelfCreated = candidate.createdById === currentUser.id;
      if (isNotificationsEnabled && isCompanyMatch && isAudienceMatch && !isSelfCreated) {
        await sendDeviceLocalNotification({
          title: candidate.title,
          body: candidate.body,
          data: {
            notificationId: candidate.id,
            kind: candidate.kind,
            audience: candidate.audience,
          },
        });
      }
    }
  } catch {
    // Non-blocking: storing notification should never fail due to device alert issues.
  }

  return candidate;
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return;
  const companyId = await getActiveCompanyId();
  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  const index = notifications.findIndex(
    (item) => item.id === notificationId && matchesCompany(item, companyId)
  );
  if (index < 0) return;
  const currentReadBy = notifications[index].readByIds || [];
  if (currentReadBy.includes(currentUser.id)) return;
  notifications[index] = {
    ...notifications[index],
    readByIds: [...currentReadBy, currentUser.id],
  };
  await setItem(KEYS.NOTIFICATIONS, notifications);
}

export async function markAllNotificationsRead(): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return;
  const companyId = await getActiveCompanyId();
  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  let changed = false;
  const next = notifications.map((item) => {
    if (!matchesCompany(item, companyId)) return item;
    if (!canReceiveNotification(item.audience, currentUser.role)) return item;
    const readByIds = item.readByIds || [];
    if (readByIds.includes(currentUser.id)) return item;
    changed = true;
    return {
      ...item,
      readByIds: [...readByIds, currentUser.id],
    };
  });
  if (!changed) return;
  await setItem(KEYS.NOTIFICATIONS, next);
}

export async function getSupportThreadsForCurrentUser(): Promise<SupportThread[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return [];
  const threads = await getRawList<SupportThread>(KEYS.SUPPORT_THREADS);
  if (currentUser.role === "admin") {
    return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const companyId = await getActiveCompanyId();
  const scoped = threads.filter((thread) => matchesCompany(thread, companyId));
  if (canModerateSupport(currentUser.role)) {
    return scoped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return scoped
    .filter((thread) => thread.requestedById === currentUser.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSupportThread(input: {
  subject: string;
  message: string;
  priority?: "normal" | "high";
}): Promise<SupportThread> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User session not found.");
  }
  const subject = input.subject.trim();
  const message = input.message.trim();
  if (!subject) {
    throw new Error("Subject is required.");
  }
  if (!message) {
    throw new Error("Message is required.");
  }
  const now = new Date().toISOString();
  const thread: SupportThread = withCompanyId<SupportThread>(
    {
      id: `support_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      subject,
      requestedById: currentUser.id,
      requestedByName: currentUser.name,
      requestedByRole: currentUser.role,
      status: "open",
      priority: input.priority === "high" ? "high" : "normal",
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: `support_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          senderId: currentUser.id,
          senderName: currentUser.name,
          senderRole: currentUser.role,
          message,
          createdAt: now,
        },
      ],
    },
    await getActiveCompanyId()
  );
  const threads = await getRawList<SupportThread>(KEYS.SUPPORT_THREADS);
  threads.unshift(thread);
  await setItem(KEYS.SUPPORT_THREADS, threads.slice(0, 1000));

  await addNotification({
    id: `notif_support_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: `Support: ${thread.subject}`,
    body: `${thread.requestedByName} raised a new support request.`,
    kind: "support",
    audience: "admin",
    createdById: currentUser.id,
    createdByName: currentUser.name,
    createdAt: now,
  });

  return thread;
}

export async function addSupportThreadMessage(
  threadId: string,
  message: string
): Promise<SupportThread | null> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User session not found.");
  }
  const text = message.trim();
  if (!text) {
    throw new Error("Message cannot be empty.");
  }
  const companyId = await getActiveCompanyId();
  const threads = await getRawList<SupportThread>(KEYS.SUPPORT_THREADS);
  const isAdmin = currentUser.role === "admin";
  const index = threads.findIndex(
    (thread) => thread.id === threadId && (isAdmin || matchesCompany(thread, companyId))
  );
  if (index < 0) return null;

  const current = threads[index];
  const isOwner = current.requestedById === currentUser.id;
  const isModerator = canModerateSupport(currentUser.role);
  if (!isOwner && !isModerator) {
    throw new Error("You are not allowed to reply on this thread.");
  }

  const now = new Date().toISOString();
  const nextMessage: SupportMessage = {
    id: `support_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    senderId: currentUser.id,
    senderName: currentUser.name,
    senderRole: currentUser.role,
    message: text,
    createdAt: now,
  };
  const updated: SupportThread = {
    ...current,
    status: !isModerator && current.status === "closed" ? "open" : current.status,
    updatedAt: now,
    messages: [...current.messages, nextMessage],
  };
  threads[index] = updated;
  await setItem(KEYS.SUPPORT_THREADS, threads);

  await addNotification({
    id: `notif_support_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: `Support Update: ${updated.subject}`,
    body: `${currentUser.name} replied to support thread.`,
    kind: "support",
    audience: isModerator ? updated.requestedByRole : "admin",
    createdById: currentUser.id,
    createdByName: currentUser.name,
    createdAt: now,
  }, { companyId: updated.companyId ?? companyId });

  return updated;
}

export async function setSupportThreadStatus(
  threadId: string,
  status: "open" | "closed"
): Promise<SupportThread | null> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    throw new Error("User session not found.");
  }
  const companyId = await getActiveCompanyId();
  const threads = await getRawList<SupportThread>(KEYS.SUPPORT_THREADS);
  const isAdmin = currentUser.role === "admin";
  const index = threads.findIndex(
    (thread) => thread.id === threadId && (isAdmin || matchesCompany(thread, companyId))
  );
  if (index < 0) return null;

  const current = threads[index];
  const isOwner = current.requestedById === currentUser.id;
  const isModerator = canModerateSupport(currentUser.role);
  if (!isOwner && !isModerator) {
    throw new Error("You are not allowed to update this thread.");
  }

  const now = new Date().toISOString();
  const updated: SupportThread = {
    ...current,
    status,
    updatedAt: now,
  };
  threads[index] = updated;
  await setItem(KEYS.SUPPORT_THREADS, threads);

  await addNotification({
    id: `notif_support_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: `Support ${status === "closed" ? "Closed" : "Reopened"}`,
    body: `${updated.subject} is now ${status}.`,
    kind: "support",
    audience: isModerator ? updated.requestedByRole : "admin",
    createdById: currentUser.id,
    createdByName: currentUser.name,
    createdAt: now,
  }, { companyId: updated.companyId ?? companyId });

  return updated;
}

export async function getAttendanceQueue<T = Record<string, unknown>>(): Promise<T[]> {
  return (await getItem<T[]>(KEYS.ATTENDANCE_QUEUE)) || [];
}

export async function setAttendanceQueue<T = Record<string, unknown>>(queue: T[]): Promise<void> {
  await setItem(KEYS.ATTENDANCE_QUEUE, queue);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const current = await AsyncStorage.getItem(KEYS.DEVICE_ID);
  if (current) return current;

  const generated = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await AsyncStorage.setItem(KEYS.DEVICE_ID, generated);
  return generated;
}

export async function getApiToken(): Promise<string | null> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) return null;
  const tokenStore = await readApiTokenStore(currentUser);
  return tokenStore[currentUser.id] ?? null;
}

export async function setApiToken(token: string | null): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) {
    if (!token) {
      await AsyncStorage.removeItem(KEYS.API_TOKEN);
    } else {
      await AsyncStorage.setItem(KEYS.API_TOKEN, token);
    }
    return;
  }

  const tokenStore = await readApiTokenStore(currentUser);
  if (!token) {
    delete tokenStore[currentUser.id];
  } else {
    tokenStore[currentUser.id] = token;
  }
  await writeApiTokenStore(tokenStore);
}
