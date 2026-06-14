const fs = require('fs');
const path = "server/routes.ts";
let content = fs.readFileSync(path, "utf8");

// 1. Add column ensuring logic to ensureCompaniesTableInMySql
content = content.replace(
  "companiesTableEnsured = true;",
  "try { await conn.execute(\"ALTER TABLE lff_companies ADD COLUMN weekend_days VARCHAR(255) DEFAULT '[0]'\"); } catch(e) {}\n  companiesTableEnsured = true;"
);

// 2. Replace GET /api/weekend-config
const getRegex = /\/\/ GET \/api\/weekend-config\n  app\.get\("\/api\/weekend-config".*?\}\n  \}\);\n/s;
const newGet = `// GET /api/weekend-config
  app.get("/api/weekend-config", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const [rows] = await conn.query<any[]>("SELECT weekend_days FROM lff_companies LIMIT 1");
      if (rows && rows.length > 0 && rows[0].weekend_days) {
        res.json({ weekendDays: JSON.parse(rows[0].weekend_days) });
      } else {
        res.json({ weekendDays: [0] });
      }
    } catch (error) {
      res.json({ weekendDays: [0] });
    }
  });
`;
content = content.replace(getRegex, newGet);

// 3. Replace POST /api/weekend-config
const postRegex = /\/\/ POST \/api\/weekend-config\n  app\.post\("\/api\/weekend-config".*?\}\n  \}\);\n/s;
const newPost = `// POST /api/weekend-config
  app.post("/api/weekend-config", requireAuth, async (req, res) => {
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
`;
content = content.replace(postRegex, newPost);

fs.writeFileSync(path, content, "utf8");
console.log("Weekend DB Logic patched to use lff_companies!");
