import * as SQLite from 'expo-sqlite';
import type { RoutePoint, TrackingSession } from '../types';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let databaseOperationTail: Promise<void> = Promise.resolve();
const databaseOpenOptions: SQLite.SQLiteOpenOptions = {
  // Android SDK 57 can retain a released cached native connection after a JS
  // runtime reload while the app process stays alive. A fresh native connection
  // avoids that poisoned handle; this database module still owns one connection
  // per JS runtime through databasePromise.
  useNewConnection: true,
  finalizeUnusedStatementsBeforeClosing: true
};

type SqlRunner = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

function isTransientDatabaseLock(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('database is locked') || message.includes('database is busy') || message.includes('sqlite_busy');
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryTransientDatabaseLock<T>(operation: () => Promise<T>): Promise<T> {
  // Background location delivery can briefly overlap a foreground stop on
  // Android. WAL plus one JS queue handles the usual case; this short retry
  // handles the separate native task runtime without losing the write.
  const delays = [0, 80, 180, 360];
  let failure: unknown;
  for (const delay of delays) {
    if (delay) await pause(delay);
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (!isTransientDatabaseLock(error)) throw error;
    }
  }
  throw failure;
}

function enqueueDatabaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = databaseOperationTail.then(() => retryTransientDatabaseLock(operation), () => retryTransientDatabaseLock(operation));
  databaseOperationTail = next.then(() => undefined, () => undefined);
  return next;
}

function serializeDatabase(db: SQLite.SQLiteDatabase): SQLite.SQLiteDatabase {
  const serializedMethods = new Set<PropertyKey>([
    'execAsync',
    'runAsync',
    'getFirstAsync',
    'getAllAsync',
    'getEachAsync',
    'withTransactionAsync',
    'withExclusiveTransactionAsync'
  ]);
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || !serializedMethods.has(property)) return value;
      return (...args: unknown[]) => enqueueDatabaseOperation(() => value.apply(target, args));
    }
  }) as SQLite.SQLiteDatabase;
}

