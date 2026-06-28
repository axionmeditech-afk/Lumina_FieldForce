import express, { type Express, type Request, type Response } from "express";
import type { Pool, PoolConnection } from "mysql2/promise";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AppNotification,
  AppUser,
  AttendanceCheckPayload,
  AttendanceRecord,
  CompanyProfile,
  Conversation,
  Expense,
  Geofence,
  LocationLog,
  NotificationAudience,
  RouteTimeline,
  SalaryRecord,
  Task,
  UserAccessRequest,
  VisitHistoryRecord,
  UserRole,
} from "@/lib/types";
import {
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  PENDING_COMPANY_ID,
  PENDING_COMPANY_NAME,
} from "@/lib/seedData";
import { buildRouteTimeline } from "@/lib/route-analytics";
import { requireAuth, requireRoles, signJwt, verifyJwt } from "@/server/auth";
import { storage } from "@/server/storage";
import { recordAnomaly, resolveGeofenceStatus } from "@/server/services/attendance-guard";
import { storeAttendancePhoto } from "@/server/services/photo-upload";
import {
  syncApprovedUserToDolibarrEmployee,
  syncAttendanceWithDolibarr,
} from "@/server/services/dolibarr-sync";
import { storeSupportAttachmentBinary } from "@/server/services/support-attachments";
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
import { analyzeConversationWithAI } from "@/lib/aiSalesAnalysis";
import { isMumbaiDateKey, toMumbaiDateKey } from "@/lib/ist-time";
import { isSalesRole } from "@/lib/role-access";
import { registerAiAnalysisRoutes } from "@/server/routes/ai.routes";
import { registerDolibarrSettingsRoutes } from "@/server/routes/settings.routes";
import { registerHealthRoutes } from "@/server/routes/health.routes";
import { registerNotificationRoutes } from "@/server/routes/notifications.routes";
import { registerSalaryRoutes } from "@/server/routes/salary.routes";
import { registerAttendanceRoutes } from "@/server/routes/attendance.routes";
import { registerLocationRoutes } from "@/server/routes/location.routes";
import { registerLeaveRoutes } from "@/server/routes/leave.routes";
import { registerMapplsRoutes } from "@/server/routes/mappls.routes";
import { registerStockRoutes } from "@/server/routes/stock.routes";
import { registerDolibarrRoutes } from "@/server/routes/dolibarr.routes";
import { registerSupportRoutes } from "@/server/routes/support.routes";
import { registerCompanyRoutes } from "@/server/routes/companies.routes";
import { registerAuthRoutes } from "@/server/routes/auth.routes";
import { registerSpeechRoutes } from "@/server/routes/speech.routes";
import { registerVisitRoutes } from "@/server/routes/visit-notes.routes";
import { registerStateRoutes } from "@/server/routes/state.routes";
import { registerLocationSyncRoutes } from "@/server/routes/location-sync.routes";
import { registerAttendanceActionRoutes } from "@/server/routes/attendance-actions.routes";
import { registerBankAccountRoutes } from "@/server/routes/bank-accounts.routes";
import { registerGeofenceRoutes } from "@/server/routes/geofences.routes";


const adminWsClients = new Set<WebSocket>();

export function broadcastAttendanceUpdate(record: AttendanceRecord) {
  const message = JSON.stringify({ type: "attendance_update", record });
  for (const client of adminWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function broadcastLocationUpdate(log: LocationLog) {
  const message = JSON.stringify({ type: "location_update", log });
  for (const client of adminWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}


const MAX_LOCATION_ACCURACY_METERS = 120;
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;
const MAX_CAPTURE_DRIFT_MS = 2 * 60 * 1000;
const MIN_LOCATION_SAMPLE_COUNT = 2;
const MAX_TRANSCRIBE_AUDIO_BYTES = 350 * 1024 * 1024;
const DEFAULT_GROQ_API_KEY =
  (
    process.env.GROQ_API_KEY ||
    process.env.EXPO_PUBLIC_GROQ_API_KEY ||
    ""
  ).trim();
const DEFAULT_AI_MODEL =
  (process.env.GROQ_MODEL || process.env.EXPO_PUBLIC_GROQ_MODEL || "openai/gpt-oss-20b").trim();
const DOLIBARR_ENV_ENDPOINT = (
  process.env.DOLIBARR_ENDPOINT ||
  process.env.DOLIBARR_BASE_URL ||
  ""
).trim();
const DOLIBARR_INSECURE_TLS =
  String(process.env.DOLIBARR_INSECURE_TLS || "false").toLowerCase() === "true";
const DOLIBARR_ENV_API_KEY = (process.env.DOLIBARR_API_KEY || "").trim();
const DOLIBARR_USER_AGENT = (
  process.env.DOLIBARR_USER_AGENT ||
  "LuminaFieldForce/1.0 (+https://api.axionmeditech.com)"
).trim();
const LEGACY_COMPANY_DATA_REHOME_TARGET_ID = (
  process.env.LEGACY_COMPANY_DATA_REHOME_TARGET_ID ||
  "cmp_lumina_meditech_7f3e019e"
).trim();
const DOLIBARR_PROXY_RULES: Array<{
  prefix: string;
  roles: UserRole[];
}> = [
  { prefix: "/users", roles: ["admin", "hr", "manager"] },
  { prefix: "/salaries", roles: ["admin", "hr", "manager"] },
  { prefix: "/salary", roles: ["admin", "hr", "manager"] },
  { prefix: "/products", roles: ["admin", "hr", "manager", "salesperson", "employee"] },
  { prefix: "/thirdparties", roles: ["admin", "hr", "manager", "salesperson", "employee"] },
  { prefix: "/orders", roles: ["admin", "hr", "manager", "salesperson", "employee"] },
  { prefix: "/warehouses", roles: ["admin", "hr", "manager"] },
  { prefix: "/stockmovements", roles: ["admin", "hr", "manager"] },
  { prefix: "/invoices", roles: ["admin", "hr", "manager"] },
  { prefix: "/bankaccounts", roles: ["admin", "hr", "manager", "salesperson", "employee"] },
];
const PRODUCT_STOCK_TABLE = "nmy5_product_stock";
const LEGACY_DEMO_PROFILE_NAMES = new Set([
  "priya",
  "priya sharma",
  "rohit",
  "sneha",
  "sneha reddy",
]);
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
  "@trackforce_quick_sale_location_logs",
  "@trackforce_dolibarr_sync_logs",
  "@trackforce_notifications",
  "@trackforce_support_threads",
]);
const COMPANY_SCOPED_REMOTE_STATE_KEYS = new Set([
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
  "@trackforce_geofences",
  "@trackforce_teams",
  "@trackforce_attendance_photos",
  "@trackforce_attendance_anomalies",
  "@trackforce_location_logs",
  "@trackforce_quick_sale_location_logs",
  "@trackforce_dolibarr_sync_logs",
  "@trackforce_notifications",
  "@trackforce_support_threads",
]);
const NORMALIZED_STATE_KEYS = new Set([
  "@trackforce_companies",
  "@trackforce_employees",
  "@trackforce_attendance",
  "@trackforce_expenses",
  "@trackforce_location_logs",
  "@trackforce_conversations",
  "@trackforce_stockists",
  "@trackforce_stock_transfers",
  "@trackforce_incentive_goal_plans",
  "@trackforce_incentive_product_plans",
  "@trackforce_incentive_payouts",
  "@trackforce_salaries",
  "@trackforce_support_threads",
]);
const REMOTE_LOCATION_LOG_READ_LIMIT = 2500;
const REMOTE_LOCATION_LOG_WRITE_LIMIT = 500;
const LEGACY_LOCATION_LOG_STATE_MAX_BYTES = 1_500_000;
const ENABLE_LEGACY_LOCATION_LOG_HYDRATION =
  String(process.env.ENABLE_LEGACY_LOCATION_LOG_HYDRATION || "false").toLowerCase() === "true";

function isLocationLogStateKey(key: string): boolean {
  return key === "@trackforce_location_logs";
}

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

function parseJsonText(text: string): unknown | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function firstMessageFromBody(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  const message = body.message;
  if (typeof message === "string") return message.trim();
  const error = body.error;
  if (error && typeof error === "object") {
    const errorMessage = (error as Record<string, unknown>).message;
    if (typeof errorMessage === "string") return errorMessage.trim();
  }
  return "";
}

function getDolibarrProtectionBlockMessage(text: string, payload: unknown): string | null {
  const message = firstMessageFromBody(payload) || text.trim().replace(/\s+/g, " ").slice(0, 240);
  if (/imunify360|bot-protection|access denied/i.test(message)) {
    return message;
  }
  return null;
}

function buildDolibarrProxyHeaders(apiKey: string, includeContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    DOLAPIKEY: apiKey,
    "X-Dolibarr-API-Key": apiKey,
    Accept: "application/json",
    "User-Agent": DOLIBARR_USER_AGENT,
  };
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function readDolibarrBankAccountIbanPrefix(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  const rawValue = record.iban_prefix ?? record.ifscCode ?? record.bic;
  if (typeof rawValue === "string") return rawValue.trim().toUpperCase();
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) return String(rawValue);
  return "";
}

