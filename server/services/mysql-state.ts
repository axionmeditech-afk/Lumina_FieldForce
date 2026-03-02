import mysql, { type Pool, type PoolOptions, type RowDataPacket } from "mysql2/promise";

interface StateRow extends RowDataPacket {
  state_key: string;
  json_value: string;
  updated_at: string;
}

let pool: Pool | null = null;
let tableEnsured = false;

const TABLE_NAME = "lff_app_state";

function normalizeBool(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toNullable(value: string | undefined): string | null {
  const normalized = value?.trim() || "";
  return normalized ? normalized : null;
}

function toPort(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3306;
  return Math.trunc(parsed);
}

function buildPoolConfig(): PoolOptions | null {
  const host = toNullable(process.env.MYSQL_HOST);
  const user = toNullable(process.env.MYSQL_USER);
  const password = toNullable(process.env.MYSQL_PASSWORD);
  const database =
    toNullable(process.env.MYSQL_DATABASE) || toNullable(process.env.MYSQL_DB);

  if (!host || !user || !password || !database) {
    return null;
  }

  const sslEnabled = normalizeBool(process.env.MYSQL_SSL);
  const sslRejectUnauthorized = normalizeBool(
    process.env.MYSQL_SSL_REJECT_UNAUTHORIZED ?? "false"
  );

  const config: PoolOptions = {
    host,
    user,
    password,
    database,
    port: toPort(process.env.MYSQL_PORT),
    connectionLimit: 12,
    waitForConnections: true,
    queueLimit: 0,
    namedPlaceholders: true,
    charset: "utf8mb4",
  };

  if (sslEnabled) {
    config.ssl = {
      rejectUnauthorized: sslRejectUnauthorized,
    };
  }

  return config;
}

export function isMySqlStateEnabled(): boolean {
  return buildPoolConfig() !== null;
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;

  const config = buildPoolConfig();
  if (!config) {
    throw new Error("MySQL state store is not configured. Set MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE.");
  }

  pool = mysql.createPool(config);
  return pool;
}

async function ensureStateTable(): Promise<void> {
  if (tableEnsured) return;
  const conn = await getPool();
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS \`${TABLE_NAME}\` (
      \`state_key\` VARCHAR(191) NOT NULL,
      \`json_value\` LONGTEXT NOT NULL,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`state_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tableEnsured = true;
}

export async function getMySqlStateValue(key: string): Promise<string | null> {
  if (!isMySqlStateEnabled()) return null;
  await ensureStateTable();
  const conn = await getPool();
  const [rows] = await conn.execute<StateRow[]>(
    `SELECT state_key, json_value, updated_at FROM \`${TABLE_NAME}\` WHERE state_key = ? LIMIT 1`,
    [key]
  );
  if (!rows.length) return null;
  return rows[0].json_value;
}

export async function setMySqlStateValue(key: string, jsonValue: string): Promise<void> {
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL state store is not configured.");
  }
  await ensureStateTable();
  const conn = await getPool();
  await conn.execute(
    `INSERT INTO \`${TABLE_NAME}\` (state_key, json_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       json_value = VALUES(json_value),
       updated_at = CURRENT_TIMESTAMP`,
    [key, jsonValue]
  );
}

