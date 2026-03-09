import express, { type Express, type Request } from "express";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "crypto";
import type {
  AppUser,
  AttendanceCheckPayload,
  AttendanceRecord,
  Geofence,
  LocationLog,
  UserAccessRequest,
  UserRole,
} from "@/lib/types";
import { DEFAULT_COMPANY_ID, DEFAULT_COMPANY_NAME } from "@/lib/seedData";
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
  getMapplsDistanceMatrixForLogs,
} from "@/server/services/mappls-routing";
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
const DOLIBARR_ENV_ENDPOINT = (process.env.DOLIBARR_ENDPOINT || "").trim();
const DOLIBARR_ENV_API_KEY = (process.env.DOLIBARR_API_KEY || "").trim();
const REMOTE_STATE_ALLOWED_KEYS = new Set([
  "@trackforce_companies",
  "@trackforce_employees",
  "@trackforce_attendance",
  "@trackforce_salaries",
  "@trackforce_tasks",
  "@trackforce_expenses",
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
  const enabled = overrides?.enabled ?? stored?.enabled ?? latestStored?.enabled ?? configured;
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

const authUsersByEmail = new Map<string, AuthUserRecord>();
const accessRequestsById = new Map<string, UserAccessRequest>();
const inMemoryStateStore = new Map<string, string>();

async function ensureCompanyExistsInMySql(companyId: string, companyName: string): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  await conn.execute(
    `INSERT INTO lff_companies (
      id, name, legal_name, industry, headquarters, primary_branch, support_email, support_phone,
      attendance_zone_label, created_at, updated_at
    ) VALUES (?, ?, ?, 'General', 'India', 'Primary', 'support@axionmeditech.com', '', 'Main Zone', NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      legal_name = VALUES(legal_name),
      updated_at = NOW()`,
    [companyId, companyName, companyName]
  );
}

async function upsertAuthUserInMySql(record: AuthUserRecord, requestedCompanyName?: string | null): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
  const user = record.user;
  const companyId = user.companyId || DEFAULT_COMPANY_ID;
  const companyName = user.companyName || DEFAULT_COMPANY_NAME;
  await ensureCompanyExistsInMySql(companyId, companyName);
  await conn.execute(
    `INSERT INTO lff_users (
      id, name, email, password_hash, role, company_id, company_name, company_ids_json,
      department, branch, phone, join_date, avatar, manager_id, manager_name, approval_status,
      requested_company_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      password_hash = VALUES(password_hash),
      role = VALUES(role),
      company_id = VALUES(company_id),
      company_name = VALUES(company_name),
      company_ids_json = VALUES(company_ids_json),
      department = VALUES(department),
      branch = VALUES(branch),
      phone = VALUES(phone),
      join_date = VALUES(join_date),
      avatar = VALUES(avatar),
      manager_id = VALUES(manager_id),
      manager_name = VALUES(manager_name),
      approval_status = VALUES(approval_status),
      requested_company_name = VALUES(requested_company_name),
      updated_at = VALUES(updated_at)`,
    [
      user.id,
      user.name,
      user.email,
      record.passwordHash,
      user.role,
      companyId,
      companyName,
      JSON.stringify(user.companyIds || [companyId]),
      user.department,
      user.branch,
      user.phone || "",
      user.joinDate || new Date().toISOString().slice(0, 10),
      user.avatar || null,
      user.managerId || null,
      user.managerName || null,
      resolveApprovalStatus(record),
      requestedCompanyName || null,
      record.createdAt.slice(0, 19).replace("T", " "),
      record.updatedAt.slice(0, 19).replace("T", " "),
    ]
  );
}

async function insertAccessRequestInMySql(entry: UserAccessRequest): Promise<void> {
  if (!isMySqlStateEnabled()) return;
  const conn = await getMySqlPool();
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

async function listAccessRequestsFromMySql(
  status: UserAccessRequest["status"] | null
): Promise<UserAccessRequest[]> {
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
  }));
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

