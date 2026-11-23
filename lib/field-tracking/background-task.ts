import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { processAttendanceLocationBatch } from '@/lib/attendance-background';
import { fieldTrackingConfig } from './config';
import { persistFieldLocation } from './tracking/capture';
import { setState } from './tracking/database';
import { syncFieldOutbox } from './tracking/sync';
import { maybeSendFieldHeartbeat } from './tracking/heartbeat';

try {
  if (!TaskManager.isTaskDefined(fieldTrackingConfig.locationTaskName)) {
    TaskManager.defineTask(fieldTrackingConfig.locationTaskName, async ({ data, error }) => {
      if (error || !data) {
        if (error) await setState('last_tracker_error', error.message || 'background_location_error').catch(() => undefined);
        return;
      }
      const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
      let captured = 0;
      let latestCaptured: Awaited<ReturnType<typeof persistFieldLocation>> = null;
      for (const location of locations) {
        const point = await persistFieldLocation(location).catch((failure: unknown) => {
          void setState('last_tracker_error', failure instanceof Error ? failure.message : 'background_capture_failed');
          return null;
        });
        if (point) {
          captured += 1;
          latestCaptured = point;
        }
      }
      await processAttendanceLocationBatch(locations).catch(() => undefined);
      if (captured) {
        await Promise.all([
          setState('tracker_state', 'tracking'),
          setState('last_tracker_error', ''),
        ]).catch(() => undefined);
        await syncFieldOutbox().catch(() => undefined);
      }
      await maybeSendFieldHeartbeat({ locations, capturedPoint: latestCaptured }).catch(() => undefined);
    });
  }
} catch (error) {
  if (__DEV__) console.warn('Field tracking background task unavailable', error);
}
