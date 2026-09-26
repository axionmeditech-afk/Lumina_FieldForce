import { randomUUID } from "crypto";
import type { AttendanceRecord } from "@/lib/types";
import { storage } from "@/server/storage";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncAttendanceWithDolibarr(
  attendance: AttendanceRecord,
  config?: {
    enabled?: boolean;
    endpoint?: string | null;
    apiKey?: string | null;
  }
): Promise<void> {

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
