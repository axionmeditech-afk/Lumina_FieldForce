import { MAX_AUTO_CHECKOUT_ACCURACY_METERS, evaluateAutoCheckoutExit } from "@/lib/geofence";
import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { AttendanceRecord } from "@/lib/types";
import { toMumbaiDateKey } from "@/lib/ist-time";
import { withAttendanceLock } from "../services/attendance-lock";
import { sendPushToCompanySupervisors } from "../services/push-notifications";

export type AttendanceActionRouteDeps = Record<string, any>;
const AUTO_CHECKOUT_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

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
          const fieldVisitEligibility =
            type === "checkin" && ["employee", "salesperson"].includes(req.auth?.role || "") && companyId && deps.getFieldVisitRemoteCheckInEligibility
              ? await deps.getFieldVisitRemoteCheckInEligibility(payload.userId, toMumbaiDateKey(new Date()), companyId, req.auth?.role || "employee")
              : { remoteCheckInAllowed: false, visitCount: 0 };
          const remoteFieldCheckIn = Boolean(fieldVisitEligibility.remoteCheckInAllowed && !zone.insideConfirmed);
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
          const maxAccuracyMeters = automatic ? MAX_AUTO_CHECKOUT_ACCURACY_METERS : deps.MAX_LOCATION_ACCURACY_METERS;
          if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > maxAccuracyMeters) {
            reject("Location accuracy is weak. Enable precise location, move near open sky and retry."); return;
          }
          const minimumSampleCount = automatic ? 2 : deps.MIN_LOCATION_SAMPLE_COUNT;
          if (!Number.isInteger(payload.locationSampleCount) || payload.locationSampleCount < minimumSampleCount) {
            reject("Stable GPS verification failed. Wait for lock and retry."); return;
          }
          if (automatic) {
            const sampleWindowMs = Number(payload.locationSampleWindowMs ?? 0);
            if (
              !Number.isFinite(sampleWindowMs) ||
              (payload.locationSampleCount < 3 && sampleWindowMs < 15_000)
            ) {
              reject("Automatic checkout needs a confirmed geofence exit window."); return;
            }
          }
          const capturedAt = deps.parseIsoDate(payload.capturedAtClient);
          const evidenceMaxAgeMs = automatic ? AUTO_CHECKOUT_MAX_EVIDENCE_AGE_MS : deps.MAX_EVIDENCE_AGE_MS;
          if (!capturedAt || !deps.isFreshDate(capturedAt, evidenceMaxAgeMs)) {
            reject("Stale attendance evidence. Please get a fresh GPS fix and retry."); return;
          }
          if (payload.mockLocationDetected) { reject("Mock location detected. Disable fake GPS and retry."); return; }
          let active = database
            ? await deps.findActiveAttendanceInMySql(payload.userId)
            : await deps.storage.findActiveAttendance(payload.userId);
          if (
            type === "checkin" &&
            active?.companyId &&
            companyId &&
            active.companyId !== companyId
          ) {
            const staleCheckoutId = deps.randomUUID ? deps.randomUUID() : randomUUID();
            const staleCheckout: AttendanceRecord = {
              id: staleCheckoutId,
              userId: payload.userId,
              userName: payload.userName,
              companyId: active.companyId,
              type: "checkout",
              timestamp: new Date().toISOString(),
              timestampServer: new Date().toISOString(),
              location: { lat: payload.latitude, lng: payload.longitude },
              geofenceId: active.geofenceId ?? null,
              geofenceName: active.geofenceName ?? null,
              deviceId: payload.deviceId,
              isInsideGeofence: false,
              notes: `System checkout: workspace changed from ${active.companyId} to ${companyId}; closing stale open session before new check-in.`,
              source: "manual",
              approvalStatus: "approved",
            };
            if (database) await deps.insertAttendanceInMySql(staleCheckout);
            else await deps.storage.createAttendance(staleCheckout);
            try { deps.broadcastAttendanceUpdate(staleCheckout); } catch { /* already committed */ }
            void Promise.resolve().then(async () => {
              const config = await deps.resolveDolibarrConfigForUser(staleCheckout.userId);
              await deps.syncAttendanceWithDolibarr(staleCheckout, config);
            }).catch(error => console.error("Attendance integration failed after stale checkout save", error));
            active = null;
          }
          if (type === "checkin" && active) {
            res.status(409).json({ message: "User already checked in", active }); return;
          }
          if (type === "checkout" && !active) { reject("No active check-in found for checkout"); return; }
          const manualCheckoutFromDifferentDevice =
            type === "checkout" &&
            !automatic &&
            Boolean(active?.deviceId) &&
            active.deviceId !== payload.deviceId;
          if (automatic) {
            const activeZone = zones.find((item: any) => item.id === active.geofenceId) ||
              (active.geofenceId && deps.getGeofenceById ? await deps.getGeofenceById(active.geofenceId) : null);
            const exitDecision = activeZone
              ? evaluateAutoCheckoutExit(activeZone, payload.latitude, payload.longitude, accuracy)
              : null;
            if (!req.auth?.deviceId || active.deviceId !== req.auth.deviceId || payload.activeAttendanceId !== active.id ||
                !activeZone || (active.companyId && activeZone.companyId !== active.companyId) || !exitDecision?.outside) {
              reject("Automatic checkout requires a verified exit from the active check-in office."); return;
            }
            if (capturedAt.getTime() < Date.parse(active.timestamp)) {
              reject("Checkout evidence predates the active check-in."); return;
            }
            const exitDate = toMumbaiDateKey(capturedAt);
            const protection = deps.hasFieldVisitAutoCheckoutProtection
              ? await deps.hasFieldVisitAutoCheckoutProtection(payload.userId, exitDate, active.companyId || companyId)
              : { protected: false, visitCount: 0 };
            if (protection.protected) {
              res.status(409).json({
                code: "FIELD_VISIT_DAY_PROTECTED",
                message: `${protection.visitCount} field visit${protection.visitCount === 1 ? " is" : "s are"} assigned for ${exitDate}. Attendance remains checked in while outside the office.`,
                attendanceActive: true,
                protectedDate: exitDate,
                visitCount: protection.visitCount,
              });
              void notifySupervisorsOfOfficeExit(deps, {
                idSeed: `protected-office-exit:${active.id}`,
                companyId: active.companyId || companyId || "",
                employeeId: payload.userId,
                employeeName: payload.userName,
                title: "Employee left office for field work",
                body: `${payload.userName} left the office geofence with ${protection.visitCount} field visit${protection.visitCount === 1 ? "" : "s"} assigned. Attendance remains active.`,
                kind: "office_exit_field_work",
                activeAttendanceId: active.id,
              });
              return;
            }
          }
          if (type === "checkin" && !zone.insideConfirmed && !remoteFieldCheckIn) {
            const remoteWindowMessage = req.auth?.role === "employee" && fieldVisitEligibility.reason === "not_open" && fieldVisitEligibility.remoteCheckInOpensAt
              ? `Remote field check-in opens at ${formatIstTime(fieldVisitEligibility.remoteCheckInOpensAt)}. Until then, check in inside your assigned office geofence.`
              : req.auth?.role === "employee" && fieldVisitEligibility.reason === "remote_window_expired"
                ? "The remote field check-in window has closed. Check in inside your assigned office geofence."
                : null;
            reject(remoteWindowMessage || (!zones.length ? "Company office location is not configured. Ask admin to set attendance location."
              : zone.inside ? "GPS is uncertain near the office boundary. Move further inside and retry."
              : "Outside geofence. Check-in denied.")); return;
          }
          // Keep the real server time for overnight shifts; never backdate a checkout.
          const now = new Date().toISOString();
          const eventTimestamp = automatic && capturedAt ? capturedAt.toISOString() : now;
          let notes = manualCheckoutFromDifferentDevice
            ? [
                payload.notes,
                `Manual checkout allowed from replacement device. Check-in device=${active.deviceId}; checkout device=${payload.deviceId}.`,
              ].filter(Boolean).join(" | ")
            : payload.notes;
          if (remoteFieldCheckIn) {
            notes = [
              notes,
              `Remote field check-in authorised by ${fieldVisitEligibility.visitCount} scheduled visit(s).`,
            ].filter(Boolean).join(" | ");
          }
          const record: AttendanceRecord = {
            id: recordId, userId: payload.userId, userName: payload.userName,
            companyId: (type === "checkout" ? active.companyId : zone.activeZone?.companyId) || companyId || undefined,
            type, timestamp: eventTimestamp, timestampServer: now,
            location: { lat: payload.latitude, lng: payload.longitude },
            geofenceId: type === "checkout" ? active.geofenceId : remoteFieldCheckIn ? null : zone.activeZone?.id || null,
            geofenceName: type === "checkout" ? active.geofenceName : remoteFieldCheckIn ? "Remote field-work start" : zone.activeZone?.name || null,
            deviceId: payload.deviceId, isInsideGeofence: remoteFieldCheckIn ? false : zone.insideConfirmed,
            notes, source: "mobile", approvalStatus: "approved",
          };
          // Durable persistence is the success boundary. Never fall back to memory on a DB failure.
          if (database) await deps.insertAttendanceInMySql(record);
          else await deps.storage.createAttendance(record);
          res.status(201).json(record);
          try { deps.broadcastAttendanceUpdate(record); } catch { /* already committed */ }
          if (automatic) {
            const activeZone = zones.find((item: any) => item.id === active?.geofenceId) ||
              (active?.geofenceId && deps.getGeofenceById ? await deps.getGeofenceById(active.geofenceId) : null);
            const exitDecision = activeZone
              ? evaluateAutoCheckoutExit(activeZone, payload.latitude, payload.longitude, accuracy)
              : null;
            if (exitDecision && exitDecision.outside) {
              const distance = Math.round(exitDecision.distanceMeters);
              void notifySupervisorsOfOfficeExit(deps, {
                idSeed: `automatic-office-exit:${record.id}`,
                companyId: active?.companyId || companyId || "",
                employeeId: record.userId,
                employeeName: record.userName,
                title: "Automatic checkout completed",
                body: `${record.userName} was automatically checked out after a verified office exit (${distance} m away).`,
                kind: "automatic_checkout",
                activeAttendanceId: active?.id || "",
                distanceMetres: distance,
              });
            }
          }
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

