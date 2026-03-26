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
  StockistProfile,
  StockTransfer,
  IncentiveGoalPlan,
  IncentiveProductPlan,
  IncentivePayout,
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
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  PENDING_COMPANY_ID,
  PENDING_COMPANY_NAME,
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
  STOCKISTS: "@trackforce_stockists",
  STOCK_TRANSFERS: "@trackforce_stock_transfers",
  INCENTIVE_GOAL_PLANS: "@trackforce_incentive_goal_plans",
  INCENTIVE_PRODUCT_PLANS: "@trackforce_incentive_product_plans",
  INCENTIVE_PAYOUTS: "@trackforce_incentive_payouts",
  ACCESS_REQUESTS: "@trackforce_access_requests",
  ATTENDANCE_QUEUE: "@trackforce_attendance_queue",
  DEVICE_ID: "@trackforce_device_id",
  API_TOKEN: "@trackforce_api_token",
  SEED_VERSION: "@trackforce_seed_version",
};

const SEED_VERSION = "9";
const DEMO_EMAIL_SUFFIX = "@trackforce.ai";

type ThemePreference = "system" | "light" | "dark";
type CompanyScoped = { companyId?: string | null };
type CompanyScopeMode = "active" | "accessible";
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

const RELEASE_BACKEND_FALLBACK_URL = "https://api.axionmeditech.com";

const BACKEND_ENV_DEFAULTS = {
  apiBaseUrl:
    readTrimmedEnv("EXPO_PUBLIC_API_URL") ||
    readTrimmedEnv("EXPO_PUBLIC_BACKEND_URL") ||
    readTrimmedEnv("EXPO_PUBLIC_DOMAIN") ||
    RELEASE_BACKEND_FALLBACK_URL,
};

const DOLIBARR_ENV_DEFAULTS = {
  endpoint:
    readTrimmedEnv("EXPO_PUBLIC_DOLIBARR_ENDPOINT") || readTrimmedEnv("DOLIBARR_ENDPOINT"),
  apiKey:
    readTrimmedEnv("EXPO_PUBLIC_DOLIBARR_API_KEY") || readTrimmedEnv("DOLIBARR_API_KEY"),
};

