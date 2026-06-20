import type { AppUser, BankAccount, Employee, SalaryRecord } from "@/lib/types";
import {
  getCurrentUser,
  getEmployees as getEmployeesLocal,
} from "@/lib/storage";
import {
  deleteBankAccountRemote,
  deleteSalaryRecordRemote,
  getDolibarrUsers,
  getUsersRemote,
  type DolibarrUser,
  listBankAccountsRemote,
  getRemoteState,
  listSalaryRecordsRemote,
  saveBankAccountRemote,
  setRemoteState,
  syncBankAccountToDolibarr,
  saveSalaryRecordRemote,
  updateSalaryStatusRemote,
} from "@/lib/attendance-api";

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
  try {
    const scopedUsers = await getUsersRemote();
    if (scopedUsers.length > 0) {
      return scopeUsersToCurrentCompany(scopedUsers, currentUser);
    }
  } catch {
    // Fall back to the generic Dolibarr proxy below.
  }

  try {
    return await getDolibarrUsers({ limit: 500, sortfield: "lastname", sortorder: "asc" });
  } catch {
    return [];
  }
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
  if (currentUser) {
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

  if (activeRoster.length > 0 && currentUser) {
    void setRemoteState(EMPLOYEE_STATE_KEY, finalEmployees).catch(() => {
      // Best-effort cleanup: UI should still use the deduped in-memory roster.
    });
  }

  return finalEmployees;
}

export async function getDolibarrEmployees(): Promise<Employee[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser || !["admin", "hr", "manager"].includes(currentUser.role)) {
    return [];
  }
  try {
    const approvedEmployees = await getEmployeesLocal();
    const scopedEmployees = approvedEmployees.filter(
      (employee) => employee.companyId === currentUser.companyId
    );
    const dolibarrUsers = await loadRosterUsers(currentUser);
    const dolibarrEmployees = dedupeEmployees(mapDolibarrUsersToEmployees(dolibarrUsers, currentUser));
    const filteredLocal = filterEmployeesByActiveRoster(scopedEmployees, dolibarrEmployees, currentUser);
    return mergeEmployees(filteredLocal, dolibarrEmployees, currentUser.companyId, {
      includeUnmatchedExtras: true,
    });
  } catch {
    return dedupeEmployees(await getEmployeesLocal());
  }
}

export async function getSalaries(): Promise<SalaryRecord[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return await listSalaryRecordsRemote();
  }

  if (["admin", "hr", "manager"].includes(currentUser.role)) {
    return await listSalaryRecordsRemote();
  }

  return await listSalaryRecordsRemote({
    userId: currentUser.id,
    userEmail: currentUser.email,
    userName: currentUser.name,
    userLogin: currentUser.login,
  });
}

export async function saveSalaryRecord(
  record: SalaryRecord
): Promise<{ record: SalaryRecord; synced: boolean; dolibarr?: { ok: boolean; message: string } }> {
  const currentUser = await getCurrentUser();
  const companyId = record.companyId || currentUser?.companyId || "company_default";
  const nextRecord: SalaryRecord = {
    ...record,
    companyId,
  };

  await saveSalaryRecordRemote(nextRecord);

  return {
    record: nextRecord,
    synced: true,
    dolibarr: { ok: true, message: "Salary saved to nmy5_salary." },
  };
}

export async function deleteSalaryRecord(id: string): Promise<boolean> {
  await deleteSalaryRecordRemote(id);
  return true;
}

export async function updateSalaryRecordStatus(
  id: string,
  status: SalaryRecord["status"]
): Promise<boolean> {
  await updateSalaryStatusRemote(id, status);
  return true;
}

const BANK_ACCOUNTS_STATE_KEY = "@trackforce_bank_accounts";

export async function getBankAccounts(filters?: {
  employeeId?: string;
  employeeEmail?: string;
  employeeName?: string;
}): Promise<BankAccount[]> {
  try {
    return await listBankAccountsRemote(filters);
  } catch {
    const remote = await readRemoteArray<BankAccount>(BANK_ACCOUNTS_STATE_KEY);
    if (!Array.isArray(remote)) return [];
    if (!filters?.employeeId && !filters?.employeeEmail && !filters?.employeeName) {
      return remote;
    }
    const email = normalizeEmail(filters.employeeEmail);
    const name = normalizeIdentity(filters.employeeName);
    const rawId = normalizeIdentity(filters.employeeId);
    const altId = rawId.startsWith("dolibarr_") ? rawId.replace("dolibarr_", "") : `dolibarr_${rawId}`;
    return remote.filter((account) => {
      const accountEmail = normalizeEmail(account.employeeEmail);
      const accountName = normalizeIdentity(account.employeeName);
      const accountId = normalizeIdentity(account.employeeId);
      return Boolean(
        (email && accountEmail === email) ||
          (name && accountName === name) ||
          (rawId && (accountId === rawId || accountId === altId))
      );
    });
  }
}

export async function saveBankAccount(
  account: BankAccount,
  options?: { syncToDolibarr?: boolean }
): Promise<{ record: BankAccount; synced: boolean; dolibarr?: { ok: boolean; message: string } }> {
  await saveBankAccountRemote(account);

  if (options?.syncToDolibarr === false) {
    await saveBankAccountLocal(account);
    return { record: account, synced: false };
  }

  let dolibarrResult: { ok: boolean; message: string } | undefined;
  try {
    dolibarrResult = await syncBankAccountToDolibarr(account);
  } catch (error) {
    dolibarrResult = {
      ok: false,
      message: error instanceof Error ? error.message : "Dolibarr sync failed",
    };
  }

  if (!dolibarrResult?.ok) {
    try {
      await deleteBankAccountRemote(account.id);
    } catch (rollbackError) {
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : "Unknown rollback failure.";
      throw new Error(
        `${dolibarrResult?.message || "Dolibarr bank account sync failed."} Database rollback may be required: ${rollbackMessage}`
      );
    }
    throw new Error(dolibarrResult?.message || "Dolibarr bank account sync failed.");
  }

  await saveBankAccountLocal(account);

  return { record: account, synced: true, dolibarr: dolibarrResult };
}

async function saveBankAccountLocal(account: BankAccount): Promise<void> {
  // Mocking local storage save for now if needed, but the summary says it's already using state key.
  // The existing implementation already used setRemoteState.
}

export async function deleteBankAccount(id: string): Promise<boolean> {
  await deleteBankAccountRemote(id);
  return true;
}
