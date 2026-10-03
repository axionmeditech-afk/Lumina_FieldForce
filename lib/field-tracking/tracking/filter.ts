import type * as Location from 'expo-location';
import { fieldTrackingConfig } from '../config';
import { haversineMetres } from '../geo';
import type { RoutePoint } from '../types';

export function classifyLocation(
  location: Location.LocationObject,
  previous: RoutePoint | null,
): { routeEligible: boolean; rejectionReason: string | null } {
  const { latitude, longitude, accuracy, speed } = location.coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { routeEligible: false, rejectionReason: 'invalid_latitude' };
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { routeEligible: false, rejectionReason: 'invalid_longitude' };
  if (Boolean(location.mocked)) return { routeEligible: false, rejectionReason: 'mock_location' };
  if (accuracy == null || !Number.isFinite(accuracy)) return { routeEligible: false, rejectionReason: 'missing_accuracy' };
  if (accuracy > fieldTrackingConfig.routeAccuracyLimitM) return { routeEligible: false, rejectionReason: 'weak_accuracy' };
  if (speed != null && speed > fieldTrackingConfig.maxPlausibleSpeedMps) return { routeEligible: false, rejectionReason: 'reported_speed_impossible' };
  if (!previous) return { routeEligible: true, rejectionReason: null };

  const capturedAt = Number(location.timestamp);
  const previousAt = Date.parse(previous.capturedAt);
  if (!Number.isFinite(capturedAt) || capturedAt <= previousAt) return { routeEligible: false, rejectionReason: 'out_of_order_timestamp' };
  const distance = haversineMetres(previous, { latitude, longitude });
  const seconds = Math.max(0.25, (capturedAt - previousAt) / 1000);
  if (distance / seconds > fieldTrackingConfig.maxPlausibleSpeedMps) return { routeEligible: false, rejectionReason: 'impossible_jump' };

  const reportedSpeed = speed == null || speed < 0 ? 0 : speed;
  const noiseGate = Math.min(12, Math.max(4, accuracy * 0.35));
  if (distance < noiseGate && reportedSpeed < 1 && seconds < 120) {
    return { routeEligible: false, rejectionReason: 'stationary_noise' };
  }
  return { routeEligible: true, rejectionReason: null };
}