function parseDolibarrProxyEntityId(payload: unknown): number | null {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return Math.trunc(payload);
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload as Record<string, unknown>;
  const candidates = [body.id, body.rowid, body.ref];
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

async function updateDolibarrBankAccountIbanPrefix(rowId: number, ibanPrefix: string): Promise<void> {
  const value = ibanPrefix.trim().toUpperCase();
  if (!value || !isMySqlStateEnabled()) return;

  const conn = await getMySqlPool();
  await conn.execute(
    "UPDATE `nmy5_bank_account` SET `iban_prefix` = ? WHERE `rowid` = ?",
    [value, rowId]
  );
}

async function enrichDolibarrBankAccountsWithIbanPrefix(payload: unknown): Promise<unknown> {
  if (!Array.isArray(payload) || !isMySqlStateEnabled()) return payload;

  const rowIds = Array.from(
    new Set(
      payload
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const account = entry as Record<string, unknown>;
          const rawId = account.rowid ?? account.id;
          const parsed = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
          return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
        })
        .filter((id): id is number => id !== null)
    )
  );
  if (rowIds.length === 0) return payload;

  try {
    const conn = await getMySqlPool();
    const placeholders = rowIds.map(() => "?").join(", ");
    const [rows] = await conn.query<any[]>(
      `SELECT \`rowid\`, \`iban_prefix\`
         FROM \`nmy5_bank_account\`
        WHERE \`rowid\` IN (${placeholders})`,
      rowIds
    );
    const ifscByRowId = new Map<string, string>();
    for (const row of rows || []) {
      const rowId = row.rowid ? String(row.rowid) : "";
      const ifsc = row.iban_prefix ? String(row.iban_prefix).trim() : "";
      if (rowId && ifsc) {
        ifscByRowId.set(rowId, ifsc);
      }
    }
    if (ifscByRowId.size === 0) return payload;

    return payload.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const account = entry as Record<string, unknown>;
      const rowId = String(account.rowid ?? account.id ?? "");
      const ibanPrefix = ifscByRowId.get(rowId);
      return ibanPrefix ? { ...account, iban_prefix: ibanPrefix } : account;
    });
  } catch (error) {
    console.error("Unable to enrich Dolibarr bank accounts with iban_prefix", {
      message: error instanceof Error ? error.message : String(error),
    });
    return payload;
  }
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
  const [rows] = await conn.query<any[]>(
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

function buildDolibarrEndpointCandidates(value: string | null | undefined): string[] {
  const raw = (value || "").trim().replace(/\/+$/, "");
  if (!raw) return [];
  try {
    const url = new URL(raw);
    const candidates = new Set<string>();
    const pathname = url.pathname.replace(/\/+$/, "");

    const addCandidate = (nextPath: string) => {
      const next = new URL(url.toString());
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
    } else {
      if (pathname) {
        addCandidate(`${pathname}/api/index.php`);
        addCandidate(`${pathname}/api`);
      }
      addCandidate("/api/index.php");
      addCandidate("/api");
      if (pathname && !/\/$/i.test(pathname)) {
        addCandidate(pathname);
      }
    }
    return Array.from(candidates);
  } catch {
    return [];
  }
}

function normalizeDolibarrEndpoint(value: string | null | undefined): string | null {
  return buildDolibarrEndpointCandidates(value)[0] ?? null;
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
  endpoints: string[];
  apiKey: string | null;
  source: "env" | "settings";
}> {
  const stored = await storage.getDolibarrConfigForUser(userId);
  const latestStored = stored ? null : await storage.getLatestDolibarrConfig();
  const settingsEndpointValue = stored?.endpoint ?? latestStored?.endpoint ?? "";
  const settingsApiKey = normalizeApiSecret(stored?.apiKey ?? latestStored?.apiKey ?? "");
  const settingsEndpoints = buildDolibarrEndpointCandidates(settingsEndpointValue);
  if (settingsEndpoints.length > 0 && settingsApiKey) {
    return {
      endpoint: settingsEndpoints[0],
      endpoints: settingsEndpoints,
      apiKey: settingsApiKey,
      source: "settings",
    };
  }

  const envEndpoints = buildDolibarrEndpointCandidates(DOLIBARR_ENV_ENDPOINT);
  const envApiKey = normalizeApiSecret(DOLIBARR_ENV_API_KEY);
  if (envEndpoints.length > 0 && envApiKey) {
    return {
      endpoint: envEndpoints[0],
      endpoints: envEndpoints,
      apiKey: envApiKey,
      source: "env",
    };
  }

  const userConfig = await resolveDolibarrConfigForUser(userId);
  const endpoints = buildDolibarrEndpointCandidates(userConfig.endpoint);
  const apiKey = normalizeApiSecret(userConfig.apiKey);
  return {
    endpoint: endpoints[0] ?? null,
    endpoints,
    apiKey,
    source: userConfig.source,
  };
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
  const endpoints = config.endpoints.length ? config.endpoints : [endpoint];
  const path = options.forwardPath.startsWith("/") ? options.forwardPath : `/${options.forwardPath}`;

  const controller = new AbortController();
  const requestTimeoutMs = path.startsWith("/bankaccounts") ? 30_000 : 15_000;
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let lastTargetUrl = "";
  const endpointFailures: string[] = [];
  try {
    const normalizedBody =
      method === "GET" || method === "HEAD"
        ? undefined
        : (() => {
            if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
              return req.body ?? {};
            }
            const body = { ...(req.body as Record<string, unknown>) };
            if (path === "/thirdparties" && method === "POST") {
              const normalizedName =
                typeof body.name === "string"
                  ? body.name.trim()
                  : typeof body.nom === "string"
                    ? body.nom.trim()
                    : "";
              if (normalizedName) {
                body.name = normalizedName;
                body.nom = normalizedName;
              }
              const rawClient = body.client;
              const isClientCreate =
                rawClient === 1 ||
                rawClient === "1" ||
                rawClient === true ||
                (typeof rawClient === "string" && rawClient.trim().toLowerCase() === "true");
              if (!("client" in body)) {
                body.client = 1;
              }
              if (!("status" in body)) {
                body.status = 1;
              }
              if (!("fournisseur" in body)) {
                body.fournisseur = 0;
              }
              if (!("prospect" in body)) {
                body.prospect = 1;
              }
              const hasCustomerCode =
                typeof body.code_client === "string"
                  ? Boolean(body.code_client.trim())
                  : typeof body.code_client === "number" && Number.isFinite(body.code_client);
              if (isClientCreate && !hasCustomerCode) {
                body.code_client = "-1";
              }
              const hasVendorCode =
                typeof body.code_fournisseur === "string"
                  ? Boolean(body.code_fournisseur.trim())
                  : typeof body.code_fournisseur === "number" &&
                    Number.isFinite(body.code_fournisseur);
              if (!hasVendorCode) {
                body.code_fournisseur = "-1";
              }
              if (!("country_code" in body)) {
                body.country_code = "IN";
              }
              if (!("country_id" in body)) {
                body.country_id = 117;
              }
            }
            if (path === "/bankaccounts" && method === "POST") {
              const ibanPrefix = readDolibarrBankAccountIbanPrefix(body);
              if (ibanPrefix) {
                body.iban_prefix = ibanPrefix;
                delete body.bic;
              }
            }
            return body;
          })();
    const dispatcher =
      DOLIBARR_INSECURE_TLS && endpoints.some((candidate) => candidate.startsWith("https:"))
        ? new (await import("undici")).Agent({
            connect: { rejectUnauthorized: false },
          })
        : undefined;
    const isGetOrHead = method === "GET" || method === "HEAD";
    const headers = buildDolibarrProxyHeaders(apiKey, !isGetOrHead);
    const requestInit: RequestInit & { dispatcher?: unknown } = {
      method,
      headers,
      body: isGetOrHead ? undefined : JSON.stringify(normalizedBody),
      signal: controller.signal,
    };
    if (dispatcher) {
      requestInit.dispatcher = dispatcher;
    }

    for (const candidateEndpoint of endpoints) {
      const base = candidateEndpoint.replace(/\/+$/, "");
      const targetUrl = `${base}${path}${query}`;
      lastTargetUrl = targetUrl;

      console.log(`[Dolibarr Proxy] Target URL: ${targetUrl}, Method: ${method}, Source: ${config.source}`);

      try {
        const response = await fetch(targetUrl, requestInit);
        const text = await response.text();
        const contentType = response.headers.get("content-type");
        const parsedBody = parseJsonText(text);
        const protectionBlockMessage = getDolibarrProtectionBlockMessage(text, parsedBody);
        if (protectionBlockMessage) {
          endpointFailures.push(`${candidateEndpoint} -> blocked by Dolibarr host protection: ${protectionBlockMessage}`);
          console.error("Dolibarr host protection blocked proxy request", {
            targetUrl,
            status: response.status,
            contentType,
            message: protectionBlockMessage,
          });
          res.status(502).json({
            message:
              "Dolibarr host protection blocked the backend server IP. Whitelist this backend server's outbound IP in Imunify360/cPanel, or disable bot protection for /api/index.php.",
            upstreamMessage: protectionBlockMessage,
            attempts: endpointFailures,
          });
          return;
        }
        const normalizedContentType = (contentType || "").toLowerCase();
        const looksLikeHtml =
          !parsedBody &&
          (normalizedContentType.includes("text/html") ||
            /^\s*<!doctype html/i.test(text) ||
            /^\s*<html\b/i.test(text));
        if (looksLikeHtml) {
          endpointFailures.push(
            `${candidateEndpoint} -> HTTP ${response.status}: returned HTML instead of JSON`
          );
          console.error("Dolibarr proxy received HTML instead of JSON", {
            targetUrl,
            status: response.status,
            contentType,
            preview: text.trim().slice(0, 220),
          });
          continue;
        }

        if (!response.ok && [404, 502, 503, 504].includes(response.status)) {
          const preview = text.trim().replace(/\s+/g, " ").slice(0, 160);
          endpointFailures.push(
            `${candidateEndpoint} -> HTTP ${response.status}${preview ? `: ${preview}` : ""}`
          );
          continue;
        }

        let responseText = text;
        if (path === "/bankaccounts" && method === "GET" && response.ok && parsedBody) {
          const enrichedBody = await enrichDolibarrBankAccountsWithIbanPrefix(parsedBody);
          responseText = JSON.stringify(enrichedBody);
          res.setHeader("Content-Type", "application/json");
        } else if (path === "/bankaccounts" && method === "POST" && response.ok && parsedBody) {
          const bankAccountId = parseDolibarrProxyEntityId(parsedBody);
          const ibanPrefix = readDolibarrBankAccountIbanPrefix(normalizedBody);
          if (bankAccountId && ibanPrefix) {
            try {
              await updateDolibarrBankAccountIbanPrefix(bankAccountId, ibanPrefix);
            } catch (error) {
              console.error("Unable to store IFSC in nmy5_bank_account.iban_prefix", {
                bankAccountId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (contentType) {
            res.setHeader("Content-Type", contentType);
          }
        } else if (contentType) {
          res.setHeader("Content-Type", contentType);
        }
        res.status(response.status).send(responseText);
        return;
      } catch (error) {
        const err = error as { message?: string; cause?: unknown };
        const cause = err?.cause as { code?: string; errno?: string; syscall?: string; hostname?: string } | undefined;
        const extra =
          cause && (cause.code || cause.errno || cause.syscall || cause.hostname)
            ? ` (${[cause.code, cause.errno, cause.syscall, cause.hostname].filter(Boolean).join(" ")})`
            : "";
        const message =
          (err?.message || "Unable to reach Dolibarr endpoint.") + extra;
        endpointFailures.push(`${candidateEndpoint} -> ${message}`);
        console.error("Dolibarr proxy failed for candidate", {
          targetUrl,
          message,
          cause,
        });
      }
    }

    res.status(502).json({
      message:
        "Dolibarr endpoint returned HTML or an API error for all known URL shapes. Set Dolibarr Endpoint to the REST API base, usually https://your-dolibarr-domain/api/index.php.",
      attempts: endpointFailures,
    });
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
      targetUrl: lastTargetUrl,
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
  let activeStartAt: string | null = null;
  let lastCompletedWindow: RouteSessionWindow = { startAt: null, endAt: null };

  for (const entry of ordered) {
    if (entry.type === "checkin") {
      activeStartAt = entry.at;
      continue;
    }
    if (entry.type === "checkout" && activeStartAt) {
      lastCompletedWindow = {
        startAt: activeStartAt,
        endAt: entry.at,
      };
      activeStartAt = null;
    }
  }

  if (activeStartAt) {
    return { startAt: activeStartAt, endAt: null };
  }
  return lastCompletedWindow;
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

async function resolveRequestCompanyId(req: Request): Promise<string | null> {
  const email = normalizeEmailKey(req.auth?.email);
  if (!email) return null;
  const synced = await syncAuthUserCacheForEmail(email).catch(() => null);
  const cached = getAuthUserByIdentifier(email);
  return synced?.user.companyId ?? cached?.user.companyId ?? null;
}

function getRequestUser(req: Request): AppUser | null {
  const auth = req.auth;
  if (!auth) return null;
  const email = normalizeEmailKey(auth.email);
  const cached = email ? getAuthUserByIdentifier(email)?.user : null;
  if (cached) return cached;
  const id = normalizeWhitespace(auth.sub || email || "user");
  const nameSeed = normalizeWhitespace(email.split("@")[0] || id);
  return {
    id,
    name: nameSeed || id,
    email,
    login: nameSeed || undefined,
    role: auth.role,
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "",
    branch: "",
    phone: "",
    joinDate: new Date().toISOString().slice(0, 10),
  };
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
let accessRequestAssignmentColumnsEnsured = false;
let stockistAssignmentColumnsEnsured = false;
let taskVisitNotesColumnsEnsured = false;
let visitHistoryTableEnsured = false;
let conversationsTableEnsured = false;
let legacyConversationsMigrated = false;
let legacyConversationsMigrationPromise: Promise<void> | null = null;
const ENV_DOLIBARR_SUPERUSER_EMAILS = String(process.env.DOLIBARR_SUPERUSER_EMAILS || "")
  .split(",")
  .map((entry) => normalizeEmailKey(entry))
  .filter(Boolean);

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
  await ensureCompaniesTableInMySql();
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

async function upsertAuthUserInMySql(
  record: AuthUserRecord,
  requestedCompanyName?: string | null,
  options?: { systemAdministrator?: boolean }
): Promise<void> {
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
  const systemAdministratorOverride =
    typeof options?.systemAdministrator === "boolean" ? options.systemAdministrator : null;
  const adminFlag =
    systemAdministratorOverride === null
      ? user.role === "admin"
        ? 1
        : 0
      : systemAdministratorOverride
        ? 1
        : 0;
  const employeeFlag =
    systemAdministratorOverride === null
      ? user.role === "admin"
        ? 0
        : 1
      : systemAdministratorOverride
        ? 0
        : 1;
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

async function ensureAccessRequestAssignmentColumns(): Promise<void> {
  if (accessRequestAssignmentColumnsEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    ALTER TABLE lff_access_requests
      ADD COLUMN IF NOT EXISTS assigned_stockist_id VARCHAR(64) NULL AFTER assigned_manager_name,
      ADD COLUMN IF NOT EXISTS assigned_stockist_name VARCHAR(191) NULL AFTER assigned_stockist_id
  `);
  accessRequestAssignmentColumnsEnsured = true;
}

async function ensureStockistAssignmentColumns(): Promise<void> {
  if (stockistAssignmentColumnsEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    ALTER TABLE lff_stockists
      ADD COLUMN IF NOT EXISTS assigned_salesperson_ids_json LONGTEXT NULL AFTER notes
  `);
  stockistAssignmentColumnsEnsured = true;
}

async function ensureTaskVisitNotesColumns(): Promise<void> {
  if (taskVisitNotesColumnsEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    ALTER TABLE lff_tasks
      ADD COLUMN IF NOT EXISTS task_type VARCHAR(32) NULL AFTER description,
      ADD COLUMN IF NOT EXISTS visit_plan_date DATETIME NULL AFTER due_date,
      ADD COLUMN IF NOT EXISTS visit_sequence INT NULL AFTER visit_plan_date,
      ADD COLUMN IF NOT EXISTS visit_location_label VARCHAR(191) NULL AFTER visit_sequence,
      ADD COLUMN IF NOT EXISTS visit_location_address LONGTEXT NULL AFTER visit_location_label,
      ADD COLUMN IF NOT EXISTS visit_latitude DECIMAL(10,7) NULL AFTER visit_location_address,
      ADD COLUMN IF NOT EXISTS visit_longitude DECIMAL(10,7) NULL AFTER visit_latitude,
      ADD COLUMN IF NOT EXISTS arrival_at DATETIME NULL AFTER visit_longitude,
      ADD COLUMN IF NOT EXISTS departure_at DATETIME NULL AFTER arrival_at,
      ADD COLUMN IF NOT EXISTS meeting_notes LONGTEXT NULL AFTER departure_at,
      ADD COLUMN IF NOT EXISTS meeting_notes_updated_at DATETIME NULL AFTER meeting_notes,
      ADD COLUMN IF NOT EXISTS visit_departure_notes LONGTEXT NULL AFTER meeting_notes_updated_at,
      ADD COLUMN IF NOT EXISTS visit_departure_notes_updated_at DATETIME NULL AFTER visit_departure_notes,
      ADD COLUMN IF NOT EXISTS auto_capture_conversation_id VARCHAR(64) NULL AFTER visit_departure_notes_updated_at
  `);
  taskVisitNotesColumnsEnsured = true;
}

async function ensureVisitHistoryTable(): Promise<void> {
  if (visitHistoryTableEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS lff_visit_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      company_id VARCHAR(64) NULL,
      task_id VARCHAR(64) NOT NULL,
      salesperson_id VARCHAR(64) NOT NULL,
      salesperson_name VARCHAR(191) NULL,
      visit_label VARCHAR(191) NOT NULL,
      visit_location_address LONGTEXT NULL,
      visit_latitude DECIMAL(10,7) NULL,
      visit_longitude DECIMAL(10,7) NULL,
      arrival_at DATETIME NULL,
      departure_at DATETIME NULL,
      meeting_notes LONGTEXT NULL,
      visit_departure_notes LONGTEXT NULL,
      auto_capture_conversation_id VARCHAR(64) NULL,
      status VARCHAR(32) NULL,
      source_created_at DATETIME NULL,
      source_updated_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_lff_visit_history_task_id (task_id),
      KEY idx_lff_visit_history_company_salesperson (company_id, salesperson_id),
      KEY idx_lff_visit_history_salesperson_departure (salesperson_id, departure_at),
      KEY idx_lff_visit_history_geo (visit_latitude, visit_longitude)
    )
  `);
  visitHistoryTableEnsured = true;
}

function toMySqlDateTime(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value || "");
  if (!normalized) return null;
  const next = new Date(normalized);
  if (Number.isNaN(next.getTime())) return null;
  return next.toISOString().slice(0, 19).replace("T", " ");
}

function fromMySqlDateTime(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  const normalized = normalizeWhitespace(String(value));
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}T00:00:00.000Z`;
  }
  if (normalized.includes("T")) {
    const iso = new Date(normalized);
    return Number.isNaN(iso.getTime()) ? normalized : iso.toISOString();
  }
  const assumedUtc = new Date(normalized.replace(" ", "T") + "Z");
  return Number.isNaN(assumedUtc.getTime()) ? normalized : assumedUtc.toISOString();
}

function normalizeVisitNoteTask(task: Partial<Task>, fallbackUser?: AppUser | null): Task {
  const fallbackName =
    normalizeWhitespace(fallbackUser?.name || "") ||
    normalizeWhitespace(task.assignedToName || "") ||
    "Unknown";
  const nowIso = new Date().toISOString();
  return {
    id: normalizeWhitespace(task.id || "") || randomUUID(),
    companyId: normalizeWhitespace(task.companyId || "") || fallbackUser?.companyId || undefined,
    title: normalizeWhitespace(task.title || "") || "Visit",
    description: normalizeWhitespace(task.description || "") || "Field visit",
    taskType: task.taskType === "field_visit" ? "field_visit" : "general",
    assignedTo: normalizeWhitespace(task.assignedTo || "") || fallbackUser?.id || "",
    assignedToName: normalizeWhitespace(task.assignedToName || "") || fallbackName,
    assignedBy: normalizeWhitespace(task.assignedBy || "") || fallbackUser?.id || "system",
    teamId: task.teamId ?? null,
    teamName: task.teamName ?? null,
    status: task.status === "completed" || task.status === "in_progress" ? task.status : "pending",
    priority: task.priority === "low" || task.priority === "high" ? task.priority : "medium",
    dueDate: normalizeWhitespace(task.dueDate || "") || nowIso,
    createdAt: normalizeWhitespace(task.createdAt || "") || nowIso,
    visitPlanDate: task.visitPlanDate ?? null,
    visitSequence:
      typeof task.visitSequence === "number" && Number.isFinite(task.visitSequence)
        ? Math.trunc(task.visitSequence)
        : null,
    visitLatitude:
      typeof task.visitLatitude === "number" && Number.isFinite(task.visitLatitude)
        ? task.visitLatitude
        : null,
    visitLongitude:
      typeof task.visitLongitude === "number" && Number.isFinite(task.visitLongitude)
        ? task.visitLongitude
        : null,
    visitLocationLabel: task.visitLocationLabel ?? null,
    visitLocationAddress: task.visitLocationAddress ?? null,
    arrivalAt: task.arrivalAt ?? null,
    meetingNotes: task.meetingNotes ?? null,
    meetingNotesUpdatedAt: task.meetingNotesUpdatedAt ?? null,
    departureAt: task.departureAt ?? null,
    visitDepartureNotes: task.visitDepartureNotes ?? null,
    visitDepartureNotesUpdatedAt: task.visitDepartureNotesUpdatedAt ?? null,
    autoCaptureRecordingActive: Boolean(task.autoCaptureRecordingActive),
    autoCaptureRecordingStartedAt: task.autoCaptureRecordingStartedAt ?? null,
    autoCaptureRecordingStoppedAt: task.autoCaptureRecordingStoppedAt ?? null,
    autoCaptureConversationId: task.autoCaptureConversationId ?? null,
  };
}

function mapVisitNoteRowToTask(row: Record<string, unknown>): Task {
  return {
    id: normalizeWhitespace(String(row.id || "")),
    companyId: normalizeWhitespace(String(row.company_id || "")) || undefined,
    title: normalizeWhitespace(String(row.title || "Visit")),
    description: String(row.description || "Field visit"),
    taskType: row.task_type === "field_visit" ? "field_visit" : "general",
    assignedTo: normalizeWhitespace(String(row.assigned_to_id || "")),
    assignedToName: normalizeWhitespace(String(row.assigned_to_name || "")),
    assignedBy: normalizeWhitespace(String(row.assigned_by_id || "")),
    teamId: null,
    teamName: null,
    status:
      row.status === "completed" || row.status === "in_progress" || row.status === "pending"
        ? row.status
        : "pending",
    priority:
      row.priority === "low" || row.priority === "medium" || row.priority === "high"
        ? row.priority
        : "medium",
    dueDate: fromMySqlDateTime(row.due_date) || fromMySqlDateTime(row.created_at) || new Date().toISOString(),
    createdAt: fromMySqlDateTime(row.created_at) || new Date().toISOString(),
    visitPlanDate: fromMySqlDateTime(row.visit_plan_date),
    visitSequence:
      typeof row.visit_sequence === "number"
        ? row.visit_sequence
        : Number.isFinite(Number(row.visit_sequence))
          ? Number(row.visit_sequence)
          : null,
    visitLatitude:
      typeof row.visit_latitude === "number"
        ? row.visit_latitude
        : Number.isFinite(Number(row.visit_latitude))
          ? Number(row.visit_latitude)
          : null,
    visitLongitude:
      typeof row.visit_longitude === "number"
        ? row.visit_longitude
        : Number.isFinite(Number(row.visit_longitude))
          ? Number(row.visit_longitude)
          : null,
    visitLocationLabel: row.visit_location_label ? String(row.visit_location_label) : null,
    visitLocationAddress: row.visit_location_address ? String(row.visit_location_address) : null,
    arrivalAt: fromMySqlDateTime(row.arrival_at),
    meetingNotes: row.meeting_notes ? String(row.meeting_notes) : null,
    meetingNotesUpdatedAt: fromMySqlDateTime(row.meeting_notes_updated_at),
    departureAt: fromMySqlDateTime(row.departure_at),
    visitDepartureNotes: row.visit_departure_notes ? String(row.visit_departure_notes) : null,
    visitDepartureNotesUpdatedAt: fromMySqlDateTime(row.visit_departure_notes_updated_at),
    autoCaptureRecordingActive: false,
    autoCaptureRecordingStartedAt: null,
    autoCaptureRecordingStoppedAt: null,
    autoCaptureConversationId: row.auto_capture_conversation_id
      ? String(row.auto_capture_conversation_id)
      : null,
  };
}

function getVisitHistoryLabel(task: Task): string {
  return (
    normalizeWhitespace(task.visitLocationLabel || "") ||
    normalizeWhitespace(task.title || "") ||
    "Visit"
  );
}

function mapVisitHistoryRow(row: Record<string, unknown>): VisitHistoryRecord {
  const visitLatitude =
    typeof row.visit_latitude === "number"
      ? row.visit_latitude
      : Number.isFinite(Number(row.visit_latitude))
        ? Number(row.visit_latitude)
        : 0;
  const visitLongitude =
    typeof row.visit_longitude === "number"
      ? row.visit_longitude
      : Number.isFinite(Number(row.visit_longitude))
        ? Number(row.visit_longitude)
        : 0;
  const distanceMeters =
    typeof row.distance_meters === "number"
      ? row.distance_meters
      : Number.isFinite(Number(row.distance_meters))
        ? Number(row.distance_meters)
        : null;
  return {
    id: String(row.task_id || row.id || ""),
    companyId: normalizeWhitespace(String(row.company_id || "")) || null,
    taskId: String(row.task_id || ""),
    salespersonId: normalizeWhitespace(String(row.salesperson_id || "")),
    salespersonName: normalizeWhitespace(String(row.salesperson_name || "")),
    visitLabel: normalizeWhitespace(String(row.visit_label || "")) || "Visit",
    visitLocationAddress: row.visit_location_address ? String(row.visit_location_address) : null,
    visitLatitude,
    visitLongitude,
    arrivalAt: fromMySqlDateTime(row.arrival_at),
    departureAt: fromMySqlDateTime(row.departure_at),
    meetingNotes: row.meeting_notes ? String(row.meeting_notes) : null,
    visitDepartureNotes: row.visit_departure_notes ? String(row.visit_departure_notes) : null,
    autoCaptureConversationId: row.auto_capture_conversation_id
      ? String(row.auto_capture_conversation_id)
      : null,
    status: normalizeWhitespace(String(row.status || "")) as VisitHistoryRecord["status"],
    updatedAt:
      fromMySqlDateTime(row.updated_at) ||
      fromMySqlDateTime(row.source_updated_at) ||
      fromMySqlDateTime(row.departure_at) ||
      new Date().toISOString(),
    distanceMeters:
      typeof distanceMeters === "number" && Number.isFinite(distanceMeters)
        ? Math.round(distanceMeters)
        : null,
  };
}

async function upsertVisitHistoryInMySql(
  conn: Pool,
  task: Task,
  companyId: string | null
): Promise<void> {
  if (
    typeof task.visitLatitude !== "number" ||
    !Number.isFinite(task.visitLatitude) ||
    typeof task.visitLongitude !== "number" ||
    !Number.isFinite(task.visitLongitude)
  ) {
    return;
  }

  await conn.execute(
    `INSERT INTO lff_visit_history (
      company_id,
      task_id,
      salesperson_id,
      salesperson_name,
      visit_label,
      visit_location_address,
      visit_latitude,
      visit_longitude,
      arrival_at,
      departure_at,
      meeting_notes,
      visit_departure_notes,
      auto_capture_conversation_id,
      status,
      source_created_at,
      source_updated_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      company_id = VALUES(company_id),
      salesperson_id = VALUES(salesperson_id),
      salesperson_name = VALUES(salesperson_name),
      visit_label = VALUES(visit_label),
      visit_location_address = VALUES(visit_location_address),
      visit_latitude = VALUES(visit_latitude),
      visit_longitude = VALUES(visit_longitude),
      arrival_at = VALUES(arrival_at),
      departure_at = VALUES(departure_at),
      meeting_notes = VALUES(meeting_notes),
      visit_departure_notes = VALUES(visit_departure_notes),
      auto_capture_conversation_id = VALUES(auto_capture_conversation_id),
      status = VALUES(status),
      source_created_at = VALUES(source_created_at),
      source_updated_at = NOW(),
      updated_at = NOW()`,
    [
      companyId,
      task.id,
      task.assignedTo,
      task.assignedToName,
      getVisitHistoryLabel(task),
      task.visitLocationAddress ?? null,
      task.visitLatitude,
      task.visitLongitude,
      toMySqlDateTime(task.arrivalAt),
      toMySqlDateTime(task.departureAt),
      task.meetingNotes ?? null,
      task.visitDepartureNotes ?? null,
      task.autoCaptureConversationId ?? null,
      task.status,
      toMySqlDateTime(task.createdAt),
    ]
  );
}

async function ensureConversationsTable(): Promise<void> {
  if (conversationsTableEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS lff_conversations (
      id VARCHAR(64) NOT NULL,
      company_id VARCHAR(64) NULL,
      salesperson_id VARCHAR(64) NOT NULL,
      salesperson_name VARCHAR(191) NOT NULL,
      customer_name VARCHAR(191) NOT NULL,
      conversation_date DATETIME NOT NULL,
      duration VARCHAR(32) NOT NULL,
      transcript LONGTEXT NULL,
      transcript_status VARCHAR(32) NULL,
      audio_uri LONGTEXT NULL,
      transcription_error LONGTEXT NULL,
      source VARCHAR(32) NULL,
      analysis_provider VARCHAR(32) NULL,
      interest_score INT NOT NULL DEFAULT 0,
      pitch_score INT NOT NULL DEFAULT 0,
      confidence_score INT NOT NULL DEFAULT 0,
      talk_listen_ratio DECIMAL(8,2) NOT NULL DEFAULT 0,
      sentiment VARCHAR(16) NULL,
      buying_intent VARCHAR(16) NULL,
      objections_json LONGTEXT NULL,
      improvements_json LONGTEXT NULL,
      summary LONGTEXT NULL,
      notes LONGTEXT NULL,
      key_phrases_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_lff_conversations_company_date (company_id, conversation_date),
      KEY idx_lff_conversations_salesperson_date (salesperson_id, conversation_date),
      KEY idx_lff_conversations_company_salesperson_date (company_id, salesperson_id, conversation_date)
    )
  `);
  await conn.execute(`
    ALTER TABLE lff_conversations
      ADD COLUMN IF NOT EXISTS company_id VARCHAR(64) NULL AFTER id,
      ADD COLUMN IF NOT EXISTS salesperson_id VARCHAR(64) NOT NULL DEFAULT '' AFTER company_id,
      ADD COLUMN IF NOT EXISTS salesperson_name VARCHAR(191) NOT NULL DEFAULT 'Sales Rep' AFTER salesperson_id,
      ADD COLUMN IF NOT EXISTS customer_name VARCHAR(191) NOT NULL DEFAULT 'Customer' AFTER salesperson_name,
      ADD COLUMN IF NOT EXISTS conversation_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER customer_name,
      ADD COLUMN IF NOT EXISTS duration VARCHAR(32) NOT NULL DEFAULT '00:00' AFTER conversation_date,
      ADD COLUMN IF NOT EXISTS transcript LONGTEXT NULL AFTER duration,
      ADD COLUMN IF NOT EXISTS transcript_status VARCHAR(32) NULL AFTER transcript,
      ADD COLUMN IF NOT EXISTS audio_uri LONGTEXT NULL AFTER transcript_status,
      ADD COLUMN IF NOT EXISTS transcription_error LONGTEXT NULL AFTER audio_uri,
      ADD COLUMN IF NOT EXISTS source VARCHAR(32) NULL AFTER transcription_error,
      ADD COLUMN IF NOT EXISTS analysis_provider VARCHAR(32) NULL AFTER source,
      ADD COLUMN IF NOT EXISTS interest_score INT NOT NULL DEFAULT 0 AFTER analysis_provider,
      ADD COLUMN IF NOT EXISTS pitch_score INT NOT NULL DEFAULT 0 AFTER interest_score,
      ADD COLUMN IF NOT EXISTS confidence_score INT NOT NULL DEFAULT 0 AFTER pitch_score,
      ADD COLUMN IF NOT EXISTS talk_listen_ratio DECIMAL(8,2) NOT NULL DEFAULT 0 AFTER confidence_score,
      ADD COLUMN IF NOT EXISTS sentiment VARCHAR(16) NULL AFTER talk_listen_ratio,
      ADD COLUMN IF NOT EXISTS buying_intent VARCHAR(16) NULL AFTER sentiment,
      ADD COLUMN IF NOT EXISTS objections_json LONGTEXT NULL AFTER buying_intent,
      ADD COLUMN IF NOT EXISTS improvements_json LONGTEXT NULL AFTER objections_json,
      ADD COLUMN IF NOT EXISTS summary LONGTEXT NULL AFTER improvements_json,
      ADD COLUMN IF NOT EXISTS notes LONGTEXT NULL AFTER summary,
      ADD COLUMN IF NOT EXISTS key_phrases_json LONGTEXT NULL AFTER notes,
      ADD COLUMN IF NOT EXISTS created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER key_phrases_json,
      ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at
  `);
  try {
    await conn.execute(`
      ALTER TABLE lff_conversations
        MODIFY COLUMN transcript LONGTEXT NULL
    `);
  } catch {
    // keep conversation table bootstrap resilient across MySQL variants
  }
  conversationsTableEnsured = true;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeConversationStatus(
  value: unknown,
  fallback: Conversation["transcriptStatus"] = "completed"
): Conversation["transcriptStatus"] {
  if (value === "pending" || value === "completed" || value === "failed") {
    return value;
  }
  return fallback;
}

function normalizeConversationProvider(
  value: unknown,
  fallback: Conversation["analysisProvider"] = "rules"
): Conversation["analysisProvider"] {
  if (value === "seed" || value === "rules" || value === "ai") {
    return value;
  }
  return fallback;
}

function normalizeConversationSource(
  value: unknown,
  fallback: Conversation["source"] = "recorded"
): Conversation["source"] {
  if (value === "seed" || value === "recorded" || value === "imported") {
    return value;
  }
  return fallback;
}

function normalizeConversationSentiment(
  value: unknown,
  fallback: Conversation["sentiment"] = "neutral"
): Conversation["sentiment"] {
  if (value === "positive" || value === "neutral" || value === "negative") {
    return value;
  }
  return fallback;
}

function normalizeConversationBuyingIntent(
  value: unknown,
  fallback: Conversation["buyingIntent"] = "medium"
): Conversation["buyingIntent"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return fallback;
}

function normalizeConversationScore(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeTalkListenRatio(value: unknown, fallback = 0): number {
  const parsed =
    typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed * 100) / 100);
}

function normalizeConversationPayload(
  payload: Partial<Conversation>,
  fallbackUser?: AppUser | null,
  base?: Conversation | null
): Conversation {
  const nowIso = new Date().toISOString();
  const resolvedDate =
    normalizeOptionalText(payload.date) ||
    normalizeOptionalText(base?.date) ||
    nowIso;
  return {
    id:
      normalizeWhitespace(String(payload.id ?? base?.id ?? "")) ||
      `conv_${Date.now()}_${randomUUID().slice(0, 8)}`,
    companyId:
      normalizeWhitespace(String(payload.companyId ?? base?.companyId ?? "")) ||
      fallbackUser?.companyId ||
      undefined,
    salespersonId:
      normalizeWhitespace(String(payload.salespersonId ?? base?.salespersonId ?? "")) ||
      fallbackUser?.id ||
      "",
    salespersonName:
      normalizeWhitespace(String(payload.salespersonName ?? base?.salespersonName ?? "")) ||
      normalizeWhitespace(fallbackUser?.name || "") ||
      "Sales Rep",
    customerName:
      normalizeWhitespace(String(payload.customerName ?? base?.customerName ?? "")) ||
      "Customer",
    date: resolvedDate,
    duration:
      normalizeWhitespace(String(payload.duration ?? base?.duration ?? "")) ||
      "00:00",
    transcript:
      normalizeOptionalText(payload.transcript) ??
      normalizeOptionalText(base?.transcript) ??
      "",
    transcriptStatus: normalizeConversationStatus(
      payload.transcriptStatus,
      normalizeConversationStatus(base?.transcriptStatus)
    ),
    audioUri:
      normalizeOptionalText(payload.audioUri) ??
      normalizeOptionalText(base?.audioUri) ??
      null,
    transcriptionError:
      normalizeOptionalText(payload.transcriptionError) ??
      normalizeOptionalText(base?.transcriptionError) ??
      null,
    source: normalizeConversationSource(
      payload.source,
      normalizeConversationSource(base?.source)
    ),
    analysisProvider: normalizeConversationProvider(
      payload.analysisProvider,
      normalizeConversationProvider(base?.analysisProvider)
    ),
    interestScore: normalizeConversationScore(
      payload.interestScore,
      normalizeConversationScore(base?.interestScore)
    ),
    pitchScore: normalizeConversationScore(
      payload.pitchScore,
      normalizeConversationScore(base?.pitchScore)
    ),
    confidenceScore: normalizeConversationScore(
      payload.confidenceScore,
      normalizeConversationScore(base?.confidenceScore)
    ),
    talkListenRatio: normalizeTalkListenRatio(
      payload.talkListenRatio,
      normalizeTalkListenRatio(base?.talkListenRatio)
    ),
    sentiment: normalizeConversationSentiment(
      payload.sentiment,
      normalizeConversationSentiment(base?.sentiment)
    ),
    buyingIntent: normalizeConversationBuyingIntent(
      payload.buyingIntent,
      normalizeConversationBuyingIntent(base?.buyingIntent)
    ),
    objections: parseStringArrayJson(payload.objections ?? base?.objections ?? []),
    improvements: parseStringArrayJson(payload.improvements ?? base?.improvements ?? []),
    summary:
      normalizeOptionalText(payload.summary) ??
      normalizeOptionalText(base?.summary) ??
      "",
    notes:
      normalizeOptionalText(payload.notes) ??
      normalizeOptionalText(base?.notes) ??
      undefined,
    keyPhrases: parseStringArrayJson(payload.keyPhrases ?? base?.keyPhrases ?? []),
  };
}

function mapConversationRow(row: Record<string, unknown>): Conversation {
  return {
    id: normalizeWhitespace(String(row.id || "")),
    companyId: normalizeWhitespace(String(row.company_id || "")) || undefined,
    salespersonId: normalizeWhitespace(String(row.salesperson_id || "")),
    salespersonName: toRequiredText(row.salesperson_name, "Sales Rep"),
    customerName: toRequiredText(row.customer_name, "Customer"),
    date:
      fromMySqlDateTime(row.conversation_date) ||
      fromMySqlDateTime(row.created_at) ||
      new Date().toISOString(),
    duration: toRequiredText(row.duration, "00:00"),
    transcript: row.transcript ? String(row.transcript) : "",
    transcriptStatus: normalizeConversationStatus(row.transcript_status),
    audioUri: row.audio_uri ? String(row.audio_uri) : null,
    transcriptionError: row.transcription_error ? String(row.transcription_error) : null,
    source: normalizeConversationSource(row.source),
    analysisProvider: normalizeConversationProvider(row.analysis_provider),
    interestScore: normalizeConversationScore(row.interest_score),
    pitchScore: normalizeConversationScore(row.pitch_score),
    confidenceScore: normalizeConversationScore(row.confidence_score),
    talkListenRatio: normalizeTalkListenRatio(row.talk_listen_ratio),
    sentiment: normalizeConversationSentiment(row.sentiment),
    buyingIntent: normalizeConversationBuyingIntent(row.buying_intent),
    objections: parseStringArrayJson(row.objections_json),
    improvements: parseStringArrayJson(row.improvements_json),
    summary: row.summary ? String(row.summary) : "",
    notes: row.notes ? String(row.notes) : undefined,
    keyPhrases: parseStringArrayJson(row.key_phrases_json),
  };
}

function isLegacyDemoConversation(conversation: Conversation): boolean {
  return (
    isLegacyDemoProfileName(conversation.salespersonName) ||
    isLegacyDemoProfileName(conversation.customerName)
  );
}

async function listConversationsFromMySql(options: {
  companyId?: string | null;
  salespersonId?: string | null;
  limit?: number | null;
}): Promise<Conversation[]> {
  await ensureConversationsTable();
  const conn = await getMySqlPool();
  const filters: string[] = [];
  const params: unknown[] = [];
  if (options.companyId) {
    filters.push("company_id = ?");
    params.push(options.companyId);
  }
  if (options.salespersonId) {
    filters.push("salesperson_id = ?");
    params.push(options.salespersonId);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limitClause =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? `LIMIT ${Math.max(1, Math.min(500, Math.trunc(options.limit)))}`
      : "";
  const [rows] = await conn.query<any[]>(
    `SELECT
      id,
      company_id,
      salesperson_id,
      salesperson_name,
      customer_name,
      conversation_date,
      duration,
      transcript,
      transcript_status,
      audio_uri,
      transcription_error,
      source,
      analysis_provider,
      interest_score,
      pitch_score,
      confidence_score,
      talk_listen_ratio,
      sentiment,
      buying_intent,
      objections_json,
      improvements_json,
      summary,
      notes,
      key_phrases_json,
      created_at,
      updated_at
    FROM lff_conversations
    ${whereClause}
    ORDER BY conversation_date DESC, updated_at DESC
    ${limitClause}`,
    params
  );
  return (rows || []).map(mapConversationRow).filter((conversation) => !isLegacyDemoConversation(conversation));
}

async function getConversationByIdFromMySql(
  conversationId: string,
  options: {
    companyId?: string | null;
    salespersonId?: string | null;
  }
): Promise<Conversation | null> {
  await ensureConversationsTable();
  const conn = await getMySqlPool();
  const filters = ["id = ?"];
  const params: unknown[] = [conversationId];
  if (options.companyId) {
    filters.push("company_id = ?");
    params.push(options.companyId);
  }
  if (options.salespersonId) {
    filters.push("salesperson_id = ?");
    params.push(options.salespersonId);
  }
  const [rows] = await conn.query<any[]>(
    `SELECT
      id,
      company_id,
      salesperson_id,
      salesperson_name,
      customer_name,
      conversation_date,
      duration,
      transcript,
      transcript_status,
      audio_uri,
      transcription_error,
      source,
      analysis_provider,
      interest_score,
      pitch_score,
      confidence_score,
      talk_listen_ratio,
      sentiment,
      buying_intent,
      objections_json,
      improvements_json,
      summary,
      notes,
      key_phrases_json,
      created_at,
      updated_at
    FROM lff_conversations
    WHERE ${filters.join(" AND ")}
    LIMIT 1`,
    params
  );
  if (!rows?.length) return null;
  return mapConversationRow(rows[0]);
}

async function upsertConversationInMySql(
  conn: Pool,
  conversation: Conversation,
  companyId: string | null
): Promise<void> {
  const safeTranscript = normalizeOptionalText(conversation.transcript) ?? "";
  await conn.execute(
    `INSERT INTO lff_conversations (
      id,
      company_id,
      salesperson_id,
      salesperson_name,
      customer_name,
      conversation_date,
      duration,
      transcript,
      transcript_status,
      audio_uri,
      transcription_error,
      source,
      analysis_provider,
      interest_score,
      pitch_score,
      confidence_score,
      talk_listen_ratio,
      sentiment,
      buying_intent,
      objections_json,
      improvements_json,
      summary,
      notes,
      key_phrases_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      company_id = VALUES(company_id),
      salesperson_id = VALUES(salesperson_id),
      salesperson_name = VALUES(salesperson_name),
      customer_name = VALUES(customer_name),
      conversation_date = VALUES(conversation_date),
      duration = VALUES(duration),
      transcript = VALUES(transcript),
      transcript_status = VALUES(transcript_status),
      audio_uri = VALUES(audio_uri),
      transcription_error = VALUES(transcription_error),
      source = VALUES(source),
      analysis_provider = VALUES(analysis_provider),
      interest_score = VALUES(interest_score),
      pitch_score = VALUES(pitch_score),
      confidence_score = VALUES(confidence_score),
      talk_listen_ratio = VALUES(talk_listen_ratio),
      sentiment = VALUES(sentiment),
      buying_intent = VALUES(buying_intent),
      objections_json = VALUES(objections_json),
      improvements_json = VALUES(improvements_json),
      summary = VALUES(summary),
      notes = VALUES(notes),
      key_phrases_json = VALUES(key_phrases_json),
      updated_at = NOW()`,
    [
      conversation.id,
      companyId,
      conversation.salespersonId,
      conversation.salespersonName,
      conversation.customerName,
      toMySqlDateTime(conversation.date) || new Date().toISOString().slice(0, 19).replace("T", " "),
      conversation.duration,
      safeTranscript,
      conversation.transcriptStatus ?? null,
      conversation.audioUri ?? null,
      conversation.transcriptionError ?? null,
      conversation.source ?? null,
      conversation.analysisProvider ?? null,
      conversation.interestScore,
      conversation.pitchScore,
      conversation.confidenceScore,
      conversation.talkListenRatio,
      conversation.sentiment,
      conversation.buyingIntent,
      JSON.stringify(conversation.objections || []),
      JSON.stringify(conversation.improvements || []),
      conversation.summary ?? "",
      conversation.notes ?? null,
      JSON.stringify(conversation.keyPhrases || []),
    ]
  );
}

async function migrateLegacyConversationsStateToMySql(): Promise<void> {
  if (legacyConversationsMigrated) return;
  if (!isMySqlStateEnabled()) return;
  if (legacyConversationsMigrationPromise) {
    await legacyConversationsMigrationPromise;
    return;
  }
  legacyConversationsMigrationPromise = migrateLegacyConversationsStateToMySqlOnce().finally(() => {
    legacyConversationsMigrationPromise = null;
  });
  await legacyConversationsMigrationPromise;
}

async function migrateLegacyConversationsStateToMySqlOnce(): Promise<void> {
  if (legacyConversationsMigrated) return;
  await ensureConversationsTable();
  let raw: string | null = null;
  try {
    raw = await getMySqlStateValue("@trackforce_conversations");
  } catch {
    raw = null;
  }
  if (!raw) {
    legacyConversationsMigrated = true;
    return;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    legacyConversationsMigrated = true;
    return;
  }
  const conn = await getMySqlPool();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const normalized = normalizeConversationPayload(entry as Partial<Conversation>, null);
    if (!normalized.salespersonId) continue;
    if (isLegacyDemoConversation(normalized)) continue;
    await upsertConversationInMySql(conn, normalized, normalized.companyId ?? null);
  }
  legacyConversationsMigrated = true;
}

async function mergeConversationsInMySql(entries: unknown[]): Promise<void> {
  await ensureConversationsTable();
  const conn = await getMySqlPool();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const normalized = normalizeConversationPayload(entry as Partial<Conversation>, null);
    if (!normalized.id || !normalized.salespersonId) continue;
    if (isLegacyDemoConversation(normalized)) continue;
    await upsertConversationInMySql(conn, normalized, normalized.companyId ?? null);
  }
}

async function insertAccessRequestInMySql(entry: AccessRequestRecord): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureAccessRequestAssignmentColumns();
  const conn = await getMySqlPool();
  try {
    await conn.execute(
      `INSERT INTO lff_access_requests (
        id, name, email, requested_role, approved_role, requested_department, requested_branch,
        requested_company_name, status, requested_at, reviewed_at, reviewed_by_id, reviewed_by_name,
        review_comment, assigned_company_ids_json, assigned_manager_id, assigned_manager_name,
        assigned_stockist_id, assigned_stockist_name, password_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        assigned_stockist_id = VALUES(assigned_stockist_id),
        assigned_stockist_name = VALUES(assigned_stockist_name),
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
        entry.assignedStockistId ?? null,
        entry.assignedStockistName ?? null,
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
        review_comment, assigned_company_ids_json, assigned_manager_id, assigned_manager_name,
        assigned_stockist_id, assigned_stockist_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        assigned_stockist_id = VALUES(assigned_stockist_id),
        assigned_stockist_name = VALUES(assigned_stockist_name)`,
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
        entry.assignedStockistId ?? null,
        entry.assignedStockistName ?? null,
      ]
    );
  }
}

async function listAccessRequestsFromMySql(
  status: UserAccessRequest["status"] | null
): Promise<AccessRequestRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAccessRequestAssignmentColumns();
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
    assignedStockistId: row.assigned_stockist_id ? String(row.assigned_stockist_id) : null,
    assignedStockistName: row.assigned_stockist_name ? String(row.assigned_stockist_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  }));
}