async function upsertStateOn(db: SqlRunner, key: string, value: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key,
    value,
    new Date().toISOString()
  );
}

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    const opening = SQLite.openDatabaseAsync('lumina-field-tracking.db', databaseOpenOptions).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracking_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          employee_id TEXT NOT NULL,
          company_id TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('active','completed')),
          next_sequence INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_active ON tracking_sessions(status, started_at);
        CREATE TABLE IF NOT EXISTS location_points (
          point_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          sequence_no INTEGER NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          accuracy REAL,
          speed REAL,
          heading REAL,
          battery REAL,
          mocked INTEGER NOT NULL DEFAULT 0,
          captured_at TEXT NOT NULL,
          synced_at TEXT,
          route_eligible INTEGER NOT NULL DEFAULT 1,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(session_id) REFERENCES tracking_sessions(id),
          UNIQUE(session_id, sequence_no)
        );
        CREATE INDEX IF NOT EXISTS idx_points_route ON location_points(session_id, sequence_no);
        CREATE INDEX IF NOT EXISTS idx_points_outbox ON location_points(synced_at, created_at);
        CREATE TABLE IF NOT EXISTS session_end_outbox (
          session_id TEXT PRIMARY KEY NOT NULL,
          ended_at TEXT NOT NULL,
          synced_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL
        );
      `);
      const sessionColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(tracking_sessions)');
      if (!sessionColumns.some((column) => column.name === 'company_id')) {
        await db.execAsync("ALTER TABLE tracking_sessions ADD COLUMN company_id TEXT NOT NULL DEFAULT ''");
      }
      return serializeDatabase(db);
    });
    databasePromise = opening.catch((error: unknown) => {
      // Do not permanently cache a failed native handle. The next tracker
      // operation can establish a clean connection instead of repeating it.
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function setState(key: string, value: string): Promise<void> {
  const db = await getDatabase();
  await upsertStateOn(db, key, value);
}

export async function getState(key: string): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_state WHERE key = ?', key);
  return row?.value ?? null;
}

export async function createSession(session: TrackingSession): Promise<void> {
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      "UPDATE tracking_sessions SET status='completed', ended_at=COALESCE(ended_at, ?) WHERE status='active'",
      session.startedAt
    );
    await txn.runAsync(
      'INSERT INTO tracking_sessions(id, employee_id, company_id, started_at, ended_at, status, next_sequence) VALUES (?, ?, ?, ?, ?, ?, 1)',
      session.id,
      session.employeeId,
      session.companyId,
      session.startedAt,
      session.endedAt,
      session.status
    );
    await upsertStateOn(txn, 'active_session_id', session.id);
  });
}

export async function setSessionCompanyIfMissing(sessionId: string, companyId: string): Promise<void> {
  const normalized = companyId.trim();
  if (!normalized) return;
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE tracking_sessions SET company_id=? WHERE id=? AND (company_id='' OR company_id IS NULL)",
    normalized,
    sessionId,
  );
}

export async function getActiveSession(employeeId?: string): Promise<TrackingSession | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string;
    employee_id: string;
    company_id: string;
    started_at: string;
    ended_at: string | null;
    status: 'active' | 'completed';
  }>(
    `SELECT id, employee_id, company_id, started_at, ended_at, status
     FROM tracking_sessions WHERE status='active'${employeeId ? ' AND employee_id=?' : ''}
     ORDER BY started_at DESC LIMIT 1`,
    ...(employeeId ? [employeeId] : []),
  );
  return row
    ? { id: row.id, employeeId: row.employee_id, companyId: row.company_id, startedAt: row.started_at, endedAt: row.ended_at, status: row.status }
    : null;
}


export async function getLatestSession(employeeId?: string): Promise<TrackingSession | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string;
    employee_id: string;
    company_id: string;
    started_at: string;
    ended_at: string | null;
    status: 'active' | 'completed';
  }>(
    `SELECT id, employee_id, company_id, started_at, ended_at, status
     FROM tracking_sessions${employeeId ? ' WHERE employee_id=?' : ''}
     ORDER BY started_at DESC LIMIT 1`,
    ...(employeeId ? [employeeId] : []),
  );
  return row
    ? { id: row.id, employeeId: row.employee_id, companyId: row.company_id, startedAt: row.started_at, endedAt: row.ended_at, status: row.status }
    : null;
}

export async function completeActiveSession(endedAt: string, employeeId?: string): Promise<TrackingSession | null> {
  const db = await getDatabase();
  let completed: TrackingSession | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = await txn.getFirstAsync<{
      id: string;
      employee_id: string;
      company_id: string;
      started_at: string;
    }>(
      `SELECT id, employee_id, company_id, started_at FROM tracking_sessions
       WHERE status='active'${employeeId ? ' AND employee_id=?' : ''}
       ORDER BY started_at DESC LIMIT 1`,
      ...(employeeId ? [employeeId] : []),
    );
    if (!row) return;
    await txn.runAsync("UPDATE tracking_sessions SET status='completed', ended_at=? WHERE id=?", endedAt, row.id);
    await txn.runAsync(
      `INSERT INTO session_end_outbox(session_id, ended_at, synced_at, created_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT(session_id) DO UPDATE SET ended_at=excluded.ended_at, synced_at=NULL`,
      row.id,
      endedAt,
      new Date().toISOString()
    );
    await upsertStateOn(txn, 'active_session_id', '');
    completed = { id: row.id, employeeId: row.employee_id, companyId: row.company_id, startedAt: row.started_at, endedAt, status: 'completed' };
  });
  return completed;
}

export async function insertPointWithNextSequence(
  point: Omit<RoutePoint, 'sequence'>
): Promise<RoutePoint> {
  const db = await getDatabase();
  let inserted: RoutePoint | null = null;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const row = await txn.getFirstAsync<{ next_sequence: number }>(
      'SELECT next_sequence FROM tracking_sessions WHERE id=? AND status=\'active\'',
      point.sessionId
    );
    if (!row) throw new Error('active_session_missing');
    const sequence = Math.max(1, Number(row.next_sequence) || 1);
    const completePoint: RoutePoint = { ...point, sequence };
    await txn.runAsync('UPDATE tracking_sessions SET next_sequence=? WHERE id=?', sequence + 1, point.sessionId);
    await txn.runAsync(
      `INSERT INTO location_points(
        point_id, session_id, sequence_no, latitude, longitude, accuracy, speed, heading,
        battery, mocked, captured_at, synced_at, route_eligible, rejection_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      completePoint.pointId,
      completePoint.sessionId,
      completePoint.sequence,
      completePoint.latitude,
      completePoint.longitude,
      completePoint.accuracy,
      completePoint.speed,
      completePoint.heading,
      completePoint.battery,
      completePoint.mocked ? 1 : 0,
      completePoint.capturedAt,
      completePoint.syncedAt,
      completePoint.routeEligible ? 1 : 0,
      completePoint.rejectionReason,
      new Date().toISOString()
    );
    await upsertStateOn(txn, 'last_captured_at', completePoint.capturedAt);
    inserted = completePoint;
  });
  if (!inserted) throw new Error('point_insert_failed');
  return inserted;
}

function mapPoint(row: Record<string, unknown>): RoutePoint {
  return {
    pointId: String(row.point_id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence_no),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
    speed: row.speed == null ? null : Number(row.speed),
    heading: row.heading == null ? null : Number(row.heading),
    battery: row.battery == null ? null : Number(row.battery),
    mocked: Boolean(row.mocked),
    capturedAt: String(row.captured_at),
    syncedAt: row.synced_at == null ? null : String(row.synced_at),
    routeEligible: Boolean(row.route_eligible),
    rejectionReason: row.rejection_reason == null ? null : String(row.rejection_reason)
  };
}

export async function getRoute(sessionId: string, limit = 5000): Promise<RoutePoint[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM location_points WHERE session_id=? ORDER BY sequence_no ASC LIMIT ?',
    sessionId,
    limit
  );
  return rows.map(mapPoint);
}

export async function getLastPoint(sessionId: string): Promise<RoutePoint | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM location_points WHERE session_id=? ORDER BY sequence_no DESC LIMIT 1',
    sessionId
  );
  return row ? mapPoint(row) : null;
}

