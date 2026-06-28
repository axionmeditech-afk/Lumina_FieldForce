import type { Express, RequestHandler } from "express";
import type { AppUser } from "@/lib/types";

type SalaryStatus = "pending" | "approved" | "paid";

export type SalaryRouteDeps = {
  requireAuth: RequestHandler;
  requireRoles: (...roles: any[]) => RequestHandler;
  populateUser: RequestHandler;
  isMySqlStateEnabled: () => boolean;
  getMySqlPool: () => Promise<any>;
  listDolibarrSalaryRows: (conn: any) => Promise<any[]>;
  verifyJwt: (token: string) => any;
  firstString: (value: unknown) => string;
  normalizeSalaryIdentity: (value: string) => string;
  resolveDolibarrSalaryViewerIds: (conn: any, user: AppUser) => Promise<Set<string>>;
  toSqlDateOnly: (value: unknown) => string | null;
  toSqlNumber: (value: unknown) => number;
  upsertDolibarrSalaryRecord: (conn: any, record: any, user: AppUser) => Promise<void>;
  deleteDolibarrSalaryRecord: (conn: any, salaryId: string) => Promise<void>;
  updateDolibarrSalaryStatus: (conn: any, salaryId: string, status: SalaryStatus) => Promise<void>;
};

export function registerSalaryRoutes(app: Express, deps: SalaryRouteDeps) {
  app.get("/api/salaries", async (req, res) => {
    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      const conn = await deps.getMySqlPool();
      let items = await deps.listDolibarrSalaryRows(conn);
      const authHeader = req.header("authorization");
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const authPayload = bearer ? deps.verifyJwt(bearer) : null;
      const isPrivileged = ["admin", "hr", "manager"].includes(authPayload?.role || "");

      if (!isPrivileged) {
        const requestUserId = deps.firstString(req.query.userId).trim();
        const requestUserEmail = deps.firstString(req.query.userEmail).trim();
        const requestUserName = deps.firstString(req.query.userName).trim();
        const requestUserLogin = deps.firstString(req.query.userLogin).trim();
        const userId = (authPayload?.sub || requestUserId).trim().toLowerCase();
        const userEmail = (authPayload?.email || requestUserEmail).trim().toLowerCase();
        const userName = deps.normalizeSalaryIdentity(requestUserName);
        const userLogin = deps.normalizeSalaryIdentity(requestUserLogin);

        if (userId || userEmail || userName || userLogin) {
          const viewerIds = await deps.resolveDolibarrSalaryViewerIds(conn, {
            id: userId,
            name: requestUserName,
            email: authPayload?.email || requestUserEmail,
            login: requestUserLogin || undefined,
            role: "salesperson",
            companyId: "",
            companyName: "",
            department: "",
            branch: "",
            phone: "",
            joinDate: "",
          } as AppUser);

          items = items.filter((salary) => {
            const salaryEmail = (salary.employeeEmail || "").trim().toLowerCase();
            const salaryId = (salary.employeeId || "").trim().toLowerCase();
            const salaryName = deps.normalizeSalaryIdentity(salary.employeeName);
            return Boolean(
              (userEmail && salaryEmail === userEmail) ||
                (userId && (salaryId === userId || salaryId === `dolibarr_${userId}`)) ||
                (userLogin &&
                  (salaryEmail === userLogin ||
                    salaryName === userLogin ||
                    salaryId === `dolibarr_${userLogin}`)) ||
                (userName && salaryName === userName) ||
                viewerIds.has(salaryId),
            );
          });
        } else {
          items = [];
        }
      }

      res.json({ items });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to fetch salaries.";
      res.status(500).json({ message });
    }
  });

  app.post(
    "/api/salaries",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager"),
    deps.populateUser,
    async (req, res) => {
      if (!deps.isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL is not configured." });
        return;
      }
      try {
        const e = (req.body || {}) as Record<string, unknown>;
        const id = e.id ? String(e.id).trim() : "";
        if (!id) {
          res.status(400).json({ message: "id is required" });
          return;
        }
        const pool = await deps.getMySqlPool();
        const conn = await pool.getConnection();
        const employeeId = e.employeeId ? String(e.employeeId).trim() : "";
        const employeeName = e.employeeName ? String(e.employeeName).trim() : "Employee";
        const employeeEmail = e.employeeEmail ? String(e.employeeEmail).trim() : null;
        const label = e.label ? String(e.label).trim() : null;
        const periodStart = e.periodStart ? deps.toSqlDateOnly(e.periodStart) : null;
        const periodEnd = e.periodEnd ? deps.toSqlDateOnly(e.periodEnd) : null;
        const paymentDate = e.paymentDate ? deps.toSqlDateOnly(e.paymentDate) : null;
        const paymentMode = e.paymentMode ? String(e.paymentMode).trim() : null;
        const bankAccount = e.bankAccount ? String(e.bankAccount).trim() : null;
        const note = e.note ? String(e.note).trim() : null;
        const month = e.month ? String(e.month).trim() : "unknown";
        const status: SalaryStatus =
          e.status === "paid" ? "paid" : e.status === "approved" ? "approved" : "pending";
        try {
          await conn.beginTransaction();
          await deps.upsertDolibarrSalaryRecord(
            conn,
            {
              id,
              employeeId,
              employeeName,
              employeeEmail: employeeEmail || undefined,
              label: label || undefined,
              periodStart: periodStart ? String(periodStart) : undefined,
              periodEnd: periodEnd ? String(periodEnd) : undefined,
              paymentDate: paymentDate ? String(paymentDate) : undefined,
              paymentMode: paymentMode || undefined,
              bankAccount: bankAccount || undefined,
              note: note || undefined,
              month,
              basic: deps.toSqlNumber(e.basic),
              hra: deps.toSqlNumber(e.hra),
              transport: deps.toSqlNumber(e.transport),
              medical: deps.toSqlNumber(e.medical),
              bonus: deps.toSqlNumber(e.bonus),
              overtime: deps.toSqlNumber(e.overtime),
              tax: deps.toSqlNumber(e.tax),
              pf: deps.toSqlNumber(e.pf),
              insurance: deps.toSqlNumber(e.insurance),
              grossPay: deps.toSqlNumber(e.grossPay),
              totalDeductions: deps.toSqlNumber(e.totalDeductions),
              netPay: deps.toSqlNumber(e.netPay),
              status,
            },
            (req as any).user as AppUser,
          );
          await conn.commit();
          res.status(201).json({ id, ok: true });
        } catch (error) {
          await conn.rollback();
          throw error;
        } finally {
          conn.release();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to save salary.";
        res.status(500).json({ message });
      }
    },
  );

  app.delete(
    "/api/salaries/:id",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!deps.isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL is not configured." });
        return;
      }
      const salaryId = deps.firstString(req.params.id);
      if (!salaryId) {
        res.status(400).json({ message: "Salary id is required." });
        return;
      }
      try {
        const conn = await deps.getMySqlPool();
        await deps.deleteDolibarrSalaryRecord(conn, salaryId);
        res.json({ id: salaryId, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to delete salary.";
        res.status(500).json({ message });
      }
    },
  );

  app.patch(
    "/api/salaries/:id/status",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!deps.isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL is not configured." });
        return;
      }
      const salaryId = deps.firstString(req.params.id);
      if (!salaryId) {
        res.status(400).json({ message: "Salary id is required." });
        return;
      }

      const rawStatus = deps.firstString((req.body as Record<string, unknown> | undefined)?.status);
      const status: SalaryStatus | null =
        rawStatus === "paid"
          ? "paid"
          : rawStatus === "approved"
            ? "approved"
            : rawStatus === "pending"
              ? "pending"
              : null;
      if (!status) {
        res.status(400).json({ message: "A valid salary status is required." });
        return;
      }

      try {
        const conn = await deps.getMySqlPool();
        await deps.updateDolibarrSalaryStatus(conn, salaryId, status);
        res.json({ id: salaryId, status, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to update salary status.";
        res.status(500).json({ message });
      }
    },
  );
}
