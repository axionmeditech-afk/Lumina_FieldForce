import { attendanceConnection, withAttendanceLock } from "./services/attendance-lock";
import express, { type Express, type Request, type Response } from "express";
import type { Pool, PoolConnection } from "mysql2/promise";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { AppNotification, AppUser, AttendanceCheckPayload, AttendanceRecord, CompanyProfile, Geofence, UserAccessRequest, UserRole } from "@/lib/types";
import {
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  PENDING_COMPANY_ID,
  PENDING_COMPANY_NAME,
} from "@/lib/seedData";
import { requireAuth, requireRoles, signJwt, verifyJwt } from "@/server/auth";
import { storage } from "@/server/storage";
import { recordAnomaly, resolveGeofenceStatus } from "@/server/services/attendance-guard";
import { storeAttendancePhoto } from "@/server/services/photo-upload";
import { syncAttendanceWithDolibarr } from "@/server/services/dolibarr-sync";
import {
  reverseGeocodeMapplsCoordinates,
  searchMapplsPlaces,
} from "@/server/services/mappls-places";
import {
  getMySqlStateValue,
  getMySqlPool,
  isMySqlStateEnabled,
  setMySqlStateValue,
} from "@/server/services/mysql-state";
import { toMumbaiDateKey } from "@/lib/ist-time";
import { isSalesRole } from "@/lib/role-access";
import { registerHealthRoutes } from "@/server/routes/health.routes";
import { registerAttendanceRoutes } from "@/server/routes/attendance.routes";
import { registerUserRoutes } from "@/server/routes/users.routes";
import { registerMapplsRoutes } from "@/server/routes/mappls.routes";
import { registerCompanyRoutes } from "@/server/routes/companies.routes";
import { registerAuthRoutes } from "@/server/routes/auth.routes";
import { registerStateRoutes } from "@/server/routes/state.routes";
import { registerAttendanceActionRoutes } from "@/server/routes/attendance-actions.routes";
import { registerGeofenceRoutes } from "@/server/routes/geofences.routes";


type AdminWsClientMeta = {
  userId: string;
  role: string;
  companyId: string | null;
};

const adminWsClients = new Map<WebSocket, AdminWsClientMeta>();

