import { randomUUID } from "crypto";
import type { AttendanceRecord } from "@/lib/types";
import { storage } from "@/server/storage";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type DolibarrApiConfig = {
  enabled?: boolean;
  endpoint?: string | null;
  apiKey?: string | null;
};

type DolibarrEmployeePayload = {
  login: string;
  email: string;
  firstname: string;
  lastname: string;
  employee: number;
  office_phone?: string;
  user_mobile?: string;
  job?: string;
};

export interface DolibarrEmployeeSyncInput {
  name: string;
  email: string;
  role?: string | null;
  department?: string | null;
  branch?: string | null;
  phone?: string | null;
}

export interface DolibarrEmployeeSyncResult {
  ok: boolean;
  status: "created" | "exists" | "skipped" | "failed";
  message: string;
  dolibarrUserId: number | null;
  endpointUsed: string | null;
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeEmail(value: string): string {
  return normalizeText(value).toLowerCase();
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const cleaned = normalizeText(name).replace(/\s+/g, " ");
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

function buildEmployeeLogin(email: string, name: string): string {
  const fromEmail = email.split("@")[0] || "";
  const fromName = name.toLowerCase().replace(/\s+/g, ".");
  const cleaned = (fromEmail || fromName || "employee")
    .replace(/[^a-z0-9._-]/gi, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 42)
    .toLowerCase();
  return cleaned || `employee_${Date.now().toString(36).slice(-6)}`;
}

function buildRetryLogin(baseLogin: string): string {
  const suffix = Date.now().toString(36).slice(-4);
  return `${baseLogin.slice(0, 36)}_${suffix}`;
}

function buildJobTitle(input: DolibarrEmployeeSyncInput): string | undefined {
  const parts = [normalizeText(input.role), normalizeText(input.department), normalizeText(input.branch)]
    .filter(Boolean)
    .slice(0, 3);
  if (!parts.length) return undefined;
  return parts.join(" | ").slice(0, 80);
}

function buildDolibarrApiBases(rawEndpoint: string): string[] {
  const cleaned = normalizeText(rawEndpoint).replace(/\/+$/, "");
  if (!cleaned) return [];
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
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

function buildDolibarrHeaders(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    DOLAPIKEY: apiKey,
    "X-Dolibarr-API-Key": apiKey,
  };
}

async function parseBody(response: Response): Promise<{ text: string; json: any | null }> {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) as any };
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

async function lookupDolibarrUserByEmail(
  apiBase: string,
  email: string,
  apiKey: string
): Promise<{ found: boolean; userId: number | null; message?: string }> {
  const response = await fetch(`${apiBase}/users/email/${encodeURIComponent(email)}`, {
    method: "GET",
    headers: buildDolibarrHeaders(apiKey),
  });

  if (response.status === 404) {
    return { found: false, userId: null };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      found: false,
      userId: null,
      message: `Dolibarr authentication failed with HTTP ${response.status}.`,
    };
  }
  if (!response.ok) {
    return { found: false, userId: null };
  }

  const { json } = await parseBody(response);
  const userId = parseDolibarrUserId(json);
  const foundEmail =
    json && typeof json === "object" && typeof (json as Record<string, unknown>).email === "string"
      ? String((json as Record<string, unknown>).email).trim().toLowerCase()
      : "";
  if (!userId && foundEmail && foundEmail !== email) {
    return { found: false, userId: null };
  }
  return { found: true, userId };
}

