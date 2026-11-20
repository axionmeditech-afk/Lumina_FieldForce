import type { Express } from "express";
import { createHash } from "crypto";
import type { AppUser, UserRole } from "@/lib/types";

type AuthUserRecord = any;
type AccessRequestRecord = any;
type CompanyProfileSummary = any;

export type AuthRouteDeps = Record<string, any>;

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_TRACKED_LOGIN_ATTEMPTS = 10_000;
type LoginAttempt = { windowStartedAt: number; failures: number; lockedUntil: number };
const loginAttempts = new Map<string, LoginAttempt>();

function passwordPolicyError(value: unknown): string | null {
  if (typeof value !== "string") return "Password is required.";
  if (value.length < 12) return "Password must be at least 12 characters.";
  if (value.length > 256) return "Password is too long.";
  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9\s]/].filter((pattern) => pattern.test(value)).length;
  return characterClasses >= 3
    ? null
    : "Password must include at least three of: lowercase, uppercase, number, symbol.";
}

function loginAttemptKey(req: any, identifier: string): string {
  // Keep raw identifiers/IP addresses out of memory while limiting both a
  // targeted account and broad credential-stuffing from one network.
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 200);
  const normalizedIdentifier = identifier.trim().toLowerCase().slice(0, 320);
  return createHash("sha256").update(`${ip}\u0000${normalizedIdentifier}`).digest("hex");
}

function activeLoginLock(key: string): number {
  const attempt = loginAttempts.get(key);
  if (!attempt) return 0;
  const now = Date.now();
  if (attempt.lockedUntil > now) return attempt.lockedUntil - now;
  if (now - attempt.windowStartedAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
}

function recordFailedLogin(key: string): void {
  const now = Date.now();
  if (loginAttempts.size >= MAX_TRACKED_LOGIN_ATTEMPTS && !loginAttempts.has(key)) {
    for (const [candidateKey, attempt] of loginAttempts) {
      if (attempt.lockedUntil <= now && now - attempt.windowStartedAt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(candidateKey);
      }
    }
    // Bound memory under a distributed identifier spray. Oldest entries are
    // less useful than preserving availability of the auth process.
    if (loginAttempts.size >= MAX_TRACKED_LOGIN_ATTEMPTS) {
      const oldest = loginAttempts.keys().next();
      if (!oldest.done) loginAttempts.delete(oldest.value);
    }
  }
  const current = loginAttempts.get(key);
  const next = !current || now - current.windowStartedAt > LOGIN_WINDOW_MS
    ? { windowStartedAt: now, failures: 1, lockedUntil: 0 }
    : { ...current, failures: current.failures + 1 };
  if (next.failures >= LOGIN_MAX_FAILURES) next.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, next);
}

function clearFailedLogins(key: string): void {
  loginAttempts.delete(key);
}

