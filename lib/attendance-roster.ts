import type { UserRole } from "@/lib/types";

type AttendanceRosterIdentity = {
  id?: string | number | null;
  name?: string | null;
  email?: string | null;
  login?: string | null;
  role?: UserRole | string | null;
  admin?: boolean | number | string | null;
  isAdmin?: boolean | number | string | null;
};

function normalizeIdentity(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function compactIdentity(value: unknown): string {
  return normalizeIdentity(value).replace(/[^a-z0-9]+/g, "");
}

function isEnabledFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isReservedAdministratorIdentity(value: unknown): boolean {
  const normalized = compactIdentity(value);
  if (!normalized) return false;
  if (["admin", "administrator", "superadmin", "superadministrator", "root"].includes(normalized)) {
    return true;
  }

  // Covers legacy display names such as "SuperAdmin SuperAdmin" without
  // excluding ordinary employees whose names merely contain "admin".
  return normalized.replace(/superadmin(?:istrator)?/g, "").length === 0;
}

export function isSystemAdministratorAccount(identity: AttendanceRosterIdentity): boolean {
  if (normalizeIdentity(identity.role) === "admin") return true;
  if (isEnabledFlag(identity.admin) || isEnabledFlag(identity.isAdmin)) return true;

  const emailLocalPart = normalizeIdentity(identity.email).split("@")[0] || "";
  return [identity.login, emailLocalPart, identity.name].some(isReservedAdministratorIdentity);
}

export function isAttendanceRosterMember(identity: AttendanceRosterIdentity): boolean {
  const role = normalizeIdentity(identity.role);
  return (role === "employee" || role === "salesperson") && !isSystemAdministratorAccount(identity);
}