async function getAccessRequestByIdFromMySql(id: string): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureAccessRequestAssignmentColumns();
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
    assignedStockistId: row.assigned_stockist_id ? String(row.assigned_stockist_id) : null,
    assignedStockistName: row.assigned_stockist_name ? String(row.assigned_stockist_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isLegacyDemoProfileName(value: string | null | undefined): boolean {
  return LEGACY_DEMO_PROFILE_NAMES.has(normalizeWhitespace(value || "").toLowerCase());
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

async function isDolibarrSuperuserReviewer(req: Request): Promise<boolean> {
  if (req.auth?.role !== "admin") return false;
  const reviewerEmail = normalizeEmailKey(req.auth?.email);
  if (reviewerEmail && ENV_DOLIBARR_SUPERUSER_EMAILS.includes(reviewerEmail)) {
    return true;
  }
  if (!isMySqlStateEnabled()) {
    // Fallback for non-MySQL mode: only app-admin can continue.
    return req.auth?.role === "admin";
  }

  const reviewerLogin = normalizeLoginKey(
    reviewerEmail.includes("@") ? reviewerEmail.split("@")[0] || reviewerEmail : reviewerEmail
  );
  if (!reviewerEmail && !reviewerLogin) return false;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT rowid, login, admin
     FROM nmy5_user
     WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(login)) = ?
     LIMIT 1`,
    [reviewerEmail, reviewerLogin]
  );
  if (!rows || rows.length === 0) return false;
  const row = rows[0];
  const isAdmin = Number(row?.admin || 0) === 1;
  const login = normalizeLoginKey(String(row?.login || ""));
  const rowId = Number(row?.rowid || 0);
  // Treat true Dolibarr superuser as either primary admin row or canonical "admin" login.
  return isAdmin && (rowId === 1 || login === "admin");
}

async function forceDolibarrAdminPrivilegesForUserIdentity(user: AppUser): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const email = normalizeEmailKey(user.email);
  const login = normalizeLoginKey(user.login || buildLoginFromEmailAndName(email, user.name));
  if (!email && !login) return;

  const conn = await getMySqlPool();
  await conn.execute(
    `UPDATE nmy5_user
     SET admin = 1, employee = 0, statut = 1, tms = NOW()
     WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(login)) = ?`,
    [email, login]
  );

  try {
    await grantDolibarrAllPermissions(user);
  } catch (error) {
    console.warn("Dolibarr admin rights grant failed", error);
  }
}

async function grantDolibarrAllPermissions(user: AppUser): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const email = normalizeEmailKey(user.email);
  const login = normalizeLoginKey(user.login || buildLoginFromEmailAndName(email, user.name));
  if (!email && !login) return;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT rowid, entity
     FROM nmy5_user
     WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(login)) = ?
     LIMIT 1`,
    [email, login]
  );
  if (!rows || rows.length === 0) return;
  const row = rows[0];
  const userId = Number(row?.rowid || 0);
  if (!userId) return;
  const entity = Number.isFinite(Number(row?.entity))
    ? Number(row?.entity)
    : 1;

  await conn.execute(
    `INSERT IGNORE INTO nmy5_user_rights (entity, fk_user, fk_id)
     SELECT rd.entity, ?, rd.id
     FROM nmy5_rights_def rd
     WHERE rd.entity IN (0, ?)`,
    [userId, entity]
  );
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

function parseStringArrayJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => normalizeWhitespace(entry))
          .filter(Boolean)
      )
    );
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return parseStringArrayJson(parsed);
  } catch {
    return [];
  }
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

async function mergeApprovedAccessRequestIntoUser(
  user: AppUser,
  request: AccessRequestRecord | null
): Promise<AppUser> {
  if (!request || request.status !== "approved") return user;
  const mergedRole = normalizeRole(user.role || request.approvedRole || request.requestedRole);
  const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
  const existingCompanyIds = normalizeCompanyIds(user.companyIds);
  const selectedCompaniesById = await getCompanyProfilesByIds(assignedCompanyIds);
  const selectedPrimaryCompany = assignedCompanyIds[0]
    ? selectedCompaniesById.get(assignedCompanyIds[0]) || null
    : null;
  const mergedCompanyId =
    assignedCompanyIds[0] ||
    normalizeWhitespace(user.companyId || "") ||
    DEFAULT_COMPANY_ID;
  const mergedCompanyName =
    selectedPrimaryCompany?.name ||
    normalizeWhitespace(user.companyName || "") ||
    DEFAULT_COMPANY_NAME;
  const mergedCompanyIds =
    assignedCompanyIds.length > 0
      ? assignedCompanyIds
      : existingCompanyIds.length > 0
        ? existingCompanyIds
        : [mergedCompanyId];
  const isSalesperson = isSalesRole(mergedRole);

  return {
    ...user,
    role: mergedRole,
    companyId: mergedCompanyId,
    companyName: mergedCompanyName,
    companyIds: mergedCompanyIds,
    department: normalizeDepartmentForRole(
      mergedRole,
      request.requestedDepartment || user.department
    ),
    branch:
      normalizeWhitespace(request.requestedBranch || "") ||
      normalizeWhitespace(user.branch || "") ||
      selectedPrimaryCompany?.primaryBranch ||
      "Main Branch",
    managerId: isSalesperson
      ? undefined
      : request.assignedManagerId || user.managerId || undefined,
    managerName: isSalesperson
      ? undefined
      : request.assignedManagerName || user.managerName || undefined,
    stockistId: isSalesperson
      ? request.assignedStockistId || user.stockistId || undefined
      : undefined,
    stockistName: isSalesperson
      ? request.assignedStockistName || user.stockistName || undefined
      : undefined,
    approvalStatus: "approved",
  };
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

let attendanceTableEnsured = false;
let attendanceLegacyStateHydrated = false;
let locationLogLegacyStateHydrated = false;
let locationLogIndexesEnsured = false;
let routeDailySummaryTableEnsured = false;
let lastLocationLogPruneAt = 0;
let geofenceTableEnsured = false;

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

const LOCATION_LOG_RETENTION_DAYS = readPositiveIntegerEnv("LOCATION_LOG_RETENTION_DAYS", 14);
const LOCATION_LOG_MAX_ROWS = readPositiveIntegerEnv("LOCATION_LOG_MAX_ROWS", 50000);
const LOCATION_LOG_PRUNE_INTERVAL_MS = readPositiveIntegerEnv(
  "LOCATION_LOG_PRUNE_INTERVAL_MS",
  60 * 60 * 1000
);

async function ensureMySqlIndex(
  tableName: string,
  indexName: string,
  columns: string[]
): Promise<void> {
  if (!isMySqlStateEnabled() || !columns.length) return;
  try {
    const conn = await getMySqlPool();
    const [rows] = await conn.query<any[]>(
      `SHOW INDEX FROM \`${tableName}\` WHERE Key_name = ?`,
      [indexName]
    );
    if (rows && rows.length > 0) return;
    const columnList = columns.map((column) => `\`${column}\``).join(", ");
    await conn.execute(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columnList})`);
  } catch (error) {
    console.warn(
      `Unable to ensure MySQL index ${indexName} on ${tableName}:`,
      error instanceof Error ? error.message : error
    );
  }
}

async function ensureLocationLogIndexes(): Promise<void> {
  if (locationLogIndexesEnsured || !isMySqlStateEnabled()) return;
  await ensureMySqlIndex("lff_location_logs", "idx_lff_location_user_captured", [
    "user_id",
    "captured_at",
  ]);
  await ensureMySqlIndex("lff_location_logs", "idx_lff_location_captured_user", [
    "captured_at",
    "user_id",
  ]);
  locationLogIndexesEnsured = true;
}

async function pruneLocationLogsIfNeeded(force = false): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const now = Date.now();
  if (!force && now - lastLocationLogPruneAt < LOCATION_LOG_PRUNE_INTERVAL_MS) return;
  lastLocationLogPruneAt = now;

  try {
    await ensureLocationLogIndexes();
    const conn = await getMySqlPool();
    const retentionCutoff = new Date(now - LOCATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const [staleRouteRows] = await conn.query<any[]>(
      `SELECT DISTINCT user_id, DATE_FORMAT(CONVERT_TZ(captured_at, '+00:00', '+05:30'), '%Y-%m-%d') AS route_date
       FROM lff_location_logs
       WHERE captured_at < ?
       ORDER BY route_date ASC
       LIMIT 500`,
      [retentionCutoff]
    );
    for (const row of staleRouteRows ?? []) {
      const userId = row.user_id ? String(row.user_id) : "";
      const routeDate = row.route_date ? toSqlDateOnly(row.route_date) : "";
      if (!userId || !isIsoDateString(routeDate)) continue;
      await summarizeRawRouteDateForMySql(userId, routeDate);
    }
    await conn.execute(
      `DELETE FROM lff_location_logs WHERE captured_at < ?`,
      [retentionCutoff]
    );

    const [countRows] = await conn.query<any[]>(
      `SELECT COUNT(*) AS count FROM lff_location_logs`
    );
    const count = Number(countRows?.[0]?.count ?? 0);
    if (count <= LOCATION_LOG_MAX_ROWS) return;

    const overflow = count - LOCATION_LOG_MAX_ROWS;
    await conn.execute(
      `DELETE FROM lff_location_logs
       ORDER BY captured_at ASC, id ASC
       LIMIT ${Math.max(1, Math.trunc(overflow))}`
    );
  } catch (error) {
    console.warn(
      "Unable to prune location logs:",
      error instanceof Error ? error.message : error
    );
  }
}

type RouteAttendanceSummaryEvent = {
  id: string;
  type: "checkin" | "checkout";
  at: string;
  geofenceName: string | null;
  latitude: number | null;
  longitude: number | null;
};

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function encodePolylineCoordinate(value: number): string {
  let coordinate = value < 0 ? ~(value << 1) : value << 1;
  let encoded = "";
  while (coordinate >= 0x20) {
    encoded += String.fromCharCode((0x20 | (coordinate & 0x1f)) + 63);
    coordinate >>= 5;
  }
  return encoded + String.fromCharCode(coordinate + 63);
}

function encodeLocationPolyline(points: LocationLog[]): string {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = "";
  for (const point of points) {
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
    const lat = Math.round(point.latitude * 100000);
    const lng = Math.round(point.longitude * 100000);
    encoded += encodePolylineCoordinate(lat - previousLat);
    encoded += encodePolylineCoordinate(lng - previousLng);
    previousLat = lat;
    previousLng = lng;
  }
  return encoded;
}

function compressRouteSummaryPoints(points: LocationLog[], maxPoints = 720): LocationLog[] {
  const ordered = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  if (ordered.length <= maxPoints) return ordered;
  const sampled: LocationLog[] = [];
  const lastIndex = ordered.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    const index = Math.round((i / (maxPoints - 1)) * lastIndex);
    const point = ordered[index];
    if (!sampled.length || sampled[sampled.length - 1].id !== point.id) {
      sampled.push(point);
    }
  }
  return sampled;
}

function serializeSummaryPoints(points: LocationLog[]): LocationLog[] {
  return points.map((point) => ({
    id: point.id,
    companyId: point.companyId,
    userId: point.userId,
    latitude: roundCoordinate(point.latitude),
    longitude: roundCoordinate(point.longitude),
    accuracy: point.accuracy ?? null,
    speed: point.speed ?? null,
    heading: point.heading ?? null,
    batteryLevel: point.batteryLevel ?? null,
    geofenceId: point.geofenceId ?? null,
    geofenceName: point.geofenceName ?? null,
    isInsideGeofence: Boolean(point.isInsideGeofence),
    capturedAt: point.capturedAt,
  }));
}

async function ensureRouteDailySummaryTable(): Promise<void> {
  if (routeDailySummaryTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_route_daily_summaries\` (
      \`user_id\` VARCHAR(64) NOT NULL,
      \`route_date\` DATE NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`first_captured_at\` DATETIME NULL,
      \`last_captured_at\` DATETIME NULL,
      \`first_latitude\` DECIMAL(10,7) NULL,
      \`first_longitude\` DECIMAL(10,7) NULL,
      \`last_latitude\` DECIMAL(10,7) NULL,
      \`last_longitude\` DECIMAL(10,7) NULL,
      \`total_distance_km\` DECIMAL(10,2) NOT NULL DEFAULT 0,
      \`total_moving_minutes\` INT NOT NULL DEFAULT 0,
      \`total_halt_minutes\` INT NOT NULL DEFAULT 0,
      \`halt_count\` INT NOT NULL DEFAULT 0,
      \`point_count\` INT NOT NULL DEFAULT 0,
      \`raw_point_count\` INT NOT NULL DEFAULT 0,
      \`encoded_polyline\` LONGTEXT NULL,
      \`points_json\` LONGTEXT NOT NULL,
      \`halts_json\` LONGTEXT NOT NULL,
      \`segments_json\` LONGTEXT NOT NULL,
      \`attendance_events_json\` LONGTEXT NOT NULL,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`user_id\`, \`route_date\`),
      KEY \`idx_lff_route_summary_company_date\` (\`company_id\`, \`route_date\`),
      KEY \`idx_lff_route_summary_date\` (\`route_date\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  routeDailySummaryTableEnsured = true;
}

async function upsertRouteDailySummaryInMySql(
  userId: string,
  dateKey: string,
  timeline: RouteTimeline,
  attendanceEvents: RouteAttendanceSummaryEvent[] = [],
  rawPointCount = timeline.points.length
): Promise<void> {
  if (!isMySqlStateEnabled() || !timeline.points.length) return;
  await ensureRouteDailySummaryTable();
  const conn = await getMySqlPool();
  const orderedPoints = [...timeline.points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const firstPoint = orderedPoints[0];
  const lastPoint = orderedPoints[orderedPoints.length - 1];
  const summaryPoints = serializeSummaryPoints(compressRouteSummaryPoints(orderedPoints));
  await conn.execute(
    `INSERT INTO lff_route_daily_summaries (
      user_id, route_date, company_id, first_captured_at, last_captured_at,
      first_latitude, first_longitude, last_latitude, last_longitude,
      total_distance_km, total_moving_minutes, total_halt_minutes, halt_count,
      point_count, raw_point_count, encoded_polyline, points_json, halts_json,
      segments_json, attendance_events_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
    ON DUPLICATE KEY UPDATE
      company_id = VALUES(company_id),
      first_captured_at = VALUES(first_captured_at),
      last_captured_at = VALUES(last_captured_at),
      first_latitude = VALUES(first_latitude),
      first_longitude = VALUES(first_longitude),
      last_latitude = VALUES(last_latitude),
      last_longitude = VALUES(last_longitude),
      total_distance_km = VALUES(total_distance_km),
      total_moving_minutes = VALUES(total_moving_minutes),
      total_halt_minutes = VALUES(total_halt_minutes),
      halt_count = VALUES(halt_count),
      point_count = VALUES(point_count),
      raw_point_count = VALUES(raw_point_count),
      encoded_polyline = VALUES(encoded_polyline),
      points_json = VALUES(points_json),
      halts_json = VALUES(halts_json),
      segments_json = VALUES(segments_json),
      attendance_events_json = VALUES(attendance_events_json),
      updated_at = NOW()`,
    [
      userId,
      dateKey,
      firstPoint.companyId || null,
      toSqlTimestamp(firstPoint.capturedAt),
      toSqlTimestamp(lastPoint.capturedAt),
      firstPoint.latitude,
      firstPoint.longitude,
      lastPoint.latitude,
      lastPoint.longitude,
      timeline.summary.totalDistanceKm,
      timeline.summary.totalMovingMinutes,
      timeline.summary.totalHaltMinutes,
      timeline.summary.haltCount,
      summaryPoints.length,
      Math.max(rawPointCount, orderedPoints.length),
      encodeLocationPolyline(summaryPoints),
      JSON.stringify(summaryPoints),
      JSON.stringify(timeline.halts ?? []),
      JSON.stringify(timeline.segments ?? []),
      JSON.stringify(attendanceEvents),
    ]
  );
}

async function getRouteDailySummaryFromMySql(
  userId: string,
  dateKey: string
): Promise<(RouteTimeline & { attendanceEvents: RouteAttendanceSummaryEvent[] }) | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureRouteDailySummaryTable();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_route_daily_summaries
     WHERE user_id = ? AND route_date = ?
     LIMIT 1`,
    [userId, dateKey]
  );
  const row = rows?.[0];
  if (!row) return null;
  const points = parseJsonArray<LocationLog>(row.points_json);
  return {
    userId,
    date: dateKey,
    points,
    halts: parseJsonArray(row.halts_json),
    segments: parseJsonArray(row.segments_json),
    summary: {
      totalDistanceKm: Number(row.total_distance_km || 0),
      totalMovingMinutes: Number(row.total_moving_minutes || 0),
      totalHaltMinutes: Number(row.total_halt_minutes || 0),
      haltCount: Number(row.halt_count || 0),
      pointCount: Number(row.point_count || points.length),
      rawPointCount: Number(row.raw_point_count || points.length),
    },
    directions: null,
    encodedPolyline: row.encoded_polyline ? String(row.encoded_polyline) : null,
    source: "daily_summary",
    summaryUpdatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    attendanceEvents: parseJsonArray<RouteAttendanceSummaryEvent>(row.attendance_events_json),
  };
}

async function summarizeRawRouteDateForMySql(userId: string, dateKey: string): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const rawLocationPoints = await listLocationLogsForUserDateFromMySql(userId, dateKey);
  if (!rawLocationPoints.length) return;
  const attendance = await listAttendanceForUserDateFromMySql(userId, dateKey).catch(() => []);
  const attendanceEvents: RouteAttendanceSummaryEvent[] = attendance
    .filter((record) => isMumbaiDateKey(record.timestamp, dateKey))
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
  const windowedPoints = filterLocationLogsToSessionWindow(rawLocationPoints, sessionWindow);
  const points = downsampleLocationLogsByInterval(windowedPoints, 1);
  if (!points.length) return;
  const timeline = buildRouteTimeline(userId, dateKey, points);
  await upsertRouteDailySummaryInMySql(
    userId,
    dateKey,
    { ...timeline, source: "raw_logs" },
    attendanceEvents,
    rawLocationPoints.length
  );
}

function parseAssignedEmployeeIdsJson(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeWhitespace(entry))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function ensureGeofenceTable(): Promise<void> {
  if (geofenceTableEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_geofences\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`name\` VARCHAR(191) NOT NULL,
      \`latitude\` DECIMAL(10,7) NOT NULL,
      \`longitude\` DECIMAL(10,7) NOT NULL,
      \`radius_meters\` INT NOT NULL,
      \`assigned_employee_ids_json\` LONGTEXT NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`allow_override\` TINYINT(1) NOT NULL DEFAULT 0,
      \`working_hours_start\` VARCHAR(8) NULL,
      \`working_hours_end\` VARCHAR(8) NULL,
      \`created_at\` DATETIME NOT NULL,
      \`updated_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_geofences_company\` (\`company_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  geofenceTableEnsured = true;
}

function mapGeofenceRow(row: any): Geofence {
  const now = new Date().toISOString();
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    name: String(row.name || "Unnamed Zone"),
    radiusMeters: Math.max(500, Number(row.radius_meters || 500)),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    assignedEmployeeIds: parseAssignedEmployeeIdsJson(row.assigned_employee_ids_json),
    isActive: row.is_active === null || row.is_active === undefined ? true : Boolean(row.is_active),
    allowOverride: Boolean(row.allow_override),
    workingHoursStart: row.working_hours_start ? String(row.working_hours_start) : null,
    workingHoursEnd: row.working_hours_end ? String(row.working_hours_end) : null,
    createdAt: row.created_at ? toIsoTimestamp(row.created_at, now) : now,
    updatedAt: row.updated_at ? toIsoTimestamp(row.updated_at, now) : now,
  };
}

async function listGeofencesForUserFromMySql(userId: string): Promise<Geofence[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureGeofenceTable();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_geofences
     WHERE is_active = 1
       AND JSON_CONTAINS(assigned_employee_ids_json, JSON_QUOTE(?))
     ORDER BY updated_at DESC`,
    [userId]
  );
  return rows.map(mapGeofenceRow);
}

function isCompanyOfficeGeofence(zone: Geofence, companyId: string | null | undefined): boolean {
  if (!zone.isActive || !companyId) return false;
  if (zone.id === `office_${companyId}`) return true;
  return zone.companyId === companyId && zone.id.startsWith("office_");
}

function mergeGeofencesById(zones: Geofence[]): Geofence[] {
  const byId = new Map<string, Geofence>();
  for (const zone of zones) {
    byId.set(zone.id, zone);
  }
  return Array.from(byId.values());
}

async function listCompanyOfficeGeofencesFromMySql(companyId: string | null | undefined): Promise<Geofence[]> {
  if (!isMySqlStateEnabled() || !companyId) return [];
  await ensureGeofenceTable();
  const conn = await getMySqlPool();
  const officeId = `office_${companyId}`;
  const [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_geofences
     WHERE is_active = 1
       AND company_id = ?
       AND (id = ? OR LEFT(id, 7) = 'office_')
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, updated_at DESC`,
    [companyId, officeId, officeId]
  );
  return rows.map(mapGeofenceRow);
}

async function listGeofencesForUserResolved(
  userId: string,
  options: { companyId?: string | null; role?: UserRole | null } = {}
): Promise<Geofence[]> {
  const includeCompanyOffice = options.role === "employee" && Boolean(options.companyId);
  if (isMySqlStateEnabled()) {
    try {
      const zones = await listGeofencesForUserFromMySql(userId);
      if (includeCompanyOffice) {
        const officeZones = await listCompanyOfficeGeofencesFromMySql(options.companyId);
        const merged = mergeGeofencesById([...zones, ...officeZones]);
        if (merged.length) return merged;
      }
      if (zones.length) return zones;
    } catch (error) {
      console.warn(
        "Unable to read geofences from MySQL:",
        error instanceof Error ? error.message : error
      );
    }
  }
  const zones = await storage.listGeofencesForUser(userId);
  if (!includeCompanyOffice) return zones;
  const allZones = await storage.listGeofences();
  const officeZones = allZones.filter((zone) => isCompanyOfficeGeofence(zone, options.companyId));
  return mergeGeofencesById([...zones, ...officeZones]);
}

async function upsertGeofenceInMySql(zone: Geofence): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureGeofenceTable();
  const conn = await getMySqlPool();
  const now = new Date().toISOString();
  await conn.execute(
    `INSERT INTO lff_geofences (
      id, company_id, name, latitude, longitude, radius_meters, assigned_employee_ids_json,
      is_active, allow_override, working_hours_start, working_hours_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      company_id = VALUES(company_id),
      name = VALUES(name),
      latitude = VALUES(latitude),
      longitude = VALUES(longitude),
      radius_meters = VALUES(radius_meters),
      assigned_employee_ids_json = VALUES(assigned_employee_ids_json),
      is_active = VALUES(is_active),
      allow_override = VALUES(allow_override),
      working_hours_start = VALUES(working_hours_start),
      working_hours_end = VALUES(working_hours_end),
      updated_at = VALUES(updated_at)`,
    [
      zone.id,
      zone.companyId ?? null,
      zone.name,
      zone.latitude,
      zone.longitude,
      Math.max(500, Math.round(zone.radiusMeters || 500)),
      JSON.stringify(zone.assignedEmployeeIds || []),
      zone.isActive ? 1 : 0,
      zone.allowOverride ? 1 : 0,
      zone.workingHoursStart ?? null,
      zone.workingHoursEnd ?? null,
      toSqlTimestamp(zone.createdAt || now),
      toSqlTimestamp(now),
    ]
  );
}

async function ensureAttendanceTable(): Promise<void> {
  if (attendanceTableEnsured) return;
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_attendance\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`user_id\` VARCHAR(64) NOT NULL,
      \`user_name\` VARCHAR(191) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`type\` ENUM('checkin','checkout') NOT NULL,
      \`timestamp\` DATETIME NOT NULL,
      \`timestamp_server\` DATETIME NULL,
      \`lat\` DECIMAL(10,7) NULL,
      \`lng\` DECIMAL(10,7) NULL,
      \`geofence_id\` VARCHAR(64) NULL,
      \`geofence_name\` VARCHAR(191) NULL,
      \`photo_url\` LONGTEXT NULL,
      \`device_id\` VARCHAR(128) NULL,
      \`is_inside_geofence\` TINYINT(1) NULL,
      \`source\` ENUM('mobile','manual','synced') NULL,
      \`notes\` LONGTEXT NULL,
      \`photo\` LONGTEXT NULL,
      \`approval_status\` ENUM('pending','approved','rejected') NULL,
      \`approval_reviewed_by_id\` VARCHAR(64) NULL,
      \`approval_reviewed_by_name\` VARCHAR(191) NULL,
      \`approval_reviewed_at\` DATETIME NULL,
      \`approval_comment\` LONGTEXT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_attendance_user_timestamp\` (\`user_id\`, \`timestamp\`),
      KEY \`idx_lff_attendance_user_type_timestamp\` (\`user_id\`, \`type\`, \`timestamp\`),
      KEY \`idx_lff_attendance_company_timestamp\` (\`company_id\`, \`timestamp\`),
      KEY \`idx_lff_attendance_company\` (\`company_id\`),
      KEY \`idx_lff_attendance_approval\` (\`approval_status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureMySqlIndex("lff_attendance", "idx_lff_attendance_user_type_timestamp", [
    "user_id",
    "type",
    "timestamp",
  ]);
  await ensureMySqlIndex("lff_attendance", "idx_lff_attendance_company_timestamp", [
    "company_id",
    "timestamp",
  ]);
  attendanceTableEnsured = true;
}

function mapAttendanceRow(row: any): AttendanceRecord {
  const location =
    row.lat === null ||
    row.lat === undefined ||
    row.lng === null ||
    row.lng === undefined
      ? undefined
      : {
          lat: Number(row.lat),
          lng: Number(row.lng),
        };

  return {
    id: String(row.id),
    userId: String(row.user_id),
    userName: String(row.user_name || ""),
    companyId: row.company_id ? String(row.company_id) : undefined,
    type: row.type === "checkout" ? "checkout" : "checkin",
    timestamp: toIsoTimestamp(row.timestamp, new Date().toISOString()),
    timestampServer: row.timestamp_server ? toIsoTimestamp(row.timestamp_server, new Date().toISOString()) : null,
    location,
    geofenceId: row.geofence_id ? String(row.geofence_id) : null,
    geofenceName: row.geofence_name ? String(row.geofence_name) : null,
    photoUrl: row.photo_url ? String(row.photo_url) : null,
    deviceId: row.device_id ? String(row.device_id) : null,
    isInsideGeofence:
      row.is_inside_geofence === null || row.is_inside_geofence === undefined
        ? undefined
        : Boolean(row.is_inside_geofence),
    source: row.source === "manual" || row.source === "synced" ? row.source : "mobile",
    notes: row.notes ? String(row.notes) : undefined,
    photo: row.photo ? String(row.photo) : undefined,
    approvalStatus: normalizeApprovalStatusValue(row.approval_status),
    approvalReviewedById: row.approval_reviewed_by_id ? String(row.approval_reviewed_by_id) : null,
    approvalReviewedByName: row.approval_reviewed_by_name ? String(row.approval_reviewed_by_name) : null,
    approvalReviewedAt: row.approval_reviewed_at ? toIsoTimestamp(row.approval_reviewed_at, new Date().toISOString()) : null,
    approvalComment: row.approval_comment ? String(row.approval_comment) : null,
  };
}

async function insertAttendanceInMySql(record: AttendanceRecord): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureAttendanceTable();
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_attendance (
      id, user_id, user_name, company_id, type, timestamp, timestamp_server, lat, lng,
      geofence_id, geofence_name, photo_url, device_id, is_inside_geofence, source, notes,
      photo, approval_status, approval_reviewed_by_id, approval_reviewed_by_name, approval_reviewed_at,
      approval_comment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      user_id = VALUES(user_id),
      user_name = VALUES(user_name),
      company_id = VALUES(company_id),
      type = VALUES(type),
      timestamp = VALUES(timestamp),
      timestamp_server = VALUES(timestamp_server),
      lat = VALUES(lat),
      lng = VALUES(lng),
      geofence_id = VALUES(geofence_id),
      geofence_name = VALUES(geofence_name),
      photo_url = VALUES(photo_url),
      device_id = VALUES(device_id),
      is_inside_geofence = VALUES(is_inside_geofence),
      source = VALUES(source),
      notes = VALUES(notes),
      photo = VALUES(photo),
      approval_status = VALUES(approval_status),
      approval_reviewed_by_id = VALUES(approval_reviewed_by_id),
      approval_reviewed_by_name = VALUES(approval_reviewed_by_name),
      approval_reviewed_at = VALUES(approval_reviewed_at),
      approval_comment = VALUES(approval_comment)`,
    [
      record.id,
      record.userId,
      record.userName,
      record.companyId ?? null,
      record.type,
      toSqlTimestamp(record.timestamp),
      record.timestampServer ? toSqlTimestamp(record.timestampServer) : null,
      record.location?.lat ?? null,
      record.location?.lng ?? null,
      record.geofenceId ?? null,
      record.geofenceName ?? null,
      record.photoUrl ?? null,
      record.deviceId ?? null,
      typeof record.isInsideGeofence === "boolean" ? (record.isInsideGeofence ? 1 : 0) : null,
      record.source ?? null,
      record.notes ?? null,
      record.photo ?? null,
      record.approvalStatus ?? "approved",
      record.approvalReviewedById ?? null,
      record.approvalReviewedByName ?? null,
      record.approvalReviewedAt ? toSqlTimestamp(record.approvalReviewedAt) : null,
      record.approvalComment ?? null,
    ]
  );
}

async function hydrateAttendanceFromLegacyStateIfNeeded(): Promise<void> {
  if (attendanceLegacyStateHydrated || !isMySqlStateEnabled()) return;
  attendanceLegacyStateHydrated = true;
  const raw = await getMySqlStateValue("@trackforce_attendance").catch(() => null);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      await mergeAttendanceInMySql(parsed);
    }
  } catch {
    // ignore malformed legacy state payload
  }
}

async function listAttendanceHistoryFromMySql(userId: string): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance WHERE user_id = ? ORDER BY \`timestamp\` DESC`,
    [userId]
  );
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance WHERE user_id = ? ORDER BY \`timestamp\` DESC`,
      [userId]
    );
  }
  return rows.map(mapAttendanceRow);
}

