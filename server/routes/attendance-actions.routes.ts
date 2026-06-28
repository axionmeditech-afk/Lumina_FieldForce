import type { Express } from "express";
import type { AttendanceRecord, LocationLog } from "@/lib/types";

export type AttendanceActionRouteDeps = Record<string, any>;

export function registerAttendanceActionRoutes(app: Express, deps: AttendanceActionRouteDeps) {
  const {
    requireAuth,
    parseCheckPayload,
    ensureUserMatch,
    recordAnomaly,
    MAX_LOCATION_ACCURACY_METERS,
    MIN_LOCATION_SAMPLE_COUNT,
    parseIsoDate,
    isFreshDate,
    MAX_EVIDENCE_AGE_MS,
    MAX_CAPTURE_DRIFT_MS,
    storage,
    isMySqlStateEnabled,
    findActiveAttendanceInMySql,
    resolveRequestCompanyId,
    listGeofencesForUserResolved,
    resolveGeofenceStatus,
    storeAttendancePhoto,
    randomUUID,
    insertAttendanceInMySql,
    broadcastAttendanceUpdate,
    insertLocationLogInMySql,
    resolveDolibarrConfigForUser,
    syncAttendanceWithDolibarr,
  } = deps;

  app.post("/api/attendance/checkin", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }

    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on check-in (${payload.biometricFailureReason ?? "unknown"})`,
      });
      res.status(400).json({
        message: "Biometric verification is required for check-in.",
      });
      return;
    }

    if (
      typeof payload.locationAccuracyMeters !== "number" ||
      payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details:
          typeof payload.locationAccuracyMeters === "number"
            ? `Weak GPS accuracy on check-in: +/-${Math.round(payload.locationAccuracyMeters)}m`
            : "Missing GPS accuracy evidence on check-in",
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }

    if (
      typeof payload.locationSampleCount !== "number" ||
      payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on check-in (${payload.locationSampleCount ?? 0})`,
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }

    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }

    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client",
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }

    const bindResult = await storage.bindDevice(payload.userId, payload.deviceId);
    if (!bindResult.ok) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "device_mismatch",
        severity: "high",
        details: "Device binding mismatch detected on check-in",
      });
      res.status(403).json({ message: "Device mismatch detected" });
      return;
    }

    const existing = isMySqlStateEnabled()
      ? await findActiveAttendanceInMySql(payload.userId).catch(() => storage.findActiveAttendance(payload.userId))
      : await storage.findActiveAttendance(payload.userId);
    if (existing) {
      await recordAnomaly({
        attendanceId: existing.id,
        userId: payload.userId,
        type: "duplicate_checkin",
        severity: "medium",
        details: "Attempted duplicate check-in while already checked in",
      });
      res.status(409).json({ message: "User already checked in" });
      return;
    }

    const companyId = await resolveRequestCompanyId(req);
    const userZones = await listGeofencesForUserResolved(payload.userId, {
      companyId,
      role: req.auth?.role ?? null,
    });
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    const isEmployeeOfficeAttendance = req.auth?.role === "employee";
    const isFieldSalespersonAttendance = req.auth?.role === "salesperson";
    const allowOverride = isFieldSalespersonAttendance || (zoneStatus.activeZone?.allowOverride ?? false);
    const insideZone = zoneStatus.insideConfirmed || (isEmployeeOfficeAttendance && zoneStatus.inside);

    if (isEmployeeOfficeAttendance && userZones.length === 0) {
      res.status(400).json({
        message: "Company office location is not configured. Ask admin to set attendance location.",
      });
      return;
    }

    if (zoneStatus.inside && !zoneStatus.insideConfirmed && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "uncertain_geofence",
        severity: "medium",
        details:
          `Geofence boundary uncertainty on check-in. Distance ${Math.round(zoneStatus.distanceMeters)}m, ` +
          `buffer ${zoneStatus.confidenceBufferMeters}m`,
      });
    }

    if (!insideZone && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "outside_geofence",
        severity: "high",
        details:
          `Check-in attempted outside strict geofence. Distance: ${Math.round(zoneStatus.distanceMeters)}m, ` +
          `buffer: ${zoneStatus.confidenceBufferMeters}m`,
      });
      res.status(400).json({ message: "Outside geofence. Check-in denied." });
      return;
    }

    const photoUrl = payload.photoBase64
      ? await storeAttendancePhoto(
          payload.photoBase64,
          payload.photoMimeType ?? "image/jpeg",
          payload.userId,
          "checkin"
        )
      : null;

    const now = new Date().toISOString();
    const attendanceRecord: AttendanceRecord = {
      id: randomUUID(),
      userId: payload.userId,
      userName: payload.userName,
      companyId: companyId ?? undefined,
      type: "checkin",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: insideZone,
      notes: payload.notes,
      source: "mobile",
    };

    await storage.createAttendance(attendanceRecord);
    try {
      await insertAttendanceInMySql(attendanceRecord);
    } catch (error) {
      console.error("Failed to persist attendance check-in in MySQL", error);
    }
    broadcastAttendanceUpdate(attendanceRecord);
    const checkInLocationLog: LocationLog = {
      id: randomUUID(),
      companyId: companyId ?? undefined,
      userId: payload.userId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: null,
      speed: null,
      heading: null,
      geofenceId: attendanceRecord.geofenceId ?? null,
      geofenceName: attendanceRecord.geofenceName ?? null,
      isInsideGeofence: attendanceRecord.isInsideGeofence ?? false,
      capturedAt: now,
    };
    await storage.addLocationLog(checkInLocationLog);
    try {
      await insertLocationLogInMySql(checkInLocationLog);
    } catch (error) {
      console.error("Failed to persist check-in location log in MySQL", error);
    }

    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID(),
        attendanceId: attendanceRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: attendanceRecord.geofenceId ?? null,
        geofenceName: attendanceRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkin",
      });
    }

    const checkInDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(attendanceRecord, checkInDolibarrConfig);
    res.status(201).json(attendanceRecord);
  });

  app.post("/api/attendance/checkout", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }

    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on checkout (${payload.biometricFailureReason ?? "unknown"})`,
      });
      res.status(400).json({
        message: "Biometric verification is required for checkout.",
      });
      return;
    }

    if (
      typeof payload.locationAccuracyMeters !== "number" ||
      payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details:
          typeof payload.locationAccuracyMeters === "number"
            ? `Weak GPS accuracy on checkout: +/-${Math.round(payload.locationAccuracyMeters)}m`
            : "Missing GPS accuracy evidence on checkout",
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }

    if (
      typeof payload.locationSampleCount !== "number" ||
      payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT
    ) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on checkout (${payload.locationSampleCount ?? 0})`,
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }

    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }

    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client on checkout",
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }

    const active = isMySqlStateEnabled()
      ? await findActiveAttendanceInMySql(payload.userId).catch(() => storage.findActiveAttendance(payload.userId))
      : await storage.findActiveAttendance(payload.userId);
    if (!active) {
      res.status(400).json({ message: "No active check-in found for checkout" });
      return;
    }

    const companyId = await resolveRequestCompanyId(req);
    const userZones = await listGeofencesForUserResolved(payload.userId, {
      companyId,
      role: req.auth?.role ?? null,
    });
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    let now = new Date().toISOString();

    if (!zoneStatus.inside) {
      await recordAnomaly({
        attendanceId: active.id,
        userId: payload.userId,
        type: "checkout_outside_zone",
        severity: "medium",
        details: `Checkout performed outside zone at distance ${Math.round(zoneStatus.distanceMeters)}m`,
      });
    }

    const checkInDate = active.timestamp.split("T")[0];
    const logDate = now.split("T")[0];
    if (checkInDate !== logDate) {
      now = `${checkInDate}T23:59:59.000Z`;
    }

    const photoUrl = payload.photoBase64
      ? await storeAttendancePhoto(
          payload.photoBase64,
          payload.photoMimeType ?? "image/jpeg",
          payload.userId,
          "checkout"
        )
      : null;

    const checkoutRecord: AttendanceRecord = {
      id: randomUUID(),
      userId: payload.userId,
      userName: payload.userName,
      companyId: companyId ?? undefined,
      type: "checkout",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: zoneStatus.inside,
      notes: payload.notes,
      source: "mobile",
    };

    await storage.createAttendance(checkoutRecord);
    try {
      await insertAttendanceInMySql(checkoutRecord);
    } catch (error) {
      console.error("Failed to persist attendance check-out in MySQL", error);
    }
    broadcastAttendanceUpdate(checkoutRecord);
    const checkOutLocationLog: LocationLog = {
      id: randomUUID(),
      companyId: companyId ?? undefined,
      userId: payload.userId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: null,
      speed: null,
      heading: null,
      batteryLevel: null,
      geofenceId: checkoutRecord.geofenceId ?? null,
      geofenceName: checkoutRecord.geofenceName ?? null,
      isInsideGeofence: checkoutRecord.isInsideGeofence ?? false,
      capturedAt: now,
    };
    await storage.addLocationLog(checkOutLocationLog);
    try {
      await insertLocationLogInMySql(checkOutLocationLog);
    } catch (error) {
      console.error("Failed to persist check-out location log in MySQL", error);
    }
    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID(),
        attendanceId: checkoutRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: checkoutRecord.geofenceId ?? null,
        geofenceName: checkoutRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkout",
      });
    }

    const checkOutDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(checkoutRecord, checkOutDolibarrConfig);
    res.status(201).json(checkoutRecord);
  });


}
