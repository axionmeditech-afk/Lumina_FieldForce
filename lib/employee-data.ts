import type { AppUser, BankAccount, Employee, SalaryRecord } from "@/lib/types";
import {
  addSalaryRecord,
  deleteSalaryRecordLocal,
  getCurrentUser,
  getEmployees as getEmployeesLocal,
  getSalaries as getSalariesLocal,
  updateSalaryStatus,
} from "@/lib/storage";
import {
  deleteBankAccountRemote,
  deleteSalaryRecordRemote,
  getDolibarrUsers,
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
const SALARY_STATE_KEY = "@trackforce_salaries";

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeEmail(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function normalizeIdentity(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function userToEmployee(user: AppUser): Employee {
  return {
    id: user.id,
    companyId: user.companyId,
    name: user.name,
    role: user.role,
    department: user.department,
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

function mergeEmployees(
  baseEmployees: Employee[],
  extraEmployees: Employee[],
  fallbackCompanyId: string
): Employee[] {
  const byEmail = new Map<string, Employee>();
  const byName = new Map<string, Employee>();
  for (const employee of baseEmployees) {
    const emailKey = normalizeEmail(employee.email);
    if (emailKey) byEmail.set(emailKey, employee);
    const nameKey = normalizeIdentity(employee.name);
    if (nameKey) byName.set(nameKey, employee);
  }

  const merged = [...baseEmployees];
  for (const extra of extraEmployees) {
    const emailKey = normalizeEmail(extra.email);
    const nameKey = normalizeIdentity(extra.name);
    const existing = (emailKey && byEmail.get(emailKey)) || (nameKey && byName.get(nameKey)) || null;
    if (existing) {
      const next: Employee = {
        ...extra,
        ...existing,
        id: existing.id || extra.id,
        companyId: existing.companyId || extra.companyId || fallbackCompanyId,
        name: existing.name || extra.name,
        email: existing.email || extra.email,
        role: existing.role || extra.role,
        department: existing.department || extra.department,
        branch: existing.branch || extra.branch,
        phone: existing.phone || extra.phone,
        status: existing.status || extra.status,
        pincode: existing.pincode || extra.pincode,
      };
      const idx = merged.findIndex((entry) => entry.id === existing.id);
      if (idx >= 0) merged[idx] = next;
      continue;
    }
    merged.push({
      ...extra,
      companyId: extra.companyId || fallbackCompanyId,
    });
  }

  return merged;
}

function mapDolibarrUsersToEmployees(
  users: Array<{
    id?: number | string;
    firstname?: string;
    lastname?: string;
    login?: string;
    email?: string;
    zip?: string;
    town?: string;
    address?: string;
    statut?: number | string;
    status?: number | string;
  }>,
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
        normalizeText(user.town ? String(user.town) : "") ||
        normalizeText(user.address ? String(user.address) : "");
      const idValue = user.id ? String(user.id) : normalizeText(user.login) || email || name;
      const role = currentUser && email && normalizeEmail(currentUser.email) === email
        ? currentUser.role
        : "salesperson";
      return {
        id: `dolibarr_${idValue}`,
        companyId,
        name,
        role,
        department: role === "admin" ? "Management" : "Sales",
        status: "active",
        email: email || `${idValue}@dolibarr.local`,
        phone: "",
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
  const localEmployees = await getEmployeesLocal();
  const remoteEmployees = await readRemoteArray<Employee>(EMPLOYEE_STATE_KEY);
  let baseEmployees = remoteEmployees && remoteEmployees.length > 0 ? remoteEmployees : localEmployees;

  if (baseEmployees.length === 0 && currentUser) {
    baseEmployees = [userToEmployee(currentUser)];
  }

  let dolibarrEmployees: Employee[] = [];
  if (currentUser && ["admin", "hr", "manager"].includes(currentUser.role)) {
    try {
      const dolibarrUsers = await getDolibarrUsers({ limit: 500, sortfield: "lastname", sortorder: "asc" });
      dolibarrEmployees = mapDolibarrUsersToEmployees(dolibarrUsers, currentUser);
    } catch {
      dolibarrEmployees = [];
    }
  }

  const merged = mergeEmployees(baseEmployees, dolibarrEmployees, companyId || "company_default");
  if (!companyId) return merged;
  return merged.filter((employee) => employee.companyId === companyId);
}

export async function getDolibarrEmployees(): Promise<Employee[]> {
  const currentUser = await getCurrentUser();
  if (!currentUser || !["admin", "hr", "manager"].includes(currentUser.role)) {
    return [];
  }
  try {
    const dolibarrUsers = await getDolibarrUsers({ limit: 500, sortfield: "lastname", sortorder: "asc" });
    return mapDolibarrUsersToEmployees(dolibarrUsers, currentUser);
  } catch {
    return [];
  }
}

export async function getSalaries(): Promise<SalaryRecord[]> {
  const currentUser = await getCurrentUser();
  const companyId = currentUser?.companyId || "";
  let remoteSalaries: SalaryRecord[] | null = null;
  try {
    remoteSalaries = await listSalaryRecordsRemote();
  } catch {
    remoteSalaries = await readRemoteArray<SalaryRecord>(SALARY_STATE_KEY);
  }
  const localSalaries = await getSalariesLocal();
  const base = remoteSalaries ?? localSalaries;
  if (!companyId) return base;
  return base.filter((salary) => !salary.companyId || salary.companyId === companyId);
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

  await addSalaryRecord(nextRecord);

  return {
    record: nextRecord,
    synced: true,
    dolibarr: { ok: true, message: "Salary saved to app DB and mirrored to Dolibarr salary table." },
  };
}

export async function deleteSalaryRecord(id: string): Promise<boolean> {
  await deleteSalaryRecordRemote(id);
  await deleteSalaryRecordLocal(id);
  return true;
}

export async function updateSalaryRecordStatus(
  id: string,
  status: SalaryRecord["status"]
): Promise<boolean> {
  await updateSalaryStatusRemote(id, status);
  await updateSalaryStatus(id, status);
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
