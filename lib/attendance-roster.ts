import type { UserRole } from "@/lib/types";

type AttendanceRosterIdentity = {
  id?: string | number | null;
  name?: string | null;
  email?: string | null;
  login?: string | null;
  role?: UserRole | string | null;
  admin?: boolean | number | string | null;
  isAdmin?: boolean | number | string | null;
  companyId?: string | null;
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

function getRosterIdentityKeys(identity: AttendanceRosterIdentity): string[] {
  const role = normalizeIdentity(identity.role);
  const keys: string[] = [];

  const rawId = normalizeIdentity(identity.id == null ? "" : String(identity.id));
  if (rawId) {
    keys.push(`id:${rawId}`);
    const unprefixedId = rawId.replace(/^dolibarr_/, "");
    if (unprefixedId !== rawId) keys.push(`id:${unprefixedId}`);
  }

  const email = normalizeIdentity(identity.email);
  if (email && !email.endsWith("@dolibarr.local")) {
    keys.push(`email:${email}`);
  }

  const name = normalizeIdentity(identity.name).replace(/\s+/g, " ");
  if (name) keys.push(`name:${role}:${name}`);
  return keys;
}

export function dedupeAttendanceRosterMembers<T extends AttendanceRosterIdentity>(identities: T[]): T[] {
  const deduped: T[] = [];
  const keyToIndex = new Map<string, number>();

  for (const identity of identities) {
    if (!isAttendanceRosterMember(identity)) continue;
    const keys = getRosterIdentityKeys(identity);
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index): index is number => typeof index === "number");

    if (typeof existingIndex === "number") {
      // Inputs are ordered cache-first/API-last, so the authoritative API row
      // replaces its cached duplicate while all known aliases keep pointing to it.
      deduped[existingIndex] = identity;
      for (const key of keys) keyToIndex.set(key, existingIndex);
      continue;
    }

    const nextIndex = deduped.length;
    deduped.push(identity);
    for (const key of keys) keyToIndex.set(key, nextIndex);
  }

  return deduped;
}
