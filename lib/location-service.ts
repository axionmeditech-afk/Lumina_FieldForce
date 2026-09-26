import * as Location from "expo-location";
import type { LocationObject } from "expo-location";

export interface LocationPermissionState {
  foreground: boolean;
  background: boolean;
  foregroundCanAskAgain: boolean;
  backgroundCanAskAgain: boolean;
}

export interface AccurateLocationOptions {
  minAccuracyMeters?: number;
  maxAttempts?: number;
}

export interface VerifiedLocationOptions extends AccurateLocationOptions {
  requiredStableSamples?: number;
  maxDriftMeters?: number;
  sampleWaitMs?: number;
  timeoutMs?: number;
}

export interface VerifiedLocationEvidence {
  location: LocationObject;
  sampleCount: number;
  sampleWindowMs: number;
  averageAccuracyMeters: number | null;
  bestAccuracyMeters: number | null;
}

const DEFAULT_MIN_ACCURACY_METERS = 100;
const DEFAULT_LOCATION_ATTEMPTS = 3;
const SAMPLE_WAIT_MS = 1200;
const DEFAULT_STABLE_SAMPLES = 2;
const DEFAULT_MAX_DRIFT_METERS = 55;
const DEFAULT_LOCATION_TIMEOUT_MS = 15000;
const MAX_SINGLE_FIX_WAIT_MS = 6000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function getCurrentPositionWithTimeout(
  options: Location.LocationOptions,
  timeoutMs = MAX_SINGLE_FIX_WAIT_MS
): Promise<LocationObject> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync(options),
      new Promise<LocationObject>((_, reject) => {
        timer = setTimeout(() => reject(new Error("GPS fix timed out.")), Math.max(500, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getAccuracyScore(location: LocationObject | null): number {
  return location?.coords.accuracy ?? Number.POSITIVE_INFINITY;
}

function distanceBetweenMeters(from: LocationObject, to: LocationObject): number {
  const earthRadiusMeters = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(to.coords.latitude - from.coords.latitude);
  const dLng = toRadians(to.coords.longitude - from.coords.longitude);
  const lat1 = toRadians(from.coords.latitude);
  const lat2 = toRadians(to.coords.latitude);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function buildEvidence(samples: LocationObject[], best: LocationObject): VerifiedLocationEvidence {
  const ordered = [...samples].sort(
    (a, b) => a.timestamp - b.timestamp
  );
  const sampleCount = ordered.length;
  const sampleWindowMs =
    sampleCount > 1 ? Math.max(0, ordered[sampleCount - 1].timestamp - ordered[0].timestamp) : 0;
  const accuracies = ordered
    .map((entry) => entry.coords.accuracy)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const averageAccuracyMeters =
    accuracies.length > 0
      ? Math.round(accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length)
      : null;
  const bestAccuracyMeters = Number.isFinite(getAccuracyScore(best))
    ? Math.round(getAccuracyScore(best))
    : null;
  return {
    location: best,
    sampleCount,
    sampleWindowMs,
    averageAccuracyMeters,
    bestAccuracyMeters,
  };
}

export async function getLocationPermissionSnapshot(): Promise<LocationPermissionState> {
  const fg = await Location.getForegroundPermissionsAsync();
  return { foreground: fg.granted, foregroundCanAskAgain: fg.canAskAgain, background: false, backgroundCanAskAgain: false };
}

export async function requestLocationPermissionBundle(): Promise<LocationPermissionState> {
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  return { foreground: fg.granted, foregroundCanAskAgain: fg.canAskAgain, background: false, backgroundCanAskAgain: false };
}

export async function getVerifiedLocationEvidence(
  options?: VerifiedLocationOptions
): Promise<VerifiedLocationEvidence> {
  const minAccuracyMeters = options?.minAccuracyMeters ?? DEFAULT_MIN_ACCURACY_METERS;
  const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_LOCATION_ATTEMPTS);
  const requiredStableSamples = Math.max(
    1,
    options?.requiredStableSamples ?? DEFAULT_STABLE_SAMPLES
  );
  const maxDriftMeters = Math.max(10, options?.maxDriftMeters ?? DEFAULT_MAX_DRIFT_METERS);
  const sampleWaitMs = Math.max(300, options?.sampleWaitMs ?? SAMPLE_WAIT_MS);
  const timeoutMs = Math.max(2000, options?.timeoutMs ?? DEFAULT_LOCATION_TIMEOUT_MS);
  const deadlineMs = Date.now() + timeoutMs;

  const lastKnown = await getLastKnownLocationSafe({ requiredAccuracy: minAccuracyMeters });

  let best: LocationObject | null = lastKnown;
  const capturedSamples: LocationObject[] = [];
  const stableSamples: LocationObject[] = [];
  let previousStable: LocationObject | null = null;

  if (lastKnown) {
    capturedSamples.push(lastKnown);
    if (getAccuracyScore(lastKnown) <= minAccuracyMeters) {
      stableSamples.push(lastKnown);
      previousStable = lastKnown;
      if (stableSamples.length >= requiredStableSamples) {
        return buildEvidence(stableSamples, lastKnown);
      }
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    let fix: LocationObject;
    try {
      fix = await getCurrentPositionWithTimeout(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          mayShowUserSettingsDialog: true,
        },
        Math.min(MAX_SINGLE_FIX_WAIT_MS, remainingMs)
      );
    } catch {
      if (Date.now() >= deadlineMs) break;
      continue;
    }
    capturedSamples.push(fix);
    if (getAccuracyScore(fix) < getAccuracyScore(best)) {
      best = fix;
    }
    if (getAccuracyScore(fix) <= minAccuracyMeters) {
      if (!previousStable) {
        stableSamples.push(fix);
        previousStable = fix;
      } else if (distanceBetweenMeters(previousStable, fix) <= maxDriftMeters) {
        stableSamples.push(fix);
        previousStable = fix;
      } else {
        stableSamples.length = 0;
        stableSamples.push(fix);
        previousStable = fix;
      }
      if (stableSamples.length >= requiredStableSamples) {
        return buildEvidence(stableSamples, best ?? fix);
      }
    }
    if (attempt < maxAttempts && Date.now() < deadlineMs) {
      await sleep(Math.min(sampleWaitMs, Math.max(0, deadlineMs - Date.now())));
    }
  }

  if (best && getAccuracyScore(best) <= minAccuracyMeters && requiredStableSamples === 1) {
    return buildEvidence(capturedSamples.length ? capturedSamples : [best], best);
  }

  const bestAccuracy = getAccuracyScore(best);
  if (Number.isFinite(bestAccuracy)) {
    throw new Error(
      `Unable to get stable GPS lock (best accuracy +/-${Math.round(bestAccuracy)}m).`
    );
  }
  throw new Error("Unable to fetch a valid GPS location.");
}

export function isMockLocation(location: LocationObject): boolean {
  // `mocked` exists mainly on Android but this keeps fraud detection consistent.
  return Boolean(location.mocked || (location.coords as { mocked?: boolean }).mocked);
}

export async function ensureLocationServicesEnabled(): Promise<boolean> {
  return Location.hasServicesEnabledAsync();
}

export async function getLastKnownLocationSafe(
  options?: { requiredAccuracy?: number; maxAgeMs?: number }
): Promise<Location.LocationObject | null> {
  try {
    const foregroundPermission = await Location.getForegroundPermissionsAsync();
    if (!foregroundPermission.granted) {
      return null;
    }
    return await Location.getLastKnownPositionAsync({
      maxAge: options?.maxAgeMs ?? 5 * 60 * 1000,
      requiredAccuracy: options?.requiredAccuracy ?? 120,
    });
  } catch {
    return null;
  }
}