async function listAttendanceForUserDateFromMySql(
  userId: string,
  dateKey: string
): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance
     WHERE user_id = ? AND \`timestamp\` BETWEEN ? AND ?
     ORDER BY \`timestamp\` ASC`,
    [userId, range.start, range.end]
  );
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance
       WHERE user_id = ? AND \`timestamp\` BETWEEN ? AND ?
       ORDER BY \`timestamp\` ASC`,
      [userId, range.start, range.end]
    );
  }
  return rows.map(mapAttendanceRow);
}

async function listAttendanceTodayFromMySql(userId: string): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const range = parseDateKeyToUtcRange(toMumbaiDateKey(new Date()));
  if (!range) return [];
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance
     WHERE user_id = ? AND \`timestamp\` BETWEEN ? AND ?
     ORDER BY \`timestamp\` DESC`,
    [userId, range.start, range.end]
  );
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance
       WHERE user_id = ? AND \`timestamp\` BETWEEN ? AND ?
       ORDER BY \`timestamp\` DESC`,
      [userId, range.start, range.end]
    );
  }
  return rows.map(mapAttendanceRow);
}

async function listAttendanceTodayFromMySqlAll(
  companyId?: string,
  dateKey = toMumbaiDateKey(new Date())
): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  const conn = await getMySqlPool();
  const cleanCompanyId = companyId ? String(companyId).trim() : "";
  let query = `SELECT * FROM lff_attendance WHERE \`timestamp\` BETWEEN ? AND ?`;
  const params: any[] = [range.start, range.end];
  if (cleanCompanyId) {
    query += ` AND company_id = ?`;
    params.push(cleanCompanyId);
  }
  query += ` ORDER BY \`timestamp\` DESC`;
  let [rows] = await conn.query<any[]>(query, params);
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(query, params);
  }
  return rows.map(mapAttendanceRow);
}

async function listAttendanceFromMySql(limit = 10000): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const conn = await getMySqlPool();
  const safeLimit = Math.max(1, Math.min(50000, Math.trunc(limit)));
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance ORDER BY \`timestamp\` DESC LIMIT ${safeLimit}`
  );
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance ORDER BY \`timestamp\` DESC LIMIT ${safeLimit}`
    );
  }
  return rows.map(mapAttendanceRow);
}

async function findActiveAttendanceInMySql(userId: string): Promise<AttendanceRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureAttendanceTable();
  const conn = await getMySqlPool();
  let [checkInRows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance
     WHERE user_id = ? AND type = 'checkin'
     ORDER BY \`timestamp\` DESC
     LIMIT 1`,
    [userId]
  );
  if ((!checkInRows || checkInRows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [checkInRows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance
       WHERE user_id = ? AND type = 'checkin'
       ORDER BY \`timestamp\` DESC
       LIMIT 1`,
      [userId]
    );
  }
  if (!checkInRows || checkInRows.length === 0) return null;
  const latestCheckIn = mapAttendanceRow(checkInRows[0]);
  const [checkoutRows] = await conn.query<any[]>(
    `SELECT id FROM lff_attendance
     WHERE user_id = ? AND type = 'checkout' AND \`timestamp\` >= ?
     ORDER BY \`timestamp\` DESC
     LIMIT 1`,
    [userId, toSqlTimestamp(latestCheckIn.timestamp)]
  );
  return checkoutRows && checkoutRows.length > 0 ? null : latestCheckIn;
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

async function listLocationLogsFromMySql(limit = 10000): Promise<LocationLog[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureLocationLogIndexes();
  const conn = await getMySqlPool();
  const safeLimit = Math.max(1, Math.min(50000, Math.trunc(limit)));
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs ORDER BY captured_at DESC LIMIT ${safeLimit}`
  );
  if ((!rows || rows.length === 0) && !locationLogLegacyStateHydrated) {
    await hydrateLocationLogsFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_location_logs ORDER BY captured_at DESC LIMIT ${safeLimit}`
    );
  }
  return rows.map(mapLocationLogRow);
}

async function insertLocationLogInMySql(log: LocationLog): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureLocationLogIndexes();
  void pruneLocationLogsIfNeeded();
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

async function insertLocationLogsInMySql(logs: LocationLog[]): Promise<void> {
  if (!isMySqlStateEnabled() || logs.length === 0) return;
  await ensureLocationLogIndexes();
  void pruneLocationLogsIfNeeded();
  const conn = await getMySqlPool();
  const chunkSize = 250;
  for (let index = 0; index < logs.length; index += chunkSize) {
    const chunk = logs.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunk.flatMap((log) => [
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
    ]);
    await conn.execute(
      `INSERT INTO lff_location_logs (
        id, company_id, user_id, latitude, longitude, accuracy, speed, heading, battery_level,
        geofence_id, geofence_name, is_inside_geofence, captured_at
      ) VALUES ${placeholders}
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
      values
    );
  }
}

async function listLocationLogsLatestFromMySql(): Promise<LocationLog[]> {
  await ensureLocationLogIndexes();
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT logs.*
     FROM lff_location_logs logs
     INNER JOIN (
       SELECT user_id, MAX(captured_at) AS captured_at
       FROM lff_location_logs
       GROUP BY user_id
     ) latest
       ON latest.user_id = logs.user_id
      AND latest.captured_at = logs.captured_at
     ORDER BY logs.captured_at DESC
     LIMIT 5000`
  );
  if ((!rows || rows.length === 0) && !locationLogLegacyStateHydrated) {
    await hydrateLocationLogsFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT logs.*
       FROM lff_location_logs logs
       INNER JOIN (
         SELECT user_id, MAX(captured_at) AS captured_at
         FROM lff_location_logs
         GROUP BY user_id
       ) latest
         ON latest.user_id = logs.user_id
        AND latest.captured_at = logs.captured_at
       ORDER BY logs.captured_at DESC
       LIMIT 5000`
    );
  }
  return rows.map(mapLocationLogRow);
}

async function listLocationLogsForDateFromMySql(dateKey: string): Promise<LocationLog[]> {
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  await ensureLocationLogIndexes();
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs
     WHERE captured_at BETWEEN ? AND ?
     ORDER BY captured_at ASC`,
    [range.start, range.end]
  );
  if ((!rows || rows.length === 0) && !locationLogLegacyStateHydrated) {
    await hydrateLocationLogsFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_location_logs
       WHERE captured_at BETWEEN ? AND ?
       ORDER BY captured_at ASC`,
      [range.start, range.end]
    );
  }
  return rows.map(mapLocationLogRow);
}

async function listLocationLogsForUserDateFromMySql(
  userId: string,
  dateKey: string
): Promise<LocationLog[]> {
  const range = parseDateKeyToUtcRange(dateKey);
  if (!range) return [];
  await ensureLocationLogIndexes();
  const conn = await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_location_logs
     WHERE user_id = ? AND captured_at BETWEEN ? AND ?
     ORDER BY captured_at ASC`,
    [userId, range.start, range.end]
  );
  if ((!rows || rows.length === 0) && !locationLogLegacyStateHydrated) {
    await hydrateLocationLogsFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_location_logs
       WHERE user_id = ? AND captured_at BETWEEN ? AND ?
       ORDER BY captured_at ASC`,
      [userId, range.start, range.end]
    );
  }
  return rows.map(mapLocationLogRow);
}

async function getLatestAccessRequestByEmailFromMySql(
  email: string
): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureAccessRequestAssignmentColumns();
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
    assignedStockistId: row.assigned_stockist_id ? String(row.assigned_stockist_id) : null,
    assignedStockistName: row.assigned_stockist_name ? String(row.assigned_stockist_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

async function getLatestPendingAccessRequestByEmailFromMySql(
  email: string
): Promise<AccessRequestRecord | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureAccessRequestAssignmentColumns();
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
    assignedStockistId: row.assigned_stockist_id ? String(row.assigned_stockist_id) : null,
    assignedStockistName: row.assigned_stockist_name ? String(row.assigned_stockist_name) : null,
    passwordHash: row.password_hash ? String(row.password_hash) : undefined,
  };
}

async function refreshStockistBalancesInMySql(
  executor?: {
    execute: (...args: any[]) => Promise<unknown>;
  }
): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const target = executor ?? (await getMySqlPool());
  await target.execute(`
    UPDATE lff_stock_transfers t
    INNER JOIN lff_stockists s
      ON s.id = t.stockist_id
    SET t.company_id = s.company_id,
        t.stockist_name = CASE
          WHEN TRIM(COALESCE(s.name, '')) <> '' THEN s.name
          ELSE t.stockist_name
        END
    WHERE NOT (t.company_id <=> s.company_id)
       OR TRIM(COALESCE(t.stockist_name, '')) <> TRIM(COALESCE(s.name, ''))
  `);
  await target.execute(`
    UPDATE lff_stockists s
    LEFT JOIN (
      SELECT stockist_id,
             SUM(CASE WHEN transfer_type = 'in' THEN quantity ELSE 0 END) AS stock_in,
             SUM(CASE WHEN transfer_type = 'out' THEN quantity ELSE 0 END) AS stock_out,
             MAX(created_at) AS last_stock_update
      FROM lff_stock_transfers
      GROUP BY stockist_id
    ) t
      ON t.stockist_id = s.id
    SET s.stock_in = COALESCE(t.stock_in, 0),
        s.stock_out = COALESCE(t.stock_out, 0),
        s.stock_balance = COALESCE(t.stock_in, 0) - COALESCE(t.stock_out, 0),
        s.last_stock_update = t.last_stock_update
  `);
}

async function syncStockistSalespersonAssignmentInMySql(
  salespersonId: string,
  nextStockistId: string | null
): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const normalizedSalespersonId = normalizeWhitespace(salespersonId);
  if (!normalizedSalespersonId) return;
  await ensureStockistAssignmentColumns();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<any[]>(
      `SELECT id, assigned_salesperson_ids_json FROM lff_stockists`
    );
    const normalizedNextStockistId = normalizeWhitespace(nextStockistId ?? "");
    for (const row of rows || []) {
      const stockistId = row?.id ? String(row.id) : "";
      if (!stockistId) continue;
      const currentIds = parseStringArrayJson(row.assigned_salesperson_ids_json);
      let nextIds = currentIds.filter((entry) => entry !== normalizedSalespersonId);
      if (normalizedNextStockistId && stockistId === normalizedNextStockistId) {
        nextIds = Array.from(new Set([...nextIds, normalizedSalespersonId]));
      }
      if (JSON.stringify(nextIds) === JSON.stringify(currentIds)) continue;
      await conn.execute(
        `UPDATE lff_stockists
         SET assigned_salesperson_ids_json = ?, updated_at = NOW()
         WHERE id = ?`,
        [JSON.stringify(nextIds), stockistId]
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
  await ensureStockistAssignmentColumns();
  const conn = await getMySqlPool();
  await refreshStockistBalancesInMySql(conn);
  const [rows] = await conn.query<any[]>(`
    SELECT id, company_id, name, phone, location, pincode, notes, assigned_salesperson_ids_json,
           stock_in, stock_out, stock_balance, last_stock_update,
           created_at, updated_at
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
    assignedSalespersonIds: parseStringArrayJson(row.assigned_salesperson_ids_json),
    stockIn: Number.isFinite(Number(row.stock_in)) ? Number(row.stock_in) : 0,
    stockOut: Number.isFinite(Number(row.stock_out)) ? Number(row.stock_out) : 0,
    stockBalance: Number.isFinite(Number(row.stock_balance)) ? Number(row.stock_balance) : 0,
    lastStockUpdate: row.last_stock_update ? toIsoTimestamp(row.last_stock_update, nowIso) : undefined,
    createdAt: toIsoTimestamp(row.created_at, nowIso),
    updatedAt: toIsoTimestamp(row.updated_at, nowIso),
  }));
}

async function listStockTransfersFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  const conn = await getMySqlPool();
  await refreshStockistBalancesInMySql(conn);
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
  await ensureStockistAssignmentColumns();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.query<any[]>(
      `SELECT id, assigned_salesperson_ids_json FROM lff_stockists`
    );
    const existingAssignmentsById = new Map<string, string[]>();
    for (const row of existingRows || []) {
      const stockistId = row?.id ? String(row.id) : "";
      if (!stockistId) continue;
      existingAssignmentsById.set(stockistId, parseStringArrayJson(row.assigned_salesperson_ids_json));
    }
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
      const providedAssignedSalespersonIds =
        "assignedSalespersonIds" in (entry as Record<string, unknown>)
          ? parseStringArrayJson((entry as any).assignedSalespersonIds)
          : existingAssignmentsById.get(id) || [];
      const assignedSalespersonIds = JSON.stringify(
        providedAssignedSalespersonIds
      );
      const createdAt = toSqlTimestamp((entry as any).createdAt);
      const updatedAt = toSqlTimestamp((entry as any).updatedAt ?? (entry as any).createdAt);
      await conn.execute(
        `INSERT INTO lff_stockists
          (id, company_id, name, phone, location, pincode, notes, assigned_salesperson_ids_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, companyId, name, phone, location, pincode, notes, assignedSalespersonIds, createdAt, updatedAt]
      );
    }
    await refreshStockistBalancesInMySql(conn);
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
    const [stockistRows] = await conn.query<any[]>(
      `SELECT id, company_id, name FROM lff_stockists`
    );
    const stockistById = new Map<string, { companyId: string | null; name: string | null }>();
    for (const row of stockistRows || []) {
      const stockistId = row?.id ? String(row.id) : "";
      if (!stockistId) continue;
      stockistById.set(stockistId, {
        companyId: row.company_id ? String(row.company_id) : null,
        name: row.name ? String(row.name) : null,
      });
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const id = toStringId((entry as any).id);
      const stockistId = toStringId((entry as any).stockistId);
      if (!id || !stockistId) continue;
      const stockistMeta = stockistById.get(stockistId);
      const companyId = stockistMeta?.companyId ?? toNullableText((entry as any).companyId);
      const stockistName = toRequiredText(
        stockistMeta?.name ?? (entry as any).stockistName,
        "Channel Partner"
      );
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

    await refreshStockistBalancesInMySql(conn);
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

function normalizeAttendanceRecordInput(entry: unknown): AttendanceRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const id = toStringId((entry as any).id);
  const userId = toStringId((entry as any).userId);
  const type = (entry as any).type === "checkout" ? "checkout" : (entry as any).type === "checkin" ? "checkin" : null;
  const timestamp = toNullableText((entry as any).timestamp);
  if (!id || !userId || !type || !timestamp) return null;

  const userName = toRequiredText((entry as any).userName, "Unknown User");
  const lat = Number((entry as any).location?.lat);
  const lng = Number((entry as any).location?.lng);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);

  return {
    id,
    userId,
    userName,
    companyId: toNullableText((entry as any).companyId) ?? undefined,
    type,
    timestamp,
    timestampServer: toNullableText((entry as any).timestampServer),
    location: hasLocation ? { lat, lng } : undefined,
    geofenceId: toNullableText((entry as any).geofenceId),
    geofenceName: toNullableText((entry as any).geofenceName),
    photoUrl: toNullableText((entry as any).photoUrl),
    deviceId: toNullableText((entry as any).deviceId),
    isInsideGeofence:
      typeof (entry as any).isInsideGeofence === "boolean"
        ? Boolean((entry as any).isInsideGeofence)
        : undefined,
    source:
      (entry as any).source === "manual" || (entry as any).source === "synced"
        ? (entry as any).source
        : "mobile",
    notes: toNullableText((entry as any).notes) ?? undefined,
    photo: toNullableText((entry as any).photo) ?? undefined,
    approvalStatus: normalizeApprovalStatusValue((entry as any).approvalStatus),
    approvalReviewedById: toNullableText((entry as any).approvalReviewedById),
    approvalReviewedByName: toNullableText((entry as any).approvalReviewedByName),
    approvalReviewedAt: toNullableText((entry as any).approvalReviewedAt),
    approvalComment: toNullableText((entry as any).approvalComment),
  };
}

function normalizeLocationLogInput(entry: unknown): LocationLog | null {
  if (!entry || typeof entry !== "object") return null;
  const id = toStringId((entry as any).id);
  const userId = toStringId((entry as any).userId);
  const latitude = Number((entry as any).latitude);
  const longitude = Number((entry as any).longitude);
  if (!id || !userId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const accuracy = Number((entry as any).accuracy);
  const speed = Number((entry as any).speed);
  const heading = Number((entry as any).heading);
  const batteryLevel = Number((entry as any).batteryLevel);

  return {
    id,
    companyId: toNullableText((entry as any).companyId) ?? undefined,
    userId,
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    speed: Number.isFinite(speed) ? speed : null,
    heading: Number.isFinite(heading) ? heading : null,
    batteryLevel: Number.isFinite(batteryLevel) ? batteryLevel : null,
    geofenceId: toNullableText((entry as any).geofenceId),
    geofenceName: toNullableText((entry as any).geofenceName),
    isInsideGeofence: Boolean((entry as any).isInsideGeofence),
    capturedAt: toNullableText((entry as any).capturedAt) || new Date().toISOString(),
  };
}

async function mergeAttendanceInMySql(entries: unknown[]): Promise<void> {
  for (const entry of entries) {
    const record = normalizeAttendanceRecordInput(entry);
    if (!record) continue;
    await insertAttendanceInMySql(record);
  }
}

async function mergeLocationLogsInMySql(entries: unknown[]): Promise<void> {
  for (const entry of entries) {
    const log = normalizeLocationLogInput(entry);
    if (!log) continue;
    await insertLocationLogInMySql(log);
  }
}

async function hydrateLocationLogsFromLegacyStateIfNeeded(): Promise<void> {
  if (locationLogLegacyStateHydrated || !isMySqlStateEnabled()) return;
  locationLogLegacyStateHydrated = true;
  if (!ENABLE_LEGACY_LOCATION_LOG_HYDRATION) {
    console.warn(
      "Skipping legacy location log hydration. Enable ENABLE_LEGACY_LOCATION_LOG_HYDRATION=true only for controlled one-time migration."
    );
    return;
  }
  const raw = await getMySqlStateValue("@trackforce_location_logs").catch(() => null);
  if (!raw) return;
  if (raw.length > LEGACY_LOCATION_LOG_STATE_MAX_BYTES) {
    console.warn(
      `Skipping legacy location log hydration because payload is too large (${raw.length} bytes).`
    );
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      await mergeLocationLogsInMySql(parsed);
    }
  } catch {
    // ignore malformed legacy state payload
  }
}

let salariesTableEnsured = false;
async function ensureSalariesTable(): Promise<void> {
  if (salariesTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_salaries\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`employee_id\` VARCHAR(64) NOT NULL,
      \`employee_name\` VARCHAR(191) NOT NULL,
      \`employee_email\` VARCHAR(191) NULL,
      \`label\` VARCHAR(191) NULL,
      \`period_start\` DATE NULL,
      \`period_end\` DATE NULL,
      \`payment_date\` DATE NULL,
      \`payment_mode\` VARCHAR(64) NULL,
      \`bank_account\` VARCHAR(191) NULL,
      \`note\` LONGTEXT NULL,
      \`month\` VARCHAR(16) NOT NULL,
      \`basic\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`hra\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`transport\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`medical\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`bonus\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`overtime\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`tax\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`pf\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`insurance\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`gross_pay\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`total_deductions\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`net_pay\` DECIMAL(12,2) NOT NULL DEFAULT 0,
      \`status\` ENUM('pending','approved','paid') NOT NULL DEFAULT 'pending',
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_salaries_employee\` (\`employee_id\`),
      KEY \`idx_lff_salaries_month\` (\`month\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [salaryColumns] = await conn.query<any[]>("SHOW COLUMNS FROM `lff_salaries`");
  const existingColumns = new Set((salaryColumns || []).map((column) => String(column.Field || "")));
  const alterClauses: string[] = [];

  if (!existingColumns.has("employee_email")) {
    alterClauses.push("ADD COLUMN `employee_email` VARCHAR(191) NULL AFTER `employee_name`");
  }
  if (!existingColumns.has("label")) {
    alterClauses.push("ADD COLUMN `label` VARCHAR(191) NULL AFTER `employee_email`");
  }
  if (!existingColumns.has("period_start")) {
    alterClauses.push("ADD COLUMN `period_start` DATE NULL AFTER `label`");
  }
  if (!existingColumns.has("period_end")) {
    alterClauses.push("ADD COLUMN `period_end` DATE NULL AFTER `period_start`");
  }
  if (!existingColumns.has("payment_date")) {
    alterClauses.push("ADD COLUMN `payment_date` DATE NULL AFTER `period_end`");
  }
  if (!existingColumns.has("payment_mode")) {
    alterClauses.push("ADD COLUMN `payment_mode` VARCHAR(64) NULL AFTER `payment_date`");
  }
  if (!existingColumns.has("bank_account")) {
    alterClauses.push("ADD COLUMN `bank_account` VARCHAR(191) NULL AFTER `payment_mode`");
  }
  if (!existingColumns.has("note")) {
    alterClauses.push("ADD COLUMN `note` LONGTEXT NULL AFTER `bank_account`");
  }

  if (alterClauses.length > 0) {
    await conn.execute(`ALTER TABLE \`lff_salaries\` ${alterClauses.join(", ")}`);
  }
  salariesTableEnsured = true;
}

async function listSalariesFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureSalariesTable();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT * FROM lff_salaries ORDER BY month DESC, employee_name ASC
  `);
  return (rows || []).map((row) => ({
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    employeeId: String(row.employee_id),
    employeeName: String(row.employee_name),
    employeeEmail: row.employee_email ? String(row.employee_email) : undefined,
    label: row.label ? String(row.label) : undefined,
    periodStart: row.period_start ? new Date(row.period_start).toISOString().slice(0, 10) : undefined,
    periodEnd: row.period_end ? new Date(row.period_end).toISOString().slice(0, 10) : undefined,
    paymentDate: row.payment_date ? new Date(row.payment_date).toISOString().slice(0, 10) : undefined,
    paymentMode: row.payment_mode ? String(row.payment_mode) : undefined,
    bankAccount: row.bank_account ? String(row.bank_account) : undefined,
    note: row.note ? String(row.note) : undefined,
    month: String(row.month),
    basic: Number(row.basic),
    hra: Number(row.hra),
    transport: Number(row.transport),
    medical: Number(row.medical),
    bonus: Number(row.bonus),
    overtime: Number(row.overtime),
    tax: Number(row.tax),
    pf: Number(row.pf),
    insurance: Number(row.insurance),
    grossPay: Number(row.gross_pay),
    totalDeductions: Number(row.total_deductions),
    netPay: Number(row.net_pay),
    status: String(row.status),
  }));
}

function toDateOnlyString(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function buildSalaryMonthFromRow(row: Record<string, unknown>): string {
  return (
    toDateOnlyString(row.datesp) ||
    toDateOnlyString(row.dateep) ||
    toDateOnlyString(row.datep) ||
    toDateOnlyString(row.datec) ||
    new Date().toISOString().slice(0, 10)
  ).slice(0, 7);
}

function buildDolibarrSalaryName(row: Record<string, unknown>): string {
  const first = row.firstname ? String(row.firstname).trim() : "";
  const last = row.lastname ? String(row.lastname).trim() : "";
  const joined = `${first} ${last}`.trim();
  if (joined) return joined;
  if (first) return first;
  if (last) return last;
  if (row.login) return String(row.login).trim();
  return `User ${String(row.fk_user || "")}`.trim();
}

function normalizeSalaryIdentity(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function resolveDolibarrSalaryViewerIds(
  conn: Pool | PoolConnection,
  requestUser: AppUser | null | undefined
): Promise<Set<string>> {
  const ids = new Set<string>();
  const email = normalizeSalaryIdentity(requestUser?.email);
  const name = normalizeSalaryIdentity(requestUser?.name);
  const login = normalizeSalaryIdentity(requestUser?.login);
  const compactName = name.replace(/\s+/g, "");
  if (!email && !name && !login) return ids;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (email) {
    clauses.push("LOWER(TRIM(email)) = ?");
    params.push(email);
  }
  if (name) {
    clauses.push("LOWER(TRIM(CONCAT_WS(' ', firstname, lastname))) = ?");
    params.push(name);
    clauses.push("LOWER(TRIM(CONCAT_WS(' ', lastname, firstname))) = ?");
    params.push(name);
    clauses.push("LOWER(REPLACE(CONCAT_WS('', firstname, lastname), ' ', '')) = ?");
    params.push(compactName);
    clauses.push("LOWER(REPLACE(CONCAT_WS('', lastname, firstname), ' ', '')) = ?");
    params.push(compactName);
    clauses.push("LOWER(TRIM(firstname)) = ?");
    params.push(name);
    clauses.push("LOWER(TRIM(lastname)) = ?");
    params.push(name);
    clauses.push("LOWER(TRIM(login)) = ?");
    params.push(compactName);
  }
  if (login) {
    clauses.push("LOWER(TRIM(login)) = ?");
    params.push(login);
  }
  if (!clauses.length) return ids;

  const [rows] = await conn.query<any[]>(
    `SELECT rowid FROM \`nmy5_user\` WHERE ${clauses.join(" OR ")}`,
    params
  );
  for (const row of rows || []) {
    if (row?.rowid) {
      ids.add(`dolibarr_${String(row.rowid).trim().toLowerCase()}`);
    }
  }
  return ids;
}

function parseSalaryNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapDolibarrSalaryRow(row: Record<string, unknown>): SalaryRecord {
  const amount = parseSalaryNumber(row.amount);
  const salaryAmount = parseSalaryNumber(row.salary);
  const grossPay = salaryAmount > 0 ? salaryAmount : amount;
  const totalDeductions = Math.max(grossPay - amount, 0);
  const paymentMode =
    row.payment_libelle ? String(row.payment_libelle) : row.payment_code ? String(row.payment_code) : undefined;
  const bankAccount =
    row.bank_label ? String(row.bank_label) : row.bank_ref ? String(row.bank_ref) : undefined;
  const employeeName = buildDolibarrSalaryName(row);
  const employeeId = row.fk_user ? `dolibarr_${String(row.fk_user)}` : `dolibarr_salary_${String(row.rowid || "")}`;
  const status = parseSalaryNumber(row.paye) > 0 ? "paid" : "pending";
  const periodStart = toDateOnlyString(row.datesp);
  const periodEnd = toDateOnlyString(row.dateep);
  return {
    id: row.ref_ext ? String(row.ref_ext) : `dolibarr_salary_${String(row.rowid || "")}`,
    companyId: undefined,
    employeeId,
    employeeName,
    employeeEmail: row.email ? String(row.email).trim() || undefined : undefined,
    label: row.label ? String(row.label) : "Salary",
    periodStart,
    periodEnd,
    paymentDate: toDateOnlyString(row.datep) || toDateOnlyString(row.datev),
    paymentMode,
    bankAccount,
    note: row.note ? String(row.note) : row.note_public ? String(row.note_public) : undefined,
    month: buildSalaryMonthFromRow(row),
    basic: grossPay,
    hra: 0,
    transport: 0,
    medical: 0,
    bonus: 0,
    overtime: 0,
    tax: 0,
    pf: 0,
    insurance: 0,
    grossPay,
    totalDeductions,
    netPay: amount,
    status,
  };
}

async function listDolibarrSalaryRows(conn: Pool | PoolConnection): Promise<SalaryRecord[]> {
  const [rows] = await conn.query<any[]>(`
    SELECT s.*, u.firstname, u.lastname, u.login, u.email,
           p.code AS payment_code, p.libelle AS payment_libelle,
           b.ref AS bank_ref, b.label AS bank_label
    FROM \`nmy5_salary\` s
    LEFT JOIN \`nmy5_user\` u ON u.rowid = s.fk_user
    LEFT JOIN \`nmy5_c_paiement\` p ON p.id = s.fk_typepayment
    LEFT JOIN \`nmy5_bank_account\` b ON b.rowid = s.fk_account
    ORDER BY s.datec DESC, s.rowid DESC
  `);
  return (rows || []).map((row) => mapDolibarrSalaryRow(row));
}

function mergeSalarySources(localRows: SalaryRecord[], dolibarrRows: SalaryRecord[]): SalaryRecord[] {
  const merged = new Map<string, SalaryRecord>();

  for (const salary of localRows) {
    merged.set(String(salary.id), salary);
  }

  for (const salary of dolibarrRows) {
    const key = String(salary.id);
    if (!merged.has(key)) {
      merged.set(key, salary);
    }
  }

  return Array.from(merged.values()).sort((left, right) => {
    const leftDate = `${left.month || ""} ${left.employeeName || ""}`;
    const rightDate = `${right.month || ""} ${right.employeeName || ""}`;
    return rightDate.localeCompare(leftDate);
  });
}

