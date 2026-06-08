import type { Employee } from "@/lib/types";

function normalizeIdentity(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function addIdentity(target: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeIdentity(value);
  if (normalized) target.add(normalized);
}

function addIdVariants(target: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeIdentity(value);
  if (!normalized) return;

  addIdentity(target, normalized);

  const queue = [normalized];
  const seen = new Set<string>();
  const prefixes = ["dolibarr_", "member_", "user_"];

  while (queue.length > 0) {
    const current = queue.shift() || "";
    if (!current || seen.has(current)) continue;
    seen.add(current);
    addIdentity(target, current);

    for (const prefix of prefixes) {
      if (current.startsWith(prefix)) {
        queue.push(current.slice(prefix.length));
      }
    }
  }

  for (const core of seen) {
    if (!core) continue;
    addIdentity(target, `dolibarr_${core}`);
    addIdentity(target, `member_${core}`);
  }
}

function addEmailVariants(target: Set<string>, value: string | null | undefined): void {
  const email = normalizeIdentity(value);
  if (!email) return;
  addIdentity(target, email);

  const localPart = email.includes("@") ? email.split("@")[0] : "";
  if (localPart) {
    addIdVariants(target, localPart);
  }
}

export function getEmployeeIdentityKeys(employee: Employee): string[] {
  const keys = new Set<string>();
  addIdVariants(keys, employee.id);
  addEmailVariants(keys, employee.email);
  addIdentity(keys, employee.name);
  addIdentity(keys, employee.phone);
  return [...keys];
}

export function getMemberIdLookupKeys(memberId: string): string[] {
  const keys = new Set<string>();
  addIdVariants(keys, memberId);
  addEmailVariants(keys, memberId);
  addIdentity(keys, memberId);
  return [...keys];
}

export function buildEmployeeIdentityMap(employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();

  for (const employee of employees) {
    const exactId = normalizeIdentity(employee.id);
    if (exactId && !map.has(exactId)) {
      map.set(exactId, employee);
    }
  }

  for (const employee of employees) {
    for (const key of getEmployeeIdentityKeys(employee)) {
      if (!map.has(key)) {
        map.set(key, employee);
      }
    }
  }

  return map;
}

export function resolveEmployeeByMemberId(
  employeesByIdentity: Map<string, Employee>,
  memberId: string
): Employee | undefined {
  for (const key of getMemberIdLookupKeys(memberId)) {
    const employee = employeesByIdentity.get(key);
    if (employee) return employee;
  }
  return undefined;
}
