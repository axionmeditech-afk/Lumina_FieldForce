import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { getMySqlPool, isMySqlStateEnabled } from "./mysql-state";

export const attendanceConnection = new AsyncLocalStorage<PoolConnection>();
const pending = new Map<string, Promise<void>>();

// Serialize a user's transitions across both simultaneous requests and server instances.
// The DB lock must be released on the same connection, including on failed writes.
export async function withAttendanceLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(userId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(userId, current);
  await previous;
  try {
    if (!isMySqlStateEnabled()) return await work();
    const conn = await (await getMySqlPool()).getConnection();
    const name = `attendance:${createHash("sha256").update(userId).digest("hex").slice(0, 48)}`;
    let acquired = false;
    try {
      const [rows] = await conn.query<any[]>("SELECT GET_LOCK(?, 5) AS acquired", [name]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw new Error("Attendance is busy. Please retry.");
      return await attendanceConnection.run(conn, work);
    } finally {
      if (acquired) {
        try { await conn.query("SELECT RELEASE_LOCK(?)", [name]); }
        catch { conn.destroy(); }
      }
      conn.release();
    }
  } finally {
    release();
    if (pending.get(userId) === current) pending.delete(userId);
  }
}
