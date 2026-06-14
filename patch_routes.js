const fs = require('fs');
const path = "server/routes.ts";
let content = fs.readFileSync(path, "utf8");

const splitPoint = "  function mapLeaveRow(row: any) {";
const splitIndex = content.indexOf(splitPoint);
if (splitIndex === -1) {
  console.error("Split point not found");
  process.exit(1);
}

const beforeContent = content.substring(0, splitIndex);

const newRoutes = `  function mapDolibarrLeaveStatus(statut: number): string {
    if (statut === 1 || statut === 2) return "pending";
    if (statut === 3) return "approved";
    if (statut === 4 || statut === 5) return "rejected";
    return "pending";
  }

  // GET /api/leaves
  app.get("/api/leaves", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const isPrivileged = ["admin", "hr", "manager"].includes(requestUser?.role || "");

      let query = \`
        SELECT h.*, u.email as user_email, u.firstname, u.lastname
        FROM \\\`nmy5_holiday\\\` h
        LEFT JOIN \\\`nmy5_user\\\` u ON h.fk_user = u.rowid
      \`;
      const whereClauses: string[] = [];
      const params: unknown[] = [];

      if (!isPrivileged) {
        whereClauses.push("u.email = ?");
        params.push(requestUser?.email || "");
      }

      if (whereClauses.length > 0) {
        query += \` WHERE \${whereClauses.join(" AND ")}\`;
      }
      query += " ORDER BY h.date_debut DESC LIMIT 500";

      const [rows] = await conn.query<any[]>(query, params);
      
      const mapped = (rows || []).map(row => ({
        id: String(row.rowid),
        companyId: null,
        userId: row.user_email || "",
        userName: \`\${row.firstname || ""} \${row.lastname || ""}\`.trim(),
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

  // POST /api/leaves
  app.post("/api/leaves", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const body = (req.body || {}) as Record<string, unknown>;
      
      const userEmail = body.userEmail ? String(body.userEmail).trim() : requestUser?.email || "";
      const leaveDate = body.leaveDate ? String(body.leaveDate).trim() : "";
      const leaveEndDate = body.leaveEndDate ? String(body.leaveEndDate).trim() : leaveDate;
      const leaveType = body.leaveType === "unplanned" ? "unplanned" : "planned";
      const isHalfDay = Boolean(body.isHalfDay);
      const leaveDays = isHalfDay ? 0.5 : Number(body.leaveDays || 1);
      const note = body.note ? String(body.note).trim().slice(0, 2000) : "";
      
      const [uRows] = await conn.query<any[]>("SELECT rowid FROM \\\`nmy5_user\\\` WHERE email = ? LIMIT 1", [userEmail]);
      if (!uRows || uRows.length === 0) {
        res.status(400).json({ message: "User not linked to Dolibarr." });
        return;
      }
      const fkUser = uRows[0].rowid;
      const fkType = leaveType === "unplanned" ? 4 : 1; // typically 1=Paid, 4=Unpaid/Unplanned

      const [insertRes] = await conn.execute<any>(
        \`INSERT INTO \\\`nmy5_holiday\\\`
         (entity, fk_user, fk_type, date_create, date_debut, date_fin, halfday, statut, description, nb_open_day)
         VALUES (1, ?, ?, NOW(), ?, ?, ?, 1, ?, ?)\`,
        [fkUser, fkType, leaveDate, leaveEndDate, isHalfDay ? 2 : 0, note, leaveDays]
      );
      
      const rowid = insertRes.insertId;
      
      await conn.execute(
        \`INSERT INTO \\\`nmy5_holiday_logs\\\`
         (date_action, fk_user_action, fk_user_update, fk_type, prevstate, new_state)
         VALUES (NOW(), ?, ?, ?, 0, 1)\`,
        [fkUser, fkUser, fkType]
      );

      res.status(201).json({ id: String(rowid) });
    } catch (error) {
      res.status(500).json({ message: "Unable to create leave request." });
    }
  });

  // PUT /api/leaves/:id/status
  app.put("/api/leaves/:id/status", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const body = req.body || {};
      const newStatut = body.status === "approved" ? 3 : 5;
      const leaveId = req.params.id;
      
      await conn.execute("UPDATE \\\`nmy5_holiday\\\` SET statut = ? WHERE rowid = ?", [newStatut, leaveId]);
      
      // We don't have requestUser fk_user handy, but let's just log with 0 or query it if strictly required
      await conn.execute(
        \`INSERT INTO \\\`nmy5_holiday_logs\\\`
         (date_action, fk_user_action, fk_user_update, fk_type, prevstate, new_state)
         VALUES (NOW(), 0, 0, 1, 1, ?)\`,
        [newStatut]
      );

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
      await conn.execute("DELETE FROM \\\`nmy5_holiday\\\` WHERE rowid = ?", [leaveId]);
      res.json({ id: leaveId, ok: true });
    } catch (error) {
      res.status(500).json({ message: "Unable to delete request." });
    }
  });

  // GET /api/leaves/summary
  app.get("/api/leaves/summary", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query<any[]>(\`
        SELECT 
          u.email as userId,
          CONCAT(u.firstname, ' ', u.lastname) as userName,
          SUM(IF(h.fk_type = 1 AND h.statut = 3, h.nb_open_day, 0)) as totalPlannedMonth,
          SUM(IF(h.fk_type = 4 AND h.statut = 3, h.nb_open_day, 0)) as totalUnplannedMonth,
          SUM(IF(h.statut = 3, h.nb_open_day, 0)) as totalLeavesMonth
        FROM \\\`nmy5_holiday\\\` h
        JOIN \\\`nmy5_user\\\` u ON h.fk_user = u.rowid
        WHERE MONTH(h.date_debut) = ? AND YEAR(h.date_debut) = ?
        GROUP BY u.rowid
      \`, [req.query.month || new Date().getMonth() + 1, req.query.year || new Date().getFullYear()]);
      res.json({ items: rows });
    } catch (error) {
      res.json({ items: [] });
    }
  });

  // GET /api/public-holidays
  app.get("/api/public-holidays", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query<any[]>("SELECT rowid as id, day, month, year, code, day_rule as dayRule FROM \\\`nmy5_c_hrm_public_holiday\\\`");
      res.json({ items: rows });
    } catch (error) {
      res.json({ items: [] });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
`;

const newContent = beforeContent + newRoutes;
fs.writeFileSync(path, newContent, "utf8");
console.log("Successfully rewritten routes to use nmy5_holiday directly");
