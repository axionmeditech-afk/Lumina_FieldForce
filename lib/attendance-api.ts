import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import type { AppUser, AttendanceCheckPayload, AttendanceRecord, CompanyProfile, Geofence, UserAccessRequest, UserRole } from "@/lib/types";
import Constants from "expo-constants";
import {
  getApiToken,
  getAttendanceQueue,
  getOrCreateDeviceId,
  getSettings,
  setApiToken,
  setAttendanceQueue,
} from "@/lib/storage";
import { beginGlobalLoading } from "@/lib/global-loading";

const FALLBACK_API_BASE = "http://localhost:5000/api";
const RELEASE_FALLBACK_API_BASE = "https://api.axionmeditech.com/api";

interface QueueItem {
  type: "checkin" | "checkout";
  payload: AttendanceCheckPayload;
}

export interface DolibarrUser {
  id?: number | string;
  rowid?: number | string;
  user_id?: number | string;
  firstname?: string;
  lastname?: string;
  name?: string;
  login?: string;
  email?: string;
  zip?: string;
  town?: string;
  address?: string;
  statut?: number | string;
  status?: number | string;
  companyId?: string;
  companyName?: string;
  assignedCompanyIds?: string[];
  admin?: boolean | number | string | null;
  employee?: boolean | number | string | null;
  role?: UserRole;
  employeeCategory?: "on_field" | "fixed_location" | string | null;
  employee_category?: "on_field" | "fixed_location" | string | null;
  department?: string;
  phone?: string;
  branch?: string;
}

export interface RemoteStateResponse<T> {
  key: string;
  value: T | null;
  updatedAt: string | null;
  source?: string | null;
}

const PUBLIC_API_PATH_PATTERNS = [
  /^\/health\b/i,
  /^\/auth\/(login|token|register|access-request)\b/i,
  /^\/salaries\b/i,
];

export class ApiAuthRequiredError extends Error {
  readonly code = "api_auth_required" as const;

  constructor(message = "API session token is missing. Sign in online to enable backend sync.") {
    super(message);
    this.name = "ApiAuthRequiredError";
  }
}

export function isApiAuthRequiredError(error: unknown): error is ApiAuthRequiredError {
  return (
    error instanceof ApiAuthRequiredError ||
    (error instanceof Error &&
      (error.name === "ApiAuthRequiredError" ||
        (typeof (error as { code?: unknown }).code === "string" &&
          (error as { code?: string }).code === "api_auth_required")))
  );
}

export class DeviceSessionLockedError extends Error {
  readonly code = "device_session_locked" as const;

  constructor(message = "This account is already signed in on another device. Sign out from the previous device before signing in here.") {
    super(message);
    this.name = "DeviceSessionLockedError";
  }
}

export class ApiSessionInvalidError extends Error {
  readonly code = "api_session_invalid" as const;

  constructor(message = "Session is no longer active. Please sign in again.") {
    super(message);
    this.name = "ApiSessionInvalidError";
  }
}

export function isApiSessionInvalidError(error: unknown): error is ApiSessionInvalidError {
  return (
    error instanceof ApiSessionInvalidError ||
    (error instanceof Error &&
      (error.name === "ApiSessionInvalidError" ||
        (typeof (error as { code?: unknown }).code === "string" &&
          (error as { code?: string }).code === "api_session_invalid")))
  );
}

export function isDeviceSessionLockedError(error: unknown): error is DeviceSessionLockedError {
  return (
    error instanceof DeviceSessionLockedError ||
    (error instanceof Error &&
      (error.name === "DeviceSessionLockedError" ||
        (typeof (error as { code?: unknown }).code === "string" &&
          (error as { code?: string }).code === "device_session_locked")))
  );
}

function isDeviceSessionLockedMessage(message: string): boolean {
  return /already (?:active|signed in) on another device|(?:log|sign) ?out from (?:that|the previous) device/i.test(message);
}

