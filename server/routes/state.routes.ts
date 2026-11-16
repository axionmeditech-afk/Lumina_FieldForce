import type { Express } from "express";

export type StateRouteDeps = Record<string, any>;

export function registerStateRoutes(app: Express, deps: StateRouteDeps) {
  const {
    requireAuth,
    firstString,
    isRemoteStateKeyAllowed,
    isMySqlStateEnabled,
    readCompanyScopedRemoteState,
    resolveRequestCompanyId,
    writeCompanyScopedRemoteState,
    getRequestUser,
    normalizeWhitespace,
  } = deps;

  const resolveAuthorizedCompanyScope = async (req: any): Promise<string | null> => {
    const requestedCompanyId = normalizeWhitespace(firstString(req.query?.companyId));
    const defaultCompanyId = normalizeWhitespace(await resolveRequestCompanyId(req));
    const requestUser = getRequestUser(req);
    const allowedCompanyIds = new Set(
      [
        ...(Array.isArray(requestUser?.companyIds) ? requestUser.companyIds : []),
        requestUser?.companyId,
        defaultCompanyId,
      ]
        .map((companyId) => normalizeWhitespace(companyId || ""))
        .filter(Boolean),
    );
    if (requestedCompanyId) {
      if (!allowedCompanyIds.has(requestedCompanyId)) return null;
      return requestedCompanyId;
    }
    return defaultCompanyId && allowedCompanyIds.has(defaultCompanyId) ? defaultCompanyId : null;
  };

  app.get("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }

    try {
      const companyId = await resolveAuthorizedCompanyScope(req);
      if (!companyId) {
        res.status(403).json({ message: "You are not authorized for this company state." });
        return;
      }

      const rawValue = await readCompanyScopedRemoteState(key, companyId);
      if (!rawValue) {
        res.json({
          key,
          value: null,
          updatedAt: null,
          source: isMySqlStateEnabled() ? "mysql" : "memory",
        });
        return;
      }

      let parsedValue: unknown = null;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        parsedValue = null;
      }

      if (Array.isArray(parsedValue) && req.auth?.role !== "admin" && req.auth?.role !== "hr" && req.auth?.role !== "manager") {
        if (key === "@trackforce_audit_logs") {
          parsedValue = parsedValue.filter(item => item && typeof item === 'object' && item.userId === req.auth?.sub);
        } else if (key === "@trackforce_support_threads") {
          parsedValue = parsedValue.filter(item => item && typeof item === 'object' && item.requestedById === req.auth?.sub);
        }
      }

      res.json({
        key,
        value: parsedValue,
        updatedAt: new Date().toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to read remote state value.";
      res.status(500).json({ message });
    }
  });


  app.put("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }

    if (key === "@trackforce_attendance" || key === "@trackforce_geofences") {
      res.status(403).json({ message: "Use the validated attendance and geofence endpoints." });
      return;
    }

    const body = req.body as { value?: unknown };
    if (!("value" in (body || {}))) {
      res.status(400).json({ message: "State value is required." });
      return;
    }

    try {
      const companyId = await resolveAuthorizedCompanyScope(req);
      if (!companyId) {
        res.status(403).json({ message: "You are not authorized for this company state." });
        return;
      }
      await writeCompanyScopedRemoteState(key, companyId, body.value ?? null, getRequestUser(req));

      res.json({
        ok: true,
        key,
        updatedAt: new Date().toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to persist remote state value.";
      res.status(500).json({ message });
    }
  });


}
