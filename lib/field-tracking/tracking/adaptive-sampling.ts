import type * as Location from 'expo-location';
import { fieldTrackingSamplingPolicy } from '../sampling-policy';
import { haversineMetres } from '../geo';
import type { RoutePoint, TrackingSamplingProfile } from '../types';

export type AdaptiveSamplingDecision = {
  profile: TrackingSamplingProfile;
  retain: boolean;
  reason: 'first_fix' | 'navigation' | 'movement' | 'stationary_anchor' | 'degraded_anchor' | 'coalesced';
};

/**
 * Coalesce redundant fixes without lowering the native engine's ability to
 * detect movement. GPS delivery remains continuous; this policy only decides
 * which fixes become durable route/audit points.
 */
export function deriveAdaptiveSamplingDecision(
  location: Location.LocationObject,
  lastPoint: RoutePoint | null,
): AdaptiveSamplingDecision {
  if (!lastPoint) return { profile: 'moving', retain: true, reason: 'first_fix' };

  const now = Number.isFinite(location.timestamp) ? location.timestamp : Date.now();
  const previousAt = Date.parse(lastPoint.capturedAt);
  const elapsed = Number.isFinite(previousAt) ? Math.max(0, now - previousAt) : Number.POSITIVE_INFINITY;
  const accuracy = location.coords.accuracy;
  const speed = location.coords.speed == null || location.coords.speed < 0 ? 0 : location.coords.speed;
  const distance = haversineMetres(lastPoint, location.coords);

  if (accuracy == null || !Number.isFinite(accuracy) || accuracy > fieldTrackingSamplingPolicy.routeAccuracyLimitM) {
    return {
      profile: 'degraded',
      retain: elapsed >= fieldTrackingSamplingPolicy.degradedAnchorIntervalMs,
      reason: elapsed >= fieldTrackingSamplingPolicy.degradedAnchorIntervalMs ? 'degraded_anchor' : 'coalesced',
    };
  }
  if (speed >= 2.5 || distance >= 25) {
    return { profile: 'navigation', retain: elapsed >= 2_500 || distance >= 8, reason: 'navigation' };
  }
  if (speed >= 0.7 || distance >= 6) {
    return { profile: 'moving', retain: elapsed >= 4_000 || distance >= 8, reason: 'movement' };
  }
  return {
    profile: 'stationary',
    retain: elapsed >= fieldTrackingSamplingPolicy.stationaryAnchorIntervalMs,
    reason: elapsed >= fieldTrackingSamplingPolicy.stationaryAnchorIntervalMs ? 'stationary_anchor' : 'coalesced',
  };
}
