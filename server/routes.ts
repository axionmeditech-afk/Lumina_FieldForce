import express, { type Express, type Request } from "express";
import type { Pool } from "mysql2/promise";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "crypto";
import type {
  AppNotification,
  AppUser,
  AttendanceCheckPayload,
  AttendanceRecord,
  Geofence,
  LocationLog,
  NotificationAudience,
  UserAccessRequest,
  UserRole,
} from "@/lib/types";
import {
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  PENDING_COMPANY_ID,
  PENDING_COMPANY_NAME,
} from "@/lib/seedData";
import { buildRouteTimeline } from "@/lib/route-analytics";
import { requireAuth, requireRoles, signJwt } from "@/server/auth";
import { storage } from "@/server/storage";
import { recordAnomaly, resolveGeofenceStatus } from "@/server/services/attendance-guard";
import { storeAttendancePhoto } from "@/server/services/photo-upload";
import {
  syncApprovedUserToDolibarrEmployee,
  syncAttendanceWithDolibarr,
} from "@/server/services/dolibarr-sync";
import {
  getMapplsDirectionsForLogs,
  getMapplsDirectionsForCoordinates,
  getMapplsDistanceMatrixForLogs,
} from "@/server/services/mappls-routing";
import {
  reverseGeocodeMapplsCoordinates,
  searchMapplsPlaces,
} from "@/server/services/mappls-places";
import {
  Speech2TextError,
  transcribeSpeechWithFairseqS2T,
} from "@/server/services/speech2text";
import {
  getMySqlStateValue,
  getMySqlPool,
  isMySqlStateEnabled,
  setMySqlStateValue,
} from "@/server/services/mysql-state";
import { analyzeConversationWithAI } from "@/lib/ai-sales-analysis";
import { isMumbaiDateKey, toMumbaiDateKey } from "@/lib/ist-time";

const MAX_LOCATION_ACCURACY_METERS = 120;
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;
const MAX_CAPTURE_DRIFT_MS = 2 * 60 * 1000;
const MIN_LOCATION_SAMPLE_COUNT = 2;
const MAX_TRANSCRIBE_AUDIO_BYTES = 12 * 1024 * 1024;
const DEFAULT_AI_MODEL =
  (process.env.GEMINI_MODEL || process.env.EXPO_PUBLIC_GEMINI_MODEL || "gemini-2.5-flash").trim();
const DOLIBARR_ENV_ENDPOINT = (
  process.env.DOLIBARR_ENDPOINT ||
  process.env.DOLIBARR_BASE_URL ||
  ""
).trim();
const DOLIBARR_INSECURE_TLS =
  String(process.env.DOLIBARR_INSECURE_TLS || "false").toLowerCase() === "true";
