import type { Express } from "express";
import type { Geofence } from "@/lib/types";

export type GeofenceRouteDeps = Record<string, any>;

export function registerGeofenceRoutes(app: Express, deps: GeofenceRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    firstString,
    ensureUserMatch,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    storage,
    upsertGeofenceInMySql,
  } = deps;

  app.get("/api/geofences/user/:id", requireAuth, async (req, res) => {
    const userId = firstString(req.params.id);
    if (!userId) {
      res.status(400).json({ message: "User id is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user geofence data" });
      return;
    }
    const companyId = await resolveRequestCompanyId(req);
    const geofences = await listGeofencesForUserResolved(userId, {
      companyId,
      role: req.auth?.role ?? null,
    });
    res.json(geofences);
  });

  app.post("/api/geofences", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const payload = req.body as Partial<Geofence>;
    if (!payload.name || typeof payload.latitude !== "number" || typeof payload.longitude !== "number") {
      res.status(400).json({ message: "Missing mandatory geofence fields" });
      return;
    }
    const defaultCompanyId = await resolveRequestCompanyId(req);
    const created = await storage.createGeofence({
      ...payload,
      companyId: payload.companyId ?? defaultCompanyId ?? undefined,
      radiusMeters: Math.max(500, Math.round(payload.radiusMeters || 500)),
      allowOverride: payload.allowOverride ?? false,
      isActive: payload.isActive ?? true,
    });
    try {
      await upsertGeofenceInMySql(created);
    } catch (error) {
      console.error("Failed to persist geofence in MySQL", error);
    }
    res.status(201).json(created);
  });

  app.put("/api/geofences/:id", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const geofenceId = firstString(req.params.id);
    if (!geofenceId) {
      res.status(400).json({ message: "Geofence id is required" });
      return;
    }
    const defaultCompanyId = await resolveRequestCompanyId(req);
    const patch = req.body as Partial<Geofence>;
    const updated = await storage.updateGeofence(geofenceId, {
      ...patch,
      companyId: patch.companyId ?? defaultCompanyId ?? undefined,
      radiusMeters:
        typeof patch.radiusMeters === "number"
          ? Math.max(500, Math.round(patch.radiusMeters))
          : patch.radiusMeters,
    });
    if (!updated) {
      res.status(404).json({ message: "Geofence not found" });
      return;
    }
    try {
      await upsertGeofenceInMySql(updated);
    } catch (error) {
      console.error("Failed to update geofence in MySQL", error);
    }
    res.json(updated);
  });


}
