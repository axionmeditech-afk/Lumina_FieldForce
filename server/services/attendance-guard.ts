import { randomUUID } from "crypto";
import type { AttendanceAnomaly, AttendanceCheckPayload, Geofence } from "@/lib/types";
import { evaluateGeofenceStatus } from "@/lib/geofence";
import { storage } from "@/server/storage";

function nowISO(): string {
  return new Date().toISOString();
}

export function resolveGeofenceStatus(payload: AttendanceCheckPayload, zones: Geofence[]) {
  const result = evaluateGeofenceStatus(zones, payload.latitude, payload.longitude, payload.locationAccuracyMeters ?? undefined);
  return { ...result, distanceMeters: result.nearestDistanceMeters };
}

export async function recordAnomaly(
  anomaly: Omit<AttendanceAnomaly, "id" | "createdAt">
): Promise<void> {
  await storage.addAnomaly({
    ...anomaly,
    id: randomUUID(),
    createdAt: nowISO(),
  });
}