const DOLIBARR_ENV_API_KEY = (process.env.DOLIBARR_API_KEY || "").trim();
const DOLIBARR_PROXY_RULES: Array<{
  prefix: string;
  roles: UserRole[];
}> = [
  { prefix: "/users", roles: ["admin", "hr", "manager"] },
  { prefix: "/salaries", roles: ["admin", "hr", "manager"] },
  { prefix: "/salary", roles: ["admin", "hr", "manager"] },
  { prefix: "/products", roles: ["admin", "hr", "manager", "salesperson"] },
  { prefix: "/thirdparties", roles: ["admin", "hr", "manager", "salesperson"] },
  { prefix: "/orders", roles: ["admin", "hr", "manager", "salesperson"] },
  { prefix: "/invoices", roles: ["admin", "hr", "manager"] },
];
const PRODUCT_STOCK_TABLE = "nmy5_product_stock";
type ProductStockSchema = {
  productIdCol: string;
  qtyCol: string;
  rowIdCol: string | null;
  warehouseCol: string | null;
};
let cachedProductStockSchema: ProductStockSchema | null = null;
const REMOTE_STATE_ALLOWED_KEYS = new Set([
  "@trackforce_companies",
  "@trackforce_employees",
  "@trackforce_attendance",
  "@trackforce_salaries",
  "@trackforce_tasks",
  "@trackforce_expenses",
  "@trackforce_stockists",
  "@trackforce_stock_transfers",
  "@trackforce_incentive_goal_plans",
  "@trackforce_incentive_product_plans",
  "@trackforce_incentive_payouts",
  "@trackforce_conversations",
  "@trackforce_audit_logs",
  "@trackforce_settings",
  "@trackforce_geofences",
  "@trackforce_teams",
  "@trackforce_attendance_photos",
  "@trackforce_attendance_anomalies",
  "@trackforce_location_logs",
  "@trackforce_dolibarr_sync_logs",
  "@trackforce_notifications",
  "@trackforce_support_threads",
]);
const NORMALIZED_STATE_KEYS = new Set([
  "@trackforce_stockists",
  "@trackforce_stock_transfers",
  "@trackforce_incentive_goal_plans",
  "@trackforce_incentive_product_plans",
  "@trackforce_incentive_payouts",
]);

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function normalizeApiSecret(value: string | undefined | null): string {
  if (!value) return "";
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

function pickProductStockColumn(
  columnMap: Map<string, string>,
  candidates: string[]
): string | null {
  for (const name of candidates) {
    const hit = columnMap.get(name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

async function resolveProductStockSchema(conn: Pool): Promise<ProductStockSchema> {
  if (cachedProductStockSchema) return cachedProductStockSchema;
  const [rows] = await conn.query<Array<Record<string, unknown>>>(
    `SHOW COLUMNS FROM \`${PRODUCT_STOCK_TABLE}\``
  );
  if (!rows || !rows.length) {
    throw new Error(`Stock table ${PRODUCT_STOCK_TABLE} not found.`);
  }
  const columnMap = new Map<string, string>();
  for (const row of rows) {
    const name = String((row as { Field?: unknown; COLUMN_NAME?: unknown }).Field ?? (row as { COLUMN_NAME?: unknown }).COLUMN_NAME ?? "");
    if (name) {
      columnMap.set(name.toLowerCase(), name);
    }
  }
  const productIdCol = pickProductStockColumn(columnMap, [
    "fk_product",
    "product_id",
    "productid",
    "fk_product_id",
    "product",
  ]);
  const qtyCol = pickProductStockColumn(columnMap, [
    "reel",
    "stock",
    "qty",
    "quantity",
    "stock_qty",
    "stock_reel",
    "stock_real",
  ]);
  const rowIdCol = pickProductStockColumn(columnMap, [
    "rowid",
    "id",
    "pk",
    "product_stock_id",
  ]);
  const warehouseCol = pickProductStockColumn(columnMap, [
    "fk_entrepot",
    "warehouse_id",
    "fk_warehouse",
    "entrepot_id",
  ]);
  if (!productIdCol || !qtyCol) {
    throw new Error(`Unable to resolve columns for ${PRODUCT_STOCK_TABLE}.`);
  }
  cachedProductStockSchema = { productIdCol, qtyCol, rowIdCol, warehouseCol };
  return cachedProductStockSchema;
}

function normalizeProductIds(raw: unknown): number[] {
  const value = firstString(raw);
  if (!value) return [];
  const ids = value
    .split(/[,\s]+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
  return Array.from(new Set(ids));
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFreshDate(date: Date, maxAgeMs: number): boolean {
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeBatteryLevel(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const scaled = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function parseOptionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "true" || cleaned === "yes" || cleaned === "on") {
    return true;
  }
  if (cleaned === "0" || cleaned === "false" || cleaned === "no" || cleaned === "off") {
    return false;
  }
  return undefined;
}

function parseBooleanQuery(value: unknown, fallback: boolean): boolean {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "true" || cleaned === "yes") return true;
  if (cleaned === "0" || cleaned === "false" || cleaned === "no") return false;
  return fallback;
}

function parseCoordinatePair(
  raw: string | null | undefined
): { latitude: number; longitude: number } | null {
  const value = (raw || "").trim();
  if (!value) return null;
  const tokens = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (tokens.length !== 2) return null;
  const first = Number(tokens[0]);
  const second = Number(tokens[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

  if (Math.abs(first) <= 90 && Math.abs(second) <= 180) {
    return { latitude: first, longitude: second };
  }
  if (Math.abs(first) <= 180 && Math.abs(second) <= 90) {
    return { latitude: second, longitude: first };
  }
  return null;
}

function parseCoordinatesList(raw: string | null | undefined): { latitude: number; longitude: number }[] {
  const value = (raw || "").trim();
  if (!value) return [];
  return value
    .split(/[;|]/g)
    .map((item) => parseCoordinatePair(item))
    .filter((item): item is { latitude: number; longitude: number } => Boolean(item));
}

function parseOptionalQueryFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function maskApiKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (cleaned.length <= 6) {
    return `${cleaned.slice(0, 1)}***${cleaned.slice(-1)}`;
  }
  return `${cleaned.slice(0, 4)}***${cleaned.slice(-3)}`;
}

function normalizeDolibarrEndpoint(value: string | null | undefined): string | null {
  const raw = (value || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/api\/index\.php$/i.test(pathname)) {
      return url.toString().replace(/\/+$/, "");
    }
    if (/\/api$/i.test(pathname)) {
      url.pathname = `${pathname}/index.php`;
      return url.toString().replace(/\/+$/, "");
    }
    url.pathname = `${pathname}/api/index.php`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveDolibarrProxyRule(pathname: string, role: UserRole | undefined): string | null {
  if (!role) return "Missing role.";
  const match = DOLIBARR_PROXY_RULES.find((rule) => pathname.startsWith(rule.prefix));
  if (!match) return "Unsupported Dolibarr path.";
  if (!match.roles.includes(role)) return "Insufficient permissions for Dolibarr path.";
  return null;
}

async function resolveDolibarrProxyConfig(userId: string): Promise<{
  endpoint: string | null;
  apiKey: string | null;
  source: "env" | "settings";
}> {
  const envEndpoint = normalizeDolibarrEndpoint(DOLIBARR_ENV_ENDPOINT);
  const envApiKey = normalizeApiSecret(DOLIBARR_ENV_API_KEY);
  if (envEndpoint && envApiKey) {
    return { endpoint: envEndpoint, apiKey: envApiKey, source: "env" };
  }
  const userConfig = await resolveDolibarrConfigForUser(userId);
  const endpoint = normalizeDolibarrEndpoint(userConfig.endpoint);
  const apiKey = normalizeApiSecret(userConfig.apiKey);
  return { endpoint, apiKey, source: "settings" };
}

async function forwardDolibarrRequest(
  req: Request,
  res: Response,
  options: {
    userId: string;
    forwardPath: string;
  }
) {
  const config = await resolveDolibarrProxyConfig(options.userId);
  const endpoint = config.endpoint;
  const apiKey = config.apiKey;
  if (!endpoint || !apiKey) {
    res.status(400).json({
      message:
        "Dolibarr endpoint and API key are required. Configure DOLIBARR_ENDPOINT and DOLIBARR_API_KEY on the backend.",
    });
    return;
  }

  const method = req.method.toUpperCase();
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : "";
  const base = endpoint.replace(/\/+$/, "");
  const path = options.forwardPath.startsWith("/") ? options.forwardPath : `/${options.forwardPath}`;
  const targetUrl = `${base}${path}${query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const dispatcher =
      DOLIBARR_INSECURE_TLS && endpoint.startsWith("https:")
        ? new (await import("undici")).Agent({
            connect: { rejectUnauthorized: false },
          })
        : undefined;
    const response = await fetch(targetUrl, {
      method,
      dispatcher,
      headers: {
        "Content-Type": "application/json",
        DOLAPIKEY: apiKey,
        "X-Dolibarr-API-Key": apiKey,
      },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
      signal: controller.signal,
    });

    const text = await response.text();
    const contentType = response.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    res.status(response.status).send(text);
  } catch (error) {
    const err = error as { message?: string; cause?: unknown };
    const cause = err?.cause as { code?: string; errno?: string; syscall?: string; hostname?: string } | undefined;
    const extra =
      cause && (cause.code || cause.errno || cause.syscall || cause.hostname)
        ? ` (${[cause.code, cause.errno, cause.syscall, cause.hostname].filter(Boolean).join(" ")})`
        : "";
    const message =
      (err?.message || "Unable to reach Dolibarr endpoint.") + extra;
    console.error("Dolibarr proxy failed", {
      targetUrl,
      message,
      cause,
    });
    res.status(502).json({ message });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDolibarrConfigForUser(
  userId: string,
  overrides?: {
    enabled?: boolean;
    endpoint?: string | null;
    apiKey?: string | null;
  }
): Promise<{
  enabled: boolean;
  endpoint: string | null;
  apiKey: string | null;
  configured: boolean;
  source: "settings" | "env";
}> {
  const stored = await storage.getDolibarrConfigForUser(userId);
  const latestStored = stored ? null : await storage.getLatestDolibarrConfig();
  const endpointValue = (
    overrides?.endpoint ??
    stored?.endpoint ??
    latestStored?.endpoint ??
    DOLIBARR_ENV_ENDPOINT ??
    ""
  ).trim();
  const apiKeyValue = (
    overrides?.apiKey ??
    stored?.apiKey ??
    latestStored?.apiKey ??
    DOLIBARR_ENV_API_KEY ??
    ""
  ).trim();
  const endpoint = endpointValue || null;
  const apiKey = apiKeyValue || null;
  const configured = Boolean(endpoint && apiKey);
    const enabled = true;
  return {
    enabled,
    endpoint,
    apiKey,
    configured,
    source: stored || latestStored ? "settings" : "env",
  };
}

function parseLocationSample(value: unknown): {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  capturedAt?: string | null;
} | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const userId = firstString(body.userId);
  const latitude = parseFiniteNumber(body.latitude);
  const longitude = parseFiniteNumber(body.longitude);
  if (!userId || latitude === null || longitude === null) return null;
  const capturedAt =
    typeof body.capturedAt === "string" && parseIsoDate(body.capturedAt)
      ? body.capturedAt
      : null;
  return {
    userId,
    latitude,
    longitude,
    accuracy: parseFiniteNumber(body.accuracy),
    speed: parseFiniteNumber(body.speed),
    heading: parseFiniteNumber(body.heading),
    batteryLevel: normalizeBatteryLevel(
      parseFiniteNumber(body.batteryLevel ?? body.batteryPercent ?? body.battery_percentage)
    ),
    capturedAt,
  };
}

function parseIntervalMinutes(value: unknown, fallback = 2): number {
  const parsed = parseOptionalInteger(value);
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(30, Math.floor(parsed)));
}

function toTimestampMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function downsampleLocationLogsByInterval(
  points: LocationLog[],
  intervalMinutes: number
): LocationLog[] {
  if (points.length <= 1) return points;
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const sorted = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const sampled: LocationLog[] = [];
  let lastIncludedMs = Number.NaN;

  for (const point of sorted) {
    const pointMs = toTimestampMs(point.capturedAt);
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

interface RouteAttendanceEventLike {
  type: "checkin" | "checkout";
  at: string;
}

interface RouteSessionWindow {
  startAt: string | null;
  endAt: string | null;
}

function resolveRouteSessionWindow(events: RouteAttendanceEventLike[]): RouteSessionWindow {
  const ordered = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const firstCheckIn = ordered.find((entry) => entry.type === "checkin");
  if (!firstCheckIn) return { startAt: null, endAt: null };
  const firstCheckOut = ordered.find(
    (entry) => entry.type === "checkout" && entry.at >= firstCheckIn.at
  );
  return {
    startAt: firstCheckIn.at,
    endAt: firstCheckOut?.at ?? null,
  };
}

function filterLocationLogsToSessionWindow(
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

function parseCheckPayload(req: Request): AttendanceCheckPayload | null {
  const body = req.body as Partial<AttendanceCheckPayload>;
  if (!body || !body.userId || !body.userName) return null;
  if (typeof body.latitude !== "number" || typeof body.longitude !== "number") return null;
  if (!body.deviceId || (body.photoType !== "checkin" && body.photoType !== "checkout")) return null;

  const locationAccuracyMeters = parseFiniteNumber(body.locationAccuracyMeters);
  const geofenceDistanceMeters = parseFiniteNumber(body.geofenceDistanceMeters);
  const faceCount = parseFiniteNumber(body.faceCount);
  const locationSampleCount = parseFiniteNumber(body.locationSampleCount);
  const locationSampleWindowMs = parseFiniteNumber(body.locationSampleWindowMs);
  const biometricRequired = Boolean(body.biometricRequired);
  const biometricVerified = Boolean(body.biometricVerified);
  const biometricType = typeof body.biometricType === "string" ? body.biometricType : null;
  const biometricFailureReason =
    typeof body.biometricFailureReason === "string" ? body.biometricFailureReason : null;

  return {
    userId: body.userId,
    userName: body.userName,
    latitude: body.latitude,
    longitude: body.longitude,
    geofenceId: body.geofenceId ?? null,
    geofenceName: body.geofenceName ?? null,
    photoBase64: body.photoBase64 ?? null,
    photoMimeType: body.photoMimeType ?? "image/jpeg",
    photoType: body.photoType,
    deviceId: body.deviceId,
    isInsideGeofence: Boolean(body.isInsideGeofence),
    notes: body.notes,
    mockLocationDetected: Boolean(body.mockLocationDetected),
    locationAccuracyMeters,
    capturedAtClient: typeof body.capturedAtClient === "string" ? body.capturedAtClient : undefined,
    photoCapturedAt: typeof body.photoCapturedAt === "string" ? body.photoCapturedAt : null,
    geofenceDistanceMeters,
    faceDetected: Boolean(body.faceDetected),
    faceCount,
    faceDetector: typeof body.faceDetector === "string" ? body.faceDetector : null,
    locationSampleCount,
    locationSampleWindowMs,
    biometricRequired,
    biometricVerified,
    biometricType,
    biometricFailureReason,
  };
}

function ensureUserMatch(req: Request, userId: string): boolean {
  if (!req.auth) return false;
  return req.auth.sub === userId || ["admin", "hr", "manager"].includes(req.auth.role);
}

interface AuthUserRecord {
  user: AppUser;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  approvalStatus?: "pending" | "approved" | "rejected";
}

type AccessRequestRecord = UserAccessRequest & {
  passwordHash?: string | null;
};

const authUsersByEmail = new Map<string, AuthUserRecord>();
const authUsersByLogin = new Map<string, AuthUserRecord>();
const accessRequestsById = new Map<string, AccessRequestRecord>();
const inMemoryStateStore = new Map<string, string>();

function setAuthUserRecord(record: AuthUserRecord): void {
  const emailKey = normalizeEmailKey(record.user.email);
  if (emailKey) {
    authUsersByEmail.set(emailKey, record);
  }
  const loginKey = normalizeLoginKey(record.user.login);
  if (loginKey) {
    authUsersByLogin.set(loginKey, record);
  }
}

function removeAuthUserByEmail(email: string): void {
  const emailKey = normalizeEmailKey(email);
  const record = authUsersByEmail.get(emailKey);
  if (record?.user.login) {
    authUsersByLogin.delete(normalizeLoginKey(record.user.login));
  }
  authUsersByEmail.delete(emailKey);
}

function removeAuthUserByLogin(login: string): void {
  const loginKey = normalizeLoginKey(login);
  const record = authUsersByLogin.get(loginKey);
  if (record?.user.email) {
    authUsersByEmail.delete(normalizeEmailKey(record.user.email));
  }
  authUsersByLogin.delete(loginKey);
}

function getAuthUserByIdentifier(identifier: string): AuthUserRecord | null {
  const trimmed = normalizeWhitespace(identifier);
  if (!trimmed) return null;
  const normalizedEmail = normalizeEmailKey(trimmed);
  const loginCandidate = trimmed.includes("@") ? trimmed.split("@")[0] || trimmed : trimmed;
  const normalizedLogin = normalizeLoginKey(loginCandidate);
  if (normalizedEmail) {
    const byEmail = authUsersByEmail.get(normalizedEmail);
    if (byEmail) return byEmail;
  }
  if (normalizedLogin) {
    const byLogin = authUsersByLogin.get(normalizedLogin);
    if (byLogin) return byLogin;
  }
  return null;
}

async function ensureCompanyExistsInMySql(companyId: string, companyName: string): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const safeName = companyName?.trim() || PENDING_COMPANY_NAME;
  const safeId = companyId?.trim() || PENDING_COMPANY_ID;
  await conn.execute(
    `INSERT INTO lff_companies (
      id, name, legal_name, industry, headquarters, primary_branch, support_email, support_phone,
      attendance_zone_label, created_at, updated_at
    ) VALUES (?, ?, ?, 'General', 'India', 'Primary', 'support@axionmeditech.com', '', 'Main Zone', NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      legal_name = VALUES(legal_name),
      updated_at = NOW()`,
    [safeId, safeName, safeName]
  );
}

async function upsertAuthUserInMySql(record: AuthUserRecord, requestedCompanyName?: string | null): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const user = record.user;
  const normalizedEmail = normalizeEmail(user.email || "");
  const baseLogin = normalizeLoginKey(user.login || buildLoginFromEmailAndName(normalizedEmail, user.name));
  const login = baseLogin || buildLoginFromEmailAndName(normalizedEmail, user.name);
  const safeEmail = normalizedEmail || `${login}@dolibarr.local`;
  const cleanedName = normalizeWhitespace(user.name);
  const nameParts = cleanedName.split(" ").filter(Boolean);
  const firstName = nameParts.shift() || login || "Employee";
  const lastName = nameParts.join(" ") || "User";
  const adminFlag = user.role === "admin" ? 1 : 0;
  const employeeFlag = user.role === "admin" ? 0 : 1;
  const phone = normalizeWhitespace(user.phone || "");
  const passwordHash = isLikelyMd5(record.passwordHash) ? record.passwordHash.trim().toLowerCase() : "";
  const approvalStatus = resolveApprovalStatus(record);
  const statutFlag = approvalStatus === "approved" ? 1 : 0;

  const [rows] = await conn.query<any[]>(
    `SELECT rowid, login FROM nmy5_user WHERE email = ? OR login = ? LIMIT 1`,
    [safeEmail, login]
  );
  if (rows && rows.length > 0) {
    const rowid = rows[0].rowid;
    await conn.execute(
      `UPDATE nmy5_user
       SET login = ?, email = ?, firstname = ?, lastname = ?, admin = ?, employee = ?,
           office_phone = ?, user_mobile = ?, pass_crypted = COALESCE(?, pass_crypted),
           statut = ?, tms = NOW()
       WHERE rowid = ?`,
      [
        login,
        safeEmail,
        firstName,
        lastName,
        adminFlag,
        employeeFlag,
        phone || null,
        phone || null,
        passwordHash || null,
        statutFlag,
        rowid,
      ]
    );
    return;
  }

  const insertUser = async (nextLogin: string): Promise<void> => {
    await conn.execute(
      `INSERT INTO nmy5_user (
        login, email, firstname, lastname, pass_crypted, admin, employee, statut, entity,
        office_phone, user_mobile, datec, tms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
      [
        nextLogin,
        safeEmail,
        firstName,
        lastName,
        passwordHash || null,
        adminFlag,
        employeeFlag,
        statutFlag,
        phone || null,
        phone || null,
      ]
    );
  };

  try {
    await insertUser(login);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/duplicate|already exists|unique/i.test(message)) {
      const suffix = Date.now().toString(36).slice(-4);
      await insertUser(`${login}_${suffix}`);
      return;
    }
    throw error;
  }
}

function toPublicAccessRequest(entry: AccessRequestRecord): UserAccessRequest {
  const { passwordHash: _passwordHash, ...rest } = entry;
  return rest;
}

async function insertAccessRequestInMySql(entry: AccessRequestRecord): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  try {
    await conn.execute(
      `INSERT INTO lff_access_requests (
        id, name, email, requested_role, approved_role, requested_department, requested_branch,
        requested_company_name, status, requested_at, reviewed_at, reviewed_by_id, reviewed_by_name,
        review_comment, assigned_company_ids_json, assigned_manager_id, assigned_manager_name,
        password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        approved_role = VALUES(approved_role),
        status = VALUES(status),
        reviewed_at = VALUES(reviewed_at),
        reviewed_by_id = VALUES(reviewed_by_id),
        reviewed_by_name = VALUES(reviewed_by_name),
        review_comment = VALUES(review_comment),
        assigned_company_ids_json = VALUES(assigned_company_ids_json),
        assigned_manager_id = VALUES(assigned_manager_id),
        assigned_manager_name = VALUES(assigned_manager_name),
        password_hash = VALUES(password_hash)`,
      [
        entry.id,
        entry.name,
        entry.email,
        entry.requestedRole,
        entry.approvedRole ?? null,
        entry.requestedDepartment ?? "",
        entry.requestedBranch ?? "",
        entry.requestedCompanyName ?? null,
        entry.status,
        entry.requestedAt.slice(0, 19).replace("T", " "),
        entry.reviewedAt ? entry.reviewedAt.slice(0, 19).replace("T", " ") : null,
        entry.reviewedById ?? null,
        entry.reviewedByName ?? null,
        entry.reviewComment ?? null,
        JSON.stringify(entry.assignedCompanyIds || []),
        entry.assignedManagerId ?? null,
        entry.assignedManagerName ?? null,
        entry.passwordHash ?? null,
      ]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/unknown column|password_hash/i.test(message)) {
      throw error;
    }
    await conn.execute(
      `INSERT INTO lff_access_requests (
        id, name, email, requested_role, approved_role, requested_department, requested_branch,
        requested_company_name, status, requested_at, reviewed_at, reviewed_by_id, reviewed_by_name,
        review_comment, assigned_company_ids_json, assigned_manager_id, assigned_manager_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        approved_role = VALUES(approved_role),
        status = VALUES(status),
        reviewed_at = VALUES(reviewed_at),
        reviewed_by_id = VALUES(reviewed_by_id),
        reviewed_by_name = VALUES(reviewed_by_name),
        review_comment = VALUES(review_comment),
        assigned_company_ids_json = VALUES(assigned_company_ids_json),
        assigned_manager_id = VALUES(assigned_manager_id),
        assigned_manager_name = VALUES(assigned_manager_name)`,
      [
        entry.id,
        entry.name,
        entry.email,
        entry.requestedRole,
        entry.approvedRole ?? null,
        entry.requestedDepartment ?? "",
        entry.requestedBranch ?? "",
        entry.requestedCompanyName ?? null,
        entry.status,
        entry.requestedAt.slice(0, 19).replace("T", " "),
        entry.reviewedAt ? entry.reviewedAt.slice(0, 19).replace("T", " ") : null,
        entry.reviewedById ?? null,
        entry.reviewedByName ?? null,
        entry.reviewComment ?? null,
        JSON.stringify(entry.assignedCompanyIds || []),
        entry.assignedManagerId ?? null,
        entry.assignedManagerName ?? null,
      ]
    );
  }
}

async function listAccessRequestsFromMySql(
  status: UserAccessRequest["status"] | null
): Promise<AccessRequestRecord[]> {
  const conn = await getMySqlPool();
  const params: unknown[] = [];
  let sql = `SELECT * FROM lff_access_requests`;
  if (status) {
    sql += ` WHERE status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY requested_at DESC`;
  const [rows] = await conn.query<any[]>(sql, params);
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    requestedRole: (row.requested_role || "salesperson") as UserRole,
    approvedRole: row.approved_role ? (row.approved_role as UserRole) : null,
    requestedDepartment: String(row.requested_department || ""),
    requestedBranch: String(row.requested_branch || ""),
    requestedCompanyName: row.requested_company_name ? String(row.requested_company_name) : undefined,
    status: row.status as UserAccessRequest["status"],
    requestedAt: new Date(row.requested_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedById: row.reviewed_by_id ? String(row.reviewed_by_id) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewComment: row.review_comment ? String(row.review_comment) : null,
    assignedCompanyIds: (() => {
      try {
        const parsed = JSON.parse(String(row.assigned_company_ids_json || "[]"));
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
      } catch {
        return [];
      }
    })(),
    assignedManagerId: row.assigned_manager_id ? String(row.assigned_manager_id) : null,
    assignedManagerName: row.assigned_manager_name ? String(row.assigned_manager_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  }));
}

async function getAccessRequestByIdFromMySql(id: string): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_access_requests WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    requestedRole: (row.requested_role || "salesperson") as UserRole,
    approvedRole: row.approved_role ? (row.approved_role as UserRole) : null,
    requestedDepartment: String(row.requested_department || ""),
    requestedBranch: String(row.requested_branch || ""),
    requestedCompanyName: row.requested_company_name ? String(row.requested_company_name) : undefined,
    status: row.status as UserAccessRequest["status"],
    requestedAt: new Date(row.requested_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedById: row.reviewed_by_id ? String(row.reviewed_by_id) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewComment: row.review_comment ? String(row.review_comment) : null,
    assignedCompanyIds: (() => {
      try {
        const parsed = JSON.parse(String(row.assigned_company_ids_json || "[]"));
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
      } catch {
        return [];
      }
    })(),
    assignedManagerId: row.assigned_manager_id ? String(row.assigned_manager_id) : null,
    assignedManagerName: row.assigned_manager_name ? String(row.assigned_manager_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeEmailKey(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeLoginKey(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function hashPassword(password: string): string {
  return createHash("md5").update(password).digest("hex");
}

function hashPasswordLegacy(password: string): string {
  return createHash("sha256").update(`trackforce::${password}`).digest("hex");
}

function matchesStoredPasswordHash(storedHash: string | null | undefined, password: string): boolean {
  const normalized = (storedHash || "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === hashPassword(password) || normalized === hashPasswordLegacy(password);
}

function isLikelyMd5(value: string | null | undefined): boolean {
  const normalized = (value || "").trim();
  return /^[a-f0-9]{32}$/i.test(normalized);
}

function normalizeRole(role: unknown): UserRole {
  if (role === "admin" || role === "hr" || role === "manager" || role === "salesperson") {
    return role;
  }
  return "salesperson";
}

function parseRequestStatus(
  value: unknown
): UserAccessRequest["status"] | null {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  return null;
}

function normalizeCompanyIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const entry of value) {
    const normalized = normalizeWhitespace(typeof entry === "string" ? entry : "");
    if (normalized) output.push(normalized);
  }
  return Array.from(new Set(output));
}

function resolveApprovalStatus(
  record: AuthUserRecord
): "pending" | "approved" | "rejected" {
  if (
    record.approvalStatus === "pending" ||
    record.approvalStatus === "approved" ||
    record.approvalStatus === "rejected"
  ) {
    return record.approvalStatus;
  }
  if (
    record.user.approvalStatus === "pending" ||
    record.user.approvalStatus === "approved" ||
    record.user.approvalStatus === "rejected"
  ) {
    return record.user.approvalStatus;
  }
  return "approved";
}

function getLatestPendingAccessRequestByEmail(email: string): UserAccessRequest | null {
  const normalized = normalizeEmailKey(email);
  let latest: UserAccessRequest | null = null;
  for (const request of accessRequestsById.values()) {
    if (request.status !== "pending") continue;
    if (normalizeEmailKey(request.email) !== normalized) continue;
    if (!latest || request.requestedAt > latest.requestedAt) {
      latest = request;
    }
  }
  return latest;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

function parseDateKeyToUtcRange(
  dateKey: string
): { start: string; end: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateKey || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const startUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - IST_OFFSET_MS);
  const endUtc = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - IST_OFFSET_MS);
  return {
    start: startUtc.toISOString().slice(0, 19).replace("T", " "),
    end: endUtc.toISOString().slice(0, 19).replace("T", " "),
  };
}

function getLatestAccessRequestByEmail(email: string): AccessRequestRecord | null {
  const normalized = normalizeEmailKey(email);
  let latest: AccessRequestRecord | null = null;
  for (const request of accessRequestsById.values()) {
    if (normalizeEmailKey(request.email) !== normalized) continue;
    if (!latest || request.requestedAt > latest.requestedAt) {
      latest = request;
    }
  }
  return latest;
}

function mapLocationLogRow(row: any): LocationLog {
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    userId: String(row.user_id),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracy: row.accuracy === null || row.accuracy === undefined ? null : Number(row.accuracy),
    speed: row.speed === null || row.speed === undefined ? null : Number(row.speed),
    heading: row.heading === null || row.heading === undefined ? null : Number(row.heading),
    batteryLevel:
      row.battery_level === null || row.battery_level === undefined
        ? null
        : Number(row.battery_level),
    geofenceId: row.geofence_id ? String(row.geofence_id) : null,
    geofenceName: row.geofence_name ? String(row.geofence_name) : null,
    isInsideGeofence: Boolean(row.is_inside_geofence),
    capturedAt: new Date(row.captured_at).toISOString(),
  };
}

async function insertLocationLogInMySql(log: LocationLog): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_location_logs (
      id, company_id, user_id, latitude, longitude, accuracy, speed, heading, battery_level,
      geofence_id, geofence_name, is_inside_geofence, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      latitude = VALUES(latitude),
      longitude = VALUES(longitude),
      accuracy = VALUES(accuracy),
      speed = VALUES(speed),
      heading = VALUES(heading),
      battery_level = VALUES(battery_level),
      geofence_id = VALUES(geofence_id),
      geofence_name = VALUES(geofence_name),
      is_inside_geofence = VALUES(is_inside_geofence),
      captured_at = VALUES(captured_at)`,
    [
      log.id,
      log.companyId ?? null,
      log.userId,
      log.latitude,
      log.longitude,
      log.accuracy ?? null,
      log.speed ?? null,
      log.heading ?? null,
      log.batteryLevel ?? null,
      log.geofenceId ?? null,
      log.geofenceName ?? null,
      log.isInsideGeofence ? 1 : 0,
      new Date(log.capturedAt).toISOString().slice(0, 19).replace("T", " "),
    ]
  );
}

async function listLocationLogsLatestFromMySql(): Promise<LocationLog[]> {
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs ORDER BY captured_at DESC LIMIT 5000`
  );
  const latestByUser = new Map<string, LocationLog>();
  for (const row of rows) {
    const log = mapLocationLogRow(row);
    if (!latestByUser.has(log.userId)) {
      latestByUser.set(log.userId, log);
    }
  }
  return Array.from(latestByUser.values());
}

async function listLocationLogsForDateFromMySql(dateKey: string): Promise<LocationLog[]> {
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs
     WHERE captured_at BETWEEN ? AND ?
     ORDER BY captured_at ASC`,
    [range.start, range.end]
  );
  return rows.map(mapLocationLogRow);
}

async function listLocationLogsForUserDateFromMySql(
  userId: string,
  dateKey: string
): Promise<LocationLog[]> {
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs
     WHERE user_id = ? AND captured_at BETWEEN ? AND ?
     ORDER BY captured_at ASC`,
    [userId, range.start, range.end]
  );
  return rows.map(mapLocationLogRow);
}

async function getLatestAccessRequestByEmailFromMySql(
  email: string
): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  const normalized = normalizeEmail(email);
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_access_requests
     WHERE email = ?
     ORDER BY requested_at DESC
     LIMIT 1`,
    [normalized]
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    requestedRole: (row.requested_role || "salesperson") as UserRole,
    approvedRole: row.approved_role ? (row.approved_role as UserRole) : null,
    requestedDepartment: String(row.requested_department || ""),
    requestedBranch: String(row.requested_branch || ""),
    requestedCompanyName: row.requested_company_name ? String(row.requested_company_name) : undefined,
    status: row.status as UserAccessRequest["status"],
    requestedAt: new Date(row.requested_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedById: row.reviewed_by_id ? String(row.reviewed_by_id) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewComment: row.review_comment ? String(row.review_comment) : null,
    assignedCompanyIds: (() => {
      try {
        const parsed = JSON.parse(String(row.assigned_company_ids_json || "[]"));
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
      } catch {
        return [];
      }
    })(),
    assignedManagerId: row.assigned_manager_id ? String(row.assigned_manager_id) : null,
    assignedManagerName: row.assigned_manager_name ? String(row.assigned_manager_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

async function getLatestPendingAccessRequestByEmailFromMySql(
  email: string
): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  const normalized = normalizeEmail(email);
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_access_requests
     WHERE email = ? AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1`,
    [normalized]
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    name: String(row.name || ""),
    email: String(row.email || ""),
    requestedRole: (row.requested_role || "salesperson") as UserRole,
    approvedRole: row.approved_role ? (row.approved_role as UserRole) : null,
    requestedDepartment: String(row.requested_department || ""),
    requestedBranch: String(row.requested_branch || ""),
    requestedCompanyName: row.requested_company_name ? String(row.requested_company_name) : undefined,
    status: row.status as UserAccessRequest["status"],
    requestedAt: new Date(row.requested_at).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    reviewedById: row.reviewed_by_id ? String(row.reviewed_by_id) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewComment: row.review_comment ? String(row.review_comment) : null,
    assignedCompanyIds: (() => {
      try {
        const parsed = JSON.parse(String(row.assigned_company_ids_json || "[]"));
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
      } catch {
        return [];
      }
    })(),
    assignedManagerId: row.assigned_manager_id ? String(row.assigned_manager_id) : null,
    assignedManagerName: row.assigned_manager_name ? String(row.assigned_manager_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

function isRemoteStateKeyAllowed(key: string): boolean {
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
}

function isNormalizedStateKey(key: string): boolean {
  return NORMALIZED_STATE_KEYS.has(key);
}

function toNullableText(value: unknown): string | null {
  const normalized = normalizeWhitespace(String(value ?? ""));
  return normalized ? normalized : null;
}

function toRequiredText(value: unknown, fallback: string): string {
  return normalizeWhitespace(String(value ?? "")) || fallback;
}

function toStringId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

async function listStockistsFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, name, phone, location, pincode, notes, created_at, updated_at
    FROM lff_stockists
    ORDER BY updated_at DESC
  `);
  const nowIso = new Date().toISOString();
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    name: toRequiredText(row.name, "Channel Partner"),
    phone: row.phone ? String(row.phone) : undefined,
    location: row.location ? String(row.location) : undefined,
    pincode: row.pincode ? String(row.pincode) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: toIsoTimestamp(row.created_at, nowIso),
    updatedAt: toIsoTimestamp(row.updated_at, nowIso),
  }));
}

async function listStockTransfersFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, stockist_id, stockist_name, transfer_type, item_name, item_id,
           quantity, unit_label, salesperson_id, salesperson_name, note, created_at
    FROM lff_stock_transfers
    ORDER BY created_at DESC
  `);
  const nowIso = new Date().toISOString();
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    stockistId: row.stockist_id ? String(row.stockist_id) : "",
    stockistName: toRequiredText(row.stockist_name, "Channel Partner"),
    type: row.transfer_type === "out" ? "out" : "in",
    itemName: toRequiredText(row.item_name, "Item"),
    itemId: row.item_id ? String(row.item_id) : undefined,
    quantity: Number.isFinite(Number(row.quantity)) ? Number(row.quantity) : 0,
    unitLabel: row.unit_label ? String(row.unit_label) : undefined,
    salespersonId: row.salesperson_id ? String(row.salesperson_id) : undefined,
    salespersonName: row.salesperson_name ? String(row.salesperson_name) : undefined,
    note: row.note ? String(row.note) : undefined,
    createdAt: toIsoTimestamp(row.created_at, nowIso),
  }));
}

