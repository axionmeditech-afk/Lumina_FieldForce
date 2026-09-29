import { isConfidentlyOutside } from "@/lib/geofence";
import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { AttendanceRecord } from "@/lib/types";
import { withAttendanceLock } from "../services/attendance-lock";

export type AttendanceActionRouteDeps = Record<string, any>;

export function registerAttendanceActionRoutes(app: Express, deps: AttendanceActionRouteDeps) {
  for (const type of ["checkin", "checkout"] as const) {
    app.post(`/api/attendance/${type}`, deps.requireAuth, async (req, res) => {
      const payload = deps.parseCheckPayload(req);
      if (!payload || !Number.isFinite(payload.latitude) || Math.abs(payload.latitude) > 90 ||
          !Number.isFinite(payload.longitude) || Math.abs(payload.longitude) > 180) {
        res.status(400).json({ message: "Invalid attendance payload" }); return;
      }
      if (!deps.ensureUserMatch(req, payload.userId)) {
        res.status(403).json({ message: "Token user mismatch" }); return;
      }
      if (req.auth?.deviceId && req.auth.deviceId !== payload.deviceId) {
        res.status(403).json({ message: "Device mismatch detected" }); return;
      }
      // Use the authenticated identity, never a name or a client-supplied alias as the key.
      payload.userId = req.auth?.sub || payload.userId;
      const requestUser = deps.getRequestUser?.(req);
      payload.userName = requestUser?.name || payload.userName;
      const recordId = payload.requestId
        ? createHash("sha256").update(`${payload.userId}:${type}:${payload.requestId}`).digest("hex")
        : randomUUID();
      try {
          const companyId = await deps.resolveRequestCompanyId(req);
          const zones = await deps.listGeofencesForUserResolved(payload.userId, {
            companyId,
            companyIds: deps.normalizeCompanyIds?.([...(requestUser?.companyIds || []), requestUser?.companyId, companyId]) || [companyId],
            role: req.auth?.role,
          });
          const zone = deps.resolveGeofenceStatus(payload, zones);
        await deps.prepareAttendance?.();
        await (deps.withAttendanceLock || withAttendanceLock)(payload.userId, async () => {
          const database = deps.isMySqlStateEnabled();
          if (payload.requestId) {
            const prior = database
              ? await deps.getAttendanceByIdFromMySql(recordId)
              : await deps.storage.getAttendanceById(recordId);
            if (prior) { res.status(200).json(prior); return; }
          }
          const reject = (message: string) => { res.status(400).json({ message }); };
          const automatic = type === "checkout" && payload.actionSource === "geofence_exit";
          if (!automatic && !payload.biometricVerified) {
            reject("Identity verification is required for attendance."); return;
          }
          const accuracy = payload.locationAccuracyMeters;
          if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > deps.MAX_LOCATION_ACCURACY_METERS) {
            reject("Location accuracy is weak. Enable precise location, move near open sky and retry."); return;
          }
          if (!Number.isInteger(payload.locationSampleCount) || payload.locationSampleCount < deps.MIN_LOCATION_SAMPLE_COUNT) {
            reject("Stable GPS verification failed. Wait for lock and retry."); return;
          }
          const capturedAt = deps.parseIsoDate(payload.capturedAtClient);
          if (!capturedAt || !deps.isFreshDate(capturedAt, deps.MAX_EVIDENCE_AGE_MS)) {
            reject("Stale attendance evidence. Please get a fresh GPS fix and retry."); return;
          }
          if (payload.mockLocationDetected) { reject("Mock location detected. Disable fake GPS and retry."); return; }
          const active = database
            ? await deps.findActiveAttendanceInMySql(payload.userId)
            : await deps.storage.findActiveAttendance(payload.userId);
          if (type === "checkin" && active) {
            res.status(409).json({ message: "User already checked in", active }); return;
          }
          if (type === "checkout" && !active) { reject("No active check-in found for checkout"); return; }
          if (active?.deviceId && active.deviceId !== payload.deviceId) {
            res.status(403).json({ message: "Check out using the device used to check in." }); return;
          }
          if (automatic) {
            const activeZone = zones.find((item: any) => item.id === active.geofenceId);
            if (!req.auth?.deviceId || active.deviceId !== req.auth.deviceId || payload.activeAttendanceId !== active.id ||
                !activeZone || !isConfidentlyOutside(activeZone, payload.latitude, payload.longitude, accuracy)) {
              reject("Automatic checkout requires a verified exit from the active check-in office."); return;
            }
          }
          if (type === "checkin" && !zone.insideConfirmed) {
            reject(!zones.length ? "Company office location is not configured. Ask admin to set attendance location."
              : zone.inside ? "GPS is uncertain near the office boundary. Move further inside and retry."
              : "Outside geofence. Check-in denied."); return;
          }
          // Keep the real server time for overnight shifts; never backdate a checkout.
          const now = new Date().toISOString();
          const record: AttendanceRecord = {
            id: recordId, userId: payload.userId, userName: payload.userName,
            companyId: (type === "checkout" ? active.companyId : zone.activeZone?.companyId) || companyId || undefined,
            type, timestamp: now, timestampServer: now,
            location: { lat: payload.latitude, lng: payload.longitude },
            geofenceId: zone.activeZone?.id || null, geofenceName: zone.activeZone?.name || null,
            deviceId: payload.deviceId, isInsideGeofence: zone.insideConfirmed,
            notes: payload.notes, source: "mobile", approvalStatus: "approved",
          };
          // Durable persistence is the success boundary. Never fall back to memory on a DB failure.
          if (database) await deps.insertAttendanceInMySql(record);
          else await deps.storage.createAttendance(record);
          res.status(201).json(record);
          try { deps.broadcastAttendanceUpdate(record); } catch { /* already committed */ }
          void Promise.resolve().then(async () => {
            const config = await deps.resolveDolibarrConfigForUser(record.userId);
            await deps.syncAttendanceWithDolibarr(record, config);
          }).catch(error => console.error("Attendance integration failed after save", error));
        });
      } catch (error) {
        console.error("Attendance operation failed", error);
        if (!res.headersSent) res.status(503).json({ message: "Attendance could not be confirmed. Please retry the same action when the server is available." });
      }
    });
  }
}