async function createDolibarrEmployee(
  apiBase: string,
  apiKey: string,
  payload: DolibarrEmployeePayload
): Promise<{ ok: boolean; userId: number | null; conflict: boolean; message: string }> {
  const response = await fetch(`${apiBase}/users`, {
    method: "POST",
    headers: buildDolibarrHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  const { text, json } = await parseBody(response);
  const jsonObject = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const errorObject =
    jsonObject && jsonObject.error && typeof jsonObject.error === "object"
      ? (jsonObject.error as Record<string, unknown>)
      : null;
  const messageFromJson =
    typeof errorObject?.message === "string"
      ? String(errorObject.message)
      : typeof jsonObject?.message === "string"
        ? String(jsonObject.message)
        : "";
  const message = messageFromJson || text || `Dolibarr responded with HTTP ${response.status}.`;

  if (!response.ok) {
    const conflict =
      response.status === 409 ||
      /already exists|already used|duplicate|login exists/i.test(message);
    return { ok: false, userId: null, conflict, message };
  }

  return {
    ok: true,
    userId: parseDolibarrUserId(json ?? text),
    conflict: false,
    message: "Employee created in Dolibarr.",
  };
}

function buildDolibarrEmployeePayload(input: DolibarrEmployeeSyncInput, login: string): DolibarrEmployeePayload {
  const normalizedEmail = normalizeEmail(input.email);
  const nameParts = splitDisplayName(input.name);
  const payload: DolibarrEmployeePayload = {
    login,
    email: normalizedEmail,
    firstname: nameParts.firstName,
    lastname: nameParts.lastName,
    employee: 1,
  };

  const cleanedPhone = normalizeText(input.phone);
  if (cleanedPhone) {
    payload.office_phone = cleanedPhone;
    payload.user_mobile = cleanedPhone;
  }

  const job = buildJobTitle(input);
  if (job) {
    payload.job = job;
  }
  return payload;
}

export async function syncApprovedUserToDolibarrEmployee(
  user: DolibarrEmployeeSyncInput,
  config?: DolibarrApiConfig
): Promise<DolibarrEmployeeSyncResult> {
  const enabled = config?.enabled ?? true;
  if (!enabled) {
    return {
      ok: false,
      status: "skipped",
      message: "Dolibarr sync disabled in settings.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const endpoint = normalizeText(config?.endpoint || process.env.DOLIBARR_ENDPOINT || "");
  const apiKey = normalizeText(config?.apiKey || process.env.DOLIBARR_API_KEY || "");
  if (!endpoint || !apiKey) {
    return {
      ok: false,
      status: "skipped",
      message: "Dolibarr endpoint and API key are required.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const normalizedEmail = normalizeEmail(user.email);
  if (!isLikelyEmail(normalizedEmail)) {
    return {
      ok: false,
      status: "failed",
      message: "A valid user email is required for Dolibarr employee sync.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const apiBases = buildDolibarrApiBases(endpoint);
  if (!apiBases.length) {
    return {
      ok: false,
      status: "failed",
      message: "Dolibarr endpoint format is invalid.",
      dolibarrUserId: null,
      endpointUsed: null,
    };
  }

  const baseLogin = buildEmployeeLogin(normalizedEmail, user.name);
  let lastFailure = "Unable to sync employee to Dolibarr.";

  for (const apiBase of apiBases) {
    const existing = await lookupDolibarrUserByEmail(apiBase, normalizedEmail, apiKey);
    if (existing.message) {
      lastFailure = existing.message;
      continue;
    }
    if (existing.found) {
      return {
        ok: true,
        status: "exists",
        message: "Employee already exists in Dolibarr.",
        dolibarrUserId: existing.userId,
        endpointUsed: apiBase,
      };
    }

    const basePayload = buildDolibarrEmployeePayload(user, baseLogin);
    const created = await createDolibarrEmployee(apiBase, apiKey, basePayload);
    if (created.ok) {
      return {
        ok: true,
        status: "created",
        message: created.message,
        dolibarrUserId: created.userId,
        endpointUsed: apiBase,
      };
    }

    if (created.conflict) {
      const retryPayload = buildDolibarrEmployeePayload(user, buildRetryLogin(baseLogin));
      const retried = await createDolibarrEmployee(apiBase, apiKey, retryPayload);
      if (retried.ok) {
        return {
          ok: true,
          status: "created",
          message: retried.message,
          dolibarrUserId: retried.userId,
          endpointUsed: apiBase,
        };
      }

      const existingAfterConflict = await lookupDolibarrUserByEmail(apiBase, normalizedEmail, apiKey);
      if (existingAfterConflict.found) {
        return {
          ok: true,
          status: "exists",
          message: "Employee already exists in Dolibarr.",
          dolibarrUserId: existingAfterConflict.userId,
          endpointUsed: apiBase,
        };
      }

      lastFailure = retried.message || created.message;
      continue;
    }

    lastFailure = created.message;
  }

  return {
    ok: false,
    status: "failed",
    message: lastFailure,
    dolibarrUserId: null,
    endpointUsed: null,
  };
}

export async function syncAttendanceWithDolibarr(
  attendance: AttendanceRecord,
  config?: {
    enabled?: boolean;
    endpoint?: string | null;
    apiKey?: string | null;
  }
): Promise<void> {
  const enabled = config?.enabled ?? true;
  if (!enabled) {
    await storage.addDolibarrSyncLog({
      id: randomUUID(),
      attendanceId: attendance.id,
      userId: attendance.userId,
      attempt: 1,
      status: "failed",
      message: "Dolibarr sync disabled in settings",
      createdAt: new Date().toISOString(),
      syncedAt: null,
    });
    return;
  }

  const endpoint = config?.endpoint || process.env.DOLIBARR_ENDPOINT;
  const apiKey = config?.apiKey || process.env.DOLIBARR_API_KEY;
  if (!endpoint || !apiKey) {
    await storage.addDolibarrSyncLog({
      id: randomUUID(),
      attendanceId: attendance.id,
      userId: attendance.userId,
      attempt: 1,
      status: "failed",
      message: "Dolibarr not configured",
      createdAt: new Date().toISOString(),
      syncedAt: null,
    });
    return;
  }

  const payload = {
    user_id: attendance.userId,
    user_name: attendance.userName,
    check_time: attendance.timestampServer ?? attendance.timestamp,
    geofence_id: attendance.geofenceId ?? null,
    geofence_name: attendance.geofenceName ?? null,
    latitude: attendance.location?.lat ?? null,
    longitude: attendance.location?.lng ?? null,
    action: attendance.type,
    note: attendance.notes ?? "",
    inside_geofence: attendance.isInsideGeofence ?? false,
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dolibarr-API-Key": apiKey,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Dolibarr sync failed with HTTP ${response.status}`);
      }

      await storage.addDolibarrSyncLog({
        id: randomUUID(),
        attendanceId: attendance.id,
        userId: attendance.userId,
        attempt,
        status: "synced",
        message: "Attendance pushed to Dolibarr",
        createdAt: new Date().toISOString(),
        syncedAt: new Date().toISOString(),
      });
      return;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      await storage.addDolibarrSyncLog({
        id: randomUUID(),
        attendanceId: attendance.id,
        userId: attendance.userId,
        attempt,
        status: isLast ? "failed" : "pending",
        message: error instanceof Error ? error.message : "Unknown Dolibarr sync error",
        createdAt: new Date().toISOString(),
        syncedAt: null,
      });
      if (!isLast) {
        await delay(attempt * 800);
      }
    }
  }
}
