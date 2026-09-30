import type { Express } from "express";
type AccessRequestRecord = any;
export function registerUserRoutes(app: Express, deps: Record<string, any>) {
const {
    getMySqlPool,
    requireAuth,
    requireRoles,
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
    removeAuthUserByEmail,
    deactivateAuthSession,
    randomUUID,
    getCompanyProfilesByIds,
    isDolibarrSuperuserReviewer,
    forceDolibarrAdminPrivilegesForUserIdentity,
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

app.delete("/api/users/:id", requireAuth, requireRoles("admin"), async (req, res) => {
    const targetId = normalizeWhitespace(String(req.params.id || ""));
    const body = (req.body || {}) as {
      email?: unknown;
      login?: unknown;
      companyId?: unknown;
      name?: unknown;
    };
    const targetEmail = normalizeEmail(typeof body.email === "string" ? body.email : "");
    const targetLogin = normalizeLoginKey(typeof body.login === "string" ? body.login : "");
    const requestedCompanyId = normalizeWhitespace(typeof body.companyId === "string" ? body.companyId : "");
    const targetName = normalizeWhitespace(typeof body.name === "string" ? body.name : "");
    const requestUser = getRequestUser(req);
    const reviewerId = normalizeWhitespace(requestUser?.id || req.auth?.sub || "admin");
    const reviewerName = normalizeWhitespace(requestUser?.name || req.auth?.email || "Admin");

    if (!targetId && !targetEmail && !targetLogin) {
      res.status(400).json({ message: "Employee id or email is required." });
      return;
    }
    if (
      (targetId && requestUser?.id && targetId === requestUser.id) ||
      (targetEmail && requestUser?.email && targetEmail === normalizeEmail(requestUser.email)) ||
      (targetLogin && requestUser?.login && targetLogin === normalizeLoginKey(requestUser.login))
    ) {
      res.status(400).json({ message: "You cannot delete your own admin account." });
      return;
    }

    try {
      const conn = await getMySqlPool();
      const lookupEmail = targetEmail || "__none__";
      const lookupLogin = targetLogin || "__none__";
      const lookupId = targetId || "__none__";
      const [rows] = await conn.query(
        `SELECT rowid, login, email, firstname, lastname, admin, statut
         FROM nmy5_user
         WHERE CAST(rowid AS CHAR) = ?
            OR LOWER(TRIM(email)) = ?
            OR LOWER(TRIM(login)) = ?
         LIMIT 1`,
        [lookupId, lookupEmail, lookupLogin]
      );
      const dolibarrUser = rows?.[0] || null;
      const resolvedUserId = normalizeWhitespace(String(dolibarrUser?.rowid || (targetId.includes("@") ? "" : targetId) || ""));
      const resolvedEmail = normalizeEmail(String(dolibarrUser?.email || targetEmail || ""));
      const resolvedLogin = normalizeLoginKey(String(dolibarrUser?.login || targetLogin || ""));
      const resolvedName =
        targetName ||
        normalizeWhitespace(`${dolibarrUser?.firstname || ""} ${dolibarrUser?.lastname || ""}`) ||
        resolvedEmail ||
        resolvedLogin ||
        resolvedUserId;
      const companyId = requestedCompanyId || requestUser?.companyId || DEFAULT_COMPANY_ID;

      if (!resolvedUserId && !resolvedEmail && !resolvedLogin) {
        res.status(404).json({ message: "Employee not found." });
        return;
      }
      if (Number(dolibarrUser?.admin || 0) === 1) {
        res.status(400).json({ message: "Admin accounts cannot be deleted from the employee list." });
        return;
      }

      if (dolibarrUser?.rowid) {
        await conn.execute(
          `UPDATE nmy5_user
           SET statut = 0, employee = 0, tms = NOW()
           WHERE rowid = ?`,
          [dolibarrUser.rowid]
        );
      }

      if (resolvedEmail) {
        await conn.execute(
          `UPDATE lff_access_requests
           SET status = 'rejected',
               assigned_company_ids_json = '[]',
               reviewed_at = NOW(),
               reviewed_by_id = ?,
               reviewed_by_name = ?,
               review_comment = TRIM(CONCAT(COALESCE(review_comment, ''), '\nDeleted by admin on ', NOW()))
           WHERE LOWER(TRIM(email)) = ?`,
          [reviewerId, reviewerName, resolvedEmail]
        ).catch(() => undefined);
      }

      const userWhereParts: string[] = [];
      const userWhereValues: string[] = [];
      if (resolvedUserId) {
        userWhereParts.push("id = ?");
        userWhereValues.push(resolvedUserId);
      }
      if (resolvedEmail) {
        userWhereParts.push("LOWER(TRIM(email)) = ?");
        userWhereValues.push(resolvedEmail);
      }
      if (userWhereParts.length) {
        await conn.execute(`DELETE FROM lff_users WHERE ${userWhereParts.join(" OR ")}`, userWhereValues).catch(() => undefined);
      }

      const employeeWhereParts: string[] = [];
      const employeeWhereValues: string[] = [];
      if (resolvedUserId) {
        employeeWhereParts.push("id = ?");
        employeeWhereValues.push(resolvedUserId);
      }
      if (resolvedEmail) {
        employeeWhereParts.push("LOWER(TRIM(email)) = ?");
        employeeWhereValues.push(resolvedEmail);
      }
      if (companyId) {
        employeeWhereParts.push("(company_id = ? AND LOWER(TRIM(name)) = ?)");
        employeeWhereValues.push(companyId, resolvedName.toLowerCase());
      }
      if (employeeWhereParts.length) {
        await conn.execute(`DELETE FROM lff_employees WHERE ${employeeWhereParts.join(" OR ")}`, employeeWhereValues).catch(() => undefined);
      }

      if (resolvedUserId) {
        await deactivateAuthSession(resolvedUserId).catch(() => undefined);
        await conn.execute(
          `UPDATE lff_auth_sessions
           SET is_active = 0, last_logout_at = NOW(), updated_at = NOW()
           WHERE user_id = ? OR LOWER(TRIM(email)) = ?`,
          [resolvedUserId, resolvedEmail || "__none__"]
        ).catch(() => undefined);
      }

      if (resolvedUserId || resolvedEmail) {
        const [latestRows] = await conn.query(
          `SELECT id, type, company_id, geofence_id, geofence_name
           FROM lff_attendance
           WHERE user_id = ?
           ORDER BY \`timestamp\` DESC
           LIMIT 1`,
          [resolvedUserId]
        ).catch(() => [[] as any[]]);
        const latest = latestRows?.[0] || null;
        if (latest?.type === "checkin") {
          await conn.execute(
            `INSERT INTO lff_attendance (
              id, user_id, user_name, company_id, type, \`timestamp\`, timestamp_server,
              geofence_id, geofence_name, source, notes, approval_status
            ) VALUES (?, ?, ?, ?, 'checkout', NOW(), NOW(), ?, ?, 'manual', ?, 'approved')`,
            [
              randomUUID(),
              resolvedUserId,
              resolvedName,
              latest.company_id || companyId || null,
              latest.geofence_id || null,
              latest.geofence_name || null,
              `System checkout because employee was deleted by ${reviewerName}.`,
            ]
          ).catch(() => undefined);
        }
      }

      const removableIds = new Set(
        [resolvedUserId, targetId, resolvedUserId ? `dolibarr_${resolvedUserId}` : "", resolvedEmail]
          .map((item) => normalizeWhitespace(String(item || "")))
          .filter(Boolean)
      );
      if (removableIds.size) {
        const [geofenceRows] = await conn.query(
          `SELECT id, assigned_employee_ids_json FROM lff_geofences`
        ).catch(() => [[] as any[]]);
        for (const row of geofenceRows || []) {
          const raw = String(row.assigned_employee_ids_json || "[]");
          let parsed: string[] = [];
          try {
            const value = JSON.parse(raw);
            parsed = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
          } catch {
            parsed = [];
          }
          const next = parsed.filter((id) => !removableIds.has(normalizeWhitespace(id)));
          if (next.length !== parsed.length) {
            await conn.execute(
              `UPDATE lff_geofences SET assigned_employee_ids_json = ?, updated_at = NOW() WHERE id = ?`,
              [JSON.stringify(next), row.id]
            ).catch(() => undefined);
          }
        }
      }

      if (resolvedEmail) removeAuthUserByEmail(resolvedEmail);

      res.json({
        ok: true,
        deleted: {
          id: resolvedUserId || targetId,
          email: resolvedEmail || null,
          name: resolvedName,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to delete employee.",
      });
    }
  });

app.patch("/api/users/:id/access", requireAuth, requireRoles("admin"), async (req, res) => {
    const targetId = normalizeWhitespace(String(req.params.id || ""));
    const body = (req.body || {}) as {
      email?: unknown;
      login?: unknown;
      name?: unknown;
      role?: unknown;
      companyIds?: unknown;
    };
    const targetEmail = normalizeEmail(typeof body.email === "string" ? body.email : "");
    const targetLogin = normalizeLoginKey(typeof body.login === "string" ? body.login : "");
    const targetName = normalizeWhitespace(typeof body.name === "string" ? body.name : "");
    const nextRole = normalizeRole(body.role);
    const nextCompanyIds = normalizeCompanyIds(body.companyIds);
    const requestUser = getRequestUser(req);

    if (!targetId && !targetEmail && !targetLogin) {
      res.status(400).json({ message: "Employee id or email is required." });
      return;
    }
    if (!nextCompanyIds.length) {
      res.status(400).json({ message: "Select at least one company." });
      return;
    }
    if (
      (targetId && requestUser?.id && targetId === requestUser.id) ||
      (targetEmail && requestUser?.email && targetEmail === normalizeEmail(requestUser.email)) ||
      (targetLogin && requestUser?.login && targetLogin === normalizeLoginKey(requestUser.login))
    ) {
      res.status(400).json({ message: "You cannot change your own role or company access." });
      return;
    }
    if (nextRole === "admin") {
      const canPromoteAdmin = await isDolibarrSuperuserReviewer(req);
      if (!canPromoteAdmin) {
        res.status(403).json({
          message: "Only the primary admin can grant admin access.",
        });
        return;
      }
    }

    try {
      const selectedCompaniesById = await getCompanyProfilesByIds(nextCompanyIds);
      const missingCompanyIds = nextCompanyIds.filter((companyId: string) => !selectedCompaniesById.has(companyId));
      if (missingCompanyIds.length > 0) {
        res.status(400).json({ message: "One or more selected companies are invalid." });
        return;
      }

      const primaryCompany = selectedCompaniesById.get(nextCompanyIds[0]);
      if (!primaryCompany) {
        res.status(400).json({ message: "Primary company is invalid." });
        return;
      }

      const conn = await getMySqlPool();
      const [rows] = await conn.query(
        `SELECT rowid, login, email, firstname, lastname, admin
         FROM nmy5_user
         WHERE CAST(rowid AS CHAR) = ?
            OR LOWER(TRIM(email)) = ?
            OR LOWER(TRIM(login)) = ?
         LIMIT 1`,
        [
          targetId || "__none__",
          targetEmail || "__none__",
          targetLogin || "__none__",
        ]
      );
      const dolibarrUser = rows?.[0] || null;
      const resolvedUserId = normalizeWhitespace(String(dolibarrUser?.rowid || (targetId.includes("@") ? "" : targetId) || ""));
      const resolvedEmail = normalizeEmail(String(dolibarrUser?.email || targetEmail || ""));
      const resolvedLogin = normalizeLoginKey(String(dolibarrUser?.login || targetLogin || ""));
      const resolvedName =
        targetName ||
        normalizeWhitespace(`${dolibarrUser?.firstname || ""} ${dolibarrUser?.lastname || ""}`) ||
        resolvedEmail ||
        resolvedLogin ||
        resolvedUserId;
      if (!resolvedUserId && !resolvedEmail && !resolvedLogin) {
        res.status(404).json({ message: "Employee not found." });
        return;
      }

      const isAdminRole = nextRole === "admin";
      const isSalespersonRole = isSalesRole(nextRole);
      const employeeCategory = isAdminRole ? null : isSalespersonRole ? "on_field" : "fixed_location";
      const jobLabel =
        nextRole === "admin"
          ? "Admin"
          : nextRole === "hr"
            ? "HR"
            : nextRole === "manager"
              ? "Manager"
              : isSalespersonRole
                ? "On Field Sales"
                : "Fixed Location Employee";

      if (resolvedUserId || resolvedEmail || resolvedLogin) {
        await conn.execute(
          `UPDATE nmy5_user
           SET admin = ?, employee = ?, job = ?, statut = 1, tms = NOW()
           WHERE CAST(rowid AS CHAR) = ?
              OR LOWER(TRIM(email)) = ?
              OR LOWER(TRIM(login)) = ?`,
          [
            isAdminRole ? 1 : 0,
            isAdminRole ? 0 : 1,
            jobLabel,
            resolvedUserId || "__none__",
            resolvedEmail || "__none__",
            resolvedLogin || "__none__",
          ]
        );
      }

      if (resolvedUserId && !isAdminRole) {
        try {
          const [profileUpdate] = await conn.execute(
            `UPDATE nmy5_hrm_employee_profile SET employee_category = ? WHERE fk_user = ?`,
            [employeeCategory, resolvedUserId]
          );
          const affected = Number((profileUpdate as { affectedRows?: number })?.affectedRows || 0);
          if (affected === 0) {
            await conn.execute(
              `INSERT INTO nmy5_hrm_employee_profile (fk_user, employee_category) VALUES (?, ?)`,
              [resolvedUserId, employeeCategory]
            );
          }
        } catch {
          // Some Dolibarr installs do not have the HRM profile table. The job/admin fields above remain authoritative.
        }
      }

      if (resolvedEmail) {
        await conn.execute(
          `UPDATE lff_access_requests
           SET status = 'approved',
               approved_role = ?,
               assigned_company_ids_json = ?,
               reviewed_at = NOW(),
               reviewed_by_id = ?,
               reviewed_by_name = ?,
               review_comment = TRIM(CONCAT(COALESCE(review_comment, ''), '\nAccess updated by admin on ', NOW()))
           WHERE LOWER(TRIM(email)) = ?`,
          [
            nextRole,
            JSON.stringify(nextCompanyIds),
            normalizeWhitespace(requestUser?.id || req.auth?.sub || "admin"),
            normalizeWhitespace(requestUser?.name || req.auth?.email || "Admin"),
            resolvedEmail,
          ]
        ).catch(() => undefined);
      }

      const companyIdsJson = JSON.stringify(nextCompanyIds);
      const department = normalizeDepartmentForRole(nextRole, String(dolibarrUser?.job || ""));
      const updateValues = [
        nextRole,
        primaryCompany.id,
        primaryCompany.name,
        companyIdsJson,
        department,
        primaryCompany.primaryBranch || requestUser?.branch || "Main Branch",
      ];
      await conn.execute(
        `UPDATE lff_users
         SET role = ?, company_id = ?, company_name = ?, company_ids_json = ?,
             department = ?, branch = ?, approval_status = 'approved', updated_at = NOW()
         WHERE id = ? OR LOWER(TRIM(email)) = ?`,
        [...updateValues, resolvedUserId || "__none__", resolvedEmail || "__none__"]
      ).catch(() => undefined);
      await conn.execute(
        `UPDATE lff_employees
         SET role = ?, company_id = ?, department = ?, branch = ?
         WHERE id = ? OR LOWER(TRIM(email)) = ?`,
        [
          nextRole,
          primaryCompany.id,
          department,
          primaryCompany.primaryBranch || requestUser?.branch || "Main Branch",
          resolvedUserId || "__none__",
          resolvedEmail || "__none__",
        ]
      ).catch(() => undefined);

      if (resolvedEmail) removeAuthUserByEmail(resolvedEmail);
      if (resolvedUserId) await deactivateAuthSession(resolvedUserId).catch(() => undefined);
      if (isAdminRole) {
        await forceDolibarrAdminPrivilegesForUserIdentity({
          id: resolvedUserId,
          name: resolvedName,
          email: resolvedEmail,
          login: resolvedLogin || undefined,
          role: "admin",
          companyId: primaryCompany.id,
          companyName: primaryCompany.name,
          companyIds: nextCompanyIds,
          department,
          branch: primaryCompany.primaryBranch || requestUser?.branch || "Main Branch",
          phone: "",
          joinDate: new Date().toISOString().slice(0, 10),
        });
      }

      res.json({
        ok: true,
        user: {
          id: resolvedUserId || targetId,
          email: resolvedEmail,
          name: resolvedName,
          role: nextRole,
          companyId: primaryCompany.id,
          companyName: primaryCompany.name,
          companyIds: nextCompanyIds,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to update employee access.",
      });
    }
  });
}
