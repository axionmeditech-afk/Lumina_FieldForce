import type { Express } from "express";

export type StateRouteDeps = Record<string, any>;

export function registerStateRoutes(app: Express, deps: StateRouteDeps) {
  const {
    requireAuth,
    firstString,
    isRemoteStateKeyAllowed,
    isLocationLogStateKey,
    listLocationLogsFromMySql,
    REMOTE_LOCATION_LOG_READ_LIMIT,
    REMOTE_LOCATION_LOG_WRITE_LIMIT,
    isMySqlStateEnabled,
    readRemoteState,
    resolveRequestCompanyId,
    withDefaultCompanyIdForRemoteState,
    writeRemoteState,
    getRequestUser,
    getMySqlPool,
    authUsersByEmail,
    randomUUID,
    insertNotificationInMySql,
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
      if (isLocationLogStateKey(key)) {
        const value = await listLocationLogsFromMySql(REMOTE_LOCATION_LOG_READ_LIMIT);
        res.json({
          key,
          value,
          updatedAt: new Date().toISOString(),
          source: isMySqlStateEnabled() ? "mysql" : "memory",
          truncated: true,
          limit: REMOTE_LOCATION_LOG_READ_LIMIT,
        });
        return;
      }

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
      if (isLocationLogStateKey(key)) {
        const candidateValue = body.value;
        const entries = Array.isArray(candidateValue) ? candidateValue : [];
        if (entries.length > REMOTE_LOCATION_LOG_WRITE_LIMIT) {
          res.status(413).json({
            message:
              "Location log state payload is too large for remote state sync. Use /api/location/batch instead.",
            limit: REMOTE_LOCATION_LOG_WRITE_LIMIT,
            received: entries.length,
          });
          return;
        }
      }

      const defaultCompanyId = await resolveRequestCompanyId(req);
      const scopedValue = withDefaultCompanyIdForRemoteState(
        key,
        body.value ?? null,
        defaultCompanyId
      );
      const serialized = JSON.stringify(scopedValue ?? null);
      await writeRemoteState(key, serialized, getRequestUser(req));
      
      // --- GPS Disabled Alert Logic ---
      if (key === "@trackforce_attendance_anomalies" && Array.isArray(scopedValue)) {
        try {
          const conn = await getMySqlPool();
          for (const anom of scopedValue) {
            if (anom && anom.type === "gps_disabled" && anom.id) {
              const [existing] = await conn.query("SELECT id FROM lff_notifications WHERE title = ? AND body LIKE ?", ["GPS Disabled Alert", `%${anom.id}%`]);
              if (!existing || existing.length === 0) {
                let employeeName = anom.userId;
                for (const r of authUsersByEmail.values()) {
                  if (r.user.id === anom.userId) {
                    employeeName = r.user.name || r.user.login || anom.userId;
                    break;
                  }
                }
                const notif = {
                  id: randomUUID(),
                  title: "GPS Disabled Alert",
                  body: `Employee ${employeeName} has disabled GPS or Location Services during check-in. Anomaly: ${anom.id}`,
                  kind: "alert" as const,
                  audience: "all" as const,
                  audienceUserIds: [] as string[],
                  readByIds: [] as string[],
                  createdById: "system",
                  createdByName: "System",
                  createdAt: new Date().toISOString(),
                };
                await insertNotificationInMySql(notif);
              }
            }
          }
        } catch (e) {
          console.error("Failed to generate GPS disabled alert", e);
        }
      }
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
