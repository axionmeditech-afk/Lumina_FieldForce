import type { Express } from "express";
import type { AppNotification, AppUser } from "@/lib/types";

type AccessRequestRecord = any;

export type LeaveRouteDeps = Record<string, any>;

export function registerLeaveRoutes(app: Express, deps: LeaveRouteDeps) {
  const {
    getMySqlPool,
    isMySqlStateEnabled,
    requireAuth,
    populateUser,
    randomUUID,
    toSqlDateOnly,
    insertNotificationInMySql,
    firstString,
    getRequestUser,
    normalizeWhitespace,
    normalizeCompanyIds,
    resolveRequestCompanyId,
    listCompanyProfilesFromMySqlRaw,
    ensureAccessRequestAssignmentColumns,
    listAccessRequestsFromMySql,
    normalizeEmail,
    normalizeLoginKey,
    isLegacyDemoProfileName,
    normalizeRole,
    isSalesRole,
    normalizeDepartmentForRole,
    DEFAULT_COMPANY_ID,
  } = deps;
  // ---------------------------------------------------------------------------
  // Leave Management
  // ---------------------------------------------------------------------------

  let leaveTableEnsured = false;
  async function ensureLeaveRequestsTable(): Promise<void> {
    if (leaveTableEnsured) return;
    const conn = await getMySqlPool();
    await conn.execute(
      `CREATE TABLE IF NOT EXISTS \`lff_leave_requests\` (
        \`id\`                    VARCHAR(64) NOT NULL,
        \`company_id\`            VARCHAR(64) NULL,
        \`user_id\`               VARCHAR(64) NOT NULL,
        \`user_name\`             VARCHAR(191) NOT NULL,
        \`user_email\`            VARCHAR(191) NULL,
        \`leave_date\`            DATE NOT NULL,
        \`leave_end_date\`        DATE NULL,
        \`leave_type\`            ENUM('planned','unplanned') NOT NULL,
        \`is_half_day\`           TINYINT(1) NOT NULL DEFAULT 0,
        \`leave_days\`            DECIMAL(3,1) NOT NULL DEFAULT 1.0,
        \`note\`                  LONGTEXT NULL,
        \`status\`                ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
        \`reviewed_by_id\`        VARCHAR(64) NULL,
        \`reviewed_by_name\`      VARCHAR(191) NULL,
        \`reviewed_at\`           DATETIME NULL,
        \`review_comment\`        LONGTEXT NULL,
        \`dolibarr_holiday_id\`   BIGINT NULL,
        \`created_at\`            DATETIME NOT NULL,
        \`updated_at\`            DATETIME NOT NULL,
        PRIMARY KEY (\`id\`),
        KEY \`idx_lff_leave_user_date\` (\`user_id\`, \`leave_date\`),
        KEY \`idx_lff_leave_status\` (\`status\`),
        KEY \`idx_lff_leave_company\` (\`company_id\`),
        KEY \`idx_lff_leave_dolibarr\` (\`dolibarr_holiday_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    leaveTableEnsured = true;
  }

  // Ensure App Config Table
  async function ensureAppConfigTable() {
    try {
      const conn = await getMySqlPool();
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS \`lff_app_config\` (
          \`key\` VARCHAR(50) PRIMARY KEY,
          \`value\` TEXT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
    } catch (e) {}
  }
  
  ensureAppConfigTable();

  function mapDolibarrLeaveStatus(statut: number): string {
    if (statut === 1 || statut === 2) return "pending";
    if (statut === 3) return "approved";
    if (statut === 4 || statut === 5) return "rejected";
    return "pending";
  }

  // GET /api/leaves
  app.get("/api/leaves", requireAuth, populateUser, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const isPrivileged = ["admin", "hr", "manager"].includes(requestUser?.role || "");

      let query = `
        SELECT h.*, u.email as user_email, u.firstname, u.lastname
        FROM \`nmy5_holiday\` h
        LEFT JOIN \`nmy5_user\` u ON h.fk_user = u.rowid
      `;
      const whereClauses: string[] = [];
      const params: unknown[] = [];

      if (!isPrivileged) {
        whereClauses.push("u.email = ?");
        params.push(requestUser?.email || "");
      }

      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(" AND ")}`;
      }
      query += " ORDER BY h.date_debut DESC LIMIT 500";

      const [rows] = (await conn.query(query, params)) as [any[], unknown];
      
      const mapped = (rows || []).map((row: any) => ({
        id: String(row.rowid),
        companyId: null,
        userId: (requestUser?.email || "").trim().toLowerCase() === (row.user_email || "").trim().toLowerCase() ? String(requestUser?.id) : String(row.fk_user),
        userName: `${row.firstname || ""} ${row.lastname || ""}`.trim(),
        userEmail: row.user_email || "",
        leaveDate: row.date_debut ? new Date(row.date_debut).toISOString().slice(0, 10) : "",
        leaveEndDate: row.date_fin ? new Date(row.date_fin).toISOString().slice(0, 10) : null,
        leaveType: Number(row.fk_type) === 4 ? "unplanned" : "planned",
        isHalfDay: row.halfday > 0,
        leaveDays: Number(row.nb_open_day || 1),
        note: row.description || "",
        status: mapDolibarrLeaveStatus(Number(row.statut)),
        reviewedById: null,
        reviewedByName: null,
        reviewedAt: null,
        reviewComment: null,
        dolibarrHolidayId: row.rowid,
        createdAt: row.date_create ? new Date(row.date_create).toISOString() : "",
        updatedAt: row.date_create ? new Date(row.date_create).toISOString() : "",
      }));

      res.json({ items: mapped });
    } catch (error) {
      res.status(500).json({ message: "Error fetching leaves" });
    }
  });

  
  // GET /api/users
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = getRequestUser(req);
      const requestedCompanyId = normalizeWhitespace(
        typeof req.query.companyId === "string" ? req.query.companyId : ""
      );
      const allowedCompanyIds = new Set(
        normalizeCompanyIds(requestUser?.companyIds || (requestUser?.companyId ? [requestUser.companyId] : []))
      );
      const canUseRequestedCompany =
        requestedCompanyId &&
        (requestUser?.role === "admin" || allowedCompanyIds.has(requestedCompanyId));
      const companyId =
        (canUseRequestedCompany ? requestedCompanyId : "") ||
        (await resolveRequestCompanyId(req)) ||
        requestUser?.companyId ||
        DEFAULT_COMPANY_ID;
      const companies = await listCompanyProfilesFromMySqlRaw();
      const companyById = new Map<string, any>(
        companies.map((company: any) => [company.id, company]),
      );
      try {
        await ensureAccessRequestAssignmentColumns();
      } catch {
        // Continue with the current schema; the access request reader will handle missing data.
      }

      let userRows: any[] = [];
      try {
        [userRows] = await conn.query(
          `SELECT
            u.rowid as id,
            u.login,
            u.firstname,
            u.lastname,
            u.email,
            u.office_phone,
            u.user_mobile,
            u.admin,
            u.employee,
            u.job,
            u.statut,
            p.employee_category
           FROM \`nmy5_user\` u
           LEFT JOIN \`nmy5_hrm_employee_profile\` p ON p.fk_user = u.rowid
           WHERE u.statut = 1`
        );
      } catch {
        [userRows] = await conn.query(
          `SELECT
            rowid as id,
            login,
            firstname,
            lastname,
            email,
            office_phone,
            user_mobile,
            admin,
            employee,
            job,
            statut,
            NULL as employee_category
           FROM \`nmy5_user\`
           WHERE statut = 1`
        );
      }
      const approvedRequests = await listAccessRequestsFromMySql("approved");
      const requestByEmail = new Map<string, AccessRequestRecord>();
      const requestByLogin = new Map<string, AccessRequestRecord>();
      for (const r of approvedRequests) {
        const emailKey = normalizeEmail(r.email || "");
        const loginKey = normalizeLoginKey(emailKey.split("@")[0] || "");
        if (emailKey && !requestByEmail.has(emailKey)) {
          requestByEmail.set(emailKey, r);
        }
        if (loginKey && !requestByLogin.has(loginKey)) {
          requestByLogin.set(loginKey, r);
        }
      }

      const mappedByScope = new Map<string, Record<string, unknown>>();
      for (const row of userRows || []) {
        const email = normalizeEmail(String(row.email || ""));
        const loginKey = normalizeLoginKey(String(row.login || ""));
        
        // Find matching access request to get company assignments
        const request = (email && requestByEmail.get(email)) || (loginKey && requestByLogin.get(loginKey)) || null;
        if (!request) continue;

        const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
        if (!assignedCompanyIds.length) continue;
        if (companyId && !assignedCompanyIds.includes(companyId)) continue;

        const firstName = normalizeWhitespace(String(row.firstname || ""));
        const lastName = normalizeWhitespace(String(row.lastname || ""));
        const displayName =
          normalizeWhitespace(request.name) ||
          normalizeWhitespace(`${firstName} ${lastName}`) ||
          normalizeWhitespace(String(row.login || "")) ||
          email ||
          "Employee";
        if (isLegacyDemoProfileName(displayName)) continue;

        // Dolibarr's admin flag is authoritative. Employee profile metadata must
        // never downgrade an administrator into the attendance roster.
        let role: string = Number(row.admin || 0) === 1 ? "admin" : "employee";
        if (role !== "admin" && row.employee_category === "on_field") {
          role = "salesperson";
        } else if (role !== "admin" && row.employee_category === "fixed_location") {
          role = "employee";
        } else if (role !== "admin") {
          // Fallback: decide from job title or the approved access request.
          let mappedRole: string | null = null;
          if (!mappedRole && row.job) {
            const jobStr = String(row.job).toLowerCase();
            if (jobStr.includes("on field") || jobStr.includes("sales")) {
              mappedRole = "salesperson";
            } else if (jobStr.includes("fixed") || jobStr.includes("office") || jobStr.includes("support") || jobStr.includes("hr")) {
              mappedRole = "employee";
            }
          }
          role = mappedRole || request.approvedRole || request.requestedRole || "salesperson";
        }
        const finalRole = normalizeRole(role);
        const employeeCategory =
          finalRole === "admin" ? null : isSalesRole(finalRole) ? "on_field" : "fixed_location";

        const targetCompanyIds = companyId ? [companyId] : assignedCompanyIds;
        for (const assignedCompanyId of targetCompanyIds) {
          const company = companyById.get(assignedCompanyId);
          const id = row.id || `access_${request.id}`;
          const key = `${assignedCompanyId}:${email || String(id) || displayName.toLowerCase()}`;
          mappedByScope.set(key, {
            id: String(id),
            rowid: row.id ? String(row.id) : undefined,
            user_id: row.id ? String(row.id) : undefined,
            login: normalizeWhitespace(String(row.login || email.split("@")[0] || "")),
            firstname: firstName || displayName.split(" ")[0] || "",
            lastname: lastName || displayName.split(" ").slice(1).join(" ") || "",
            name: displayName,
            email,
            phone: normalizeWhitespace(String(row.user_mobile || row.office_phone || "")),
            town: "",
            address: "",
            zip: "",
            statut: row.statut ?? 1,
            status: row.statut ?? 1,
            companyId: assignedCompanyId,
            companyName:
              company?.name ||
              (assignedCompanyId === requestUser?.companyId ? requestUser?.companyName : "") ||
              request.requestedCompanyName ||
              assignedCompanyId,
            assignedCompanyIds,
            admin: Number(row.admin || 0),
            employee: Number(row.employee || 0),
            employeeCategory,
            employee_category: employeeCategory,
            role: finalRole,
            department: normalizeDepartmentForRole(finalRole, request.requestedDepartment || row.job),
            branch:
              normalizeWhitespace(request.requestedBranch || "") ||
              company?.primaryBranch ||
              requestUser?.branch ||
              "Main Branch",
            managerId: request.assignedManagerId || undefined,
            managerName: request.assignedManagerName || undefined,
            stockistId: request.assignedStockistId || undefined,
            stockistName: request.assignedStockistName || undefined,
          });
        }
      }

      res.json({ items: Array.from(mappedByScope.values()) });
    } catch (e) {
      res.json({ items: [] });
    }
  });

  // POST /api/collective-leaves
  app.post("/api/collective-leaves", requireAuth, populateUser, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        return res.status(403).json({ message: "Unauthorized" });
      }
      const body = req.body || {};
      const userIds = Array.isArray(body.userIds) ? body.userIds : [];
      if (userIds.length === 0) return res.status(400).json({ message: "No users selected" });

      const startDate = body.startDate || "";
      const endDate = body.endDate || startDate;
      const startAmPm = body.startAmPm || "morning";
      const endAmPm = body.endAmPm || "afternoon";
      const fkType = body.leaveType === "unplanned" ? 4 : 1;
      const note = (body.note || "").slice(0, 2000);
      const fkValidator = Number(body.approvedBy) || 1;
      const autoValidate = Boolean(body.autoValidate);
      const statut = autoValidate ? 3 : 2;
      
      let halfday = 0;
      if (startAmPm === "morning" && endAmPm === "afternoon") halfday = 0;
      else if (startAmPm === "afternoon" && endAmPm === "afternoon") halfday = 1;
      else if (startAmPm === "morning" && endAmPm === "morning") halfday = 2;
      else if (startAmPm === "afternoon" && endAmPm === "morning") halfday = 3;

      let insertedCount = 0;
      for (const uid of userIds) {
        const provRef = "(PROV" + Math.floor(Math.random() * 1000000) + ")";
        await conn.execute(
          "INSERT INTO \`nmy5_holiday\` (ref, entity, fk_user, fk_user_create, fk_validator, fk_type, date_create, date_debut, date_fin, halfday, statut, description, nb_open_day) VALUES (?, 1, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, 1)",
          [provRef, Number(uid), requestUser?.id ? Number(requestUser.id) : null, fkValidator, fkType, startDate, endDate, halfday, statut, note]
        );
        insertedCount++;
      }
      res.status(201).json({ ok: true, count: insertedCount });
    } catch (error) {
      console.error("[Collective Leave Error]:", error);
      res.status(500).json({ message: "Failed to create collective leaves" });
    }
  });

