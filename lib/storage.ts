import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
import type { AppUser, AppNotification, AttendanceRecord, Employee, AuditLog, Geofence, Team, AttendanceAnomaly, AttendancePhoto, CompanyProfile, UserRole, UserAccessRequest } from "./types";
import {
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  PENDING_COMPANY_ID,
  PENDING_COMPANY_NAME,
} from "./seedData";
import { isSalesRole } from "./role-access";

const KEYS = {
  USER: "@trackforce_user",
  AUTH_USERS: "@trackforce_auth_users",
  COMPANIES: "@trackforce_companies",
  EMPLOYEES: "@trackforce_employees",
  ATTENDANCE: "@trackforce_attendance",
  AUDIT_LOGS: "@trackforce_audit_logs",
  SEEDED: "@trackforce_seeded",
  CHECKED_IN: "@trackforce_checked_in",
  SETTINGS: "@trackforce_settings",
  GEOFENCES: "@trackforce_geofences",
  TEAMS: "@trackforce_teams",
  ATTENDANCE_PHOTOS: "@trackforce_attendance_photos",
  ATTENDANCE_ANOMALIES: "@trackforce_attendance_anomalies",
  NOTIFICATIONS: "@trackforce_notifications",
  ACCESS_REQUESTS: "@trackforce_access_requests",
  ATTENDANCE_QUEUE: "@trackforce_attendance_queue",
  DEVICE_ID: "@trackforce_device_id",
  API_TOKEN: "@trackforce_api_token",
  SEED_VERSION: "@trackforce_seed_version",
};

const SEED_VERSION = "11";
const DEMO_EMAIL_SUFFIX = "@trackforce.ai";
const LEGACY_DEMO_PROFILE_NAMES = new Set([
  "priya",
  "priya sharma",
  "rohit",
  "sneha",
  "sneha reddy",
]);

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