async function resolveDolibarrSalaryUserId(
  conn: Pool | PoolConnection,
  payload: { employeeEmail?: string; employeeName?: string; employeeId?: string }
): Promise<number | null> {
  const email = payload.employeeEmail ? String(payload.employeeEmail).trim().toLowerCase() : "";
  if (email) {
    const [rows] = await conn.query<any[]>(
      "SELECT rowid FROM `nmy5_user` WHERE LOWER(TRIM(email)) = ? LIMIT 1",
      [email]
    );
    if (rows?.[0]?.rowid) return Number(rows[0].rowid);
  }

  const rawId = payload.employeeId ? String(payload.employeeId).trim().toLowerCase() : "";
  const dolibarrId =
    rawId && rawId.startsWith("dolibarr_") ? Number(rawId.replace("dolibarr_", "")) : Number.NaN;
  if (Number.isFinite(dolibarrId) && dolibarrId > 0) {
    const [rows] = await conn.query<any[]>("SELECT rowid FROM `nmy5_user` WHERE rowid = ? LIMIT 1", [dolibarrId]);
    if (rows?.[0]?.rowid) return Number(rows[0].rowid);
  }

  const name = payload.employeeName ? String(payload.employeeName).trim().toLowerCase() : "";
  if (!name) return null;
  const compactName = name.replace(/\s+/g, "");
  const [rows] = await conn.query<any[]>(
    `SELECT rowid
       FROM \`nmy5_user\`
      WHERE LOWER(TRIM(CONCAT_WS(' ', firstname, lastname))) = ?
         OR LOWER(TRIM(CONCAT_WS(' ', lastname, firstname))) = ?
         OR LOWER(REPLACE(CONCAT_WS('', firstname, lastname), ' ', '')) = ?
         OR LOWER(REPLACE(CONCAT_WS('', lastname, firstname), ' ', '')) = ?
         OR LOWER(TRIM(login)) = ?
      LIMIT 1`,
    [name, name, compactName, compactName, compactName]
  );
  return rows?.[0]?.rowid ? Number(rows[0].rowid) : null;
}

async function resolveDolibarrSalaryPaymentTypeId(conn: Pool | PoolConnection, paymentMode?: string): Promise<number> {
  const mode = (paymentMode || "").trim().toLowerCase();
  let preferredCode = "VIR";
  if (/cash|liquid|esp[eè]ce/.test(mode)) preferredCode = "LIQ";
  else if (/cheque|check|chq/.test(mode)) preferredCode = "CHQ";
  else if (/card|cb/.test(mode)) preferredCode = "CB";

  const [rows] = await conn.query<any[]>(
    "SELECT id FROM `nmy5_c_paiement` WHERE active = 1 AND code = ? LIMIT 1",
    [preferredCode]
  );
  if (rows?.[0]?.id) return Number(rows[0].id);

  return 2;
}

async function resolveDolibarrSalaryBankAccountId(conn: Pool | PoolConnection, bankAccount?: string): Promise<number | null> {
  const input = (bankAccount || "").trim().toLowerCase();
  if (!input) return null;
  const [rows] = await conn.query<any[]>(
    `SELECT rowid
       FROM \`nmy5_bank_account\`
      WHERE LOWER(TRIM(label)) = ?
         OR LOWER(TRIM(ref)) = ?
         OR LOWER(TRIM(bank)) = ?
         OR LOWER(TRIM(number)) = ?
      LIMIT 1`,
    [input, input, input, input]
  );
  return rows?.[0]?.rowid ? Number(rows[0].rowid) : null;
}

async function upsertDolibarrSalaryRecord(
  conn: Pool | PoolConnection,
  payload: SalaryRecord,
  requestUser?: AppUser | null
): Promise<void> {
  const fkUser = await resolveDolibarrSalaryUserId(conn, payload);
  if (!fkUser) {
    throw new Error(`Dolibarr salary user not found for ${payload.employeeName}.`);
  }
  const fkTypePayment = await resolveDolibarrSalaryPaymentTypeId(conn, payload.paymentMode);
  const fkAccount = await resolveDolibarrSalaryBankAccountId(conn, payload.bankAccount);
  const amount = Number.isFinite(payload.netPay) ? payload.netPay : payload.grossPay;
  const grossPay = Number.isFinite(payload.grossPay) ? payload.grossPay : amount;
  const periodStart = payload.periodStart ? toSqlDateOnly(payload.periodStart) : null;
  const periodEnd = payload.periodEnd ? toSqlDateOnly(payload.periodEnd) : null;
  const paymentDate = payload.paymentDate ? toSqlDateOnly(payload.paymentDate) : null;
  const authorId = await resolveDolibarrSalaryUserId(conn, {
    employeeEmail: requestUser?.email,
    employeeName: requestUser?.name,
  });
  const ref = `APP-SAL-${payload.month.replace(/[^0-9]/g, "").slice(0, 6)}-${payload.id.slice(-6).toUpperCase()}`.slice(0, 30);
  const label = (payload.label || "").trim() || "Salary";
  const noteParts = [
    payload.note?.trim(),
    `gross=${grossPay}`,
    `net=${amount}`,
    payload.bankAccount ? `bank=${payload.bankAccount}` : "",
  ].filter(Boolean);
  const note = noteParts.join(" | ") || null;
  const baseParams = [
    ref,
    label,
    fkUser,
    paymentDate,
    null,
    grossPay || null,
    amount || 0,
    0,
    periodStart,
    periodEnd,
    note,
    payload.status === "paid" ? 1 : 0,
    fkTypePayment,
    fkAccount,
    authorId,
    authorId,
    payload.id,
    note,
  ];
  const [existingRows] = await conn.query<any[]>(
    "SELECT rowid FROM `nmy5_salary` WHERE ref_ext = ? LIMIT 1",
    [payload.id]
  );
  const existingRowId = existingRows?.[0]?.rowid ? Number(existingRows[0].rowid) : null;

  if (existingRowId) {
    await conn.execute(
      `UPDATE \`nmy5_salary\`
          SET \`ref\` = ?, \`label\` = ?, \`fk_user\` = ?, \`datep\` = ?, \`datev\` = ?, \`salary\` = ?, \`amount\` = ?,
              \`fk_projet\` = ?, \`datesp\` = ?, \`dateep\` = ?, \`note\` = ?, \`paye\` = ?, \`fk_typepayment\` = ?,
              \`fk_account\` = ?, \`fk_user_author\` = ?, \`fk_user_modif\` = ?, \`ref_ext\` = ?, \`note_public\` = ?
        WHERE \`rowid\` = ?`,
      [...baseParams, existingRowId]
    );
    return;
  }

  await conn.execute(
    `INSERT INTO \`nmy5_salary\`
      (\`ref\`, \`label\`, \`datec\`, \`fk_user\`, \`datep\`, \`datev\`, \`salary\`, \`amount\`, \`fk_projet\`, \`datesp\`, \`dateep\`, \`entity\`, \`note\`, \`fk_bank\`, \`paye\`, \`fk_typepayment\`, \`fk_account\`, \`fk_user_author\`, \`fk_user_modif\`, \`ref_ext\`, \`note_public\`)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    baseParams
  );
}

async function deleteDolibarrSalaryRecord(conn: Pool | PoolConnection, salaryId: string): Promise<void> {
  const legacyRowId =
    salaryId.startsWith("dolibarr_salary_") ? Number(salaryId.replace("dolibarr_salary_", "")) : Number.NaN;
  const hasLegacyRowId = Number.isFinite(legacyRowId) && legacyRowId > 0;
  await conn.execute(
    `DELETE FROM \`nmy5_salary\` WHERE \`ref_ext\` = ?${hasLegacyRowId ? " OR `rowid` = ?" : ""}`,
    hasLegacyRowId ? [salaryId, legacyRowId] : [salaryId]
  );
}

async function updateDolibarrSalaryStatus(conn: Pool | PoolConnection, salaryId: string, status: string): Promise<void> {
  const legacyRowId =
    salaryId.startsWith("dolibarr_salary_") ? Number(salaryId.replace("dolibarr_salary_", "")) : Number.NaN;
  const hasLegacyRowId = Number.isFinite(legacyRowId) && legacyRowId > 0;
  await conn.execute(
    `UPDATE \`nmy5_salary\`
        SET \`paye\` = ?, \`datep\` = CASE WHEN ? = 'paid' AND \`datep\` IS NULL THEN CURDATE() ELSE \`datep\` END
      WHERE \`ref_ext\` = ?${hasLegacyRowId ? " OR `rowid` = ?" : ""}`,
    hasLegacyRowId
      ? [status === "paid" ? 1 : 0, status, salaryId, legacyRowId]
      : [status === "paid" ? 1 : 0, status, salaryId]
  );
}

async function replaceSalariesInMySql(entries: unknown[]): Promise<void> {
  await ensureSalariesTable();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_salaries");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const id = e.id ? String(e.id).trim() : "";
      if (!id) continue;
      const companyId = e.companyId ? String(e.companyId).trim() : null;
      const employeeId = e.employeeId ? String(e.employeeId).trim() : "";
      const employeeName = e.employeeName ? String(e.employeeName).trim() : "Employee";
      const employeeEmail = e.employeeEmail ? String(e.employeeEmail).trim() : null;
      const label = e.label ? String(e.label).trim() : null;
      const periodStart = e.periodStart ? toSqlDateOnly(e.periodStart) : null;
      const periodEnd = e.periodEnd ? toSqlDateOnly(e.periodEnd) : null;
      const paymentDate = e.paymentDate ? toSqlDateOnly(e.paymentDate) : null;
      const paymentMode = e.paymentMode ? String(e.paymentMode).trim() : null;
      const bankAccount = e.bankAccount ? String(e.bankAccount).trim() : null;
      const note = e.note ? String(e.note).trim() : null;
      const month = e.month ? String(e.month).trim() : "unknown";
      const status = e.status === "paid" ? "paid" : e.status === "approved" ? "approved" : "pending";
      await conn.execute(
        `INSERT INTO \`lff_salaries\`
          (\`id\`, \`company_id\`, \`employee_id\`, \`employee_name\`, \`employee_email\`, \`label\`, \`period_start\`, \`period_end\`, \`payment_date\`, \`payment_mode\`, \`bank_account\`, \`note\`, \`month\`, \`basic\`, \`hra\`, \`transport\`, \`medical\`, \`bonus\`, \`overtime\`, \`tax\`, \`pf\`, \`insurance\`, \`gross_pay\`, \`total_deductions\`, \`net_pay\`, \`status\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           \`company_id\` = VALUES(\`company_id\`),
           \`employee_name\` = VALUES(\`employee_name\`),
           \`employee_email\` = VALUES(\`employee_email\`),
           \`label\` = VALUES(\`label\`),
           \`period_start\` = VALUES(\`period_start\`),
           \`period_end\` = VALUES(\`period_end\`),
           \`payment_date\` = VALUES(\`payment_date\`),
           \`payment_mode\` = VALUES(\`payment_mode\`),
           \`bank_account\` = VALUES(\`bank_account\`),
           \`note\` = VALUES(\`note\`),
           \`month\` = VALUES(\`month\`),
           \`basic\` = VALUES(\`basic\`),
           \`hra\` = VALUES(\`hra\`),
           \`transport\` = VALUES(\`transport\`),
           \`medical\` = VALUES(\`medical\`),
           \`bonus\` = VALUES(\`bonus\`),
           \`overtime\` = VALUES(\`overtime\`),
           \`tax\` = VALUES(\`tax\`),
           \`pf\` = VALUES(\`pf\`),
           \`insurance\` = VALUES(\`insurance\`),
           \`gross_pay\` = VALUES(\`gross_pay\`),
           \`total_deductions\` = VALUES(\`total_deductions\`),
           \`net_pay\` = VALUES(\`net_pay\`),
           \`status\` = VALUES(\`status\`)`,
        [
          id, companyId, employeeId, employeeName, employeeEmail, label,
          periodStart, periodEnd, paymentDate, paymentMode, bankAccount, note, month,
          toSqlNumber(e.basic), toSqlNumber(e.hra), toSqlNumber(e.transport),
          toSqlNumber(e.medical), toSqlNumber(e.bonus), toSqlNumber(e.overtime),
          toSqlNumber(e.tax), toSqlNumber(e.pf), toSqlNumber(e.insurance),
          toSqlNumber(e.grossPay), toSqlNumber(e.totalDeductions), toSqlNumber(e.netPay),
          status
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

let expensesTableEnsured = false;
let expensesLegacyStateHydrated = false;
const DOLIBARR_EXPENSE_REPORT_TABLE = "nmy5_expensereport";
const DOLIBARR_EXPENSE_REPORT_LINE_TABLE = "nmy5_expensereport_det";
const DOLIBARR_EXPENSE_PAYMENT_TABLE = "nmy5_payment_expensereport";
const DOLIBARR_EXPENSE_PAYMENT_LINK_TABLE = "nmy5_paymentexpensereport_expensereport";
const DOLIBARR_ECM_FILES_TABLE = "nmy5_ecm_files";
const DOLIBARR_DEFAULT_EXPENSE_TYPE_ID = 28;
const dolibarrExpenseTableColumns = new Map<string, Set<string>>();

function normalizeExpenseStatus(value: unknown): Expense["status"] {
  if (value === "approved" || value === "rejected") return value;
  return "pending";
}

function normalizeExpenseInput(entry: unknown): Expense | null {
  if (!entry || typeof entry !== "object") return null;
  const item = entry as Record<string, unknown>;
  const id = toStringId(item.id);
  if (!id) return null;
  return {
    id,
    companyId: toNullableText(item.companyId) ?? undefined,
    userId: toRequiredText(item.userId, "unknown"),
    userName: toRequiredText(item.userName, "Unknown User"),
    category: toRequiredText(item.category, "General"),
    amount: toSqlNumber(item.amount),
    description: toRequiredText(item.description, ""),
    status: normalizeExpenseStatus(item.status),
    date: toSqlDateOnly(item.date),
    receipt: toNullableText(item.receipt) ?? undefined,
    periodStart: item.periodStart ? toSqlDateOnly(item.periodStart) : undefined,
    periodEnd: item.periodEnd ? toSqlDateOnly(item.periodEnd) : undefined,
    approverId: toNullableText(item.approverId) ?? undefined,
    approverName: toNullableText(item.approverName) ?? undefined,
    notePublic: toNullableText(item.notePublic) ?? undefined,
    notePrivate: toNullableText(item.notePrivate) ?? undefined,
    lineDate: item.lineDate ? toSqlDateOnly(item.lineDate) : undefined,
    projectId: toNullableText(item.projectId) ?? undefined,
    projectName: toNullableText(item.projectName) ?? undefined,
    salesTaxRate: toSqlNumber(item.salesTaxRate),
    unitPriceNet: toSqlNumber(item.unitPriceNet),
    unitPriceInclTax: toSqlNumber(item.unitPriceInclTax),
    quantity: toSqlNumber(item.quantity) || 1,
    documentName: toNullableText(item.documentName) ?? undefined,
    proofUrl: toNullableText(item.proofUrl) ?? undefined,
    proofName: toNullableText(item.proofName) ?? undefined,
    proofMimeType: toNullableText(item.proofMimeType) ?? undefined,
    proofSizeBytes:
      typeof item.proofSizeBytes === "number" && Number.isFinite(item.proofSizeBytes)
        ? Math.max(0, Math.trunc(item.proofSizeBytes))
        : null,
  };
}

function isWritableAppExpenseId(expenseId: string): boolean {
  return !expenseId.toLowerCase().startsWith("dolibarr_");
}

function buildDolibarrExpenseRef(expenseId: string): string {
  const cleaned = expenseId.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const suffix = cleaned.length >= 8 ? cleaned : createHash("sha1").update(expenseId).digest("hex").toUpperCase();
  return `LFF-${suffix.slice(0, 46)}`;
}

function parseExpenseIdFromDolibarrRef(ref: unknown): string | null {
  const value = String(ref || "").trim();
  if (!/^LFF-/i.test(value)) return null;
  const raw = value.slice(4).toLowerCase();
  if (/^[a-f0-9]{32}$/.test(raw)) {
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  }
  return raw || null;
}

function expenseStatusToDolibarrStatus(status: Expense["status"]): number {
  if (status === "approved") return 5;
  if (status === "rejected") return 99;
  return 2;
}

function dolibarrStatusToExpenseStatus(value: unknown): Expense["status"] {
  const status = Number(value);
  if (status === 5 || status === 6) return "approved";
  if (status === 99) return "rejected";
  return "pending";
}

async function getDolibarrTableColumns(
  conn: Pool | PoolConnection,
  tableName: string
): Promise<Set<string>> {
  const cached = dolibarrExpenseTableColumns.get(tableName);
  if (cached) return cached;
  const [rows] = await conn.query<any[]>(`SHOW COLUMNS FROM \`${tableName}\``);
  const columns = new Set((rows || []).map((row) => String(row.Field)));
  dolibarrExpenseTableColumns.set(tableName, columns);
  return columns;
}

async function ensureDolibarrExpenseTables(conn: Pool | PoolConnection): Promise<void> {
  const requiredTables = [
    DOLIBARR_EXPENSE_REPORT_TABLE,
    DOLIBARR_EXPENSE_REPORT_LINE_TABLE,
  ];
  for (const table of requiredTables) {
    const [rows] = await conn.query<any[]>("SHOW TABLES LIKE ?", [table]);
    if (!rows?.length) {
      throw new Error(`Dolibarr expense table ${table} was not found.`);
    }
    await getDolibarrTableColumns(conn, table);
  }
  for (const table of [DOLIBARR_EXPENSE_PAYMENT_TABLE, DOLIBARR_EXPENSE_PAYMENT_LINK_TABLE]) {
    const [rows] = await conn.query<any[]>("SHOW TABLES LIKE ?", [table]);
    if (rows?.length) {
      await getDolibarrTableColumns(conn, table);
    }
  }
}

async function ensureExpensesTable(): Promise<void> {
  if (expensesTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await ensureDolibarrExpenseTables(conn);
  expensesTableEnsured = true;
}

async function resolveDolibarrExpenseUserId(
  conn: Pool | PoolConnection,
  expense: Expense
): Promise<number | null> {
  const rawId = String(expense.userId || "").trim().toLowerCase();
  const directId =
    rawId.startsWith("dolibarr_") ? Number(rawId.replace("dolibarr_", "")) : Number(rawId);
  if (Number.isFinite(directId) && directId > 0) {
    const [rows] = await conn.query<any[]>("SELECT rowid FROM `nmy5_user` WHERE rowid = ? LIMIT 1", [directId]);
    if (rows?.[0]?.rowid) return Number(rows[0].rowid);
  }

  const name = normalizeWhitespace(expense.userName || "").toLowerCase();
  if (!name) return null;
  const compactName = name.replace(/\s+/g, "");
  const [rows] = await conn.query<any[]>(
    `SELECT rowid
       FROM \`nmy5_user\`
      WHERE LOWER(TRIM(CONCAT_WS(' ', firstname, lastname))) = ?
         OR LOWER(TRIM(CONCAT_WS(' ', lastname, firstname))) = ?
         OR LOWER(REPLACE(CONCAT_WS('', firstname, lastname), ' ', '')) = ?
         OR LOWER(REPLACE(CONCAT_WS('', lastname, firstname), ' ', '')) = ?
         OR LOWER(TRIM(login)) = ?
      LIMIT 1`,
    [name, name, compactName, compactName, compactName]
  );
  return rows?.[0]?.rowid ? Number(rows[0].rowid) : null;
}

async function resolveDolibarrExpenseAuthorId(
  conn: Pool | PoolConnection,
  requestUser?: AppUser | null
): Promise<number | null> {
  const email = normalizeEmailKey(requestUser?.email);
  if (email) {
    const [rows] = await conn.query<any[]>(
      "SELECT rowid FROM `nmy5_user` WHERE LOWER(TRIM(email)) = ? LIMIT 1",
      [email]
    );
    if (rows?.[0]?.rowid) return Number(rows[0].rowid);
  }
  const fallbackExpense: Expense = {
    id: "author",
    userId: requestUser?.id || "",
    userName: requestUser?.name || "",
    category: "General",
    amount: 0,
    description: "",
    status: "pending",
    date: new Date().toISOString().slice(0, 10),
  };
  return resolveDolibarrExpenseUserId(conn, fallbackExpense);
}

async function resolveDolibarrSuperAdminUserId(conn: Pool | PoolConnection): Promise<number | null> {
  const [namedRows] = await conn.query<any[]>(
    `SELECT rowid
       FROM \`nmy5_user\`
      WHERE LOWER(TRIM(login)) = 'superadmin'
         OR LOWER(TRIM(CONCAT_WS(' ', firstname, lastname))) = 'superadmin'
         OR LOWER(TRIM(lastname)) = 'superadmin'
      ORDER BY rowid ASC
      LIMIT 1`
  );
  if (namedRows?.[0]?.rowid) return Number(namedRows[0].rowid);

  const [adminRows] = await conn.query<any[]>(
    `SELECT rowid
       FROM \`nmy5_user\`
      WHERE admin = 1
        AND (statut IS NULL OR statut = 1)
      ORDER BY rowid ASC
      LIMIT 1`
  );
  if (adminRows?.[0]?.rowid) return Number(adminRows[0].rowid);

  const [fallbackRows] = await conn.query<any[]>(
    "SELECT rowid FROM `nmy5_user` WHERE rowid = 1 LIMIT 1"
  );
  return fallbackRows?.[0]?.rowid ? Number(fallbackRows[0].rowid) : null;
}

async function resolveDolibarrExpenseTypeId(
  conn: Pool | PoolConnection,
  category: string
): Promise<number> {
  const normalized = normalizeWhitespace(category || "").toLowerCase();
  if (normalized) {
    const [matches] = await conn.query<any[]>(
      `SELECT id
         FROM \`nmy5_c_type_fees\`
        WHERE active = 1
          AND (LOWER(TRIM(code)) = ? OR LOWER(TRIM(label)) = ?)
        LIMIT 1`,
      [normalized, normalized]
    ).catch(() => [null] as any);
    if (matches?.[0]?.id) return Number(matches[0].id);
  }

  const [preferred] = await conn.query<any[]>(
    "SELECT id FROM `nmy5_c_type_fees` WHERE id = ? LIMIT 1",
    [DOLIBARR_DEFAULT_EXPENSE_TYPE_ID]
  ).catch(() => [null] as any);
  if (preferred?.[0]?.id) return Number(preferred[0].id);

  const [firstActive] = await conn.query<any[]>(
    "SELECT id FROM `nmy5_c_type_fees` WHERE active = 1 ORDER BY id LIMIT 1"
  ).catch(() => [null] as any);
  return firstActive?.[0]?.id ? Number(firstActive[0].id) : DOLIBARR_DEFAULT_EXPENSE_TYPE_ID;
}

async function createDolibarrExpenseProofFile(
  conn: Pool | PoolConnection,
  expense: Expense,
  reportId: number,
  authorId: number | null
): Promise<number | null> {
  const proofUrl = toNullableText(expense.proofUrl || expense.receipt);
  if (!proofUrl) return null;
  const [tableRows] = await conn.query<any[]>("SHOW TABLES LIKE ?", [DOLIBARR_ECM_FILES_TABLE]);
  if (!tableRows?.length) return null;

  const proofName =
    toNullableText(expense.proofName || expense.documentName) ||
    proofUrl.split("/").pop() ||
    `expense-proof-${reportId}`;
  const ref = `LFF-PROOF-${String(expense.id).replace(/[^a-z0-9]/gi, "").slice(0, 38).toUpperCase()}`;
  const filepath = `expensereport/${reportId}`;
  try {
    const [existingRows] = await conn.query<any[]>(
      `SELECT rowid FROM \`${DOLIBARR_ECM_FILES_TABLE}\` WHERE ref = ? LIMIT 1`,
      [ref]
    );
    if (existingRows?.[0]?.rowid) return Number(existingRows[0].rowid);

    const rowId = await insertDolibarrRow(conn, DOLIBARR_ECM_FILES_TABLE, {
      ref,
      entity: 1,
      filepath,
      filename: proofName,
      label: proofName,
      fullpath_orig: proofUrl,
      description: proofUrl,
      keywords: "expense proof",
      src_object_type: "expensereport",
      src_object_id: reportId,
      date_c: toSqlTimestamp(new Date()),
      fk_user_c: authorId,
      fk_user_m: authorId,
      acl: null,
      import_key: expense.id,
    });
    return rowId > 0 ? rowId : null;
  } catch {
    return null;
  }
}

function pickColumns(
  columns: Set<string>,
  values: Record<string, unknown>
): { fields: string[]; params: unknown[] } {
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const [field, value] of Object.entries(values)) {
    if (!columns.has(field) || typeof value === "undefined") continue;
    fields.push(field);
    params.push(value);
  }
  return { fields, params };
}

async function insertDolibarrRow(
  conn: Pool | PoolConnection,
  tableName: string,
  values: Record<string, unknown>
): Promise<number> {
  const columns = await getDolibarrTableColumns(conn, tableName);
  const { fields, params } = pickColumns(columns, values);
  await conn.execute(
    `INSERT INTO \`${tableName}\` (${fields.map((field) => `\`${field}\``).join(", ")})
     VALUES (${fields.map(() => "?").join(", ")})`,
    params as any[]
  );
  const [rows] = await conn.query<any[]>("SELECT LAST_INSERT_ID() AS id");
  return Number(rows?.[0]?.id || 0);
}

async function updateDolibarrRow(
  conn: Pool | PoolConnection,
  tableName: string,
  rowId: number,
  values: Record<string, unknown>
): Promise<void> {
  const columns = await getDolibarrTableColumns(conn, tableName);
  const { fields, params } = pickColumns(columns, values);
  if (!fields.length) return;
  await conn.execute(
    `UPDATE \`${tableName}\`
        SET ${fields.map((field) => `\`${field}\` = ?`).join(", ")}
      WHERE \`rowid\` = ?`,
    [...params, rowId] as any[]
  );
}

async function upsertDolibarrExpenseRecord(
  conn: Pool | PoolConnection,
  expense: Expense,
  requestUser?: AppUser | null
): Promise<void> {
  const fkUser = await resolveDolibarrExpenseUserId(conn, expense);
  if (!fkUser) {
    throw new Error(`Dolibarr user not found for expense user ${expense.userName}.`);
  }
  const authorId = (await resolveDolibarrExpenseAuthorId(conn, requestUser)) ?? fkUser;
  const superAdminId = (await resolveDolibarrSuperAdminUserId(conn)) ?? authorId;
  const expenseDate = toSqlDateOnly(expense.date);
  const periodStart = toSqlDateOnly(expense.periodStart || expense.date);
  const periodEnd = toSqlDateOnly(expense.periodEnd || expense.periodStart || expense.date);
  const lineDate = toSqlDateOnly(expense.lineDate || expense.date);
  const quantity = Math.max(toSqlNumber(expense.quantity) || 1, 0.000001);
  const taxRate = Math.max(toSqlNumber(expense.salesTaxRate), 0);
  const unitInclTaxInput = toSqlNumber(expense.unitPriceInclTax);
  const unitNetInput = toSqlNumber(expense.unitPriceNet);
  const fallbackTotal = toSqlNumber(expense.amount);
  const unitInclTax =
    unitInclTaxInput > 0
      ? unitInclTaxInput
      : unitNetInput > 0
        ? unitNetInput * (1 + taxRate / 100)
        : fallbackTotal / quantity;
  const unitNet =
    unitNetInput > 0
      ? unitNetInput
      : taxRate > 0
        ? unitInclTax / (1 + taxRate / 100)
        : unitInclTax;
  const totalHt = Number((unitNet * quantity).toFixed(8));
  const amount = Number(((unitInclTax || unitNet) * quantity).toFixed(8));
  const vatAmount = Math.max(Number((amount - totalHt).toFixed(8)), 0);
  const status = expenseStatusToDolibarrStatus(expense.status);
  const ref = buildDolibarrExpenseRef(expense.id);
  const notePrivate = [
    `LFF expense id: ${expense.id}`,
    `category: ${expense.category}`,
    expense.notePrivate ? expense.notePrivate : "",
    "approver: SuperAdmin",
    expense.projectName ? `project: ${expense.projectName}` : "",
    expense.receipt ? `receipt: ${expense.receipt}` : "",
    expense.documentName ? `document: ${expense.documentName}` : "",
    expense.proofUrl ? `proof: ${expense.proofUrl}` : "",
  ].filter(Boolean).join("\n");
  const notePublic = expense.notePublic || expense.description;
  const projectId = Number(expense.projectId);
  const fkProject = Number.isFinite(projectId) && projectId > 0 ? Math.trunc(projectId) : 0;

  const [existingRows] = await conn.query<any[]>(
    `SELECT rowid FROM \`${DOLIBARR_EXPENSE_REPORT_TABLE}\` WHERE ref = ? LIMIT 1`,
    [ref]
  );
  const existingRowId = existingRows?.[0]?.rowid ? Number(existingRows[0].rowid) : null;
  const headerValues: Record<string, unknown> = {
    ref,
    entity: 1,
    total_ht: totalHt,
    total_tva: vatAmount,
    localtax1: 0,
    localtax2: 0,
    total_ttc: amount,
    date_debut: periodStart,
    date_fin: periodEnd,
    date_create: toSqlTimestamp(new Date()),
    date_valid: status >= 2 && status !== 99 ? toSqlTimestamp(new Date()) : null,
    date_approve: status === 5 ? toSqlTimestamp(new Date()) : null,
    date_refuse: status === 99 ? toSqlTimestamp(new Date()) : null,
    fk_user_author: fkUser,
    fk_user_creat: authorId,
    fk_user_modif: authorId,
    fk_user_valid: status >= 2 && status !== 99 ? superAdminId : null,
    fk_user_validator: superAdminId,
    fk_user_approve: status === 5 ? superAdminId : null,
    fk_user_refuse: status === 99 ? authorId : null,
    fk_statut: status,
    paid: 0,
    note_public: notePublic,
    note_private: notePrivate,
    multicurrency_code: "INR",
    multicurrency_tx: 1,
    multicurrency_total_ht: totalHt,
    multicurrency_total_tva: vatAmount,
    multicurrency_total_ttc: amount,
    extraparams: JSON.stringify({ lffExpenseId: expense.id }).slice(0, 255),
  };

  const reportId = existingRowId
    ? (await updateDolibarrRow(conn, DOLIBARR_EXPENSE_REPORT_TABLE, existingRowId, headerValues), existingRowId)
    : await insertDolibarrRow(conn, DOLIBARR_EXPENSE_REPORT_TABLE, headerValues);

  const expenseTypeId = await resolveDolibarrExpenseTypeId(conn, expense.category);
  const proofEcmFileId = await createDolibarrExpenseProofFile(conn, expense, reportId, authorId);
  const proofDocNumber = expense.proofUrl || expense.receipt || expense.documentName || null;
  await conn.execute(
    `DELETE FROM \`${DOLIBARR_EXPENSE_REPORT_LINE_TABLE}\` WHERE \`fk_expensereport\` = ?`,
    [reportId]
  );
  await insertDolibarrRow(conn, DOLIBARR_EXPENSE_REPORT_LINE_TABLE, {
    fk_expensereport: reportId,
    docnumber: proofDocNumber,
    fk_c_type_fees: expenseTypeId,
    fk_c_exp_tax_cat: null,
    fk_projet: fkProject,
    comments: expense.description,
    product_type: -1,
    qty: quantity,
    subprice: unitNet,
    subprice_ttc: unitInclTax,
    value_unit: unitInclTax,
    remise_percent: 0,
    vat_src_code: "",
    tva_tx: taxRate,
    localtax1_tx: 0,
    localtax1_type: "0",
    localtax2_tx: 0,
    localtax2_type: "0",
    total_ht: totalHt,
    total_tva: vatAmount,
    total_localtax1: 0,
    total_localtax2: 0,
    total_ttc: amount,
    date: lineDate,
    info_bits: 0,
    special_code: 0,
    fk_facture: 0,
    fk_code_ventilation: 0,
    fk_ecm_files: proofEcmFileId,
    rang: 0,
    multicurrency_code: "INR",
    multicurrency_subprice: unitNet,
    multicurrency_subprice_ttc: unitInclTax,
    multicurrency_total_ht: totalHt,
    multicurrency_total_tva: vatAmount,
    multicurrency_total_ttc: amount,
  });
}

