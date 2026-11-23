import Constants, { ExecutionEnvironment } from 'expo-constants';
import { FIELD_TRACKING_LOCATION_TASK } from './task-names';
import { fieldTrackingSamplingPolicy } from './sampling-policy';

export const fieldTrackingConfig = {
  locationTaskName: FIELD_TRACKING_LOCATION_TASK,
  captureTimeMs: 5_000,
  captureDistanceM: 8,
  routeAccuracyLimitM: fieldTrackingSamplingPolicy.routeAccuracyLimitM,
  initialFixTargetM: 60,
  initialFixFallbackM: 110,
  maxPlausibleSpeedMps: 70,
  syncIntervalMs: 10_000,
  heartbeatIntervalMs: 45_000,
  heartbeatRetryIntervalMs: 15_000,
  stationaryAnchorIntervalMs: fieldTrackingSamplingPolicy.stationaryAnchorIntervalMs,
  degradedAnchorIntervalMs: fieldTrackingSamplingPolicy.degradedAnchorIntervalMs,
  trackingGapWarningMs: 2 * 60_000,
  trackingGapCriticalMs: 5 * 60_000,
  maxBatchSize: 75,
  maxRoutePointsOnDevice: 20_000,
  osmTileUrl:
    (process.env.EXPO_PUBLIC_OSM_TILE_URL || '').trim() ||
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  isExpoGo: Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
} as const;
