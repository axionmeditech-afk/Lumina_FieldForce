import { ensureAttendanceNotificationPermission } from "@/lib/attendance-notifications";
import {
  requestLocationPermissionBundle,
  type LocationPermissionState,
} from "@/lib/location-service";

export type AppPermissionBootstrapResult = {
  location: LocationPermissionState;
  notifications: boolean;
};

let activeBootstrap: Promise<AppPermissionBootstrapResult> | null = null;

/**
 * Ask only for permissions that are still missing.
 *
 * Android grants foreground and background location in separate steps. Keeping
 * the sequence here prevents the attendance button, navigation button and
 * background tracker from opening competing native permission flows.
 */
export function requestMissingAppPermissions(): Promise<AppPermissionBootstrapResult> {
  if (activeBootstrap) return activeBootstrap;
  activeBootstrap = (async () => {
    const location = await requestLocationPermissionBundle();
    const notifications = await ensureAttendanceNotificationPermission(true).catch(() => false);
    return { location, notifications };
  })().finally(() => {
    activeBootstrap = null;
  });
  return activeBootstrap;
}