async function replaceExpensesInMySql(entries: unknown[], requestUser?: AppUser | null): Promise<void> {
  await ensureExpensesTable();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureDolibarrExpenseTables(conn);
    for (const entry of entries) {
      const expense = normalizeExpenseInput(entry);
      if (!expense || !isWritableAppExpenseId(expense.id)) continue;
      await upsertDolibarrExpenseRecord(conn, expense, requestUser);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function hydrateExpensesFromLegacyStateIfNeeded(): Promise<void> {
  if (expensesLegacyStateHydrated || !isMySqlStateEnabled()) return;
  expensesLegacyStateHydrated = true;
  await ensureExpensesTable();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT COUNT(*) AS total FROM \`${DOLIBARR_EXPENSE_REPORT_TABLE}\` WHERE ref LIKE 'LFF-%'`
  );
  const currentCount = Number(rows?.[0]?.total);
  if (Number.isFinite(currentCount) && currentCount > 0) return;

  const raw = await getMySqlStateValue("@trackforce_expenses").catch(() => null);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    await replaceExpensesInMySql(parsed);
  } catch {
    // ignore malformed legacy expenses payload
  }
}

function buildDolibarrExpenseUserName(row: Record<string, unknown>): string {
  const first = normalizeWhitespace(String(row.firstname || ""));
  const last = normalizeWhitespace(String(row.lastname || ""));
  const joined = `${first} ${last}`.trim();
  return joined || normalizeWhitespace(String(row.login || "")) || `User ${String(row.fk_user_author || "")}`;
}

async function listExpensesFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureExpensesTable();
  await hydrateExpensesFromLegacyStateIfNeeded();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(`
    SELECT er.rowid AS report_rowid, er.ref, er.total_ttc AS report_total_ttc, er.fk_statut,
           er.date_debut, er.note_public, er.note_private, er.fk_user_author,
           erd.rowid AS line_rowid, erd.comments, erd.total_ttc AS line_total_ttc, erd.date AS line_date,
           erd.docnumber, erd.fk_ecm_files,
           ctf.label AS type_label, ctf.code AS type_code,
           u.firstname, u.lastname, u.login
      FROM \`${DOLIBARR_EXPENSE_REPORT_TABLE}\` er
      LEFT JOIN \`${DOLIBARR_EXPENSE_REPORT_LINE_TABLE}\` erd ON erd.fk_expensereport = er.rowid
      LEFT JOIN \`nmy5_c_type_fees\` ctf ON ctf.id = erd.fk_c_type_fees
      LEFT JOIN \`nmy5_user\` u ON u.rowid = er.fk_user_author
     ORDER BY COALESCE(erd.date, er.date_debut) DESC, er.rowid DESC, erd.rowid ASC
  `);
  return (rows || []).map((row) => ({
    id:
      parseExpenseIdFromDolibarrRef(row.ref) ||
      `dolibarr_expensereport_${String(row.report_rowid)}${row.line_rowid ? `_line_${String(row.line_rowid)}` : ""}`,
    companyId: undefined,
    userId: row.fk_user_author ? `dolibarr_${String(row.fk_user_author)}` : "unknown",
    userName: buildDolibarrExpenseUserName(row),
    category: toRequiredText(row.type_label || row.type_code, "General"),
    amount: toSqlNumber(row.line_total_ttc ?? row.report_total_ttc),
    description: toRequiredText(row.comments || row.note_public || row.note_private, ""),
    status: dolibarrStatusToExpenseStatus(row.fk_statut),
    date: toSqlDateOnly(row.line_date || row.date_debut),
    receipt: row.docnumber ? String(row.docnumber) : undefined,
    documentName: row.docnumber ? String(row.docnumber).split("/").pop() : undefined,
    proofUrl: row.docnumber ? String(row.docnumber) : undefined,
  }));
}

let supportTablesEnsured = false;
let supportLegacyStateHydrated = false;

function normalizeSupportThreadStatus(value: unknown): "open" | "closed" {
  return value === "closed" ? "closed" : "open";
}

function normalizeSupportThreadPriority(value: unknown): "normal" | "high" {
  return value === "high" ? "high" : "normal";
}

function toDbSupportThreadPriority(value: unknown): "medium" | "high" {
  return normalizeSupportThreadPriority(value) === "high" ? "high" : "medium";
}

function normalizeSupportCategory(value: unknown): string {
  const normalized = toNullableText(value);
  if (!normalized) return "general";
  return normalized.slice(0, 80);
}

function normalizeSupportAttachmentType(
  value: unknown
): "image" | "video" | "audio" | "document" | "other" {
  if (
    value === "image" ||
    value === "video" ||
    value === "audio" ||
    value === "document" ||
    value === "other"
  ) {
    return value;
  }
  return "other";
}

let supportAttachmentBlobsEnsured = false;

async function ensureSupportAttachmentBlobsTable(): Promise<void> {
  if (supportAttachmentBlobsEnsured || !isMySqlStateEnabled()) return;
  const pool = await getMySqlPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_support_attachment_blobs\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`url_path\` VARCHAR(700) NOT NULL,
      \`file_name\` VARCHAR(255) NOT NULL,
      \`mime_type\` VARCHAR(127) NOT NULL,
      \`file_size_bytes\` BIGINT NOT NULL,
      \`content\` LONGBLOB NOT NULL,
      \`created_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`idx_lff_support_attachment_blobs_url_path\` (\`url_path\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  supportAttachmentBlobsEnsured = true;
}

async function storeSupportAttachmentBlobInMySql({
  id,
  urlPath,
  fileName,
  mimeType,
  content,
  createdAt,
}: {
  id: string;
  urlPath: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  createdAt: string;
}): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureSupportAttachmentBlobsTable();
  const pool = await getMySqlPool();
  await pool.execute(
    `INSERT INTO \`lff_support_attachment_blobs\`
      (id, url_path, file_name, mime_type, file_size_bytes, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      url_path = VALUES(url_path),
      file_name = VALUES(file_name),
      mime_type = VALUES(mime_type),
      file_size_bytes = VALUES(file_size_bytes),
      content = VALUES(content)`,
    [
      id,
      urlPath,
      fileName,
      mimeType,
      content.length,
      content,
      toSqlTimestamp(createdAt),
    ]
  );
}

async function getSupportAttachmentBlobByPath(urlPath: string): Promise<{
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  content: Buffer;
} | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureSupportAttachmentBlobsTable();
  const pool = await getMySqlPool();
  const [rows] = await pool.execute(
    `SELECT file_name, mime_type, file_size_bytes, content
     FROM \`lff_support_attachment_blobs\`
     WHERE url_path = ?
     LIMIT 1`,
    [urlPath]
  );
  const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  const content = first?.content;
  if (!first || !Buffer.isBuffer(content)) return null;
  return {
    fileName: toRequiredText(first.file_name, "attachment"),
    mimeType: toRequiredText(first.mime_type, "application/octet-stream"),
    fileSizeBytes:
      typeof first.file_size_bytes === "number"
        ? first.file_size_bytes
        : Number(first.file_size_bytes) || content.length,
    content,
  };
}

async function ensureSupportTables(): Promise<void> {
  if (supportTablesEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_support_threads\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`subject\` VARCHAR(191) NOT NULL,
      \`category\` VARCHAR(80) NOT NULL,
      \`priority\` ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
      \`status\` ENUM('open','in_progress','closed') NOT NULL DEFAULT 'open',
      \`requested_by_id\` VARCHAR(64) NOT NULL,
      \`requested_by_name\` VARCHAR(191) NOT NULL,
      \`requested_by_role\` ENUM('admin','hr','manager','salesperson','employee') NOT NULL,
      \`assigned_to_id\` VARCHAR(64) NULL,
      \`assigned_to_name\` VARCHAR(191) NULL,
      \`assigned_to_role\` ENUM('admin','hr','manager','salesperson','employee') NULL,
      \`last_message\` LONGTEXT NULL,
      \`last_message_at\` DATETIME NULL,
      \`created_at\` DATETIME NOT NULL,
      \`updated_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_support_threads_status\` (\`status\`),
      KEY \`idx_lff_support_threads_company\` (\`company_id\`),
      KEY \`idx_lff_support_threads_requested_by\` (\`requested_by_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_support_messages\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`thread_id\` VARCHAR(64) NOT NULL,
      \`sender_id\` VARCHAR(64) NOT NULL,
      \`sender_name\` VARCHAR(191) NOT NULL,
      \`sender_role\` ENUM('admin','hr','manager','salesperson','employee') NOT NULL,
      \`body\` LONGTEXT NOT NULL,
      \`delivery_status\` ENUM('sent','delivered','seen') NOT NULL DEFAULT 'delivered',
      \`read_state\` ENUM('unread','read') NOT NULL DEFAULT 'unread',
      \`delivered_at\` DATETIME NULL,
      \`seen_at\` DATETIME NULL,
      \`seen_by_user_ids_json\` LONGTEXT NULL,
      \`created_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_support_messages_thread_time\` (\`thread_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_support_message_attachments\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`message_id\` VARCHAR(64) NOT NULL,
      \`thread_id\` VARCHAR(64) NOT NULL,
      \`file_url\` LONGTEXT NOT NULL,
      \`file_name\` VARCHAR(255) NULL,
      \`mime_type\` VARCHAR(127) NULL,
      \`file_size_bytes\` BIGINT NULL,
      \`attachment_type\` ENUM('image','video','audio','document','other') NOT NULL DEFAULT 'other',
      \`uploaded_by_id\` VARCHAR(64) NULL,
      \`created_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_support_msg_attach_message\` (\`message_id\`),
      KEY \`idx_lff_support_msg_attach_thread\` (\`thread_id\`),
      KEY \`idx_lff_support_msg_attach_created\` (\`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    ALTER TABLE \`lff_support_messages\`
      ADD COLUMN IF NOT EXISTS \`company_id\` VARCHAR(64) NULL AFTER \`id\`,
      ADD COLUMN IF NOT EXISTS \`delivery_status\` ENUM('sent','delivered','seen') NOT NULL DEFAULT 'delivered' AFTER \`body\`,
      ADD COLUMN IF NOT EXISTS \`read_state\` ENUM('unread','read') NOT NULL DEFAULT 'unread' AFTER \`delivery_status\`,
      ADD COLUMN IF NOT EXISTS \`delivered_at\` DATETIME NULL AFTER \`delivery_status\`,
      ADD COLUMN IF NOT EXISTS \`seen_at\` DATETIME NULL AFTER \`delivered_at\`,
      ADD COLUMN IF NOT EXISTS \`seen_by_user_ids_json\` LONGTEXT NULL AFTER \`seen_at\`
  `);
  await conn.execute(`
    ALTER TABLE \`lff_support_message_attachments\`
      ADD COLUMN IF NOT EXISTS \`company_id\` VARCHAR(64) NULL AFTER \`id\`,
      ADD COLUMN IF NOT EXISTS \`file_name\` VARCHAR(255) NULL AFTER \`file_url\`,
      ADD COLUMN IF NOT EXISTS \`mime_type\` VARCHAR(127) NULL AFTER \`file_name\`,
      ADD COLUMN IF NOT EXISTS \`file_size_bytes\` BIGINT NULL AFTER \`mime_type\`,
      ADD COLUMN IF NOT EXISTS \`attachment_type\` ENUM('image','video','audio','document','other') NOT NULL DEFAULT 'other' AFTER \`file_size_bytes\`,
      ADD COLUMN IF NOT EXISTS \`uploaded_by_id\` VARCHAR(64) NULL AFTER \`attachment_type\`,
      ADD COLUMN IF NOT EXISTS \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER \`uploaded_by_id\`
  `);
  await conn.execute(`
    UPDATE \`lff_support_messages\`
    SET \`read_state\` = 'read'
    WHERE \`delivery_status\` = 'seen' OR \`seen_at\` IS NOT NULL
  `);
  supportTablesEnsured = true;
}

async function replaceSupportThreadsInMySql(entries: unknown[]): Promise<void> {
  await ensureSupportTables();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_support_message_attachments");
    await conn.execute("DELETE FROM lff_support_messages");
    await conn.execute("DELETE FROM lff_support_threads");

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const threadId = toStringId(item.id);
      if (!threadId) continue;

      const companyId = toNullableText(item.companyId);
      const subject = toRequiredText(item.subject, "Support Request");
      const category = normalizeSupportCategory(item.category);
      const priority = toDbSupportThreadPriority(item.priority);
      const status = normalizeSupportThreadStatus(item.status);
      const requestedById = toRequiredText(item.requestedById, "system");
      const requestedByName = toRequiredText(item.requestedByName, "User");
      const requestedByRole = normalizeRole(item.requestedByRole);
      const assignedToId = toNullableText(item.assignedToId);
      const assignedToName = toNullableText(item.assignedToName);
      const assignedToRole = assignedToId ? normalizeRole(item.assignedToRole) : null;
      const createdAt = toSqlTimestamp(item.createdAt);
      const updatedAt = toSqlTimestamp(item.updatedAt ?? item.createdAt);

      const sourceMessages = Array.isArray(item.messages) ? item.messages : [];
      const normalizedMessages: Array<{
        id: string;
        senderId: string;
        senderName: string;
        senderRole: UserRole;
        body: string;
        attachments: Array<{
          id: string;
          fileUrl: string;
          fileName: string | null;
          mimeType: string | null;
          fileSizeBytes: number | null;
          attachmentType: "image" | "video" | "audio" | "document" | "other";
          uploadedById: string | null;
          createdAt: string;
        }>;
        deliveryStatus: "sent" | "delivered" | "seen";
        readState: "unread" | "read";
        deliveredAt: string | null;
        seenAt: string | null;
        seenByUserIdsJson: string | null;
        createdAt: string;
      }> = [];

      for (const rawMessage of sourceMessages) {
        if (!rawMessage || typeof rawMessage !== "object") continue;
        const message = rawMessage as Record<string, unknown>;
        const body = toNullableText(message.message ?? message.body) || "";
        const senderId = toRequiredText(message.senderId, requestedById);
        const sourceAttachments = Array.isArray(message.attachments) ? message.attachments : [];
        const normalizedAttachments: Array<{
          id: string;
          fileUrl: string;
          fileName: string | null;
          mimeType: string | null;
          fileSizeBytes: number | null;
          attachmentType: "image" | "video" | "audio" | "document" | "other";
          uploadedById: string | null;
          createdAt: string;
        }> = [];
        for (const rawAttachment of sourceAttachments) {
          if (!rawAttachment || typeof rawAttachment !== "object") continue;
          const attachment = rawAttachment as Record<string, unknown>;
          const fileUrl = toNullableText(attachment.url ?? attachment.fileUrl);
          if (!fileUrl) continue;
          const parsedSize =
            typeof attachment.sizeBytes === "number" && Number.isFinite(attachment.sizeBytes)
              ? Math.max(0, Math.floor(attachment.sizeBytes))
              : typeof attachment.fileSizeBytes === "number" && Number.isFinite(attachment.fileSizeBytes)
                ? Math.max(0, Math.floor(attachment.fileSizeBytes))
                : null;
          normalizedAttachments.push({
            id: toStringId(attachment.id) || `support_att_${randomUUID()}`,
            fileUrl,
            fileName: toNullableText(attachment.name ?? attachment.fileName),
            mimeType: toNullableText(attachment.mimeType ?? attachment.fileMime),
            fileSizeBytes: parsedSize,
            attachmentType: normalizeSupportAttachmentType(attachment.attachmentType),
            uploadedById: toNullableText(attachment.uploadedById),
            createdAt: toSqlTimestamp(attachment.createdAt ?? message.createdAt),
          });
        }
        if (!body && normalizedAttachments.length === 0) continue;
        const seenByUserIds = parseStringArrayJson(message.seenByIds);
        const hasRecipientSeen = seenByUserIds.some((entry) => entry !== senderId);
        const normalizedSeenAt = toNullableText(message.seenAt) ? toSqlTimestamp(message.seenAt) : null;
        const readState: "unread" | "read" =
          message.deliveryStatus === "seen" || Boolean(normalizedSeenAt) || hasRecipientSeen
            ? "read"
            : "unread";
        normalizedMessages.push({
          id: toStringId(message.id) || `support_msg_${randomUUID()}`,
          senderId,
          senderName: toRequiredText(message.senderName, requestedByName),
          senderRole: normalizeRole(message.senderRole ?? requestedByRole),
          body,
          attachments: normalizedAttachments,
          deliveryStatus:
            message.deliveryStatus === "sent" || message.deliveryStatus === "seen"
              ? message.deliveryStatus
              : "delivered",
          readState,
          deliveredAt: toNullableText(message.deliveredAt)
            ? toSqlTimestamp(message.deliveredAt)
            : null,
          seenAt: normalizedSeenAt,
          seenByUserIdsJson: JSON.stringify(seenByUserIds),
          createdAt: toSqlTimestamp(message.createdAt),
        });
      }

      const lastMessageCandidate =
        normalizedMessages.length > 0
          ? normalizedMessages[normalizedMessages.length - 1]
          : null;
      const lastMessageFromCandidate = lastMessageCandidate
        ? lastMessageCandidate.body ||
          (lastMessageCandidate.attachments.length === 1
            ? "[Attachment]"
            : lastMessageCandidate.attachments.length > 1
              ? `[${lastMessageCandidate.attachments.length} attachments]`
              : "")
        : "";
      const lastMessage = lastMessageFromCandidate || toNullableText(item.lastMessage);
      const lastMessageAt = lastMessageCandidate
        ? lastMessageCandidate.createdAt
        : toNullableText(item.lastMessageAt)
          ? toSqlTimestamp(item.lastMessageAt)
          : null;

      await conn.execute(
        `INSERT INTO lff_support_threads
          (id, company_id, subject, category, priority, status, requested_by_id, requested_by_name,
           requested_by_role, assigned_to_id, assigned_to_name, assigned_to_role,
           last_message, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          companyId,
          subject,
          category,
          priority,
          status,
          requestedById,
          requestedByName,
          requestedByRole,
          assignedToId,
          assignedToName,
          assignedToRole,
          lastMessage,
          lastMessageAt,
          createdAt,
          updatedAt,
        ]
      );

      for (const message of normalizedMessages) {
        await conn.execute(
          `INSERT INTO lff_support_messages
            (id, company_id, thread_id, sender_id, sender_name, sender_role, body, delivery_status, read_state, delivered_at, seen_at, seen_by_user_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.id,
            companyId,
            threadId,
            message.senderId,
            message.senderName,
            message.senderRole,
            message.body,
            message.deliveryStatus,
            message.readState,
            message.deliveredAt,
            message.seenAt,
            message.seenByUserIdsJson,
            message.createdAt,
          ]
        );
        for (const attachment of message.attachments) {
          await conn.execute(
            `INSERT INTO lff_support_message_attachments
              (id, company_id, message_id, thread_id, file_url, file_name, mime_type, file_size_bytes, attachment_type, uploaded_by_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              attachment.id,
              companyId,
              message.id,
              threadId,
              attachment.fileUrl,
              attachment.fileName,
              attachment.mimeType,
              attachment.fileSizeBytes,
              attachment.attachmentType,
              attachment.uploadedById,
              attachment.createdAt,
            ]
          );
        }
      }
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function hydrateSupportThreadsFromLegacyStateIfNeeded(): Promise<void> {
  if (supportLegacyStateHydrated || !isMySqlStateEnabled()) return;
  supportLegacyStateHydrated = true;
  await ensureSupportTables();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>("SELECT COUNT(*) AS total FROM lff_support_threads");
  const currentCount = Number(rows?.[0]?.total);
  if (Number.isFinite(currentCount) && currentCount > 0) return;

  const raw = await getMySqlStateValue("@trackforce_support_threads").catch(() => null);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    await replaceSupportThreadsInMySql(parsed);
  } catch {
    // ignore malformed legacy support payload
  }
}

async function listSupportThreadsFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureSupportTables();
  await hydrateSupportThreadsFromLegacyStateIfNeeded();
  const conn = await getMySqlPool();

  const [threadRows] = await conn.query<any[]>(`
    SELECT id, company_id, subject, category, priority, status, requested_by_id, requested_by_name,
           requested_by_role, assigned_to_id, assigned_to_name, assigned_to_role,
           last_message, last_message_at, created_at, updated_at
    FROM lff_support_threads
    ORDER BY updated_at DESC, created_at DESC
  `);
  if (!threadRows?.length) return [];

  const [messageRows] = await conn.query<any[]>(`
    SELECT id, thread_id, sender_id, sender_name, sender_role, body,
           delivery_status, read_state, delivered_at, seen_at, seen_by_user_ids_json, created_at
    FROM lff_support_messages
    ORDER BY thread_id ASC, created_at ASC
  `);
  const [attachmentRows] = await conn.query<any[]>(`
    SELECT id, message_id, thread_id, file_url, file_name, mime_type, file_size_bytes, attachment_type, uploaded_by_id, created_at
    FROM lff_support_message_attachments
    ORDER BY message_id ASC, created_at ASC
  `);

  const nowIso = new Date().toISOString();
  const attachmentsByMessage = new Map<string, Array<Record<string, unknown>>>();
  for (const row of attachmentRows || []) {
    const messageId = row?.message_id ? String(row.message_id) : "";
    if (!messageId) continue;
    const fileUrl = toRequiredText(row?.file_url, "");
    if (!fileUrl) continue;
    const current = attachmentsByMessage.get(messageId) || [];
    current.push({
      id: row?.id ? String(row.id) : `support_att_${randomUUID()}`,
      messageId,
      threadId: row?.thread_id ? String(row.thread_id) : undefined,
      url: fileUrl,
      name: toNullableText(row?.file_name) || undefined,
      mimeType: toNullableText(row?.mime_type) || undefined,
      sizeBytes:
        typeof row?.file_size_bytes === "number" && Number.isFinite(row.file_size_bytes)
          ? Math.max(0, Math.floor(row.file_size_bytes))
          : null,
      attachmentType: normalizeSupportAttachmentType(row?.attachment_type),
      uploadedById: toNullableText(row?.uploaded_by_id),
      createdAt: toIsoTimestamp(row?.created_at, nowIso),
    });
    attachmentsByMessage.set(messageId, current);
  }

  const messagesByThread = new Map<string, Array<Record<string, unknown>>>();
  for (const row of messageRows || []) {
    const threadId = row?.thread_id ? String(row.thread_id) : "";
    if (!threadId) continue;
    const normalizedReadState: "unread" | "read" = row?.read_state === "read" ? "read" : "unread";
    const normalizedSeenAt = row?.seen_at ? toIsoTimestamp(row.seen_at, nowIso) : null;
    const nextMessage: Record<string, unknown> = {
      id: row?.id ? String(row.id) : `support_msg_${randomUUID()}`,
      senderId: row?.sender_id ? String(row.sender_id) : "system",
      senderName: toRequiredText(row?.sender_name, "User"),
      senderRole: normalizeRole(row?.sender_role),
      message: toRequiredText(row?.body, ""),
      deliveryStatus:
        normalizedReadState === "read"
          ? "seen"
          : row?.delivery_status === "sent" || row?.delivery_status === "seen"
            ? row.delivery_status
            : "delivered",
      readState: normalizedReadState,
      deliveredAt: row?.delivered_at ? toIsoTimestamp(row.delivered_at, nowIso) : null,
      seenAt: normalizedReadState === "read" ? normalizedSeenAt || nowIso : normalizedSeenAt,
      seenByIds: parseStringArrayJson(row?.seen_by_user_ids_json),
      attachments: attachmentsByMessage.get(row?.id ? String(row.id) : "") || [],
      createdAt: toIsoTimestamp(row?.created_at, nowIso),
    };
    const current = messagesByThread.get(threadId) || [];
    current.push(nextMessage);
    messagesByThread.set(threadId, current);
  }

  return threadRows.map((row) => {
    const threadId = String(row.id);
    return {
      id: threadId,
      companyId: row.company_id ? String(row.company_id) : undefined,
      subject: toRequiredText(row.subject, "Support Request"),
      requestedById: toRequiredText(row.requested_by_id, "system"),
      requestedByName: toRequiredText(row.requested_by_name, "User"),
      requestedByRole: normalizeRole(row.requested_by_role),
      status: normalizeSupportThreadStatus(row.status),
      priority: normalizeSupportThreadPriority(row.priority),
      createdAt: toIsoTimestamp(row.created_at, nowIso),
      updatedAt: toIsoTimestamp(row.updated_at, nowIso),
      messages: messagesByThread.get(threadId) || [],
    };
  });
}

let bankAccountsTableEnsured = false;
async function ensureBankAccountsTable(): Promise<void> {
  if (bankAccountsTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS \`lff_bank_accounts\` (
      \`id\` VARCHAR(64) NOT NULL,
      \`company_id\` VARCHAR(64) NULL,
      \`employee_id\` VARCHAR(64) NULL,
      \`employee_name\` VARCHAR(191) NOT NULL,
      \`employee_email\` VARCHAR(191) NOT NULL,
      \`account_type\` ENUM('bank','upi') NOT NULL DEFAULT 'bank',
      \`dolibarr_ref\` VARCHAR(32) NULL,
      \`dolibarr_label\` VARCHAR(191) NULL,
      \`dolibarr_type\` ENUM('savings','current','cash') NOT NULL DEFAULT 'current',
      \`currency_code\` VARCHAR(3) NOT NULL DEFAULT 'INR',
      \`country_code\` VARCHAR(8) NOT NULL DEFAULT 'IN',
      \`country_id\` INT NOT NULL DEFAULT 117,
      \`status\` ENUM('open','closed') NOT NULL DEFAULT 'open',
      \`bank_name\` VARCHAR(191) NULL,
      \`bank_address\` LONGTEXT NULL,
      \`account_number\` VARCHAR(64) NULL,
      \`ifsc_code\` VARCHAR(16) NULL,
      \`upi_id\` VARCHAR(191) NULL,
      \`holder_name\` VARCHAR(191) NULL,
      \`website\` VARCHAR(255) NULL,
      \`comment\` LONGTEXT NULL,
      \`is_default\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_at\` DATETIME NOT NULL,
      \`updated_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_lff_bank_accounts_email\` (\`employee_email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await conn.execute(`
    ALTER TABLE \`lff_bank_accounts\`
      ADD COLUMN IF NOT EXISTS \`company_id\` VARCHAR(64) NULL AFTER \`id\`,
      ADD COLUMN IF NOT EXISTS \`dolibarr_ref\` VARCHAR(32) NULL AFTER \`account_type\`,
      ADD COLUMN IF NOT EXISTS \`dolibarr_label\` VARCHAR(191) NULL AFTER \`dolibarr_ref\`,
      ADD COLUMN IF NOT EXISTS \`dolibarr_type\` ENUM('savings','current','cash') NOT NULL DEFAULT 'current' AFTER \`dolibarr_label\`,
      ADD COLUMN IF NOT EXISTS \`currency_code\` VARCHAR(3) NOT NULL DEFAULT 'INR' AFTER \`dolibarr_type\`,
      ADD COLUMN IF NOT EXISTS \`country_code\` VARCHAR(8) NOT NULL DEFAULT 'IN' AFTER \`currency_code\`,
      ADD COLUMN IF NOT EXISTS \`country_id\` INT NOT NULL DEFAULT 117 AFTER \`country_code\`,
      ADD COLUMN IF NOT EXISTS \`status\` ENUM('open','closed') NOT NULL DEFAULT 'open' AFTER \`country_id\`,
      ADD COLUMN IF NOT EXISTS \`bank_address\` LONGTEXT NULL AFTER \`bank_name\`,
      ADD COLUMN IF NOT EXISTS \`website\` VARCHAR(255) NULL AFTER \`holder_name\`,
      ADD COLUMN IF NOT EXISTS \`comment\` LONGTEXT NULL AFTER \`website\`
  `);
  bankAccountsTableEnsured = true;
}

function mapBankAccountRow(row: Record<string, unknown>): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    employeeId: row.employee_id ? String(row.employee_id) : undefined,
    employeeName: row.employee_name ? String(row.employee_name) : "",
    employeeEmail: row.employee_email ? String(row.employee_email) : "",
    accountType: row.account_type === "upi" ? "upi" : "bank",
    dolibarrRef: row.dolibarr_ref ? String(row.dolibarr_ref) : undefined,
    dolibarrLabel: row.dolibarr_label ? String(row.dolibarr_label) : undefined,
    dolibarrType:
      row.dolibarr_type === "savings" || row.dolibarr_type === "cash" ? String(row.dolibarr_type) : "current",
    currencyCode: row.currency_code ? String(row.currency_code) : "INR",
    countryCode: row.country_code ? String(row.country_code) : "IN",
    countryId:
      typeof row.country_id === "number" ? row.country_id : row.country_id ? Number(row.country_id) : 117,
    status: row.status === "closed" ? "closed" : "open",
    bankName: row.bank_name ? String(row.bank_name) : undefined,
    bankAddress: row.bank_address ? String(row.bank_address) : undefined,
    accountNumber: row.account_number ? String(row.account_number) : undefined,
    ifscCode: row.ifsc_code ? String(row.ifsc_code) : undefined,
    upiId: row.upi_id ? String(row.upi_id) : undefined,
    holderName: row.holder_name ? String(row.holder_name) : undefined,
    website: row.website ? String(row.website) : undefined,
    comment: row.comment ? String(row.comment) : undefined,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : nowIso,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : nowIso,
  };
}

