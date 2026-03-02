import type { UserRole } from "@/lib/types";

export function canAccessSalesModule(role?: UserRole | null): boolean {
  return role === "admin" || role === "salesperson";
}

export function canReviewAttendanceSignIns(role?: UserRole | null): boolean {
  return role === "admin" || role === "manager";
}

export function requiresAttendanceApproval(role?: UserRole | null): boolean {
  void role;
  return false;
}

export function canModerateSupport(role?: UserRole | null): boolean {
  return role === "admin" || role === "manager" || role === "hr";
}

export function canAccessAdminControls(role?: UserRole | null): boolean {
  return role === "admin";
}

export function canBroadcastAnnouncements(role?: UserRole | null): boolean {
  return role === "admin" || role === "manager";
}
