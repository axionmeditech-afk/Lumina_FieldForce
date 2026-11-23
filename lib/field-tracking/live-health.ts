import type { LiveEmployee } from './types';

export const LIVE_HEARTBEAT_MAX_AGE_MS = 2 * 60_000;
export const DELAYED_HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

export function deriveLiveTrackingStatus(input: {
  attendanceActive: boolean;
  trackingActive: boolean;
  heartbeatAt: string | null;
  capturedAt: string;
  now?: number;
}): LiveEmployee['status'] {
  if (input.attendanceActive && !input.trackingActive) return 'waiting';
  if (!input.attendanceActive || !input.trackingActive) return 'offline';
  const livenessAt = input.heartbeatAt || input.capturedAt;
  const timestamp = Date.parse(livenessAt);
  if (!Number.isFinite(timestamp)) return 'stale';
  const ageMs = Math.max(0, (input.now ?? Date.now()) - timestamp);
  if (ageMs <= LIVE_HEARTBEAT_MAX_AGE_MS) return 'live';
  if (ageMs <= DELAYED_HEARTBEAT_MAX_AGE_MS) return 'delayed';
  return 'stale';
}
