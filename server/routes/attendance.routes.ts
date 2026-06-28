import type { Express, RequestHandler } from "express";
import type { AttendanceRecord } from "@/lib/types";

export type AttendanceRouteDeps = {
  requireAuth: RequestHandler;
  firstString: (value: unknown) => string;
  ensureUserMatch: (req: any, userId: string) => boolean;
  isMySqlStateEnabled: () => boolean;
  storage: {
    getAttendanceToday: (userId: string) => Promise<AttendanceRecord[]>;
    getAttendanceHistory: (userId: string) => Promise<AttendanceRecord[]>;
  };
  listAttendanceTodayFromMySql: (userId: string) => Promise<AttendanceRecord[]>;
  listAttendanceTodayFromMySqlAll: (companyId: string, dateKey?: string) => Promise<AttendanceRecord[]>;
  listAttendanceHistoryFromMySql: (userId: string) => Promise<AttendanceRecord[]>;
  listAttendanceForUserDateFromMySql: (userId: string, dateKey: string) => Promise<AttendanceRecord[]>;
  getRequestUser: (req: any) => any;
  normalizeWhitespace: (value: string) => string;
  normalizeCompanyIds: (value: unknown) => string[];
  resolveRequestCompanyId: (req: any) => Promise<string | null>;
  defaultCompanyId: string;
};

export function registerAttendanceRoutes(app: Express, deps: AttendanceRouteDeps) {
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
          .catch(() => deps.storage.getAttendanceToday(userId))
      : await deps.storage.getAttendanceToday(userId);
    res.json(records);
  });

  app.get("/api/attendance/company/today", deps.requireAuth, async (req, res) => {
    try {
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
      const companyId =
        (canUseRequestedCompany ? requestedCompanyId : "") ||
        (await deps.resolveRequestCompanyId(req)) ||
        requestUser?.companyId ||
        deps.defaultCompanyId;

      const requestedDate = deps.normalizeWhitespace(
        typeof req.query.date === "string" ? req.query.date : "",
      );
      const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : undefined;
      const records = deps.isMySqlStateEnabled()
        ? await deps.listAttendanceTodayFromMySqlAll(companyId, dateKey)
        : [];
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
    const limitRaw = Number(typeof req.query.limit === "string" ? req.query.limit : "");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(2000, Math.trunc(limitRaw)))
      : null;
    const records = deps.isMySqlStateEnabled()
      ? await (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
          ? deps
              .listAttendanceForUserDateFromMySql(userId, requestedDate)
              .catch(() => deps.storage.getAttendanceHistory(userId))
          : deps
              .listAttendanceHistoryFromMySql(userId)
              .catch(() => deps.storage.getAttendanceHistory(userId)))
      : await deps.storage.getAttendanceHistory(userId);
    const responseRecords = limit ? records.slice(0, limit) : records;
    res.json(responseRecords);
  });
}
