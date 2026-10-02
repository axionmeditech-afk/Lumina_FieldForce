import { toMumbaiDateKey } from "@/lib/ist-time";
import type { Express, RequestHandler } from "express";
import type { AttendanceRecord } from "@/lib/types";

export type AttendanceRouteDeps = {
  requireAuth: RequestHandler;
  firstString: (value: unknown) => string;
  ensureUserMatch: (req: any, userId: string) => boolean;
  isMySqlStateEnabled: () => boolean;
  storage: {
    getAttendanceToday: (userId: string) => Promise<AttendanceRecord[]>;
    findActiveAttendance: (userId: string) => Promise<AttendanceRecord | null>;
    getCompanyAttendanceForDate: (companyId: string, date: string) => Promise<AttendanceRecord[]>;
    getAttendanceHistory: (userId: string) => Promise<AttendanceRecord[]>;
  };
  findActiveAttendanceInMySql: (userId: string) => Promise<AttendanceRecord | null>;
  listAttendanceTodayFromMySql: (userId: string) => Promise<AttendanceRecord[]>;
  listAttendanceTodayFromMySqlAll: (companyId: string, dateKey?: string, endDateKey?: string) => Promise<AttendanceRecord[]>;
  listAttendanceHistoryFromMySql: (userId: string, limit?: number) => Promise<AttendanceRecord[]>;
  listAttendanceForUserDateFromMySql: (userId: string, dateKey: string) => Promise<AttendanceRecord[]>;
  getRequestUser: (req: any) => any;
  normalizeWhitespace: (value: string) => string;
  normalizeCompanyIds: (value: unknown) => string[];
  resolveRequestCompanyId: (req: any) => Promise<string | null>;
  defaultCompanyId: string;
};

export function registerAttendanceRoutes(app: Express, deps: AttendanceRouteDeps) {
  app.get("/api/attendance/status", deps.requireAuth, async (req, res) => {
    const userId = req.auth!.sub;
    const date = typeof req.query.date === "string" ? req.query.date : toMumbaiDateKey(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ message: "Invalid date" }); return; }
    try {
      const [records, active] = deps.isMySqlStateEnabled()
        ? await Promise.all([deps.listAttendanceForUserDateFromMySql(userId, date), deps.findActiveAttendanceInMySql(userId)])
        : await Promise.all([deps.storage.getAttendanceHistory(userId).then(rows => rows.filter(row => toMumbaiDateKey(row.timestamp) === date)), deps.storage.findActiveAttendance(userId)]);
      const requestUser = deps.getRequestUser(req);
      const activeCompanyId =
        (await deps.resolveRequestCompanyId(req)) ||
        requestUser?.companyId ||
        null;
      const scopedRecords = activeCompanyId
        ? records.filter((record) => !record.companyId || record.companyId === activeCompanyId)
        : records;
      const scopedActive =
        active && activeCompanyId && active.companyId && active.companyId !== activeCompanyId
          ? null
          : active;
      res.set("Cache-Control", "no-store").json({ records: scopedRecords, active: scopedActive });
    } catch { res.status(503).json({ message: "Unable to refresh attendance. Please retry." }); }
  });

  app.get("/api/attendance/today", deps.requireAuth, async (req, res) => {
    const userId = deps.firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!deps.ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const records = deps.isMySqlStateEnabled()
      ? await deps
          .listAttendanceTodayFromMySql(userId)

      : await deps.storage.getAttendanceToday(userId);
    res.json(records);
  });

  app.get("/api/attendance/company/today", deps.requireAuth, async (req, res) => {
    try {
      if (!["admin", "hr", "manager"].includes(req.auth?.role || "")) {
        res.status(403).json({ message: "Company attendance requires a supervisor role" }); return;
      }
      const requestUser = deps.getRequestUser(req);
      const requestedCompanyId = deps.normalizeWhitespace(
        typeof req.query.company_id === "string" ? req.query.company_id : "",
      );
      const allowedCompanyIds = new Set(
        deps.normalizeCompanyIds(
          requestUser?.companyIds || (requestUser?.companyId ? [requestUser.companyId] : []),
        ),
      );
      const canUseRequestedCompany =
        requestedCompanyId &&
        (requestUser?.role === "admin" || allowedCompanyIds.has(requestedCompanyId));
      if (requestedCompanyId && !canUseRequestedCompany) { res.status(403).json({ message: "Company access denied" }); return; }
      const companyId =
        (canUseRequestedCompany ? requestedCompanyId : "") ||
        (await deps.resolveRequestCompanyId(req)) ||
        requestUser?.companyId ||
        deps.defaultCompanyId;

      const requestedDate = deps.normalizeWhitespace(
        typeof req.query.date === "string" ? req.query.date : "",
      );
      const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : undefined;
      const month = typeof req.query.month === "string" ? req.query.month : "";
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { res.status(400).json({ message: "Invalid month" }); return; }
      const start = month ? `${month}-01` : dateKey;
      const end = month ? `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()}` : dateKey;
      const records = deps.isMySqlStateEnabled()
        ? await deps.listAttendanceTodayFromMySqlAll(companyId, start, end)
        : await deps.storage.getCompanyAttendanceForDate(companyId, dateKey || toMumbaiDateKey(new Date()));
      res.json(records);
    } catch (error) {
      console.error("Failed to list company attendance today", error);
      res.status(500).json({ message: "Failed to list company attendance" });
    }
  });

  app.get("/api/attendance/history", deps.requireAuth, async (req, res) => {
    const userId = deps.firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!deps.ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const requestedDate = deps.normalizeWhitespace(
      typeof req.query.date === "string" ? req.query.date : "",
    );
    const limitRaw = Number(typeof req.query.limit === "string" ? req.query.limit : "200");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(2000, Math.trunc(limitRaw)))
      : null;
    const records = deps.isMySqlStateEnabled()
      ? await (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
          ? deps
              .listAttendanceForUserDateFromMySql(userId, requestedDate)

          : deps
              .listAttendanceHistoryFromMySql(userId, limit || 200)
              )
      : await deps.storage.getAttendanceHistory(userId);
    const responseRecords = limit ? records.slice(0, limit) : records;
    res.json(responseRecords);
  });
}
