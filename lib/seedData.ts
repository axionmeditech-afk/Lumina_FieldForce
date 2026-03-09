import type {
  AppUser,
  Employee,
  AttendanceRecord,
  SalaryRecord,
  Task,
  Expense,
  Conversation,
  AuditLog,
  BranchInfo,
  Geofence,
  Team,
  AppNotification,
  SupportThread,
} from "./types";

export const DEFAULT_COMPANY_ID = "cmp_trackforce_ai";
export const DEFAULT_COMPANY_NAME = "TrackForce AI";

export const demoUsers: AppUser[] = [];
export const demoPasswords: Record<string, string> = {};
export const demoEmployees: Employee[] = [];
export const demoAttendance: AttendanceRecord[] = [];
export const demoSalaries: SalaryRecord[] = [];
export const demoTasks: Task[] = [];
export const demoTeams: Team[] = [];
export const demoExpenses: Expense[] = [];
export const demoConversations: Conversation[] = [];
export const demoAuditLogs: AuditLog[] = [];
export const demoBranches: BranchInfo[] = [];
export const demoGeofences: Geofence[] = [];
export const demoNotifications: AppNotification[] = [];
export const demoSupportThreads: SupportThread[] = [];