async function readNormalizedState(key: string): Promise<unknown[] | undefined> {
  if (!isNormalizedStateKey(key)) return undefined;
  if (key === "@trackforce_companies") return listCompaniesFromMySql();
  if (key === "@trackforce_employees") return listEmployeesFromMySql();
  if (key === "@trackforce_attendance") return listAttendanceFromMySql();
  if (key === "@trackforce_expenses") return listExpensesFromMySql();
  if (key === "@trackforce_location_logs") {
    return listLocationLogsFromMySql(REMOTE_LOCATION_LOG_READ_LIMIT);
  }
  if (key === "@trackforce_conversations") {
    await migrateLegacyConversationsStateToMySql();
    return listConversationsFromMySql({ limit: 500 });
  }
  if (key === "@trackforce_stockists") return listStockistsFromMySql();
  if (key === "@trackforce_stock_transfers") return listStockTransfersFromMySql();
  if (key === "@trackforce_incentive_goal_plans") return listIncentiveGoalPlansFromMySql();
  if (key === "@trackforce_incentive_product_plans") return listIncentiveProductPlansFromMySql();
  if (key === "@trackforce_incentive_payouts") return listIncentivePayoutsFromMySql();
  if (key === "@trackforce_salaries") return listSalariesFromMySql();
  if (key === "@trackforce_support_threads") return listSupportThreadsFromMySql();
  return undefined;
}

function withDefaultCompanyIdForRemoteState(
  key: string,
  value: unknown,
  defaultCompanyId: string | null
): unknown {
  if (!defaultCompanyId || !COMPANY_SCOPED_REMOTE_STATE_KEYS.has(key) || !Array.isArray(value)) {
    return value;
  }
  let changed = false;
  const next = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    const currentCompanyId =
      typeof record.companyId === "string" ? normalizeWhitespace(record.companyId) : "";
    if (currentCompanyId) return entry;
    changed = true;
    return { ...record, companyId: defaultCompanyId };
  });
  return changed ? next : value;
}

async function writeNormalizedState(
  key: string,
  jsonValue: string,
  requestUser?: AppUser | null
): Promise<boolean> {
  if (!isNormalizedStateKey(key)) return false;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(jsonValue);
  } catch {
    parsed = null;
  }
  const entries = Array.isArray(parsed) ? parsed : [];
  if (key === "@trackforce_companies") {
    // Companies are now managed exclusively via backend APIs / DB.
    // We ignore incoming client syncs for this key to prevent stale cache overwrites.
    return true;
  }
  if (key === "@trackforce_attendance") {
    await mergeAttendanceInMySql(entries);
    return true;
  }
  if (key === "@trackforce_location_logs") {
    if (entries.length > REMOTE_LOCATION_LOG_WRITE_LIMIT) {
      throw new Error(
        `Location log state payload is too large (${entries.length} entries). Use /api/location/batch for log sync.`
      );
    }
    await mergeLocationLogsInMySql(entries);
    return true;
  }
  if (key === "@trackforce_conversations") {
    await mergeConversationsInMySql(entries);
    return true;
  }
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
  if (key === "@trackforce_salaries") {
    await replaceSalariesInMySql(entries);
    return true;
  }
  if (key === "@trackforce_expenses") {
    await replaceExpensesInMySql(entries, requestUser);
    return true;
  }
  if (key === "@trackforce_support_threads") {
    await replaceSupportThreadsInMySql(entries);
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

async function writeRemoteState(
  key: string,
  jsonValue: string,
  requestUser?: AppUser | null
): Promise<void> {
  if (isMySqlStateEnabled()) {
    let handled = false;
    try {
      handled = await writeNormalizedState(key, jsonValue, requestUser);
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
  if (role === "employee") return "Office Employees";
  return "On Field Employees";
}

function normalizeDepartmentForRole(role: UserRole, department?: string | null): string {
  const normalized = normalizeWhitespace(department ?? "");
  if (role === "salesperson" && (!normalized || normalized.toLowerCase() === "sales")) {
    return roleToDepartment("salesperson");
  }
  return normalized || roleToDepartment(role);
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

type CompanyProfileSummary = Pick<CompanyProfile, "id" | "name" | "primaryBranch">;

let companiesTableEnsured = false;
let legacyCompaniesStateMigrated = false;
let companyIdColumnsEnsured = false;
let configuredLegacyCompanyDataRehomeTargetId: string | null = null;
let configuredLegacyCompanyDataRehomePromise: Promise<void> | null = null;

function companyProfileFromRow(row: any): CompanyProfile {
  const nowIso = new Date().toISOString();
  const name = normalizeCompanyName(String(row?.name || DEFAULT_COMPANY_NAME));
  return {
    id: normalizeWhitespace(String(row?.id || getCompanyIdFromName(name))),
    name,
    legalName: normalizeWhitespace(String(row?.legal_name || `${name} Pvt Ltd`)) || `${name} Pvt Ltd`,
    industry: normalizeWhitespace(String(row?.industry || "General")) || "General",
    headquarters: normalizeWhitespace(String(row?.headquarters || "India")) || "India",
    primaryBranch: normalizeWhitespace(String(row?.primary_branch || "Main Branch")) || "Main Branch",
    supportEmail:
      normalizeEmail(String(row?.support_email || "")) ||
      `support@${name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "company"}.com`,
    supportPhone: normalizeWhitespace(String(row?.support_phone || "")),
    attendanceZoneLabel:
      normalizeWhitespace(String(row?.attendance_zone_label || `${name} Attendance Zone`)) ||
      `${name} Attendance Zone`,
    createdAt: row?.created_at ? toIsoTimestamp(row.created_at, nowIso) : nowIso,
    updatedAt: row?.updated_at ? toIsoTimestamp(row.updated_at, nowIso) : nowIso,
  };
}

function normalizeCompanyProfilePayload(input: Partial<CompanyProfile>): CompanyProfile {
  const nowIso = new Date().toISOString();
  const name = normalizeCompanyName(String(input.name || DEFAULT_COMPANY_NAME));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 48) || "company";
  return {
    id: normalizeWhitespace(input.id || "") || getCompanyIdFromName(name),
    name,
    legalName: normalizeWhitespace(input.legalName || `${name} Pvt Ltd`) || `${name} Pvt Ltd`,
    industry: normalizeWhitespace(input.industry || "General") || "General",
    headquarters: normalizeWhitespace(input.headquarters || "India") || "India",
    primaryBranch: normalizeWhitespace(input.primaryBranch || "Main Branch") || "Main Branch",
    supportEmail: normalizeEmail(input.supportEmail || `support@${slug}.com`) || `support@${slug}.com`,
    supportPhone: normalizeWhitespace(input.supportPhone || ""),
    attendanceZoneLabel:
      normalizeWhitespace(input.attendanceZoneLabel || `${name} Attendance Zone`) ||
      `${name} Attendance Zone`,
    createdAt: input.createdAt || nowIso,
    updatedAt: input.updatedAt || nowIso,
  };
}

function parseCompanyProfilesState(value: unknown): Map<string, CompanyProfileSummary> {
  const profiles = new Map<string, CompanyProfileSummary>();
  if (!Array.isArray(value)) return profiles;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const profile = normalizeCompanyProfilePayload(entry as Partial<CompanyProfile>);
    if (!profile.id || !profile.name) continue;
    profiles.set(profile.id, {
      id: profile.id,
      name: profile.name,
      primaryBranch: profile.primaryBranch,
    });
  }
  return profiles;
}

async function ensureCompaniesTableInMySql(): Promise<void> {
  if (companiesTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS lff_companies (
      id VARCHAR(64) NOT NULL,
      name VARCHAR(191) NOT NULL,
      legal_name VARCHAR(191) NOT NULL,
      industry VARCHAR(120) NOT NULL DEFAULT 'General',
      headquarters VARCHAR(191) NOT NULL DEFAULT 'India',
      primary_branch VARCHAR(191) NOT NULL DEFAULT 'Main Branch',
      support_email VARCHAR(191) NOT NULL DEFAULT 'support@company.com',
      support_phone VARCHAR(64) NOT NULL DEFAULT '',
      attendance_zone_label VARCHAR(191) NOT NULL DEFAULT 'Main Branch',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_lff_companies_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  try { await conn.execute("ALTER TABLE lff_companies ADD COLUMN weekend_days VARCHAR(255) DEFAULT '[0]'"); } catch(e) {}
  companiesTableEnsured = true;
}

async function upsertCompanyProfileInMySql(profile: CompanyProfile): Promise<CompanyProfile> {
  if (!isMySqlStateEnabled()) return profile;
  await ensureCompaniesTableInMySql();
  const conn = await getMySqlPool();
  const normalized = normalizeCompanyProfilePayload(profile);
  await conn.execute(
    `INSERT INTO lff_companies (
      id, name, legal_name, industry, headquarters, primary_branch, support_email, support_phone,
      attendance_zone_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      legal_name = VALUES(legal_name),
      industry = VALUES(industry),
      headquarters = VALUES(headquarters),
      primary_branch = VALUES(primary_branch),
      support_email = VALUES(support_email),
      support_phone = VALUES(support_phone),
      attendance_zone_label = VALUES(attendance_zone_label),
      updated_at = VALUES(updated_at)`,
    [
      normalized.id,
      normalized.name,
      normalized.legalName,
      normalized.industry,
      normalized.headquarters,
      normalized.primaryBranch,
      normalized.supportEmail,
      normalized.supportPhone,
      normalized.attendanceZoneLabel,
      normalized.createdAt.slice(0, 19).replace("T", " "),
      normalized.updatedAt.slice(0, 19).replace("T", " "),
    ]
  );
  return normalized;
}

async function migrateLegacyCompaniesStateToMySql(): Promise<void> {
  if (legacyCompaniesStateMigrated || !isMySqlStateEnabled()) return;
  await ensureCompaniesTableInMySql();
  const conn = await getMySqlPool();
  const [existingRows] = await conn.query<any[]>(`SELECT id FROM lff_companies LIMIT 1`);
  if (existingRows && existingRows.length > 0) {
    legacyCompaniesStateMigrated = true;
    return;
  }
  const raw = await getMySqlStateValue("@trackforce_companies").catch(() => null);
  const parsed = raw ? parseJsonText(raw) : null;
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      await upsertCompanyProfileInMySql(normalizeCompanyProfilePayload(entry as Partial<CompanyProfile>));
    }
  }
  legacyCompaniesStateMigrated = true;
}

async function listCompanyProfilesFromMySqlRaw(): Promise<CompanyProfile[]> {
  if (!isMySqlStateEnabled()) return [];
  await migrateLegacyCompaniesStateToMySql();
  await ensureCompaniesTableInMySql();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT id, name, legal_name, industry, headquarters, primary_branch, support_email,
            support_phone, attendance_zone_label, created_at, updated_at
     FROM lff_companies
     ORDER BY created_at DESC, name ASC`
  );
  return (rows || []).map((row) => companyProfileFromRow(row));
}

async function listCompaniesFromMySql(): Promise<CompanyProfile[]> {
  return listCompanyProfilesFromMySqlRaw();
}

async function persistCompaniesLegacyStateFromMySql(): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const companies = await listCompaniesFromMySql();
  await setMySqlStateValue("@trackforce_companies", JSON.stringify(companies));
}

async function replaceCompaniesInMySql(entries: unknown[]): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureCompaniesTableInMySql();
  const pool = await getMySqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("DELETE FROM lff_companies");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const profile = normalizeCompanyProfilePayload(entry as Partial<CompanyProfile>);
      await conn.execute(
        `INSERT INTO lff_companies (
          id, name, legal_name, industry, headquarters, primary_branch, support_email, support_phone,
          attendance_zone_label, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profile.id,
          profile.name,
          profile.legalName,
          profile.industry,
          profile.headquarters,
          profile.primaryBranch,
          profile.supportEmail,
          profile.supportPhone,
          profile.attendanceZoneLabel,
          profile.createdAt.slice(0, 19).replace("T", " "),
          profile.updatedAt.slice(0, 19).replace("T", " "),
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

async function listEmployeesFromMySql(): Promise<unknown[]> {
  if (!isMySqlStateEnabled()) return [];
  const byScope = new Map<string, Record<string, unknown>>();
  const addEmployee = (employee: Record<string, unknown>) => {
    const id = normalizeWhitespace(String(employee.id || ""));
    const email = normalizeEmail(String(employee.email || ""));
    const name = normalizeWhitespace(String(employee.name || ""));
    const companyId = normalizeWhitespace(String(employee.companyId || ""));
    if (isLegacyDemoProfileName(name)) return;
    if (!companyId || (!id && !email && !name)) return;
    const key = `${companyId}:${email || id || name.toLowerCase()}`;
    byScope.set(key, {
      status: "active",
      ...employee,
      id: id || email || `${companyId}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      email,
      name: name || email || "Employee",
      companyId,
      employeeCategory:
        employee.employeeCategory === "on_field" || isSalesRole(normalizeRole(employee.role))
          ? "on_field"
          : "fixed_location",
    });
  };

  const rawEmployees = await getMySqlStateValue("@trackforce_employees").catch(() => null);
  const parsedEmployees = rawEmployees ? parseJsonText(rawEmployees) : null;
  if (Array.isArray(parsedEmployees)) {
    for (const entry of parsedEmployees) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      addEmployee(entry as Record<string, unknown>);
    }
  }

  await ensureAccessRequestAssignmentColumns();
  const companies = await listCompanyProfilesFromMySqlRaw();
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const conn = await getMySqlPool();
  const [userRows] = await conn.query<any[]>(
    `SELECT rowid, login, email, firstname, lastname, admin, statut, employee, job,
            office_phone, user_mobile, datec
     FROM nmy5_user`
  );
  const dolibarrUserByEmail = new Map<string, any>();
  const dolibarrUserByLogin = new Map<string, any>();
  for (const row of userRows || []) {
    const email = normalizeEmail(String(row.email || ""));
    const login = normalizeLoginKey(String(row.login || ""));
    if (email) dolibarrUserByEmail.set(email, row);
    if (login) dolibarrUserByLogin.set(login, row);
  }

  const requests = await listAccessRequestsFromMySql("approved");
  for (const request of requests) {
    const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
    if (!assignedCompanyIds.length) continue;
    const email = normalizeEmail(request.email || "");
    const login = normalizeLoginKey(email.split("@")[0] || "");
    const dolibarrUser = (email && dolibarrUserByEmail.get(email)) || (login && dolibarrUserByLogin.get(login)) || null;
    const firstName = normalizeWhitespace(String(dolibarrUser?.firstname || ""));
    const lastName = normalizeWhitespace(String(dolibarrUser?.lastname || ""));
    const displayName =
      normalizeWhitespace(request.name) ||
      normalizeWhitespace(`${firstName} ${lastName}`) ||
      normalizeWhitespace(String(dolibarrUser?.login || "")) ||
      email ||
      "Employee";
    if (isLegacyDemoProfileName(displayName)) continue;
    let mappedRole = Number(dolibarrUser?.admin || 0) === 1 ? "admin" : null;
    if (!mappedRole && dolibarrUser?.job) {
      const jobStr = String(dolibarrUser.job).toLowerCase();
      if (jobStr.includes("on field") || jobStr.includes("sales")) {
        mappedRole = "salesperson";
      } else if (jobStr.includes("fixed") || jobStr.includes("office") || jobStr.includes("support") || jobStr.includes("hr")) {
        mappedRole = "employee";
      }
    }
    const role = normalizeRole(mappedRole || request.approvedRole || request.requestedRole || "salesperson");
    const isActive =
      dolibarrUser?.statut === undefined || dolibarrUser?.statut === null
        ? true
        : Number(dolibarrUser.statut) === 1;
    if (!isActive) continue;
    for (const companyId of assignedCompanyIds) {
      const company = companyById.get(companyId);
      addEmployee({
        id: dolibarrUser?.rowid ? String(dolibarrUser.rowid) : `access_${request.id}`,
        companyId,
        companyName: company?.name,
        name: displayName,
        role,
        department: normalizeDepartmentForRole(
          role,
          request.requestedDepartment || (dolibarrUser as any)?.department
        ),
        status: "active",
        email,
        phone: normalizeWhitespace(String(dolibarrUser?.user_mobile || dolibarrUser?.office_phone || "")),
        branch:
          normalizeWhitespace(request.requestedBranch || "") ||
          company?.primaryBranch ||
          "Main Branch",
        joinDate: dolibarrUser?.datec
          ? new Date(dolibarrUser.datec).toISOString().slice(0, 10)
          : request.reviewedAt?.slice(0, 10) || request.requestedAt.slice(0, 10),
        stockistId: request.assignedStockistId || undefined,
        stockistName: request.assignedStockistName || undefined,
        managerId: request.assignedManagerId || undefined,
        managerName: request.assignedManagerName || undefined,
      });
    }
  }

  return Array.from(byScope.values());
}

function isLegacyCompanyIdForRehome(value: unknown, validCompanyIds: Set<string>): boolean {
  const companyId = normalizeWhitespace(typeof value === "string" ? value : "");
  if (!companyId) return true;
  if (companyId === DEFAULT_COMPANY_ID || companyId === PENDING_COMPANY_ID) return true;
  return !validCompanyIds.has(companyId);
}

async function getColumnsForTable(conn: Pool | PoolConnection, tableName: string): Promise<Set<string>> {
  const [rows] = await conn.query<any[]>(
    `SELECT COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set((rows || []).map((row) => String(row.column_name || "")));
}

async function ensureCompanyIdColumnsForCompanyScopedTables(conn: Pool | PoolConnection): Promise<void> {
  if (companyIdColumnsEnsured || !isMySqlStateEnabled()) return;
  const excludedTables = new Set(["lff_auth_sessions", "lff_companies"]);
  const [rows] = await conn.query<any[]>(
    `SELECT table_info.TABLE_NAME AS table_name
     FROM INFORMATION_SCHEMA.TABLES table_info
     LEFT JOIN INFORMATION_SCHEMA.COLUMNS company_columns
       ON company_columns.TABLE_SCHEMA = table_info.TABLE_SCHEMA
      AND company_columns.TABLE_NAME = table_info.TABLE_NAME
      AND company_columns.COLUMN_NAME = 'company_id'
     WHERE table_info.TABLE_SCHEMA = DATABASE()
       AND table_info.TABLE_TYPE = 'BASE TABLE'
       AND table_info.TABLE_NAME LIKE 'lff\\_%'
       AND company_columns.COLUMN_NAME IS NULL`
  );

  for (const row of rows || []) {
    const tableName = String(row?.table_name || "");
    if (!/^lff_[a-zA-Z0-9_]+$/.test(tableName) || excludedTables.has(tableName)) continue;
    const columns = await getColumnsForTable(conn, tableName);
    const afterIdClause = columns.has("id") ? " AFTER `id`" : "";
    await conn.execute(
      `ALTER TABLE \`${tableName}\` ADD COLUMN IF NOT EXISTS \`company_id\` VARCHAR(64) NULL${afterIdClause}`
    );
  }
  companyIdColumnsEnsured = true;
}

async function ensureCompanyScopedSchemaInMySql(): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureCompaniesTableInMySql();
  const conn = await getMySqlPool();
  await ensureCompanyIdColumnsForCompanyScopedTables(conn);
}

async function rehomeLegacyCompanyDataToConfiguredCompany(): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const targetCompanyId = normalizeWhitespace(LEGACY_COMPANY_DATA_REHOME_TARGET_ID);
  if (!targetCompanyId || configuredLegacyCompanyDataRehomeTargetId === targetCompanyId) return;
  if (!configuredLegacyCompanyDataRehomePromise) {
    configuredLegacyCompanyDataRehomePromise = (async () => {
      const companies = await listCompanyProfilesFromMySqlRaw();
      const targetCompany = companies.find((company) => company.id === targetCompanyId);
      if (!targetCompany) {
        console.warn(`Legacy company data assignment skipped: company id ${targetCompanyId} was not found.`);
        return;
      }
      await rehomeLegacyCompanyDataToMySql(targetCompany, companies);
      await persistCompaniesLegacyStateFromMySql();
      configuredLegacyCompanyDataRehomeTargetId = targetCompanyId;
    })().finally(() => {
      configuredLegacyCompanyDataRehomePromise = null;
    });
  }
  await configuredLegacyCompanyDataRehomePromise;
}

async function rehomeLegacyCompanyDataToMySql(
  targetCompany: CompanyProfile,
  companies: CompanyProfile[]
): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const validCompanyIds = new Set(companies.map((company) => company.id));
  const conn = await getMySqlPool();
  await ensureCompanyIdColumnsForCompanyScopedTables(conn);
  const [companyScopedRows] = await conn.query<any[]>(
    `SELECT TABLE_NAME AS table_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME = 'company_id'
       AND TABLE_NAME LIKE 'lff\\_%'
       AND TABLE_NAME <> 'lff_companies'`
  );

  for (const row of companyScopedRows || []) {
    const tableName = String(row?.table_name || "");
    if (!/^lff_[a-zA-Z0-9_]+$/.test(tableName)) continue;
    const columns = await getColumnsForTable(conn, tableName);
    const setParts = ["company_id = ?"];
    const params: unknown[] = [targetCompany.id];
    if (columns.has("company_name")) {
      setParts.push("company_name = ?");
      params.push(targetCompany.name);
    }
    if (columns.has("company_ids_json")) {
      setParts.push("company_ids_json = ?");
      params.push(JSON.stringify([targetCompany.id]));
    }
    if (columns.has("updated_at")) {
      setParts.push("updated_at = NOW()");
    }
    if (columns.has("tms")) {
      setParts.push("tms = NOW()");
    }
    params.push(DEFAULT_COMPANY_ID, PENDING_COMPANY_ID);
    await conn.execute(
      `UPDATE \`${tableName}\` scoped
       SET ${setParts.join(", ")}
       WHERE scoped.company_id IS NULL
          OR scoped.company_id = ''
          OR scoped.company_id IN (?, ?)
          OR NOT EXISTS (
            SELECT 1 FROM lff_companies companies WHERE companies.id = scoped.company_id
          )`,
      params as any[]
    );
  }

  const [requestRows] = await conn.query<any[]>(
    `SELECT id, assigned_company_ids_json FROM lff_access_requests`
  ).catch(() => [[] as any[]]);
  for (const row of requestRows || []) {
    const requestId = String(row.id || "");
    if (!requestId) continue;
    const currentIds = parseStringArrayJson(row.assigned_company_ids_json);
    const validIds = currentIds.filter((companyId) => validCompanyIds.has(companyId));
    if (validIds.length === currentIds.length && validIds.length > 0) continue;
    const nextIds = validIds.length ? validIds : [targetCompany.id];
    await conn.execute(
      `UPDATE lff_access_requests SET assigned_company_ids_json = ? WHERE id = ?`,
      [JSON.stringify(nextIds), requestId]
    );
  }

  const stateKeys = Array.from(REMOTE_STATE_ALLOWED_KEYS).filter(
    (key) => key !== "@trackforce_companies"
  );
  for (const key of stateKeys) {
    const raw = await getMySqlStateValue(key).catch(() => null);
    const parsed = raw ? parseJsonText(raw) : null;
    if (!Array.isArray(parsed)) continue;
    let changed = false;
    const next = parsed.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const record = entry as Record<string, unknown>;
      if (!isLegacyCompanyIdForRehome(record.companyId, validCompanyIds)) return entry;
      changed = true;
      return { ...record, companyId: targetCompany.id };
    });
    if (changed) {
      await setMySqlStateValue(key, JSON.stringify(next));
    }
  }
}

async function deleteCompanyScopedRowsInMySql(
  companyId: string,
  fallbackCompany: CompanyProfile
): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT TABLE_NAME AS table_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME = 'company_id'
       AND TABLE_NAME LIKE 'lff\\_%'
       AND TABLE_NAME <> 'lff_companies'`
  );
  for (const row of rows || []) {
    const tableName = String(row?.table_name || "");
    if (!/^lff_[a-zA-Z0-9_]+$/.test(tableName)) continue;
    if (tableName === "lff_users") {
      try {
        await conn.execute(
          `UPDATE \`${tableName}\`
           SET company_id = ?, company_name = ?, company_ids_json = ?, updated_at = NOW()
           WHERE company_id = ?`,
          [
            fallbackCompany.id,
            fallbackCompany.name,
            JSON.stringify([fallbackCompany.id]),
            companyId,
          ]
        );
      } catch {
        await conn.execute(
          `UPDATE \`${tableName}\`
           SET company_id = ?, company_name = ?, company_ids_json = ?
           WHERE company_id = ?`,
          [
            fallbackCompany.id,
            fallbackCompany.name,
            JSON.stringify([fallbackCompany.id]),
            companyId,
          ]
        );
      }
      continue;
    }
    await conn.execute(`DELETE FROM \`${tableName}\` WHERE company_id = ?`, [companyId]);
  }
}

