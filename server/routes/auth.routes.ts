import type { Express } from "express";
import type { AppUser, UserRole } from "@/lib/types";

type AuthUserRecord = any;
type AccessRequestRecord = any;
type CompanyProfileSummary = any;

export type AuthRouteDeps = Record<string, any>;

export function registerAuthRoutes(app: Express, deps: AuthRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    normalizeEmail,
    normalizeRole,
    normalizeCompanyName,
    checkAuthUserForSignup,
    resolveApprovalStatus,
    hasAnyApprovedAdmin,
    buildUserFromRegistration,
    hashPassword,
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
    syncStockistSalespersonAssignmentInMySql,
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

  app.post("/api/auth/register", async (req, res) => {
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
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }

    const normalizedRole = normalizeRole(role);
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const existingRecord = await checkAuthUserForSignup(normalizedEmail);
    if (existingRecord && resolveApprovalStatus(existingRecord) === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }

    const adminAlreadyExists = await hasAnyApprovedAdmin();
    if (normalizedRole === "admin" && adminAlreadyExists) {
      res.status(403).json({
        message:
          "An admin already exists. Ask an existing admin to approve additional admin access.",
      });
      return;
    }

    const user = buildUserFromRegistration({
      name,
      email: normalizedEmail,
      companyName: normalizedCompanyName,
      role: normalizedRole,
      department,
      branch,
      phone,
    });
    const now = new Date().toISOString();
    const authRecord: AuthUserRecord = {
      user,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved",
    };
    setAuthUserRecord(authRecord);
    try {
      await upsertAuthUserInMySql(authRecord, normalizedCompanyName);
      if (user.role === "admin") {
        await forceDolibarrAdminPrivilegesForUserIdentity(user);
      }
    } catch (error) {
      removeAuthUserByEmail(user.email);
      console.error("Failed to persist registered user in MySQL", error);
      res.status(500).json({
        message:
          error instanceof Error
            ? `Failed to save user in database: ${error.message}`
            : "Failed to save user in database.",
      });
      return;
    }

    const deviceId = resolveDeviceIdFromRequest(req);
    try {
      const token = await issueDeviceScopedAuthToken(user, deviceId);
      res.status(201).json({ token, user });
    } catch (error) {
      if (isSingleDeviceSessionLockError(error)) {
        res.status(409).json({
          message: SINGLE_DEVICE_SESSION_LOCK_MESSAGE,
          code: "session_active_on_another_device",
        });
        return;
      }
      console.error("Failed to issue auth token during registration", error);
      res.status(500).json({ message: "Unable to create login session right now." });
    }
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
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
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

    if (normalizedRole === "admin" && !adminAlreadyExists) {
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
        createdAt: existingRecord?.createdAt || now,
        updatedAt: now,
        approvalStatus: "approved",
      };
      setAuthUserRecord(authRecord);
      try {
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

      if (currentRequest.requestedRole === "admin") {
        const canApproveAdminRequest = await isDolibarrSuperuserReviewer(req);
        if (!canApproveAdminRequest) {
          res.status(403).json({
            message:
              "Admin access requests can only be approved by Dolibarr superuser (primary admin account).",
          });
          return;
        }
      }

      const now = new Date().toISOString();
      const approvedRole =
        action === "approved"
          ? normalizeRole(body?.role || currentRequest.requestedRole)
          : null;
      const finalRole = approvedRole || currentRequest.requestedRole;
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
        const reviewedSalespersonId =
          action === "approved" && reviewedUser ? reviewedUser.id : authRecord?.user.id || "";
        if (reviewedSalespersonId) {
          await syncStockistSalespersonAssignmentInMySql(
            reviewedSalespersonId,
            action === "approved" && isSalesRole(finalRole) ? assignedStockistId : null
          );
        }
        if (action === "approved" && reviewedUser?.role === "admin") {
          await forceDolibarrAdminPrivilegesForUserIdentity(reviewedUser);
        }
        await insertAccessRequestInMySql(reviewedRequest);
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
      if (password.length < 6) {
        res.status(400).json({ message: "Password must be at least 6 characters." });
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
        createdAt: now,
        updatedAt: now,
        approvalStatus: "approved",
      };

      setAuthUserRecord(authRecord);
      try {
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
    const { email, login, username, identifier, password } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
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

    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
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
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const deviceId = resolveDeviceIdFromRequest(req);
    try {
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
    const { email, login, username, identifier, password } = req.body as {
      email?: string;
      login?: string;
      username?: string;
      identifier?: string;
      password?: string;
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
    await initAuthUsersStore();
    const authRecord = getAuthUserByIdentifier(rawIdentifier);
    if (authRecord && matchesStoredPasswordHash(authRecord.passwordHash, password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
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
          res.status(403).json({ message: "Your access request is pending admin approval." });
          return;
        }
        if (latestRequest.status === "rejected") {
          res.status(403).json({ message: "Your access request was rejected by admin." });
          return;
        }
      }
    }
    const user = await authenticateCredentials(rawIdentifier, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    const deviceId = resolveDeviceIdFromRequest(req);
    try {
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
    const activeSession =
      typeof readActiveAuthSession === "function"
        ? await readActiveAuthSession(userId).catch(() => null)
        : null;
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