function notifyStorageUpdated(key: string): void {
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

function trimEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const EXPO_PUBLIC_GROQ_API_KEY = trimEnv(process.env.EXPO_PUBLIC_GROQ_API_KEY);
const GROQ_API_KEY = trimEnv(process.env.GROQ_API_KEY);
const EXPO_PUBLIC_GROQ_MODEL = trimEnv(process.env.EXPO_PUBLIC_GROQ_MODEL);
const GROQ_MODEL = trimEnv(process.env.GROQ_MODEL);
const EXPO_PUBLIC_GROQ_PROJECT_ID = trimEnv(process.env.EXPO_PUBLIC_GROQ_PROJECT_ID);
const EXPO_PUBLIC_API_URL = trimEnv(process.env.EXPO_PUBLIC_API_URL);
const EXPO_PUBLIC_BACKEND_URL = trimEnv(process.env.EXPO_PUBLIC_BACKEND_URL);
const EXPO_PUBLIC_DOMAIN = trimEnv(process.env.EXPO_PUBLIC_DOMAIN);
const EXPO_PUBLIC_DOLIBARR_ENDPOINT = trimEnv(process.env.EXPO_PUBLIC_DOLIBARR_ENDPOINT);
const DOLIBARR_ENDPOINT = trimEnv(process.env.DOLIBARR_ENDPOINT);
const EXPO_PUBLIC_DOLIBARR_API_KEY = trimEnv(process.env.EXPO_PUBLIC_DOLIBARR_API_KEY);
const DOLIBARR_API_KEY = trimEnv(process.env.DOLIBARR_API_KEY);
const EXPO_PUBLIC_REMOTE_STATE_SYNC = trimEnv(process.env.EXPO_PUBLIC_REMOTE_STATE_SYNC);

const GROQ_KEY_FROM_ENV = EXPO_PUBLIC_GROQ_API_KEY || GROQ_API_KEY;
const GROQ_MODEL_FROM_ENV = EXPO_PUBLIC_GROQ_MODEL || GROQ_MODEL;
const AI_ENV_DEFAULTS = {
  apiKey: GROQ_KEY_FROM_ENV,
  model: GROQ_MODEL_FROM_ENV || "openai/gpt-oss-20b",
  projectId: EXPO_PUBLIC_GROQ_PROJECT_ID,
};

const RELEASE_BACKEND_FALLBACK_URL = "https://api.axionmeditech.com";

const BACKEND_ENV_DEFAULTS = {
  apiBaseUrl:
    EXPO_PUBLIC_API_URL ||
    EXPO_PUBLIC_BACKEND_URL ||
    EXPO_PUBLIC_DOMAIN ||
    RELEASE_BACKEND_FALLBACK_URL,
};

const DOLIBARR_ENV_DEFAULTS = {
  endpoint:
    EXPO_PUBLIC_DOLIBARR_ENDPOINT || DOLIBARR_ENDPOINT,
  apiKey:
    EXPO_PUBLIC_DOLIBARR_API_KEY || DOLIBARR_API_KEY,
};

const REMOTE_STATE_SYNC_DISABLED = EXPO_PUBLIC_REMOTE_STATE_SYNC === "false";
const IS_STANDALONE_RUNTIME =
  !__DEV__ && Constants.appOwnership !== "expo" && !Constants.expoConfig?.hostUri;
const REMOTE_STATE_TIMEOUT_MS = IS_STANDALONE_RUNTIME ? 9000 : 3200;
const REMOTE_STATE_API_CANDIDATES_TTL_MS = 10_000;
const REMOTE_STATE_FETCH_CACHE_TTL_MS = 3_000;
const REMOTE_STATE_PENDING_WRITES_KEY = "@trackforce_remote_state_pending_writes";
const REMOTE_STATE_ALLOWED_KEYS = new Set<string>([KEYS.EMPLOYEES, KEYS.ATTENDANCE, KEYS.AUDIT_LOGS, KEYS.SETTINGS, KEYS.GEOFENCES, KEYS.TEAMS, KEYS.ATTENDANCE_PHOTOS, KEYS.ATTENDANCE_ANOMALIES]);

interface PendingRemoteStateWrite {
  key: string;
  value: unknown;
  updatedAt: string;
}

type RemoteStateApiCandidatesCacheEntry = {
  values: string[];
  expiresAt: number;
};

type RemoteStateReadCacheEntry = {
  value: unknown;
  expiresAt: number;
};

let remoteStateApiCandidatesCache: RemoteStateApiCandidatesCacheEntry | null = null;
const remoteStateReadCache = new Map<string, RemoteStateReadCacheEntry>();
const remoteStateReadInFlight = new Map<string, Promise<unknown | null | undefined>>();

function makeRemoteStateReadCacheKey(stateKey: string, token: string): string {
  return `${token}::${stateKey}`;
}

function invalidateRemoteStateReadCacheForKey(stateKey: string): void {
  const suffix = `::${stateKey}`;
  for (const cacheKey of remoteStateReadCache.keys()) {
    if (cacheKey.endsWith(suffix)) {
      remoteStateReadCache.delete(cacheKey);
    }
  }
}

function resetRemoteStateRuntimeCaches(): void {
  remoteStateApiCandidatesCache = null;
  remoteStateReadCache.clear();
  remoteStateReadInFlight.clear();
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

function isAsyncStorageCursorWindowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /row too big to fit into cursorwindow/i.test(message);
}

async function safeAsyncStorageGetItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch (error) {
    if (isAsyncStorageCursorWindowError(error)) {
      console.warn(`Clearing oversized AsyncStorage row for key ${key}.`);
      await AsyncStorage.removeItem(key).catch(() => undefined);
      return null;
    }
    throw error;
  }
}