async function notifySupervisorsOfOfficeExit(
  deps: AttendanceActionRouteDeps,
  event: {
    idSeed: string;
    companyId: string;
    employeeId: string;
    employeeName: string;
    title: string;
    body: string;
    kind: string;
    activeAttendanceId: string;
    distanceMetres?: number;
  },
): Promise<void> {
  if (!event.companyId || !deps.insertNotificationInMySql) return;
  const notificationId = createHash("sha256").update(event.idSeed).digest("hex");
  try {
    // The deterministic ID is the cross-device/server retry dedupe boundary.
    // A duplicate event therefore cannot generate another supervisor push.
    const notification = {
      id: notificationId,
      companyId: event.companyId,
      title: event.title,
      body: event.body,
      kind: "alert",
      audience: "admin",
      createdById: event.employeeId,
      createdByName: event.employeeName,
      createdAt: new Date().toISOString(),
      readByIds: [],
      audienceUserIds: [],
    };
    const inserted = deps.insertNotificationIfAbsentInMySql
      ? await deps.insertNotificationIfAbsentInMySql(notification)
      : (await deps.insertNotificationInMySql(notification), true);
    if (!inserted) return;
  } catch (error) {
    // Duplicate notification IDs are expected when Android retries the same
    // geofence transition; suppress both the duplicate inbox item and push.
    console.warn("[attendance] supervisor office-exit notification skipped", error instanceof Error ? error.message : error);
    return;
  }
  if (!deps.getMySqlPool) return;
  try {
    await sendPushToCompanySupervisors(await deps.getMySqlPool(), {
      companyId: event.companyId,
      payload: {
        title: event.title,
        body: event.body,
        data: {
          screen: "field-tracking",
          kind: event.kind,
          employeeId: event.employeeId,
          activeAttendanceId: event.activeAttendanceId,
          ...(Number.isFinite(event.distanceMetres) ? { distanceMetres: event.distanceMetres } : {}),
        },
      },
    });
  } catch (error) {
    console.warn("[attendance] supervisor office-exit push failed", error instanceof Error ? error.message : error);
  }
}

function formatIstTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "the scheduled travel window";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