async function getCompanyProfilesByIds(
  companyIds: string[]
): Promise<Map<string, CompanyProfileSummary>> {
  const requestedIds = new Set(companyIds.map((id) => normalizeWhitespace(id)).filter(Boolean));
  const matches = new Map<string, CompanyProfileSummary>();
  if (!requestedIds.size) return matches;
  if (isMySqlStateEnabled()) {
    for (const company of await listCompaniesFromMySql()) {
      if (!requestedIds.has(company.id)) continue;
      matches.set(company.id, {
        id: company.id,
        name: company.name,
        primaryBranch: company.primaryBranch,
      });
    }
  }
  if (matches.size === requestedIds.size) return matches;
  const raw = await readRemoteState("@trackforce_companies");
  const parsed = raw ? parseJsonText(raw) : null;
  const legacyProfiles = parseCompanyProfilesState(parsed);
  for (const companyId of requestedIds) {
    if (matches.has(companyId)) continue;
    const profile = legacyProfiles.get(companyId);
    if (profile) matches.set(companyId, profile);
  }
  return matches;
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
  if (
    value === "admin" ||
    value === "hr" ||
    value === "manager" ||
    value === "salesperson" ||
    value === "employee"
  ) {
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

function isGenericNotificationTitle(rawTitle: string): boolean {
  const normalized = normalizeWhitespace(rawTitle).toLowerCase();
  if (!normalized) return true;
  if (normalized === "notification") return true;
  if (normalized === "new notification") return true;
  return /^notification(?:\b|[:\-_.])/i.test(normalized);
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

function parseNotificationUserIds(value: unknown): string[] {
  return Array.from(new Set(parseReadByIds(value).map((entry) => entry.trim()).filter(Boolean)));
}

function isNotificationBroadcast(notification: Pick<AppNotification, "audience" | "kind">): boolean {
  return notification.audience === "all" && (notification.kind === "announcement" || notification.kind === "policy");
}

function canUserReceiveNotification(notification: AppNotification, role: UserRole, userId: string): boolean {
  if (role === "admin") return true;
  if (notification.createdById === userId) return true;
  const audienceUserIds = parseNotificationUserIds(notification.audienceUserIds);
  if (audienceUserIds.length > 0) {
    return Boolean(userId && audienceUserIds.includes(userId));
  }
  if (isNotificationBroadcast(notification)) return true;
  if (notification.audience !== "all") {
    const isSalesAudience = notification.audience === "salesperson";
    const isSalesUser = role === "salesperson";
    if (isSalesAudience && isSalesUser) return true;
    return notification.audience === role;
  }
  return false;
}

function buildNotificationFromRow(row: any): AppNotification {
  const nowIso = new Date().toISOString();
  const rawTitle = normalizeWhitespace(String(row?.title || ""));
  const rawBody = normalizeWhitespace(String(row?.body || row?.message || ""));
  const hasGenericTitle = isGenericNotificationTitle(rawTitle);
  const resolvedTitle =
    !rawTitle || hasGenericTitle
      ? rawBody.slice(0, 90) || "New update"
      : rawTitle;
  const resolvedBody =
    rawBody || (!hasGenericTitle && rawTitle ? rawTitle : "You have a new notification.");
  return {
    id: String(row?.id || randomUUID()),
    companyId: row?.company_id ? String(row.company_id) : undefined,
    title: resolvedTitle,
    body: resolvedBody,
    kind: normalizeNotificationKind(row?.kind),
    audience: normalizeNotificationAudience(row?.audience),
    createdById: String(row?.created_by_id || "system"),
    createdByName: normalizeWhitespace(String(row?.created_by_name || "System")),
    createdAt: toIsoTimestamp(row?.created_at, nowIso),
    readByIds: parseReadByIds(row?.read_by_user_ids_json),
    audienceUserIds: parseNotificationUserIds(row?.audience_user_ids_json),
  };
}

let notificationsTableEnsured = false;

async function ensureNotificationsTableInMySql(): Promise<void> {
  if (notificationsTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS lff_notifications (
      id VARCHAR(64) NOT NULL,
      company_id VARCHAR(64) NULL,
      title VARCHAR(191) NOT NULL,
      body LONGTEXT NOT NULL,
      kind VARCHAR(64) NOT NULL,
      audience VARCHAR(32) NOT NULL,
      created_by_id VARCHAR(64) NOT NULL,
      created_by_name VARCHAR(191) NOT NULL,
      created_at DATETIME NOT NULL,
      read_by_user_ids_json LONGTEXT NULL,
      audience_user_ids_json LONGTEXT NULL,
      PRIMARY KEY (id),
      KEY idx_lff_notifications_company_time (company_id, created_at),
      KEY idx_lff_notifications_kind (kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  await conn.execute(`
    ALTER TABLE lff_notifications
      ADD COLUMN IF NOT EXISTS audience_user_ids_json LONGTEXT NULL AFTER read_by_user_ids_json
  `);
  notificationsTableEnsured = true;
}

async function insertNotificationInMySql(notification: AppNotification): Promise<void> {
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL notifications storage is not configured.");
  }
  await ensureNotificationsTableInMySql();
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_notifications (
      id, company_id, title, body, kind, audience, created_by_id, created_by_name,
      created_at, read_by_user_ids_json, audience_user_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      body = VALUES(body),
      kind = VALUES(kind),
      audience = VALUES(audience),
      created_by_id = VALUES(created_by_id),
      created_by_name = VALUES(created_by_name),
      created_at = VALUES(created_at),
      read_by_user_ids_json = COALESCE(read_by_user_ids_json, VALUES(read_by_user_ids_json)),
      audience_user_ids_json = VALUES(audience_user_ids_json)`,
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
      JSON.stringify(notification.audienceUserIds || []),
    ]
  );
}

function getAccessRequestNotificationIdentity(notification: AppNotification): string | null {
  if (notification.kind !== "alert" || notification.audience !== "admin") return null;
  if (!notification.id.startsWith("notif_access_") && notification.title !== "New access request") return null;
  const emailMatch = notification.body.match(/\(([^()@\s]+@[^()\s]+)\)/i);
  if (emailMatch) return `email:${normalizeEmail(emailMatch[1])}`;
  const sourceId = normalizeWhitespace(notification.createdById || "");
  return sourceId ? `id:${sourceId}` : null;
}

function dedupeNotifications(notifications: AppNotification[]): AppNotification[] {
  const seenAccessRequests = new Set<string>();
  const result: AppNotification[] = [];
  for (const notification of notifications) {
    const accessKey = getAccessRequestNotificationIdentity(notification);
    if (accessKey) {
      if (seenAccessRequests.has(accessKey)) continue;
      seenAccessRequests.add(accessKey);
    }
    result.push(notification);
  }
  return result;
}

async function removeDuplicateAccessRequestNotifications(notification: AppNotification): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureNotificationsTableInMySql();
  const conn = await getMySqlPool();
  
  const emailMatch = notification.body.match(/\(([^()@\s]+@[^()\s]+)\)/i);
  if (!emailMatch) return;
  const email = emailMatch[1].toLowerCase();

  await conn.execute(
    `DELETE FROM lff_notifications
     WHERE kind = 'alert'
       AND audience = 'admin'
       AND title = 'New access request'
       AND LOWER(body) LIKE ?
       AND id <> ?`,
    [`%(${email})%`, notification.id]
  );
}

async function listNotificationsFromMySql(
  role: UserRole,
  userId: string,
  companyId?: string | null
): Promise<AppNotification[]> {
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL notifications storage is not configured.");
  }
  await ensureNotificationsTableInMySql();
  const conn = await getMySqlPool();
  const params: Array<string | null> = [];
  let where = "WHERE 1=1";
  if (companyId) {
    where += " AND (company_id = ? OR company_id IS NULL)";
    params.push(companyId);
  }
  const [rows] = await conn.query<any[]>(
    `SELECT id, company_id, title, body, kind, audience, created_by_id, created_by_name, created_at, read_by_user_ids_json, audience_user_ids_json
     FROM lff_notifications
     ${where}
     ORDER BY created_at DESC
     LIMIT 500`,
    params
  );
  return dedupeNotifications((rows || [])
    .map((row) => buildNotificationFromRow(row))
    .filter((notification) => canUserReceiveNotification(notification, role, userId)));
}

async function markNotificationReadInMySql(notificationId: string, userId: string): Promise<void> {
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL notifications storage is not configured.");
  }
  await ensureNotificationsTableInMySql();
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
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL notifications storage is not configured.");
  }
  await ensureNotificationsTableInMySql();
  const notifications = await listNotificationsFromMySql(role, userId, companyId);
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
}): AppNotification {
  const createdAt = new Date().toISOString();
  return {
    id: `notif_access_${payload.requestId}`,
    companyId: undefined,
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
let authUsersStoreLastFailedAt = 0;
let authUsersStoreLastWarningAt = 0;

function toPositiveDurationMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

const AUTH_USERS_STORE_RETRY_MS = Math.max(
  5000,
  toPositiveDurationMs(process.env.AUTH_USERS_STORE_RETRY_MS, 30000)
);
const AUTH_USERS_STORE_WARNING_INTERVAL_MS = Math.max(
  AUTH_USERS_STORE_RETRY_MS,
  toPositiveDurationMs(process.env.AUTH_USERS_STORE_WARNING_INTERVAL_MS, 60000)
);

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnAuthUsersHydrationFailure(error: unknown): void {
  const now = Date.now();
  if (now - authUsersStoreLastWarningAt < AUTH_USERS_STORE_WARNING_INTERVAL_MS) {
    return;
  }
  authUsersStoreLastWarningAt = now;
  console.warn(
    "Unable to hydrate auth users from MySQL. Server will keep running and retry shortly:",
    getErrorMessage(error)
  );
}

async function hydrateAuthUsersFromMySql(): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT
      u.rowid, u.login, u.email, u.firstname, u.lastname, u.admin, u.statut, u.employee, u.job,
      u.office_phone, u.user_mobile, u.pass_crypted, u.pass, u.datec, u.tms,
      p.employee_category
    FROM nmy5_user u
    LEFT JOIN nmy5_hrm_employee_profile p ON p.fk_user = u.rowid`
  );
  const latestAccessRequestByEmail = new Map<string, AccessRequestRecord>();
  const accessRequests = await listAccessRequestsFromMySql(null);
  for (const request of accessRequests) {
    const emailKey = normalizeEmailKey(request.email);
    if (emailKey && !latestAccessRequestByEmail.has(emailKey)) {
      latestAccessRequestByEmail.set(emailKey, request);
    }
  }

  for (const row of rows) {
    const record = buildAuthRecordFromMySqlRow(row);
    if (!record) continue;
    const latestRequest = latestAccessRequestByEmail.get(normalizeEmailKey(record.user.email)) || null;
    const hydratedRecord: AuthUserRecord = {
      ...record,
      user: await mergeApprovedAccessRequestIntoUser(record.user, latestRequest),
      approvalStatus: latestRequest?.status === "approved" ? "approved" : record.approvalStatus,
    };
    setAuthUserRecord(hydratedRecord);
  }
}

async function initAuthUsersStore(): Promise<void> {
  if (authUsersByEmail.size > 0) return;
  if (!isMySqlStateEnabled()) return;
  if (authUsersStoreLastFailedAt > 0 && Date.now() - authUsersStoreLastFailedAt < AUTH_USERS_STORE_RETRY_MS) {
    return;
  }
  if (!authUsersStoreInitPromise) {
    authUsersStoreInitPromise = (async () => {
      try {
        await hydrateAuthUsersFromMySql();
        authUsersStoreLastFailedAt = 0;
      } catch (error) {
        authUsersStoreLastFailedAt = Date.now();
        warnAuthUsersHydrationFailure(error);
      }
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
  let role: UserRole = isAdmin ? "admin" : "salesperson";
  if (!isAdmin && row?.employee_category) {
    const catStr = String(row.employee_category).toLowerCase();
    if (catStr === "on_field") {
      role = "salesperson";
    } else if (catStr === "fixed_location") {
      role = "employee";
    }
  } else if (!isAdmin && row?.job) {
    const jobStr = String(row.job).toLowerCase();
    if (jobStr.includes("on field") || jobStr.includes("sales")) {
      role = "salesperson";
    } else if (jobStr.includes("fixed") || jobStr.includes("office") || jobStr.includes("support") || jobStr.includes("hr")) {
      role = "employee";
    }
  }
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
    department: normalizeDepartmentForRole(role),
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
      u.rowid, u.login, u.email, u.firstname, u.lastname, u.admin, u.statut, u.employee, u.job,
      u.office_phone, u.user_mobile, u.pass_crypted, u.pass, u.datec, u.tms,
      p.employee_category
    FROM nmy5_user u
    LEFT JOIN nmy5_hrm_employee_profile p ON p.fk_user = u.rowid
    WHERE u.email = ? OR u.login = ?
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
    const latestRequest = await getLatestAccessRequestByEmailFromMySql(normalized);
    const hydratedRecord: AuthUserRecord = {
      ...record,
      user: await mergeApprovedAccessRequestIntoUser(record.user, latestRequest),
      approvalStatus: latestRequest?.status === "approved" ? "approved" : record.approvalStatus,
    };
    setAuthUserRecord(hydratedRecord);
    return hydratedRecord;
  } catch {
    return authUsersByEmail.get(normalized) ?? null;
  }
}

async function checkAuthUserForSignup(email: string): Promise<AuthUserRecord | null> {
  const normalized = normalizeEmail(email);
  if (!isMySqlStateEnabled()) {
    return authUsersByEmail.get(normalized) ?? null;
  }
  const record = await getAuthUserFromMySqlByEmail(normalized);
  if (!record) {
    removeAuthUserByEmail(normalized);
    return null;
  }
  const latestRequest = await getLatestAccessRequestByEmailFromMySql(normalized);
  const hydratedRecord: AuthUserRecord = {
    ...record,
    user: await mergeApprovedAccessRequestIntoUser(record.user, latestRequest),
    approvalStatus: latestRequest?.status === "approved" ? "approved" : record.approvalStatus,
  };
  setAuthUserRecord(hydratedRecord);
  return hydratedRecord;
}

type ActiveAuthSessionRecord = {
  userId: string;
  email: string;
  deviceId: string;
};

let authSessionsTableEnsured = false;
const inMemoryActiveAuthSessions = new Map<string, ActiveAuthSessionRecord>();
const SINGLE_DEVICE_SESSION_LOCK_MESSAGE =
  "This account is already signed in on another device. Sign out from the previous device before signing in here.";

function normalizeDeviceIdInput(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120);
}

function resolveDeviceIdFromRequest(req: Request): string {
  const body = (req.body || {}) as { deviceId?: unknown };
  return (
    normalizeDeviceIdInput(body.deviceId) ||
    normalizeDeviceIdInput(req.header("x-device-id")) ||
    "unknown-device"
  );
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureAuthSessionsTableInMySql(): Promise<void> {
  if (authSessionsTableEnsured || !isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS lff_auth_sessions (
      user_id VARCHAR(64) NOT NULL,
      email VARCHAR(191) NOT NULL,
      device_id VARCHAR(191) NOT NULL,
      token_hash VARCHAR(128) NULL,
      logged_in_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      last_logout_at DATETIME NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id),
      KEY idx_lff_auth_sessions_device (device_id),
      KEY idx_lff_auth_sessions_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  authSessionsTableEnsured = true;
}

async function readActiveAuthSession(userId: string): Promise<ActiveAuthSessionRecord | null> {
  if (!userId) return null;
  if (!isMySqlStateEnabled()) {
    return inMemoryActiveAuthSessions.get(userId) ?? null;
  }
  await ensureAuthSessionsTableInMySql();
  const conn = await getMySqlPool();
  const [rows] = await conn.query<any[]>(
    `SELECT user_id, email, device_id
     FROM lff_auth_sessions
     WHERE user_id = ? AND is_active = 1
     LIMIT 1`,
    [userId]
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    userId: String(row.user_id || ""),
    email: String(row.email || ""),
    deviceId: String(row.device_id || ""),
  };
}

async function ensureSingleDeviceSessionAllowed(user: AppUser, deviceId: string): Promise<void> {
  const active = await readActiveAuthSession(user.id);
  if (!active) return;
  if (active.deviceId === deviceId) return;
  throw new Error(SINGLE_DEVICE_SESSION_LOCK_MESSAGE);
}

async function upsertActiveAuthSession(
  user: AppUser,
  deviceId: string,
  token: string
): Promise<void> {
  if (!isMySqlStateEnabled()) {
    inMemoryActiveAuthSessions.set(user.id, {
      userId: user.id,
      email: user.email,
      deviceId,
    });
    return;
  }
  await ensureAuthSessionsTableInMySql();
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_auth_sessions
      (user_id, email, device_id, token_hash, logged_in_at, updated_at, last_logout_at, is_active)
     VALUES (?, ?, ?, ?, NOW(), NOW(), NULL, 1)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       device_id = VALUES(device_id),
       token_hash = VALUES(token_hash),
       logged_in_at = IF(is_active = 1, logged_in_at, NOW()),
       updated_at = NOW(),
       last_logout_at = NULL,
       is_active = 1`,
    [user.id, user.email, deviceId, hashSessionToken(token)]
  );
}

async function deactivateAuthSession(
  userId: string,
  options?: { deviceId?: string | null; token?: string | null }
): Promise<void> {
  if (!userId) return;
  const normalizedDeviceId = normalizeDeviceIdInput(options?.deviceId);
  const normalizedTokenHash =
    typeof options?.token === "string" && options.token.trim()
      ? hashSessionToken(options.token.trim())
      : "";

  if (!isMySqlStateEnabled()) {
    const active = inMemoryActiveAuthSessions.get(userId);
    if (!active) return;
    if (normalizedDeviceId && active.deviceId !== normalizedDeviceId) return;
    inMemoryActiveAuthSessions.delete(userId);
    return;
  }

  await ensureAuthSessionsTableInMySql();
  const conn = await getMySqlPool();
  if (normalizedDeviceId) {
    await conn.execute(
      `UPDATE lff_auth_sessions
       SET is_active = 0, last_logout_at = NOW(), updated_at = NOW()
       WHERE user_id = ? AND device_id = ? AND is_active = 1`,
      [userId, normalizedDeviceId]
    );
    return;
  }
  if (normalizedTokenHash) {
    await conn.execute(
      `UPDATE lff_auth_sessions
       SET is_active = 0, last_logout_at = NOW(), updated_at = NOW()
       WHERE user_id = ? AND token_hash = ? AND is_active = 1`,
      [userId, normalizedTokenHash]
    );
    return;
  }
  await conn.execute(
    `UPDATE lff_auth_sessions
     SET is_active = 0, last_logout_at = NOW(), updated_at = NOW()
     WHERE user_id = ? AND is_active = 1`,
    [userId]
  );
}

function extractBearerTokenFromRequest(req: Request): string {
  const authHeader = req.header("authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice(7).trim();
}

function isSingleDeviceSessionLockError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /already (?:active|signed in) on another device/i.test(error.message || "");
}

function createAuthToken(user: AppUser, deviceId: string): string {
  return signJwt({
    sub: user.id,
    role: user.role,
    email: user.email,
    deviceId,
  });
}

async function issueDeviceScopedAuthToken(user: AppUser, deviceId: string): Promise<string> {
  await ensureSingleDeviceSessionAllowed(user, deviceId);
  const token = createAuthToken(user, deviceId);
  await upsertActiveAuthSession(user, deviceId, token);
  return token;
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
    department: normalizeDepartmentForRole(payload.role, payload.department),
    branch: normalizeWhitespace(payload.branch || "Main Branch"),
    phone: normalizeWhitespace(payload.phone || "+91 00000 00000"),
    joinDate: now,
    approvalStatus: "approved",
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  await initAuthUsersStore();
  
  const populateUser = async (req: Request, res: Response, next: any) => {
    if (req.auth && req.auth.email) {
      const email = req.auth.email;
      await initAuthUsersStore();
      const identifier = email.endsWith("@dolibarr.local") ? email.split("@")[0] || email : email;
      const record = (await syncAuthUserCacheForEmail(identifier)) || getAuthUserByIdentifier(identifier);
      if (record) {
        (req as any).user = record.user;
      }
    }
    next();
  };
  await ensureCompanyScopedSchemaInMySql().catch((error) => {
    console.warn(
      "Unable to finish company-scoped schema setup during startup:",
      error instanceof Error ? error.message : error
    );
  });
  await rehomeLegacyCompanyDataToConfiguredCompany().catch((error) => {
    console.warn(
      "Unable to assign legacy company data during startup:",
      error instanceof Error ? error.message : error
    );
  });
  registerHealthRoutes(app, {
    isMySqlStateEnabled,
  });
  registerAiAnalysisRoutes(app, {
    defaultGroqApiKey: DEFAULT_GROQ_API_KEY,
    defaultAiModel: DEFAULT_AI_MODEL,
    normalizeApiSecret,
    analyzeConversationWithAI,
  });
  registerDolibarrSettingsRoutes(app, {
    requireAuth,
    resolveDolibarrConfigForUser,
    setDolibarrConfigForUser: storage.setDolibarrConfigForUser.bind(storage),
    maskApiKey,
    buildDolibarrEndpointCandidates,
    buildDolibarrProxyHeaders,
    parseJsonText,
    getDolibarrProtectionBlockMessage,
  });

  registerNotificationRoutes(app, {
    requireAuth,
    initAuthUsersStore,
    getAuthUserByIdentifier,
    isMySqlStateEnabled,
    listNotificationsFromMySql,
    normalizeWhitespace,
    isGenericNotificationTitle,
    normalizeNotificationKind,
    normalizeNotificationAudience,
    parseNotificationUserIds,
    randomUUID,
    insertNotificationInMySql,
    firstString,
    markNotificationReadInMySql,
    markAllNotificationsReadInMySql,
  });

  registerCompanyRoutes(app, {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    listCompaniesFromMySql,
    normalizeWhitespace,
    ensureCompaniesTableInMySql,
    getMySqlPool,
    companyProfileFromRow,
    upsertCompanyProfileInMySql,
    normalizeCompanyProfilePayload,
    getCompanyIdFromName,
    randomUUID,
    persistCompaniesLegacyStateFromMySql,
    firstString,
    listCompanyProfilesFromMySqlRaw,
    rehomeLegacyCompanyDataToMySql,
    deleteCompanyScopedRowsInMySql,
  });

  registerSupportRoutes(app, {
    requireAuth,
    firstString,
    normalizeSupportAttachmentType,
    storeSupportAttachmentBinary,
  });

  registerDolibarrRoutes(app, {
    requireAuth,
    requireRoles,
    firstString,
    resolveDolibarrProxyRule,
    forwardDolibarrRequest,
    resolveDolibarrConfigForUser,
    parseOptionalBoolean,
    syncApprovedUserToDolibarrEmployee,
  });

  registerSpeechRoutes(app, {
    MAX_TRANSCRIBE_AUDIO_BYTES,
    firstString,
    transcribeSpeechWithFairseqS2T,
    Speech2TextError,
  });

  registerAuthRoutes(app, {
    requireAuth,
    requireRoles,
    normalizeEmail,
    normalizeRole,
    normalizeCompanyName,
    checkAuthUserForSignup,
    resolveApprovalStatus,
    hasAnyApprovedAdmin,
    buildUserFromRegistration,
    hashPassword,
    setAuthUserRecord,
    upsertAuthUserInMySql,
    forceDolibarrAdminPrivilegesForUserIdentity,
    removeAuthUserByEmail,
    resolveDeviceIdFromRequest,
    issueDeviceScopedAuthToken,
    isSingleDeviceSessionLockError,
    SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
    getLatestPendingAccessRequestByEmail,
    isMySqlStateEnabled,
    getLatestPendingAccessRequestByEmailFromMySql,
    accessRequestsById,
    insertAccessRequestInMySql,
    buildAccessRequestNotification,
    removeDuplicateAccessRequestNotifications,
    insertNotificationInMySql,
    toPublicAccessRequest,
    parseRequestStatus,
    listAccessRequestsFromMySql,
    firstString,
    getAccessRequestByIdFromMySql,
    isDolibarrSuperuserReviewer,
    normalizeCompanyIds,
    parseCompanyProfilesState,
    getCompanyProfilesByIds,
    normalizeWhitespace,
    normalizeDepartmentForRole,
    isSalesRole,
    authUsersByEmail,
    DEFAULT_COMPANY_NAME,
    syncStockistSalespersonAssignmentInMySql,
    normalizeLoginKey,
    buildLoginFromEmailAndName,
    getCompanyIdFromName,
    authenticateCredentials,
    matchesStoredPasswordHash,
    getLatestAccessRequestByEmail,
    getLatestAccessRequestByEmailFromMySql,
    deactivateAuthSession,
    normalizeDeviceIdInput,
    extractBearerTokenFromRequest,
    initAuthUsersStore,
    syncAuthUserCacheForEmail,
    getAuthUserByIdentifier,
    randomUUID,
  });

  registerStockRoutes(app, {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    toNullableText,
    listStockistsFromMySql,
    ensureStockistAssignmentColumns,
    toStringId,
    toRequiredText,
    toSqlTimestamp,
    parseStringArrayJson,
    getMySqlPool,
    normalizeProductIds,
    resolveProductStockSchema,
    PRODUCT_STOCK_TABLE,
  });

  registerStateRoutes(app, {
    requireAuth,
    firstString,
    isRemoteStateKeyAllowed,
    isLocationLogStateKey,
    listLocationLogsFromMySql,
    REMOTE_LOCATION_LOG_READ_LIMIT,
    REMOTE_LOCATION_LOG_WRITE_LIMIT,
    isMySqlStateEnabled,
    readRemoteState,
    resolveRequestCompanyId,
    withDefaultCompanyIdForRemoteState,
    writeRemoteState,
    getRequestUser,
    getMySqlPool,
    authUsersByEmail,
    randomUUID,
    insertNotificationInMySql,
  });

  registerVisitRoutes(app, {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    ensureConversationsTable,
    migrateLegacyConversationsStateToMySql,
    resolveRequestCompanyId,
    normalizeWhitespace,
    firstString,
    isSalesRole,
    parseOptionalInteger,
    listConversationsFromMySql,
    getAuthUserByIdentifier,
    normalizeConversationPayload,
    getMySqlPool,
    upsertConversationInMySql,
    mapConversationRow,
    getConversationByIdFromMySql,
    ensureTaskVisitNotesColumns,
    mapVisitNoteRowToTask,
    parseOptionalQueryFloat,
    ensureVisitHistoryTable,
    mapVisitHistoryRow,
    normalizeVisitNoteTask,
    toMySqlDateTime,
    upsertVisitHistoryInMySql,
  });

  registerGeofenceRoutes(app, {
    requireAuth,
    requireRoles,
    firstString,
    ensureUserMatch,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    storage,
    upsertGeofenceInMySql,
  });

  registerLocationSyncRoutes(app, {
    requireAuth,
    parseLocationSample,
    ensureUserMatch,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    resolveGeofenceStatus,
    randomUUID,
    storage,
    insertLocationLogInMySql,
    insertLocationLogsInMySql,
    isMySqlStateEnabled,
    findActiveAttendanceInMySql,
    insertAttendanceInMySql,
    resolveDolibarrConfigForUser,
    syncAttendanceWithDolibarr,
    insertNotificationInMySql,
    listAttendanceHistoryFromMySql,
    broadcastLocationUpdate,
  });

  registerLocationRoutes(app, {
    requireAuth,
    requireRoles,
    firstString,
    ensureUserMatch,
    isMySqlStateEnabled,
    storage,
    listLocationLogsLatestFromMySql,
    listLocationLogsForDateFromMySql,
    listLocationLogsForUserDateFromMySql,
    listAttendanceHistoryFromMySql: listAttendanceForUserDateFromMySql,
    toMumbaiDateKey,
    isIsoDateString,
    parseBooleanQuery,
    parseIntervalMinutes,
    downsampleLocationLogsByInterval,
    isMumbaiDateKey,
    resolveRouteSessionWindow,
    filterLocationLogsToSessionWindow,
    buildRouteTimeline,
    getRouteDailySummaryFromMySql,
    upsertRouteDailySummaryInMySql,
    getMapplsDirectionsForLogs,
    getMapplsDistanceMatrixForLogs,
    parseOptionalInteger,
  });
  registerMapplsRoutes(app, {
    requireAuth,
    firstString,
    parseCoordinatePair,
    parseOptionalQueryFloat,
    parseOptionalInteger,
    parseBooleanQuery,
    parseCoordinatesList,
    searchMapplsPlaces,
    reverseGeocodeMapplsCoordinates,
    getMapplsDirectionsForCoordinates,
  });

  registerAttendanceActionRoutes(app, {
    requireAuth,
    parseCheckPayload,
    ensureUserMatch,
    recordAnomaly,
    MAX_LOCATION_ACCURACY_METERS,
    MIN_LOCATION_SAMPLE_COUNT,
    parseIsoDate,
    isFreshDate,
    MAX_EVIDENCE_AGE_MS,
    MAX_CAPTURE_DRIFT_MS,
    storage,
    isMySqlStateEnabled,
    findActiveAttendanceInMySql,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    resolveGeofenceStatus,
    storeAttendancePhoto,
    randomUUID,
    insertAttendanceInMySql,
    broadcastAttendanceUpdate,
    insertLocationLogInMySql,
    resolveDolibarrConfigForUser,
    syncAttendanceWithDolibarr,
  });

  registerAttendanceRoutes(app, {
    requireAuth,
    firstString,
    ensureUserMatch,
    isMySqlStateEnabled,
    storage,
    listAttendanceTodayFromMySql,
    listAttendanceTodayFromMySqlAll,
    listAttendanceHistoryFromMySql,
    listAttendanceForUserDateFromMySql,
    getRequestUser,
    normalizeWhitespace,
    normalizeCompanyIds,
    resolveRequestCompanyId,
    defaultCompanyId: DEFAULT_COMPANY_ID,
  });
  registerSalaryRoutes(app, {
    requireAuth,
    requireRoles,
    populateUser,
    isMySqlStateEnabled,
    getMySqlPool,
    listDolibarrSalaryRows,
    verifyJwt,
    firstString,
    normalizeSalaryIdentity,
    resolveDolibarrSalaryViewerIds,
    toSqlDateOnly,
    toSqlNumber,
    upsertDolibarrSalaryRecord,
    deleteDolibarrSalaryRecord,
    updateDolibarrSalaryStatus,
  });
  // ─── Employee Bank Accounts REST endpoints ────────────────────────────────

  registerBankAccountRoutes(app, {
    requireAuth,
    populateUser,
    isMySqlStateEnabled,
    ensureBankAccountsTable,
    getMySqlPool,
    resolveRequestCompanyId,
    mapBankAccountRow,
    toNullableText,
    randomUUID,
    toSqlTimestamp,
    firstString,
  });

  registerLeaveRoutes(app, {
    getMySqlPool,
    isMySqlStateEnabled,
    requireAuth,
    populateUser,
    randomUUID,
    toSqlDateOnly,
    insertNotificationInMySql,
    firstString,
    getRequestUser,
    normalizeWhitespace,
    normalizeCompanyIds,
    resolveRequestCompanyId,
    listCompanyProfilesFromMySqlRaw,
    ensureAccessRequestAssignmentColumns,
    listAccessRequestsFromMySql,
    normalizeEmail,
    normalizeLoginKey,
    isLegacyDemoProfileName,
    normalizeRole,
    isSalesRole,
    normalizeDepartmentForRole,
    DEFAULT_COMPANY_ID,
  });
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url || "", `http://${request.headers.host}`);
      
      if (url.pathname === "/api/ws/attendance") {
        const token = url.searchParams.get("token");
        if (!token) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        // JWT token verify karein
        const payload = await verifyJwt(token);
        // Sirf admin aur manager ko WebSocket connect karne ki permission
        if (!payload || (payload.role !== "admin" && payload.role !== "manager")) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request, payload);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    adminWsClients.add(ws);

    let isAlive = true;
    ws.on("pong", () => { isAlive = true; });
    
    const pingInterval = setInterval(() => {
      if (!isAlive) return ws.terminate();
      isAlive = false;
      ws.ping();
    }, 30000);

    ws.on("close", () => {
      clearInterval(pingInterval);
      adminWsClients.delete(ws);
    });
  });
  return httpServer;
}
