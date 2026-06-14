const fs = require('fs');
const path = "server/routes.ts";
let content = fs.readFileSync(path, "utf8");

const newEndpoints = `
  // GET /api/users
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query("SELECT rowid as id, firstname, lastname, email FROM \\\`nmy5_user\\\` WHERE statut = 1");
      const mapped = rows.map((r) => ({
        id: String(r.id),
        name: \`\${r.firstname || ""} \${r.lastname || ""}\`.trim(),
        email: r.email || ""
      }));
      res.json({ items: mapped });
    } catch (e) {
      res.json({ items: [] });
    }
  });

  // POST /api/collective-leaves
  app.post("/api/collective-leaves", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = req.user;
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
      const fkValidator = Number(body.approvedBy) || 0;
      const autoValidate = Boolean(body.autoValidate);
      const statut = autoValidate ? 3 : 1;
      
      let halfday = 0;
      if (startAmPm === "morning" && endAmPm === "afternoon") halfday = 0;
      else if (startAmPm === "afternoon" && endAmPm === "afternoon") halfday = 1;
      else if (startAmPm === "morning" && endAmPm === "morning") halfday = 2;
      else if (startAmPm === "afternoon" && endAmPm === "morning") halfday = 3;

      let insertedCount = 0;
      for (const uid of userIds) {
        const provRef = "(PROV" + Math.floor(Math.random() * 1000000) + ")";
        await conn.execute(
          "INSERT INTO \\\`nmy5_holiday\\\` (ref, entity, fk_user, fk_user_create, fk_user_valid, fk_type, date_create, date_debut, date_fin, halfday, statut, description, nb_open_day) VALUES (?, 1, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, 1)",
          [provRef, Number(uid), 0, fkValidator, fkType, startDate, endDate, halfday, statut, note]
        );
        insertedCount++;
      }
      res.status(201).json({ ok: true, count: insertedCount });
    } catch (error) {
      console.error("[Collective Leave Error]:", error);
      res.status(500).json({ message: "Failed to create collective leaves" });
    }
  });
`;

if (!content.includes('app.get("/api/users"')) {
  const insertIndex = content.indexOf('// POST /api/leaves');
  if (insertIndex > -1) {
    content = content.slice(0, insertIndex) + newEndpoints + "\n" + content.slice(insertIndex);
  }
}

const postLeavesRegex = /\/\/ POST \/api\/leaves\n  app\.post\("\/api\/leaves".*?res\.status\(500\)\.json\(\{ message: "Unable to create leave request.*?\}\n  \}\);\n/s;

const newPostLeaves = `// POST /api/leaves
  app.post("/api/leaves", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      return res.status(503).json({ message: "MySQL is not configured." });
    }
    try {
      const conn = await getMySqlPool();
      const requestUser = req.user;
      const body = req.body || {};
      
      const userEmail = body.userEmail ? String(body.userEmail).trim() : requestUser?.email || "";
      const userName = body.userName ? String(body.userName).trim() : requestUser?.name || "";
      const leaveDate = body.leaveDate ? String(body.leaveDate).trim() : "";
      const leaveEndDate = body.leaveEndDate ? String(body.leaveEndDate).trim() : leaveDate;
      const leaveType = body.leaveType === "unplanned" ? "unplanned" : "planned";
      const note = body.note ? String(body.note).trim().slice(0, 2000) : "";
      
      const startAmPm = body.startAmPm || "morning";
      const endAmPm = body.endAmPm || "afternoon";
      const fkValidator = Number(body.approvedBy) || 0;
      
      let halfday = 0;
      if (startAmPm === "morning" && endAmPm === "afternoon") halfday = 0;
      else if (startAmPm === "afternoon" && endAmPm === "afternoon") halfday = 1;
      else if (startAmPm === "morning" && endAmPm === "morning") halfday = 2;
      else if (startAmPm === "afternoon" && endAmPm === "morning") halfday = 3;

      const [uRows] = await conn.query("SELECT rowid FROM \\\`nmy5_user\\\` WHERE email = ? LIMIT 1", [userEmail]);
      if (!uRows || uRows.length === 0) {
        return res.status(400).json({ message: "User not linked to Dolibarr." });
      }
      const fkUser = uRows[0].rowid;
      const fkType = leaveType === "unplanned" ? 4 : 1;
      const provRef = "(PROV" + Math.floor(Math.random() * 1000000) + ")";

      const [insertRes] = await conn.execute(
        "INSERT INTO \\\`nmy5_holiday\\\` (ref, entity, fk_user, fk_user_create, fk_user_valid, fk_type, date_create, date_debut, date_fin, halfday, statut, description, nb_open_day) VALUES (?, 1, ?, ?, ?, ?, NOW(), ?, ?, ?, 1, ?, 1)",
        [provRef, fkUser, fkUser, fkValidator, fkType, leaveDate, leaveEndDate, halfday, note]
      );
      
      const rowid = insertRes.insertId;

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
`;

content = content.replace(postLeavesRegex, newPostLeaves);
fs.writeFileSync(path, content, "utf8");
console.log("Routes patched successfully");
