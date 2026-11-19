import type { Pool } from "mysql2/promise";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;
const PUSH_TIMEOUT_MS = 8_000;

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string | number | boolean | null>;
};

export type PushSendResult = {
  attempted: number;
  delivered: number;
  failed: number;
};

let tableReady: Promise<void> | null = null;

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === "string" && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(value.trim());
}

export async function ensurePushDevicesTable(pool: Pool): Promise<void> {
  if (!tableReady) {
    tableReady = pool.execute(
      `CREATE TABLE IF NOT EXISTS lff_push_devices (
        push_token VARCHAR(255) NOT NULL,
        user_id VARCHAR(64) NOT NULL,
        company_id VARCHAR(64) NULL,
        device_id VARCHAR(191) NOT NULL,
        platform VARCHAR(16) NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (push_token),
        KEY idx_lff_push_devices_user (user_id, active),
        KEY idx_lff_push_devices_company (company_id, active),
        KEY idx_lff_push_devices_device (user_id, device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ).then(() => undefined).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

export async function registerPushDevice(pool: Pool, input: {
  token: string;
  userId: string;
  companyId?: string | null;
  deviceId: string;
  platform: string;
}): Promise<void> {
  await ensurePushDevicesTable(pool);
  // A physical device may change its Expo token. Retire its older token so one
  // alert never appears twice after an app reinstall or token rotation.
  await pool.execute(
    `UPDATE lff_push_devices SET active=0, updated_at=NOW(3)
     WHERE user_id=? AND device_id=? AND push_token<>?`,
    [input.userId, input.deviceId, input.token],
  );
  await pool.execute(
    `INSERT INTO lff_push_devices
      (push_token, user_id, company_id, device_id, platform, active, created_at, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 1, NOW(3), NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       user_id=VALUES(user_id), company_id=VALUES(company_id), device_id=VALUES(device_id),
       platform=VALUES(platform), active=1, updated_at=NOW(3), last_seen_at=NOW(3)`,
    [input.token, input.userId, input.companyId || null, input.deviceId, input.platform],
  );
}

export async function unregisterPushDevice(pool: Pool, input: {
  userId: string;
  token?: string | null;
  deviceId?: string | null;
}): Promise<void> {
  await ensurePushDevicesTable(pool);
  if (input.token) {
    await pool.execute(
      `UPDATE lff_push_devices SET active=0, updated_at=NOW(3) WHERE user_id=? AND push_token=?`,
      [input.userId, input.token],
    );
  } else if (input.deviceId) {
    await pool.execute(
      `UPDATE lff_push_devices SET active=0, updated_at=NOW(3) WHERE user_id=? AND device_id=?`,
      [input.userId, input.deviceId],
    );
  }
}

export async function sendPushToUsers(pool: Pool, input: {
  userIds: string[];
  companyId?: string | null;
  payload: PushPayload;
}): Promise<PushSendResult> {
  const userIds = [...new Set(input.userIds.map((id) => id.trim()).filter(Boolean))].slice(0, 500);
  if (!userIds.length) return { attempted: 0, delivered: 0, failed: 0 };
  await ensurePushDevicesTable(pool);
  const placeholders = userIds.map(() => "?").join(",");
  const [rows] = await pool.execute<any[]>(
    `SELECT push_token FROM lff_push_devices
     WHERE active=1 AND user_id IN (${placeholders}) ${input.companyId ? "AND company_id=?" : ""}`,
    input.companyId ? [...userIds, input.companyId] : userIds,
  );
  return sendExpoPushTokens(pool, rows.map((row) => String(row.push_token || "")), input.payload);
}

export async function sendPushToCompany(pool: Pool, input: {
  companyId: string;
  payload: PushPayload;
}): Promise<PushSendResult> {
  await ensurePushDevicesTable(pool);
  const [rows] = await pool.execute<any[]>(
    `SELECT push_token FROM lff_push_devices WHERE active=1 AND company_id=?`,
    [input.companyId],
  );
  return sendExpoPushTokens(pool, rows.map((row) => String(row.push_token || "")), input.payload);
}

async function sendExpoPushTokens(pool: Pool, rawTokens: string[], payload: PushPayload): Promise<PushSendResult> {
  const tokens = [...new Set(rawTokens.filter(isExpoPushToken))];
  const result: PushSendResult = { attempted: tokens.length, delivered: 0, failed: 0 };
  for (let offset = 0; offset < tokens.length; offset += MAX_BATCH_SIZE) {
    const chunk = tokens.slice(offset, offset + MAX_BATCH_SIZE);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN?.trim()
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN.trim()}` }
            : {}),
        },
        body: JSON.stringify(chunk.map((to) => ({
          to,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          sound: "default",
          priority: "high",
          channelId: "employee_alerts",
        }))),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Expo push returned HTTP ${response.status}`);
      const json = await response.json() as { data?: Array<{ status?: string; details?: { error?: string } }> };
      const tickets = Array.isArray(json.data) ? json.data : [];
      const invalid: string[] = [];
      chunk.forEach((token, index) => {
        const ticket = tickets[index];
        if (ticket?.status === "ok") result.delivered += 1;
        else {
          result.failed += 1;
          if (ticket?.details?.error === "DeviceNotRegistered") invalid.push(token);
        }
      });
      if (invalid.length) {
        await pool.execute(
          `UPDATE lff_push_devices SET active=0, updated_at=NOW(3)
           WHERE push_token IN (${invalid.map(() => "?").join(",")})`,
          invalid,
        );
      }
    } catch (error) {
      result.failed += chunk.length;
      console.warn("[push] delivery failed", error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timeout);
    }
  }
  return result;
}
