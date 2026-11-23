/**
 * V2 is the single location producer for an active field shift. Attendance
 * boundary evaluation is fed from this task instead of starting a competing
 * foreground location service.
 */
export const FIELD_TRACKING_LOCATION_TASK = 'LUMINA_TRACKING_ENGINE_V2';

/** Native registrations survive application upgrades, so explicitly retire
 * every task name that previously owned a GPS stream. */
export const LEGACY_FIELD_TRACKING_LOCATION_TASKS = [
  'LUMINA_FIELD_TRACKING_LOCATION_V1',
  'trackforce-background-location-task-v1',
] as const;
