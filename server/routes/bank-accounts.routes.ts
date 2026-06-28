import type { Express } from "express";
import type { AppUser } from "@/lib/types";

export type BankAccountRouteDeps = Record<string, any>;

export function registerBankAccountRoutes(app: Express, deps: BankAccountRouteDeps) {
  const {
    requireAuth,
    populateUser,
    isMySqlStateEnabled,
    ensureBankAccountsTable,
    getMySqlPool,
    resolveRequestCompanyId,
    mapBankAccountRow,
    toNullableText,
    randomUUID,
    toSqlTimestamp,
    firstString,
  } = deps;

  app.get("/api/bank-accounts", requireAuth, populateUser, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      await ensureBankAccountsTable();
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const companyId = await resolveRequestCompanyId(req);
      const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId.trim().toLowerCase() : "";
      const employeeEmail =
        typeof req.query.employeeEmail === "string" ? req.query.employeeEmail.trim().toLowerCase() : "";
      const employeeName =
        typeof req.query.employeeName === "string" ? req.query.employeeName.trim().toLowerCase() : "";
      const employeeIdAlt =
        employeeId && employeeId.startsWith("dolibarr_")
          ? employeeId.replace("dolibarr_", "")
          : employeeId
            ? `dolibarr_${employeeId}`
            : "";

      let query = "SELECT * FROM `lff_bank_accounts`";
      const params: unknown[] = [];
      const accessClauses: string[] = [];
      const filterClauses: string[] = [];
      // Non-admin/hr/manager users can only see their own accounts
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        const ownAccessClauses: string[] = [];
        const ownAccessParams: unknown[] = [];
        const requestEmail = (requestUser?.email || "").trim().toLowerCase();
        const requestId = (requestUser?.id || "").trim().toLowerCase();
        const requestName = (requestUser?.name || "").trim().toLowerCase();
        if (requestEmail) {
          ownAccessClauses.push("LOWER(TRIM(employee_email)) = ?");
          ownAccessParams.push(requestEmail);
        }
        if (requestId) {
          ownAccessClauses.push("LOWER(TRIM(employee_id)) = ?");
          ownAccessParams.push(requestId);
        }
        if (requestName) {
          ownAccessClauses.push("LOWER(TRIM(employee_name)) = ?");
          ownAccessParams.push(requestName);
        }
        if (ownAccessClauses.length > 0) {
          accessClauses.push(`(${ownAccessClauses.join(" OR ")})`);
          params.push(...ownAccessParams);
        }
      }
      if (employeeEmail) {
        filterClauses.push("LOWER(TRIM(employee_email)) = ?");
        params.push(employeeEmail);
      }
      if (employeeName) {
        filterClauses.push("LOWER(TRIM(employee_name)) = ?");
        params.push(employeeName);
      }
      if (employeeId) {
        const idClauses = ["LOWER(TRIM(employee_id)) = ?"];
        const idParams: unknown[] = [employeeId];
        if (employeeIdAlt && employeeIdAlt !== employeeId) {
          idClauses.push("LOWER(TRIM(employee_id)) = ?");
          idParams.push(employeeIdAlt);
        }
        filterClauses.push(`(${idClauses.join(" OR ")})`);
        params.push(...idParams);
      }
      const whereClauses: string[] = [];
      if (accessClauses.length > 0) {
        whereClauses.push(...accessClauses);
      }
      if (filterClauses.length > 0) {
        whereClauses.push(`(${filterClauses.join(" OR ")})`);
      }
      if (companyId) {
        whereClauses.push("company_id = ?");
        params.push(companyId);
      }
      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(" AND ")}`;
      }
      query += " ORDER BY updated_at DESC";
      const [rows] = await conn.query(query, params);
      res.json({ items: (rows || []).map(mapBankAccountRow) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to fetch bank accounts.";
      res.status(500).json({ message });
    }
  });

  app.post("/api/bank-accounts", requireAuth, populateUser, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    try {
      await ensureBankAccountsTable();
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const body = (req.body || {}) as Record<string, unknown>;
      const companyId = toNullableText(body.companyId) || (await resolveRequestCompanyId(req));
      const id = body.id ? String(body.id).trim() : randomUUID();
      const employeeId = body.employeeId ? String(body.employeeId).trim() : "";
      const employeeName = body.employeeName ? String(body.employeeName).trim() : "";
      const employeeEmail = body.employeeEmail ? String(body.employeeEmail).trim() : requestUser?.email || "";
      const accountType = body.accountType ? String(body.accountType).trim() : "bank";
      const dolibarrRef = body.dolibarrRef ? String(body.dolibarrRef).trim() : null;
      const dolibarrLabel = body.dolibarrLabel ? String(body.dolibarrLabel).trim() : null;
      const dolibarrType =
        body.dolibarrType === "savings" || body.dolibarrType === "cash" ? String(body.dolibarrType) : "current";
      const currencyCode = body.currencyCode ? String(body.currencyCode).trim().toUpperCase() : "INR";
      const countryCode = body.countryCode ? String(body.countryCode).trim().toUpperCase() : "IN";
      const parsedCountryId =
        typeof body.countryId === "number" ? body.countryId : Number(String(body.countryId || ""));
      const countryId = Number.isFinite(parsedCountryId) && parsedCountryId > 0 ? Math.trunc(parsedCountryId) : 117;
      const status = body.status === "closed" ? "closed" : "open";
      const bankName = body.bankName ? String(body.bankName).trim() : null;
      const bankAddress = body.bankAddress ? String(body.bankAddress).trim() : null;
      const accountNumber = body.accountNumber ? String(body.accountNumber).trim() : null;
      const ifscCode = body.ifscCode ? String(body.ifscCode).trim() : null;
      const upiId = body.upiId ? String(body.upiId).trim() : null;
      const holderName = body.holderName ? String(body.holderName).trim() : null;
      const website = body.website ? String(body.website).trim() : null;
      const comment = body.comment ? String(body.comment).trim() : null;
      const isDefault = body.isDefault ? 1 : 0;
      const now = toSqlTimestamp(new Date());
      await conn.execute(
        `INSERT INTO \`lff_bank_accounts\`
          (\`id\`, \`company_id\`, \`employee_id\`, \`employee_name\`, \`employee_email\`, \`account_type\`, \`dolibarr_ref\`, \`dolibarr_label\`, \`dolibarr_type\`, \`currency_code\`, \`country_code\`, \`country_id\`, \`status\`, \`bank_name\`, \`bank_address\`, \`account_number\`, \`ifsc_code\`, \`upi_id\`, \`holder_name\`, \`website\`, \`comment\`, \`is_default\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           \`company_id\` = VALUES(\`company_id\`),
           \`dolibarr_ref\` = VALUES(\`dolibarr_ref\`),
           \`dolibarr_label\` = VALUES(\`dolibarr_label\`),
           \`dolibarr_type\` = VALUES(\`dolibarr_type\`),
           \`currency_code\` = VALUES(\`currency_code\`),
           \`country_code\` = VALUES(\`country_code\`),
           \`country_id\` = VALUES(\`country_id\`),
           \`status\` = VALUES(\`status\`),
           \`bank_name\` = VALUES(\`bank_name\`),
           \`bank_address\` = VALUES(\`bank_address\`),
           \`account_number\` = VALUES(\`account_number\`),
           \`ifsc_code\` = VALUES(\`ifsc_code\`),
           \`upi_id\` = VALUES(\`upi_id\`),
           \`holder_name\` = VALUES(\`holder_name\`),
           \`website\` = VALUES(\`website\`),
           \`comment\` = VALUES(\`comment\`),
           \`account_type\` = VALUES(\`account_type\`),
           \`is_default\` = VALUES(\`is_default\`),
           \`updated_at\` = VALUES(\`updated_at\`)`,
        [
          id,
          companyId,
          employeeId,
          employeeName,
          employeeEmail,
          accountType,
          dolibarrRef,
          dolibarrLabel,
          dolibarrType,
          currencyCode,
          countryCode,
          countryId,
          status,
          bankName,
          bankAddress,
          accountNumber,
          ifscCode,
          upiId,
          holderName,
          website,
          comment,
          isDefault,
          now,
          now,
        ]
      );
      res.status(201).json({ id, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to save bank account.";
      res.status(500).json({ message });
    }
  });

  app.delete("/api/bank-accounts/:id", requireAuth, populateUser, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL is not configured." });
      return;
    }
    const accountId = firstString(req.params.id);
    if (!accountId) {
      res.status(400).json({ message: "Account id is required." });
      return;
    }
    try {
      await ensureBankAccountsTable();
      const conn = await getMySqlPool();
      const requestUser = (req as any).user as AppUser;
      const companyId = await resolveRequestCompanyId(req);
      // Non-admins can only delete their own accounts
      if (!["admin", "hr", "manager"].includes(requestUser?.role || "")) {
        const params: unknown[] = [accountId, requestUser?.email || ""];
        let where = "`id` = ? AND `employee_email` = ?";
        if (companyId) {
          where += " AND `company_id` = ?";
          params.push(companyId);
        }
        await conn.execute(
          `DELETE FROM \`lff_bank_accounts\` WHERE ${where}`,
          params
        );
      } else {
        const params: unknown[] = [accountId];
        let where = "`id` = ?";
        if (companyId) {
          where += " AND `company_id` = ?";
          params.push(companyId);
        }
        await conn.execute(`DELETE FROM \`lff_bank_accounts\` WHERE ${where}`, params);
      }
      res.json({ id: accountId, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete bank account.";
      res.status(500).json({ message });
    }
  });


}
