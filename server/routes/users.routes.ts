import type { Express } from "express";
type AccessRequestRecord = any;
export function registerUserRoutes(app: Express, deps: Record<string, any>) {
const {
    getMySqlPool,
    requireAuth,
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
}
