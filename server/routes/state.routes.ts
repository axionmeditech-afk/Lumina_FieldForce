import type { Express } from "express";

export type StateRouteDeps = Record<string, any>;

export function registerStateRoutes(app: Express, deps: StateRouteDeps) {
  const {
    requireAuth,
    firstString,
    isRemoteStateKeyAllowed,
    isMySqlStateEnabled,
    readRemoteState,
    resolveRequestCompanyId,
    withDefaultCompanyIdForRemoteState,
    writeRemoteState,
    getRequestUser,
  } = deps;

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

      const rawValue = await readRemoteState(key);
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

    const body = req.body as { value?: unknown };
    if (!("value" in (body || {}))) {
      res.status(400).json({ message: "State value is required." });
      return;
    }

    try {

      const defaultCompanyId = await resolveRequestCompanyId(req);
      const scopedValue = withDefaultCompanyIdForRemoteState(
        key,
        body.value ?? null,
        defaultCompanyId
      );
      const serialized = JSON.stringify(scopedValue ?? null);
      await writeRemoteState(key, serialized, getRequestUser(req));
      // --------------------------------

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