export function registerAuthRoutes(app: Express, deps: AuthRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    getMySqlPool,
    normalizeEmail,
    normalizeRole,
    normalizeCompanyName,
    checkAuthUserForSignup,
    resolveApprovalStatus,
    hasAnyApprovedAdmin,
    buildUserFromRegistration,
    hashPassword,
    hashLegacyDolibarrPassword,
    persistSecurePasswordHash,
    setAuthUserRecord,
    upsertAuthUserInMySql,
    forceDolibarrAdminPrivilegesForUserIdentity,
    removeAuthUserByEmail,
    resolveDeviceIdFromRequest,
    issueDeviceScopedAuthToken,
    isSingleDeviceSessionLockError,
    SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
    getLatestPendingAccessRequestByEmail,
    isMySqlStateEnabled,
    getLatestPendingAccessRequestByEmailFromMySql,
    accessRequestsById,
    insertAccessRequestInMySql,
    buildAccessRequestNotification,
    removeDuplicateAccessRequestNotifications,
    insertNotificationInMySql,
    toPublicAccessRequest,
    parseRequestStatus,
    listAccessRequestsFromMySql,
    firstString,
    getAccessRequestByIdFromMySql,
    isDolibarrSuperuserReviewer,
    normalizeCompanyIds,
    parseCompanyProfilesState,
    getCompanyProfilesByIds,
    normalizeWhitespace,
    normalizeDepartmentForRole,
    isSalesRole,
    authUsersByEmail,
    DEFAULT_COMPANY_NAME,
    normalizeLoginKey,
    buildLoginFromEmailAndName,
    getCompanyIdFromName,
    authenticateCredentials,
    matchesStoredPasswordHash,
    getLatestAccessRequestByEmail,
    getLatestAccessRequestByEmailFromMySql,
    deactivateAuthSession,
    normalizeDeviceIdInput,
    extractBearerTokenFromRequest,
    readActiveAuthSession,
    initAuthUsersStore,
    syncAuthUserCacheForEmail,
    getAuthUserByIdentifier,
    randomUUID,
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
    employeeIdentityIds: string[],
    nextCompanyIds: string[],
  ): Promise<void> => {
    if (!isMySqlStateEnabled() || typeof getMySqlPool !== "function") return;
    const identityIds = Array.from(new Set(employeeIdentityIds.map((item) => normalizeWhitespace(item)).filter(Boolean)));
    const companyIds = new Set(nextCompanyIds.map((item) => normalizeWhitespace(item)).filter(Boolean));
    if (!identityIds.length || !companyIds.size) return;
    const primaryId = identityIds[0];
    const companyPlaceholders = Array.from(companyIds).map(() => "?").join(", ");
    const containsClauses = identityIds.map(() => "JSON_CONTAINS(assigned_employee_ids_json, JSON_QUOTE(?))").join(" OR ");
    const conn = await getMySqlPool();
    const [rows] = await conn.query(
      `SELECT id, company_id, assigned_employee_ids_json
       FROM lff_geofences
       WHERE company_id IN (${companyPlaceholders})${containsClauses ? ` OR ${containsClauses}` : ""}`,
      [...Array.from(companyIds), ...identityIds],
    ).catch(() => [[] as any[]]);
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
    }
  };

  // Public registration must never mint an approved account.  Keeping this
  // endpoint explicit (instead of silently redirecting) prevents old clients
  // from accidentally treating a pending request as an authenticated session.
  app.post("/api/auth/register", (_req, res) => {
    res.status(410).json({
      message: "Direct account registration is disabled. Submit an access request for administrator approval.",
      code: "direct_registration_disabled",
    });
  });

  app.post("/api/auth/access-request", async (req, res) => {
    const {
      name,
      email,
      password,
      companyName,
      role,
      department,
      branch,
      phone,
    } = req.body as {
      name?: string;
      email?: string;
      password?: string;
      companyName?: string;
      role?: UserRole;
      department?: string;
      branch?: string;
      phone?: string;
    };

    if (!name || !email || !password || !companyName) {
      res.status(400).json({ message: "Name, email, password and company name are required" });
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ message: "Invalid email format" });
      return;
    }
    const passwordError = passwordPolicyError(password);
    if (passwordError) {
      res.status(400).json({ message: passwordError });
      return;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const adminAlreadyExists = await hasAnyApprovedAdmin();

    const existingRecord = await checkAuthUserForSignup(normalizedEmail);
    const existingStatus = existingRecord ? resolveApprovalStatus(existingRecord) : null;
    if (existingRecord && existingStatus === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    // A first admin is an installation operation, not public signup.  The
    // secret lives only in the server environment and is intentionally never
    // accepted in the JSON request body.
    const bootstrapToken = String(req.header("x-initial-admin-token") || "").trim();
    const configuredBootstrapToken = String(process.env.INITIAL_ADMIN_SETUP_TOKEN || "").trim();
    const canBootstrapAdmin =
      normalizedRole === "admin" &&
      !adminAlreadyExists &&
      configuredBootstrapToken.length >= 24 &&
      bootstrapToken === configuredBootstrapToken;

    if (normalizedRole === "admin" && !adminAlreadyExists && !canBootstrapAdmin) {
      res.status(403).json({
        message: "Initial administrator setup requires the server-side bootstrap token.",
        code: "bootstrap_token_required",
      });
      return;
    }

    if (canBootstrapAdmin) {
      const now = new Date().toISOString();
      const bootstrapAdmin = buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName: normalizedCompanyName,
        role: "admin",
        department,
        branch,
        phone,
      });
      const authRecord: AuthUserRecord = {
        user: bootstrapAdmin,
        passwordHash: hashPassword(password),
        legacyPasswordHash: hashLegacyDolibarrPassword(password),
        createdAt: existingRecord?.createdAt || now,
        updatedAt: now,
        approvalStatus: "approved",
      };
      setAuthUserRecord(authRecord);
      try {
        await persistSecurePasswordHash(normalizedEmail, authRecord.passwordHash);
        await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
        await forceDolibarrAdminPrivilegesForUserIdentity(bootstrapAdmin);
      } catch (error) {
        removeAuthUserByEmail(normalizedEmail);
        console.error("Failed to persist bootstrap admin in MySQL", error);
        res.status(500).json({
          message:
            error instanceof Error
              ? `Failed to save admin in database: ${error.message}`
              : "Failed to save admin in database.",
        });
        return;
      }
      const deviceId = resolveDeviceIdFromRequest(req);
      try {
        const token = await issueDeviceScopedAuthToken(bootstrapAdmin, deviceId);
        res.status(201).json({
          ok: true,
          autoApproved: true,
          message: "First admin account created and approved for this company.",
          token,
          user: bootstrapAdmin,
        });
        return;
      } catch (error) {
        if (isSingleDeviceSessionLockError(error)) {
          res.status(409).json({
            message: SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
            code: "session_active_on_another_device",
          });
          return;
        }
        console.error("Failed to issue bootstrap admin session", error);
        res.status(500).json({ message: "Admin created, but session could not be started." });
        return;
      }
    }

    let existingPendingRequest = getLatestPendingAccessRequestByEmail(normalizedEmail);
    if (!existingPendingRequest && isMySqlStateEnabled()) {
      const pendingFromDb = await getLatestPendingAccessRequestByEmailFromMySql(normalizedEmail);
      if (pendingFromDb) {
        accessRequestsById.set(pendingFromDb.id, pendingFromDb);
        existingPendingRequest = toPublicAccessRequest(pendingFromDb);
      }
    }
    if (existingPendingRequest) {
      res.status(200).json({
        ok: true,
        alreadyPending: true,
        message: "Access request already pending admin approval.",
        request: existingPendingRequest,
      });
      return;
    }

    const now = new Date().toISOString();
    const pendingUser = {
      ...buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName: normalizedCompanyName,
        role: normalizedRole,
        department,
        branch,
        phone,
      }),
      approvalStatus: "pending" as const,
    };

    const pendingPasswordHash = hashPassword(password);
    const pendingAuthRecord: AuthUserRecord = {
      user: pendingUser,
      passwordHash: pendingPasswordHash,
      legacyPasswordHash: hashLegacyDolibarrPassword(password),
      createdAt: existingRecord?.createdAt || now,
      updatedAt: now,
      approvalStatus: "pending",
    };
    setAuthUserRecord(pendingAuthRecord);

    const pendingRequest: AccessRequestRecord = {
      id: randomUUID(),
      name: pendingUser.name,
      email: pendingUser.email,
      requestedRole: pendingUser.role,
      approvedRole: null,
      requestedDepartment: pendingUser.department,
      requestedBranch: pendingUser.branch,
      requestedCompanyName: normalizedCompanyName,
      status: "pending",
      requestedAt: now,
      reviewedAt: null,
      reviewedById: null,
      reviewedByName: null,
      reviewComment: null,
      assignedCompanyIds: [],
      assignedManagerId: null,
      assignedManagerName: null,
      assignedStockistId: null,
      assignedStockistName: null,
      passwordHash: pendingPasswordHash,
    };
    accessRequestsById.set(pendingRequest.id, pendingRequest);
    try {
      await persistSecurePasswordHash(normalizedEmail, pendingPasswordHash);
      await insertAccessRequestInMySql(pendingRequest);
      await upsertAuthUserInMySql(pendingAuthRecord, normalizedCompanyName);
      try {
        const notification = buildAccessRequestNotification({
          requestId: pendingRequest.id,
          name: pendingUser.name,
          email: pendingUser.email,
        });
        await removeDuplicateAccessRequestNotifications(notification);
        await insertNotificationInMySql(notification);
      } catch (error) {
        console.error("Failed to persist access request notification", error);
      }
    } catch (error) {
      console.error("Failed to persist access request in MySQL", error);
      res.status(500).json({
        message:
          error instanceof Error
            ? `Failed to save access request in database: ${error.message}`
            : "Failed to save access request in database.",
      });
      return;
    }

    res.status(202).json({
      ok: true,
      message:
        "Signup request submitted. Your Dolibarr user is created in disabled state. Wait for admin approval before signing in.",
      request: toPublicAccessRequest(pendingRequest),
    });
  });

  app.get(
    "/api/admin/access-requests",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const parsedStatus = parseRequestStatus(firstString(req.query.status));
      if (firstString(req.query.status) && !parsedStatus) {
        res.status(400).json({ message: "Invalid access request status filter." });
        return;
      }

      void (async () => {
        if (isMySqlStateEnabled()) {
          try {
            const requests = await listAccessRequestsFromMySql(parsedStatus);
            res.json(requests.map(toPublicAccessRequest));
            return;
          } catch (error) {
            console.error("Failed to read access requests from MySQL", error);
          }
        }
        const requests = Array.from(accessRequestsById.values())
          .filter((entry: any) => !parsedStatus || entry.status === parsedStatus)
          .sort((a: any, b: any) => b.requestedAt.localeCompare(a.requestedAt))
          .map(toPublicAccessRequest);
        res.json(requests);
      })();
    }
  );

  app.post(
    "/api/admin/access-requests/:id/review",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requestId = firstString(req.params.id);
      if (!requestId) {
        res.status(400).json({ message: "Access request id is required." });
        return;
      }

      const body = req.body as {
        action?: "approved" | "rejected";
        role?: UserRole;
        companyIds?: unknown;
        companyProfiles?: unknown;
        managerId?: string;
        managerName?: string;
        stockistId?: string;
        stockistName?: string;
        comment?: string;
      };
      const action = body?.action;
      if (action !== "approved" && action !== "rejected") {
        res.status(400).json({ message: "Review action must be approved or rejected." });
        return;
      }

      let currentRequest = accessRequestsById.get(requestId) || null;
      if (!currentRequest && isMySqlStateEnabled()) {
        currentRequest = await getAccessRequestByIdFromMySql(requestId);
        if (currentRequest) {
          accessRequestsById.set(requestId, currentRequest);
        }
      }
      if (!currentRequest) {
        res.status(404).json({ message: "Access request not found." });
        return;
      }
      if (currentRequest.status !== "pending") {
        res.json(toPublicAccessRequest(currentRequest));
        return;
      }

      const now = new Date().toISOString();
      const approvedRole =
        action === "approved"
          ? normalizeRole(body?.role || currentRequest.requestedRole)
          : null;
      const finalRole = approvedRole || currentRequest.requestedRole;
      if (action === "approved" && finalRole === "admin") {
        const canApproveAdminRequest = await isDolibarrSuperuserReviewer(req);
        if (!canApproveAdminRequest) {
          res.status(403).json({
            message:
              "Admin access can only be approved by Dolibarr superuser (primary admin account).",
          });
          return;
        }
      }
      const isSalespersonApproval = action === "approved" && isSalesRole(finalRole);
      const assignedCompanyIds =
        action === "approved" ? normalizeCompanyIds(body?.companyIds) : [];
      let selectedCompaniesById = new Map<string, CompanyProfileSummary>();
      if (action === "approved") {
        if (assignedCompanyIds.length === 0) {
          res.status(400).json({ message: "Select at least one company before approval." });
          return;
        }
        selectedCompaniesById = parseCompanyProfilesState(body?.companyProfiles);
        const storedCompaniesById = await getCompanyProfilesByIds(assignedCompanyIds);
        for (const [companyId, company] of storedCompaniesById) {
          selectedCompaniesById.set(companyId, company);
        }
        const missingCompanyIds = assignedCompanyIds.filter(
          (companyId: string) => !selectedCompaniesById.has(companyId)
        );
        if (missingCompanyIds.length > 0) {
          res.status(400).json({ message: "One or more selected companies are invalid." });
          return;
        }
      }
      const assignedManagerId =
        action === "approved" && !isSalesRole(finalRole)
          ? normalizeWhitespace(typeof body?.managerId === "string" ? body.managerId : "") || null
          : null;
      const assignedManagerName =
        action === "approved" && !isSalesRole(finalRole)
          ? normalizeWhitespace(typeof body?.managerName === "string" ? body.managerName : "") ||
            null
          : null;
      const assignedStockistId =
        isSalespersonApproval
          ? normalizeWhitespace(typeof body?.stockistId === "string" ? body.stockistId : "") ||
            null
          : null;
      const assignedStockistName =
        isSalespersonApproval
          ? normalizeWhitespace(typeof body?.stockistName === "string" ? body.stockistName : "") ||
            null
          : null;
      const reviewComment = normalizeWhitespace(
        typeof body?.comment === "string" ? body.comment : ""
      );

      const normalizedEmail = normalizeEmail(currentRequest.email);
      let authRecord = authUsersByEmail.get(normalizedEmail);
      const pendingPasswordHash = currentRequest.passwordHash || null;
      if (!authRecord && action === "approved") {
        if (!pendingPasswordHash) {
          res.status(404).json({
            message: "User account request is missing credentials. Ask the user to sign up again.",
          });
          return;
        }
        const bootstrapUser = buildUserFromRegistration({
          name: currentRequest.name,
          email: normalizedEmail,
          companyName: normalizeCompanyName(currentRequest.requestedCompanyName || DEFAULT_COMPANY_NAME),
          role: currentRequest.requestedRole,
          department: currentRequest.requestedDepartment,
          branch: currentRequest.requestedBranch,
        });
        authRecord = {
          user: bootstrapUser,
          passwordHash: pendingPasswordHash,
          createdAt: currentRequest.requestedAt,
          updatedAt: now,
          approvalStatus: "pending",
        };
        setAuthUserRecord(authRecord);
      }

      let reviewedUser: AppUser | null = null;
      if (action === "approved") {
        const selectedPrimaryCompany = selectedCompaniesById.get(assignedCompanyIds[0]);
        if (!selectedPrimaryCompany) {
          res.status(400).json({ message: "Selected company is invalid." });
          return;
        }
        const effectiveCompanyId = selectedPrimaryCompany.id;
        const effectiveCompanyName = selectedPrimaryCompany.name;
        reviewedUser = {
          ...(authRecord?.user ?? buildUserFromRegistration({
            name: currentRequest.name,
            email: normalizedEmail,
            companyName: effectiveCompanyName,
            role: finalRole,
            department: currentRequest.requestedDepartment,
            branch: currentRequest.requestedBranch,
          })),
          role: finalRole,
          department:
            normalizeDepartmentForRole(finalRole, currentRequest.requestedDepartment),
          branch:
            normalizeWhitespace(currentRequest.requestedBranch) ||
            authRecord?.user.branch ||
            "Main Branch",
          companyId: effectiveCompanyId,
          companyName: effectiveCompanyName,
          companyIds: assignedCompanyIds,
          managerId: assignedManagerId || undefined,
          managerName: assignedManagerName || undefined,
          stockistId: assignedStockistId || undefined,
          stockistName: assignedStockistName || undefined,
          approvalStatus: "approved",
        };

        if (authRecord) {
          setAuthUserRecord({
            ...authRecord,
            user: reviewedUser,
            updatedAt: now,
            approvalStatus: "approved",
          });
        }
      } else {
        if (authRecord) {
          setAuthUserRecord({
            ...authRecord,
            user: {
              ...authRecord.user,
              approvalStatus: "rejected",
            },
            updatedAt: now,
            approvalStatus: "rejected",
          });
        }
      }

      const reviewedRequest: AccessRequestRecord = {
        ...currentRequest,
        approvedRole,
        status: action,
        reviewedAt: now,
        reviewedById: req.auth?.sub || null,
        reviewedByName: req.auth?.email || null,
        reviewComment: reviewComment || null,
        assignedCompanyIds,
        assignedManagerId,
        assignedManagerName,
        assignedStockistId,
        assignedStockistName,
        passwordHash: action === "approved" ? null : currentRequest.passwordHash ?? null,
      };
      accessRequestsById.set(requestId, reviewedRequest);
      try {
        const latestAuthRecord = getAuthUserByIdentifier(normalizedEmail);
        const fallbackAuthRecord =
          !latestAuthRecord && action === "approved" && reviewedUser
            ? ({
                user: {
                  ...reviewedUser,
                  approvalStatus: "approved",
                },
                passwordHash: pendingPasswordHash || "",
                createdAt: reviewedRequest.requestedAt,
                updatedAt: now,
                approvalStatus: "approved",
              } as AuthUserRecord)
            : null;
        const recordToPersist = latestAuthRecord || fallbackAuthRecord;
        if (recordToPersist) {
          await upsertAuthUserInMySql(
            recordToPersist,
            reviewedRequest.requestedCompanyName
          );
        }
        if (action === "approved" && reviewedUser?.role === "admin") {
          await forceDolibarrAdminPrivilegesForUserIdentity(reviewedUser);
        }
        await insertAccessRequestInMySql(reviewedRequest);
        if (action === "approved" && reviewedUser) {
          await syncWorkspaceGeofenceAccess(
            [
              reviewedUser.id,
              reviewedUser.id ? `dolibarr_${reviewedUser.id}` : "",
              reviewedUser.email,
              (reviewedUser as AppUser & { login?: string }).login || normalizeLoginKey(normalizedEmail.split("@")[0] || normalizedEmail),
            ],
            assignedCompanyIds,
          ).catch((error: unknown) => {
            console.warn("Workspace geofence sync after approval failed", error);
          });
        }
      } catch (error) {
        console.error("Failed to persist reviewed access request in MySQL", error);
        res.status(500).json({
          message:
            error instanceof Error
              ? `Approval saved locally, but database sync failed: ${error.message}`
              : "Approval saved locally, but database sync failed.",
        });
        return;
      }
      res.json(toPublicAccessRequest(reviewedRequest));
    }
  );

  app.post(
    "/api/admin/create-admin",
    requireAuth,
    requireRoles("admin"),
    async (req, res) => {
      const body = req.body as {
        name?: string;
        email?: string;
        password?: string;
        login?: string;
        companyName?: string;
        department?: string;
        branch?: string;
        phone?: string;
        systemAdministrator?: unknown;
      };

      const name = normalizeWhitespace(typeof body?.name === "string" ? body.name : "");
      const normalizedEmail = normalizeEmail(
        typeof body?.email === "string" ? body.email : ""
      );
      const password = typeof body?.password === "string" ? body.password : "";
      const loginInput = normalizeLoginKey(typeof body?.login === "string" ? body.login : "");
      const companyName = normalizeCompanyName(
        typeof body?.companyName === "string" && body.companyName.trim()
          ? body.companyName
          : DEFAULT_COMPANY_NAME
      );
      const department = normalizeWhitespace(
        typeof body?.department === "string" && body.department.trim()
          ? body.department
          : "Administration"
      );
      const branch = normalizeWhitespace(
        typeof body?.branch === "string" && body.branch.trim() ? body.branch : "Main Branch"
      );
      const phone = normalizeWhitespace(
        typeof body?.phone === "string" && body.phone.trim() ? body.phone : "+91 00000 00000"
      );
      const systemAdministrator = Boolean(body?.systemAdministrator);

      if (!name || !normalizedEmail || !password) {
        res.status(400).json({ message: "Name, email, and password are required." });
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        res.status(400).json({ message: "Invalid email format." });
        return;
      }
      const passwordError = passwordPolicyError(password);
      if (passwordError) {
        res.status(400).json({ message: passwordError });
        return;
      }

      const existingRecord = await checkAuthUserForSignup(normalizedEmail);
      if (existingRecord) {
        const existingStatus = resolveApprovalStatus(existingRecord);
        if (existingStatus === "approved") {
          res.status(409).json({ message: "User already exists for this email." });
          return;
        }
      }

      const now = new Date().toISOString();
      const createdUser = buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName,
        role: "admin",
        department,
        branch,
        phone,
      });

      const finalLogin = loginInput || buildLoginFromEmailAndName(normalizedEmail, name);
      const userToPersist: AppUser = {
        ...createdUser,
        login: finalLogin,
        companyName,
        companyId: getCompanyIdFromName(companyName),
        companyIds: [getCompanyIdFromName(companyName)],
        approvalStatus: "approved",
      };
      const authRecord: AuthUserRecord = {
        user: userToPersist,
        passwordHash: hashPassword(password),
        legacyPasswordHash: hashLegacyDolibarrPassword(password),
        createdAt: now,
        updatedAt: now,
        approvalStatus: "approved",
      };

      setAuthUserRecord(authRecord);
      try {
        await persistSecurePasswordHash(normalizedEmail, authRecord.passwordHash);
        await upsertAuthUserInMySql(authRecord, companyName, {
          systemAdministrator,
        });
        if (systemAdministrator) {
          await forceDolibarrAdminPrivilegesForUserIdentity(userToPersist);
        }
      } catch (error) {
        removeAuthUserByEmail(normalizedEmail);
        res.status(500).json({
          message:
            error instanceof Error
              ? `Unable to create admin account: ${error.message}`
              : "Unable to create admin account.",
        });
        return;
      }

      res.status(201).json({
        ok: true,
        user: userToPersist,
        systemAdministrator,
      });
    }
  );

  app.post("/api/auth/login", async (req, res) => {
    const { email, login, username, identifier, password, replaceSession } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
      replaceSession?: boolean;
    };
    const rawIdentifier =
      (identifier || "").trim() ||
      (email || "").trim() ||
      (login || "").trim() ||
      (username || "").trim();
    if (!rawIdentifier || !password) {
      res.status(400).json({ message: "Email/username and password are required" });
      return;
    }
    const attemptKey = loginAttemptKey(req, rawIdentifier);
    const lockRemainingMs = activeLoginLock(attemptKey);
    if (lockRemainingMs > 0) {
      const retryAfterSeconds = Math.ceil(lockRemainingMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ message: "Too many failed sign-in attempts. Try again later.", retryAfterSeconds });
      return;
    }

    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        clearFailedLogins(attemptKey);
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        clearFailedLogins(attemptKey);
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    } else if (rawIdentifier.includes("@")) {
      const normalizedEmail = normalizeEmail(rawIdentifier);
      let latestRequest = getLatestAccessRequestByEmail(normalizedEmail);
      if (!latestRequest && isMySqlStateEnabled()) {
        latestRequest = await getLatestAccessRequestByEmailFromMySql(normalizedEmail);
      }
      if (latestRequest?.passwordHash && matchesStoredPasswordHash(latestRequest.passwordHash, password)) {
        if (latestRequest.status === "pending") {
          clearFailedLogins(attemptKey);
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          clearFailedLogins(attemptKey);
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      recordFailedLogin(attemptKey);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    clearFailedLogins(attemptKey);

    const deviceId = resolveDeviceIdFromRequest(req);
    try {
      if (replaceSession === true) {
        await deactivateAuthSession(user.id);
      }
      const token = await issueDeviceScopedAuthToken(user, deviceId);
      res.json({ token, user });
    } catch (error) {
      if (isSingleDeviceSessionLockError(error)) {
        res.status(409).json({
          message: SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
          code: "session_active_on_another_device",
        });
        return;
      }
      console.error("Failed to issue login token", error);
      res.status(500).json({ message: "Unable to issue login token right now." });
    }
  });

  app.post("/api/auth/token", async (req, res) => {
    const { email, login, username, identifier, password, replaceSession } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
      replaceSession?: boolean;
    };
    const rawIdentifier =
      (identifier || "").trim() ||
      (email || "").trim() ||
      (login || "").trim() ||
      (username || "").trim();
    if (!rawIdentifier || !password) {
      res.status(400).json({ message: "Email/username and password are required" });
      return;
    }
    const attemptKey = loginAttemptKey(req, rawIdentifier);
    const lockRemainingMs = activeLoginLock(attemptKey);
    if (lockRemainingMs > 0) {
      const retryAfterSeconds = Math.ceil(lockRemainingMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ message: "Too many failed sign-in attempts. Try again later.", retryAfterSeconds });
      return;
    }
    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        clearFailedLogins(attemptKey);
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        clearFailedLogins(attemptKey);
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    } else if (rawIdentifier.includes("@")) {
      const normalizedEmail = normalizeEmail(rawIdentifier);
      let latestRequest = getLatestAccessRequestByEmail(normalizedEmail);
      if (!latestRequest && isMySqlStateEnabled()) {
        latestRequest = await getLatestAccessRequestByEmailFromMySql(normalizedEmail);
      }
      if (latestRequest?.passwordHash && matchesStoredPasswordHash(latestRequest.passwordHash, password)) {
        if (latestRequest.status === "pending") {
          clearFailedLogins(attemptKey);
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          clearFailedLogins(attemptKey);
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      recordFailedLogin(attemptKey);
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    clearFailedLogins(attemptKey);
    const deviceId = resolveDeviceIdFromRequest(req);
    try {
      if (replaceSession === true) {
        await deactivateAuthSession(user.id);
      }
      const token = await issueDeviceScopedAuthToken(user, deviceId);
      res.json({ token });
    } catch (error) {
      if (isSingleDeviceSessionLockError(error)) {
        res.status(409).json({
          message: SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
          code: "session_active_on_another_device",
        });
        return;
      }
      console.error("Failed to issue API token", error);
      res.status(500).json({ message: "Unable to issue API token right now." });
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req, res) => {
    const userId = req.auth?.sub || "";
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const bodyDeviceId = normalizeDeviceIdInput((req.body as { deviceId?: unknown } | undefined)?.deviceId);
    const headerDeviceId = normalizeDeviceIdInput(req.header("x-device-id"));
    const tokenDeviceId = normalizeDeviceIdInput(req.auth?.deviceId);
    const deviceId = bodyDeviceId || headerDeviceId || tokenDeviceId || null;
    const token = extractBearerTokenFromRequest(req);
    try {
      await deactivateAuthSession(userId, {
        deviceId,
        token: token || null,
      });
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to logout right now.";
      res.status(500).json({ message });
    }
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    const email = req.auth?.email;
    const userId = req.auth?.sub || "";
    if (!email || !userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    let activeSession = null;
    try {
      activeSession =
        typeof readActiveAuthSession === "function"
          ? await readActiveAuthSession(userId)
          : null;
    } catch (error) {
      // A temporary database outage is not proof that the user's session was
      // revoked. Returning 401 here made the mobile app erase its valid token
      // while the active device row remained in MySQL, producing the confusing
      // "already signed in" loop on the next login attempt.
      console.error("Unable to verify active auth session", error);
      res.status(503).json({ message: "Session verification is temporarily unavailable. Please retry." });
      return;
    }
    const tokenDeviceId = normalizeDeviceIdInput(req.auth?.deviceId);
    if (!activeSession || (tokenDeviceId && activeSession.deviceId !== tokenDeviceId)) {
      res.status(401).json({ message: "Session is no longer active. Please sign in again." });
      return;
    }
    await initAuthUsersStore();
    const identifier = email.endsWith("@dolibarr.local") ? email.split("@")[0] || email : email;
    const record =
      (await syncAuthUserCacheForEmail(identifier)) || getAuthUserByIdentifier(identifier);
    if (!record) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    const status = resolveApprovalStatus(record);
    if (status === "pending") {
      await deactivateAuthSession(userId, {
        deviceId: tokenDeviceId || null,
        token: extractBearerTokenFromRequest(req) || null,
      }).catch(() => undefined);
      res.status(403).json({ message: "Your access request is pending admin approval." });
      return;
    }
    if (status === "rejected") {
      await deactivateAuthSession(userId, {
        deviceId: tokenDeviceId || null,
        token: extractBearerTokenFromRequest(req) || null,
      }).catch(() => undefined);
      res.status(403).json({ message: "Your access request was rejected by admin." });
      return;
    }
    res.json({ user: record.user });
  });


}
