import type * as Location from 'expo-location';
import { sendFieldTrackingHeartbeat } from '../api';
import { fieldTrackingConfig } from '../config';
import type { RoutePoint, TrackingRuntimeState } from '../types';
import {
  countPendingForSession,
  getActiveSession,
  getLastPoint,
  getState,
  setState,
} from './database';

let running: Promise<void> | null = null;

type HeartbeatInput = {
  locations?: Location.LocationObject[];
  capturedPoint?: RoutePoint | null;
  force?: boolean;
};

function finiteAccuracy(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function runtimeStateFor(
  accuracy: number | null,
  speed: number | null,
  capturedPoint: RoutePoint | null | undefined,
): TrackingRuntimeState {
  if (accuracy == null || accuracy > fieldTrackingConfig.routeAccuracyLimitM) return 'gps_degraded';
  if (capturedPoint?.rejectionReason === 'stationary_noise' || (speed != null && speed >= 0 && speed < 0.8)) {
    return 'stationary';
  }
  return 'tracking';
}

/**
 * Report liveness independently from accepted route points. A stationary phone
 * can legitimately produce no new route geometry for several minutes; this
 * heartbeat prevents supervisors from interpreting that as a dead tracker.
 */
export function maybeSendFieldHeartbeat(input: HeartbeatInput = {}): Promise<void> {
  if (running) return running;
  running = runHeartbeat(input).finally(() => { running = null; });
  return running;
}

async function runHeartbeat(input: HeartbeatInput): Promise<void> {
  const session = await getActiveSession();
  if (!session) return;

  const now = Date.now();
  const [lastAttempt, previousError] = await Promise.all([
    getState('last_heartbeat_attempt_at'),
    getState('last_heartbeat_error'),
  ]);
  const lastAttemptAt = lastAttempt ? Date.parse(lastAttempt) : 0;
  const minimumInterval = previousError
    ? fieldTrackingConfig.heartbeatRetryIntervalMs
    : fieldTrackingConfig.heartbeatIntervalMs;
  if (!input.force && Number.isFinite(lastAttemptAt) && now - lastAttemptAt < minimumInterval) return;
  await setState('last_heartbeat_attempt_at', new Date(now).toISOString());

  const latestLocation = input.locations?.at(-1) ?? null;
  const latestPoint = input.capturedPoint ?? await getLastPoint(session.id);
  const accuracy = finiteAccuracy(latestLocation?.coords.accuracy ?? latestPoint?.accuracy);
  const rawSpeed = latestLocation?.coords.speed ?? latestPoint?.speed;
  const speed = typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) ? rawSpeed : null;
  const capturedAt = latestLocation
    ? new Date(Number.isFinite(latestLocation.timestamp) ? latestLocation.timestamp : now).toISOString()
    : latestPoint?.capturedAt ?? null;
  const runtimeState = runtimeStateFor(accuracy, speed, input.capturedPoint);
  const pendingPoints = await countPendingForSession(session.id);
  const trackerError = ((await getState('last_tracker_error')) || null)?.slice(0, 255) ?? null;
  const storedProfile = await getState('tracking_sampling_profile');
  const samplingProfile = storedProfile === 'navigation' || storedProfile === 'moving'
    || storedProfile === 'stationary' || storedProfile === 'degraded'
    ? storedProfile
    : runtimeState === 'stationary' ? 'stationary' : runtimeState === 'gps_degraded' ? 'degraded' : 'moving';

  try {
    const response = await sendFieldTrackingHeartbeat({
      sessionId: session.id,
      companyId: session.companyId,
      runtimeState,
      pendingPoints,
      lastCapturedAt: capturedAt,
      accuracy,
      lastError: trackerError,
      samplingProfile,
    });
    await Promise.all([
      setState('last_heartbeat_sent_at', response.receivedAt),
      setState('last_heartbeat_error', ''),
      setState('tracking_runtime_state', runtimeState),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'tracking_heartbeat_failed';
    await Promise.all([
      setState('last_heartbeat_error', message),
      setState('tracking_runtime_state', 'sync_blocked'),
    ]);
  }
}