let incentiveTablesEnsured = false;

async function ensureIncentiveTables(): Promise<void> {
  if (incentiveTablesEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_incentive_goal_plans\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`title\` VARCHAR(191) NOT NULL,
      \`period\` ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'monthly',
      \`target_qty\` INT NOT NULL DEFAULT 0,
      \`threshold_percent\` DECIMAL(5,2) NOT NULL DEFAULT 0,
      \`per_unit_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` DATETIME NOT NULL,
      \`updated_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_incentive_goal_company\` (\`company_id\`),
      KEY \`idx_lff_incentive_goal_period\` (\`period\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_incentive_product_plans\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`product_id\` VARCHAR(64) NULL,
      \`product_name\` VARCHAR(191) NOT NULL,
      \`per_unit_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` DATETIME NOT NULL,
      \`updated_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_incentive_product_company\` (\`company_id\`),
      KEY \`idx_lff_incentive_product_product\` (\`product_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_incentive_payouts\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`salesperson_id\` VARCHAR(64) NOT NULL,
      \`salesperson_name\` VARCHAR(191) NOT NULL,
      \`range_key\` ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'monthly',
      \`range_start\` DATE NOT NULL,
      \`range_end\` DATE NOT NULL,
      \`goal_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`product_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`total_amount\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`status\` ENUM('pending','paid') NOT NULL DEFAULT 'pending',
      \`note\` LONGTEXT NULL,
      \`created_at\` DATETIME NOT NULL,
      \`created_by_id\` VARCHAR(64) NULL,
      \`created_by_name\` VARCHAR(191) NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_incentive_payout_company\` (\`company_id\`),
      KEY \`idx_lff_incentive_payout_salesperson\` (\`salesperson_id\`),
      KEY \`idx_lff_incentive_payout_range\` (\`range_key\`, \`range_start\`, \`range_end\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  incentiveTablesEnsured = true;
}

async function listIncentiveGoalPlansFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureIncentiveTables();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, title, period, target_qty, threshold_percent, per_unit_amount,
           active, created_at, updated_at
    FROM lff_incentive_goal_plans
    ORDER BY updated_at DESC
  `);
  const nowIso = new Date().toISOString();
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    title: toRequiredText(row.title, "Incentive Plan"),
    period: row.period === "daily" || row.period === "weekly" ? row.period : "monthly",
    targetQty: Number.isFinite(Number(row.target_qty)) ? Number(row.target_qty) : 0,
    thresholdPercent: Number.isFinite(Number(row.threshold_percent))
      ? Number(row.threshold_percent)
      : 0,
    perUnitAmount: Number.isFinite(Number(row.per_unit_amount)) ? Number(row.per_unit_amount) : 0,
    active: Boolean(row.active),
    createdAt: toIsoTimestamp(row.created_at, nowIso),
    updatedAt: toIsoTimestamp(row.updated_at, nowIso),
  }));
}

async function listIncentiveProductPlansFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureIncentiveTables();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, product_id, product_name, per_unit_amount, active, created_at, updated_at
    FROM lff_incentive_product_plans
    ORDER BY updated_at DESC
  `);
  const nowIso = new Date().toISOString();
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    productId: row.product_id ? String(row.product_id) : undefined,
    productName: toRequiredText(row.product_name, "Product"),
    perUnitAmount: Number.isFinite(Number(row.per_unit_amount)) ? Number(row.per_unit_amount) : 0,
    active: Boolean(row.active),
    createdAt: toIsoTimestamp(row.created_at, nowIso),
    updatedAt: toIsoTimestamp(row.updated_at, nowIso),
  }));
}

async function listIncentivePayoutsFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureIncentiveTables();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, salesperson_id, salesperson_name, range_key, range_start, range_end,
           goal_amount, product_amount, total_amount, status, note, created_at,
           created_by_id, created_by_name
    FROM lff_incentive_payouts
    ORDER BY created_at DESC
  `);
  const nowIso = new Date().toISOString();
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    salespersonId: row.salesperson_id ? String(row.salesperson_id) : "",
    salespersonName: toRequiredText(row.salesperson_name, "Salesperson"),
    rangeKey: row.range_key === "daily" || row.range_key === "weekly" ? row.range_key : "monthly",
    rangeStart: row.range_start ? new Date(row.range_start).toISOString().slice(0, 10) : nowIso.slice(0, 10),
    rangeEnd: row.range_end ? new Date(row.range_end).toISOString().slice(0, 10) : nowIso.slice(0, 10),
    goalAmount: Number.isFinite(Number(row.goal_amount)) ? Number(row.goal_amount) : 0,
    productAmount: Number.isFinite(Number(row.product_amount)) ? Number(row.product_amount) : 0,
    totalAmount: Number.isFinite(Number(row.total_amount)) ? Number(row.total_amount) : 0,
    createdAt: toIsoTimestamp(row.created_at, nowIso),
    createdById: row.created_by_id ? String(row.created_by_id) : undefined,
    createdByName: row.created_by_name ? String(row.created_by_name) : undefined,
    status: row.status === "paid" ? "paid" : "pending",
    note: row.note ? String(row.note) : undefined,
  }));
}

