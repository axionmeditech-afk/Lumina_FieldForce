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
    isLegacyDemoIdentity,
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
  const parseAssignedEmployeeIds = (value: unknown): string[] => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!Array.isArray(parsed)) return [];
      return Array.from(new Set(parsed.map((item) => normalizeWhitespace(String(item || ""))).filter(Boolean)));
    } catch {
      return [];
    }
  };

  const syncWorkspaceGeofenceAccess = async (
    conn: any,
    employeeIdentityIds: string[],
    nextCompanyIds: string[],
  ): Promise<number> => {
    const identityIds = Array.from(new Set(employeeIdentityIds.map((item) => normalizeWhitespace(item)).filter(Boolean)));
    const companyIds = new Set(nextCompanyIds.map((item) => normalizeWhitespace(item)).filter(Boolean));
    if (!identityIds.length) return 0;
    const primaryId = identityIds[0];
    const companyPlaceholders = companyIds.size ? Array.from(companyIds).map(() => "?").join(", ") : "''";
    const containsClauses = identityIds.map(() => "JSON_CONTAINS(assigned_employee_ids_json, JSON_QUOTE(?))").join(" OR ");
    const [rows] = await conn.query(
      `SELECT id, company_id, assigned_employee_ids_json
       FROM lff_geofences
       WHERE company_id IN (${companyPlaceholders})${containsClauses ? ` OR ${containsClauses}` : ""}`,
      [...Array.from(companyIds), ...identityIds],
    ).catch(() => [[] as any[]]);
    let updated = 0;
    for (const row of rows || []) {
      const zoneId = normalizeWhitespace(String(row.id || ""));
      if (!zoneId) continue;
      const zoneCompanyId = normalizeWhitespace(String(row.company_id || ""));
      const current = parseAssignedEmployeeIds(row.assigned_employee_ids_json);
      const shouldAssign = Boolean(zoneCompanyId && companyIds.has(zoneCompanyId));
      const withoutAliases = current.filter((id) => !identityIds.includes(normalizeWhitespace(id)));
      const next = shouldAssign ? Array.from(new Set([...withoutAliases, primaryId])) : withoutAliases;
      if (next.length === current.length && next.every((id, index) => id === current[index])) continue;
      await conn.execute(
        `UPDATE lff_geofences SET assigned_employee_ids_json = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(next), zoneId],
      );
      updated += 1;
    }
    return updated;
  };

  const closeOpenAttendanceOutsideWorkspaceAccess = async (
    conn: any,
    userIdentityIds: string[],
    nextCompanyIds: string[],
    reviewerName: string,
  ): Promise<void> => {
    const identityIds = Array.from(new Set(userIdentityIds.map((item) => normalizeWhitespace(item || "")).filter(Boolean)));
    const allowedCompanyIds = new Set(nextCompanyIds.map((item) => normalizeWhitespace(item)).filter(Boolean));
    if (!identityIds.length || !allowedCompanyIds.size) return;
    const placeholders = identityIds.map(() => "?").join(", ");
    const [rows] = await conn.query(
      `SELECT a.*
       FROM lff_attendance a
       WHERE a.user_id IN (${placeholders})
         AND a.type = 'checkin'
         AND NOT EXISTS (
           SELECT 1
           FROM lff_attendance later
           WHERE later.user_id = a.user_id
             AND later.type = 'checkout'
             AND later.timestamp >= a.timestamp
         )
       ORDER BY a.timestamp DESC
       LIMIT 1`,
      identityIds,
    ).catch(() => [[] as any[]]);
    const active = rows?.[0];
    const activeCompanyId = normalizeWhitespace(String(active?.company_id || ""));
    const activeUserId = normalizeWhitespace(String(active?.user_id || identityIds[0]));
    if (!active || !activeCompanyId || allowedCompanyIds.has(activeCompanyId)) return;
    await conn.execute(
      `INSERT INTO lff_attendance (
        id, user_id, user_name, company_id, type, timestamp, timestamp_server,
        lat, lng, geofence_id, geofence_name, device_id, is_inside_geofence,
        source, notes, approval_status
      ) VALUES (?, ?, ?, ?, 'checkout', NOW(), NOW(), ?, ?, ?, ?, ?, 0, 'manual', ?, 'approved')`,
      [
        randomUUID(),
        activeUserId,
        normalizeWhitespace(String(active.user_name || "")) || activeUserId,
        activeCompanyId,
        active.lat ?? null,
        active.lng ?? null,
        active.geofence_id ?? null,
        active.geofence_name ?? null,
        active.device_id ?? null,
        `System checkout because workspace access changed by ${reviewerName}. Previous workspace ${activeCompanyId} is no longer assigned.`,
      ],
    ).catch(() => undefined);
  };
app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const conn = await getMySqlPool();
      const requestUser = getRequestUser(req);
      const requestedCompanyId = normalizeWhitespace(
        typeof req.query.companyId === "string" ? req.query.companyId : ""
      );
      const wantsAllCompanies =
        req.query.allCompanies === "1" ||
        req.query.allCompanies === "true";
      const allowedCompanyIds = new Set(
        normalizeCompanyIds(requestUser?.companyIds || (requestUser?.companyId ? [requestUser.companyId] : []))
      );
      const canListAllCompanies = wantsAllCompanies && requestUser?.role === "admin";
      const canUseRequestedCompany =
        requestedCompanyId &&
        (requestUser?.role === "admin" || allowedCompanyIds.has(requestedCompanyId));
      const companyId =
        canListAllCompanies ? "" :
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
      let appUserRows: any[] = [];
      try {
        [appUserRows] = await conn.query(
          `SELECT id, email, role, approval_status
           FROM lff_users
           WHERE approval_status = 'approved'`
        );
      } catch {
        // Older installations may not have lff_users yet. Approved access
        // requests below remain the compatibility path.
      }
      const appUserByEmail = new Map<string, any>();
      for (const appUser of appUserRows || []) {
        const emailKey = normalizeEmail(String(appUser.email || ""));
        if (emailKey) appUserByEmail.set(emailKey, appUser);
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
      const mappedAccessRequestIds = new Set<string>();
      const addRosterEntry = (
        request: AccessRequestRecord,
        options?: {
          appUser?: any;
          dolibarrUser?: any;
          assignedCompanyId?: string;
          firstName?: string;
          lastName?: string;
          displayName?: string;
          login?: string;
          phone?: string;
          statut?: unknown;
        },
      ) => {
        const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
        if (!assignedCompanyIds.length) return;
        if (companyId && !assignedCompanyIds.includes(companyId)) return;

        const requestEmail = normalizeEmail(request.email || "");
        const appUser = options?.appUser || (requestEmail ? appUserByEmail.get(requestEmail) || null : null);
        const dolibarrUser = options?.dolibarrUser || null;
        const firstName = normalizeWhitespace(options?.firstName || String(dolibarrUser?.firstname || ""));
        const lastName = normalizeWhitespace(options?.lastName || String(dolibarrUser?.lastname || ""));
        const login =
          normalizeWhitespace(options?.login || String(dolibarrUser?.login || requestEmail.split("@")[0] || ""));
        const displayName =
          normalizeWhitespace(options?.displayName || request.name) ||
          normalizeWhitespace(`${firstName} ${lastName}`) ||
          login ||
          requestEmail ||
          "Employee";
        if (
          isLegacyDemoProfileName(displayName) ||
          isLegacyDemoIdentity(requestEmail) ||
          isLegacyDemoIdentity(login) ||
          isLegacyDemoIdentity(String(dolibarrUser?.login || ""))
        ) {
          return;
        }

        let role: string = appUser?.role
          ? normalizeRole(String(appUser.role))
          : Number(dolibarrUser?.admin || 0) === 1
            ? "admin"
            : "";
        if (!role && dolibarrUser?.employee_category === "on_field") {
          role = "salesperson";
        } else if (!role && dolibarrUser?.employee_category === "fixed_location") {
          role = "employee";
        } else if (!role && dolibarrUser?.job) {
          const jobStr = String(dolibarrUser.job).toLowerCase();
          if (jobStr.includes("on field") || jobStr.includes("sales")) {
            role = "salesperson";
          } else if (jobStr.includes("fixed") || jobStr.includes("office") || jobStr.includes("support") || jobStr.includes("hr")) {
            role = "employee";
          }
        }
        const finalRole = normalizeRole(role || request.approvedRole || request.requestedRole || "employee");
        const employeeCategory =
          finalRole === "admin" ? null : isSalesRole(finalRole) ? "on_field" : "fixed_location";
        const rowid = normalizeWhitespace(String(dolibarrUser?.rowid || dolibarrUser?.id || ""));
        const id = normalizeWhitespace(String(appUser?.id || rowid || `access_${request.id}`));
        const phone = normalizeWhitespace(options?.phone || String(dolibarrUser?.user_mobile || dolibarrUser?.office_phone || ""));
        const statut = options?.statut ?? dolibarrUser?.statut ?? 1;
        const targetCompanyIds = companyId ? [companyId] : assignedCompanyIds;
        for (const assignedCompanyId of targetCompanyIds) {
          const company = companyById.get(assignedCompanyId);
          const key = `${assignedCompanyId}:${requestEmail || String(id) || displayName.toLowerCase()}`;
          mappedByScope.set(key, {
            id: String(id),
            rowid: rowid || undefined,
            user_id: String(id),
            login,
            firstname: firstName || displayName.split(" ")[0] || "",
            lastname: lastName || displayName.split(" ").slice(1).join(" ") || "",
            name: displayName,
            email: requestEmail,
            phone,
            town: "",
            address: "",
            zip: "",
            statut,
            status: statut,
            companyId: assignedCompanyId,
            companyName:
              company?.name ||
              (assignedCompanyId === requestUser?.companyId ? requestUser?.companyName : "") ||
              request.requestedCompanyName ||
              assignedCompanyId,
            assignedCompanyIds,
            admin: finalRole === "admin" ? 1 : Number(dolibarrUser?.admin || 0),
            employee: finalRole === "admin" ? 0 : 1,
            employeeCategory,
            employee_category: employeeCategory,
            role: finalRole,
            department: normalizeDepartmentForRole(finalRole, request.requestedDepartment || dolibarrUser?.job),
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
        mappedAccessRequestIds.add(String(request.id));
      };

      for (const row of userRows || []) {
        const email = normalizeEmail(String(row.email || ""));
        const loginKey = normalizeLoginKey(String(row.login || ""));
        const appUser = email ? appUserByEmail.get(email) || null : null;

        // Find matching access request to get company assignments
        const request = (email && requestByEmail.get(email)) || (loginKey && requestByLogin.get(loginKey)) || null;
        if (!request) continue;

        const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
        if (!assignedCompanyIds.length) continue;
        if (companyId && !assignedCompanyIds.includes(companyId)) continue;

        addRosterEntry(request, {
          appUser,
          dolibarrUser: row,
          firstName: normalizeWhitespace(String(row.firstname || "")),
          lastName: normalizeWhitespace(String(row.lastname || "")),
          login: normalizeWhitespace(String(row.login || "")),
          phone: normalizeWhitespace(String(row.user_mobile || row.office_phone || "")),
          statut: row.statut ?? 1,
        });
      }

      for (const request of approvedRequests) {
        if (mappedAccessRequestIds.has(String(request.id))) continue;
        const assignedCompanyIds = normalizeCompanyIds(request.assignedCompanyIds);
        if (!assignedCompanyIds.length) continue;
        if (companyId && !assignedCompanyIds.includes(companyId)) continue;
        addRosterEntry(request);
      }

      res.json({ items: Array.from(mappedByScope.values()) });
    } catch (error) {
      console.error("Failed to list app users", error);
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to load employees.",
      });
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
    const requesterId = normalizeWhitespace(requestUser?.id || req.auth?.sub || "").replace(/^dolibarr_/i, "");
    const requesterEmail = normalizeEmail(requestUser?.email || req.auth?.email || "");
    const requesterLogin = normalizeLoginKey(
      String(requestUser?.login || (requesterEmail ? requesterEmail.split("@")[0] : "") || "")
    );
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

app.post("/api/users/:id/reset-session", requireAuth, requireRoles("admin"), async (req, res) => {
    const targetId = normalizeWhitespace(String(req.params.id || ""));
    const body = (req.body || {}) as {
      email?: unknown;
      login?: unknown;
      name?: unknown;
    };
    const targetEmail = normalizeEmail(typeof body.email === "string" ? body.email : "");
    const targetLogin = normalizeLoginKey(typeof body.login === "string" ? body.login : "");
    const targetName = normalizeWhitespace(typeof body.name === "string" ? body.name : "");
    const requestUser = getRequestUser(req);
    const requesterId = normalizeWhitespace(requestUser?.id || req.auth?.sub || "").replace(/^dolibarr_/i, "");
    const requesterEmail = normalizeEmail(requestUser?.email || req.auth?.email || "");
    const requesterLogin = normalizeLoginKey(
      String(requestUser?.login || (requesterEmail ? requesterEmail.split("@")[0] : "") || "")
    );
    const reviewerId = normalizeWhitespace(requestUser?.id || req.auth?.sub || "admin");
    const reviewerName = normalizeWhitespace(requestUser?.name || req.auth?.email || "Admin");

    if (!targetId && !targetEmail && !targetLogin) {
      res.status(400).json({ message: "Employee id or email is required." });
      return;
    }
    if (
      (targetId && requesterId && targetId.replace(/^dolibarr_/i, "") === requesterId) ||
      (targetEmail && requesterEmail && targetEmail === requesterEmail) ||
      (targetLogin && requesterLogin && targetLogin === requesterLogin)
    ) {
      res.status(400).json({ message: "You cannot reset your own active admin session." });
      return;
    }

    try {
      const conn = await getMySqlPool();
      const normalizedTargetId = targetId.replace(/^dolibarr_/i, "");
      const lookupEmail = targetEmail || "__none__";
      const lookupLogin = targetLogin || "__none__";
      const lookupId = normalizedTargetId || "__none__";
      const [rows] = await conn.query(
        `SELECT rowid, login, email, firstname, lastname, admin, statut
         FROM nmy5_user
         WHERE CAST(rowid AS CHAR) = ?
            OR LOWER(TRIM(email)) = ?
            OR LOWER(TRIM(login)) = ?
         LIMIT 1`,
        [lookupId, lookupEmail, lookupLogin]
      ).catch(() => [[] as any[]]);
      const dolibarrUser = rows?.[0] || null;
      const resolvedUserId = normalizeWhitespace(
        String(dolibarrUser?.rowid || (normalizedTargetId.includes("@") ? "" : normalizedTargetId) || "")
      );
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
      if (
        (resolvedUserId && requesterId && resolvedUserId === requesterId) ||
        (resolvedEmail && requesterEmail && resolvedEmail === requesterEmail) ||
        (resolvedLogin && requesterLogin && resolvedLogin === requesterLogin)
      ) {
        res.status(400).json({ message: "You cannot reset your own active admin session." });
        return;
      }

      if (resolvedUserId) {
        await deactivateAuthSession(resolvedUserId).catch(() => undefined);
      }

      const whereParts: string[] = [];
      const whereValues: string[] = [];
      for (const idCandidate of [resolvedUserId, resolvedUserId ? `dolibarr_${resolvedUserId}` : "", targetId]) {
        const value = normalizeWhitespace(idCandidate);
        if (value) {
          whereParts.push("user_id = ?");
          whereValues.push(value);
        }
      }
      if (resolvedEmail) {
        whereParts.push("LOWER(TRIM(email)) = ?");
        whereValues.push(resolvedEmail);
      }
      if (whereParts.length) {
        await conn.execute(
          `UPDATE lff_auth_sessions
           SET is_active = 0,
               last_logout_at = NOW(),
               updated_at = NOW()
           WHERE is_active = 1 AND (${whereParts.join(" OR ")})`,
          whereValues
        ).catch(() => undefined);
      }

      await conn.execute(
        `INSERT INTO lff_audit_logs (id, actor_id, actor_name, action, entity_type, entity_id, details_json, created_at)
         VALUES (?, ?, ?, 'reset_employee_session', 'user', ?, ?, NOW())`,
        [
          randomUUID(),
          reviewerId,
          reviewerName,
          resolvedUserId || resolvedEmail || targetId,
          JSON.stringify({ email: resolvedEmail || null, login: resolvedLogin || null, name: resolvedName }),
        ]
      ).catch(() => undefined);

      res.json({
        ok: true,
        reset: {
          id: resolvedUserId || targetId,
          email: resolvedEmail || null,
          name: resolvedName,
        },
      });
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Unable to reset employee session.",
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

      const geofenceIdentityIds = Array.from(new Set([
        resolvedUserId,
        resolvedUserId ? `dolibarr_${resolvedUserId}` : "",
        resolvedEmail,
        resolvedLogin,
        targetId,
      ].map((item) => normalizeWhitespace(String(item || ""))).filter(Boolean)));
      await syncWorkspaceGeofenceAccess(conn, geofenceIdentityIds, nextCompanyIds).catch((error: unknown) => {
        console.warn("Workspace geofence sync failed", error);
      });
      await closeOpenAttendanceOutsideWorkspaceAccess(
        conn,
        geofenceIdentityIds,
        nextCompanyIds,
        normalizeWhitespace(requestUser?.name || req.auth?.email || "Admin"),
      );

      if (resolvedEmail) removeAuthUserByEmail(resolvedEmail);
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
