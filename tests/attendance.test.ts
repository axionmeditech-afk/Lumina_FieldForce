import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { registerAttendanceActionRoutes } from "../server/routes/attendance-actions.routes";
import { resolveGeofenceStatus } from "../server/services/attendance-guard";
import type { AttendanceRecord, Geofence } from "../lib/types";

test("geofenced attendance accepts valid evidence, rejects invalid evidence, and allows checkout", async () => {
  const app = express();
  app.use(express.json());
  const records: AttendanceRecord[] = [];
  const office: Geofence = { id: "office_test", name: "Test office", companyId: "test", latitude: 23.02,
    longitude: 72.57, radiusMeters: 500, isActive: true, allowOverride: true,
    assignedEmployeeIds: ["employee"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let zones = [office];
  registerAttendanceActionRoutes(app, {
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { sub: "employee", role: "salesperson", email: "employee@example.test" } as typeof req.auth;
      next();
    },
    parseCheckPayload: (req: express.Request) => req.body,
    ensureUserMatch: (_req: express.Request, id: string) => id === "employee",
    recordAnomaly: async () => {}, MAX_LOCATION_ACCURACY_METERS: 120, MIN_LOCATION_SAMPLE_COUNT: 2,
    parseIsoDate: (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null,
    isFreshDate: (date: Date, limit: number) => Math.abs(Date.now() - date.getTime()) <= limit,
    MAX_EVIDENCE_AGE_MS: 120000, MAX_CAPTURE_DRIFT_MS: 120000,
    storage: {
      bindDevice: async () => ({ ok: true }),
      findActiveAttendance: async () => records.at(-1)?.type === "checkin" ? records.at(-1) : null,
      createAttendance: async (record: AttendanceRecord) => { records.push(record); return record; },
    },
    isMySqlStateEnabled: () => false,
    resolveRequestCompanyId: async () => "test",
    listGeofencesForUserResolved: async () => zones,
    resolveGeofenceStatus,
    randomUUID, insertAttendanceInMySql: async () => {}, broadcastAttendanceUpdate: () => {},
    resolveDolibarrConfigForUser: async () => null, syncAttendanceWithDolibarr: async () => {},
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const payload = { userId: "employee", userName: "Employee", deviceId: "device", latitude: office.latitude,
    longitude: office.longitude, capturedAtClient: new Date().toISOString(), locationAccuracyMeters: 10,
    locationSampleCount: 2, biometricRequired: true, biometricVerified: true };
  const post = async (action: string, overrides: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/attendance/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, ...overrides }),
    });
    await response.json();
    return response.status;
  };
  try {
    // A legacy salesperson or allowOverride zone must not bypass geofencing.
    assert.equal(await post("checkin", { latitude: office.latitude + 1 }), 400);
    zones = [];
    assert.equal(await post("checkin"), 400);
    zones = [office];
    assert.equal(await post("checkin", { mockLocationDetected: true }), 400);
    assert.equal(await post("checkin", { locationAccuracyMeters: 200 }), 400);
    assert.equal(await post("checkin", { capturedAtClient: "2000-01-01T00:00:00Z" }), 400);
    assert.equal(await post("checkin", { biometricVerified: false }), 400);
    assert.equal(await post("checkin", { userId: "someone-else" }), 403);
    assert.equal(records.length, 0);
    assert.equal(await post("checkin"), 201);
    assert.equal(await post("checkin"), 409);
    assert.equal(await post("checkout"), 201);
    assert.deepEqual(records.map(record => record.type), ["checkin", "checkout"]);
    assert.equal(await post("checkout"), 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("attendance build exposes no removed feature APIs", async () => {
  // This smoke check uses memory only; it must never open the configured production database.
  process.env.MYSQL_HOST = "";
  const { registerRoutes } = await import("../server/routes");
  const app = express();
  app.use(express.json());
  const server = await registerRoutes(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    for (const route of ["/api/location/latest", "/api/location/batch", "/api/salaries", "/api/stockists", "/api/collective-leaves", "/api/mappls/route/preview"]) {
      for (const method of ["GET", "POST"]) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method });
        assert.equal(response.status, 404, `${method} ${route}`);
        await response.text();
      }
    }
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(health.status, 200);
    const result = await health.json() as { mysqlStateEnabled: boolean };
    assert.equal(result.mysqlStateEnabled, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