function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function isProtectedApiPath(path: string): boolean {
  return !isPublicApiPath(path);
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
  const protocols: Array<"http:" | "https:"> = isPrivateHost
    ? ["http:", "https:"]
    : allowedProtocol === "http:"
      ? ["http:"]
      : ["https:"];

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

function isPrivateApiBaseUrl(value: string): boolean {
  const cleaned = value.trim();
  if (!cleaned) return false;
  try {
    const parsed = new URL(cleaned);
    return isPrivateOrLocalHost(parsed.hostname);
  } catch {
    return false;
  }
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

export async function getApiBaseUrlCandidates(): Promise<string[]> {
  const settings = await getSettings();
  const settingsUrl = (settings.backendApiUrl || "").trim();
  const envUrl = (
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    process.env.EXPO_PUBLIC_DOMAIN ||
    ""
  ).trim();
  const candidates = new Set<string>();
  const expoLanApiBase = getExpoLanApiBaseUrl();
  const isExpoDevRuntime =
    __DEV__ ||
    Constants.appOwnership === "expo" ||
    Boolean(Constants.expoConfig?.hostUri);
  const envApiBases = envUrl ? toApiBaseUrls(envUrl) : [];
  const publicHttpsEnvApiBases = envApiBases.filter((base) => {
    try {
      const parsed = new URL(base);
      return parsed.protocol === "https:" && !isPrivateApiBaseUrl(base);
    } catch {
      return false;
    }
  });
  const publicHttpsSettingsApiBases = settingsUrl
    ? toApiBaseUrls(settingsUrl).filter((base) => {
        try {
          const parsed = new URL(base);
          return parsed.protocol === "https:" && !isPrivateApiBaseUrl(base);
        } catch {
          return false;
        }
      })
    : [];

  // If a public HTTPS backend is configured, hard-pin to public API bases even in Expo/dev.
  // This avoids stale LAN/localhost settings hijacking production traffic inside preview builds.
  if (publicHttpsEnvApiBases.length > 0) {
    return [...new Set([...publicHttpsEnvApiBases, RELEASE_FALLBACK_API_BASE, ...publicHttpsSettingsApiBases])];
  }

  // In production, prefer a user-provided public HTTPS API base if available.
  if (!isExpoDevRuntime) {
    if (publicHttpsSettingsApiBases.length > 0) {
      return [...new Set([RELEASE_FALLBACK_API_BASE, ...publicHttpsSettingsApiBases])];
    }
    return [RELEASE_FALLBACK_API_BASE];
  }

  // In dev runtime keep env URL first, but still allow LAN/localhost fallback.
  for (const publicApiBase of publicHttpsEnvApiBases) {
    candidates.add(publicApiBase);
  }

  // Production hard-pin fallback: if env API URL exists, use only HTTPS variants.
  if (!isExpoDevRuntime && envApiBases.length > 0) {
    const httpsOnly = envApiBases.filter((base) => {
      try {
        return new URL(base).protocol === "https:";
      } catch {
        return false;
      }
    });
    if (httpsOnly.length > 0) {
      return httpsOnly;
    }
  }

  if (isExpoDevRuntime && expoLanApiBase) {
    candidates.add(expoLanApiBase);
  }

  if (settingsUrl) {
    const settingsApiBases = toApiBaseUrls(settingsUrl);
    for (const settingsApiBase of settingsApiBases) {
      if (!isExpoDevRuntime && isPrivateApiBaseUrl(settingsApiBase)) continue;
      candidates.add(settingsApiBase);
    }
  }

  for (const envApiBase of envApiBases) {
    if (!isExpoDevRuntime && isPrivateApiBaseUrl(envApiBase)) continue;
    candidates.add(envApiBase);
  }

  if (isExpoDevRuntime) {
    candidates.add(FALLBACK_API_BASE);
  }
  return Array.from(candidates);
}

function buildHeaders(token: string | null, extra?: HeadersInit): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function parseJsonBody(text: string): { parsed: unknown | null; isValid: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { parsed: null, isValid: true };
  }
  try {
    return { parsed: JSON.parse(text), isValid: true };
  } catch {
    return { parsed: null, isValid: false };
  }
}

function buildBodyPreview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > 140 ? `${trimmed.slice(0, 140)}...` : trimmed;
}

let cachedLastWorkingApiBase: string | null = null;

class ApiHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type ApiRequestInit = RequestInit & {
  skipGlobalLoading?: boolean;
};