const REMOTE_STATE_SYNC_DISABLED = readTrimmedEnv("EXPO_PUBLIC_REMOTE_STATE_SYNC") === "false";
const REMOTE_STATE_TIMEOUT_MS = 3200;
const REMOTE_STATE_PENDING_WRITES_KEY = "@trackforce_remote_state_pending_writes";
const REMOTE_STATE_ALLOWED_KEYS = new Set<string>([
  KEYS.COMPANIES,
  KEYS.EMPLOYEES,
  KEYS.ATTENDANCE,
  KEYS.SALARIES,
  KEYS.TASKS,
  KEYS.EXPENSES,
  KEYS.STOCKISTS,
  KEYS.STOCK_TRANSFERS,
  KEYS.INCENTIVE_GOAL_PLANS,
  KEYS.INCENTIVE_PRODUCT_PLANS,
  KEYS.INCENTIVE_PAYOUTS,
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

interface PendingRemoteStateWrite {
  key: string;
  value: unknown;
  updatedAt: string;
}

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
  const protocols: ("http:" | "https:")[] = isPrivateHost
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

async function getLocalSettingsApiBaseUrl(): Promise<string> {
  const [settingsRaw, userRaw] = await Promise.all([
    AsyncStorage.getItem(KEYS.SETTINGS),
    AsyncStorage.getItem(KEYS.USER),
  ]);
  if (!settingsRaw) return "";

  let companyId = DEFAULT_COMPANY_ID;
  if (userRaw) {
    try {
      const parsedUser = JSON.parse(userRaw) as { companyId?: unknown } | null;
      if (parsedUser && typeof parsedUser.companyId === "string" && parsedUser.companyId.trim()) {
        companyId = parsedUser.companyId.trim();
      }
    } catch {
      // ignore parse errors and keep default company id fallback
    }
  }

  try {
    const parsedSettings = JSON.parse(settingsRaw) as Record<string, unknown>;
    if (!parsedSettings || typeof parsedSettings !== "object" || Array.isArray(parsedSettings)) {
      return "";
    }
    const values = Object.values(parsedSettings);
    const isLegacy = values.some((value) => typeof value === "string");
    if (isLegacy) {
      const directUrl = parsedSettings.backendApiUrl;
      return typeof directUrl === "string" ? directUrl.trim() : "";
    }

    const companySettings = parsedSettings[companyId];
    if (companySettings && typeof companySettings === "object" && !Array.isArray(companySettings)) {
      const companyUrl = (companySettings as Record<string, unknown>).backendApiUrl;
      if (typeof companyUrl === "string" && companyUrl.trim()) {
        return companyUrl.trim();
      }
    }

    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const fallbackUrl = (value as Record<string, unknown>).backendApiUrl;
      if (typeof fallbackUrl === "string" && fallbackUrl.trim()) {
        return fallbackUrl.trim();
      }
    }
    return "";
  } catch {
    return "";
  }
}

async function getRemoteStateApiCandidates(): Promise<string[]> {
  const candidates = new Set<string>();
  const isExpoDevRuntime =
    __DEV__ ||
    Constants.appOwnership === "expo" ||
    Boolean(Constants.expoConfig?.hostUri);
  const settingsApiUrl = await getLocalSettingsApiBaseUrl();
  const envUrl = BACKEND_ENV_DEFAULTS.apiBaseUrl;
  for (const rawUrl of [settingsApiUrl, envUrl]) {
    if (!rawUrl) continue;
    for (const apiBase of toApiBaseUrls(rawUrl)) {
      candidates.add(apiBase);
    }
  }

  const expoLanBase = getExpoLanApiBaseUrl();
  if (isExpoDevRuntime && expoLanBase) {
    candidates.add(expoLanBase);
  }

  if (isExpoDevRuntime) {
    candidates.add("http://localhost:5000/api");
  }
  return Array.from(candidates);
}

async function readPendingRemoteStateWrites(): Promise<PendingRemoteStateWrite[]> {
  const raw = await AsyncStorage.getItem(REMOTE_STATE_PENDING_WRITES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as PendingRemoteStateWrite[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writePendingRemoteStateWrites(entries: PendingRemoteStateWrite[]): Promise<void> {
  if (!entries.length) {
    await AsyncStorage.removeItem(REMOTE_STATE_PENDING_WRITES_KEY);
    return;
  }
  await AsyncStorage.setItem(REMOTE_STATE_PENDING_WRITES_KEY, JSON.stringify(entries.slice(-120)));
}

async function enqueuePendingRemoteStateWrite(key: string, value: unknown): Promise<void> {
  const queue = await readPendingRemoteStateWrites();
  const withoutCurrentKey = queue.filter((entry) => entry.key !== key);
  withoutCurrentKey.push({
    key,
    value,
    updatedAt: new Date().toISOString(),
  });
  await writePendingRemoteStateWrites(withoutCurrentKey);
}

async function removePendingRemoteStateWrite(key: string): Promise<void> {
  const queue = await readPendingRemoteStateWrites();
  if (!queue.length) return;
  const next = queue.filter((entry) => entry.key !== key);
  if (next.length === queue.length) return;
  await writePendingRemoteStateWrites(next);
}

async function flushPendingRemoteStateWrites(): Promise<void> {
  const queue = await readPendingRemoteStateWrites();
  if (!queue.length) return;
  const remaining: PendingRemoteStateWrite[] = [];
  for (const entry of queue) {
    const pushed = await pushStateRemote(entry.key, entry.value);
    if (!pushed) {
      remaining.push(entry);
    }
  }
  await writePendingRemoteStateWrites(remaining);
}

function shouldSyncRemoteStateKey(key: string): boolean {
  if (REMOTE_STATE_SYNC_DISABLED) return false;
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
}

async function fetchStateRemote<T>(key: string): Promise<T | null | undefined> {
  const token = await getApiToken();
  if (!token) return undefined;
  const encodedKey = encodeURIComponent(key);

  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
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
      const text = await response.text();
      if (!response.ok) {
        if (response.status >= 500) continue;
        return undefined;
      }
      const trimmed = text.trim();
      if (!trimmed) return null;
      try {
        const payload = JSON.parse(text) as { value?: unknown };
        return (payload?.value ?? null) as T | null;
      } catch {
        // invalid JSON from backend, try next candidate
        continue;
      }
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return undefined;
}

async function fetchStockistsRemote(): Promise<StockistProfile[] | null | undefined> {
  const token = await getApiToken();
  if (!token) return undefined;

  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/stockists`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status >= 500) continue;
        return undefined;
      }
      const trimmed = text.trim();
      if (!trimmed) return [];
      try {
        const payload = JSON.parse(text) as { items?: unknown } | unknown[];
        if (Array.isArray(payload)) return payload as StockistProfile[];
        if (payload && typeof payload === "object" && Array.isArray((payload as any).items)) {
          return (payload as any).items as StockistProfile[];
        }
        return [];
      } catch {
        continue;
      }
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

  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
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

async function refreshRemoteStateList<T>(key: string): Promise<T[] | null> {
  const remote = await fetchStateRemote<T[]>(key);
  if (typeof remote === "undefined") return null;
  const normalized = Array.isArray(remote) ? remote : [];
  await AsyncStorage.setItem(key, JSON.stringify(normalized));
  return normalized;
}

async function getLatestRemoteSyncedList<T>(
  key: string,
  refresh?: () => Promise<T[] | null>
): Promise<T[]> {
  if (!shouldSyncRemoteStateKey(key)) {
    return getRawList<T>(key);
  }
  const remote = refresh ? await refresh() : await refreshRemoteStateList<T>(key);
  if (Array.isArray(remote)) return remote;
  return getRawList<T>(key);
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
  pincode?: string;
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

function normalizeLogin(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isLegacyDemoEmail(value: string | null | undefined): boolean {
  return normalizeEmail(value || "").endsWith(DEMO_EMAIL_SUFFIX);
}

function hasAnyLegacyDemoProfile(
  authUsers: StoredAuthUser[],
  employees: Employee[],
  accessRequests: UserAccessRequest[]
): boolean {
  return (
    authUsers.some((entry) => isLegacyDemoEmail(entry.user.email)) ||
    employees.some((entry) => isLegacyDemoEmail(entry.email)) ||
    accessRequests.some((entry) => isLegacyDemoEmail(entry.email))
  );
}

function normalizePhone(value?: string): string {
  const cleaned = normalizeWhitespace(value ?? "");
  return cleaned || "+91 00000 00000";
}

function normalizePincode(value?: string): string | undefined {
  const cleaned = normalizeWhitespace(value ?? "").replace(/\s+/g, "");
  return cleaned || undefined;
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

function normalizeStringIdList(values: string[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.map((value) => normalizeWhitespace(value)).filter((value) => Boolean(value)))
  );
}

function buildDefaultCompanyProfile(): CompanyProfile {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_COMPANY_ID,
    name: DEFAULT_COMPANY_NAME,
    legalName: `${DEFAULT_COMPANY_NAME} Pvt Ltd`,
    industry: "General",
    headquarters: "India",
    primaryBranch: "Main Branch",
    supportEmail: "support@company.com",
    supportPhone: "+91 00000 00000",
    attendanceZoneLabel: "Main Branch",
    createdAt: now,
    updatedAt: now,
  };
}

function buildPendingCompanyProfile(): CompanyProfile {
  const now = new Date().toISOString();
  return {
    id: PENDING_COMPANY_ID,
    name: PENDING_COMPANY_NAME,
    legalName: `${PENDING_COMPANY_NAME} Pvt Ltd`,
    industry: "General",
    headquarters: "India",
    primaryBranch: "Main Branch",
    supportEmail: "support@company.com",
    supportPhone: "+91 00000 00000",
    attendanceZoneLabel: "Main Branch",
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
  const stockistId = normalizeWhitespace(user.stockistId ?? "");
  const stockistName = normalizeWhitespace(user.stockistName ?? "");
  const explicitLogin = normalizeWhitespace(user.login ?? "");
  const fallbackLogin =
    explicitLogin || normalizeEmail(user.email).split("@")[0] || slugify(user.name);
  return {
    ...user,
    companyId,
    companyName: sanitizeCompanyName(user.companyName || DEFAULT_COMPANY_NAME),
    companyIds,
    name: normalizeWhitespace(user.name),
    email: normalizeEmail(user.email),
    login: fallbackLogin || undefined,
    department: normalizeWhitespace(user.department),
    branch: normalizeWhitespace(user.branch),
    phone: normalizePhone(user.phone),
    pincode: normalizePincode(user.pincode),
    managerId: managerId || undefined,
    managerName: managerName || undefined,
    stockistId: stockistId || undefined,
    stockistName: stockistName || undefined,
    approvalStatus,
  };
}

function withCompanyId<T extends CompanyScoped>(item: T, companyId: string | null): T {
  if (!companyId || item.companyId) return item;
  return { ...item, companyId } as T;
}

function matchesCompany(item: CompanyScoped, companyId: string | null): boolean {
  if (!companyId) return true;
  if (!item.companyId) return true;
  return item.companyId === companyId;
}

function matchesCompanySet(item: CompanyScoped, companyIds: Set<string>): boolean {
  if (!companyIds.size) return true;
  if (!item.companyId) return true;
  return companyIds.has(item.companyId);
}

function employeeMatchesUserIdentity(employee: Employee, user: AppUser): boolean {
  if (!employee || !user) return false;
  const employeeId = normalizeWhitespace(employee.id);
  const userId = normalizeWhitespace(user.id);
  if (employeeId && userId && employeeId === userId) {
    return true;
  }

  const employeeEmail = normalizeEmail(employee.email);
  const userEmail = normalizeEmail(user.email);
  if (employeeEmail && userEmail && employeeEmail === userEmail) {
    return true;
  }

  const employeeName = normalizeWhitespace(employee.name).toLowerCase();
  const userName = normalizeWhitespace(user.name).toLowerCase();
  return Boolean(employeeName && userName && employeeName === userName);
}

function mergeEmployeeWriteForSalesperson(
  remoteEmployees: Employee[],
  localEmployees: Employee[],
  currentUser: AppUser
): Employee[] {
  const nextEmployees = [...remoteEmployees];
  const localSelfEntries = localEmployees.filter((employee) =>
    employeeMatchesUserIdentity(employee, currentUser)
  );

  for (const localEmployee of localSelfEntries) {
    const matchIndex = nextEmployees.findIndex((remoteEmployee) =>
      employeeMatchesUserIdentity(remoteEmployee, currentUser)
    );
    if (matchIndex >= 0) {
      nextEmployees[matchIndex] = {
        ...nextEmployees[matchIndex],
        ...localEmployee,
        id: nextEmployees[matchIndex].id || localEmployee.id,
        email: nextEmployees[matchIndex].email || localEmployee.email,
        name: nextEmployees[matchIndex].name || localEmployee.name,
        role: nextEmployees[matchIndex].role || localEmployee.role,
        companyId: nextEmployees[matchIndex].companyId || localEmployee.companyId,
      };
      continue;
    }

    nextEmployees.unshift(localEmployee);
  }

  return nextEmployees;
}

function canDirectlyReadRemoteStockists(role?: UserRole | null): boolean {
  return role === "admin" || role === "hr" || role === "manager";
}

async function filterByCompanyScope<T extends CompanyScoped>(
  items: T[],
  scope: CompanyScopeMode = "active"
): Promise<T[]> {
  if (scope === "active") {
    const companyId = await getActiveCompanyId();
    return items.filter((item) => matchesCompany(item, companyId));
  }

  const currentUser = await getCurrentUser();
  if (!currentUser || currentUser.role === "admin") {
    return items;
  }

  const allowedCompanyIds = new Set(
    (currentUser.companyIds || [currentUser.companyId])
      .map((companyId) => normalizeWhitespace(companyId))
      .filter((companyId) => Boolean(companyId))
  );
  return items.filter((item) => matchesCompanySet(item, allowedCompanyIds));
}

async function getItem<T>(key: string): Promise<T | null> {
  const localRaw = await AsyncStorage.getItem(key);
  const localValue = localRaw ? (JSON.parse(localRaw) as T) : null;
  if (!shouldSyncRemoteStateKey(key)) {
    return localValue;
  }
  void flushPendingRemoteStateWrites();

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
    let remoteValue = value;

    if (key === KEYS.EMPLOYEES && Array.isArray(value)) {
      const currentUser = await getCurrentUser().catch(() => null);
      if (!currentUser) {
        remoteValue = (await fetchStateRemote<T>(key)) ?? value;
      } else if (currentUser.role === "salesperson") {
        const remoteEmployees = (await fetchStateRemote<Employee[]>(key)) || [];
        remoteValue = mergeEmployeeWriteForSalesperson(
          remoteEmployees,
          value as Employee[],
          currentUser
        ) as T;
      }
    }

    const pushed = await pushStateRemote(key, remoteValue);
    if (!pushed) {
      await enqueuePendingRemoteStateWrite(key, remoteValue);
    } else {
      await removePendingRemoteStateWrite(key);
      void flushPendingRemoteStateWrites();
    }
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
  const assignedStockistId = normalizeWhitespace(entry.assignedStockistId ?? "");
  const assignedStockistName = normalizeWhitespace(entry.assignedStockistName ?? "");
  const approvedRole = entry.approvedRole ? normalizeRole(entry.approvedRole) : null;
  return {
    ...entry,
    name: normalizeWhitespace(entry.name),
    email: normalizeEmail(entry.email),
    approvedRole,
    requestedDepartment: normalizeWhitespace(entry.requestedDepartment),
    requestedBranch: normalizeWhitespace(entry.requestedBranch),
    requestedPincode: normalizePincode(entry.requestedPincode),
    requestedCompanyName: entry.requestedCompanyName
      ? sanitizeCompanyName(entry.requestedCompanyName)
      : undefined,
    assignedCompanyIds: Array.from(
      new Set((entry.assignedCompanyIds || []).map((id) => normalizeWhitespace(id)).filter(Boolean))
    ),
    assignedManagerId: assignedManagerId || null,
    assignedManagerName: assignedManagerName || null,
    assignedStockistId: assignedStockistId || null,
    assignedStockistName: assignedStockistName || null,
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

async function ensureCompanyProfilesSeeded(): Promise<void> {
  const existing = (await getItem<CompanyProfile[]>(KEYS.COMPANIES)) || [];
  if (!existing.length) {
    await setItem(KEYS.COMPANIES, []);
    return;
  }
  const cleaned = existing.filter((profile) => {
    const name = sanitizeCompanyName(profile.name).toLowerCase();
    if (!name) return false;
    if (name.includes("trackforce")) return false;
    if (name === "google") return false;
    if (name === "google india") return false;
    return true;
  });
  const normalized = cleaned.map((profile) => normalizeCompanyProfile(profile));
  await setItem(KEYS.COMPANIES, normalized);
}

async function ensurePendingCompanyProfile(): Promise<CompanyProfile> {
  const companies = await getCompanyProfiles();
  const pending = companies.find((company) => company.id === PENDING_COMPANY_ID);
  if (pending) return pending;
  const created = normalizeCompanyProfile(buildPendingCompanyProfile());
  await setItem(KEYS.COMPANIES, [created, ...companies]);
  return created;
}

async function ensureAuthUsersSeeded(): Promise<void> {
  const existing = await getAuthUsersRaw();
  if (!existing.length) {
    await setAuthUsersRaw([]);
    return;
  }

  const normalized: StoredAuthUser[] = [];
  for (const entry of existing) {
    const user = normalizeUserProfile(entry.user);
    let passwordHash = entry.passwordHash;
    if (!passwordHash) {
      passwordHash = await hashPassword("changeme123");
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

async function purgeLegacyDemoProfiles(): Promise<void> {
  const [authUsers, employees, accessRequests] = await Promise.all([
    getAuthUsersRaw(),
    getItem<Employee[]>(KEYS.EMPLOYEES).then((value) => value || []),
    getAccessRequestsRaw(),
  ]);
  if (!hasAnyLegacyDemoProfile(authUsers, employees, accessRequests)) {
    return;
  }

  const removedUserIds = new Set<string>();
  const removedNames = new Set<string>();

  const filteredAuthUsers = authUsers.filter((entry) => {
    const isDemo = isLegacyDemoEmail(entry.user.email);
    if (!isDemo) return true;
    if (entry.user.id) removedUserIds.add(entry.user.id);
    if (entry.user.name) removedNames.add(normalizeWhitespace(entry.user.name).toLowerCase());
    return false;
  });
  if (filteredAuthUsers.length !== authUsers.length) {
    await setAuthUsersRaw(filteredAuthUsers);
  }

  const filteredEmployees = employees.filter((entry) => {
    const normalizedName = normalizeWhitespace(entry.name).toLowerCase();
    const isDemo =
      isLegacyDemoEmail(entry.email) ||
      removedUserIds.has(entry.id) ||
      removedNames.has(normalizedName);
    if (!isDemo) return true;
    removedUserIds.add(entry.id);
    removedNames.add(normalizedName);
    return false;
  });
  if (filteredEmployees.length !== employees.length) {
    await setItem(KEYS.EMPLOYEES, filteredEmployees);
  }

  const filteredAccessRequests = accessRequests.filter((entry) => !isLegacyDemoEmail(entry.email));
  if (filteredAccessRequests.length !== accessRequests.length) {
    await setAccessRequestsRaw(filteredAccessRequests);
  }

  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (currentUser && isLegacyDemoEmail(currentUser.email)) {
    await Promise.all([
      AsyncStorage.removeItem(KEYS.USER),
      AsyncStorage.removeItem(KEYS.API_TOKEN),
      AsyncStorage.removeItem(KEYS.CHECKED_IN),
    ]);
  }

  const idKeys = ["userId", "employeeId", "ownerId", "assignedTo", "createdById", "leadId"];
  const nameKeys = ["userName", "employeeName", "ownerName", "assignedToName", "createdByName", "leadName"];
  const emailKeys = ["email", "ownerEmail", "assignedToEmail", "createdByEmail"];
  const arrayIdKeys = ["memberIds", "assignedEmployeeIds", "participantIds", "audienceUserIds"];
  const pruneByUserIdentity = <T extends Record<string, unknown>>(entries: T[]): T[] =>
    entries.filter((entry) => {
      for (const key of idKeys) {
        const value = entry[key];
        if (typeof value === "string" && removedUserIds.has(value)) return false;
      }
      for (const key of nameKeys) {
        const value = entry[key];
        if (typeof value === "string" && removedNames.has(normalizeWhitespace(value).toLowerCase())) {
          return false;
        }
      }
      for (const key of emailKeys) {
        const value = entry[key];
        if (typeof value === "string" && isLegacyDemoEmail(value)) return false;
      }
      for (const key of arrayIdKeys) {
        const value = entry[key];
        if (!Array.isArray(value)) continue;
        if (value.some((item) => typeof item === "string" && removedUserIds.has(item))) return false;
      }
      return true;
    });

  const pruneKeys = [
    KEYS.ATTENDANCE,
    KEYS.SALARIES,
    KEYS.TASKS,
    KEYS.EXPENSES,
    KEYS.CONVERSATIONS,
    KEYS.AUDIT_LOGS,
    KEYS.TEAMS,
    KEYS.ATTENDANCE_PHOTOS,
    KEYS.ATTENDANCE_ANOMALIES,
    KEYS.LOCATION_LOGS,
    KEYS.DOLIBARR_SYNC_LOGS,
    KEYS.NOTIFICATIONS,
    KEYS.SUPPORT_THREADS,
  ];

  for (const key of pruneKeys) {
    const existing = (await getItem<Record<string, unknown>[]>(key)) || [];
    if (!existing.length) continue;
    const filtered = pruneByUserIdentity(existing);
    if (filtered.length !== existing.length) {
      await setItem(key, filtered);
    }
  }
}

async function ensureCurrentUserShape(): Promise<void> {
  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (!currentUser) return;
  const normalized = normalizeUserProfile(currentUser);
  await setItem(KEYS.USER, normalized);
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

async function runSeedMigrations(): Promise<void> {
  await ensureCompanyProfilesSeeded();
  await ensureAuthUsersSeeded();
  await ensureAccessRequestsSeeded();
  await ensureCurrentUserShape();

  const appliedVersion = await AsyncStorage.getItem(KEYS.SEED_VERSION);
  if (appliedVersion === SEED_VERSION) return;

  await Promise.all([
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
  await purgeLegacyDemoProfiles();

  await AsyncStorage.setItem(KEYS.SEED_VERSION, SEED_VERSION);
}

async function seedDataIfNeededInternal(): Promise<void> {
  const seeded = await AsyncStorage.getItem(KEYS.SEEDED);
  if (seeded) {
    await runSeedMigrations();
    return;
  }

  await Promise.all([
    setItem(KEYS.EMPLOYEES, []),
    setItem(KEYS.ATTENDANCE, []),
    setItem(KEYS.SALARIES, []),
    setItem(KEYS.TASKS, []),
    setItem(KEYS.EXPENSES, []),
    setItem(KEYS.CONVERSATIONS, []),
    setItem(KEYS.AUDIT_LOGS, []),
    setItem(KEYS.GEOFENCES, []),
    setItem(KEYS.TEAMS, []),
    setItem(KEYS.ATTENDANCE_PHOTOS, []),
    setItem(KEYS.ATTENDANCE_ANOMALIES, []),
    setItem(KEYS.LOCATION_LOGS, []),
    setItem(KEYS.DOLIBARR_SYNC_LOGS, []),
    setItem(KEYS.NOTIFICATIONS, []),
    setItem(KEYS.SUPPORT_THREADS, []),
    setItem(KEYS.ACCESS_REQUESTS, []),
    setItem(KEYS.ATTENDANCE_QUEUE, []),
    setItem(KEYS.COMPANIES, []),
    setItem(KEYS.AUTH_USERS, []),
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

export async function removeCompanyProfile(companyId: string): Promise<boolean> {
  await seedDataIfNeeded();
  const targetId = normalizeWhitespace(companyId);
  if (!targetId) return false;
  const companies = await getCompanyProfiles();
  const target = companies.find((company) => company.id === targetId);
  if (!target) return false;
  const remaining = companies.filter((company) => company.id !== targetId);
  if (remaining.length === 0) return false;

  const companyById = new Map(remaining.map((company) => [company.id, company]));
  const fallbackCompany = remaining[0];

  await setItem(KEYS.COMPANIES, remaining);

  const settingsStore = await getSettingsStore();
  if (targetId in settingsStore) {
    const { [targetId]: _, ...rest } = settingsStore;
    await setItem(KEYS.SETTINGS, rest);
  }

  const authUsers = await getAuthUsersRaw();
  let authChanged = false;
  const nextAuthUsers = authUsers.map((entry) => {
    const currentUser = entry.user;
    const filteredCompanyIds = (currentUser.companyIds || [])
      .map((id) => normalizeWhitespace(id))
      .filter((id) => id && id !== targetId && companyById.has(id));
    let nextCompanyId = normalizeWhitespace(currentUser.companyId);
    if (!nextCompanyId || nextCompanyId === targetId || !companyById.has(nextCompanyId)) {
      nextCompanyId = filteredCompanyIds[0] || fallbackCompany.id;
    }
    const nextCompanyName =
      companyById.get(nextCompanyId)?.name || fallbackCompany.name || DEFAULT_COMPANY_NAME;
    const normalized = normalizeUserProfile({
      ...currentUser,
      companyId: nextCompanyId,
      companyName: nextCompanyName,
      companyIds: normalizeCompanyIds(filteredCompanyIds, nextCompanyId),
    });
    const companyIdsChanged =
      JSON.stringify(normalized.companyIds || []) !== JSON.stringify(currentUser.companyIds || []);
    if (
      normalized.companyId !== currentUser.companyId ||
      normalized.companyName !== currentUser.companyName ||
      companyIdsChanged
    ) {
      authChanged = true;
      return {
        ...entry,
        user: normalized,
        updatedAt: new Date().toISOString(),
      };
    }
    return entry;
  });
  if (authChanged) {
    await setAuthUsersRaw(nextAuthUsers);
  }

  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (currentUser) {
    const filteredCompanyIds = (currentUser.companyIds || [])
      .map((id) => normalizeWhitespace(id))
      .filter((id) => id && id !== targetId && companyById.has(id));
    let nextCompanyId = normalizeWhitespace(currentUser.companyId);
    if (!nextCompanyId || nextCompanyId === targetId || !companyById.has(nextCompanyId)) {
      nextCompanyId = filteredCompanyIds[0] || fallbackCompany.id;
    }
    const nextCompanyName =
      companyById.get(nextCompanyId)?.name || fallbackCompany.name || DEFAULT_COMPANY_NAME;
    const normalized = normalizeUserProfile({
      ...currentUser,
      companyId: nextCompanyId,
      companyName: nextCompanyName,
      companyIds: normalizeCompanyIds(filteredCompanyIds, nextCompanyId),
    });
    const companyIdsChanged =
      JSON.stringify(normalized.companyIds || []) !== JSON.stringify(currentUser.companyIds || []);
    if (
      normalized.companyId !== currentUser.companyId ||
      normalized.companyName !== currentUser.companyName ||
      companyIdsChanged
    ) {
      await setItem(KEYS.USER, normalized);
    }
  }

  const employees = await getRawList<Employee>(KEYS.EMPLOYEES);
  const filteredEmployees = employees.filter((employee) => employee.companyId !== targetId);
  if (filteredEmployees.length !== employees.length) {
    await setItem(KEYS.EMPLOYEES, filteredEmployees);
  }

  const accessRequests = await getAccessRequestsRaw();
  let accessChanged = false;
  const filteredRequests = accessRequests.map((request) => {
    if (!request.assignedCompanyIds?.length) return request;
    const nextIds = request.assignedCompanyIds.filter(
      (id) => id !== targetId && companyById.has(id)
    );
    if (nextIds.length === request.assignedCompanyIds.length) return request;
    accessChanged = true;
    return { ...request, assignedCompanyIds: nextIds };
  });
  if (accessChanged) {
    await setAccessRequestsRaw(filteredRequests);
  }

  return true;
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
    pincode: user.pincode,
    joinDate: user.joinDate,
    avatar: user.avatar,
    managerId: user.managerId,
    managerName: user.managerName,
    stockistId: user.stockistId,
    stockistName: user.stockistName,
  };

  if (existingIndex >= 0) {
    employees[existingIndex] = baseEmployee;
  } else {
    employees.unshift(baseEmployee);
  }
  await setItem(KEYS.EMPLOYEES, employees);
}

function resolveStoredAuthApprovalStatus(entry: StoredAuthUser): "pending" | "approved" | "rejected" {
  if (entry.approvalStatus === "pending" || entry.approvalStatus === "rejected") {
    return entry.approvalStatus;
  }
  if (entry.user.approvalStatus === "pending" || entry.user.approvalStatus === "rejected") {
    return entry.user.approvalStatus;
  }
  return "approved";
}

function hasAnyApprovedAdmin(authUsers: StoredAuthUser[]): boolean {
  return authUsers.some((entry) => {
    if (resolveStoredAuthApprovalStatus(entry) !== "approved") return false;
    return entry.user.role === "admin";
  });
}

export async function registerUser(input: RegisterUserInput): Promise<RegisterUserResult> {
  await seedDataIfNeeded();

  const name = normalizeWhitespace(input.name);
  const email = normalizeEmail(input.email);
  const password = input.password;
  const requestedCompanyName = sanitizeCompanyName(input.companyName);
  const requestedBranch = normalizeWhitespace(input.branch ?? "");
  const requestedPincode = normalizePincode(input.pincode);

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
  const now = new Date().toISOString();
  const adminAlreadyExists = hasAnyApprovedAdmin(authUsers);
  if (role === "salesperson" && (!requestedBranch || !requestedPincode)) {
    return { ok: false, message: "Location and pincode are required for salesperson signup" };
  }
  if (role === "admin" && !adminAlreadyExists) {
    const adminCompany = await ensurePendingCompanyProfile();
    const adminUser = normalizeUserProfile({
      id: makeId("u"),
      name,
      email,
      role: "admin",
      companyId: adminCompany.id,
      companyName: adminCompany.name,
      companyIds: [adminCompany.id],
      department: normalizeWhitespace(input.department ?? "") || roleToDepartment("admin"),
      branch: requestedBranch || adminCompany.primaryBranch,
      phone: normalizePhone(input.phone),
      pincode: requestedPincode,
      joinDate: now.slice(0, 10),
      approvalStatus: "approved",
    });
    authUsers.unshift({
      user: adminUser,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved",
      requestedCompanyName,
    });
    await setAuthUsersRaw(authUsers);
    await upsertEmployeeForCompany(adminUser, adminCompany);
    await setItem(KEYS.USER, adminUser);
    return {
      ok: true,
      message: "Admin account created successfully.",
      user: adminUser,
      company: adminCompany,
    };
  }
  const fallbackCompany = await ensurePendingCompanyProfile();

  const pendingUser = normalizeUserProfile({
    id: makeId("u"),
    name,
    email,
    role,
    companyId: fallbackCompany.id,
    companyName: fallbackCompany.name,
    companyIds: [fallbackCompany.id],
    department: normalizeWhitespace(input.department ?? "") || roleToDepartment(role),
    branch: requestedBranch || fallbackCompany.primaryBranch,
    phone: normalizePhone(input.phone),
    pincode: requestedPincode,
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
    requestedPincode: pendingUser.pincode,
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
    assignedStockistId: null,
    assignedStockistName: null,
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
    stockistId?: string;
    stockistName?: string;
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
  const isSalesperson = action === "approved" && finalApprovedRole === "salesperson";
  const shouldAssignManager = action === "approved" && finalApprovedRole !== "salesperson";
  const normalizedManagerId = shouldAssignManager ? normalizeWhitespace(options?.managerId ?? "") : "";
  const normalizedManagerName = shouldAssignManager
    ? normalizeWhitespace(options?.managerName ?? "")
    : "";
  const normalizedStockistId = isSalesperson ? normalizeWhitespace(options?.stockistId ?? "") : "";
  const normalizedStockistName = isSalesperson
    ? normalizeWhitespace(options?.stockistName ?? "")
    : "";
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
  const selectedManager =
    shouldAssignManager && normalizedManagerId
      ? employees.find(
          (employee) => employee.id === normalizedManagerId && employee.role === "manager"
        ) || null
      : null;
  if (shouldAssignManager && normalizedManagerId && !selectedManager) {
    throw new Error("Selected manager is invalid.");
  }
  if (
    shouldAssignManager &&
    normalizedManagerId &&
    selectedManager &&
    normalizedCompanyIds.length > 0 &&
    !normalizedCompanyIds.includes(selectedManager.companyId)
  ) {
    throw new Error("Selected manager must belong to an assigned company.");
  }
  const assignedManagerId = shouldAssignManager ? normalizedManagerId || null : null;
  const assignedManagerName = shouldAssignManager
    ? selectedManager?.name || normalizedManagerName || null
    : null;

  const stockists = await getRawList<StockistProfile>(KEYS.STOCKISTS);
  const selectedStockist =
    isSalesperson && normalizedStockistId
      ? stockists.find((stockist) => stockist.id === normalizedStockistId) || null
      : null;
  if (isSalesperson && normalizedStockistId && !selectedStockist) {
    throw new Error("Selected channel partner is invalid.");
  }
  if (
    isSalesperson &&
    selectedStockist?.companyId &&
    normalizedCompanyIds.length > 0 &&
    !normalizedCompanyIds.includes(normalizeWhitespace(selectedStockist.companyId))
  ) {
    throw new Error("Selected channel partner must belong to an assigned company.");
  }
  const assignedStockistId = isSalesperson ? normalizedStockistId || null : null;
  const assignedStockistName = isSalesperson
    ? selectedStockist?.name || normalizedStockistName || null
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
      stockistId: assignedStockistId || undefined,
      stockistName: assignedStockistName || undefined,
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
    await syncStockistSalespersonAssignmentLocal(approvedUser.id, assignedStockistId);

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
    await syncStockistSalespersonAssignmentLocal(currentAuth.user.id, null);
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
    assignedStockistId,
    assignedStockistName,
  };
  requests[requestIndex] = reviewedRequest;
  await setAccessRequestsRaw(requests);
  return reviewedRequest;
}

export async function authenticateUser(identifier: string, password: string): Promise<AppUser | null> {
  await seedDataIfNeeded();
  const normalizedEmail = normalizeEmail(identifier);
  const normalizedLogin = normalizeLogin(identifier);
  const isEmailIdentifier = normalizedEmail.includes("@");
  const users = await getAuthUsersRaw();
  const match = users.find((entry) => {
    const emailValue = normalizeEmail(entry.user.email);
    if (isEmailIdentifier) {
      return emailValue === normalizedEmail;
    }
    const loginValue = normalizeLogin(entry.user.login || "");
    const emailPrefix = emailValue.split("@")[0] || "";
    return (
      (loginValue && loginValue === normalizedLogin) ||
      (emailPrefix && emailPrefix === normalizedLogin)
    );
  });
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
  const previousUser = await getCurrentUser();
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

  if (previousUser?.id && previousUser.id !== hydratedUser.id) {
    const tokenStore = await readApiTokenStore(previousUser);
    const fallbackToken =
      tokenStore[hydratedUser.id] ||
      tokenStore[previousUser.id] ||
      tokenStore[GLOBAL_API_TOKEN_KEY] ||
      null;
    if (fallbackToken && !tokenStore[hydratedUser.id]) {
      tokenStore[hydratedUser.id] = fallbackToken;
      tokenStore[GLOBAL_API_TOKEN_KEY] = fallbackToken;
      await writeApiTokenStore(tokenStore);
    }
  }

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
const GLOBAL_API_TOKEN_KEY = "__global__";

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

  const trimmed = raw.trim();
  if (!trimmed) return {};
  const user = currentUser || (await getItem<AppUser>(KEYS.USER));
  if (!user?.id) {
    return { [GLOBAL_API_TOKEN_KEY]: trimmed };
  }
  return {
    [user.id]: trimmed,
    [GLOBAL_API_TOKEN_KEY]: trimmed,
  };
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
    const removedToken = tokenStore[current.id];
    delete tokenStore[current.id];
    if (removedToken && tokenStore[GLOBAL_API_TOKEN_KEY] === removedToken) {
      const nextToken = Object.entries(tokenStore).find(
        ([key, value]) =>
          key !== GLOBAL_API_TOKEN_KEY && typeof value === "string" && value.trim().length > 0
      )?.[1];
      if (nextToken) {
        tokenStore[GLOBAL_API_TOKEN_KEY] = nextToken;
      } else {
        delete tokenStore[GLOBAL_API_TOKEN_KEY];
      }
    }
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

export async function addSalaryRecord(record: SalaryRecord): Promise<void> {
  const companyId = await getActiveCompanyId();
  const salaries = await getRawList<SalaryRecord>(KEYS.SALARIES);
  const nextRecord = withCompanyId(record, companyId ?? record.companyId ?? DEFAULT_COMPANY_ID);
  const filtered = salaries.filter((entry) => entry.id !== record.id);
  filtered.unshift(nextRecord);
  await setItem(KEYS.SALARIES, filtered);
}

export async function deleteSalaryRecordLocal(salaryId: string): Promise<void> {
  const companyId = await getActiveCompanyId();
  const salaries = await getRawList<SalaryRecord>(KEYS.SALARIES);
  const filtered = salaries.filter(
    (salary) => !(salary.id === salaryId && matchesCompany(salary, companyId))
  );
  await setItem(KEYS.SALARIES, filtered);
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

export async function updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
  const companyId = await getActiveCompanyId();
  const tasks = await getRawList<Task>(KEYS.TASKS);
  const idx = tasks.findIndex((task) => task.id === taskId && matchesCompany(task, companyId));
  if (idx === -1) return null;
  const updatedTask: Task = {
    ...tasks[idx],
    ...updates,
  };
  tasks[idx] = updatedTask;
  await setItem(KEYS.TASKS, tasks);
  return updatedTask;
}

export async function removeTask(taskId: string): Promise<boolean> {
  const companyId = await getActiveCompanyId();
  const tasks = await getRawList<Task>(KEYS.TASKS);
  const nextTasks = tasks.filter(
    (task) => !(task.id === taskId && matchesCompany(task, companyId))
  );
  if (nextTasks.length === tasks.length) return false;
  await setItem(KEYS.TASKS, nextTasks);
  return true;
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

function normalizeStockistName(value: string): string {
  return normalizeWhitespace(value) || "Channel Partner";
}

function normalizeItemName(value: string): string {
  return normalizeWhitespace(value) || "Item";
}

function normalizeUnitLabel(value?: string): string | undefined {
  const cleaned = normalizeWhitespace(value ?? "");
  return cleaned || undefined;
}

function normalizeIncentiveTitle(value: string): string {
  return normalizeWhitespace(value) || "Incentive Plan";
}

function normalizeIncentiveProductName(value: string): string {
  return normalizeWhitespace(value) || "Product";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export async function getStockists(options?: {
  scope?: CompanyScopeMode;
  refreshRemote?: boolean;
}): Promise<StockistProfile[]> {
  let stockists: StockistProfile[] | null | undefined = undefined;

  if (options?.refreshRemote) {
    stockists = await refreshStockistsFromBackend();
  }

  const resolved = Array.isArray(stockists) ? stockists : await getRawList<StockistProfile>(KEYS.STOCKISTS);
  return filterByCompanyScope(resolved, options?.scope ?? "active");
}

export async function addStockist(
  input: Omit<StockistProfile, "id" | "companyId" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<StockistProfile> {
  const companyId = await getActiveCompanyId();
  const now = new Date().toISOString();
  const candidate: StockistProfile = withCompanyId<StockistProfile>(
    {
      id: input.id || makeId("stockist"),
      name: normalizeStockistName(input.name),
      phone: normalizeWhitespace(input.phone ?? "") || undefined,
      location: normalizeWhitespace(input.location ?? "") || undefined,
      pincode: normalizePincode(input.pincode),
      notes: normalizeWhitespace(input.notes ?? "") || undefined,
      assignedSalespersonIds: normalizeStringIdList(input.assignedSalespersonIds),
      createdAt: now,
      updatedAt: now,
    },
    companyId
  );
  const stockists = await getLatestRemoteSyncedList<StockistProfile>(
    KEYS.STOCKISTS,
    refreshStockistsFromBackend
  );
  stockists.unshift(candidate);
  await setItem(KEYS.STOCKISTS, stockists);
  return candidate;
}

export async function syncStockistsToBackend(options?: { force?: boolean }): Promise<boolean> {
  const stockists = await getRawList<StockistProfile>(KEYS.STOCKISTS);
  if (!options?.force && !shouldSyncRemoteStateKey(KEYS.STOCKISTS)) {
    return false;
  }
  const pushed = await pushStateRemote(KEYS.STOCKISTS, stockists);
  if (!pushed) {
    await enqueuePendingRemoteStateWrite(KEYS.STOCKISTS, stockists);
    return false;
  }
  await removePendingRemoteStateWrite(KEYS.STOCKISTS);
  return true;
}

export async function refreshStockistsFromBackend(): Promise<StockistProfile[] | null> {
  await seedDataIfNeeded();
  const direct = await fetchStockistsRemote();
  if (typeof direct !== "undefined") {
    const normalized = Array.isArray(direct) ? direct : [];
    await AsyncStorage.setItem(KEYS.STOCKISTS, JSON.stringify(normalized));
    return normalized;
  }
  const remote = await fetchStateRemote<StockistProfile[]>(KEYS.STOCKISTS);
  if (typeof remote === "undefined") return null;
  const normalized = Array.isArray(remote) ? remote : [];
  await AsyncStorage.setItem(KEYS.STOCKISTS, JSON.stringify(normalized));
  return normalized;
}

export async function clearLocalStockists(): Promise<void> {
  await AsyncStorage.setItem(KEYS.STOCKISTS, JSON.stringify([]));
  await removePendingRemoteStateWrite(KEYS.STOCKISTS);
  const event: StorageUpdateEvent = {
    key: KEYS.STOCKISTS,
    updatedAt: new Date().toISOString(),
  };
  for (const listener of storageUpdateListeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
}

export async function updateStockist(
  stockistId: string,
  updates: Partial<StockistProfile>
): Promise<StockistProfile | null> {
  const companyId = await getActiveCompanyId();
  const stockists = await getLatestRemoteSyncedList<StockistProfile>(
    KEYS.STOCKISTS,
    refreshStockistsFromBackend
  );
  const idx = stockists.findIndex(
    (stockist) => stockist.id === stockistId && matchesCompany(stockist, companyId)
  );
  if (idx === -1) return null;
  const current = stockists[idx];
  const updated: StockistProfile = {
    ...current,
    name: updates.name ? normalizeStockistName(updates.name) : current.name,
    phone:
      updates.phone !== undefined
        ? normalizeWhitespace(updates.phone) || undefined
        : current.phone,
    location:
      updates.location !== undefined
        ? normalizeWhitespace(updates.location) || undefined
        : current.location,
    pincode: updates.pincode !== undefined ? normalizePincode(updates.pincode) : current.pincode,
    notes:
      updates.notes !== undefined
        ? normalizeWhitespace(updates.notes) || undefined
        : current.notes,
    assignedSalespersonIds:
      updates.assignedSalespersonIds !== undefined
        ? normalizeStringIdList(updates.assignedSalespersonIds)
        : normalizeStringIdList(current.assignedSalespersonIds),
    updatedAt: new Date().toISOString(),
  };
  stockists[idx] = updated;
  await setItem(KEYS.STOCKISTS, stockists);
  return updated;
}

async function syncStockistSalespersonAssignmentLocal(
  salespersonId: string,
  nextStockistId: string | null
): Promise<void> {
  const normalizedSalespersonId = normalizeWhitespace(salespersonId);
  if (!normalizedSalespersonId) return;
  const normalizedNextStockistId = normalizeWhitespace(nextStockistId ?? "");
  const timestamp = new Date().toISOString();
  const stockists = await getLatestRemoteSyncedList<StockistProfile>(
    KEYS.STOCKISTS,
    refreshStockistsFromBackend
  );
  let changed = false;
  const nextStockists = stockists.map((stockist) => {
    const currentIds = normalizeStringIdList(stockist.assignedSalespersonIds);
    let nextIds = currentIds.filter((id) => id !== normalizedSalespersonId);
    if (normalizedNextStockistId && stockist.id === normalizedNextStockistId) {
      nextIds = normalizeStringIdList([...nextIds, normalizedSalespersonId]);
    }
    if (JSON.stringify(nextIds) === JSON.stringify(currentIds)) {
      return stockist;
    }
    changed = true;
    return {
      ...stockist,
      assignedSalespersonIds: nextIds,
      updatedAt: timestamp,
    };
  });
  if (changed) {
    await setItem(KEYS.STOCKISTS, nextStockists);
  }
}

export async function resolveAssignedStockistForUser(
  user: Pick<AppUser, "id" | "companyId" | "companyIds" | "stockistId"> | null | undefined
): Promise<StockistProfile | null> {
  const normalizedUserId = normalizeWhitespace(user?.id ?? "");
  const normalizedUserStockistId = normalizeWhitespace(user?.stockistId ?? "");
  if (!normalizedUserId && !normalizedUserStockistId) return null;

  const fallbackCompanyId =
    normalizeWhitespace(user?.companyId ?? DEFAULT_COMPANY_ID) || DEFAULT_COMPANY_ID;
  const allowedCompanyIds = new Set(normalizeCompanyIds(user?.companyIds, fallbackCompanyId));
  const stockists = await getRawList<StockistProfile>(KEYS.STOCKISTS);

  const byMappedSalesperson = normalizedUserId
    ? stockists.find(
        (stockist) =>
          normalizeStringIdList(stockist.assignedSalespersonIds).includes(normalizedUserId) &&
          matchesCompanySet(stockist, allowedCompanyIds)
      ) || null
    : null;
  if (byMappedSalesperson) return byMappedSalesperson;

  if (normalizedUserStockistId) {
    const matchedStockist =
      stockists.find(
        (stockist) =>
          stockist.id === normalizedUserStockistId && matchesCompanySet(stockist, allowedCompanyIds)
      ) || null;
    if (matchedStockist && normalizedUserId) {
      const assignedIds = normalizeStringIdList(matchedStockist.assignedSalespersonIds);
      if (!assignedIds.includes(normalizedUserId)) {
        await syncStockistSalespersonAssignmentLocal(normalizedUserId, matchedStockist.id);
      }
    }
    return matchedStockist;
  }

  return null;
}

export async function removeStockist(stockistId: string): Promise<boolean> {
  const companyId = await getActiveCompanyId();
  const stockists = await getLatestRemoteSyncedList<StockistProfile>(
    KEYS.STOCKISTS,
    refreshStockistsFromBackend
  );
  const nextStockists = stockists.filter(
    (stockist) => !(stockist.id === stockistId && matchesCompany(stockist, companyId))
  );
  if (nextStockists.length === stockists.length) return false;
  await setItem(KEYS.STOCKISTS, nextStockists);

  const transfers = await getLatestRemoteSyncedList<StockTransfer>(
    KEYS.STOCK_TRANSFERS,
    refreshStockTransfersFromBackend
  );
  const nextTransfers = transfers.filter(
    (transfer) => !(transfer.stockistId === stockistId && matchesCompany(transfer, companyId))
  );
  if (nextTransfers.length !== transfers.length) {
    await setItem(KEYS.STOCK_TRANSFERS, nextTransfers);
  }
  return true;
}

export async function getStockTransfers(options?: {
  scope?: CompanyScopeMode;
  refreshRemote?: boolean;
}): Promise<StockTransfer[]> {
  const transfers = options?.refreshRemote
    ? (await refreshStockTransfersFromBackend()) ??
      (await getRawList<StockTransfer>(KEYS.STOCK_TRANSFERS))
    : await getRawList<StockTransfer>(KEYS.STOCK_TRANSFERS);
  return filterByCompanyScope(transfers, options?.scope ?? "active");
}

export async function refreshStockTransfersFromBackend(): Promise<StockTransfer[] | null> {
  return refreshRemoteStateList<StockTransfer>(KEYS.STOCK_TRANSFERS);
}

function applyStockTransferToStockist(
  stockist: StockistProfile,
  transfer: StockTransfer
): StockistProfile {
  const quantity = Number.isFinite(transfer.quantity) ? Math.max(0, transfer.quantity) : 0;
  const currentIn = Number.isFinite(stockist.stockIn ?? Number.NaN) ? Number(stockist.stockIn) : 0;
  const currentOut = Number.isFinite(stockist.stockOut ?? Number.NaN) ? Number(stockist.stockOut) : 0;
  const nextIn = transfer.type === "in" ? currentIn + quantity : currentIn;
  const nextOut = transfer.type === "out" ? currentOut + quantity : currentOut;
  const timestamp = transfer.createdAt || new Date().toISOString();
  return {
    ...stockist,
    companyId: stockist.companyId || transfer.companyId,
    stockIn: nextIn,
    stockOut: nextOut,
    stockBalance: nextIn - nextOut,
    lastStockUpdate: timestamp,
    updatedAt: timestamp,
  };
}

export async function addStockTransfer(transfer: StockTransfer): Promise<void> {
  const activeCompanyId = await getActiveCompanyId();
  const now = new Date().toISOString();
  const stockists = await getLatestRemoteSyncedList<StockistProfile>(
    KEYS.STOCKISTS,
    refreshStockistsFromBackend
  );
  const matchedStockist = stockists.find((entry) => entry.id === transfer.stockistId) || null;
  const resolvedCompanyId =
    normalizeWhitespace(
      matchedStockist?.companyId ?? transfer.companyId ?? activeCompanyId ?? DEFAULT_COMPANY_ID
    ) || DEFAULT_COMPANY_ID;
  const resolvedStockistName = normalizeStockistName(matchedStockist?.name ?? transfer.stockistName);
  const candidate: StockTransfer = {
    ...transfer,
    id: transfer.id || makeId("stock_transfer"),
    companyId: resolvedCompanyId,
    stockistId: transfer.stockistId,
    stockistName: resolvedStockistName,
    itemName: normalizeItemName(transfer.itemName),
    unitLabel: normalizeUnitLabel(transfer.unitLabel),
    note: normalizeWhitespace(transfer.note ?? "") || undefined,
    quantity: Number.isFinite(transfer.quantity) ? Math.max(0, transfer.quantity) : 0,
    createdAt: transfer.createdAt || now,
  };
  const transfers = await getLatestRemoteSyncedList<StockTransfer>(
    KEYS.STOCK_TRANSFERS,
    refreshStockTransfersFromBackend
  );
  transfers.unshift(candidate);
  await setItem(KEYS.STOCK_TRANSFERS, transfers.slice(0, 5000));
  if (matchedStockist) {
    const nextStockists = stockists.map((stockist) =>
      stockist.id === matchedStockist.id ? applyStockTransferToStockist(stockist, candidate) : stockist
    );
    await setItem(KEYS.STOCKISTS, nextStockists);
  }
}

export async function refreshIncentiveGoalPlansFromBackend(): Promise<IncentiveGoalPlan[] | null> {
  return refreshRemoteStateList<IncentiveGoalPlan>(KEYS.INCENTIVE_GOAL_PLANS);
}

export async function getIncentiveGoalPlans(options?: {
  refreshRemote?: boolean;
}): Promise<IncentiveGoalPlan[]> {
  const companyId = await getActiveCompanyId();
  const plans = options?.refreshRemote
    ? (await refreshIncentiveGoalPlansFromBackend()) ??
      (await getRawList<IncentiveGoalPlan>(KEYS.INCENTIVE_GOAL_PLANS))
    : await getRawList<IncentiveGoalPlan>(KEYS.INCENTIVE_GOAL_PLANS);
  return plans.filter((plan) => matchesCompany(plan, companyId));
}

export async function addIncentiveGoalPlan(
  input: Omit<IncentiveGoalPlan, "id" | "companyId" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<IncentiveGoalPlan> {
  const companyId = await getActiveCompanyId();
  const now = new Date().toISOString();
  const candidate: IncentiveGoalPlan = withCompanyId<IncentiveGoalPlan>(
    {
      ...input,
      id: input.id || makeId("goal_incentive"),
      title: normalizeIncentiveTitle(input.title),
      targetQty: Number.isFinite(input.targetQty) ? Math.max(0, input.targetQty) : 0,
      thresholdPercent: clampPercent(input.thresholdPercent),
      perUnitAmount: Number.isFinite(input.perUnitAmount) ? Math.max(0, input.perUnitAmount) : 0,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    },
    companyId
  );
  const plans = await getLatestRemoteSyncedList<IncentiveGoalPlan>(
    KEYS.INCENTIVE_GOAL_PLANS,
    refreshIncentiveGoalPlansFromBackend
  );
  plans.unshift(candidate);
  await setItem(KEYS.INCENTIVE_GOAL_PLANS, plans);
  return candidate;
}

export async function updateIncentiveGoalPlan(
  planId: string,
  updates: Partial<IncentiveGoalPlan>
): Promise<IncentiveGoalPlan | null> {
  const companyId = await getActiveCompanyId();
  const plans = await getLatestRemoteSyncedList<IncentiveGoalPlan>(
    KEYS.INCENTIVE_GOAL_PLANS,
    refreshIncentiveGoalPlansFromBackend
  );
  const idx = plans.findIndex((plan) => plan.id === planId && matchesCompany(plan, companyId));
  if (idx === -1) return null;
  const current = plans[idx];
  const updated: IncentiveGoalPlan = {
    ...current,
    title: updates.title ? normalizeIncentiveTitle(updates.title) : current.title,
    targetQty:
      updates.targetQty !== undefined
        ? Math.max(0, Number(updates.targetQty) || 0)
        : current.targetQty,
    thresholdPercent:
      updates.thresholdPercent !== undefined
        ? clampPercent(Number(updates.thresholdPercent))
        : current.thresholdPercent,
    perUnitAmount:
      updates.perUnitAmount !== undefined
        ? Math.max(0, Number(updates.perUnitAmount) || 0)
        : current.perUnitAmount,
    active: updates.active !== undefined ? updates.active : current.active,
    period: updates.period || current.period,
    updatedAt: new Date().toISOString(),
  };
  plans[idx] = updated;
  await setItem(KEYS.INCENTIVE_GOAL_PLANS, plans);
  return updated;
}

export async function removeIncentiveGoalPlan(planId: string): Promise<boolean> {
  const companyId = await getActiveCompanyId();
  const plans = await getLatestRemoteSyncedList<IncentiveGoalPlan>(
    KEYS.INCENTIVE_GOAL_PLANS,
    refreshIncentiveGoalPlansFromBackend
  );
  const nextPlans = plans.filter((plan) => !(plan.id === planId && matchesCompany(plan, companyId)));
  if (nextPlans.length === plans.length) return false;
  await setItem(KEYS.INCENTIVE_GOAL_PLANS, nextPlans);
  return true;
}

export async function refreshIncentiveProductPlansFromBackend(): Promise<IncentiveProductPlan[] | null> {
  return refreshRemoteStateList<IncentiveProductPlan>(KEYS.INCENTIVE_PRODUCT_PLANS);
}

export async function getIncentiveProductPlans(options?: {
  refreshRemote?: boolean;
}): Promise<IncentiveProductPlan[]> {
  const companyId = await getActiveCompanyId();
  const plans = options?.refreshRemote
    ? (await refreshIncentiveProductPlansFromBackend()) ??
      (await getRawList<IncentiveProductPlan>(KEYS.INCENTIVE_PRODUCT_PLANS))
    : await getRawList<IncentiveProductPlan>(KEYS.INCENTIVE_PRODUCT_PLANS);
  return plans.filter((plan) => matchesCompany(plan, companyId));
}

export async function addIncentiveProductPlan(
  input: Omit<IncentiveProductPlan, "id" | "companyId" | "createdAt" | "updatedAt"> & { id?: string }
): Promise<IncentiveProductPlan> {
  const companyId = await getActiveCompanyId();
  const now = new Date().toISOString();
  const candidate: IncentiveProductPlan = withCompanyId<IncentiveProductPlan>(
    {
      ...input,
      id: input.id || makeId("product_incentive"),
      productName: normalizeIncentiveProductName(input.productName),
      perUnitAmount: Number.isFinite(input.perUnitAmount) ? Math.max(0, input.perUnitAmount) : 0,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    },
    companyId
  );
  const plans = await getLatestRemoteSyncedList<IncentiveProductPlan>(
    KEYS.INCENTIVE_PRODUCT_PLANS,
    refreshIncentiveProductPlansFromBackend
  );
  plans.unshift(candidate);
  await setItem(KEYS.INCENTIVE_PRODUCT_PLANS, plans);
  return candidate;
}

export async function updateIncentiveProductPlan(
  planId: string,
  updates: Partial<IncentiveProductPlan>
): Promise<IncentiveProductPlan | null> {
  const companyId = await getActiveCompanyId();
  const plans = await getLatestRemoteSyncedList<IncentiveProductPlan>(
    KEYS.INCENTIVE_PRODUCT_PLANS,
    refreshIncentiveProductPlansFromBackend
  );
  const idx = plans.findIndex((plan) => plan.id === planId && matchesCompany(plan, companyId));
  if (idx === -1) return null;
  const current = plans[idx];
  const updated: IncentiveProductPlan = {
    ...current,
    productName: updates.productName
      ? normalizeIncentiveProductName(updates.productName)
      : current.productName,
    productId: updates.productId !== undefined ? updates.productId : current.productId,
    perUnitAmount:
      updates.perUnitAmount !== undefined
        ? Math.max(0, Number(updates.perUnitAmount) || 0)
        : current.perUnitAmount,
    active: updates.active !== undefined ? updates.active : current.active,
    updatedAt: new Date().toISOString(),
  };
  plans[idx] = updated;
  await setItem(KEYS.INCENTIVE_PRODUCT_PLANS, plans);
  return updated;
}

export async function removeIncentiveProductPlan(planId: string): Promise<boolean> {
  const companyId = await getActiveCompanyId();
  const plans = await getLatestRemoteSyncedList<IncentiveProductPlan>(
    KEYS.INCENTIVE_PRODUCT_PLANS,
    refreshIncentiveProductPlansFromBackend
  );
  const nextPlans = plans.filter(
    (plan) => !(plan.id === planId && matchesCompany(plan, companyId))
  );
  if (nextPlans.length === plans.length) return false;
  await setItem(KEYS.INCENTIVE_PRODUCT_PLANS, nextPlans);
  return true;
}

export async function refreshIncentivePayoutsFromBackend(): Promise<IncentivePayout[] | null> {
  return refreshRemoteStateList<IncentivePayout>(KEYS.INCENTIVE_PAYOUTS);
}

export async function getIncentivePayouts(options?: {
  refreshRemote?: boolean;
}): Promise<IncentivePayout[]> {
  const companyId = await getActiveCompanyId();
  const payouts = options?.refreshRemote
    ? (await refreshIncentivePayoutsFromBackend()) ??
      (await getRawList<IncentivePayout>(KEYS.INCENTIVE_PAYOUTS))
    : await getRawList<IncentivePayout>(KEYS.INCENTIVE_PAYOUTS);
  return payouts.filter((payout) => matchesCompany(payout, companyId));
}

export async function addIncentivePayout(payout: IncentivePayout): Promise<void> {
  const companyId = await getActiveCompanyId();
  const payouts = await getLatestRemoteSyncedList<IncentivePayout>(
    KEYS.INCENTIVE_PAYOUTS,
    refreshIncentivePayoutsFromBackend
  );
  payouts.unshift(withCompanyId(payout, companyId));
  await setItem(KEYS.INCENTIVE_PAYOUTS, payouts.slice(0, 2000));
}

export async function updateIncentivePayoutStatus(
  payoutId: string,
  status: IncentivePayout["status"]
): Promise<void> {
  const companyId = await getActiveCompanyId();
  const payouts = await getLatestRemoteSyncedList<IncentivePayout>(
    KEYS.INCENTIVE_PAYOUTS,
    refreshIncentivePayoutsFromBackend
  );
  const idx = payouts.findIndex((payout) => payout.id === payoutId && matchesCompany(payout, companyId));
  if (idx === -1) return;
  payouts[idx].status = status;
  await setItem(KEYS.INCENTIVE_PAYOUTS, payouts);
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
      : "light";
  const backendApiUrl = (current.backendApiUrl || "").trim() || BACKEND_ENV_DEFAULTS.apiBaseUrl;
  const dolibarrEndpoint =
    (current.dolibarrEndpoint || "").trim() || DOLIBARR_ENV_DEFAULTS.endpoint;
  const dolibarrApiKey = (current.dolibarrApiKey || "").trim() || DOLIBARR_ENV_DEFAULTS.apiKey;
  const aiApiKey = (current.aiApiKey || "").trim() || AI_ENV_DEFAULTS.apiKey;
  const aiModel = (current.aiModel || "").trim() || AI_ENV_DEFAULTS.model;
  const aiProjectId = (current.aiProjectId || "").trim() || AI_ENV_DEFAULTS.projectId;
  const dolibarrEnabled = "true";

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
    normalized.dolibarrEnabled = "true";
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

async function fetchRemoteNotifications(): Promise<AppNotification[] | null> {
  const token = await getApiToken();
  if (!token) return null;
  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/notifications`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) continue;
        return null;
      }
      const payload = (await response.json()) as AppNotification[];
      return Array.isArray(payload) ? payload : null;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function createRemoteNotificationInternal(input: {
  title: string;
  body: string;
  kind: AppNotification["kind"];
  audience: NotificationAudience;
}): Promise<AppNotification | null> {
  const token = await getApiToken();
  if (!token) return null;
  const apiBases = await getRemoteStateApiCandidates();
  const body = JSON.stringify(input);
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/notifications`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status >= 500) continue;
        return null;
      }
      const payload = (await response.json()) as AppNotification;
      return payload ?? null;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function markRemoteNotificationReadInternal(notificationId: string): Promise<boolean> {
  const token = await getApiToken();
  if (!token) return false;
  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/notifications/${notificationId}/read`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status >= 500) continue;
      return false;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function markAllRemoteNotificationsReadInternal(): Promise<boolean> {
  const token = await getApiToken();
  if (!token) return false;
  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/notifications/read-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (response.ok) return true;
      if (response.status >= 500) continue;
      return false;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function refreshRemoteNotifications(): Promise<AppNotification[] | null> {
  try {
    const remote = await fetchRemoteNotifications();
    if (!Array.isArray(remote)) return null;
    const companyId = await getActiveCompanyId();
    const existing = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
    const preserved = existing.filter((item) => !matchesCompany(item, companyId));
    const normalized = remote.map((item) => ({
      ...item,
      readByIds: Array.isArray(item.readByIds) ? item.readByIds : [],
    }));
    await setItem(KEYS.NOTIFICATIONS, [...normalized, ...preserved]);
    return normalized;
  } catch {
    return null;
  }
}

export async function getNotificationsForCurrentUser(): Promise<AppNotification[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) return [];
  const companyId = await getActiveCompanyId();
  const remote = await refreshRemoteNotifications();
  const notifications = remote ?? (await getRawList<AppNotification>(KEYS.NOTIFICATIONS));
  return notifications
    .filter(
      (item) =>
        matchesCompany(item, companyId) && canReceiveNotification(item.audience, currentUser.role)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCompanyNotifications(): Promise<AppNotification[]> {
  const companyId = await getActiveCompanyId();
  const remote = await refreshRemoteNotifications();
  const notifications = remote ?? (await getRawList<AppNotification>(KEYS.NOTIFICATIONS));
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
  const remoteCandidate = await createRemoteNotificationInternal({
    title: notification.title,
    body: notification.body,
    kind: notification.kind,
    audience: notification.audience,
  });

  const notifications = await getRawList<AppNotification>(KEYS.NOTIFICATIONS);
  const candidate: AppNotification = withCompanyId<AppNotification>(
    remoteCandidate || {
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
  await markRemoteNotificationReadInternal(notificationId);
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
  await markAllRemoteNotificationsReadInternal();
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
  const tokenStore = await readApiTokenStore(currentUser);
  if (currentUser?.id) {
    const currentToken = tokenStore[currentUser.id];
    if (typeof currentToken === "string" && currentToken.trim()) {
      return currentToken;
    }
  }

  const globalToken = tokenStore[GLOBAL_API_TOKEN_KEY];
  if (typeof globalToken === "string" && globalToken.trim()) {
    return globalToken;
  }

  const fallbackTokens = Object.entries(tokenStore)
    .filter(([key, value]) => key !== GLOBAL_API_TOKEN_KEY && typeof value === "string" && value.trim())
    .map(([, value]) => value);
  return fallbackTokens.length === 1 ? fallbackTokens[0] : null;
}

export async function setApiToken(token: string | null): Promise<void> {
  const currentUser = await getCurrentUser();
  if (!currentUser?.id) {
    const tokenStore = await readApiTokenStore(null);
    if (!token) {
      delete tokenStore[GLOBAL_API_TOKEN_KEY];
    } else {
      tokenStore[GLOBAL_API_TOKEN_KEY] = token;
    }
    await writeApiTokenStore(tokenStore);
    return;
  }

  const tokenStore = await readApiTokenStore(currentUser);
  if (!token) {
    const removedToken = tokenStore[currentUser.id];
    delete tokenStore[currentUser.id];
    if (removedToken && tokenStore[GLOBAL_API_TOKEN_KEY] === removedToken) {
      const nextToken = Object.entries(tokenStore).find(
        ([key, value]) =>
          key !== GLOBAL_API_TOKEN_KEY && typeof value === "string" && value.trim().length > 0
      )?.[1];
      if (nextToken) {
        tokenStore[GLOBAL_API_TOKEN_KEY] = nextToken;
      } else {
        delete tokenStore[GLOBAL_API_TOKEN_KEY];
      }
    }
  } else {
    tokenStore[currentUser.id] = token;
    tokenStore[GLOBAL_API_TOKEN_KEY] = token;
  }
  await writeApiTokenStore(tokenStore);
  if (token) {
    void flushPendingRemoteStateWrites();
  }
}
