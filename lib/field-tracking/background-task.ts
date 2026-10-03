import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { processAttendanceLocationBatch } from '@/lib/attendance-background';
import { fieldTrackingConfig } from './config';
import { persistFieldLocation } from './tracking/capture';
import { setState } from './tracking/database';
import { syncFieldOutbox } from './tracking/sync';

try {
  if (!TaskManager.isTaskDefined(fieldTrackingConfig.locationTaskName)) {
    TaskManager.defineTask(fieldTrackingConfig.locationTaskName, async ({ data, error }) => {
      if (error || !data) {
        if (error) await setState('last_tracker_error', error.message || 'background_location_error').catch(() => undefined);
        return;
      }
      const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
      let captured = 0;
      for (const location of locations) {
        const point = await persistFieldLocation(location).catch((failure: unknown) => {
          void setState('last_tracker_error', failure instanceof Error ? failure.message : 'background_capture_failed');
          return null;
        });
        if (point) captured += 1;
      }
      await processAttendanceLocationBatch(locations).catch(() => undefined);
      if (captured) {
        await setState('tracker_state', 'tracking').catch(() => undefined);
        await syncFieldOutbox().catch(() => undefined);
      }
    });
  }
} catch (error) {
  if (__DEV__) console.warn('Field tracking background task unavailable', error);
}
