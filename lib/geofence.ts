import type { Geofence, GeofenceEvaluation } from "@/lib/types";

const EARTH_RADIUS_METERS = 6371000;
export const MAX_ATTENDANCE_ACCURACY_METERS = 120;
export const MAX_AUTO_CHECKOUT_ACCURACY_METERS = 300;
export const GEOFENCE_EXIT_MARGIN_METERS = 30;
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

  const c = 2 * Math.atan2(Math.sqrt(Math.min(1, Math.max(0, a))), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_METERS * c;
}

function isWithinWorkingHours(zone: Geofence, now = new Date()): boolean {
  if (!zone.workingHoursStart || !zone.workingHoursEnd) {
    return true;
  }

  const [startH, startM] = zone.workingHoursStart.split(":").map(Number);
  const [endH, endM] = zone.workingHoursEnd.split(":").map(Number);
  const ist = new Date(now.getTime() + 330 * 60_000);
  const minutesNow = ist.getUTCHours() * 60 + ist.getUTCMinutes();
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
  return Math.max(10, Math.ceil(accuracy));
}

export function getEffectiveGeofenceRadiusMeters(zone: Pick<Geofence, "radiusMeters">): number {
  const configuredRadius = Number.isFinite(zone.radiusMeters) ? zone.radiusMeters : 0;
  return Math.max(configuredRadius, MIN_GEOFENCE_CAPTURE_RADIUS_METERS);
}

export function evaluateGeofenceStatus(
  geofences: Geofence[],
  latitude: number,
  longitude: number,
  accuracyMeters?: number,
  ignoreSchedule = false
): GeofenceEvaluation {
  const normalizedAccuracy = normalizeAccuracy(accuracyMeters);
  const signalWeak =
    normalizedAccuracy === null || normalizedAccuracy > MAX_ATTENDANCE_ACCURACY_METERS;

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
    if (!ignoreSchedule && !isWithinWorkingHours(zone)) continue;
    if (!validCoordinates(zone.latitude, zone.longitude) || !validCoordinates(latitude, longitude)) continue;

    const distance = haversineDistanceMeters(latitude, longitude, zone.latitude, zone.longitude);
    const effectiveRadiusMeters = getEffectiveGeofenceRadiusMeters(zone);
    const distanceFromBoundary = effectiveRadiusMeters - distance;
    const confirmedInside =
      distance <= effectiveRadiusMeters &&
      !signalWeak && distance + confidenceBufferMeters <= effectiveRadiusMeters;

    if (distance < nearestDistanceMeters) {
      nearestDistanceMeters = distance;
      nearestZone = zone;
      nearestDistanceFromBoundary = distanceFromBoundary;
    }
    if (distance <= effectiveRadiusMeters) {
      if (
        !insideMatch ||
        (confirmedInside && !insideMatch.confirmed) ||
        (confirmedInside === insideMatch.confirmed && distance < insideMatch.distanceMeters)
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

export function validCoordinates(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

export function isConfidentlyOutside(zone: Geofence, latitude: number, longitude: number, accuracy: number): boolean {
  return validCoordinates(latitude, longitude) && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= MAX_ATTENDANCE_ACCURACY_METERS &&
    haversineDistanceMeters(latitude, longitude, zone.latitude, zone.longitude) - accuracy >
    getEffectiveGeofenceRadiusMeters(zone) + GEOFENCE_EXIT_MARGIN_METERS;
}

export type AutoCheckoutExitDecision = {
  usable: boolean;
  outside: boolean;
  distanceMeters: number;
  effectiveRadiusMeters: number;
  accuracyMeters: number | null;
  bufferMeters: number;
  reason:
    | "outside_confirmed"
    | "inside_or_boundary"
    | "invalid_location"
    | "accuracy_missing"
    | "accuracy_too_weak";
};

export function getAutoCheckoutBufferMeters(accuracyMeters: number | null | undefined): number | null {
  const accuracy = normalizeAccuracy(accuracyMeters ?? undefined);
  if (accuracy === null) return null;
  if (accuracy > MAX_AUTO_CHECKOUT_ACCURACY_METERS) return null;
  if (accuracy <= 10) return 50;
  if (accuracy <= MAX_ATTENDANCE_ACCURACY_METERS) return 100;
  return 150;
}

export function evaluateAutoCheckoutExit(
  zone: Geofence,
  latitude: number,
  longitude: number,
  accuracyMeters?: number | null
): AutoCheckoutExitDecision {
  const effectiveRadiusMeters = getEffectiveGeofenceRadiusMeters(zone);
  const accuracy = normalizeAccuracy(accuracyMeters ?? undefined);
  const invalid = !validCoordinates(latitude, longitude) || !validCoordinates(zone.latitude, zone.longitude);
  if (invalid) {
    return {
      usable: false,
      outside: false,
      distanceMeters: Number.POSITIVE_INFINITY,
      effectiveRadiusMeters,
      accuracyMeters: accuracy,
      bufferMeters: 0,
      reason: "invalid_location",
    };
  }

  const distanceMeters = haversineDistanceMeters(latitude, longitude, zone.latitude, zone.longitude);
  const bufferMeters = getAutoCheckoutBufferMeters(accuracy);
  if (accuracy === null || bufferMeters === null) {
    return {
      usable: false,
      outside: false,
      distanceMeters,
      effectiveRadiusMeters,
      accuracyMeters: accuracy,
      bufferMeters: 0,
      reason: accuracy === null ? "accuracy_missing" : "accuracy_too_weak",
    };
  }

  const outside =
    distanceMeters > effectiveRadiusMeters + bufferMeters &&
    distanceMeters - accuracy > effectiveRadiusMeters + GEOFENCE_EXIT_MARGIN_METERS;

  return {
    usable: true,
    outside,
    distanceMeters,
    effectiveRadiusMeters,
    accuracyMeters: accuracy,
    bufferMeters,
    reason: outside ? "outside_confirmed" : "inside_or_boundary",
  };
}