async function fetchJson<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { skipGlobalLoading, ...requestInit } = init;
  const endGlobalLoading = skipGlobalLoading ? () => {} : beginGlobalLoading();
  try {
  let apiBases = await getApiBaseUrlCandidates();
  if (cachedLastWorkingApiBase && apiBases.includes(cachedLastWorkingApiBase)) {
    apiBases = [cachedLastWorkingApiBase, ...apiBases.filter((b) => b !== cachedLastWorkingApiBase)];
  }
  const token = await getApiToken();
  const headers = buildHeaders(token, init.headers);
  const networkFailures: string[] = [];
  const applicationFailures: string[] = [];
  const isAuthRoute = /^\/auth\/(login|token|register|access-request)\b/i.test(path);
  if (!token && !isAuthRoute && isProtectedApiPath(path)) {
    throw new ApiAuthRequiredError();
  }

  if (requestInit.method && !["GET", "HEAD"].includes(requestInit.method.toUpperCase())) apiBases = apiBases.slice(0, 1);
  for (const apiBase of apiBases) {
    if (requestInit.signal?.aborted) {
      throw new Error("Request aborted.");
    }
    const url = `${apiBase}${path}`;
    try {
      const response = await fetch(url, {
        ...requestInit,
        headers,
      });
      const text = await response.text();
      const contentType = response.headers.get("content-type") || "";
      const { parsed, isValid } = parseJsonBody(text);
      if (!response.ok) {
        const messageFromJson =
          parsed && typeof parsed === "object" && "message" in parsed
            ? String((parsed as { message?: unknown }).message ?? "")
            : "";
        const normalized = (messageFromJson || text || "").toLowerCase();
        const isTokenError =
          response.status === 401 &&
          /invalid or expired token|missing authorization bearer token|missing authorization/i.test(
            normalized
          );
        const isSessionInvalid =
          Boolean(token) &&
          !isAuthRoute &&
          (response.status === 401 || response.status === 403 || response.status === 404) &&
          /session|not authenticated|user not found|user inactive|access request|pending admin approval|rejected by admin|no longer active|disabled/i.test(
            messageFromJson || text || ""
          );

        if (isTokenError || isSessionInvalid) {
          if (token && !isAuthRoute) {
            await setApiToken(null);
          }
          if (isSessionInvalid) {
            throw new ApiSessionInvalidError(
              messageFromJson || "Session is no longer active. Please sign in again."
            );
          }
          if (token) {
            throw new Error("Session expired. Please log out and sign in again.");
          }
          throw new ApiAuthRequiredError();
        }

        const shouldTryNextBase =
          response.status === 404 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;
        if (shouldTryNextBase) {
          const failureBody = buildBodyPreview(messageFromJson || text || "");
          applicationFailures.push(
            `${apiBase} -> HTTP ${response.status}: ${failureBody || "empty body"}`
          );
          continue;
        }
        throw new ApiHttpError(messageFromJson || text || `HTTP ${response.status}`, response.status);
      }
      if (!isValid) {
        const preview = buildBodyPreview(text);
        const inferredType =
          contentType.split(";")[0] ||
          (preview.startsWith("<") ? "text/html" : "text/plain");
        applicationFailures.push(
          `${apiBase} -> Expected JSON but received ${inferredType}${preview ? `: ${preview}` : ""}`
        );
        continue;
      }
      cachedLastWorkingApiBase = apiBase;
      return (parsed ?? null) as T;
    } catch (error) {
      if (requestInit.signal?.aborted) {
        throw error instanceof Error ? error : new Error("Request aborted.");
      }
      const message =
        error instanceof Error ? error.message : "Request failed unexpectedly.";
      if (/network request failed|failed to fetch|econn|enotfound|timed out|ssl|certificate/i.test(message.toLowerCase())) {
        networkFailures.push(`${apiBase} -> ${message}`);
        continue;
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }

  if (networkFailures.length > 0) {
    const appPart = applicationFailures.length ? ` | API: ${applicationFailures.join(" | ")}` : "";
    throw new Error(`Backend request failed. Tried: ${networkFailures.join(" | ")}${appPart}`);
  }
  if (applicationFailures.length > 0) {
    throw new Error(`Backend request rejected across API bases. Tried: ${applicationFailures.join(" | ")}`);
  }
  throw new Error("Backend request failed.");
  } finally {
    endGlobalLoading();
  }
}

interface AuthRequestOptions {
  timeoutMs?: number;
  throwOnDeviceLock?: boolean;
  throwOnInvalidSession?: boolean;
}

export interface AccessRequestPayload {
  name: string;
  email: string;
  password: string;
  companyName: string;
  role?: UserRole;
  department?: string;
  branch?: string;
  phone?: string;
  pincode?: string;
}

async function fetchJsonWithTimeout<T>(
  path: string,
  init: ApiRequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson<T>(path, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function getRemoteState<T>(
  key: string,
  options?: { skipGlobalLoading?: boolean }
): Promise<RemoteStateResponse<T>> {
  const encodedKey = encodeURIComponent(key);
  return fetchJson<RemoteStateResponse<T>>(`/state/${encodedKey}`, {
    method: "GET",
    skipGlobalLoading: options?.skipGlobalLoading,
  });
}

export async function setRemoteState<T>(key: string, value: T): Promise<void> {
  const encodedKey = encodeURIComponent(key);
  await fetchJson<Record<string, unknown>>(`/state/${encodedKey}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export async function issueApiToken(
  identifier: string,
  password: string,
  options?: AuthRequestOptions
): Promise<string | null> {
  const timeoutMs = Math.max(300, options?.timeoutMs ?? 1800);
  const cleanIdentifier = identifier.trim();
  if (!cleanIdentifier) {
    return null;
  }
  const deviceId = await getOrCreateDeviceId();
  const payload = cleanIdentifier.includes("@")
    ? { email: cleanIdentifier, password, deviceId }
    : {
        email: cleanIdentifier,
        login: cleanIdentifier,
        username: cleanIdentifier,
        password,
        deviceId,
      };
  try {
    const result = await fetchJsonWithTimeout<{ token: string }>(
      "/auth/token",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
    await setApiToken(result.token);
    return result.token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (options?.throwOnDeviceLock && isDeviceSessionLockedMessage(message)) {
      throw new DeviceSessionLockedError(message);
    }
    return null;
  }
}

export async function getAuthenticatedApiUser(
  options?: AuthRequestOptions
): Promise<AppUser | null> {
  const timeoutMs = Math.max(400, options?.timeoutMs ?? 2200);
  try {
    const response = await fetchJsonWithTimeout<{ user: AppUser }>(
      "/auth/me",
      { method: "GET" },
      timeoutMs
    );
    return response.user;
  } catch (error) {
    if (options?.throwOnInvalidSession && isApiSessionInvalidError(error)) {
      throw error;
    }
    return null;
  }
}

export async function registerApiUser(payload: {
  name: string;
  email: string;
  password: string;
  companyName: string;
  role?: "admin" | "hr" | "manager" | "salesperson" | "employee";
  department?: string;
  branch?: string;
  phone?: string;
  pincode?: string;
}, options?: AuthRequestOptions): Promise<string | null> {
  const timeoutMs = Math.max(300, options?.timeoutMs ?? 2200);
  try {
    const deviceId = await getOrCreateDeviceId();
    const result = await fetchJsonWithTimeout<{ token?: string }>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          deviceId,
        }),
      },
      timeoutMs
    );
    if (result.token) {
      await setApiToken(result.token);
      return result.token;
    }
    return null;
  } catch {
    return null;
  }
}

export async function logoutApiSession(options?: AuthRequestOptions): Promise<void> {
  const timeoutMs = Math.max(300, options?.timeoutMs ?? 1800);
  try {
    const deviceId = await getOrCreateDeviceId();
    await fetchJsonWithTimeout<{ ok: boolean }>(
      "/auth/logout",
      {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      },
      timeoutMs
    );
  } catch {
    // Local logout should continue even when backend is unreachable.
  }
}

export async function submitAccessRequestToBackend(
  payload: AccessRequestPayload,
  options?: AuthRequestOptions
): Promise<{ ok: boolean; message?: string; request?: UserAccessRequest } | null> {
  const timeoutMs = Math.max(400, options?.timeoutMs ?? 2800);
  try {
    return await fetchJsonWithTimeout<{ ok: boolean; message?: string; request?: UserAccessRequest }>(
      "/auth/access-request",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Access request failed.",
    };
  }
}

export async function getAdminAccessRequests(
  status?: UserAccessRequest["status"]
): Promise<UserAccessRequest[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return fetchJson<UserAccessRequest[]>(`/admin/access-requests${query}`, {
    method: "GET",
  });
}

export async function reviewAdminAccessRequest(payload: {
  requestId: string;
  action: "approved" | "rejected";
  role?: UserRole;
  companyIds?: string[];
  companyProfiles?: Array<{ id: string; name: string; primaryBranch?: string }>;
  managerId?: string;
  managerName?: string;
  stockistId?: string;
  stockistName?: string;
  comment?: string;
}): Promise<UserAccessRequest> {
  return fetchJson<UserAccessRequest>(
    `/admin/access-requests/${encodeURIComponent(payload.requestId)}/review`,
    {
      method: "POST",
      body: JSON.stringify({
        action: payload.action,
        role: payload.role,
        companyIds: payload.companyIds,
        companyProfiles: payload.companyProfiles,
        managerId: payload.managerId,
        managerName: payload.managerName,
        stockistId: payload.stockistId,
        stockistName: payload.stockistName,
        comment: payload.comment,
      }),
    }
  );
}

export async function getCompanyProfilesRemote(): Promise<CompanyProfile[]> {
  return fetchJson<CompanyProfile[]>("/companies", {
    method: "GET",
  });
}

export async function createCompanyProfileRemote(
  payload: Partial<CompanyProfile> & { name: string }
): Promise<CompanyProfile> {
  return fetchJson<CompanyProfile>("/companies", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCompanyProfileRemote(
  companyId: string,
  payload: Partial<CompanyProfile>
): Promise<CompanyProfile> {
  return fetchJson<CompanyProfile>(`/companies/${encodeURIComponent(companyId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function getUserGeofences(userId: string): Promise<Geofence[]> {
  return fetchJsonWithTimeout<Geofence[]>(
    `/geofences/user/${encodeURIComponent(userId)}`,
    { method: "GET" },
    8000
  );
}

export async function createGeofence(payload: Partial<Geofence>): Promise<Geofence> {
  return fetchJson<Geofence>("/geofences", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateGeofence(zoneId: string, payload: Partial<Geofence>): Promise<Geofence> {
  return fetchJson<Geofence>(`/geofences/${encodeURIComponent(zoneId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

async function submitAttendanceAction(type: "checkin" | "checkout", payload: AttendanceCheckPayload): Promise<AttendanceRecord> {
  const key = `@attendance_request:${payload.userId}:${type}`;
  const automatic = payload.actionSource === "geofence_exit";
  const saved = automatic ? null : await AsyncStorage.getItem(key);
  const requestId = saved || payload.requestId || Crypto.randomUUID();
  if (!automatic) await AsyncStorage.setItem(key, requestId);
  try {
    const record = await fetchJsonWithTimeout<AttendanceRecord>(`/attendance/${type}`, {
      method: "POST", skipGlobalLoading: automatic,
      body: JSON.stringify({ ...payload, requestId }),
    }, 70000);
    if (!automatic) await AsyncStorage.removeItem(key);
    return record;
  } catch (error) {
    if (!automatic && error instanceof ApiHttpError && error.status >= 400 && error.status < 500) await AsyncStorage.removeItem(key);
    throw error;
  }
}

export async function attendanceCheckIn(payload: AttendanceCheckPayload): Promise<AttendanceRecord> {
  return submitAttendanceAction("checkin", payload);
}
export async function attendanceCheckOut(payload: AttendanceCheckPayload): Promise<AttendanceRecord> {
  return submitAttendanceAction("checkout", payload);
}

export async function getCompanyAttendanceToday(companyId?: string, date?: string): Promise<AttendanceRecord[]> {
  const params: string[] = [];
  if (companyId) params.push(`company_id=${encodeURIComponent(companyId)}`);
  if (date) params.push(`date=${encodeURIComponent(date)}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return fetchJsonWithTimeout<AttendanceRecord[]>(`/attendance/company/today${query}`, { method: "GET", skipGlobalLoading: true }, 70000);
}

export interface MapplsPlaceSuggestion {
  id: string;
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  eloc: string | null;
}

export interface MapplsPlaceSearchResponse {
  provider: "mappls";
  mode: "autosuggest" | "text";
  query: string;
  suggestions: MapplsPlaceSuggestion[];
  source: string | null;
  error: string | null;
}

export async function searchMapplsAutosuggest(
  query: string,
  opts?: {
    latitude?: number | null;
    longitude?: number | null;
    region?: string | null;
    limit?: number;
  }
): Promise<MapplsPlaceSearchResponse> {
  const params = new URLSearchParams({ query: query.trim() });
  if (typeof opts?.latitude === "number" && typeof opts?.longitude === "number") {
    params.set("latitude", String(opts.latitude));
    params.set("longitude", String(opts.longitude));
    params.set("location", `${opts.latitude},${opts.longitude}`);
  }
  if (opts?.region) params.set("region", opts.region);
  if (typeof opts?.limit === "number" && Number.isFinite(opts.limit)) {
    params.set("limit", String(Math.max(1, Math.min(20, Math.floor(opts.limit)))));
  }
  return fetchJson<MapplsPlaceSearchResponse>(`/mappls/places/autosuggest?${params.toString()}`, {
    method: "GET",
  });
}

export async function searchMapplsTextSearch(
  query: string,
  opts?: {
    latitude?: number | null;
    longitude?: number | null;
    region?: string | null;
    limit?: number;
  }
): Promise<MapplsPlaceSearchResponse> {
  const params = new URLSearchParams({ query: query.trim() });
  if (typeof opts?.latitude === "number" && typeof opts?.longitude === "number") {
    params.set("latitude", String(opts.latitude));
    params.set("longitude", String(opts.longitude));
    params.set("location", `${opts.latitude},${opts.longitude}`);
  }
  if (opts?.region) params.set("region", opts.region);
  if (typeof opts?.limit === "number" && Number.isFinite(opts.limit)) {
    params.set("limit", String(Math.max(1, Math.min(20, Math.floor(opts.limit)))));
  }
  return fetchJson<MapplsPlaceSearchResponse>(`/mappls/places/text-search?${params.toString()}`, {
    method: "GET",
  });
}

const MAX_QUEUE_RETRIES = 5;

export async function flushAttendanceQueue(): Promise<void> {
  const settings = await getSettings();
  if (settings.offlineMode === "true" || settings.autoSync === "false") {
    return;
  }

  const queue = await getAttendanceQueue<QueueItem & { _retries?: number }>();
  if (!queue.length) return;

  const remaining: (QueueItem & { _retries?: number })[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    const retries = entry._retries ?? 0;
    // Drop items that have exceeded max retries
    if (retries >= MAX_QUEUE_RETRIES) {
      console.warn(`Dropping queued ${entry.type} after ${retries} failed attempts`, entry.payload.requestId);
      continue;
    }
    try {
      if (entry.type === "checkin") {
        await attendanceCheckIn(entry.payload);
      } else {
        await attendanceCheckOut(entry.payload);
      }
    } catch (error) {
      remaining.push({ ...entry, _retries: retries + 1 });
      if (isApiAuthRequiredError(error)) {
        // Auth required — preserve remaining items as-is (no retry increment)
        remaining.push(...queue.slice(index + 1));
        break;
      }
    }
  }
  await setAttendanceQueue(remaining);
}


// --- Users ---
export async function getUsersRemote(options?: { companyId?: string | null }): Promise<DolibarrUser[]> {
  const params = new URLSearchParams();
  if (options?.companyId) params.set("companyId", options.companyId);
  const query = params.toString();
  const data = await fetchJson<{ items?: DolibarrUser[] }>(`/users${query ? `?${query}` : ""}`, { method: "GET" });
  return Array.isArray(data.items) ? data.items : [];
}

export async function deleteUserRemote(
  userId: string,
  payload?: {
    email?: string | null;
    login?: string | null;
    companyId?: string | null;
    name?: string | null;
  }
): Promise<{ ok: boolean; deleted?: { id?: string; email?: string | null; name?: string | null } }> {
  return fetchJson(`/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    body: JSON.stringify({
      email: payload?.email || undefined,
      login: payload?.login || undefined,
      companyId: payload?.companyId || undefined,
      name: payload?.name || undefined,
    }),
  });
}

export async function getAttendanceStatus(date?: string): Promise<{ records: AttendanceRecord[]; active: AttendanceRecord | null }> {
  return fetchJsonWithTimeout(`/attendance/status${date ? `?date=${encodeURIComponent(date)}` : ""}`, { method: "GET", skipGlobalLoading: true }, 70000);
}

export async function getCompanyAttendanceMonth(companyId: string | undefined, month: string): Promise<AttendanceRecord[]> {
  return fetchJsonWithTimeout(`/attendance/company/today?month=${encodeURIComponent(month)}${companyId ? `&company_id=${encodeURIComponent(companyId)}` : ""}`, { method: "GET", skipGlobalLoading: true }, 70000);
}