async function replaceStockistsInMySql(entries: unknown[]): Promise<void> {
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_stockists");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      if (!id) continue;
      const companyId = toNullableText((entry as any).companyId);
      const name = toRequiredText((entry as any).name, "Channel Partner");
      const phone = toNullableText((entry as any).phone);
      const location = toNullableText((entry as any).location);
      const pincode = toNullableText((entry as any).pincode);
      const notes = toNullableText((entry as any).notes);
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      const updatedAt = toSqlTimestamp((entry as any).updatedAt ?? (entry as any).createdAt);
      await conn.execute(
        `INSERT INTO lff_stockists
          (id, company_id, name, phone, location, pincode, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, companyId, name, phone, location, pincode, notes, createdAt, updatedAt]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function replaceStockTransfersInMySql(entries: unknown[]): Promise<void> {
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_stock_transfers");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      const stockistId = toStringId((entry as any).stockistId);
      if (!id || !stockistId) continue;
      const companyId = toNullableText((entry as any).companyId);
      const stockistName = toRequiredText((entry as any).stockistName, "Channel Partner");
      const transferType = (entry as any).type === "out" ? "out" : "in";
      const itemName = toRequiredText((entry as any).itemName, "Item");
      const itemId = toNullableText((entry as any).itemId);
      const quantity = toSqlNumber((entry as any).quantity);
      const unitLabel = toNullableText((entry as any).unitLabel);
      const salespersonId = toNullableText((entry as any).salespersonId);
      const salespersonName = toNullableText((entry as any).salespersonName);
      const note = toNullableText((entry as any).note);
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      await conn.execute(
        `INSERT INTO lff_stock_transfers
          (id, company_id, stockist_id, stockist_name, transfer_type, item_name, item_id,
           quantity, unit_label, salesperson_id, salesperson_name, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          companyId,
          stockistId,
          stockistName,
          transferType,
          itemName,
          itemId,
          quantity,
          unitLabel,
          salespersonId,
          salespersonName,
          note,
          createdAt,
        ]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function replaceIncentiveGoalPlansInMySql(entries: unknown[]): Promise<void> {
  await ensureIncentiveTables();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_incentive_goal_plans");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      if (!id) continue;
      const companyId = toNullableText((entry as any).companyId);
      const title = toRequiredText((entry as any).title, "Incentive Plan");
      const periodRaw = (entry as any).period;
      const period =
        periodRaw === "daily" || periodRaw === "weekly" || periodRaw === "monthly"
          ? periodRaw
          : "monthly";
      const targetQty = Math.max(0, Math.floor(toSqlNumber((entry as any).targetQty)));
      const thresholdPercent = Math.max(0, toSqlNumber((entry as any).thresholdPercent));
      const perUnitAmount = Math.max(0, toSqlNumber((entry as any).perUnitAmount));
      const active = toSqlBoolean((entry as any).active, true);
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      const updatedAt = toSqlTimestamp((entry as any).updatedAt ?? (entry as any).createdAt);
      await conn.execute(
        `INSERT INTO lff_incentive_goal_plans
          (id, company_id, title, period, target_qty, threshold_percent, per_unit_amount, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          companyId,
          title,
          period,
          targetQty,
          thresholdPercent,
          perUnitAmount,
          active,
          createdAt,
          updatedAt,
        ]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function replaceIncentiveProductPlansInMySql(entries: unknown[]): Promise<void> {
  await ensureIncentiveTables();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_incentive_product_plans");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      if (!id) continue;
      const companyId = toNullableText((entry as any).companyId);
      const productId = toNullableText((entry as any).productId);
      const productName = toRequiredText((entry as any).productName, "Product");
      const perUnitAmount = Math.max(0, toSqlNumber((entry as any).perUnitAmount));
      const active = toSqlBoolean((entry as any).active, true);
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      const updatedAt = toSqlTimestamp((entry as any).updatedAt ?? (entry as any).createdAt);
      await conn.execute(
        `INSERT INTO lff_incentive_product_plans
          (id, company_id, product_id, product_name, per_unit_amount, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, companyId, productId, productName, perUnitAmount, active, createdAt, updatedAt]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function replaceIncentivePayoutsInMySql(entries: unknown[]): Promise<void> {
  await ensureIncentiveTables();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_incentive_payouts");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      if (!id) continue;
      const companyId = toNullableText((entry as any).companyId);
      const salespersonId = toStringId((entry as any).salespersonId) || "";
      const salespersonName = toRequiredText((entry as any).salespersonName, "Salesperson");
      const rangeKeyRaw = (entry as any).rangeKey;
      const rangeKey =
        rangeKeyRaw === "daily" || rangeKeyRaw === "weekly" || rangeKeyRaw === "monthly"
          ? rangeKeyRaw
          : "monthly";
      const rangeStart = toSqlDateOnly((entry as any).rangeStart);
      const rangeEnd = toSqlDateOnly((entry as any).rangeEnd);
      const goalAmount = Math.max(0, toSqlNumber((entry as any).goalAmount));
      const productAmount = Math.max(0, toSqlNumber((entry as any).productAmount));
      const totalAmount = Math.max(0, toSqlNumber((entry as any).totalAmount));
      const status = (entry as any).status === "paid" ? "paid" : "pending";
      const note = toNullableText((entry as any).note);
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      const createdById = toNullableText((entry as any).createdById);
      const createdByName = toNullableText((entry as any).createdByName);
      await conn.execute(
        `INSERT INTO lff_incentive_payouts
          (id, company_id, salesperson_id, salesperson_name, range_key, range_start, range_end,
           goal_amount, product_amount, total_amount, status, note, created_at, created_by_id, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          companyId,
          salespersonId,
          salespersonName,
          rangeKey,
          rangeStart,
          rangeEnd,
          goalAmount,
          productAmount,
          totalAmount,
          status,
          note,
          createdAt,
          createdById,
          createdByName,
        ]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function readNormalizedState(key: string): Promise<unknown[] | undefined> {
  if (!isNormalizedStateKey(key)) return undefined;
  if (key === "@trackforce_stockists") return listStockistsFromMySql();
  if (key === "@trackforce_stock_transfers") return listStockTransfersFromMySql();
  if (key === "@trackforce_incentive_goal_plans") return listIncentiveGoalPlansFromMySql();
  if (key === "@trackforce_incentive_product_plans") return listIncentiveProductPlansFromMySql();
  if (key === "@trackforce_incentive_payouts") return listIncentivePayoutsFromMySql();
  return undefined;
}

async function writeNormalizedState(key: string, jsonValue: string): Promise<boolean> {
  if (!isNormalizedStateKey(key)) return false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonValue);
  } catch {
    parsed = null;
  }
  const entries = Array.isArray(parsed) ? parsed : [];
  if (key === "@trackforce_stockists") {
    await replaceStockistsInMySql(entries);
    return true;
  }
  if (key === "@trackforce_stock_transfers") {
    await replaceStockTransfersInMySql(entries);
    return true;
  }
  if (key === "@trackforce_incentive_goal_plans") {
    await replaceIncentiveGoalPlansInMySql(entries);
    return true;
  }
  if (key === "@trackforce_incentive_product_plans") {
    await replaceIncentiveProductPlansInMySql(entries);
    return true;
  }
  if (key === "@trackforce_incentive_payouts") {
    await replaceIncentivePayoutsInMySql(entries);
    return true;
  }
  return false;
}

async function readRemoteState(key: string): Promise<string | null> {
  if (isMySqlStateEnabled()) {
    try {
      const normalized = await readNormalizedState(key);
      if (typeof normalized !== "undefined") {
        return JSON.stringify(normalized ?? null);
      }
    } catch {
      // fall through to legacy app state below
    }
    try {
      return await getMySqlStateValue(key);
    } catch {
      // fallback to in-memory state so APIs stay usable when DB is temporarily unavailable
    }
  }
  return inMemoryStateStore.get(key) ?? null;
}

async function writeRemoteState(key: string, jsonValue: string): Promise<void> {
  if (isMySqlStateEnabled()) {
    let handled = false;
    try {
      handled = await writeNormalizedState(key, jsonValue);
    } catch {
      handled = false;
    }
    // keep legacy state table populated for compatibility and fallback
    if (!handled) {
      await setMySqlStateValue(key, jsonValue);
      return;
    }
    await setMySqlStateValue(key, jsonValue);
  } else {
    inMemoryStateStore.set(key, jsonValue);
  }
}

function roleToDepartment(role: UserRole): string {
  if (role === "admin") return "Management";
  if (role === "hr") return "Human Resources";
  if (role === "manager") return "Operations";
  return "Sales";
}

function normalizeCompanyName(value: string): string {
  const cleaned = normalizeWhitespace(value);
  return cleaned || DEFAULT_COMPANY_NAME;
}

function getCompanyIdFromName(companyName: string): string {
  const slug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 42);
  return slug ? `cmp_${slug}` : DEFAULT_COMPANY_ID;
}

async function hasAnyApprovedAdmin(): Promise<boolean> {
  if (isMySqlStateEnabled()) {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query<any[]>(
        `SELECT rowid FROM nmy5_user
         WHERE admin = 1
           AND statut = 1
         LIMIT 1`
      );
      if (rows && rows.length > 0) return true;
    } catch {
      // fallback to in-memory cache below if DB read fails
    }
  }

  for (const record of authUsersByEmail.values()) {
    if (resolveApprovalStatus(record) !== "approved") continue;
    if (record.user.role !== "admin") continue;
    return true;
  }
  return false;
}

function toIsoTimestamp(value: unknown, fallbackIso: string): string {
  if (typeof value === "string") {
    const parsed = parseIsoDate(value);
    if (parsed) return parsed.toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return fallbackIso;
}

function toSqlTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = parseIsoDate(value);
    if (parsed) return parsed.toISOString().slice(0, 19).replace("T", " ");
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function toSqlDateOnly(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
    const parsed = parseIsoDate(trimmed);
    if (parsed) return parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function toSqlNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function toSqlBoolean(value: unknown, defaultValue = true): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value === 0 ? 0 : 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return 0;
    if (["1", "true", "yes", "on"].includes(normalized)) return 1;
  }
  return defaultValue ? 1 : 0;
}

function normalizeNotificationAudience(value: unknown): NotificationAudience {
  if (value === "all") return "all";
  if (value === "admin" || value === "hr" || value === "manager" || value === "salesperson") {
    return value;
  }
  return "all";
}

function normalizeNotificationKind(value: unknown): AppNotification["kind"] {
  if (value === "announcement" || value === "policy" || value === "alert" || value === "support") {
    return value;
  }
  return "alert";
}

function parseReadByIds(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      return [];
    }
  }
  return [];
}

function buildNotificationFromRow(row: any): AppNotification {
  const nowIso = new Date().toISOString();
  return {
    id: String(row?.id || randomUUID()),
    companyId: row?.company_id ? String(row.company_id) : undefined,
    title: normalizeWhitespace(String(row?.title || "Notification")),
    body: normalizeWhitespace(String(row?.body || "")),
    kind: normalizeNotificationKind(row?.kind),
    audience: normalizeNotificationAudience(row?.audience),
    createdById: String(row?.created_by_id || "system"),
    createdByName: normalizeWhitespace(String(row?.created_by_name || "System")),
    createdAt: toIsoTimestamp(row?.created_at, nowIso),
    readByIds: parseReadByIds(row?.read_by_user_ids_json),
  };
}

async function insertNotificationInMySql(notification: AppNotification): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_notifications (
      id, company_id, title, body, kind, audience, created_by_id, created_by_name,
      created_at, read_by_user_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      body = VALUES(body),
      kind = VALUES(kind),
      audience = VALUES(audience),
      created_by_id = VALUES(created_by_id),
      created_by_name = VALUES(created_by_name),
      created_at = VALUES(created_at),
      read_by_user_ids_json = COALESCE(read_by_user_ids_json, VALUES(read_by_user_ids_json))`,
    [
      notification.id,
      notification.companyId ?? null,
      notification.title,
      notification.body,
      notification.kind,
      notification.audience,
      notification.createdById,
      notification.createdByName,
      notification.createdAt.slice(0, 19).replace("T", " "),
      JSON.stringify(notification.readByIds || []),
    ]
  );
}

async function listNotificationsFromMySql(
  role: UserRole,
  companyId?: string | null
): Promise<AppNotification[]> {
  if (!isMySqlStateEnabled()) return [];
  const conn = await getMySqlPool();
  const params: Array<string | null> = [role];
  let where = "WHERE (audience = 'all' OR audience = ?)";
  if (companyId) {
    where += " AND (company_id = ? OR company_id IS NULL)";
    params.push(companyId);
  }
  const [rows] = await conn.query<any[]>(
    `SELECT id, company_id, title, body, kind, audience, created_by_id, created_by_name, created_at, read_by_user_ids_json
     FROM lff_notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT 500`,
    params
  );
  return (rows || []).map((row) => buildNotificationFromRow(row));
}

async function markNotificationReadInMySql(notificationId: string, userId: string): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT read_by_user_ids_json FROM lff_notifications WHERE id = ? LIMIT 1`,
    [notificationId]
  );
  if (!rows || rows.length === 0) return;
  const currentReadBy = parseReadByIds(rows[0]?.read_by_user_ids_json);
  if (currentReadBy.includes(userId)) return;
  currentReadBy.push(userId);
  await conn.execute(
    `UPDATE lff_notifications SET read_by_user_ids_json = ? WHERE id = ?`,
    [JSON.stringify(currentReadBy), notificationId]
  );
}

async function markAllNotificationsReadInMySql(
  role: UserRole,
  userId: string,
  companyId?: string | null
): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const notifications = await listNotificationsFromMySql(role, companyId);
  const conn = await getMySqlPool();
  await Promise.all(
    notifications.map((notification) => {
      const readBy = Array.isArray(notification.readByIds)
        ? notification.readByIds
        : [];
      if (readBy.includes(userId)) return Promise.resolve();
      const nextReadBy = [...readBy, userId];
      return conn.execute(
        `UPDATE lff_notifications SET read_by_user_ids_json = ? WHERE id = ?`,
        [JSON.stringify(nextReadBy), notification.id]
      );
    })
  );
}

function buildAccessRequestNotification(payload: {
  requestId: string;
  name: string;
  email: string;
  companyName: string;
}): AppNotification {
  const createdAt = new Date().toISOString();
  const companyId = getCompanyIdFromName(payload.companyName);
  return {
    id: `notif_access_${payload.requestId}`,
    companyId,
    title: "New access request",
    body: `${payload.name} (${payload.email}) requested access.`,
    kind: "alert",
    audience: "admin",
    createdById: payload.requestId,
    createdByName: payload.name,
    createdAt,
    readByIds: [],
  };
}

function normalizeApprovalStatusValue(value: unknown): "pending" | "approved" | "rejected" {
  if (value === "pending" || value === "approved" || value === "rejected") return value;
  return "approved";
}

function parseCompanyIdsFromJson(value: unknown, fallbackCompanyId: string): string[] {
  if (typeof value !== "string" || !value.trim()) return [fallbackCompanyId];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [fallbackCompanyId];
    const normalized = parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeWhitespace(entry))
      .filter(Boolean);
    return normalized.length ? Array.from(new Set(normalized)) : [fallbackCompanyId];
  } catch {
    return [fallbackCompanyId];
  }
}

let authUsersStoreInitPromise: Promise<void> | null = null;

async function hydrateAuthUsersFromMySql(): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT
      rowid, login, email, firstname, lastname, admin, statut, employee,
      office_phone, user_mobile, pass_crypted, pass, datec, tms
    FROM nmy5_user`
  );

  for (const row of rows) {
    const record = buildAuthRecordFromMySqlRow(row);
    if (!record) continue;
    setAuthUserRecord(record);
  }
}

async function initAuthUsersStore(): Promise<void> {
  if (authUsersByEmail.size > 0) return;
  if (!isMySqlStateEnabled()) return;
  if (!authUsersStoreInitPromise) {
    authUsersStoreInitPromise = (async () => {
      await hydrateAuthUsersFromMySql();
    })().finally(() => {
      authUsersStoreInitPromise = null;
    });
  }
  await authUsersStoreInitPromise;
}

function buildAuthRecordFromMySqlRow(row: any): AuthUserRecord | null {
  const loginValue = normalizeLoginKey(typeof row?.login === "string" ? row.login : "");
  const rawEmail = typeof row?.email === "string" ? row.email : "";
  const emailValue = normalizeEmailKey(rawEmail || (loginValue ? `${loginValue}@dolibarr.local` : ""));
  const passCrypted =
    typeof row?.pass_crypted === "string" ? row.pass_crypted.trim().toLowerCase() : "";
  const passPlain = typeof row?.pass === "string" ? row.pass.trim() : "";
  const passwordHashValue = passCrypted || (passPlain ? hashPassword(passPlain) : "");
  if (!loginValue || !passwordHashValue) return null;

  const isAdmin = Number(row?.admin || 0) === 1;
  const role: UserRole = isAdmin ? "admin" : "salesperson";
  const nowIso = new Date().toISOString();
  const firstName = normalizeWhitespace(String(row?.firstname || ""));
  const lastName = normalizeWhitespace(String(row?.lastname || ""));
  const fullName = normalizeWhitespace(`${firstName} ${lastName}`) || loginValue;
  const phone = normalizeWhitespace(String(row?.user_mobile || row?.office_phone || "+91 00000 00000"));
  const statusValue = typeof row?.statut === "number" ? row.statut : Number(row?.statut ?? 1);
  const approvalStatus: "approved" | "pending" | "rejected" =
    statusValue === 1 ? "approved" : statusValue === 0 ? "pending" : "rejected";
  const user: AppUser = {
    id: normalizeWhitespace(String(row?.rowid || randomUUID())),
    name: fullName,
    email: normalizeEmail(emailValue),
    login: loginValue,
    role,
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    companyIds: [DEFAULT_COMPANY_ID],
    department: roleToDepartment(role),
    branch: "Main Branch",
    phone,
    joinDate: String(row?.datec ? new Date(row.datec).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
    approvalStatus,
  };

  return {
    user,
    passwordHash: passwordHashValue,
    createdAt: toIsoTimestamp(row?.datec, nowIso),
    updatedAt: toIsoTimestamp(row?.tms, nowIso),
    approvalStatus,
  };
}

async function getAuthUserFromMySqlByEmail(identifier: string): Promise<AuthUserRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  const normalizedEmail = normalizeEmail(identifier);
  const normalizedLogin = normalizeLoginKey(identifier);
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT
      rowid, login, email, firstname, lastname, admin, statut, employee,
      office_phone, user_mobile, pass_crypted, pass, datec, tms
    FROM nmy5_user
    WHERE email = ? OR login = ?
    LIMIT 1`,
    [normalizedEmail, normalizedLogin]
  );
  if (!rows || rows.length === 0) return null;
  return buildAuthRecordFromMySqlRow(rows[0]);
}

async function syncAuthUserCacheForEmail(email: string): Promise<AuthUserRecord | null> {
  const normalized = normalizeEmail(email);
  if (!isMySqlStateEnabled()) {
    return authUsersByEmail.get(normalized) ?? null;
  }
  try {
    const record = await getAuthUserFromMySqlByEmail(normalized);
    if (!record) {
      removeAuthUserByEmail(normalized);
      return null;
    }
    setAuthUserRecord(record);
    return record;
  } catch {
    return authUsersByEmail.get(normalized) ?? null;
  }
}

function createAuthToken(user: AppUser): string {
  return signJwt({
    sub: user.id,
    role: user.role,
    email: user.email,
  });
}

function buildLoginFromEmailAndName(email: string, name: string): string {
  const fromEmail = email.split("@")[0] || "";
  const fromName = name.toLowerCase().replace(/\s+/g, ".");
  const cleaned = (fromEmail || fromName || "employee")
    .replace(/[^a-z0-9._-]/gi, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 42)
    .toLowerCase();
  return cleaned || `user_${Date.now().toString(36).slice(-6)}`;
}

async function authenticateCredentials(identifier: string, password: string): Promise<AppUser | null> {
  await initAuthUsersStore();
  const record = getAuthUserByIdentifier(identifier);
  if (!record) return null;
  if (!matchesStoredPasswordHash(record.passwordHash, password)) return null;
  if (resolveApprovalStatus(record) !== "approved") return null;
  return {
    ...record.user,
    approvalStatus: "approved",
  };
}

function buildUserFromRegistration(payload: {
  name: string;
  email: string;
  companyName: string;
  role: UserRole;
  department?: string;
  branch?: string;
  phone?: string;
}): AppUser {
  const now = new Date().toISOString().slice(0, 10);
  const normalizedEmail = normalizeEmail(payload.email);
  const login = buildLoginFromEmailAndName(normalizedEmail, payload.name);
  return {
    id: randomUUID(),
    name: normalizeWhitespace(payload.name),
    email: normalizedEmail,
    login,
    role: payload.role,
    companyId: PENDING_COMPANY_ID,
    companyName: PENDING_COMPANY_NAME,
    department: normalizeWhitespace(payload.department || roleToDepartment(payload.role)),
    branch: normalizeWhitespace(payload.branch || "Main Branch"),
    phone: normalizeWhitespace(payload.phone || "+91 00000 00000"),
    joinDate: now,
    approvalStatus: "approved",
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  await initAuthUsersStore();

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      mysqlStateEnabled: isMySqlStateEnabled(),
    });
  });

  app.post("/api/ai/analyze", async (req, res) => {
    const body = req.body as {
      transcript?: unknown;
      customerName?: unknown;
      salespersonName?: unknown;
      model?: unknown;
    };
    const transcript =
      typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const customerName =
      typeof body?.customerName === "string" ? body.customerName.trim() : "Customer";
    const salespersonName =
      typeof body?.salespersonName === "string" ? body.salespersonName.trim() : "Sales Rep";
    const requestedModel =
      typeof body?.model === "string" ? body.model.trim() : "";
    const model = requestedModel || DEFAULT_AI_MODEL;

    if (!transcript || transcript.length < 20) {
      res.status(400).json({ message: "Transcript is too short for AI analysis." });
      return;
    }

    const apiKey = normalizeApiSecret(
      process.env.GEMINI_API_KEY ||
        process.env.EXPO_PUBLIC_GEMINI_API_KEY ||
        process.env.GEMINI_API ||
        process.env.EXPO_PUBLIC_GEMINI_API ||
        process.env.gemini_API ||
        process.env.gemini_APi
    );
    if (!apiKey) {
      res.status(500).json({ message: "AI key not configured on server." });
      return;
    }

    try {
      const result = await analyzeConversationWithAI({
        apiKey,
        model,
        transcript,
        customerName,
        salespersonName,
      });
      res.json({
        provider: "ai",
        model,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI analysis failed.";
      const kind = typeof (error as any)?.kind === "string" ? String((error as any).kind) : "";
      const statusFromError =
        typeof (error as any)?.status === "number" ? Number((error as any).status) : 0;
      const status =
        statusFromError >= 400
          ? statusFromError
          : kind === "invalid_api_key"
            ? 401
            : kind === "quota_exhausted" || kind === "rate_limited"
              ? 429
              : kind === "model_not_available"
                ? 404
                : 500;
      res.status(status).json({
        message,
        kind: kind || "unknown",
      });
    }
  });

  app.get("/api/settings/integrations/dolibarr", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const config = await resolveDolibarrConfigForUser(userId);
    res.json({
      enabled: config.enabled,
      endpoint: config.endpoint,
      apiKeyMasked: maskApiKey(config.apiKey),
      configured: config.configured,
      source: config.source,
    });
  });

  app.put("/api/settings/integrations/dolibarr", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body as {
      enabled?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
    };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ message: "enabled must be a boolean." });
      return;
    }

    const updated = await storage.setDolibarrConfigForUser(userId, {
      enabled: body.enabled,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });
    const resolved = await resolveDolibarrConfigForUser(userId, {
      enabled: updated.enabled,
      endpoint: updated.endpoint,
      apiKey: updated.apiKey,
    });
    res.json({
      enabled: resolved.enabled,
      endpoint: resolved.endpoint,
      apiKeyMasked: maskApiKey(resolved.apiKey),
      configured: resolved.configured,
      source: "settings",
    });
  });

  app.post("/api/settings/integrations/dolibarr/test", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body as {
      enabled?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
    };

    const config = await resolveDolibarrConfigForUser(userId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });

      if (!config.endpoint || !config.apiKey) {
      res.json({
        ok: false,
        status: null,
        message: "Dolibarr endpoint and API key are required.",
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(config.endpoint, {
        method: "GET",
        headers: {
          "X-Dolibarr-API-Key": config.apiKey,
        },
        signal: controller.signal,
      });

      if (response.ok) {
        res.json({
          ok: true,
          status: response.status,
          message: "Dolibarr endpoint reachable.",
        });
        return;
      }

      res.json({
        ok: false,
        status: response.status,
        message: `Dolibarr endpoint responded with HTTP ${response.status}. Verify endpoint and API key.`,
      });
    } catch (error) {
      res.json({
        ok: false,
        status: null,
        message:
          error instanceof Error ? error.message : "Unable to reach Dolibarr endpoint.",
      });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    const role = req.auth?.role || "salesperson";
    await initAuthUsersStore();
    const authRecord = req.auth?.email
      ? getAuthUserByIdentifier(req.auth.email)
      : null;
    const companyId = authRecord?.user.companyId ?? null;

    if (!isMySqlStateEnabled()) {
      res.json([]);
      return;
    }

    try {
      const notifications = await listNotificationsFromMySql(role, companyId);
      res.json(notifications);
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to load notifications: ${error.message}`
            : "Unable to load notifications.",
      });
    }
  });

  app.post(
    "/api/notifications",
    requireAuth,
    requireRoles("admin", "manager"),
    async (req, res) => {
      const { title, body, kind, audience } = req.body as {
        title?: string;
        body?: string;
        kind?: AppNotification["kind"];
        audience?: NotificationAudience;
      };
      if (!title || !body) {
        res.status(400).json({ message: "Notification title and body are required." });
        return;
      }

      await initAuthUsersStore();
      const authRecord = req.auth?.email
        ? getAuthUserByIdentifier(req.auth.email)
        : null;
      const companyId = authRecord?.user.companyId ?? null;
      const createdAt = new Date().toISOString();
      const notification: AppNotification = {
        id: `notif_${randomUUID()}`,
        companyId: companyId || undefined,
        title: normalizeWhitespace(title),
        body: normalizeWhitespace(body),
        kind: normalizeNotificationKind(kind),
        audience: normalizeNotificationAudience(audience),
        createdById: req.auth?.sub || "system",
        createdByName: req.auth?.email || "System",
        createdAt,
        readByIds: [],
      };

      try {
        await insertNotificationInMySql(notification);
        res.status(201).json(notification);
      } catch (error) {
        res.status(500).json({
          message:
            error instanceof Error
              ? `Unable to save notification: ${error.message}`
              : "Unable to save notification.",
        });
      }
    }
  );

  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    const notificationId = firstString(req.params.id);
    if (!notificationId) {
      res.status(400).json({ message: "Notification id is required." });
      return;
    }
    if (!isMySqlStateEnabled()) {
      res.json({ ok: true });
      return;
    }
    try {
      await markNotificationReadInMySql(notificationId, req.auth?.sub || "");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to mark notification read: ${error.message}`
            : "Unable to mark notification read.",
      });
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.json({ ok: true });
      return;
    }
    try {
      const role = req.auth?.role || "salesperson";
      await initAuthUsersStore();
      const authRecord = req.auth?.email
        ? getAuthUserByIdentifier(req.auth.email)
        : null;
      const companyId = authRecord?.user.companyId ?? null;
      await markAllNotificationsReadInMySql(role, req.auth?.sub || "", companyId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to mark notifications read: ${error.message}`
            : "Unable to mark notifications read.",
      });
    }
  });

  app.all(/^\/api\/dolibarr\/proxy(\/.*)?$/, requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const forwardPath = req.path.replace(/^\/api\/dolibarr\/proxy/, "");
    const ruleError = resolveDolibarrProxyRule(forwardPath, req.auth?.role);
    if (ruleError) {
      res.status(403).json({ message: ruleError });
      return;
    }

    await forwardDolibarrRequest(req, res, {
      userId,
      forwardPath,
    });
  });

  app.post(
    "/api/integrations/dolibarr/hrm/sync-employee",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requesterId = req.auth?.sub;
      if (!requesterId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }

      const body = req.body as {
        name?: unknown;
        email?: unknown;
        role?: unknown;
        department?: unknown;
        branch?: unknown;
        phone?: unknown;
        enabled?: unknown;
        endpoint?: unknown;
        apiKey?: unknown;
      };

      const name = firstString(body.name);
      const email = firstString(body.email).toLowerCase();
      if (!name || !email) {
        res.status(400).json({ message: "name and email are required." });
        return;
      }

      const endpointOverride =
        typeof body.endpoint === "string"
          ? body.endpoint
          : body.endpoint === null
            ? null
            : undefined;
      const apiKeyOverride =
        typeof body.apiKey === "string"
          ? body.apiKey
          : body.apiKey === null
            ? null
            : undefined;
      const config = await resolveDolibarrConfigForUser(requesterId, {
        enabled: parseOptionalBoolean(body.enabled),
        endpoint: endpointOverride,
        apiKey: apiKeyOverride,
      });
      try {
        const result = await syncApprovedUserToDolibarrEmployee(
          {
            name,
            email,
            role: firstString(body.role) || null,
            department: firstString(body.department) || null,
            branch: firstString(body.branch) || null,
            phone: firstString(body.phone) || null,
          },
          {
            enabled: config.enabled,
            endpoint: config.endpoint,
            apiKey: config.apiKey,
          }
        );
        res.json(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unexpected failure while syncing employee to Dolibarr.";
        res.json({
          ok: false,
          status: "failed",
          message,
          dolibarrUserId: null,
          endpointUsed: null,
        });
      }
    }
  );

  app.post(
    "/api/speech/transcribe",
    express.raw({ type: "*/*", limit: `${MAX_TRANSCRIBE_AUDIO_BYTES}b` }),
    async (req, res) => {
      const rawBody = req.body;
      const audioBuffer = Buffer.isBuffer(rawBody) ? rawBody : null;
      if (!audioBuffer || audioBuffer.length === 0) {
        res.status(400).json({ message: "Audio payload is required." });
        return;
      }
      if (audioBuffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
        res.status(413).json({ message: "Audio payload too large." });
        return;
      }

      const mimeTypeHeader = firstString(req.header("content-type"));
      const mimeType = mimeTypeHeader.split(";")[0]?.trim() || "audio/webm";
      const model = firstString(req.query.model) || null;
      const fallbackModel = firstString(req.query.fallback_model) || null;
      const provider = firstString(req.query.provider) || null;
      const mode = firstString(req.query.mode) || null;
      const languageCode = firstString(req.query.language_code) || null;
      const withDiarizationRaw = firstString(req.query.with_diarization) || null;
      const withTimestampsRaw = firstString(req.query.with_timestamps) || null;
      const numSpeakersRaw = firstString(req.query.num_speakers) || null;
      const geminiApiKeysHeader = firstString(req.header("x-gemini-api-keys"));
      const geminiApiKeyHeader = firstString(req.header("x-gemini-api-key"));
      const revupApiKeyHeader = firstString(req.header("x-revup-api-key"));
      const revupAppIdHeader = firstString(req.header("x-revup-app-id"));
      const hfTokenHeader = firstString(req.header("x-hf-token"));
      const withDiarization =
        withDiarizationRaw === null
          ? null
          : /^(1|true|yes|on)$/i.test(withDiarizationRaw.trim());
      const withTimestamps =
        withTimestampsRaw === null
          ? null
          : /^(1|true|yes|on)$/i.test(withTimestampsRaw.trim());
      const parsedNumSpeakers = numSpeakersRaw ? Number(numSpeakersRaw) : Number.NaN;
      const numSpeakers = Number.isFinite(parsedNumSpeakers)
        ? Math.max(1, Math.floor(parsedNumSpeakers))
        : null;

      try {
        const result = await transcribeSpeechWithFairseqS2T({
          audio: audioBuffer,
          mimeType,
          model,
          fallbackModel,
          provider,
          mode,
          languageCode,
          withDiarization,
          withTimestamps,
          numSpeakers,
          geminiApiKey:
            geminiApiKeysHeader ||
            geminiApiKeyHeader ||
            firstString(req.query.gemini_api_keys) ||
            firstString(req.query.gemini_api_key) ||
            null,
          revupApiKey:
            revupApiKeyHeader || firstString(req.query.revup_api_key) || null,
          revupAppId:
            revupAppIdHeader || firstString(req.query.revup_app_id) || null,
          huggingFaceToken:
            hfTokenHeader ||
            firstString(req.query.hf_token) ||
            firstString(req.query.huggingface_token) ||
            null,
        });
        res.json(result);
      } catch (error) {
        if (error instanceof Speech2TextError) {
          res.status(error.statusCode).json({ message: error.message });
          return;
        }
        const message =
          error instanceof Error ? error.message : "Speech transcription failed unexpectedly.";
        res.status(500).json({ message });
      }
    }
  );

  app.post("/api/auth/register", async (req, res) => {
    const {
      name,
      email,
      password,
      companyName,
      role,
      department,
      branch,
      phone,
    } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      companyName?: string;
      role?: UserRole;
      department?: string;
      branch?: string;
      phone?: string;
    };

    if (!name || !email || !password || !companyName) {
      res.status(400).json({ message: "Name, email, password and company name are required" });
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ message: "Invalid email format" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const existingRecord = await syncAuthUserCacheForEmail(normalizedEmail);
    if (existingRecord && resolveApprovalStatus(existingRecord) === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    const adminAlreadyExists = await hasAnyApprovedAdmin();
    if (normalizedRole === "admin" && adminAlreadyExists) {
      res.status(403).json({
        message:
          "An admin already exists. Ask an existing admin to approve additional admin access.",
      });
      return;
    }

    const user = buildUserFromRegistration({
      name,
      email: normalizedEmail,
      companyName: normalizedCompanyName,
      role: normalizedRole,
      department,
      branch,
      phone,
    });
    const now = new Date().toISOString();
    const authRecord: AuthUserRecord = {
      user,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved",
    };
    setAuthUserRecord(authRecord);
    try {
      await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
    } catch (error) {
      removeAuthUserByEmail(user.email);
      console.error("Failed to persist registered user in MySQL", error);
      res.status(500).json({
        message:
          error instanceof Error
            ? `Failed to save user in database: ${error.message}`
            : "Failed to save user in database.",
      });
      return;
    }

    const token = createAuthToken(user);
    res.status(201).json({ token, user });
  });

  app.post("/api/auth/access-request", async (req, res) => {
    const {
      name,
      email,
      password,
      companyName,
      role,
      department,
      branch,
      phone,
    } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      companyName?: string;
      role?: UserRole;
      department?: string;
      branch?: string;
      phone?: string;
    };

    if (!name || !email || !password || !companyName) {
      res.status(400).json({ message: "Name, email, password and company name are required" });
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ message: "Invalid email format" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const adminAlreadyExists = await hasAnyApprovedAdmin();

    const existingRecord = await syncAuthUserCacheForEmail(normalizedEmail);
    const existingStatus = existingRecord ? resolveApprovalStatus(existingRecord) : null;
    if (existingRecord && existingStatus === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    if (normalizedRole === "admin" && !adminAlreadyExists) {
      const now = new Date().toISOString();
      const bootstrapAdmin = buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName: normalizedCompanyName,
        role: "admin",
        department,
        branch,
        phone,
      });
      const authRecord: AuthUserRecord = {
        user: bootstrapAdmin,
        passwordHash: hashPassword(password),
        createdAt: existingRecord?.createdAt || now,
        updatedAt: now,
        approvalStatus: "approved",
      };
      setAuthUserRecord(authRecord);
      try {
        await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
      } catch (error) {
        removeAuthUserByEmail(normalizedEmail);
        console.error("Failed to persist bootstrap admin in MySQL", error);
        res.status(500).json({
          message:
            error instanceof Error
              ? `Failed to save admin in database: ${error.message}`
              : "Failed to save admin in database.",
        });
        return;
      }
      const token = createAuthToken(bootstrapAdmin);
      res.status(201).json({
        ok: true,
        autoApproved: true,
        message: "First admin account created and approved for this company.",
        token,
        user: bootstrapAdmin,
      });
      return;
    }

    let existingPendingRequest = getLatestPendingAccessRequestByEmail(normalizedEmail);
    if (!existingPendingRequest && isMySqlStateEnabled()) {
      const pendingFromDb = await getLatestPendingAccessRequestByEmailFromMySql(normalizedEmail);
      if (pendingFromDb) {
        accessRequestsById.set(pendingFromDb.id, pendingFromDb);
        existingPendingRequest = toPublicAccessRequest(pendingFromDb);
      }
    }
    if (existingPendingRequest) {
      res.status(200).json({
        ok: true,
        alreadyPending: true,
        message: "Access request already pending admin approval.",
        request: existingPendingRequest,
      });
      return;
    }

    const now = new Date().toISOString();
    const pendingUser = {
      ...buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName: normalizedCompanyName,
        role: normalizedRole,
        department,
        branch,
        phone,
      }),
      approvalStatus: "pending" as const,
    };

    const pendingPasswordHash = hashPassword(password);
    const pendingAuthRecord: AuthUserRecord = {
      user: pendingUser,
      passwordHash: pendingPasswordHash,
      createdAt: existingRecord?.createdAt || now,
      updatedAt: now,
      approvalStatus: "pending",
    };
    setAuthUserRecord(pendingAuthRecord);

    const pendingRequest: AccessRequestRecord = {
      id: randomUUID(),
      name: pendingUser.name,
      email: pendingUser.email,
      requestedRole: pendingUser.role,
      approvedRole: null,
      requestedDepartment: pendingUser.department,
      requestedBranch: pendingUser.branch,
      requestedCompanyName: normalizedCompanyName,
      status: "pending",
      requestedAt: now,
      reviewedAt: null,
      reviewedById: null,
      reviewedByName: null,
      reviewComment: null,
      assignedCompanyIds: [],
      assignedManagerId: null,
      assignedManagerName: null,
      passwordHash: pendingPasswordHash,
    };
    accessRequestsById.set(pendingRequest.id, pendingRequest);
    try {
      await insertAccessRequestInMySql(pendingRequest);
      await upsertAuthUserInMySql(pendingAuthRecord, normalizedCompanyName);
      try {
        const notification = buildAccessRequestNotification({
          requestId: pendingRequest.id,
          name: pendingUser.name,
          email: pendingUser.email,
          companyName: normalizedCompanyName,
        });
        await insertNotificationInMySql(notification);
      } catch (error) {
        console.error("Failed to persist access request notification", error);
      }
    } catch (error) {
      console.error("Failed to persist access request in MySQL", error);
      res.status(500).json({
        message:
          error instanceof Error
            ? `Failed to save access request in database: ${error.message}`
            : "Failed to save access request in database.",
      });
      return;
    }

    res.status(202).json({
      ok: true,
      message:
        "Signup request submitted. Your Dolibarr user is created in disabled state. Wait for admin approval before signing in.",
      request: toPublicAccessRequest(pendingRequest),
    });
  });

  app.get(
    "/api/admin/access-requests",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const parsedStatus = parseRequestStatus(firstString(req.query.status));
      if (firstString(req.query.status) && !parsedStatus) {
        res.status(400).json({ message: "Invalid access request status filter." });
        return;
      }

      void (async () => {
        if (isMySqlStateEnabled()) {
          try {
            const requests = await listAccessRequestsFromMySql(parsedStatus);
            res.json(requests.map(toPublicAccessRequest));
            return;
          } catch (error) {
            console.error("Failed to read access requests from MySQL", error);
          }
        }
        const requests = Array.from(accessRequestsById.values())
          .filter((entry) => !parsedStatus || entry.status === parsedStatus)
          .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
          .map(toPublicAccessRequest);
        res.json(requests);
      })();
    }
  );

  app.post(
    "/api/admin/access-requests/:id/review",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requestId = firstString(req.params.id);
      if (!requestId) {
        res.status(400).json({ message: "Access request id is required." });
        return;
      }

      const body = req.body as {
        action?: "approved" | "rejected";
        role?: UserRole;
        companyIds?: unknown;
        managerId?: string;
        managerName?: string;
        comment?: string;
      };
      const action = body?.action;
      if (action !== "approved" && action !== "rejected") {
        res.status(400).json({ message: "Review action must be approved or rejected." });
        return;
      }

      let currentRequest = accessRequestsById.get(requestId) || null;
      if (!currentRequest && isMySqlStateEnabled()) {
        currentRequest = await getAccessRequestByIdFromMySql(requestId);
        if (currentRequest) {
          accessRequestsById.set(requestId, currentRequest);
        }
      }
      if (!currentRequest) {
        res.status(404).json({ message: "Access request not found." });
        return;
      }
      if (currentRequest.status !== "pending") {
        res.json(toPublicAccessRequest(currentRequest));
        return;
      }

      const now = new Date().toISOString();
      const approvedRole =
        action === "approved"
          ? normalizeRole(body?.role || currentRequest.requestedRole)
          : null;
      const finalRole = approvedRole || currentRequest.requestedRole;
      const assignedCompanyIds =
        action === "approved" ? normalizeCompanyIds(body?.companyIds) : [];
      const assignedManagerId =
        action === "approved"
          ? normalizeWhitespace(typeof body?.managerId === "string" ? body.managerId : "") || null
          : null;
      const assignedManagerName =
        action === "approved"
          ? normalizeWhitespace(typeof body?.managerName === "string" ? body.managerName : "") ||
            null
          : null;
      const reviewComment = normalizeWhitespace(
        typeof body?.comment === "string" ? body.comment : ""
      );

      const normalizedEmail = normalizeEmail(currentRequest.email);
      let authRecord = authUsersByEmail.get(normalizedEmail);
      const pendingPasswordHash = currentRequest.passwordHash || null;
      if (!authRecord && action === "approved") {
        if (!pendingPasswordHash) {
          res.status(404).json({
            message: "User account request is missing credentials. Ask the user to sign up again.",
          });
          return;
        }
        const bootstrapUser = buildUserFromRegistration({
          name: currentRequest.name,
          email: normalizedEmail,
          companyName: normalizeCompanyName(currentRequest.requestedCompanyName || DEFAULT_COMPANY_NAME),
          role: currentRequest.requestedRole,
          department: currentRequest.requestedDepartment,
          branch: currentRequest.requestedBranch,
        });
        authRecord = {
          user: bootstrapUser,
          passwordHash: pendingPasswordHash,
          createdAt: currentRequest.requestedAt,
          updatedAt: now,
          approvalStatus: "pending",
        };
        setAuthUserRecord(authRecord);
      }

      if (action === "approved") {
        const effectiveCompanyName = normalizeCompanyName(
          currentRequest.requestedCompanyName || authRecord?.user.companyName || DEFAULT_COMPANY_NAME
        );
        const effectiveCompanyId =
          assignedCompanyIds[0] ||
          authRecord?.user.companyId ||
          getCompanyIdFromName(effectiveCompanyName);
        const reviewedUser: AppUser = {
          ...(authRecord?.user ?? buildUserFromRegistration({
            name: currentRequest.name,
            email: normalizedEmail,
            companyName: effectiveCompanyName,
            role: finalRole,
            department: currentRequest.requestedDepartment,
            branch: currentRequest.requestedBranch,
          })),
          role: finalRole,
          department:
            normalizeWhitespace(currentRequest.requestedDepartment) || roleToDepartment(finalRole),
          branch:
            normalizeWhitespace(currentRequest.requestedBranch) ||
            authRecord?.user.branch ||
            "Main Branch",
          companyId: effectiveCompanyId,
          companyName: effectiveCompanyName,
          companyIds: assignedCompanyIds.length ? assignedCompanyIds : [effectiveCompanyId],
          managerId: assignedManagerId || undefined,
          managerName: assignedManagerName || undefined,
          approvalStatus: "approved",
        };

        if (authRecord) {
          setAuthUserRecord({
            ...authRecord,
            user: reviewedUser,
            updatedAt: now,
            approvalStatus: "approved",
          });
        }
      } else {
        if (authRecord) {
          setAuthUserRecord({
            ...authRecord,
            user: {
              ...authRecord.user,
              approvalStatus: "rejected",
            },
            updatedAt: now,
            approvalStatus: "rejected",
          });
        }
      }

      const reviewedRequest: AccessRequestRecord = {
        ...currentRequest,
        approvedRole,
        status: action,
        reviewedAt: now,
        reviewedById: req.auth?.sub || null,
        reviewedByName: req.auth?.email || null,
        reviewComment: reviewComment || null,
        assignedCompanyIds,
        assignedManagerId,
        assignedManagerName,
        passwordHash: action === "approved" ? null : currentRequest.passwordHash ?? null,
      };
      accessRequestsById.set(requestId, reviewedRequest);
      try {
        const latestAuthRecord = getAuthUserByIdentifier(normalizedEmail);
        const fallbackAuthRecord =
          !latestAuthRecord && action === "approved"
            ? ({
                user: {
                  ...reviewedUser,
                  approvalStatus: "approved",
                },
                passwordHash: pendingPasswordHash || "",
                createdAt: reviewedRequest.requestedAt,
                updatedAt: now,
                approvalStatus: "approved",
              } as AuthUserRecord)
            : null;
        const recordToPersist = latestAuthRecord || fallbackAuthRecord;
        if (recordToPersist) {
          await upsertAuthUserInMySql(
            recordToPersist,
            reviewedRequest.requestedCompanyName
          );
        }
        await insertAccessRequestInMySql(reviewedRequest);
      } catch (error) {
        console.error("Failed to persist reviewed access request in MySQL", error);
        res.status(500).json({
          message:
            error instanceof Error
              ? `Approval saved locally, but database sync failed: ${error.message}`
              : "Approval saved locally, but database sync failed.",
        });
        return;
      }
      res.json(toPublicAccessRequest(reviewedRequest));
    }
  );

  app.post("/api/auth/login", async (req, res) => {
    const { email, login, username, identifier, password } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
    };
    const rawIdentifier =
      (identifier || "").trim() ||
      (email || "").trim() ||
      (login || "").trim() ||
      (username || "").trim();
    if (!rawIdentifier || !password) {
      res.status(400).json({ message: "Email/username and password are required" });
      return;
    }

    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    } else if (rawIdentifier.includes("@")) {
      const normalizedEmail = normalizeEmail(rawIdentifier);
      let latestRequest = getLatestAccessRequestByEmail(normalizedEmail);
      if (!latestRequest && isMySqlStateEnabled()) {
        latestRequest = await getLatestAccessRequestByEmailFromMySql(normalizedEmail);
      }
      if (latestRequest?.passwordHash && matchesStoredPasswordHash(latestRequest.passwordHash, password)) {
        if (latestRequest.status === "pending") {
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const token = createAuthToken(user);
    res.json({ token, user });
  });

  app.post("/api/auth/token", async (req, res) => {
    const { email, login, username, identifier, password } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
    };
    const rawIdentifier =
      (identifier || "").trim() ||
      (email || "").trim() ||
      (login || "").trim() ||
      (username || "").trim();
    if (!rawIdentifier || !password) {
      res.status(400).json({ message: "Email/username and password are required" });
      return;
    }
    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    } else if (rawIdentifier.includes("@")) {
      const normalizedEmail = normalizeEmail(rawIdentifier);
      let latestRequest = getLatestAccessRequestByEmail(normalizedEmail);
      if (!latestRequest && isMySqlStateEnabled()) {
        latestRequest = await getLatestAccessRequestByEmailFromMySql(normalizedEmail);
      }
      if (latestRequest?.passwordHash && matchesStoredPasswordHash(latestRequest.passwordHash, password)) {
        if (latestRequest.status === "pending") {
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    const token = createAuthToken(user);
    res.json({ token });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const email = req.auth?.email;
    if (!email) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    await initAuthUsersStore();
    const identifier = email.endsWith("@dolibarr.local") ? email.split("@")[0] || email : email;
    const record =
      (await syncAuthUserCacheForEmail(identifier)) || getAuthUserByIdentifier(identifier);
    if (!record) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ user: record.user });
  });

  app.get(
    "/api/stockists",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL state store is not configured." });
        return;
      }
      const companyId = toNullableText(req.query.companyId);
      try {
        const items = await listStockistsFromMySql();
        const filtered = companyId
          ? items.filter(
              (entry) => entry && typeof entry === "object" && (entry as any).companyId === companyId
            )
          : items;
        res.json({ items: filtered });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load channel partners.";
        res.status(500).json({ message });
      }
    }
  );

  app.post(
    "/api/stockists",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL state store is not configured." });
        return;
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const id = toStringId(body.id);
      if (!id) {
        res.status(400).json({ message: "Stockist id is required." });
        return;
      }
      const companyId = toNullableText(body.companyId);
      const name = toRequiredText(body.name, "Channel Partner");
      const phone = toNullableText(body.phone);
      const location = toNullableText(body.location);
      const pincode = toNullableText(body.pincode);
      const notes = toNullableText(body.notes);
      const createdAt = toSqlTimestamp(body.createdAt);
      const updatedAt = toSqlTimestamp(body.updatedAt ?? body.createdAt);

      try {
        const conn = await getMySqlPool();
        await conn.execute(
          `INSERT INTO lff_stockists
            (id, company_id, name, phone, location, pincode, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             phone = VALUES(phone),
             location = VALUES(location),
             pincode = VALUES(pincode),
             notes = VALUES(notes),
             updated_at = VALUES(updated_at)`,
          [id, companyId, name, phone, location, pincode, notes, createdAt, updatedAt]
        );
        res.json({
          id,
          companyId: companyId || undefined,
          name,
          phone: phone || undefined,
          location: location || undefined,
          pincode: pincode || undefined,
          notes: notes || undefined,
          createdAt: new Date(createdAt).toISOString(),
          updatedAt: new Date(updatedAt).toISOString(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to save channel partner.";
        res.status(500).json({ message });
      }
    }
  );

  app.get(
    "/api/stock/products",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL stock store is not configured." });
        return;
      }
      const ids = normalizeProductIds(req.query.ids);
      if (!ids.length) {
        res.status(400).json({ message: "Product ids are required." });
        return;
      }
      try {
        const conn = await getMySqlPool();
        const schema = await resolveProductStockSchema(conn);
        const placeholders = ids.map(() => "?").join(", ");
        const query = `SELECT \`${schema.productIdCol}\` AS productId, SUM(COALESCE(\`${schema.qtyCol}\`, 0)) AS stock
          FROM \`${PRODUCT_STOCK_TABLE}\`
          WHERE \`${schema.productIdCol}\` IN (${placeholders})
          GROUP BY \`${schema.productIdCol}\``;
        const [rows] = await conn.execute<Array<Record<string, unknown>>>(query, ids);
        const stockMap = new Map<string, number>();
        for (const row of rows || []) {
          const productId = String(row.productId ?? "");
          const stock = Number(row.stock);
          if (!productId) continue;
          stockMap.set(productId, Number.isFinite(stock) ? stock : 0);
        }
        const items = ids.map((id) => ({
          productId: String(id),
          stock: stockMap.get(String(id)) ?? 0,
        }));
        res.json({ items });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to read product stock.";
        res.status(500).json({ message });
      }
    }
  );

  app.post(
    "/api/stock/products/adjust",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL stock store is not configured." });
        return;
      }
      const body = req.body as { productId?: unknown; delta?: unknown };
      const productId = Number(body.productId);
      const delta = Number(body.delta);
      if (!Number.isFinite(productId)) {
        res.status(400).json({ message: "Valid productId is required." });
        return;
      }
      if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ message: "Valid stock delta is required." });
        return;
      }
      try {
        const conn = await getMySqlPool();
        const schema = await resolveProductStockSchema(conn);
        const selectParts = [
          `\`${schema.qtyCol}\` AS stock`,
          schema.rowIdCol ? `\`${schema.rowIdCol}\` AS rowId` : "",
          schema.warehouseCol ? `\`${schema.warehouseCol}\` AS warehouseId` : "",
        ].filter(Boolean);
        const orderBy = schema.warehouseCol ? ` ORDER BY \`${schema.warehouseCol}\` ASC` : "";
        const selectQuery = `SELECT ${selectParts.join(", ")}
          FROM \`${PRODUCT_STOCK_TABLE}\`
          WHERE \`${schema.productIdCol}\` = ?
          ${orderBy}
          LIMIT 1`;
        const [rows] = await conn.execute<Array<Record<string, unknown>>>(selectQuery, [productId]);
        if (!rows.length) {
          res.status(404).json({ message: "Product stock row not found." });
          return;
        }
        const current = Number(rows[0].stock);
        const nextStock = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);

        if (schema.rowIdCol && rows[0].rowId !== undefined) {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.rowIdCol}\` = ?`,
            [nextStock, rows[0].rowId]
          );
        } else if (schema.warehouseCol && rows[0].warehouseId !== undefined) {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.productIdCol}\` = ? AND \`${schema.warehouseCol}\` = ?`,
            [nextStock, productId, rows[0].warehouseId]
          );
        } else {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.productIdCol}\` = ?`,
            [nextStock, productId]
          );
        }

        const [totalRows] = await conn.execute<Array<Record<string, unknown>>>(
          `SELECT SUM(COALESCE(\`${schema.qtyCol}\`, 0)) AS stock
           FROM \`${PRODUCT_STOCK_TABLE}\`
           WHERE \`${schema.productIdCol}\` = ?`,
          [productId]
        );
        const total = Number(totalRows[0]?.stock);
        res.json({ productId: String(productId), stock: Number.isFinite(total) ? total : 0 });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to update product stock.";
        res.status(500).json({ message });
      }
    }
  );

  app.get("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }

    try {
      const rawValue = await readRemoteState(key);
      if (!rawValue) {
        res.json({
          key,
          value: null,
          updatedAt: null,
          source: isMySqlStateEnabled() ? "mysql" : "memory",
        });
        return;
      }

      let parsedValue: unknown = null;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        parsedValue = null;
      }

      res.json({
        key,
        value: parsedValue,
        updatedAt: new Date().toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read remote state value.";
      res.status(500).json({ message });
    }
  });

  app.put("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }

    const body = req.body as { value?: unknown };
    if (!("value" in (body || {}))) {
      res.status(400).json({ message: "State value is required." });
      return;
    }

    try {
      const serialized = JSON.stringify(body.value ?? null);
      await writeRemoteState(key, serialized);
      res.json({
        ok: true,
        key,
        updatedAt: new Date().toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to persist remote state value.";
      res.status(500).json({ message });
    }
  });

  app.get("/api/geofences/user/:id", requireAuth, async (req, res) => {
    const userId = firstString(req.params.id);
    if (!userId) {
      res.status(400).json({ message: "User id is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user geofence data" });
      return;
    }
    const geofences = await storage.listGeofencesForUser(userId);
    res.json(geofences);
  });

  app.post("/api/geofences", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const payload = req.body as Partial<Geofence>;
    if (!payload.name || typeof payload.latitude !== "number" || typeof payload.longitude !== "number") {
      res.status(400).json({ message: "Missing mandatory geofence fields" });
      return;
    }
    const created = await storage.createGeofence(payload);
    res.status(201).json(created);
  });

  app.put("/api/geofences/:id", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const geofenceId = firstString(req.params.id);
    if (!geofenceId) {
      res.status(400).json({ message: "Geofence id is required" });
      return;
    }
    const updated = await storage.updateGeofence(geofenceId, req.body as Partial<Geofence>);
    if (!updated) {
      res.status(404).json({ message: "Geofence not found" });
      return;
    }
    res.json(updated);
  });

  app.post("/api/location/log", requireAuth, async (req, res) => {
    const sample = parseLocationSample(req.body);
    if (!sample) {
      res.status(400).json({ message: "Invalid location payload" });
      return;
    }
    if (!ensureUserMatch(req, sample.userId)) {
      res.status(403).json({ message: "Not authorized to post location" });
      return;
    }
    const zones = await storage.listGeofencesForUser(sample.userId);
    const status = resolveGeofenceStatus(
      {
        userId: sample.userId,
        userName: "",
        latitude: sample.latitude,
        longitude: sample.longitude,
        deviceId: "",
        photoType: "checkin",
        isInsideGeofence: false,
      },
      zones
    );

    const log: LocationLog = {
      id: randomUUID(),
      userId: sample.userId,
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracy: sample.accuracy,
      speed: sample.speed,
      heading: sample.heading,
      batteryLevel: sample.batteryLevel ?? null,
      geofenceId: status.activeZone?.id ?? null,
      geofenceName: status.activeZone?.name ?? null,
      isInsideGeofence: status.inside,
      capturedAt: sample.capturedAt ?? new Date().toISOString(),
    };
    await storage.addLocationLog(log);
    try {
      await insertLocationLogInMySql(log);
    } catch (error) {
      console.error("Failed to persist location log in MySQL", error);
    }
    res.status(201).json({ ok: true, inside: status.inside, zone: status.activeZone?.name ?? null });
  });

  app.post("/api/location/batch", requireAuth, async (req, res) => {
    const body = req.body as
      | { entries?: unknown[]; points?: unknown[]; samples?: unknown[] }
      | unknown[];
    const candidateEntries = Array.isArray(body)
      ? body
      : Array.isArray(body.entries)
        ? body.entries
        : Array.isArray(body.points)
          ? body.points
          : Array.isArray(body.samples)
            ? body.samples
            : [];

    if (!candidateEntries.length) {
      res.status(400).json({ message: "Location batch payload is empty." });
      return;
    }

    const parsedEntries = candidateEntries.map((entry) => parseLocationSample(entry));
    const invalidCount = parsedEntries.filter((entry) => !entry).length;
    const validEntries = parsedEntries.filter(
      (entry): entry is NonNullable<typeof entry> => Boolean(entry)
    );
    if (!validEntries.length) {
      res.status(400).json({ message: "No valid location points found in payload." });
      return;
    }

    const zoneCache = new Map<string, Awaited<ReturnType<typeof storage.listGeofencesForUser>>>();
    let accepted = 0;
    for (const entry of validEntries) {
      if (!ensureUserMatch(req, entry.userId)) {
        res.status(403).json({ message: `Not authorized to post location for user ${entry.userId}` });
        return;
      }
      let zones = zoneCache.get(entry.userId);
      if (!zones) {
        zones = await storage.listGeofencesForUser(entry.userId);
        zoneCache.set(entry.userId, zones);
      }
      const status = resolveGeofenceStatus(
        {
          userId: entry.userId,
          userName: "",
          latitude: entry.latitude,
          longitude: entry.longitude,
          deviceId: "",
          photoType: "checkin",
          isInsideGeofence: false,
        },
        zones
      );

      const log: LocationLog = {
        id: randomUUID(),
        userId: entry.userId,
        latitude: entry.latitude,
        longitude: entry.longitude,
        accuracy: entry.accuracy,
        speed: entry.speed,
        heading: entry.heading,
        batteryLevel: entry.batteryLevel ?? null,
        geofenceId: status.activeZone?.id ?? null,
        geofenceName: status.activeZone?.name ?? null,
        isInsideGeofence: status.inside,
        capturedAt: entry.capturedAt ?? new Date().toISOString(),
      };
      await storage.addLocationLog(log);
      try {
        await insertLocationLogInMySql(log);
      } catch (error) {
        console.error("Failed to persist location log in MySQL", error);
      }
      accepted += 1;
    }

    res.status(201).json({
      ok: true,
      accepted,
      rejected: invalidCount,
    });
  });

  app.get("/api/admin/live-map", requireAuth, requireRoles("admin", "hr", "manager"), async (_req, res) => {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    if (isMySqlStateEnabled()) {
      try {
        const latest = await listLocationLogsLatestFromMySql();
        res.json(latest);
        return;
      } catch (error) {
        console.error("Failed to read latest location logs from MySQL", error);
      }
    }
    const latest = await storage.getLocationLogsLatest();
    res.json(latest);
  });

  app.get(
    "/api/admin/live-map/routes",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const requestedDate = firstString(req.query.date) || toMumbaiDateKey(new Date());
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const intervalMinutes = parseIntervalMinutes(req.query.interval_minutes, 1);
      let allPoints: LocationLog[] = [];
      if (isMySqlStateEnabled()) {
        try {
          allPoints = await listLocationLogsForDateFromMySql(requestedDate);
        } catch (error) {
          console.error("Failed to read location logs for date from MySQL", error);
          allPoints = await storage.getLocationLogsForDate(requestedDate);
        }
      } else {
        allPoints = await storage.getLocationLogsForDate(requestedDate);
      }
      const byUser = new Map<string, LocationLog[]>();
      for (const point of allPoints) {
        const bucket = byUser.get(point.userId) ?? [];
        bucket.push(point);
        byUser.set(point.userId, bucket);
      }

      const routes = Array.from(byUser.entries())
        .map(([userId, userPoints]) => {
          const sampled = downsampleLocationLogsByInterval(userPoints, intervalMinutes);
          return {
            userId,
            intervalMinutes,
            pointCount: sampled.length,
            points: sampled,
            latestPoint: sampled.length ? sampled[sampled.length - 1] : null,
          };
        })
        .sort((a, b) => {
          const aTime = a.latestPoint?.capturedAt || "";
          const bTime = b.latestPoint?.capturedAt || "";
          return bTime.localeCompare(aTime);
        });

      res.json({
        date: requestedDate,
        intervalMinutes,
        routes,
      });
    }
  );

  app.get(
    "/api/admin/route/:id",
    requireAuth,
    requireRoles("admin", "hr", "manager", "salesperson"),
    async (req, res) => {
      const userId = firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      if (!ensureUserMatch(req, userId)) {
        res.status(403).json({ message: "Token user mismatch" });
        return;
      }

      const requestedDate = firstString(req.query.date) || toMumbaiDateKey(new Date());
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }

      const intervalMinutes = parseIntervalMinutes(req.query.interval_minutes, 1);
      let rawPoints: LocationLog[] = [];
      if (isMySqlStateEnabled()) {
        try {
          rawPoints = await listLocationLogsForUserDateFromMySql(userId, requestedDate);
        } catch (error) {
          console.error("Failed to read user location logs for date from MySQL", error);
          rawPoints = await storage.getLocationLogsForUserDate(userId, requestedDate);
        }
      } else {
        rawPoints = await storage.getLocationLogsForUserDate(userId, requestedDate);
      }
      const attendance = await storage.getAttendanceHistory(userId);
      const attendanceEvents = attendance
        .filter((record) => isMumbaiDateKey(record.timestamp, requestedDate))
        .map((record) => ({
          id: record.id,
          type: record.type,
          at: record.timestamp,
          geofenceName: record.geofenceName ?? null,
          latitude: record.location?.lat ?? null,
          longitude: record.location?.lng ?? null,
        }))
        .sort((a, b) => a.at.localeCompare(b.at));
      const sessionWindow = resolveRouteSessionWindow(attendanceEvents);
      const windowedPoints = filterLocationLogsToSessionWindow(rawPoints, sessionWindow);
      const points = downsampleLocationLogsByInterval(windowedPoints, intervalMinutes);
      const timeline = buildRouteTimeline(userId, requestedDate, points);
      const directions = await getMapplsDirectionsForLogs(points, {
        resource: firstString(req.query.routing_resource) || null,
        profile: firstString(req.query.routing_profile) || null,
        overview: firstString(req.query.routing_overview) || null,
        geometries: firstString(req.query.routing_geometries) || null,
        alternatives: parseBooleanQuery(req.query.routing_alternatives, false),
        steps: parseBooleanQuery(req.query.routing_steps, true),
        region: firstString(req.query.routing_region) || null,
        routeType: parseOptionalInteger(req.query.routing_rtype),
      });

      res.json({
        ...timeline,
        intervalMinutes,
        directions,
        attendanceEvents,
      });
    }
  );

  app.get(
    "/api/admin/route/:id/matrix",
    requireAuth,
    requireRoles("admin", "hr", "manager", "salesperson"),
    async (req, res) => {
      const userId = firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      if (!ensureUserMatch(req, userId)) {
        res.status(403).json({ message: "Token user mismatch" });
        return;
      }

      const requestedDate = firstString(req.query.date) || toMumbaiDateKey(new Date());
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }

      const points = await storage.getLocationLogsForUserDate(userId, requestedDate);

      if (points.length < 2) {
        res.status(400).json({ message: "At least 2 route points are required for matrix" });
        return;
      }

      const matrix = await getMapplsDistanceMatrixForLogs(points, {
        resource: firstString(req.query.distance_resource) || null,
        profile: firstString(req.query.distance_profile) || null,
        region: firstString(req.query.distance_region) || null,
        routeType: parseOptionalInteger(req.query.distance_rtype),
      });

      if (!matrix) {
        res.status(400).json({
          message: "Mappls routing API key missing. Configure MAPPLS_ROUTING_API_KEY in server env.",
        });
        return;
      }

      res.json({
        userId,
        date: requestedDate,
        matrix,
      });
    }
  );

  app.get("/api/mappls/places/autosuggest", requireAuth, async (req, res) => {
    const query = firstString(req.query.query);
    if (!query) {
      res.status(400).json({ message: "query is required." });
      return;
    }

    const locationPair =
      parseCoordinatePair(firstString(req.query.location)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
        const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();

    const limit = parseOptionalInteger(req.query.limit ?? req.query.itemCount);
    const response = await searchMapplsPlaces("autosuggest", query, {
      latitude: locationPair?.latitude ?? null,
      longitude: locationPair?.longitude ?? null,
      region: firstString(req.query.region) || null,
      limit,
    });

    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }

    res.json(response);
  });

  app.get("/api/mappls/places/text-search", requireAuth, async (req, res) => {
    const query = firstString(req.query.query);
    if (!query) {
      res.status(400).json({ message: "query is required." });
      return;
    }

    const locationPair =
      parseCoordinatePair(firstString(req.query.location)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
        const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();

    const limit = parseOptionalInteger(req.query.limit ?? req.query.itemCount);
    const response = await searchMapplsPlaces("text", query, {
      latitude: locationPair?.latitude ?? null,
      longitude: locationPair?.longitude ?? null,
      region: firstString(req.query.region) || null,
      limit,
    });

    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }

    res.json(response);
  });

  app.get("/api/mappls/reverse-geocode", requireAuth, async (req, res) => {
    const pointFromPair = parseCoordinatePair(firstString(req.query.location));
    const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
    const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
    const point =
      pointFromPair ||
      (lat !== null && lng !== null
        ? {
            latitude: lat,
            longitude: lng,
          }
        : null);

    if (!point || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      res.status(400).json({
        message:
          "Valid latitude and longitude are required. Use latitude/longitude or location=lat,lng.",
      });
      return;
    }

    const response = await reverseGeocodeMapplsCoordinates(point.latitude, point.longitude);
    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }
    res.json(response);
  });

  app.get("/api/mappls/route/preview", requireAuth, async (req, res) => {
    const origin =
      parseCoordinatePair(firstString(req.query.origin)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.origin_latitude ?? req.query.origin_lat);
        const lng = parseOptionalQueryFloat(
          req.query.origin_longitude ?? req.query.origin_lng ?? req.query.origin_lon
        );
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();
    const destination =
      parseCoordinatePair(firstString(req.query.destination)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.destination_latitude ?? req.query.destination_lat);
        const lng = parseOptionalQueryFloat(
          req.query.destination_longitude ?? req.query.destination_lng ?? req.query.destination_lon
        );
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();
    const waypoints = parseCoordinatesList(firstString(req.query.waypoints));

    if (!origin || !destination) {
      res.status(400).json({
        message:
          "origin and destination are required. Use origin=lat,lng and destination=lat,lng.",
      });
      return;
    }

    const routePoints = [origin, ...waypoints, destination];
    const directions = await getMapplsDirectionsForCoordinates(routePoints, {
      resource: firstString(req.query.resource) || null,
      profile: firstString(req.query.profile) || null,
      overview: firstString(req.query.overview) || null,
      geometries: firstString(req.query.geometries) || null,
      alternatives: parseBooleanQuery(req.query.alternatives, false),
      steps: parseBooleanQuery(req.query.steps, true),
      region: firstString(req.query.region) || null,
      routeType: parseOptionalInteger(req.query.rtype),
    });

    if (!directions) {
      res.status(400).json({
        message: "Mappls routing API key missing. Configure MAPPLS_ROUTING_API_KEY in server env.",
      });
      return;
    }

    res.json({
      provider: "mappls",
      origin,
      destination,
      waypointCount: waypoints.length,
      routePointCount: routePoints.length,
      directions,
    });
  });

  app.post("/api/attendance/checkin", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }

    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on check-in (${payload.biometricFailureReason ?? "unknown"})`,
      });
      res.status(400).json({
        message: "Biometric verification is required for check-in.",
      });
      return;
    }

    if (
      typeof payload.locationAccuracyMeters !== "number" ||
      payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details:
          typeof payload.locationAccuracyMeters === "number"
            ? `Weak GPS accuracy on check-in: +/-${Math.round(payload.locationAccuracyMeters)}m`
            : "Missing GPS accuracy evidence on check-in",
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }

    if (
      typeof payload.locationSampleCount !== "number" ||
      payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on check-in (${payload.locationSampleCount ?? 0})`,
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }

    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }

    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client",
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }

    const bindResult = await storage.bindDevice(payload.userId, payload.deviceId);
    if (!bindResult.ok) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "device_mismatch",
        severity: "high",
        details: "Device binding mismatch detected on check-in",
      });
      res.status(403).json({ message: "Device mismatch detected" });
      return;
    }

    const existing = await storage.findActiveAttendance(payload.userId);
    if (existing) {
      await recordAnomaly({
        attendanceId: existing.id,
        userId: payload.userId,
        type: "duplicate_checkin",
        severity: "medium",
        details: "Attempted duplicate check-in while already checked in",
      });
      res.status(409).json({ message: "User already checked in" });
      return;
    }

    const userZones = await storage.listGeofencesForUser(payload.userId);
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    const allowOverride = zoneStatus.activeZone?.allowOverride ?? false;
    const insideZone = zoneStatus.insideConfirmed;

    if (zoneStatus.inside && !zoneStatus.insideConfirmed && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "uncertain_geofence",
        severity: "medium",
        details:
          `Geofence boundary uncertainty on check-in. Distance ${Math.round(zoneStatus.distanceMeters)}m, ` +
          `buffer ${zoneStatus.confidenceBufferMeters}m`,
      });
    }

    if (!insideZone && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "outside_geofence",
        severity: "high",
        details:
          `Check-in attempted outside strict geofence. Distance: ${Math.round(zoneStatus.distanceMeters)}m, ` +
          `buffer: ${zoneStatus.confidenceBufferMeters}m`,
      });
      res.status(400).json({ message: "Outside geofence. Check-in denied." });
      return;
    }

    const photoUrl = payload.photoBase64
      ? await storeAttendancePhoto(
          payload.photoBase64,
          payload.photoMimeType ?? "image/jpeg",
          payload.userId,
          "checkin"
        )
      : null;

    const now = new Date().toISOString();
    const attendanceRecord: AttendanceRecord = {
      id: randomUUID(),
      userId: payload.userId,
      userName: payload.userName,
      type: "checkin",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: insideZone,
      notes: payload.notes,
      source: "mobile",
    };

    await storage.createAttendance(attendanceRecord);
    await storage.addLocationLog({
      id: randomUUID(),
      userId: payload.userId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: null,
      speed: null,
      heading: null,
      geofenceId: attendanceRecord.geofenceId ?? null,
      geofenceName: attendanceRecord.geofenceName ?? null,
      isInsideGeofence: attendanceRecord.isInsideGeofence ?? false,
      capturedAt: now,
    });

    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID(),
        attendanceId: attendanceRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: attendanceRecord.geofenceId ?? null,
        geofenceName: attendanceRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkin",
      });
    }

    const checkInDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(attendanceRecord, checkInDolibarrConfig);
    res.status(201).json(attendanceRecord);
  });

  app.post("/api/attendance/checkout", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }

    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on checkout (${payload.biometricFailureReason ?? "unknown"})`,
      });
      res.status(400).json({
        message: "Biometric verification is required for checkout.",
      });
      return;
    }

    if (
      typeof payload.locationAccuracyMeters !== "number" ||
      payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details:
          typeof payload.locationAccuracyMeters === "number"
            ? `Weak GPS accuracy on checkout: +/-${Math.round(payload.locationAccuracyMeters)}m`
            : "Missing GPS accuracy evidence on checkout",
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }

    if (
      typeof payload.locationSampleCount !== "number" ||
      payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on checkout (${payload.locationSampleCount ?? 0})`,
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }

    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }

    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client on checkout",
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }

    const active = await storage.findActiveAttendance(payload.userId);
    if (!active) {
      res.status(400).json({ message: "No active check-in found for checkout" });
      return;
    }

    const userZones = await storage.listGeofencesForUser(payload.userId);
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    const now = new Date().toISOString();

    if (!zoneStatus.inside) {
      await recordAnomaly({
        attendanceId: active.id,
        userId: payload.userId,
        type: "checkout_outside_zone",
        severity: "medium",
        details: `Checkout performed outside zone at distance ${Math.round(zoneStatus.distanceMeters)}m`,
      });
    }

    const photoUrl = payload.photoBase64
      ? await storeAttendancePhoto(
          payload.photoBase64,
          payload.photoMimeType ?? "image/jpeg",
          payload.userId,
          "checkout"
        )
      : null;

    const checkoutRecord: AttendanceRecord = {
      id: randomUUID(),
      userId: payload.userId,
      userName: payload.userName,
      type: "checkout",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: zoneStatus.inside,
      notes: payload.notes,
      source: "mobile",
    };

    await storage.createAttendance(checkoutRecord);
    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID(),
        attendanceId: checkoutRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: checkoutRecord.geofenceId ?? null,
        geofenceName: checkoutRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkout",
      });
    }

    const checkOutDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(checkoutRecord, checkOutDolibarrConfig);
    res.status(201).json(checkoutRecord);
  });

  app.get("/api/attendance/today", requireAuth, async (req, res) => {
    const userId = firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const records = await storage.getAttendanceToday(userId);
    res.json(records);
  });

  app.get("/api/attendance/history", requireAuth, async (req, res) => {
    const userId = firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const records = await storage.getAttendanceHistory(userId);
    res.json(records);
  });

  const httpServer = createServer(app);
  return httpServer;
}

