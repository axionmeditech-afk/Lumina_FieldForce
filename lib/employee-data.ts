import type { AppUser, Employee } from "@/lib/types";
import {
  getCurrentUser,
  getEmployees as getEmployeesLocal,
} from "@/lib/storage";
import { getUsersRemote, type DolibarrUser, getRemoteState, setRemoteState } from "@/lib/attendance-api";
import { isSystemAdministratorAccount } from "@/lib/attendance-roster";

const EMPLOYEE_STATE_KEY = "@trackforce_employees";
const FALLBACK_COMPANY_IDS = new Set(["", "company_default", "default", "cmp_default"]);

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeEmail(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function normalizeIdentity(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function normalizeEmployeeStatus(value: Employee["status"] | string | null | undefined): Employee["status"] {
  return value === "idle" || value === "offline" ? value : "active";
}

function isPlaceholderEmail(value: string | null | undefined): boolean {
  const email = normalizeEmail(value);
  return !email || email.endsWith("@dolibarr.local");
}

function getEmployeeNameKey(employee: Pick<Employee, "companyId" | "name">): string {
  return [
    normalizeText(employee.companyId),
    normalizeIdentity(employee.name),
  ].join("|");
}

function getEmployeeIdentityKeys(employee: Employee): string[] {
  const companyId = normalizeText(employee.companyId);
  const keys: string[] = [];
  const email = normalizeEmail(employee.email);
  if (email && !isPlaceholderEmail(email)) keys.push(`email:${companyId}:${email}`);
  const phone = normalizeText(employee.phone);
  if (phone) keys.push(`phone:${companyId}:${phone}`);
  const id = normalizeText(employee.id);
  if (id) keys.push(`id:${companyId}:${id}`);
  const name = normalizeIdentity(employee.name);
  const role = normalizeIdentity(employee.role);
  if (name) keys.push(`name:${companyId}:${role}:${name}`);
  return keys;
}

function scoreEmployeeRecord(employee: Employee): number {
  let score = 0;
  if (normalizeText(employee.id)) score += 1;
  if (!isPlaceholderEmail(employee.email)) score += 4;
  if (normalizeText(employee.phone)) score += 2;
  if (normalizeText(employee.branch)) score += 1;
  if (normalizeText(employee.department)) score += 1;
  if (employee.avatar) score += 1;
  if (employee.id.startsWith("dolibarr_")) score += 3;
  return score;
}

function mergeEmployeeRecord(current: Employee, incoming: Employee): Employee {
  const preferIncoming = scoreEmployeeRecord(incoming) >= scoreEmployeeRecord(current);
  const primary = preferIncoming ? incoming : current;
  const secondary = preferIncoming ? current : incoming;
  const role = primary.role || secondary.role;
  return {
    ...secondary,
    ...primary,
    id: primary.id || secondary.id,
    companyId: primary.companyId || secondary.companyId,
    name: primary.name || secondary.name,
    email: !isPlaceholderEmail(primary.email) ? primary.email : secondary.email || primary.email,
    role,
    department: normalizeDepartmentForRole(role, primary.department || secondary.department),
    status: normalizeEmployeeStatus(primary.status || secondary.status),
    phone: primary.phone || secondary.phone,
    branch: primary.branch || secondary.branch,
    pincode: primary.pincode || secondary.pincode,
    joinDate: primary.joinDate || secondary.joinDate,
    avatar: primary.avatar || secondary.avatar,
    managerId: primary.managerId || secondary.managerId,
    managerName: primary.managerName || secondary.managerName,
    stockistId: primary.stockistId || secondary.stockistId,
    stockistName: primary.stockistName || secondary.stockistName,
  };
}

function dedupeEmployees(employees: Employee[]): Employee[] {
  const merged: Employee[] = [];
  const keyToIndex = new Map<string, number>();

  for (const rawEmployee of employees) {
    const employee: Employee = {
      ...rawEmployee,
      name: normalizeText(rawEmployee.name),
      email: normalizeEmail(rawEmployee.email),
      role: rawEmployee.role || "employee",
      department: normalizeDepartmentForRole(rawEmployee.role || "employee", rawEmployee.department),
      status: normalizeEmployeeStatus(rawEmployee.status),
    };
    if (!employee.name) continue;

    const keys = getEmployeeIdentityKeys(employee);
    const existingIndex = keys
      .map((key) => keyToIndex.get(key))
      .find((index): index is number => typeof index === "number");

    if (typeof existingIndex === "number") {
      merged[existingIndex] = mergeEmployeeRecord(merged[existingIndex], employee);
      for (const key of getEmployeeIdentityKeys(merged[existingIndex])) {
        keyToIndex.set(key, existingIndex);
      }
      continue;
    }

    const nextIndex = merged.length;
    merged.push(employee);
    for (const key of keys) {
      keyToIndex.set(key, nextIndex);
    }
  }

  return merged;
}

function filterEmployeesByActiveRoster(
  employees: Employee[],
  activeEmployees: Employee[],
  currentUser: AppUser | null
): Employee[] {
  if (activeEmployees.length === 0) return employees;
  const activeKeys = new Set<string>();
  const activeNameKeys = new Set<string>();
  for (const employee of activeEmployees) {
    for (const key of getEmployeeIdentityKeys(employee)) activeKeys.add(key);
    activeNameKeys.add(getEmployeeNameKey(employee));
  }

  return employees.filter((employee) => {
    if (currentUser && employee.id === currentUser.id) return true;
    if (getEmployeeIdentityKeys(employee).some((key) => activeKeys.has(key))) return true;
    return activeNameKeys.has(getEmployeeNameKey(employee));
  });
}

function isEmployeeInCurrentCompany(employee: Employee, companyId: string): boolean {
  const employeeCompanyId = normalizeText(employee.companyId);
  if (!companyId) return true;
  return employeeCompanyId === companyId || FALLBACK_COMPANY_IDS.has(employeeCompanyId);
}

function scopeUsersToCurrentCompany(users: DolibarrUser[], currentUser: AppUser | null): DolibarrUser[] {
  if (!currentUser?.companyId) return users;
  return users.map((user) => ({
    ...user,
    companyId: user.companyId || currentUser.companyId,
    companyName: user.companyName || currentUser.companyName,
  }));
}

function getDepartmentForRole(role: AppUser["role"]): string {
  if (role === "admin") return "Management";
  if (role === "hr") return "Human Resources";
  if (role === "manager") return "Operations";
  if (role === "salesperson") return "On Field Employees";
  return "Office Employees";
}

function normalizeDepartmentForRole(role: AppUser["role"], department?: string | null): string {
  const normalized = normalizeText(department);
  if (role === "salesperson" && (!normalized || normalized.toLowerCase() === "sales")) {
    return getDepartmentForRole(role);
  }
  return normalized || getDepartmentForRole(role);
}

function userToEmployee(user: AppUser): Employee {
  return {
    id: user.id,
    companyId: user.companyId,
    name: user.name,
    role: user.role,
    department: normalizeDepartmentForRole(user.role, user.department),
    status: "active",
    email: user.email,
    phone: user.phone,
    branch: user.branch,
    pincode: user.pincode,
    joinDate: user.joinDate,
    avatar: user.avatar,
    managerId: user.managerId,
    managerName: user.managerName,
  };
}

async function readRemoteArray<T>(key: string): Promise<T[] | null> {
  try {
    const result = await getRemoteState<T[]>(key);
    if (Array.isArray(result.value)) return result.value;
  } catch {
    return null;
  }
  return null;
}

async function loadRosterUsers(currentUser: AppUser): Promise<DolibarrUser[]> {
  let scopedUsers: DolibarrUser[] = [];
  try {
    scopedUsers = scopeUsersToCurrentCompany(await getUsersRemote(), currentUser);
  } catch {
    scopedUsers = [];
  }

  return scopedUsers;
}

function mergeEmployees(
  baseEmployees: Employee[],
  extraEmployees: Employee[],
  fallbackCompanyId: string,
  options?: { includeUnmatchedExtras?: boolean }
): Employee[] {
  const normalizedBase = dedupeEmployees(baseEmployees);
  const normalizedExtra = dedupeEmployees(extraEmployees);
  const byEmail = new Map<string, Employee>();
  const byName = new Map<string, Employee>();
  for (const employee of normalizedBase) {
    const emailKey = normalizeEmail(employee.email);
    if (emailKey) byEmail.set(emailKey, employee);
    const nameKey = normalizeIdentity(employee.name);
    if (nameKey) byName.set(nameKey, employee);
  }

  const merged = [...normalizedBase];
  for (const extra of normalizedExtra) {
    const emailKey = normalizeEmail(extra.email);
    const nameKey = normalizeIdentity(extra.name);
    const existing = (emailKey && byEmail.get(emailKey)) || (nameKey && byName.get(nameKey)) || null;
    if (existing) {
      const next = mergeEmployeeRecord(
        {
          ...extra,
          companyId: extra.companyId || fallbackCompanyId,
        },
        {
          ...existing,
          companyId: existing.companyId || extra.companyId || fallbackCompanyId,
        }
      );
      const idx = merged.findIndex((entry) => entry.id === existing.id);
      if (idx >= 0) merged[idx] = next;
      if (emailKey) byEmail.set(emailKey, next);
      if (nameKey) byName.set(nameKey, next);
      continue;
    }
    if (options?.includeUnmatchedExtras) {
      merged.push({
        ...extra,
        companyId: extra.companyId || fallbackCompanyId,
      });
    }
  }

  return dedupeEmployees(merged);
}

function mapDolibarrUsersToEmployees(
  users: DolibarrUser[],
  currentUser: AppUser | null
): Employee[] {
  const companyId = currentUser?.companyId || "";
  const branch = currentUser?.branch || "Main Branch";
  const joined = currentUser?.joinDate || new Date().toISOString().slice(0, 10);

  const isUserActive = (user: { statut?: number | string; status?: number | string }): boolean => {
    const raw = user.statut ?? user.status;
    if (raw === undefined || raw === null || raw === "") return true;
    const numeric = Number(raw);
    if (!Number.isNaN(numeric)) return numeric === 1;
    const text = String(raw).toLowerCase();
    return text !== "0" && text !== "false" && text !== "disabled";
  };

  return users
    .filter((user) => isUserActive(user))
    .filter((user) => !isSystemAdministratorAccount(user))
    .map((user) => {
      const first = normalizeText(user.firstname);
      const last = normalizeText(user.lastname);
      const name = normalizeText(`${first} ${last}`) || normalizeText(user.login) || "Employee";
      const email = normalizeEmail(user.email);
      const pincode = normalizeText(user.zip ? String(user.zip) : "");
      const location =
        normalizeText(user.branch) ||
        normalizeText(user.town ? String(user.town) : "") ||
        normalizeText(user.address ? String(user.address) : "");
      const idValue =
        (user.id ? String(user.id) : "") ||
        (user.rowid ? String(user.rowid) : "") ||
        (user.user_id ? String(user.user_id) : "") ||
        normalizeText(user.login) ||
        email ||
        name;
      const rawCategory = normalizeIdentity(user.employeeCategory || user.employee_category);
      const role = user.role
        ? user.role
        : rawCategory === "fixed_location"
          ? "employee"
          : rawCategory === "on_field"
            ? "salesperson"
            : currentUser && email && normalizeEmail(currentUser.email) === email
              ? currentUser.role
              : "employee";
      return {
        id: `dolibarr_${idValue}`,
        companyId: normalizeText(user.companyId) || companyId,
        companyName: normalizeText(user.companyName) || currentUser?.companyName || "",
        name,
        role,
        employeeCategory: rawCategory === "on_field" || role === "salesperson" ? "on_field" : "fixed_location",
        department: normalizeDepartmentForRole(role, user.department),
        status: "active",
        email: email || `${idValue}@dolibarr.local`,
        phone: normalizeText(user.phone),
        branch: location || branch,
        pincode: pincode || undefined,
        joinDate: joined,
      } as Employee;
    })
    .filter((employee) => Boolean(employee.name));
}

export async function getEmployees(): Promise<Employee[]> {
  const currentUser = await getCurrentUser();
  const companyId = currentUser?.companyId || "";
  const [localEmployeesRaw, remoteEmployees] = await Promise.all([
    getEmployeesLocal(),
    readRemoteArray<Employee>(EMPLOYEE_STATE_KEY),
  ]);
  const localEmployees = dedupeEmployees(localEmployeesRaw);
  const remoteEmployeeList = dedupeEmployees(remoteEmployees || []);
  let baseEmployees = dedupeEmployees([...localEmployees, ...remoteEmployeeList]);

  if (baseEmployees.length === 0 && currentUser) {
    baseEmployees = [userToEmployee(currentUser)];
  }

  let dolibarrEmployees: Employee[] = [];
  if (currentUser && ["admin", "hr", "manager"].includes(currentUser.role)) {
    const dolibarrUsers = await loadRosterUsers(currentUser);
    dolibarrEmployees = mapDolibarrUsersToEmployees(dolibarrUsers, currentUser);
  }

  const activeRoster = dedupeEmployees(dolibarrEmployees);
  const filteredBase =
    activeRoster.length > 0 ? filterEmployeesByActiveRoster(baseEmployees, activeRoster, currentUser) : baseEmployees;
  const merged = mergeEmployees(filteredBase, activeRoster, companyId || "company_default", {
    includeUnmatchedExtras: activeRoster.length > 0,
  });
  const scoped = companyId ? merged.filter((employee) => isEmployeeInCurrentCompany(employee, companyId)) : merged;
  const finalEmployees = dedupeEmployees(scoped);

  if (activeRoster.length > 0 && currentUser && ["admin", "hr", "manager"].includes(currentUser.role)) {
    void setRemoteState(EMPLOYEE_STATE_KEY, finalEmployees).catch(() => {
      // Best-effort cleanup: UI should still use the deduped in-memory roster.
    });
  }

  return finalEmployees;
}
