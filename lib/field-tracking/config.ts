import Constants, { ExecutionEnvironment } from 'expo-constants';
import { FIELD_TRACKING_LOCATION_TASK } from './task-names';

export const fieldTrackingConfig = {
  locationTaskName: FIELD_TRACKING_LOCATION_TASK,
  captureTimeMs: 5_000,
  captureDistanceM: 8,
  routeAccuracyLimitM: 80,
  initialFixTargetM: 60,
  initialFixFallbackM: 110,
  maxPlausibleSpeedMps: 70,
  syncIntervalMs: 10_000,
  maxBatchSize: 75,
  maxRoutePointsOnDevice: 20_000,
  osmTileUrl:
    (process.env.EXPO_PUBLIC_OSM_TILE_URL || '').trim() ||
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  isExpoGo: Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
} as const;
