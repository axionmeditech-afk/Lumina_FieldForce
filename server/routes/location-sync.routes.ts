import type { Express } from "express";
import type { AttendanceRecord, Geofence, LocationLog } from "@/lib/types";

export type LocationSyncRouteDeps = Record<string, any>;

const AUTO_CHECKOUT_ON_GEOFENCE_EXIT =
  (process.env.AUTO_CHECKOUT_ON_GEOFENCE_EXIT || "false").trim().toLowerCase() === "true";

export function registerLocationSyncRoutes(app: Express, deps: LocationSyncRouteDeps) {
  const {
    requireAuth,
    parseLocationSample,
    ensureUserMatch,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    resolveGeofenceStatus,
    randomUUID,
    storage,
    insertLocationLogInMySql,
    insertLocationLogsInMySql,
    isMySqlStateEnabled,
    findActiveAttendanceInMySql,
    insertAttendanceInMySql,
    resolveDolibarrConfigForUser,
    syncAttendanceWithDolibarr,
    insertNotificationInMySql,
    listAttendanceHistoryFromMySql,
    broadcastLocationUpdate,
    getRequestUser,
    upsertTrackingStatusInMySql,
  } = deps;

  app.post("/api/location/status", requireAuth, async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) {
      res.status(400).json({ message: "userId is required." });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized to update tracking status." });
      return;
    }
    const requestUser = typeof getRequestUser === "function" ? getRequestUser(req) : null;
    const companyId = (await resolveRequestCompanyId(req)) ?? requestUser?.companyId ?? null;
    const trackingStatus =
      typeof body.trackerStatus === "string"
        ? body.trackerStatus
        : typeof body.trackingStatus === "string"
          ? body.trackingStatus
          : "unknown";
    const queuedPointsRaw = Number(body.queuedPoints);
    const queuedPoints =
      Number.isFinite(queuedPointsRaw) && queuedPointsRaw >= 0 ? Math.trunc(queuedPointsRaw) : null;
    const lastClientSyncErrorAt =
      typeof body.lastClientSyncErrorAt === "string" ? body.lastClientSyncErrorAt : null;
    await upsertTrackingStatusInMySql?.({
      companyId,
      userId,
      trackingStatus,
      trackingStatusReason:
        typeof body.trackerStatusReason === "string"
          ? body.trackerStatusReason.slice(0, 500)
          : typeof body.trackingStatusReason === "string"
            ? body.trackingStatusReason.slice(0, 500)
            : null,
      queuedPoints,
      lastClientSyncErrorAt,
      updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : new Date().toISOString(),
    });
    res.status(202).json({ ok: true });
  });

  app.post("/api/location/log", requireAuth, async (req, res) => {
    const sample = parseLocationSample(req.body);
    if (!sample) {
      res.status(400).json({ message: "Invalid location payload" });
      return;
    }
    if (!ensureUserMatch(req, sample.userId)) {
      res.status(403).json({ message: "Not authorized to post location" });
      return;
    }
    const requestUser = typeof getRequestUser === "function" ? getRequestUser(req) : null;
    const companyId = (await resolveRequestCompanyId(req)) ?? requestUser?.companyId ?? null;
    const zones = await listGeofencesForUserResolved(sample.userId, {
      companyId,
      role: req.auth?.role ?? null,
    });
    const status = resolveGeofenceStatus(
      {
        userId: sample.userId,
        userName: "",
        latitude: sample.latitude,
        longitude: sample.longitude,
        deviceId: "",
        photoType: "checkin",
        isInsideGeofence: false,
      },
      zones
    );

    const log: LocationLog = {
      id: randomUUID(),
      companyId: companyId ?? undefined,
      userId: sample.userId,
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracy: sample.accuracy,
      speed: sample.speed,
      heading: sample.heading,
      batteryLevel: sample.batteryLevel ?? null,
      geofenceId: status.activeZone?.id ?? null,
      geofenceName: status.activeZone?.name ?? null,
      isInsideGeofence: status.inside,
      capturedAt: sample.capturedAt ?? new Date().toISOString(),
      trackingStatus: sample.trackerStatus ?? "active",
      trackingStatusReason: sample.trackerStatusReason ?? null,
      queuedPoints: sample.queuedPoints ?? null,
      lastClientSyncErrorAt: sample.lastClientSyncErrorAt ?? null,
    };
    await storage.addLocationLog(log);
    try {
      await insertLocationLogInMySql(log);
    } catch (error) {
      console.error("Failed to persist location log in MySQL", error);
    }
    broadcastLocationUpdate?.(log);
    res.status(201).json({ ok: true, inside: status.inside, zone: status.activeZone?.name ?? null });
  });

  app.post("/api/location/batch", requireAuth, async (req, res) => {
    const body = req.body as
      | { entries?: unknown[]; points?: unknown[]; samples?: unknown[] }
      | unknown[];
    const candidateEntries = Array.isArray(body)
      ? body
      : Array.isArray(body.entries)
        ? body.entries
        : Array.isArray(body.points)
          ? body.points
          : Array.isArray(body.samples)
            ? body.samples
            : [];

    if (!candidateEntries.length) {
      res.status(400).json({ message: "Location batch payload is empty." });
      return;
    }

    const parsedEntries = candidateEntries.map((entry) => parseLocationSample(entry));
    const invalidCount = parsedEntries.filter((entry) => !entry).length;
    const validEntries = parsedEntries.filter(
      (entry): entry is NonNullable<typeof entry> => Boolean(entry)
    );
    if (!validEntries.length) {
      res.status(400).json({ message: "No valid location points found in payload." });
      return;
    }

    const requestUser = typeof getRequestUser === "function" ? getRequestUser(req) : null;
    const companyId = (await resolveRequestCompanyId(req)) ?? requestUser?.companyId ?? null;
    const zoneCache = new Map<string, Geofence[]>();
    const activeAttendanceCache = new Map<string, AttendanceRecord | null>();
    const checkedInTodayCache = new Map<string, boolean>();
    const logsToPersist: LocationLog[] = [];
    let accepted = 0;
    for (const entry of validEntries) {
      if (!ensureUserMatch(req, entry.userId)) {
        res.status(403).json({ message: `Not authorized to post location for user ${entry.userId}` });
        return;
      }
      let zones = zoneCache.get(entry.userId);
      if (!zones) {
        zones = await listGeofencesForUserResolved(entry.userId, {
          companyId,
          role: req.auth?.role ?? null,
        });
        zones = zones ?? [];
        zoneCache.set(entry.userId, zones);
      }
      const resolvedZones = zones ?? [];
      const status = resolveGeofenceStatus(
        {
          userId: entry.userId,
          userName: "",
          latitude: entry.latitude,
          longitude: entry.longitude,
          deviceId: "",
          photoType: "checkin",
          isInsideGeofence: false,
        },
        resolvedZones
      );

      // --- Auto-checkout / reminder logic ---
      try {
        let activeAttendance = activeAttendanceCache.get(entry.userId);
        if (!activeAttendanceCache.has(entry.userId)) {
          activeAttendance = isMySqlStateEnabled()
            ? await findActiveAttendanceInMySql(entry.userId).catch(() => null)
            : await storage.findActiveAttendance(entry.userId);
          activeAttendanceCache.set(entry.userId, activeAttendance ?? null);
        }
        const autoCheckoutBlockedForRole =
          req.auth?.role === "salesperson" ||
          requestUser?.role === "salesperson" ||
          requestUser?.employeeCategory === "on_field";
        if (activeAttendance && AUTO_CHECKOUT_ON_GEOFENCE_EXIT && !autoCheckoutBlockedForRole) {
          // Verify that the location log was captured AFTER the active check-in
          const logTime = entry.capturedAt ? new Date(entry.capturedAt).getTime() : Date.now();
          const checkInTime = new Date(activeAttendance.timestamp).getTime();
          if (logTime > checkInTime) {
            // If checked in but now outside > 500m and GPS is accurate
            if (!status.inside && status.distanceMeters > 500 && (entry.accuracy ?? 2500) <= 2500) {
              let now = entry.capturedAt ?? new Date().toISOString();
              const checkInDate = activeAttendance.timestamp.split("T")[0];
              const logDate = now.split("T")[0];
              if (checkInDate !== logDate) {
                now = `${checkInDate}T23:59:59.000Z`;
              }
              const checkoutRecord: AttendanceRecord = {
                id: randomUUID(),
                userId: entry.userId,
                userName: activeAttendance.userName,
                companyId: activeAttendance.companyId,
                type: "checkout",
                timestamp: now,
                timestampServer: new Date().toISOString(),
                location: { lat: entry.latitude, lng: entry.longitude },
                geofenceId: activeAttendance.geofenceId,
                geofenceName: activeAttendance.geofenceName,
                photoUrl: null,
                deviceId: activeAttendance.deviceId,
                isInsideGeofence: false,
                source: "synced",
                notes: `Auto-checkout due to geofence exit (distance: ${Math.round(status.distanceMeters)}m, accuracy: ${Math.round(entry.accuracy ?? 0)}m)`,
                approvalStatus: "approved",
                approvalReviewedById: "system",
                approvalReviewedByName: "System",
                approvalReviewedAt: now,
              };
              await storage.createAttendance(checkoutRecord);
              if (isMySqlStateEnabled()) {
                try { await insertAttendanceInMySql(checkoutRecord); } catch(e){}
              }
              const dolibarrConfig = await resolveDolibarrConfigForUser(entry.userId);
              void syncAttendanceWithDolibarr(checkoutRecord, dolibarrConfig);

              const notification = {
                id: randomUUID(),
                title: "Auto-Checkout Executed",
                body: "You were automatically checked out for leaving the geofenced area.",
                kind: "alert" as const,
                audience: "all" as const,
                audienceUserIds: [entry.userId],
                readByIds: [] as string[],
                createdById: "system",
                createdByName: "System",
                createdAt: now,
              };
              try { await insertNotificationInMySql(notification); } catch(e){}
            }
          }
        } else {
          // --- Geofence Enter Notification ---
          if (status.distanceMeters <= 500) {
            const today = new Date().toISOString().split('T')[0];
            
            // Check if user already checked in today to prevent spam
            let hasCheckedInToday = checkedInTodayCache.get(entry.userId);
            if (hasCheckedInToday === undefined) {
              const history = isMySqlStateEnabled()
                ? await listAttendanceHistoryFromMySql(entry.userId).catch(() => [])
                : await storage.getAttendanceToday(entry.userId);
              hasCheckedInToday = history.some((a: AttendanceRecord) => a.type === "checkin" && a.timestamp.startsWith(today));
              checkedInTodayCache.set(entry.userId, Boolean(hasCheckedInToday));
            }
            
            if (!hasCheckedInToday) {
              const reminderId = `notif_checkin_reminder_${entry.userId}_${today}`;
              const now = new Date().toISOString();
              const notification = {
                id: reminderId,
                title: "Check-in Reminder",
                body: "You are near the office location. Please check in for the day.",
                kind: "alert" as const,
                audience: "all" as const,
                audienceUserIds: [entry.userId],
                readByIds: [] as string[],
                createdById: "system",
                createdByName: "System",
                createdAt: now,
              };
              try { await insertNotificationInMySql(notification); } catch (e) {}
            }
          }
        }
      } catch (error) {
        console.error("Failed auto-checkout / reminder logic", error);
      }
      // -----------------------------

      const log: LocationLog = {
        id: randomUUID(),
        companyId: companyId ?? undefined,
        userId: entry.userId,
        latitude: entry.latitude,
        longitude: entry.longitude,
        accuracy: entry.accuracy,
        speed: entry.speed,
        heading: entry.heading,
        batteryLevel: entry.batteryLevel ?? null,
        geofenceId: status.activeZone?.id ?? null,
        geofenceName: status.activeZone?.name ?? null,
        isInsideGeofence: status.inside,
        capturedAt: entry.capturedAt ?? new Date().toISOString(),
        trackingStatus: entry.trackerStatus ?? "active",
        trackingStatusReason: entry.trackerStatusReason ?? null,
        queuedPoints: entry.queuedPoints ?? null,
        lastClientSyncErrorAt: entry.lastClientSyncErrorAt ?? null,
      };
      await storage.addLocationLog(log);
      logsToPersist.push(log);
      accepted += 1;
    }

    try {
      await insertLocationLogsInMySql(logsToPersist);
    } catch (error) {
      console.error("Failed to persist location log batch in MySQL", error);
    }
    for (const log of logsToPersist) {
      broadcastLocationUpdate?.(log);
    }

    res.status(201).json({
      ok: true,
      accepted,
      rejected: invalidCount,
    });
  });


}
