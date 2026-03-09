import type {
  AppUser,
  AttendanceCheckPayload,
  AttendanceRecord,
  Geofence,
  LocationLog,
  RouteDistanceMatrix,
  RouteTimeline,
  UserAccessRequest,
  UserRole,
} from "@/lib/types";
import Constants from "expo-constants";
import {
  getApiToken,
  getAttendanceQueue,
  getSettings,
  setApiToken,
  setAttendanceQueue,
} from "@/lib/storage";

const FALLBACK_API_BASE = "http://localhost:5000/api";

interface QueueItem {
  type: "checkin" | "checkout";
  payload: AttendanceCheckPayload;
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

  // Hard-pin to public HTTPS env API URL in production.
  if (!isExpoDevRuntime && publicHttpsEnvApiBases.length > 0) {
    return publicHttpsEnvApiBases;
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

export async function getApiBaseUrl(): Promise<string> {
  const candidates = await getApiBaseUrlCandidates();
  return candidates[0] || FALLBACK_API_BASE;
}

async function buildHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await getApiToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiBases = await getApiBaseUrlCandidates();
  const headers = await buildHeaders(init.headers);
  const networkFailures: string[] = [];
  const applicationFailures: string[] = [];
  const isAuthRoute = /^\/auth\/(login|token|register|access-request)\b/i.test(path);

  for (const apiBase of apiBases) {
    if (init.signal?.aborted) {
      throw new Error("Request aborted.");
    }
    const url = `${apiBase}${path}`;
    try {
      const response = await fetch(url, {
        ...init,
        headers,
      });
      if (!response.ok) {
        const text = await response.text();
        const normalized = (text || "").toLowerCase();
        const isTokenError =
          response.status === 401 &&
          /invalid or expired token|missing authorization bearer token|missing authorization/i.test(
            normalized
          );

        if (isTokenError) {
          if (!isAuthRoute) {
            await setApiToken(null);
          }
          throw new Error("Session expired. Please log out and sign in again.");
        }

        const shouldTryNextBase =
          response.status === 404 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504;
        if (shouldTryNextBase) {
          applicationFailures.push(`${apiBase} -> HTTP ${response.status}: ${text || "empty body"}`);
          continue;
        }
        throw new Error(text || `HTTP ${response.status}`);
      }
      return response.json() as Promise<T>;
    } catch (error) {
      if (init.signal?.aborted) {
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
}

interface AuthRequestOptions {
  timeoutMs?: number;
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
}

async function fetchJsonWithTimeout<T>(
  path: string,
  init: RequestInit,
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

export async function issueApiToken(
  email: string,
  password: string,
  options?: AuthRequestOptions
): Promise<string | null> {
  const timeoutMs = Math.max(300, options?.timeoutMs ?? 1800);
  try {
    const result = await fetchJsonWithTimeout<{ token: string }>(
      "/auth/token",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      timeoutMs
    );
    await setApiToken(result.token);
    return result.token;
  } catch {
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
  } catch {
    return null;
  }
}

export async function registerApiUser(payload: {
  name: string;
  email: string;
  password: string;
  companyName: string;
  role?: "admin" | "hr" | "manager" | "salesperson";
  department?: string;
  branch?: string;
  phone?: string;
}, options?: AuthRequestOptions): Promise<string | null> {
  const timeoutMs = Math.max(300, options?.timeoutMs ?? 2200);
  try {
    const result = await fetchJsonWithTimeout<{ token?: string }>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify(payload),
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
  } catch {
    return null;
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
  managerId?: string;
  managerName?: string;
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
        managerId: payload.managerId,
        managerName: payload.managerName,
        comment: payload.comment,
      }),
    }
  );
}

export async function getUserGeofences(userId: string): Promise<Geofence[]> {
  return fetchJson<Geofence[]>(`/geofences/user/${encodeURIComponent(userId)}`, {
    method: "GET",
  });
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

export async function attendanceCheckIn(payload: AttendanceCheckPayload): Promise<AttendanceRecord> {
  return fetchJsonWithTimeout<AttendanceRecord>(
    "/attendance/checkin",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    6500
  );
}

export async function attendanceCheckOut(payload: AttendanceCheckPayload): Promise<AttendanceRecord> {
  return fetchJsonWithTimeout<AttendanceRecord>(
    "/attendance/checkout",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    6500
  );
}

export async function getTodayAttendance(userId: string): Promise<AttendanceRecord[]> {
  return fetchJson<AttendanceRecord[]>(`/attendance/today?user_id=${encodeURIComponent(userId)}`, {
    method: "GET",
  });
}

export async function getAttendanceHistory(userId: string): Promise<AttendanceRecord[]> {
  return fetchJson<AttendanceRecord[]>(
    `/attendance/history?user_id=${encodeURIComponent(userId)}`,
    {
      method: "GET",
    }
  );
}

export async function postLocationLog(payload: {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  capturedAt?: string | null;
}): Promise<void> {
  await fetchJson<{ ok: boolean }>("/location/log", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function postLocationBatch(
  entries: {
    userId: string;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
    batteryLevel?: number | null;
    capturedAt?: string | null;
  }[]
): Promise<{ ok: boolean; accepted: number; rejected: number }> {
  return fetchJson<{ ok: boolean; accepted: number; rejected: number }>("/location/batch", {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
}

export interface LiveMapPoint {
  id: string;
  userId: string;
  latitude: number;
  longitude: number;
  batteryLevel?: number | null;
  geofenceName?: string | null;
  isInsideGeofence: boolean;
  capturedAt: string;
}

export async function getAdminLiveMapPoints(): Promise<LiveMapPoint[]> {
  return fetchJson<LiveMapPoint[]>("/admin/live-map", { method: "GET" });
}

export interface AdminLiveMapRoute {
  userId: string;
  intervalMinutes: number;
  pointCount: number;
  points: LocationLog[];
  latestPoint: LocationLog | null;
}

export interface AdminLiveMapRoutesResponse {
  date: string;
  intervalMinutes: number;
  routes: AdminLiveMapRoute[];
}

export async function getAdminLiveMapRoutes(
  date: string,
  intervalMinutes = 1
): Promise<AdminLiveMapRoutesResponse> {
  const query = new URLSearchParams({
    date,
    interval_minutes: String(Math.max(1, Math.floor(intervalMinutes))),
  });
  return fetchJson<AdminLiveMapRoutesResponse>(`/admin/live-map/routes?${query.toString()}`, {
    method: "GET",
  });
}

export interface RouteAttendanceEvent {
  id: string;
  type: "checkin" | "checkout";
  at: string;
  geofenceName: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface AdminRouteTimelineResponse extends RouteTimeline {
  attendanceEvents: RouteAttendanceEvent[];
}

export interface AdminRouteDistanceMatrixResponse {
  userId: string;
  date: string;
  matrix: RouteDistanceMatrix;
}

export interface DolibarrIntegrationSettings {
  enabled: boolean;
  endpoint: string | null;
  apiKeyMasked: string | null;
  configured: boolean;
  source: "settings" | "env";
}

export interface DolibarrIntegrationUpdatePayload {
  enabled: boolean;
  endpoint?: string | null;
  apiKey?: string | null;
}

export interface DolibarrIntegrationTestResult {
  ok: boolean;
  status: number | null;
  message: string;
}

export interface DolibarrEmployeeSyncPayload {
  name: string;
  email: string;
  role?: string | null;
  department?: string | null;
  branch?: string | null;
  phone?: string | null;
  enabled?: boolean;
  endpoint?: string | null;
  apiKey?: string | null;
}

export interface DolibarrEmployeeSyncResult {
  ok: boolean;
  status: "created" | "exists" | "skipped" | "failed";
  message: string;
  dolibarrUserId: number | null;
  endpointUsed: string | null;
}

interface DolibarrEmployeeCreatePayload {
  login: string;
  email: string;
  firstname: string;
  lastname: string;
  employee: number;
  office_phone?: string;
  user_mobile?: string;
  job?: string;
}

function normalizeDolibarrText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeDolibarrEmail(value: string): string {
  return normalizeDolibarrText(value).toLowerCase();
}

function isValidDolibarrEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function splitDolibarrDisplayName(name: string): { firstName: string; lastName: string } {
  const cleaned = normalizeDolibarrText(name).replace(/\s+/g, " ");
  if (!cleaned) {
    return { firstName: "Employee", lastName: "User" };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "User" };
  }
  const firstName = parts.shift() || "Employee";
  const lastName = parts.join(" ") || "User";
  return { firstName, lastName };
}

function buildDolibarrLogin(email: string, name: string): string {
  const fromEmail = email.split("@")[0] || "";
  const fromName = name.toLowerCase().replace(/\s+/g, ".");
  const cleaned = (fromEmail || fromName || "employee")
    .replace(/[^a-z0-9._-]/gi, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 42)
    .toLowerCase();
  return cleaned || `employee_${Date.now().toString(36).slice(-6)}`;
}

function buildDolibarrRetryLogin(baseLogin: string): string {
  const suffix = Date.now().toString(36).slice(-4);
  return `${baseLogin.slice(0, 36)}_${suffix}`;
}

function buildDolibarrJobTitle(payload: DolibarrEmployeeSyncPayload): string | undefined {
  const parts = [payload.role || "", payload.department || "", payload.branch || ""]
    .map((entry) => normalizeDolibarrText(entry))
    .filter(Boolean)
    .slice(0, 3);
  if (!parts.length) return undefined;
  return parts.join(" | ").slice(0, 80);
}

function buildDolibarrHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    DOLAPIKEY: apiKey,
    "X-Dolibarr-API-Key": apiKey,
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMissingDolibarrSyncRoute(message: string): boolean {
  const raw = normalizeDolibarrText(message).toLowerCase();
  const plain = stripHtml(raw);
  return (
    /cannot post\s*\/api\/integrations\/dolibarr\/hrm\/sync-employee/i.test(raw) ||
    /cannot post\s*\/api\/integrations\/dolibarr\/hrm\/sync-employee/i.test(plain) ||
    /cannot post\s*\/integrations\/dolibarr\/hrm\/sync-employee/i.test(raw) ||
    /cannot post\s*\/integrations\/dolibarr\/hrm\/sync-employee/i.test(plain)
  );
}

function summarizeDolibarrSyncError(message: string): string {
  const raw = normalizeDolibarrText(message);
  const plain = stripHtml(raw);
  if (!raw && !plain) {
    return "Dolibarr sync failed.";
  }
  if (
    /backend request failed/i.test(raw) ||
    /backend request failed/i.test(plain) ||
    /network request failed/i.test(raw) ||
    /network request failed/i.test(plain) ||
    /failed to fetch/i.test(raw) ||
    /failed to fetch/i.test(plain)
  ) {
    return "Backend is not reachable from this device. Set the Backend API URL to the correct LAN IP in Settings (example: http://<your-ip>:5000).";
  }
  if (isMissingDolibarrSyncRoute(raw) || isMissingDolibarrSyncRoute(plain)) {
    return "Current backend does not expose Dolibarr sync route. Direct Dolibarr sync needs endpoint + API key in Settings.";
  }
  if (/<!doctype html>/i.test(raw) || /<html/i.test(raw)) {
    return plain || "Server returned HTML instead of JSON.";
  }
  if (/unexpected token\s*</i.test(raw)) {
    return "Server returned invalid response while syncing Dolibarr.";
  }
  return plain || raw;
}

function buildDolibarrApiBases(rawEndpoint: string): string[] {
  const cleaned = normalizeDolibarrText(rawEndpoint).replace(/\/+$/, "");
  if (!cleaned) return [];

  const input = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return [];
  }

  const candidates = new Set<string>();
  const pathname = parsed.pathname.replace(/\/+$/, "");

  const addCandidate = (nextPath: string) => {
    const next = new URL(parsed.toString());
    next.pathname = nextPath || "/";
    next.search = "";
    next.hash = "";
    candidates.add(next.toString().replace(/\/+$/, ""));
  };

  if (/\/api\/index\.php(\/.*)?$/i.test(pathname)) {
    addCandidate(pathname.replace(/(\/api\/index\.php).*/i, "$1"));
  } else if (/\/api$/i.test(pathname)) {
    addCandidate(`${pathname}/index.php`);
    addCandidate(pathname);
  } else if (/\/users$/i.test(pathname)) {
    addCandidate(pathname.replace(/\/users$/i, ""));
  } else {
    if (pathname) {
      addCandidate(`${pathname}/api/index.php`);
      addCandidate(`${pathname}/api`);
    }
    addCandidate("/api/index.php");
    addCandidate("/api");
    if (pathname) {
      addCandidate(pathname);
    }
  }

  return Array.from(candidates);
}

async function parseDolibarrResponseBody(
  response: Response
): Promise<{ text: string; json: Record<string, unknown> | null }> {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      return { text, json: parsed as Record<string, unknown> };
    }
    return { text, json: null };
  } catch {
    return { text, json: null };
  }
}

function parseDolibarrUserId(payload: unknown): number | null {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return Math.trunc(payload);
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload as Record<string, unknown>;
  const candidates = [body.id, body.rowid, body.user_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      return Number(candidate.trim());
    }
  }
  return null;
}

function buildDolibarrCreatePayload(
  payload: DolibarrEmployeeSyncPayload,
  login: string
): DolibarrEmployeeCreatePayload {
  const normalizedEmail = normalizeDolibarrEmail(payload.email);
  const name = splitDolibarrDisplayName(payload.name);
  const nextPayload: DolibarrEmployeeCreatePayload = {
    login,
    email: normalizedEmail,
    firstname: name.firstName,
    lastname: name.lastName,
    employee: 1,
  };

  const phone = normalizeDolibarrText(payload.phone);
  if (phone) {
    nextPayload.office_phone = phone;
    nextPayload.user_mobile = phone;
  }

  const job = buildDolibarrJobTitle(payload);
  if (job) {
    nextPayload.job = job;
  }
  return nextPayload;
}

async function syncApprovedEmployeeToDolibarrDirect(
  payload: DolibarrEmployeeSyncPayload,
  config: { enabled: boolean; endpoint: string; apiKey: string }
): Promise<DolibarrEmployeeSyncResult> {
  const normalizedEmail = normalizeDolibarrEmail(payload.email);
  if (!isValidDolibarrEmail(normalizedEmail)) {
    return {
      ok: false,
      status: "failed",
      message: "A valid user email is required for Dolibarr employee sync.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const apiBases = buildDolibarrApiBases(config.endpoint);
  if (!apiBases.length) {
    return {
      ok: false,
      status: "failed",
      message: "Dolibarr endpoint format is invalid.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const headers = buildDolibarrHeaders(config.apiKey);
  const baseLogin = buildDolibarrLogin(normalizedEmail, payload.name);
  let lastFailure = "Unable to sync employee to Dolibarr.";

  for (const apiBase of apiBases) {
    try {
      const existingResponse = await fetch(
        `${apiBase}/users/email/${encodeURIComponent(normalizedEmail)}`,
        {
          method: "GET",
          headers,
        }
      );
      if (existingResponse.ok) {
        const { json } = await parseDolibarrResponseBody(existingResponse);
        return {
          ok: true,
          status: "exists",
          message: "Employee already exists in Dolibarr.",
          dolibarrUserId: parseDolibarrUserId(json),
          endpointUsed: apiBase,
        };
      }
      if (existingResponse.status !== 404) {
        const { text, json } = await parseDolibarrResponseBody(existingResponse);
        const message =
          (json?.error &&
          typeof json.error === "object" &&
          typeof (json.error as Record<string, unknown>).message === "string"
            ? String((json.error as Record<string, unknown>).message)
            : typeof json?.message === "string"
              ? String(json.message)
              : text) || `Dolibarr responded with HTTP ${existingResponse.status}.`;
        lastFailure = summarizeDolibarrSyncError(message);
        continue;
      }

      const primaryPayload = buildDolibarrCreatePayload(payload, baseLogin);
      const createResponse = await fetch(`${apiBase}/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(primaryPayload),
      });
      const createBody = await parseDolibarrResponseBody(createResponse);
      if (createResponse.ok) {
        return {
          ok: true,
          status: "created",
          message: "Employee created in Dolibarr.",
          dolibarrUserId: parseDolibarrUserId(createBody.json ?? createBody.text),
          endpointUsed: apiBase,
        };
      }

      const createMessage =
        (createBody.json?.error &&
        typeof createBody.json.error === "object" &&
        typeof (createBody.json.error as Record<string, unknown>).message === "string"
          ? String((createBody.json.error as Record<string, unknown>).message)
          : typeof createBody.json?.message === "string"
            ? String(createBody.json.message)
            : createBody.text) || `Dolibarr responded with HTTP ${createResponse.status}.`;
      const isConflict =
        createResponse.status === 409 ||
        /already exists|already used|duplicate|login exists/i.test(createMessage);

      if (!isConflict) {
        lastFailure = summarizeDolibarrSyncError(createMessage);
        continue;
      }

      const retryPayload = buildDolibarrCreatePayload(payload, buildDolibarrRetryLogin(baseLogin));
      const retryResponse = await fetch(`${apiBase}/users`, {
        method: "POST",
        headers,
        body: JSON.stringify(retryPayload),
      });
      const retryBody = await parseDolibarrResponseBody(retryResponse);
      if (retryResponse.ok) {
        return {
          ok: true,
          status: "created",
          message: "Employee created in Dolibarr.",
          dolibarrUserId: parseDolibarrUserId(retryBody.json ?? retryBody.text),
          endpointUsed: apiBase,
        };
      }

      lastFailure = summarizeDolibarrSyncError(
        (retryBody.json?.error &&
        typeof retryBody.json.error === "object" &&
        typeof (retryBody.json.error as Record<string, unknown>).message === "string"
          ? String((retryBody.json.error as Record<string, unknown>).message)
          : typeof retryBody.json?.message === "string"
            ? String(retryBody.json.message)
            : retryBody.text) || createMessage
      );
    } catch (error) {
      lastFailure = summarizeDolibarrSyncError(
        error instanceof Error
          ? error.message
          : "Unable to reach Dolibarr endpoint from device."
      );
    }
  }

  return {
    ok: false,
    status: "failed",
    message: lastFailure,
    dolibarrUserId: null,
    endpointUsed: null,
  };
}

export async function getAdminRouteTimeline(
  userId: string,
  date: string,
  intervalMinutes = 1
): Promise<AdminRouteTimelineResponse> {
  const query = new URLSearchParams({
    date,
    interval_minutes: String(Math.max(1, Math.floor(intervalMinutes))),
  });
  return fetchJson<AdminRouteTimelineResponse>(
    `/admin/route/${encodeURIComponent(userId)}?${query.toString()}`,
    { method: "GET" }
  );
}

export async function getAdminDemoRouteTimeline(
  userId: string,
  date: string
): Promise<AdminRouteTimelineResponse> {
  return fetchJson<AdminRouteTimelineResponse>(
    `/admin/route/${encodeURIComponent(userId)}/demo?date=${encodeURIComponent(date)}`,
    { method: "GET" }
  );
}

export async function getAdminRouteDistanceMatrix(
  userId: string,
  date: string,
  opts?: { demo?: boolean }
): Promise<AdminRouteDistanceMatrixResponse> {
  const query = new URLSearchParams({
    date,
    ...(opts?.demo ? { demo: "1" } : {}),
  });
  return fetchJson<AdminRouteDistanceMatrixResponse>(
    `/admin/route/${encodeURIComponent(userId)}/matrix?${query.toString()}`,
    { method: "GET" }
  );
}

export async function getDolibarrIntegrationSettings(): Promise<DolibarrIntegrationSettings> {
  return fetchJson<DolibarrIntegrationSettings>("/settings/integrations/dolibarr", {
    method: "GET",
  });
}

export async function updateDolibarrIntegrationSettings(
  payload: DolibarrIntegrationUpdatePayload
): Promise<DolibarrIntegrationSettings> {
  return fetchJson<DolibarrIntegrationSettings>("/settings/integrations/dolibarr", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function testDolibarrIntegration(
  payload?: DolibarrIntegrationUpdatePayload
): Promise<DolibarrIntegrationTestResult> {
  return fetchJson<DolibarrIntegrationTestResult>("/settings/integrations/dolibarr/test", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

export async function syncApprovedEmployeeToDolibarr(
  payload: DolibarrEmployeeSyncPayload
): Promise<DolibarrEmployeeSyncResult> {
  const settings = await getSettings();
  const localEnabled = settings.dolibarrEnabled === "true";
  const localEndpoint = (settings.dolibarrEndpoint || "").trim();
  const localApiKey = (settings.dolibarrApiKey || "").trim();
  const backendApiUrl = (settings.backendApiUrl || "").trim();
  const payloadEndpoint =
    typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
  const payloadApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
  const resolvedEndpoint = payloadEndpoint || localEndpoint;
  const resolvedApiKey = payloadApiKey || localApiKey;
  const resolvedEnabled =
    typeof payload.enabled === "boolean" ? payload.enabled : localEnabled;

  if (!resolvedEnabled) {
    return {
      ok: true,
      status: "skipped",
      message: "Dolibarr sync skipped: integration is disabled in Settings.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const body: DolibarrEmployeeSyncPayload = {
    ...payload,
  };

  if (typeof payload.enabled === "boolean") {
    body.enabled = payload.enabled;
  } else if (localEnabled || Boolean(localEndpoint) || Boolean(localApiKey)) {
    body.enabled = localEnabled;
  }

  if (payload.endpoint !== undefined) {
    body.endpoint = payload.endpoint;
  } else if (localEndpoint) {
    body.endpoint = localEndpoint;
  }

  if (payload.apiKey !== undefined) {
    body.apiKey = payload.apiKey;
  } else if (localApiKey) {
    body.apiKey = localApiKey;
  }

  let directResult: DolibarrEmployeeSyncResult | null = null;
  const canRunDirectFirst = Boolean(resolvedEndpoint && resolvedApiKey && resolvedEnabled);
  if (canRunDirectFirst) {
    directResult = await syncApprovedEmployeeToDolibarrDirect(payload, {
      enabled: true,
      endpoint: resolvedEndpoint,
      apiKey: resolvedApiKey,
    });
    if (directResult.ok) {
      return {
        ...directResult,
        message: `${directResult.message} (direct device sync)`,
      };
    }
  }

  let backendResult: DolibarrEmployeeSyncResult | null = null;
  let backendError: Error | null = null;

  try {
    backendResult = await fetchJson<DolibarrEmployeeSyncResult>(
      "/integrations/dolibarr/hrm/sync-employee",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  } catch (error) {
    backendError = error instanceof Error ? error : new Error("Dolibarr sync request failed.");
  }

  if (backendResult?.ok) {
    return backendResult;
  }

  const routeMissingOnBackend = Boolean(
    (backendResult && isMissingDolibarrSyncRoute(backendResult.message)) ||
      (backendError && isMissingDolibarrSyncRoute(backendError.message))
  );
  const fallbackEndpoint =
    resolvedEndpoint || (routeMissingOnBackend ? backendApiUrl : "");
  const fallbackApiKey = resolvedApiKey;
  const shouldTryFallbackDirect =
    !canRunDirectFirst &&
    Boolean(fallbackEndpoint && fallbackApiKey) &&
    (resolvedEnabled || routeMissingOnBackend);

  if (shouldTryFallbackDirect) {
    directResult = await syncApprovedEmployeeToDolibarrDirect(payload, {
      enabled: true,
      endpoint: fallbackEndpoint,
      apiKey: fallbackApiKey,
    });
    if (directResult.ok) {
      return {
        ...directResult,
        message: `${directResult.message} (direct device sync)`,
      };
    }
  }

  if (routeMissingOnBackend && !resolvedEndpoint && !resolvedApiKey) {
    return {
      ok: true,
      status: "skipped",
      message:
        "Dolibarr sync skipped: backend route unavailable and direct endpoint/API key not configured.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const messages: string[] = [];
  if (backendResult) {
    messages.push(summarizeDolibarrSyncError(backendResult.message));
  } else if (backendError) {
    messages.push(summarizeDolibarrSyncError(backendError.message));
  }
  if (directResult && !directResult.ok) {
    messages.push(`Direct sync: ${summarizeDolibarrSyncError(directResult.message)}`);
  }
  if (!messages.length && !resolvedEndpoint) {
    messages.push("Dolibarr endpoint is not configured in Settings.");
  }
  if (!messages.length && !resolvedApiKey) {
    messages.push("Dolibarr API key is not configured in Settings.");
  }
  if (!messages.length && !resolvedEnabled) {
    messages.push("Dolibarr sync is disabled in Settings.");
  }
  if (!messages.length) {
    messages.push("Dolibarr sync failed.");
  }
  return {
    ok: false,
    status: backendResult?.status ?? "failed",
    message: messages.join(" | "),
    dolibarrUserId: directResult?.dolibarrUserId ?? backendResult?.dolibarrUserId ?? null,
    endpointUsed: directResult?.endpointUsed ?? backendResult?.endpointUsed ?? null,
  };
}

export async function queueAttendanceRequest(item: QueueItem): Promise<void> {
  const queue = await getAttendanceQueue<QueueItem>();
  queue.push(item);
  await setAttendanceQueue(queue);
}

export async function flushAttendanceQueue(): Promise<void> {
  const settings = await getSettings();
  if (settings.offlineMode === "true" || settings.autoSync === "false") {
    return;
  }

  const queue = await getAttendanceQueue<QueueItem>();
  if (!queue.length) return;

  const remaining: QueueItem[] = [];
  for (const entry of queue) {
    try {
      if (entry.type === "checkin") {
        await attendanceCheckIn(entry.payload);
      } else {
        await attendanceCheckOut(entry.payload);
      }
    } catch {
      remaining.push(entry);
    }
  }
  await setAttendanceQueue(remaining);
}

