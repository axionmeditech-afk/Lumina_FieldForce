import type { AppUser, AttendanceRecord } from "@/lib/types";
import type * as Location from "expo-location";
import { restoreFieldTracker, startFieldTracking, stopFieldTracking } from "./tracking/tracker";
import { getActiveSession } from "./tracking/database";

/** Only employee-facing roles publish a live route to supervisors. */
export function canAutoTrackAttendance(user: Pick<AppUser, "role"> | null | undefined): boolean {
  return user?.role === "employee" || user?.role === "salesperson";
}

export async function startFieldTrackingForCheckIn(
  user: Pick<AppUser, "id" | "companyId" | "role">,
  record: AttendanceRecord,
  initialLocation?: Location.LocationObject,
): Promise<boolean> {
  if (!canAutoTrackAttendance(user) || record.type !== "checkin" || record.userId !== user.id) return false;
  const companyId = record.companyId || user.companyId;
  if (!companyId) throw new Error("A workspace is required to start live field tracking.");
  await startFieldTracking(user.id, companyId, initialLocation);
  return true;
}

export async function stopFieldTrackingForCheckOut(userId: string | null | undefined): Promise<void> {
  if (userId) await stopFieldTracking(userId);
}

/** Restore a prior task on reload without prompting the user for permissions. */
export async function restoreFieldTrackingForActiveAttendance(
  user: Pick<AppUser, "id" | "role" | "companyId"> | null | undefined,
  active: AttendanceRecord | null,
): Promise<void> {
  if (!user?.id || !canAutoTrackAttendance(user)) return;
  if (active?.userId !== user.id) {
    await stopFieldTracking(user.id);
    return;
  }

  const existing = await getActiveSession(user.id);
  if (existing) {
    await restoreFieldTracker(user.id);
    return;
  }

  // Recover an already checked-in employee if the initial tracker start was interrupted.
  const companyId = active.companyId || user.companyId;
  if (companyId) await startFieldTracking(user.id, companyId);
}
