import type { AppUser, Employee, SalaryRecord } from "@/lib/types";
import {
  addSalaryRecord,
  getCurrentUser,
  getEmployees as getEmployeesLocal,
  getSalaries as getSalariesLocal,
} from "@/lib/storage";
import {
  getDolibarrUsers,
  getRemoteState,
  setRemoteState,
  syncSalaryToDolibarr,
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
        branch,
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

export async function getSalaries(): Promise<SalaryRecord[]> {
  const currentUser = await getCurrentUser();
  const companyId = currentUser?.companyId || "";
  const remoteSalaries = await readRemoteArray<SalaryRecord>(SALARY_STATE_KEY);
  const localSalaries = await getSalariesLocal();
  const base = remoteSalaries && remoteSalaries.length > 0 ? remoteSalaries : localSalaries;
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

  let synced = false;
  try {
    const remoteSalaries = (await readRemoteArray<SalaryRecord>(SALARY_STATE_KEY)) || [];
    const filtered = remoteSalaries.filter((entry) => entry.id !== nextRecord.id);
    filtered.unshift(nextRecord);
    await setRemoteState(SALARY_STATE_KEY, filtered);
    synced = true;
  } catch {
    synced = false;
  }

  await addSalaryRecord(nextRecord);

  let dolibarrResult: { ok: boolean; message: string } | undefined;
  if (nextRecord.employeeEmail) {
    try {
      dolibarrResult = await syncSalaryToDolibarr({
        salaryId: nextRecord.id,
        employeeName: nextRecord.employeeName,
        employeeEmail: nextRecord.employeeEmail,
        label: nextRecord.label,
        periodStart: nextRecord.periodStart,
        periodEnd: nextRecord.periodEnd,
        paymentDate: nextRecord.paymentDate,
        paymentMode: nextRecord.paymentMode,
        note: nextRecord.note,
        month: nextRecord.month,
        grossPay: nextRecord.grossPay,
        netPay: nextRecord.netPay,
        status: nextRecord.status,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sync salary to Dolibarr.";
      dolibarrResult = { ok: false, message };
    }
  }

  return { record: nextRecord, synced, dolibarr: dolibarrResult };
}
