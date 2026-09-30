import { randomUUID } from "node:crypto";
import { validCoordinates } from "@/lib/geofence";
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
    getRequestUser,
    normalizeCompanyIds,
    listGeofencesForUserResolved,
    listGeofencesForCompanyResolved,
    storage,
    upsertGeofenceInMySql,
  } = deps;

  app.get("/api/geofences", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const requestedCompanyId = firstString(req.query.companyId);
    const resolvedCompanyId = requestedCompanyId || await resolveRequestCompanyId(req);
    const user = getRequestUser(req);
    const allowedCompanyIds = normalizeCompanyIds([...(user?.companyIds || []), user?.companyId]);
    const canManageAnyCompany = user?.role === "admin";
    if (!resolvedCompanyId || (!canManageAnyCompany && !allowedCompanyIds.includes(resolvedCompanyId))) {
      res.status(403).json({ message: "Company access denied" });
      return;
    }
    try {
      const zones = await listGeofencesForCompanyResolved(resolvedCompanyId);
      res.json(zones);
    } catch (error) {
      console.error("Office geofence list failed", error);
      res.status(503).json({ message: "Office geofences could not be loaded." });
    }
  });

  app.get("/api/geofences/user/:id", requireAuth, async (req, res) => {
    const userId = firstString((req.params as Record<string, string>).id);
    if (!userId) {
      res.status(400).json({ message: "User id is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user geofence data" });
      return;
    }
    const companyId = await resolveRequestCompanyId(req);
    const requestUser = getRequestUser(req);
    const companyIds = normalizeCompanyIds([
      ...(requestUser?.companyIds || []),
      requestUser?.companyId,
      companyId,
    ]);
    const geofences = await listGeofencesForUserResolved(userId, {
      companyId,
      companyIds,
      role: req.auth?.role ?? null,
    });
    res.json(geofences);
  });

  for (const method of ["post", "put"] as const) {
    app[method](method === "post" ? "/api/geofences" : "/api/geofences/:id", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
      const patch = req.body as Partial<Geofence>;
      const id = method === "put" ? firstString((req.params as { id?: string }).id) : patch.id || randomUUID();
      if (!id || typeof id !== "string" || id.length > 64) { res.status(400).json({ message: "Invalid geofence id" }); return; }
      try {
        const current = await deps.getGeofenceById(id);
        if (method === "put" && !current) { res.status(404).json({ message: "Geofence not found" }); return; }
        const companyId = current?.companyId || patch.companyId || await resolveRequestCompanyId(req);
        const user = getRequestUser(req);
        const allowed = normalizeCompanyIds([...(user?.companyIds || []), user?.companyId]);
        const canManageAnyCompany = user?.role === "admin";
        if (
          !companyId ||
          (!canManageAnyCompany && !allowed.includes(companyId)) ||
          (patch.companyId && patch.companyId !== companyId)
        ) {
          res.status(403).json({ message: "Company access denied" }); return;
        }
        const now = new Date().toISOString();
        const zone: Geofence = {
          ...current, id, companyId, name: patch.name ?? current?.name ?? "",
          latitude: patch.latitude ?? current?.latitude ?? NaN,
          longitude: patch.longitude ?? current?.longitude ?? NaN,
          radiusMeters: patch.radiusMeters ?? current?.radiusMeters ?? 500,
          assignedEmployeeIds: patch.assignedEmployeeIds ?? current?.assignedEmployeeIds ?? [],
          isActive: patch.isActive ?? current?.isActive ?? true, allowOverride: false,
          workingHoursStart: patch.workingHoursStart === undefined ? current?.workingHoursStart : patch.workingHoursStart,
          workingHoursEnd: patch.workingHoursEnd === undefined ? current?.workingHoursEnd : patch.workingHoursEnd,
          createdAt: current?.createdAt || now, updatedAt: now,
        };
        const validTime = (time: unknown) => time == null || (typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
        if (typeof zone.name !== "string" || !zone.name.trim() || zone.name.length > 191 ||
            !validCoordinates(zone.latitude, zone.longitude) || !Number.isFinite(zone.radiusMeters) || zone.radiusMeters < 500 || zone.radiusMeters > 10000 ||
            !Array.isArray(zone.assignedEmployeeIds) || !zone.assignedEmployeeIds.every(id => typeof id === "string") ||
            typeof zone.isActive !== "boolean" || !validTime(zone.workingHoursStart) || !validTime(zone.workingHoursEnd)) {
          res.status(400).json({ message: "Invalid office coordinates, radius, schedule or assigned employees" }); return;
        }
        zone.radiusMeters = Math.round(zone.radiusMeters);
        if (deps.isMySqlStateEnabled()) await upsertGeofenceInMySql(zone);
        else if (current) await storage.updateGeofence(id, zone);
        else await storage.createGeofence(zone);
        res.status(method === "post" ? 201 : 200).json(zone);
      } catch (error) {
        console.error("Office location save failed", error);
        res.status(503).json({ message: "Office location could not be saved. Please retry." });
      }
    });
  }
}