export function broadcastAttendanceUpdate(record: AttendanceRecord) {
  const message = JSON.stringify({ type: "attendance_update", record });
  const targetCompanyId = normalizeWhitespace(record.companyId || "");
  for (const [client, meta] of adminWsClients) {
    if (!targetCompanyId || !meta.companyId || meta.companyId !== targetCompanyId) continue;
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}



const MAX_LOCATION_ACCURACY_METERS = 120;
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 1000;
const MAX_CAPTURE_DRIFT_MS = 2 * 60 * 1000;
const MIN_LOCATION_SAMPLE_COUNT = 2;
const DOLIBARR_ENV_ENDPOINT = (
  process.env.DOLIBARR_ENDPOINT ||
  process.env.DOLIBARR_BASE_URL ||
  ""
).trim();
const DOLIBARR_ENV_API_KEY = (process.env.DOLIBARR_API_KEY || "").trim();
const LEGACY_COMPANY_DATA_REHOME_TARGET_ID = (
  process.env.LEGACY_COMPANY_DATA_REHOME_TARGET_ID ||
  "cmp_lumina_meditech_7f3e019e"
).trim();
const LEGACY_DEMO_PROFILE_NAMES = new Set([
  "iamdummy",
  "i am dummy",
  "dummy",
  "dummy user",
  "test",
  "test user",
  "priya",
  "priya sharma",
  "rohit",
  "sneha",
  "sneha reddy",
]);
const REMOTE_STATE_ALLOWED_KEYS = new Set(["@trackforce_companies","@trackforce_employees","@trackforce_attendance","@trackforce_audit_logs","@trackforce_settings","@trackforce_geofences","@trackforce_teams","@trackforce_attendance_photos","@trackforce_attendance_anomalies"]);
const COMPANY_SCOPED_REMOTE_STATE_KEYS = new Set(["@trackforce_companies","@trackforce_employees","@trackforce_attendance","@trackforce_audit_logs","@trackforce_settings","@trackforce_geofences","@trackforce_teams","@trackforce_attendance_photos","@trackforce_attendance_anomalies"]);

function firstString(value: unknown): string {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}

function parseJsonText(text: string): unknown | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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

function parseOptionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
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

function parseOptionalQueryFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
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

function parseCheckPayload(req: Request): AttendanceCheckPayload | null {
  const body = req.body as Partial<AttendanceCheckPayload>;
  if (!body || !body.userId || !body.userName) return null;
  if (typeof body.latitude !== "number" || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90 ||
      typeof body.longitude !== "number" || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180) return null;
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId))) return null;
  if (!body.deviceId || (body.photoType !== "checkin" && body.photoType !== "checkout")) return null;

  const locationAccuracyMeters = parseFiniteNumber(body.locationAccuracyMeters);
  const geofenceDistanceMeters = parseFiniteNumber(body.geofenceDistanceMeters);
  const faceCount = parseFiniteNumber(body.faceCount);
  const locationSampleCount = parseFiniteNumber(body.locationSampleCount);
  const locationSampleWindowMs = parseFiniteNumber(body.locationSampleWindowMs);
  const biometricRequired = body.biometricRequired === true;
  const biometricVerified = body.biometricVerified === true;
  const biometricType = typeof body.biometricType === "string" ? body.biometricType : null;
  const biometricFailureReason =
    typeof body.biometricFailureReason === "string" ? body.biometricFailureReason : null;

  return {
    requestId: body.requestId,
    actionSource: body.actionSource === "geofence_exit" ? "geofence_exit" : "manual",
    activeAttendanceId: typeof body.activeAttendanceId === "string" ? body.activeAttendanceId : undefined,
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
  const buildAliases = (value: string | null | undefined): Set<string> => {
    const aliases = new Set<string>();
    const normalized = normalizeWhitespace(value || "");
    if (!normalized) return aliases;
    aliases.add(normalized);
    aliases.add(normalized.toLowerCase());
    const lower = normalized.toLowerCase();
    if (lower.startsWith("dolibarr_")) {
      const raw = normalized.slice("dolibarr_".length);
      if (raw) {
        aliases.add(raw);
        aliases.add(raw.toLowerCase());
      }
    } else if (/^\d+$/.test(normalized)) {
      aliases.add(`dolibarr_${normalized}`);
      aliases.add(`dolibarr_${normalized}`.toLowerCase());
    }
    return aliases;
  };
  const authAliases = buildAliases(req.auth.sub);
  const userAliases = buildAliases(userId);
  for (const alias of userAliases) {
    if (authAliases.has(alias)) return true;
  }
  return ["admin", "hr", "manager"].includes(req.auth.role);
}

async function resolveRequestCompanyId(req: Request): Promise<string | null> {
  const email = normalizeEmailKey(req.auth?.email);
  if (!email) return null;
  const synced = await syncAuthUserCacheForEmail(email).catch(() => null);
  const cached = getAuthUserByIdentifier(email);
  return synced?.user.companyId ?? cached?.user.companyId ?? null;
}

async function resolveAuthPayloadCompanyId(payload: { email?: string | null } | null | undefined): Promise<string | null> {
  const email = normalizeEmailKey(payload?.email);
  if (!email) return null;
  const synced = await syncAuthUserCacheForEmail(email).catch(() => null);
  const cached = getAuthUserByIdentifier(email);
  return synced?.user.companyId ?? cached?.user.companyId ?? DEFAULT_COMPANY_ID;
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
  const normalized = normalizeWhitespace(value || "").toLowerCase();
  if (!normalized) return false;
  if (LEGACY_DEMO_PROFILE_NAMES.has(normalized)) return true;
  return /(^|[^a-z0-9])(dummy|testuser|demo)([^a-z0-9]|$)/i.test(normalized);
}

