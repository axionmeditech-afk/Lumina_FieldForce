import NetInfo from '@react-native-community/netinfo';
import { completeFieldSession, uploadFieldPoints } from '../api';
import { fieldTrackingConfig } from '../config';
import {
  acknowledgePoints,
  acknowledgeRejectedPoints,
  acknowledgeSessionEnd,
  countPendingForSession,
  getActiveSession,
  getPendingBatch,
  getPendingSessionEnds,
  getSession,
  pruneSyncedHistory,
  setState,
} from './database';

let running: Promise<{ uploaded: number; error: string | null }> | null = null;
let lastAttemptAt = 0;

export function syncFieldOutbox(employeeId?: string, force = false): Promise<{ uploaded: number; error: string | null }> {
  if (running) return running;
  const now = Date.now();
  if (!force && now - lastAttemptAt < fieldTrackingConfig.syncIntervalMs) {
    return Promise.resolve({ uploaded: 0, error: null });
  }
  lastAttemptAt = now;
  running = runSync(employeeId).finally(() => { running = null; });
  return running;
}

async function runSync(employeeId?: string): Promise<{ uploaded: number; error: string | null }> {
  const network = await NetInfo.fetch();
  if (!network.isConnected || network.isInternetReachable === false) {
    await setState('tracker_state', 'offline');
    return { uploaded: 0, error: 'offline' };
  }
  let uploaded = 0;
  try {
    for (let index = 0; index < 8; index += 1) {
      const points = await getPendingBatch(fieldTrackingConfig.maxBatchSize, employeeId);
      if (!points.length) break;
      const session = await getSession(points[0]!.sessionId);
      if (!session) throw new Error('local_session_missing');
      const data = await uploadFieldPoints(session, points);
      const accepted = data.accepted.map((item) => item.pointId);
      const rejected = data.rejected.filter((item): item is { pointId: string; reason: string } => Boolean(item.pointId && item.reason));
      if (!accepted.length && !rejected.length) throw new Error('server_acknowledged_zero_points');
      await acknowledgePoints(accepted, data.committedAt);
      await acknowledgeRejectedPoints(rejected, data.committedAt);
      uploaded += accepted.length;
    }
    for (const pending of await getPendingSessionEnds(employeeId)) {
      if (await countPendingForSession(pending.sessionId)) continue;
      await completeFieldSession(pending.sessionId, pending.endedAt);
      await acknowledgeSessionEnd(pending.sessionId, new Date().toISOString());
    }
    await setState('last_sync_error', '');
    await setState('last_synced_at', new Date().toISOString());
    await pruneSyncedHistory(fieldTrackingConfig.maxRoutePointsOnDevice);
    await setState('tracker_state', await getActiveSession(employeeId) ? 'tracking' : 'stopped');
    return { uploaded, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'field_sync_failed';
    await setState('last_sync_error', message);
    return { uploaded, error: message };
  }
}
