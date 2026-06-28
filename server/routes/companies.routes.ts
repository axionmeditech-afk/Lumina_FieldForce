import type { Express } from "express";
import type { CompanyProfile } from "@/lib/types";

export type CompanyRouteDeps = Record<string, any>;

export function registerCompanyRoutes(app: Express, deps: CompanyRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    listCompaniesFromMySql,
    normalizeWhitespace,
    ensureCompaniesTableInMySql,
    getMySqlPool,
    companyProfileFromRow,
    upsertCompanyProfileInMySql,
    normalizeCompanyProfilePayload,
    getCompanyIdFromName,
    randomUUID,
    persistCompaniesLegacyStateFromMySql,
    firstString,
    listCompanyProfilesFromMySqlRaw,
    rehomeLegacyCompanyDataToMySql,
    deleteCompanyScopedRowsInMySql,
  } = deps;

  app.get("/api/companies", requireAuth, async (_req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "Company database storage is not configured." });
      return;
    }
    try {
      res.json(await listCompaniesFromMySql());
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to load companies: ${error.message}`
            : "Unable to load companies.",
      });
    }
  });

  app.post("/api/companies", requireAuth, requireRoles("admin"), async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "Company database storage is not configured." });
      return;
    }
    const body = (req.body || {}) as Partial<CompanyProfile>;
    const requestedName = normalizeWhitespace(typeof body.name === "string" ? body.name : "");
    if (!requestedName) {
      res.status(400).json({ message: "Company name is required." });
      return;
    }
    try {
      await ensureCompaniesTableInMySql();
      const conn = await getMySqlPool();
      const [existingRows] = await conn.query(
        `SELECT id, name, legal_name, industry, headquarters, primary_branch, support_email,
                support_phone, attendance_zone_label, created_at, updated_at
         FROM lff_companies
         WHERE LOWER(TRIM(name)) = ?
         LIMIT 1`,
        [requestedName.toLowerCase()]
      );
      if (existingRows && existingRows.length > 0) {
        res.status(200).json(companyProfileFromRow(existingRows[0]));
        return;
      }
      const nowIso = new Date().toISOString();
      const created = await upsertCompanyProfileInMySql(
        normalizeCompanyProfilePayload({
          ...body,
          id: `${getCompanyIdFromName(requestedName)}_${randomUUID().slice(0, 8)}`,
          name: requestedName,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
      );
      await persistCompaniesLegacyStateFromMySql();
      res.status(201).json(created);
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to create company: ${error.message}`
            : "Unable to create company.",
      });
    }
  });

  app.post("/api/companies/:id/rehome-legacy-data", requireAuth, requireRoles("admin"), async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "Company database storage is not configured." });
      return;
    }
    const companyId = normalizeWhitespace(firstString(req.params.id));
    if (!companyId) {
      res.status(400).json({ message: "Company id is required." });
      return;
    }
    try {
      const companies = await listCompanyProfilesFromMySqlRaw();
      const targetCompany = companies.find((company: any) => company.id === companyId);
      if (!targetCompany) {
        res.status(404).json({ message: "Company not found." });
        return;
      }
      await rehomeLegacyCompanyDataToMySql(targetCompany, companies);
      await persistCompaniesLegacyStateFromMySql();
      res.json({
        ok: true,
        companyId: targetCompany.id,
        companyName: targetCompany.name,
      });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to assign legacy data to company: ${error.message}`
            : "Unable to assign legacy data to company.",
      });
    }
  });

  app.put("/api/companies/:id", requireAuth, requireRoles("admin"), async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "Company database storage is not configured." });
      return;
    }
    const companyId = normalizeWhitespace(firstString(req.params.id));
    if (!companyId) {
      res.status(400).json({ message: "Company id is required." });
      return;
    }
    try {
      const companies = await listCompaniesFromMySql();
      const current = companies.find((company: any) => company.id === companyId);
      if (!current) {
        res.status(404).json({ message: "Company not found." });
        return;
      }
      const updated = await upsertCompanyProfileInMySql(
        normalizeCompanyProfilePayload({
          ...current,
          ...((req.body || {}) as Partial<CompanyProfile>),
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: new Date().toISOString(),
        })
      );
      await persistCompaniesLegacyStateFromMySql();
      res.json(updated);
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to update company: ${error.message}`
            : "Unable to update company.",
      });
    }
  });

  app.delete("/api/companies/:id", requireAuth, requireRoles("admin"), async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "Company database storage is not configured." });
      return;
    }
    const companyId = normalizeWhitespace(firstString(req.params.id));
    if (!companyId) {
      res.status(400).json({ message: "Company id is required." });
      return;
    }
    try {
      const companies = await listCompaniesFromMySql();
      if (!companies.some((company: any) => company.id === companyId)) {
        res.status(404).json({ message: "Company not found." });
        return;
      }
      if (companies.length <= 1) {
        res.status(400).json({ message: "At least one company environment is required." });
        return;
      }
      const fallbackCompany = companies.find((company: any) => company.id !== companyId);
      if (!fallbackCompany) {
        res.status(400).json({ message: "A fallback company is required before deletion." });
        return;
      }
      await deleteCompanyScopedRowsInMySql(companyId, fallbackCompany);
      const conn = await getMySqlPool();
      await conn.execute(`DELETE FROM lff_companies WHERE id = ?`, [companyId]);
      await persistCompaniesLegacyStateFromMySql();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to delete company: ${error.message}`
            : "Unable to delete company.",
      });
    }
  });


}