async function getLocalSettingsApiBaseUrl(): Promise<string> {
  const [settingsRaw, userRaw] = await Promise.all([
    safeAsyncStorageGetItem(KEYS.SETTINGS),
    safeAsyncStorageGetItem(KEYS.USER),
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
  const now = Date.now();
  if (remoteStateApiCandidatesCache && remoteStateApiCandidatesCache.expiresAt > now) {
    return [...remoteStateApiCandidatesCache.values];
  }

  const candidates = new Set<string>();
  const isExpoDevRuntime =
    __DEV__ ||
    Constants.appOwnership === "expo" ||
    Boolean(Constants.expoConfig?.hostUri);
  const settingsApiUrl = await getLocalSettingsApiBaseUrl();
  const envUrl = BACKEND_ENV_DEFAULTS.apiBaseUrl;
  const publicHttpsEnvApiBases = toApiBaseUrls(envUrl).filter((apiBase) => {
    try {
      const parsed = new URL(apiBase);
      return parsed.protocol === "https:" && !isPrivateOrLocalHost(parsed.hostname);
    } catch {
      return false;
    }
  });
  const publicHttpsSettingsApiBases = toApiBaseUrls(settingsApiUrl).filter((apiBase) => {
    try {
      const parsed = new URL(apiBase);
      return parsed.protocol === "https:" && !isPrivateOrLocalHost(parsed.hostname);
    } catch {
      return false;
    }
  });

  if (publicHttpsEnvApiBases.length > 0) {
    const resolved = Array.from(
      new Set([
        ...publicHttpsEnvApiBases,
        `${RELEASE_BACKEND_FALLBACK_URL}/api`,
        ...publicHttpsSettingsApiBases,
      ])
    );
    remoteStateApiCandidatesCache = {
      values: resolved,
      expiresAt: Date.now() + REMOTE_STATE_API_CANDIDATES_TTL_MS,
    };
    return [...resolved];
  }

  const prioritizedUrls = !isExpoDevRuntime
    ? [envUrl, RELEASE_BACKEND_FALLBACK_URL, settingsApiUrl]
    : [envUrl, settingsApiUrl];
  for (const rawUrl of prioritizedUrls) {
    if (!rawUrl) continue;
    for (const apiBase of toApiBaseUrls(rawUrl)) {
      if (!isExpoDevRuntime && isPrivateOrLocalHost(new URL(apiBase).hostname)) continue;
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
  const resolved = Array.from(candidates);
  remoteStateApiCandidatesCache = {
    values: resolved,
    expiresAt: Date.now() + REMOTE_STATE_API_CANDIDATES_TTL_MS,
  };
  return [...resolved];
}

async function readPendingRemoteStateWrites(): Promise<PendingRemoteStateWrite[]> {
  const raw = await safeAsyncStorageGetItem(REMOTE_STATE_PENDING_WRITES_KEY);
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

async function hasPendingRemoteStateWrite(key: string): Promise<boolean> {
  const queue = await readPendingRemoteStateWrites();
  return queue.some((entry) => entry.key === key);
}

async function flushPendingRemoteStateWrites(): Promise<void> {
  const queue = await readPendingRemoteStateWrites();
  if (!queue.length) return;
  const remaining: PendingRemoteStateWrite[] = [];
  for (const entry of queue) {
    // Older installs can have queued writes for features removed from this build.
    if (!entry || !REMOTE_STATE_ALLOWED_KEYS.has(entry.key)) continue;
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
  const readCacheKey = makeRemoteStateReadCacheKey(key, token);
  const cached = remoteStateReadCache.get(readCacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T | null;
  }
  const inFlight = remoteStateReadInFlight.get(readCacheKey);
  if (inFlight) {
    return (await inFlight) as T | null | undefined;
  }

  const encodedKey = encodeURIComponent(key);
  const request = (async (): Promise<T | null | undefined> => {
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
          if (response.status === 401 || response.status === 403) {
            await setApiToken(null);
            return undefined;
          }
          if (response.status >= 500) continue;
          return undefined;
        }
        const trimmed = text.trim();
        if (!trimmed) {
          remoteStateReadCache.set(readCacheKey, {
            value: null,
            expiresAt: Date.now() + REMOTE_STATE_FETCH_CACHE_TTL_MS,
          });
          return null;
        }
        try {
          const payload = JSON.parse(text) as { value?: unknown };
          const value = (payload?.value ?? null) as T | null;
          remoteStateReadCache.set(readCacheKey, {
            value,
            expiresAt: Date.now() + REMOTE_STATE_FETCH_CACHE_TTL_MS,
          });
          return value;
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
  })();

  remoteStateReadInFlight.set(readCacheKey, request as Promise<unknown | null | undefined>);
  try {
    return await request;
  } finally {
    remoteStateReadInFlight.delete(readCacheKey);
  }
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
      if (response.ok) {
        invalidateRemoteStateReadCacheForKey(key);
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        await setApiToken(null);
        return false;
      }
      if (response.status < 500) return false;
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

async function readCompanyApiError(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return fallback;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // fall through to plain text
    }
    return text.trim().replace(/\s+/g, " ").slice(0, 220);
  } catch {
    return fallback;
  }
}

async function fetchCompaniesFromDb(): Promise<CompanyProfile[] | null> {
  const token = await getApiToken();
  if (!token) return null;
  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/companies`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await setApiToken(null);
          return null;
        }
        if (response.status >= 500) continue;
        return null;
      }
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) return [];
      return payload.map((entry) => normalizeCompanyProfile(entry as Partial<CompanyProfile>));
    } catch {
      // try next backend candidate
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function mutateCompanyInDb(
  method: "POST" | "PUT",
  path: string,
  payload: Partial<CompanyProfile>
): Promise<CompanyProfile | null> {
  const token = await getApiToken();
  if (!token) return null;
  const apiBases = await getRemoteStateApiCandidates();
  for (const apiBase of apiBases) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_STATE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          await setApiToken(null);
          return null;
        }
        if (response.status >= 500) continue;
        throw new Error(await readCompanyApiError(response, "Company database operation failed."));
      }
      const result = (await response.json()) as Partial<CompanyProfile>;
      return normalizeCompanyProfile(result);
    } catch (error) {
      if (error instanceof Error && !/aborted|network request failed|fetch/i.test(error.message)) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function writeCompanyProfilesCache(companies: CompanyProfile[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.COMPANIES, JSON.stringify(companies));
  notifyStorageUpdated(KEYS.COMPANIES);
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

function isLegacyDemoProfileName(value: string | null | undefined): boolean {
  return LEGACY_DEMO_PROFILE_NAMES.has(normalizeWhitespace(value || "").toLowerCase());
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
  if (
    role === "admin" ||
    role === "hr" ||
    role === "manager" ||
    role === "salesperson" ||
    role === "employee"
  ) {
    return role;
  }
  return "salesperson";
}

function roleToDepartment(role: UserRole): string {
	if (role === "admin") return "Management";
	if (role === "hr") return "Human Resources";
	if (role === "manager") return "Operations";
	if (role === "employee") return "Office Employees";
	return "On Field Employees";
}

function roleToEmployeeCategory(role: UserRole): "on_field" | "fixed_location" {
	return isSalesRole(role) ? "on_field" : "fixed_location";
}

function normalizeDepartmentForRole(role: UserRole, department?: string | null): string {
  const normalized = normalizeWhitespace(department ?? "");
  if (role === "salesperson" && (!normalized || normalized.toLowerCase() === "sales")) {
    return roleToDepartment("salesperson");
  }
  return normalized || roleToDepartment(role);
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
    department: normalizeDepartmentForRole(user.role, user.department),
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
  return normalizeWhitespace(item.companyId ?? "") === companyId;
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

async function getItem<T>(key: string): Promise<T | null> {
  const localRaw = await safeAsyncStorageGetItem(key);
  const localValue = localRaw ? (JSON.parse(localRaw) as T) : null;
  if (!shouldSyncRemoteStateKey(key)) {
    return localValue;
  }
  void flushPendingRemoteStateWrites();

  const remoteValue = await fetchStateRemote<T>(key);
  if (typeof remoteValue === "undefined") {
    return localValue;
  }

  const hasPendingWrite = await hasPendingRemoteStateWrite(key);
  if (hasPendingWrite && localValue !== null) {
    // Keep the latest local write visible until the queued remote sync succeeds.
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
    {
      let remoteValue = value;

      if (key === KEYS.EMPLOYEES && Array.isArray(value)) {
        const currentUser = await getCurrentUser().catch(() => null);
        if (!currentUser) {
          remoteValue = (await fetchStateRemote<T>(key)) ?? value;
        } else if (isSalesRole(currentUser.role)) {
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
  }
  notifyStorageUpdated(key);
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
  const removedUserIds = new Set<string>();
  const removedNames = new Set<string>();

  const filteredAuthUsers = authUsers.filter((entry) => {
    const isDemo = isLegacyDemoEmail(entry.user.email) || isLegacyDemoProfileName(entry.user.name);
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
      isLegacyDemoProfileName(entry.name) ||
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

  const filteredAccessRequests = accessRequests.filter(
    (entry) => !isLegacyDemoEmail(entry.email) && !isLegacyDemoProfileName(entry.name)
  );
  if (filteredAccessRequests.length !== accessRequests.length) {
    await setAccessRequestsRaw(filteredAccessRequests);
  }

  const currentUser = await getItem<AppUser>(KEYS.USER);
  if (currentUser && (isLegacyDemoEmail(currentUser.email) || isLegacyDemoProfileName(currentUser.name))) {
    await Promise.all([
      AsyncStorage.removeItem(KEYS.USER),
      AsyncStorage.removeItem(KEYS.API_TOKEN),
      AsyncStorage.removeItem(KEYS.CHECKED_IN),
    ]);
  }

  const idKeys = ["userId", "employeeId", "ownerId", "assignedTo", "createdById", "leadId"];
  const nameKeys = [
    "userName",
    "employeeName",
    "ownerName",
    "assignedToName",
    "createdByName",
    "leadName",
    "salespersonName",
    "customerName",
    "requestedByName",
  ];
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
        if (typeof value === "string") {
          const normalizedValue = normalizeWhitespace(value).toLowerCase();
          if (removedNames.has(normalizedValue) || isLegacyDemoProfileName(value)) {
            return false;
          }
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
    KEYS.AUDIT_LOGS,
    KEYS.TEAMS,
    KEYS.ATTENDANCE_PHOTOS,
    KEYS.ATTENDANCE_ANOMALIES,
    KEYS.NOTIFICATIONS,
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

  const appliedVersion = await safeAsyncStorageGetItem(KEYS.SEED_VERSION);
  if (appliedVersion === SEED_VERSION) return;

  await Promise.all([
    migrateCompanyIdOnCollection<Employee>(KEYS.EMPLOYEES),
    migrateCompanyIdOnCollection<AttendanceRecord>(KEYS.ATTENDANCE),
    migrateCompanyIdOnCollection<AuditLog>(KEYS.AUDIT_LOGS),
    migrateCompanyIdOnCollection<Geofence>(KEYS.GEOFENCES),
    migrateCompanyIdOnCollection<Team>(KEYS.TEAMS),
    migrateCompanyIdOnCollection<AttendancePhoto>(KEYS.ATTENDANCE_PHOTOS),
    migrateCompanyIdOnCollection<AttendanceAnomaly>(KEYS.ATTENDANCE_ANOMALIES),
    migrateCompanyIdOnCollection<AppNotification>(KEYS.NOTIFICATIONS),
  ]);
  await purgeLegacyDemoProfiles();

  await AsyncStorage.setItem(KEYS.SEED_VERSION, SEED_VERSION);
}

async function seedDataIfNeededInternal(): Promise<void> {
  const seeded = await safeAsyncStorageGetItem(KEYS.SEEDED);
  if (seeded) {
    await runSeedMigrations();
    return;
  }

  await Promise.all([
    setItem(KEYS.EMPLOYEES, []),
    setItem(KEYS.ATTENDANCE, []),
    setItem(KEYS.AUDIT_LOGS, []),
    setItem(KEYS.GEOFENCES, []),
    setItem(KEYS.TEAMS, []),
    setItem(KEYS.ATTENDANCE_PHOTOS, []),
    setItem(KEYS.ATTENDANCE_ANOMALIES, []),
    setItem(KEYS.NOTIFICATIONS, []),
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
  const dbCompanies = await fetchCompaniesFromDb();
  if (Array.isArray(dbCompanies)) {
    await writeCompanyProfilesCache(dbCompanies);
    return dbCompanies;
  }
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
  const saved = await mutateCompanyInDb("PUT", `/companies/${encodeURIComponent(companyId)}`, next);
  if (!saved) return null;
  companies[idx] = saved;
  await writeCompanyProfilesCache(companies);
  if (current.name !== next.name) {
    await propagateCompanyName(companyId, saved.name);
  }
  return saved;
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
		employeeCategory: roleToEmployeeCategory(user.role),
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

  const rawAuthUsers = await getAuthUsersRaw();
  const authUsers = rawAuthUsers.filter((entry) => normalizeEmail(entry.user.email) !== email);

  const role = normalizeRole(input.role);
  const now = new Date().toISOString();
  const adminAlreadyExists = hasAnyApprovedAdmin(authUsers);
  if (isSalesRole(role) && (!requestedBranch || !requestedPincode)) {
    return { ok: false, message: "Location and pincode are required for sales role signup" };
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
      department: normalizeDepartmentForRole("admin", input.department),
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
    department: normalizeDepartmentForRole(role, input.department),
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

export async function deleteAuthUserByEmail(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const rawAuthUsers = await getAuthUsersRaw();
  const filtered = rawAuthUsers.filter((entry) => normalizeEmail(entry.user.email) !== normalized);
  await setAuthUsersRaw(filtered);
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

async function readCheckedInMap(currentUser?: AppUser | null): Promise<Record<string, boolean>> {
  const raw = await safeAsyncStorageGetItem(KEYS.CHECKED_IN);
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
  const raw = await safeAsyncStorageGetItem(KEYS.API_TOKEN);
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
  return employees.filter(
    (employee) =>
      matchesCompany(employee, companyId) &&
      !isLegacyDemoEmail(employee.email) &&
      !isLegacyDemoProfileName(employee.name)
  );
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

function isPublicHttpsBackendUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && !isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
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
  const currentBackendApiUrl = (current.backendApiUrl || "").trim();
  const envBackendApiUrl = BACKEND_ENV_DEFAULTS.apiBaseUrl.trim();
  const backendApiUrl =
    isPublicHttpsBackendUrl(envBackendApiUrl) &&
    (!currentBackendApiUrl || !isPublicHttpsBackendUrl(currentBackendApiUrl))
      ? envBackendApiUrl
      : currentBackendApiUrl || envBackendApiUrl;
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
    locationTracking: "false",
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
    normalized.locationTracking = "false";
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
  resetRemoteStateRuntimeCaches();
  invalidateRemoteStateReadCacheForKey(KEYS.SETTINGS);
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
  const currentUser = await getCurrentUser().catch(() => null);
  const activeCompanyId = await getActiveCompanyId();
  const allGeofences = await getRawList<Geofence>(KEYS.GEOFENCES);
  const allowedCompanyIds = new Set(
    currentUser?.id === userId
      ? normalizeCompanyIds(currentUser.companyIds, currentUser.companyId)
      : activeCompanyId
        ? [activeCompanyId]
        : []
  );
  const geofences = allGeofences.filter((zone) => {
    const zoneCompanyId = normalizeWhitespace(zone.companyId || "");
    return !zoneCompanyId || allowedCompanyIds.has(zoneCompanyId);
  });
  const directZones = geofences.filter((zone) => zone.isActive && zone.assignedEmployeeIds.includes(userId));
  if (currentUser?.id !== userId) {
    return directZones;
  }

  const officeZones = geofences.filter((zone) => {
    if (!zone.isActive) return false;
    if (Array.from(allowedCompanyIds).some((companyId) => zone.id === `office_${companyId}`)) return true;
    return Boolean(zone.companyId && allowedCompanyIds.has(zone.companyId) && zone.id.startsWith("office_"));
  });
  const byId = new Map<string, Geofence>();
  for (const zone of [...directZones, ...officeZones]) {
    byId.set(zone.id, zone);
  }
  return Array.from(byId.values());
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

export async function addAttendanceAnomaly(anomaly: AttendanceAnomaly): Promise<void> {
  const companyId = await getActiveCompanyId();
  const anomalies = await getRawList<AttendanceAnomaly>(KEYS.ATTENDANCE_ANOMALIES);
  anomalies.unshift(withCompanyId(anomaly, companyId));
  await setItem(KEYS.ATTENDANCE_ANOMALIES, anomalies);
}

export async function getAttendanceQueue<T = Record<string, unknown>>(): Promise<T[]> {
  return (await getItem<T[]>(KEYS.ATTENDANCE_QUEUE)) || [];
}

export async function setAttendanceQueue<T = Record<string, unknown>>(queue: T[]): Promise<void> {
  await setItem(KEYS.ATTENDANCE_QUEUE, queue);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const current = await safeAsyncStorageGetItem(KEYS.DEVICE_ID);
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
    resetRemoteStateRuntimeCaches();
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
  resetRemoteStateRuntimeCaches();
  if (token) {
    void flushPendingRemoteStateWrites();
  }
}