function hashPassword(password: string): string {
  return createHash("sha256").update(`trackforce::${password}`).digest("hex");
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

function isRemoteStateKeyAllowed(key: string): boolean {
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
}

async function readRemoteState(key: string): Promise<string | null> {
  if (isMySqlStateEnabled()) {
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

function hasApprovedAdminForCompany(companyName: string): boolean {
  const normalizedCompanyName = normalizeCompanyName(companyName);
  const companyNameKey = normalizedCompanyName.toLowerCase();
  const companyId = getCompanyIdFromName(normalizedCompanyName);
  for (const record of authUsersByEmail.values()) {
    if (resolveApprovalStatus(record) !== "approved") continue;
    if (record.user.role !== "admin") continue;
    const userCompanyId = normalizeWhitespace(record.user.companyId || "");
    const userCompanyName = normalizeCompanyName(record.user.companyName || "").toLowerCase();
    if (userCompanyId === companyId || userCompanyName === companyNameKey) {
      return true;
    }
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
      id, name, email, password_hash, role, company_id, company_name, company_ids_json,
      department, branch, phone, join_date, avatar, manager_id, manager_name, approval_status,
      created_at, updated_at
    FROM lff_users`
  );

  for (const row of rows) {
    const emailValue = normalizeEmailKey(typeof row?.email === "string" ? row.email : "");
    const passwordHashValue =
      typeof row?.password_hash === "string" ? row.password_hash.trim() : "";
    if (!emailValue || !passwordHashValue) continue;

    const role = normalizeRole(row?.role);
    const companyId = normalizeWhitespace(String(row?.company_id || DEFAULT_COMPANY_ID)) || DEFAULT_COMPANY_ID;
    const companyName = normalizeCompanyName(String(row?.company_name || DEFAULT_COMPANY_NAME));
    const nowIso = new Date().toISOString();
    const user: AppUser = {
      id: normalizeWhitespace(String(row?.id || randomUUID())),
      name: normalizeWhitespace(String(row?.name || emailValue)),
      email: normalizeEmail(emailValue),
      role,
      companyId,
      companyName,
      companyIds: parseCompanyIdsFromJson(row?.company_ids_json, companyId),
      department: normalizeWhitespace(String(row?.department || roleToDepartment(role))),
      branch: normalizeWhitespace(String(row?.branch || "Main Branch")),
      phone: normalizeWhitespace(String(row?.phone || "+91 00000 00000")),
      joinDate: String(row?.join_date || new Date().toISOString().slice(0, 10)),
      avatar: row?.avatar ? String(row.avatar) : undefined,
      managerId: row?.manager_id ? String(row.manager_id) : undefined,
      managerName: row?.manager_name ? String(row.manager_name) : undefined,
      approvalStatus: normalizeApprovalStatusValue(row?.approval_status),
    };

    authUsersByEmail.set(user.email, {
      user,
      passwordHash: passwordHashValue,
      createdAt: toIsoTimestamp(row?.created_at, nowIso),
      updatedAt: toIsoTimestamp(row?.updated_at, nowIso),
      approvalStatus: normalizeApprovalStatusValue(row?.approval_status),
    });
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

function createAuthToken(user: AppUser): string {
  return signJwt({
    sub: user.id,
    role: user.role,
    email: user.email,
  });
}

async function authenticateCredentials(email: string, password: string): Promise<AppUser | null> {
  await initAuthUsersStore();
  const record = authUsersByEmail.get(normalizeEmail(email));
  if (!record) return null;
  if (record.passwordHash !== hashPassword(password)) return null;
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
  const normalizedCompanyName = normalizeCompanyName(payload.companyName);
  return {
    id: randomUUID(),
    name: normalizeWhitespace(payload.name),
    email: normalizeEmail(payload.email),
    role: payload.role,
    companyId: getCompanyIdFromName(normalizedCompanyName),
    companyName: normalizedCompanyName,
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

    if (!config.enabled) {
      res.json({
        ok: false,
        status: null,
        message: "Dolibarr sync is disabled in settings.",
      });
      return;
    }
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
      const assemblyAiApiKeyHeader = firstString(req.header("x-assemblyai-api-key"));
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
          assemblyAiApiKey:
            assemblyAiApiKeyHeader || firstString(req.query.assemblyai_api_key) || null,
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
    if (authUsersByEmail.has(normalizedEmail)) {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const companyAlreadyHasAdmin = hasApprovedAdminForCompany(normalizedCompanyName);
    if (normalizedRole === "admin" && companyAlreadyHasAdmin) {
      res.status(403).json({
        message:
          "Admin already exists for this company. Ask an existing admin to approve additional admin access.",
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
    authUsersByEmail.set(user.email, authRecord);
    try {
      await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
    } catch (error) {
      authUsersByEmail.delete(user.email);
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
    const companyAlreadyHasAdmin = hasApprovedAdminForCompany(normalizedCompanyName);

    const existingRecord = authUsersByEmail.get(normalizedEmail);
    const existingStatus = existingRecord ? resolveApprovalStatus(existingRecord) : null;
    if (existingRecord && existingStatus === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    if (normalizedRole === "admin" && !companyAlreadyHasAdmin) {
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
      authUsersByEmail.set(normalizedEmail, authRecord);
      try {
        await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
      } catch (error) {
        authUsersByEmail.delete(normalizedEmail);
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

    const existingPendingRequest = getLatestPendingAccessRequestByEmail(normalizedEmail);
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

    authUsersByEmail.set(normalizedEmail, {
      user: pendingUser,
      passwordHash: hashPassword(password),
      createdAt: existingRecord?.createdAt || now,
      updatedAt: now,
      approvalStatus: "pending",
    });

    const pendingRequest: UserAccessRequest = {
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
    };
    accessRequestsById.set(pendingRequest.id, pendingRequest);
    try {
      const latestAuthRecord = authUsersByEmail.get(normalizedEmail);
      if (latestAuthRecord) {
        await upsertAuthUserInMySql(
          latestAuthRecord,
          pendingRequest.requestedCompanyName
        );
      }
      await insertAccessRequestInMySql(pendingRequest);
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
      message: "Signup request submitted. Wait for admin approval before signing in.",
      request: pendingRequest,
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
            res.json(requests);
            return;
          } catch (error) {
            console.error("Failed to read access requests from MySQL", error);
          }
        }
        const requests = Array.from(accessRequestsById.values())
          .filter((entry) => !parsedStatus || entry.status === parsedStatus)
          .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
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

      const currentRequest = accessRequestsById.get(requestId);
      if (!currentRequest) {
        res.status(404).json({ message: "Access request not found." });
        return;
      }
      if (currentRequest.status !== "pending") {
        res.json(currentRequest);
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
      const authRecord = authUsersByEmail.get(normalizedEmail);
      if (!authRecord) {
        res
          .status(404)
          .json({ message: "User account request is missing. Ask the user to sign up again." });
        return;
      }

      if (action === "approved") {
        const effectiveCompanyName = normalizeCompanyName(
          currentRequest.requestedCompanyName || authRecord.user.companyName || DEFAULT_COMPANY_NAME
        );
        const effectiveCompanyId =
          assignedCompanyIds[0] ||
          authRecord.user.companyId ||
          getCompanyIdFromName(effectiveCompanyName);
        const reviewedUser: AppUser = {
          ...authRecord.user,
          role: finalRole,
          department:
            normalizeWhitespace(currentRequest.requestedDepartment) || roleToDepartment(finalRole),
          branch: normalizeWhitespace(currentRequest.requestedBranch) || authRecord.user.branch,
          companyId: effectiveCompanyId,
          companyName: effectiveCompanyName,
          companyIds: assignedCompanyIds.length ? assignedCompanyIds : [effectiveCompanyId],
          managerId: assignedManagerId || undefined,
          managerName: assignedManagerName || undefined,
          approvalStatus: "approved",
        };

        authUsersByEmail.set(normalizedEmail, {
          ...authRecord,
          user: reviewedUser,
          updatedAt: now,
          approvalStatus: "approved",
        });
      } else {
        authUsersByEmail.set(normalizedEmail, {
          ...authRecord,
          user: {
            ...authRecord.user,
            approvalStatus: "rejected",
          },
          updatedAt: now,
          approvalStatus: "rejected",
        });
      }

      const reviewedRequest: UserAccessRequest = {
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
      };
      accessRequestsById.set(requestId, reviewedRequest);
      try {
        const latestAuthRecord = authUsersByEmail.get(normalizedEmail);
        if (latestAuthRecord) {
          await upsertAuthUserInMySql(
            latestAuthRecord,
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
      res.json(reviewedRequest);
    }
  );

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    await initAuthUsersStore();
    const normalizedEmail = normalizeEmail(email);
    const authRecord = authUsersByEmail.get(normalizedEmail);
    if (authRecord && authRecord.passwordHash === hashPassword(password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    }
    const user = await authenticateCredentials(normalizedEmail, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const token = createAuthToken(user);
    res.json({ token, user });
  });

  app.post("/api/auth/token", async (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }
    await initAuthUsersStore();
    const normalizedEmail = normalizeEmail(email);
    const authRecord = authUsersByEmail.get(normalizedEmail);
    if (authRecord && authRecord.passwordHash === hashPassword(password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    }
    const user = await authenticateCredentials(normalizedEmail, password);
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
    const record = authUsersByEmail.get(normalizeEmail(email));
    if (!record) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ user: record.user });
  });

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

    await storage.addLocationLog({
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
    });
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

      await storage.addLocationLog({
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
      });
      accepted += 1;
    }

    res.status(201).json({
      ok: true,
      accepted,
      rejected: invalidCount,
    });
  });

  app.get("/api/admin/live-map", requireAuth, requireRoles("admin", "hr", "manager"), async (_req, res) => {
    const latest = await storage.getLocationLogsLatest();
    res.json(latest);
  });

  app.get(
    "/api/admin/live-map/routes",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requestedDate = firstString(req.query.date) || toMumbaiDateKey(new Date());
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const intervalMinutes = parseIntervalMinutes(req.query.interval_minutes, 1);
      const allPoints = await storage.getLocationLogsForDate(requestedDate);
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
      const rawPoints = await storage.getLocationLogsForUserDate(userId, requestedDate);
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

