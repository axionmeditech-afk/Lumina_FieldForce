import type { Express } from "express";

export type DolibarrRouteDeps = Record<string, any>;

export function registerDolibarrRoutes(app: Express, deps: DolibarrRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    firstString,
    resolveDolibarrProxyRule,
    forwardDolibarrRequest,
    resolveDolibarrConfigForUser,
    parseOptionalBoolean,
    syncApprovedUserToDolibarrEmployee,
  } = deps;

  app.all(/^\/api\/dolibarr\/proxy(\/.*)?$/, requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    const forwardPath = req.path.replace(/^\/api\/dolibarr\/proxy/, "");
    const ruleError = resolveDolibarrProxyRule(forwardPath, req.auth?.role);
    if (ruleError) {
      res.status(403).json({ message: ruleError });
      return;
    }

    await forwardDolibarrRequest(req, res, {
      userId,
      forwardPath,
    });
  });

  app.post(
    "/api/integrations/dolibarr/hrm/sync-employee",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requesterId = req.auth?.sub;
      if (!requesterId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }

      const body = req.body as {
        name?: unknown;
        email?: unknown;
        role?: unknown;
        employeeCategory?: unknown;
        department?: unknown;
        branch?: unknown;
        phone?: unknown;
        enabled?: unknown;
        endpoint?: unknown;
        apiKey?: unknown;
      };

      const name = firstString(body.name);
      const email = firstString(body.email).toLowerCase();
      const role = firstString(body.role) || null;
      const employeeCategory = firstString(body.employeeCategory);
      if (!name || !email) {
        res.status(400).json({ message: "name and email are required." });
        return;
      }

      const endpointOverride =
        typeof body.endpoint === "string"
          ? body.endpoint
          : body.endpoint === null
            ? null
            : undefined;
      const apiKeyOverride =
        typeof body.apiKey === "string"
          ? body.apiKey
          : body.apiKey === null
            ? null
            : undefined;
      const config = await resolveDolibarrConfigForUser(requesterId, {
        enabled: parseOptionalBoolean(body.enabled),
        endpoint: endpointOverride,
        apiKey: apiKeyOverride,
      });
      try {
        const result = await syncApprovedUserToDolibarrEmployee(
          {
            name,
            email,
            role,
            employeeCategory:
              employeeCategory === "on_field" || role === "salesperson" ? "on_field" : "fixed_location",
            department: firstString(body.department) || null,
            branch: firstString(body.branch) || null,
            phone: firstString(body.phone) || null,
          },
          {
            enabled: config.enabled,
            endpoint: config.endpoint,
            apiKey: config.apiKey,
          }
        );
        res.json(result);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unexpected failure while syncing employee to Dolibarr.";
        res.json({
          ok: false,
          status: "failed",
          message,
          dolibarrUserId: null,
          endpointUsed: null,
        });
      }
    }
  );


}
