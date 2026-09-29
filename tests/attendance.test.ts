import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { registerAttendanceActionRoutes } from "../server/routes/attendance-actions.routes";
import { resolveGeofenceStatus } from "../server/services/attendance-guard";
import type { AttendanceRecord, Geofence } from "../lib/types";

process.env.MYSQL_HOST = "";

test("geofenced attendance accepts valid evidence, rejects invalid evidence, and allows checkout", async () => {
  const app = express();
  app.use(express.json());
  const records: AttendanceRecord[] = [];
  const office: Geofence = { id: "office_test", name: "Test office", companyId: "test", latitude: 23.02,
    longitude: 72.57, radiusMeters: 500, isActive: true, allowOverride: true,
    assignedEmployeeIds: ["employee"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let zones = [office];
  let databaseEnabled = false;
  let rejectDatabaseWrite = false;
  registerAttendanceActionRoutes(app, {
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.auth = { sub: "employee", deviceId: "device", role: "salesperson", email: "employee@example.test" } as typeof req.auth;
      next();
    },
    parseCheckPayload: (req: express.Request) => req.body,
    ensureUserMatch: (_req: express.Request, id: string) => id === "employee",
    recordAnomaly: async () => {}, MAX_LOCATION_ACCURACY_METERS: 120, MIN_LOCATION_SAMPLE_COUNT: 2,
    parseIsoDate: (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null,
    isFreshDate: (date: Date, limit: number) => Math.abs(Date.now() - date.getTime()) <= limit,
    MAX_EVIDENCE_AGE_MS: 120000, MAX_CAPTURE_DRIFT_MS: 120000,
    storage: {
      getAttendanceById: async (id: string) => records.find(record => record.id === id) || null,
      bindDevice: async () => ({ ok: true }),
      findActiveAttendance: async () => records.at(-1)?.type === "checkin" ? records.at(-1) : null,
      createAttendance: async (record: AttendanceRecord) => { records.push(record); return record; },
    },
    isMySqlStateEnabled: () => databaseEnabled,
    findActiveAttendanceInMySql: async () => records.at(-1)?.type === "checkin" ? records.at(-1) : null,
    getAttendanceByIdFromMySql: async (id: string) => records.find(record => record.id === id) || null,
    resolveRequestCompanyId: async () => "test",
    listGeofencesForUserResolved: async () => zones,
    resolveGeofenceStatus,
    randomUUID, insertAttendanceInMySql: async (record: AttendanceRecord) => { if (rejectDatabaseWrite) throw new Error("Simulated DB outage"); records.push(record); }, broadcastAttendanceUpdate: () => {},
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
    assert.equal(await post("checkin", { locationAccuracyMeters: -1 }), 400);
    assert.equal(await post("checkin", { latitude: 91 }), 400);
    assert.equal(await post("checkin", { deviceId: "another-device" }), 403);
    assert.equal(await post("checkin", { latitude: office.latitude + 0.00445, locationAccuracyMeters: 30 }), 400);
    assert.equal(await post("checkin", { capturedAtClient: "2000-01-01T00:00:00Z" }), 400);
    assert.equal(await post("checkin", { biometricVerified: false }), 400);
    assert.equal(await post("checkin", { userId: "someone-else" }), 403);
    assert.equal(records.length, 0);
    assert.equal(await post("checkin"), 201);
    assert.equal(await post("checkin"), 409);
    assert.equal(await post("checkout"), 201);
    assert.deepEqual(records.map(record => record.type), ["checkin", "checkout"]);
    assert.equal(await post("checkout"), 400);
    const requestId = "retry-same-request-12345";
    const statuses = await Promise.all([post("checkin", { requestId }), post("checkin", { requestId })]);
    assert.deepEqual(statuses.sort(), [200, 201]);
    assert.equal(records.length, 3, "retry must not add another check-in");
    const activeAttendanceId = records.at(-1)!.id;
    assert.equal(await post("checkout", { actionSource: "geofence_exit", activeAttendanceId, biometricVerified: false }), 400, "inside office must not auto-checkout");
    assert.equal(await post("checkout", { actionSource: "geofence_exit", activeAttendanceId: "old-session", biometricVerified: false, latitude: office.latitude + .01 }), 400);
    assert.equal(await post("checkout", { actionSource: "geofence_exit", activeAttendanceId, biometricVerified: false, latitude: office.latitude + .01 }), 201);
    const parallel = await Promise.all([post("checkin"), post("checkin")]);
    assert.deepEqual(parallel.sort(), [201, 409]);
    assert.equal(await post("checkout"), 201);
    databaseEnabled = true; rejectDatabaseWrite = true;
    const count = records.length;
    assert.equal(await post("checkin", { requestId: "database-failure-retry-123" }), 503);
    assert.equal(records.length, count, "failed durable writes must not create memory-only success");
    rejectDatabaseWrite = false;
    assert.equal(await post("checkin", { requestId: "database-failure-retry-123" }), 201);
    assert.equal(records.length, count + 1);
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


test("GPS evidence and client/server geofencing agree at uncertain boundaries", async () => {
  const { evaluateGeofenceStatus, isConfidentlyOutside } = await import("../lib/geofence");
  const { isUsableLocationSample } = await import("../lib/location-evidence");
  const office: Geofence = { id: "office", name: "Office", latitude: 0, longitude: 0, radiusMeters: 500, isActive: true, allowOverride: false, assignedEmployeeIds: [], createdAt: "", updatedAt: "" };
  assert.equal(evaluateGeofenceStatus([office], 0, 0, 10).insideConfirmed, true);
  assert.equal(evaluateGeofenceStatus([office], .0044, 0, 30).insideConfirmed, false);
  assert.equal(evaluateGeofenceStatus([office], 0, 0).insideConfirmed, false);
  assert.equal(evaluateGeofenceStatus([office], 0, 0, -5).insideConfirmed, false);
  const near = { ...office, id: "near", latitude: .0088, radiusMeters: 500 };
  const containing = { ...office, id: "containing", latitude: 0, radiusMeters: 1000 };
  assert.equal(evaluateGeofenceStatus([containing, near], .0044, 0, 40).activeZone?.id, "containing");
  assert.equal(isConfidentlyOutside(office, .0046, 0, 30), false);
  assert.equal(isConfidentlyOutside(office, .006, 0, 20), true);
  const now = Date.now();
  const sample = { timestamp: now, coords: { latitude: 0, longitude: 0, accuracy: 10 } };
  assert.equal(isUsableLocationSample(sample, now), true);
  assert.equal(isUsableLocationSample({ ...sample, timestamp: now - 300000 }, now), false);
  assert.equal(isUsableLocationSample({ ...sample, mocked: true }, now), false);
});


test("only the intended app pages exist and removed animations cannot return silently", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const routes = (await readdir("app/(tabs)")).sort();
  assert.deepEqual(routes, ["_layout.tsx", "account.tsx", "attendance.tsx", "index.tsx"]);
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.dependencies.lenis, undefined);
  for (const file of ["app/(tabs)/index.tsx", "app/(tabs)/_layout.tsx", "app/login.tsx", "components/StartScreen.tsx"]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /lenis|Animated\.|getTasks|getExpenses|getConversations|@react-navigation\//, file);
  }
});


test("employees with the same name remain separate in the attendance roster", async () => {
  const { dedupeAttendanceRosterMembers } = await import("../lib/attendance-roster");
  const people = [{ id: "one", name: "Same Name", email: "one@example.test", role: "employee" }, { id: "two", name: "Same Name", email: "two@example.test", role: "employee" }];
  assert.equal(dedupeAttendanceRosterMembers(people).length, 2);
});