export async function getLastEligiblePoint(sessionId: string): Promise<RoutePoint | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<Record<string, unknown>>(
    'SELECT * FROM location_points WHERE session_id=? AND route_eligible=1 ORDER BY sequence_no DESC LIMIT 1',
    sessionId
  );
  return row ? mapPoint(row) : null;
}

export async function getRouteAfter(sessionId: string, afterSequence: number, limit = 500): Promise<RoutePoint[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM location_points WHERE session_id=? AND sequence_no>? ORDER BY sequence_no ASC LIMIT ?',
    sessionId,
    afterSequence,
    limit
  );
  return rows.map(mapPoint);
}

export async function getSession(sessionId: string): Promise<TrackingSession | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ id: string; employee_id: string; company_id: string; started_at: string; ended_at: string | null; status: 'active' | 'completed' }>(
    'SELECT id, employee_id, company_id, started_at, ended_at, status FROM tracking_sessions WHERE id=?',
    sessionId
  );
  return row ? { id: row.id, employeeId: row.employee_id, companyId: row.company_id, startedAt: row.started_at, endedAt: row.ended_at, status: row.status } : null;
}

export async function getPendingBatch(limit: number, employeeId?: string): Promise<RoutePoint[]> {
  const db = await getDatabase();
  const first = await db.getFirstAsync<{ session_id: string }>(
    `SELECT p.session_id FROM location_points p
     JOIN tracking_sessions s ON s.id=p.session_id
     WHERE p.synced_at IS NULL${employeeId ? ' AND s.employee_id=?' : ''}
     ORDER BY p.created_at ASC LIMIT 1`,
    ...(employeeId ? [employeeId] : []),
  );
  if (!first) return [];
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM location_points
     WHERE synced_at IS NULL AND session_id=?
     ORDER BY sequence_no ASC LIMIT ?`,
    first.session_id,
    limit
  );
  return rows.map(mapPoint);
}

export async function acknowledgePoints(pointIds: string[], syncedAt: string): Promise<void> {
  if (!pointIds.length) return;
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const pointId of pointIds) {
      await txn.runAsync('UPDATE location_points SET synced_at=? WHERE point_id=? AND synced_at IS NULL', syncedAt, pointId);
    }
    await upsertStateOn(txn, 'last_synced_at', syncedAt);
  });
}


export async function acknowledgeRejectedPoints(
  rejected: { pointId: string; reason: string }[],
  acknowledgedAt: string
): Promise<void> {
  if (!rejected.length) return;
  const db = await getDatabase();
  await db.withExclusiveTransactionAsync(async (txn) => {
    for (const item of rejected) {
      await txn.runAsync(
        `UPDATE location_points
         SET synced_at=?, route_eligible=0, rejection_reason=?
         WHERE point_id=? AND synced_at IS NULL`,
        acknowledgedAt,
        `server_${item.reason}`.slice(0, 64),
        item.pointId
      );
    }
    await upsertStateOn(txn, 'last_synced_at', acknowledgedAt);
  });
}

export async function getPendingSessionEnds(employeeId?: string): Promise<{ sessionId: string; endedAt: string }[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ session_id: string; ended_at: string }>(
    `SELECT e.session_id, e.ended_at FROM session_end_outbox e
     JOIN tracking_sessions s ON s.id=e.session_id
     WHERE e.synced_at IS NULL${employeeId ? ' AND s.employee_id=?' : ''}
     ORDER BY e.created_at ASC LIMIT 10`,
    ...(employeeId ? [employeeId] : []),
  );
  return rows.map((row) => ({ sessionId: row.session_id, endedAt: row.ended_at }));
}

export async function acknowledgeSessionEnd(sessionId: string, syncedAt: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE session_end_outbox SET synced_at=? WHERE session_id=?', syncedAt, sessionId);
}


export async function countPendingForSession(sessionId: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ total: number }>(
    'SELECT COUNT(*) AS total FROM location_points WHERE session_id=? AND synced_at IS NULL',
    sessionId
  );
  return row?.total ?? 0;
}

export async function countPending(employeeId?: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COUNT(*) AS total FROM location_points p
     JOIN tracking_sessions s ON s.id=p.session_id
     WHERE p.synced_at IS NULL${employeeId ? ' AND s.employee_id=?' : ''}`,
    ...(employeeId ? [employeeId] : []),
  );
  return row?.total ?? 0;
}

export async function recordSyncEvent(eventType: string, detail?: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO sync_events(event_type, detail, created_at) VALUES (?, ?, ?)',
    eventType,
    detail ?? null,
    new Date().toISOString()
  );
}

export async function pruneSyncedHistory(maxRows: number): Promise<void> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ total: number }>('SELECT COUNT(*) AS total FROM location_points');
  const excess = Math.max(0, (row?.total ?? 0) - maxRows);
  if (!excess) return;
  await db.runAsync(
    `DELETE FROM location_points WHERE point_id IN (
       SELECT point_id FROM location_points
       WHERE synced_at IS NOT NULL
       ORDER BY created_at ASC LIMIT ?
     )`,
    excess
  );
}
