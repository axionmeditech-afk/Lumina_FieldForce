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

/**
 * Arrival is based on consecutive fixes inside the destination geofence, not
 * on the last few route fixes (which are normally still outside the fence).
 * Resetting on an outside/weak/mock fix both avoids a slow five-fix delay and
 * prevents one noisy GPS jump from confirming arrival.
 */
export function appendArrivalEvidence(
  current: VisitLocationEvidence[],
  next: VisitLocationEvidence,
  destination: Coordinate,
  nowMs = Date.now(),
): VisitLocationEvidence[] {
  const safelyInside = (sample: VisitLocationEvidence) => !sample.mocked
    && isVisitEvidenceFresh(sample, nowMs)
    && Number.isFinite(sample.accuracy)
    && sample.accuracy > 0
    && sample.accuracy <= VISIT_MAX_ACCURACY_METRES
    && haversineMetres(sample, destination) + sample.accuracy <= VISIT_GEOFENCE_RADIUS_METRES;
  if (!safelyInside(next)) return [];

  let consecutive: VisitLocationEvidence[] = [];
  for (const sample of [...current].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))) {
    consecutive = safelyInside(sample) ? appendVisitEvidence(consecutive, sample, nowMs) : [];
  }
  return appendVisitEvidence(consecutive, next, nowMs);
}

export function hasStableVisitEvidence(samples: VisitLocationEvidence[], nowMs = Date.now()): boolean {
  if (samples.length < VISIT_MIN_EVIDENCE_SAMPLES) return false;
  const ordered = [...samples].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return Date.parse(ordered.at(-1)!.capturedAt) - Date.parse(ordered[0]!.capturedAt) >= VISIT_MIN_SAMPLE_WINDOW_MS
    && ordered.every((sample) => isVisitEvidenceFresh(sample, nowMs) && !sample.mocked);
}

export function isEvidenceInsideVisitGeofence(
  samples: VisitLocationEvidence[],
  destination: Coordinate,
  nowMs = Date.now(),
): boolean {
  return hasStableVisitEvidence(samples, nowMs) && samples.every((sample) =>
    Number.isFinite(sample.accuracy)
      && sample.accuracy > 0
      && sample.accuracy <= VISIT_MAX_ACCURACY_METRES
      && haversineMetres(sample, destination) + sample.accuracy <= VISIT_GEOFENCE_RADIUS_METRES,
  );
}