function isLegacyDemoIdentity(value: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(value || "").toLowerCase();
  if (!normalized) return false;
  if (isLegacyDemoProfileName(normalized)) return true;
  if (normalized.endsWith("@trackforce.ai")) return true;
  const localPart = normalized.includes("@") ? normalized.split("@")[0] : normalized;
  return isLegacyDemoProfileName(localPart);
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

async function hydrateAuthRecordWithAccessRequest(
  record: AuthUserRecord,
  latestRequest: AccessRequestRecord | null
): Promise<AuthUserRecord> {
  const sourceStatus = resolveApprovalStatus(record);
  if (sourceStatus !== "approved") {
    return {
      ...record,
      user: {
        ...record.user,
        approvalStatus: sourceStatus,
      },
      approvalStatus: sourceStatus,
    };
  }

  const mergedUser = await mergeApprovedAccessRequestIntoUser(record.user, latestRequest);
  return {
    ...record,
    user: mergedUser,
    approvalStatus: latestRequest?.status === "approved" ? "approved" : record.approvalStatus,
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
let geofenceTableEnsured = false;

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
      \`location_label\` VARCHAR(191) NULL,
      \`location_address\` TEXT NULL,
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
  await conn.execute(`
    ALTER TABLE \`lff_geofences\`
      ADD COLUMN IF NOT EXISTS \`location_label\` VARCHAR(191) NULL AFTER \`name\`,
      ADD COLUMN IF NOT EXISTS \`location_address\` TEXT NULL AFTER \`location_label\`
  `).catch(() => undefined);
  geofenceTableEnsured = true;
}

function mapGeofenceRow(row: any): Geofence {
  const now = new Date().toISOString();
  return {
    id: String(row.id),
    companyId: row.company_id ? String(row.company_id) : undefined,
    name: String(row.name || "Unnamed Zone"),
    locationLabel: row.location_label ? String(row.location_label) : null,
    locationAddress: row.location_address ? String(row.location_address) : null,
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

async function listGeofencesForCompanyResolved(companyId: string | null | undefined): Promise<Geofence[]> {
  const normalizedCompanyId = normalizeWhitespace(companyId || "");
  if (!normalizedCompanyId) return [];
  if (isMySqlStateEnabled()) {
    await ensureGeofenceTable();
    const conn = await getMySqlPool();
    const [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_geofences
       WHERE company_id = ?
       ORDER BY is_active DESC, updated_at DESC`,
      [normalizedCompanyId]
    );
    return rows.map(mapGeofenceRow);
  }
  const zones = await storage.listGeofences();
  return zones
    .filter((zone) => zone.companyId === normalizedCompanyId)
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.updatedAt.localeCompare(a.updatedAt));
}

async function listGeofencesForUserResolved(
  userId: string,
  options: { companyId?: string | null; companyIds?: string[]; role?: UserRole | null } = {}
): Promise<Geofence[]> {
  const authorizedCompanyIds = normalizeCompanyIds([
    ...(options.companyIds || []),
    options.companyId,
  ]);
  const includeCompanyOffice = authorizedCompanyIds.length > 0;
  if (isMySqlStateEnabled()) {
    const [zones, officeZones] = await Promise.all([
      listGeofencesForUserFromMySql(userId),
      Promise.all(authorizedCompanyIds.map(listCompanyOfficeGeofencesFromMySql)),
    ]);
    return mergeGeofencesById([...zones, ...officeZones.flat()]);
  }
  const zones = await storage.listGeofencesForUser(userId);
  if (!includeCompanyOffice) return zones;
  const allZones = await storage.listGeofences();
  const officeZones = allZones.filter((zone) =>
    authorizedCompanyIds.some((companyId) => isCompanyOfficeGeofence(zone, companyId))
  );
  return mergeGeofencesById([...zones, ...officeZones]);
}

async function getGeofenceById(id: string): Promise<Geofence | null> {
  if (!isMySqlStateEnabled()) return (await storage.listGeofences()).find(zone => zone.id === id) || null;
  await ensureGeofenceTable();
  const [rows] = await (await getMySqlPool()).query<any[]>("SELECT * FROM lff_geofences WHERE id = ? LIMIT 1", [id]);
  return rows[0] ? mapGeofenceRow(rows[0]) : null;
}

async function upsertGeofenceInMySql(zone: Geofence): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureGeofenceTable();
  const conn = await getMySqlPool();
  const now = new Date().toISOString();
  await conn.execute(
    `INSERT INTO lff_geofences (
      id, company_id, name, location_label, location_address, latitude, longitude, radius_meters, assigned_employee_ids_json,
      is_active, allow_override, working_hours_start, working_hours_end, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      company_id = VALUES(company_id),
      name = VALUES(name),
      location_label = VALUES(location_label),
      location_address = VALUES(location_address),
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
      zone.locationLabel ?? null,
      zone.locationAddress ?? null,
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

async function getAttendanceByIdFromMySql(id: string): Promise<AttendanceRecord | null> {
  await ensureAttendanceTable();
  const conn = attendanceConnection.getStore() || await getMySqlPool();
  const [rows] = await conn.query<any[]>("SELECT * FROM lff_attendance WHERE id = ? LIMIT 1", [id]);
  return rows[0] ? mapAttendanceRow(rows[0]) : null;
}

async function insertAttendanceInMySql(record: AttendanceRecord): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  await ensureAttendanceTable();
  const conn = attendanceConnection.getStore() || await getMySqlPool();
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

async function listAttendanceHistoryFromMySql(userId: string, limit = 200): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const conn = attendanceConnection.getStore() || await getMySqlPool();
  let [rows] = await conn.query<any[]>(
    `SELECT * FROM lff_attendance WHERE user_id = ? ORDER BY \`timestamp\` DESC LIMIT ${Math.max(1, Math.min(2000, Math.trunc(limit)))}`,
    [userId]
  );
  if ((!rows || rows.length === 0) && !attendanceLegacyStateHydrated) {
    await hydrateAttendanceFromLegacyStateIfNeeded();
    [rows] = await conn.query<any[]>(
      `SELECT * FROM lff_attendance WHERE user_id = ? ORDER BY \`timestamp\` DESC LIMIT ${Math.max(1, Math.min(2000, Math.trunc(limit)))}`,
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
  const conn = attendanceConnection.getStore() || await getMySqlPool();
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
  const conn = attendanceConnection.getStore() || await getMySqlPool();
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
  dateKey = toMumbaiDateKey(new Date()),
  endDateKey = dateKey
): Promise<AttendanceRecord[]> {
  if (!isMySqlStateEnabled()) return [];
  await ensureAttendanceTable();
  const range = parseDateKeyToUtcRange(dateKey);
  const endRange = parseDateKeyToUtcRange(endDateKey);
  if (!range || !endRange) return [];
  const conn = attendanceConnection.getStore() || await getMySqlPool();
  const cleanCompanyId = companyId ? String(companyId).trim() : "";
  let query = `SELECT * FROM lff_attendance WHERE \`timestamp\` BETWEEN ? AND ?`;
  const params: any[] = [range.start, endRange.end];
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
  const conn = attendanceConnection.getStore() || await getMySqlPool();
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
  const conn = attendanceConnection.getStore() || await getMySqlPool();
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

function isRemoteStateKeyAllowed(key: string): boolean {
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
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

async function mergeAttendanceInMySql(entries: unknown[]): Promise<void> {
  for (const entry of entries) {
    const record = normalizeAttendanceRecordInput(entry);
    if (!record) continue;
    await insertAttendanceInMySql(record);
  }
}

async function readNormalizedState(key: string): Promise<unknown[] | undefined> {
 if (key === "@trackforce_companies") return listCompaniesFromMySql();
 if (key === "@trackforce_employees") return listEmployeesFromMySql();
 if (key === "@trackforce_attendance") return listAttendanceFromMySql();
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

async function writeNormalizedState(key: string, jsonValue: string, requestUser?: AppUser | null): Promise<boolean> {
 if (key === "@trackforce_companies") return true;
 if (key === "@trackforce_attendance") { const parsed = JSON.parse(jsonValue); await mergeAttendanceInMySql(Array.isArray(parsed) ? parsed : []); return true; }
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

let authUsersStoreInitPromise: Promise<void> | null = null;
let hasHydratedUsers = false;
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
    const hydratedRecord = await hydrateAuthRecordWithAccessRequest(record, latestRequest);
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
        hasHydratedUsers = true;
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
  // If user is deactivated in Dolibarr DB, reject them (drops from auth cache)
  if (row?.statut !== undefined && String(row.statut) === "0") return null;

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
    const hydratedRecord = await hydrateAuthRecordWithAccessRequest(record, latestRequest);
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
  const hydratedRecord = await hydrateAuthRecordWithAccessRequest(record, latestRequest);
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
  const record = (await syncAuthUserCacheForEmail(identifier)) || getAuthUserByIdentifier(identifier);
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

  registerAuthRoutes(app, {
    requireAuth,
    requireRoles,
    getMySqlPool,
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
    readActiveAuthSession,
    initAuthUsersStore,
    syncAuthUserCacheForEmail,
    getAuthUserByIdentifier,
    randomUUID,
  });

  registerStateRoutes(app, {
    requireAuth,
    firstString,
    isRemoteStateKeyAllowed,
    isMySqlStateEnabled,
    readRemoteState,
    resolveRequestCompanyId,
    withDefaultCompanyIdForRemoteState,
    writeRemoteState,
    getRequestUser,
  });

  registerGeofenceRoutes(app, {
    getGeofenceById, isMySqlStateEnabled,
    requireAuth,
    requireRoles,
    firstString,
    ensureUserMatch,
    resolveRequestCompanyId,
    getRequestUser,
    normalizeCompanyIds,
    listGeofencesForUserResolved,
    listGeofencesForCompanyResolved,
    storage,
    upsertGeofenceInMySql,
  });
  registerMapplsRoutes(app, {
    requireAuth,
    firstString,
    parseCoordinatePair,
    parseOptionalQueryFloat,
    parseOptionalInteger,
    searchMapplsPlaces,
    reverseGeocodeMapplsCoordinates,
  });

  registerAttendanceActionRoutes(app, {
    getGeofenceById,
    withAttendanceLock, getAttendanceByIdFromMySql, getRequestUser, normalizeCompanyIds, prepareAttendance: ensureAttendanceTable,
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
    resolveDolibarrConfigForUser,
    syncAttendanceWithDolibarr,
    insertNotificationInMySql,
  });

  registerAttendanceRoutes(app, {
    findActiveAttendanceInMySql,
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

  registerUserRoutes(app, {
    getMySqlPool,
    requireAuth,
    requireRoles,
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
    isLegacyDemoIdentity,
    normalizeRole,
    isSalesRole,
    normalizeDepartmentForRole,
    DEFAULT_COMPANY_ID,
    removeAuthUserByEmail,
    deactivateAuthSession,
    randomUUID,
    getCompanyProfilesByIds,
    isDolibarrSuperuserReviewer,
    forceDolibarrAdminPrivilegesForUserIdentity,
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
        // Sirf admin, HR aur manager ko WebSocket connect karne ki permission.
        if (!payload || (payload.role !== "admin" && payload.role !== "manager" && payload.role !== "hr")) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }

        const companyId = await resolveAuthPayloadCompanyId(payload);
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request, payload, companyId);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, _request: import("node:http").IncomingMessage, payload: any, companyId?: string | null) => {
    adminWsClients.set(ws, {
      userId: normalizeWhitespace(payload?.sub || ""),
      role: normalizeWhitespace(payload?.role || ""),
      companyId: normalizeWhitespace(companyId || "") || null,
    });

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

    // Respond to client-side JSON heartbeat pings
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "ping") {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        }
      } catch { /* ignore non-JSON messages */ }
    });
  });
  return httpServer;
}
