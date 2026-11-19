import * as Location from 'expo-location';
import { haversineMetres } from './geo';
import {
  VISIT_EVIDENCE_MAX_AGE_MS,
  VISIT_GEOFENCE_RADIUS_METRES,
  VISIT_MAX_ACCURACY_METRES,
  VISIT_MIN_EVIDENCE_SAMPLES,
  VISIT_MIN_SAMPLE_WINDOW_MS,
  isVisitEvidenceFresh,
  type VisitLocationEvidence,
} from './visit-policy';
import type { Coordinate } from './types';

export function toVisitLocationEvidence(location: Location.LocationObject): VisitLocationEvidence | null {
  const accuracy = location.coords.accuracy;
  if (!Number.isFinite(accuracy) || accuracy == null || accuracy <= 0 || accuracy > VISIT_MAX_ACCURACY_METRES) return null;
  const sample: VisitLocationEvidence = {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy,
    capturedAt: new Date(location.timestamp).toISOString(),
    mocked: Boolean((location as Location.LocationObject & { mocked?: boolean }).mocked),
  };
  return isVisitEvidenceFresh(sample) ? sample : null;
}

export function appendVisitEvidence(
  current: VisitLocationEvidence[],
  next: VisitLocationEvidence,
  nowMs = Date.now(),
): VisitLocationEvidence[] {
  const fresh = current
    .filter((sample) => nowMs - Date.parse(sample.capturedAt) <= VISIT_EVIDENCE_MAX_AGE_MS)
    .filter((sample) => sample.capturedAt !== next.capturedAt);
  return [...fresh, next].slice(-5);
}

export function hasStableVisitEvidence(samples: VisitLocationEvidence[]): boolean {
  if (samples.length < VISIT_MIN_EVIDENCE_SAMPLES) return false;
  const ordered = [...samples].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return Date.parse(ordered.at(-1)!.capturedAt) - Date.parse(ordered[0].capturedAt) >= VISIT_MIN_SAMPLE_WINDOW_MS
    && ordered.every((sample) => isVisitEvidenceFresh(sample) && !sample.mocked);
}

export function isEvidenceInsideVisitGeofence(samples: VisitLocationEvidence[], destination: Coordinate): boolean {
  return hasStableVisitEvidence(samples) && samples.every((sample) =>
    haversineMetres(sample, destination) + sample.accuracy <= VISIT_GEOFENCE_RADIUS_METRES,
  );
}

export async function captureFreshVisitEvidence(timeoutMs = 12_000): Promise<VisitLocationEvidence[]> {
  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== 'granted' && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Allow precise location to verify the visit destination.');

  return new Promise<VisitLocationEvidence[]>((resolve, reject) => {
    let samples: VisitLocationEvidence[] = [];
    let subscription: Location.LocationSubscription | null = null;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.remove();
      if (error) reject(error);
      else resolve(samples);
    };
    const timer = setTimeout(() => finish(new Error('Precise GPS verification timed out. Move near an open area and retry.')), timeoutMs);
    void Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 1_000, distanceInterval: 0, mayShowUserSettingsDialog: true },
      (location) => {
        const sample = toVisitLocationEvidence(location);
        if (!sample) return;
        samples = appendVisitEvidence(samples, sample);
        if (hasStableVisitEvidence(samples)) finish();
      },
    ).then((value) => {
      subscription = value;
      if (finished) value.remove();
    }).catch((error) => finish(error instanceof Error ? error : new Error('Unable to start precise GPS verification.')));
  });
}

