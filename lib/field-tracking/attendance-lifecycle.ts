import type { AppUser, AttendanceRecord } from "@/lib/types";
import { restoreFieldTracker, startFieldTracking, stopFieldTracking } from "./tracking/tracker";

/** Only employee-facing roles publish a live route to supervisors. */
export function canAutoTrackAttendance(user: Pick<AppUser, "role"> | null | undefined): boolean {
  return user?.role === "employee" || user?.role === "salesperson";
}

export async function startFieldTrackingForCheckIn(
  user: Pick<AppUser, "id" | "companyId" | "role">,
  record: AttendanceRecord,
): Promise<boolean> {
  if (!canAutoTrackAttendance(user) || record.type !== "checkin" || record.userId !== user.id) return false;
  const companyId = record.companyId || user.companyId;
  if (!companyId) throw new Error("A workspace is required to start live field tracking.");
  await startFieldTracking(user.id, companyId);
  return true;
}

export async function stopFieldTrackingForCheckOut(userId: string | null | undefined): Promise<void> {
  if (userId) await stopFieldTracking(userId);
}

/** Restore a prior task on reload without prompting the user for permissions. */
export async function restoreFieldTrackingForActiveAttendance(
  user: Pick<AppUser, "id" | "role"> | null | undefined,
  active: AttendanceRecord | null,
): Promise<void> {
  if (!user?.id || !canAutoTrackAttendance(user)) return;
  if (active?.userId === user.id) await restoreFieldTracker(user.id);
  else await stopFieldTracking(user.id);
}
