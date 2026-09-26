import type { UserRole } from "@/lib/types";

export function isSalesRole(role?: UserRole | null): boolean {
  return role === "salesperson";
}

export function canReviewAttendanceSignIns(role?: UserRole | null): boolean {
  return role === "admin" || role === "manager";
}