// POST /api/leaves
  app.post("/api/leaves", requireAuth, populateUser, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      return res.status(503).json({ message: "MySQL is not configured." });
    }
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const body = req.body || {};
      
      const userEmail = body.userEmail ? String(body.userEmail).trim() : requestUser?.email || "";
      const userName = body.userName ? String(body.userName).trim() : requestUser?.name || "";
      const leaveDate = body.leaveDate ? String(body.leaveDate).trim() : "";
      const leaveEndDate = body.leaveEndDate ? String(body.leaveEndDate).trim() : leaveDate;
      const leaveType = body.leaveType === "unplanned" ? "unplanned" : "planned";
      const note = body.note ? String(body.note).trim().slice(0, 2000) : "";
      
      const startAmPm = body.startAmPm || "morning";
      const endAmPm = body.endAmPm || "afternoon";
      const fkValidator = Number(body.approvedBy) || 1;
      
      let halfday = 0;
      if (startAmPm === "morning" && endAmPm === "afternoon") halfday = 0;
      else if (startAmPm === "afternoon" && endAmPm === "afternoon") halfday = 1;
      else if (startAmPm === "morning" && endAmPm === "morning") halfday = 2;
      else if (startAmPm === "afternoon" && endAmPm === "morning") halfday = 3;

      const [uRows] = await conn.query("SELECT rowid FROM \`nmy5_user\` WHERE email = ? LIMIT 1", [userEmail]);
      if (!uRows || uRows.length === 0) {
        return res.status(400).json({ message: "User not linked to Dolibarr." });
      }
      const fkUser = uRows[0].rowid;
      const fkType = leaveType === "unplanned" ? 4 : 1;
      const provRef = "(PROV" + Math.floor(Math.random() * 1000000) + ")";

      const [insertRes] = await conn.execute(
        "INSERT INTO \`nmy5_holiday\` (ref, entity, fk_user, fk_user_create, fk_validator, fk_type, date_create, date_debut, date_fin, halfday, statut, description, nb_open_day) VALUES (?, 1, ?, ?, ?, ?, NOW(), ?, ?, ?, 2, ?, 1)",
        [provRef, fkUser, fkUser, fkValidator, fkType, leaveDate, leaveEndDate, halfday, note]
      );
      
      const rowid = (insertRes as any).insertId;

      res.status(201).json({
        id: String(rowid),
        companyId: null,
        userId: String(requestUser?.id || fkUser),
        userName,
        userEmail,
        leaveDate,
        leaveEndDate,
        leaveType,
        isHalfDay: halfday !== 0,
        leaveDays: 1,
        note,
        status: "pending",
        reviewedById: null,
        reviewedByName: null,
        reviewedAt: null,
        reviewComment: null,
        dolibarrHolidayId: rowid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[Leave POST Error]:", error);
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ message: "Unable to create leave request. DB ERROR: " + msg });
    }
  });

  // PUT /api/leaves/:id/status
  app.put("/api/leaves/:id/status", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const body = req.body || {};
      const newStatut = body.status === "approved" ? 3 : 5;
      const leaveId = req.params.id;
      
      await conn.execute("UPDATE \`nmy5_holiday\` SET statut = ? WHERE rowid = ?", [newStatut, leaveId]);

      res.json({ id: leaveId, status: body.status, ok: true });
    } catch (error) {
      res.status(500).json({ message: "Unable to update status." });
    }
  });

  // DELETE /api/leaves/:id
  app.delete("/api/leaves/:id", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const leaveId = req.params.id;
      await conn.execute("DELETE FROM \`nmy5_holiday\` WHERE rowid = ?", [leaveId]);
      res.json({ id: leaveId, ok: true });
    } catch (error) {
      res.status(500).json({ message: "Unable to delete request." });
    }
  });

  // GET /api/leaves/summary
  app.get("/api/leaves/summary", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query(`
        SELECT 
          u.email as userId,
          CONCAT(u.firstname, ' ', u.lastname) as userName,
          SUM(IF(h.fk_type = 1 AND h.statut = 3, h.nb_open_day, 0)) as totalPlannedMonth,
          SUM(IF(h.fk_type = 4 AND h.statut = 3, h.nb_open_day, 0)) as totalUnplannedMonth,
          SUM(IF(h.statut = 3, h.nb_open_day, 0)) as totalLeavesMonth
        FROM \`nmy5_holiday\` h
        JOIN \`nmy5_user\` u ON h.fk_user = u.rowid
        WHERE MONTH(h.date_debut) = ? AND YEAR(h.date_debut) = ?
        GROUP BY u.rowid
      `, [req.query.month || new Date().getMonth() + 1, req.query.year || new Date().getFullYear()]);
      res.json({ items: rows });
    } catch (error) {
      res.json({ items: [] });
    }
  });

  // GET /api/public-holidays
  app.get("/api/public-holidays", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query("SELECT id, day, month, year, code, code as dayRule FROM `nmy5_c_hrm_public_holiday`");
      res.json({ items: rows });
    } catch (error) {
      console.error("[GET /api/public-holidays] Error:", error);
      res.json({ items: [] });
    }
  });

  // POST /api/public-holidays
  app.post("/api/public-holidays", requireAuth, populateUser, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        res.status(403).json({ message: "Unauthorized" });
        return;
      }
      const body = req.body || {};
      console.log("[POST /api/public-holidays] received body:", body);
      
      // Use ON DUPLICATE KEY UPDATE to handle the unique constraint uk_c_hrm_public_holiday
      const [insertRes] = await conn.execute(
        "INSERT INTO `nmy5_c_hrm_public_holiday` (day, month, year, code) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE month = VALUES(month), year = VALUES(year)",
        [body.day, body.month, body.year || 0, body.code || ""]
      );

      // Create and dispatch a broadcast notification to all users
      const holidayDate = `${body.day}/${body.month}/${body.year || new Date().getFullYear()}`;
      const notifId = `holiday_declared_${insertRes.insertId}_${Date.now()}`;
      const notification: AppNotification = {
        id: notifId,
        title: "Public Holiday Declared",
        body: `Admin ${requestUser.name || "Admin"} has declared ${holidayDate} as a Public Holiday.`,
        kind: "announcement" as const,
        audience: "all" as const,
        audienceUserIds: [],
        readByIds: [],
        createdById: requestUser.id,
        createdByName: requestUser.name || "Admin",
        createdAt: new Date().toISOString(),
      };

      try {
        await insertNotificationInMySql(notification);
      } catch (err: any) {
        console.error("Failed to insert public holiday notification:", err);
      }

      res.status(201).json({ id: insertRes.insertId, ...body });
    } catch (error: any) {
      console.error("[POST /api/public-holidays] INSERT FAILED:", error);
      res.status(500).json({ message: `Unable to add holiday: ${error.message}` });
    }
  });

  // DELETE /api/public-holidays/:id
  app.delete("/api/public-holidays/:id", requireAuth, populateUser, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        res.status(403).json({ message: "Unauthorized" });
        return;
      }
      console.log("[DELETE /api/public-holidays] deleting id:", req.params.id);
      const [result] = await conn.execute("DELETE FROM `nmy5_c_hrm_public_holiday` WHERE id = ?", [req.params.id]);
      console.log("[DELETE /api/public-holidays] result:", result);
      res.json({ id: req.params.id, ok: true });
    } catch (error: any) {
      console.error("[DELETE /api/public-holidays] FAILED:", error);
      res.status(500).json({ message: `Unable to delete holiday: ${error.message}` });
    }
  });

  // GET /api/weekend-config
  app.get("/api/weekend-config", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query("SELECT weekend_days FROM lff_companies LIMIT 1");
      if (rows && rows.length > 0 && rows[0].weekend_days) {
        res.json({ weekendDays: JSON.parse(rows[0].weekend_days) });
      } else {
        res.json({ weekendDays: [0] });
      }
    } catch (error) {
      res.json({ weekendDays: [0] });
    }
  });

  // POST /api/weekend-config
  app.post("/api/weekend-config", requireAuth, populateUser, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        res.status(403).json({ message: "Unauthorized" });
        return;
      }
      const body = req.body || {};
      const weekendDays = Array.isArray(body.weekendDays) ? body.weekendDays : [0];
      
      // Update all rows in lff_companies (usually just 1 tenant row)
      await conn.execute("UPDATE lff_companies SET weekend_days = ?", [JSON.stringify(weekendDays)]);
      
      res.json({ weekendDays, ok: true });
    } catch (error) {
      console.error("Weekend save error", error);
      res.status(500).json({ message: "Unable to update weekend config" });
    }
  });


}
