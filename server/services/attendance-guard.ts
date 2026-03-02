import { randomUUID } from "crypto";
import type { AttendanceAnomaly, AttendanceCheckPayload, Geofence } from "@/lib/types";
import { getEffectiveGeofenceRadiusMeters, haversineDistanceMeters } from "@/lib/geofence";
import { storage } from "@/server/storage";

function nowISO(): string {
  return new Date().toISOString();
}

function getConfidenceBufferMeters(accuracyMeters?: number | null): number {
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    return 15;
  }
  return Math.max(10, Math.min(35, Math.round(accuracyMeters * 0.5)));
}

export function resolveGeofenceStatus(
  payload: AttendanceCheckPayload,
  zones: Geofence[]
): {
  inside: boolean;
  insideConfirmed: boolean;
  activeZone: Geofence | null;
  distanceMeters: number;
  confidenceBufferMeters: number;
  distanceFromBoundaryMeters: number;
} {
  let bestDistance = Number.POSITIVE_INFINITY;
  let activeZone: Geofence | null = null;
  let inside = false;
  let insideConfirmed = false;
  const confidenceBufferMeters = getConfidenceBufferMeters(payload.locationAccuracyMeters);
  let distanceFromBoundaryMeters = Number.NEGATIVE_INFINITY;

  for (const zone of zones) {
    if (!zone.isActive) continue;
    const effectiveRadiusMeters = getEffectiveGeofenceRadiusMeters(zone);
    const distance = haversineDistanceMeters(
      payload.latitude,
      payload.longitude,
      zone.latitude,
      zone.longitude
    );
    const boundaryDistance = effectiveRadiusMeters - distance;
    const confirmed =
      distance <= effectiveRadiusMeters &&
      (distance + confidenceBufferMeters <= effectiveRadiusMeters || confidenceBufferMeters <= 10);
    if (distance < bestDistance) {
      bestDistance = distance;
      activeZone = zone;
      distanceFromBoundaryMeters = boundaryDistance;
    }
    if (distance <= effectiveRadiusMeters) {
      if (!inside || (confirmed && !insideConfirmed) || distance < bestDistance) {
        bestDistance = distance;
        activeZone = zone;
        inside = true;
        insideConfirmed = confirmed;
        distanceFromBoundaryMeters = boundaryDistance;
      }
    }
  }

  return {
    inside,
    insideConfirmed,
    activeZone,
    distanceMeters: bestDistance,
    confidenceBufferMeters,
    distanceFromBoundaryMeters,
  };
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
