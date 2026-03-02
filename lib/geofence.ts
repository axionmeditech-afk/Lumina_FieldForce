import type { Geofence, GeofenceEvaluation } from "@/lib/types";

const EARTH_RADIUS_METERS = 6371000;
const WEAK_SIGNAL_THRESHOLD_METERS = 220;
export const MIN_GEOFENCE_CAPTURE_RADIUS_METERS = 500;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

function isWithinWorkingHours(zone: Geofence, now = new Date()): boolean {
  if (!zone.workingHoursStart || !zone.workingHoursEnd) {
    return true;
  }

  const [startH, startM] = zone.workingHoursStart.split(":").map(Number);
  const [endH, endM] = zone.workingHoursEnd.split(":").map(Number);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (endMinutes >= startMinutes) {
    return minutesNow >= startMinutes && minutesNow <= endMinutes;
  }

  return minutesNow >= startMinutes || minutesNow <= endMinutes;
}

function normalizeAccuracy(accuracyMeters?: number): number | null {
  if (typeof accuracyMeters !== "number") return null;
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return null;
  return accuracyMeters;
}

function getConfidenceBufferMeters(accuracyMeters?: number): number {
  const accuracy = normalizeAccuracy(accuracyMeters);
  if (accuracy === null) return 15;
  return Math.max(10, Math.min(35, Math.round(accuracy * 0.5)));
}

export function getEffectiveGeofenceRadiusMeters(zone: Pick<Geofence, "radiusMeters">): number {
  const configuredRadius = Number.isFinite(zone.radiusMeters) ? zone.radiusMeters : 0;
  return Math.max(configuredRadius, MIN_GEOFENCE_CAPTURE_RADIUS_METERS);
}

export function evaluateGeofenceStatus(
  geofences: Geofence[],
  latitude: number,
  longitude: number,
  accuracyMeters?: number
): GeofenceEvaluation {
  const normalizedAccuracy = normalizeAccuracy(accuracyMeters);
  const signalWeak =
    normalizedAccuracy !== null ? normalizedAccuracy > WEAK_SIGNAL_THRESHOLD_METERS : false;

  if (!geofences.length) {
    return {
      inside: false,
      insideConfirmed: false,
      activeZone: null,
      nearestDistanceMeters: Number.POSITIVE_INFINITY,
      confidenceBufferMeters: getConfidenceBufferMeters(accuracyMeters),
      distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
      signalWeak,
      warning: "No geofence assigned",
    };
  }

  let nearestDistanceMeters = Number.POSITIVE_INFINITY;
  let nearestZone: Geofence | null = null;
  let nearestDistanceFromBoundary = Number.NEGATIVE_INFINITY;
  let insideMatch:
    | {
        zone: Geofence;
        distanceMeters: number;
        distanceFromBoundaryMeters: number;
        confirmed: boolean;
        confidenceBufferMeters: number;
      }
    | null = null;
  const confidenceBufferMeters = getConfidenceBufferMeters(accuracyMeters);

  for (const zone of geofences) {
    if (!zone.isActive) continue;
    if (!isWithinWorkingHours(zone)) continue;

    const distance = haversineDistanceMeters(latitude, longitude, zone.latitude, zone.longitude);
    const effectiveRadiusMeters = getEffectiveGeofenceRadiusMeters(zone);
    const distanceFromBoundary = effectiveRadiusMeters - distance;
    const confirmedInside =
      distance <= effectiveRadiusMeters &&
      (distance + confidenceBufferMeters <= effectiveRadiusMeters || confidenceBufferMeters <= 10);

    if (distance < nearestDistanceMeters) {
      nearestDistanceMeters = distance;
      nearestZone = zone;
      nearestDistanceFromBoundary = distanceFromBoundary;
    }
    if (distance <= effectiveRadiusMeters) {
      if (
        !insideMatch ||
        (confirmedInside && !insideMatch.confirmed) ||
        distance < insideMatch.distanceMeters
      ) {
        insideMatch = {
          zone,
          distanceMeters: distance,
          distanceFromBoundaryMeters: distanceFromBoundary,
          confirmed: confirmedInside,
          confidenceBufferMeters,
        };
      }
    }
  }

  if (insideMatch) {
    return {
      inside: true,
      insideConfirmed: insideMatch.confirmed,
      activeZone: insideMatch.zone,
      nearestDistanceMeters: insideMatch.distanceMeters,
      confidenceBufferMeters: insideMatch.confidenceBufferMeters,
      distanceFromBoundaryMeters: insideMatch.distanceFromBoundaryMeters,
      signalWeak,
      warning: insideMatch.confirmed
        ? undefined
        : "GPS fix is near geofence boundary. Move closer to office for strict validation.",
    };
  }

  return {
    inside: false,
    insideConfirmed: false,
    activeZone: nearestZone,
    nearestDistanceMeters,
    confidenceBufferMeters,
    distanceFromBoundaryMeters: nearestDistanceFromBoundary,
    signalWeak,
    warning: nearestZone
      ? `Outside ${nearestZone.name} zone`
      : "No active zone available for this schedule",
  };
}

export function formatDistance(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters)) return "N/A";
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)} m`;
  return `${(distanceMeters / 1000).toFixed(2)} km`;
}
