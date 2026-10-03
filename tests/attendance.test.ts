import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { registerAttendanceActionRoutes } from "../server/routes/attendance-actions.routes";
import { resolveGeofenceStatus } from "../server/services/attendance-guard";
import type { AttendanceRecord, Geofence } from "../lib/types";

process.env.MYSQL_HOST = "";

// Run the actual mobile orchestration with native adapters replaced in memory.
// No device, production credentials, or database is used by these regressions.
async function mobileModule(entry: string, mocks: Record<string, any>, globals: Record<string, any> = {}) {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    plugins: [{ name: "native-test-adapters", setup(build) {
      build.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, external: true } : undefined);
    } }],
  });
  const module = { exports: {} as any };
  runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: (name: string) => {
      if (!(name in mocks)) throw new Error("Unexpected native dependency: " + name);
      return mocks[name];
    }, console: { ...console, warn: () => {} }, __DEV__: false, URL, AbortController, setTimeout, clearTimeout,
    process: { env: {} }, ...globals,
  });
  return module.exports;
}

test("background exit submits while stationary and survives offline restart without losing confirmed evidence", async () => {
  const data = new Map<string, string>();
  const tasks = new Map<string, (event: any) => Promise<void>>();
  const clock = Date.now();
  const zone = { id: "office", companyId: "company", name: "Office", latitude: 23, longitude: 72,
    radiusMeters: 500, isActive: true, updatedAt: "v1" };
  const active = { id: "shift", userId: "employee", deviceId: "device", geofenceId: "office",
    timestamp: new Date(clock - 3600000).toISOString() };
  let networkWorks = false;
  let requests = 0;
  let savedRecords = 0;
  let pendingNotifications = 0;
  let checkedIn = true;
  let watchdogOptions: any;
  let watchdogStarts = 0;
  let lastPayload: any;
  const runtime = await mobileModule("lib/attendance-background.ts", {
    "expo-task-manager": { defineTask: (name: string, task: any) => tasks.set(name, task), isAvailableAsync: async () => true },
    "expo-location": {
      Accuracy: { High: 4 }, GeofencingEventType: { Enter: 1, Exit: 2 },
      getForegroundPermissionsAsync: async () => ({ granted: true }),
      getBackgroundPermissionsAsync: async () => ({ granted: true }),
      hasStartedGeofencingAsync: async () => true, hasStartedLocationUpdatesAsync: async () => true,
      stopGeofencingAsync: async () => {}, stopLocationUpdatesAsync: async () => {},
      startGeofencingAsync: async () => {}, startLocationUpdatesAsync: async (_: string, options: any) => { watchdogOptions = options; watchdogStarts++; },
    },
    "expo-constants": { appOwnership: "standalone" }, "react-native": { Platform: { OS: "android" } },
    "@react-native-async-storage/async-storage": {
      getItem: async (key: string) => data.get(key) || null, setItem: async (key: string, value: string) => { data.set(key, value); },
      removeItem: async (key: string) => { data.delete(key); },
    },
    "./storage": {
      getCurrentUser: async () => ({ id: "employee", name: "Employee" }), getApiToken: async () => "token",
      getOrCreateDeviceId: async () => "device", addAttendance: async () => { savedRecords++; },
      setCheckedIn: async (value: boolean) => { checkedIn = value; },
    },
    "./attendance-api": {
      enqueueAttendanceAction: async (_: string, payload: any) => payload, removeQueuedAttendanceAction: async () => {},
      attendanceCheckOut: async (payload: any) => {
        requests++; lastPayload = payload;
        assert(pendingNotifications > 0, "notification must not wait for a network timeout");
        if (!networkWorks) throw new Error("Network unavailable");
        return { id: "checkout", type: "checkout" };
      },
    },
    "./attendance-notifications": {
      ensureAttendanceNotificationPermission: async () => true,
      notifyAutoCheckoutPending: async () => { pendingNotifications++; }, notifyAutoCheckoutSynced: async () => {},
    },
    "./location-service": { getVerifiedLocationEvidence: async () => null },
  });
  assert.equal(await runtime.startAttendanceGeofence(active, [zone], true), true);
  assert.equal(watchdogOptions.distanceInterval, 0, "a second fix must not require further movement");
  await runtime.startAttendanceGeofence(active, [zone]);
  assert.equal(watchdogStarts, 1, "healthy native registrations must not restart on every refresh");
  const sessionKey = "@attendance_background_session_v2";
  data.set(sessionKey, JSON.stringify({ ...JSON.parse(data.get(sessionKey)!), watchdogVersion: 1 }));
  await runtime.startAttendanceGeofence(active, [zone]);
  assert.equal(watchdogStarts, 2, "older running registrations must adopt stationary sampling after update");
  const location = (timestamp: number, latitude = 23.01) => ({ timestamp, coords: { latitude, longitude: 72, accuracy: 10 } });
  const watchdog = tasks.get("BACKGROUND_ATTENDANCE_LOCATION_WATCHDOG_TASK")!;
  await watchdog({ data: { locations: [location(clock - 150000)] } });
  assert.equal(requests, 0, "stale readings are ignored");
  await watchdog({ data: { locations: [{ ...location(clock - 100000), mocked: true }] } });
  assert.equal(requests, 0, "mocked readings are ignored");
  await watchdog({ data: { locations: [location(clock - 90000)] } });
  await watchdog({ data: { locations: [location(clock - 80000, 23)] } });
  await watchdog({ data: { locations: [location(clock - 31000)] } });
  assert.equal(requests, 0, "returning inside clears unconfirmed evidence; one new reading is not an exit");
  await watchdog({ data: { locations: [location(clock)] } });
  assert.equal(requests, 1);
  assert.equal(checkedIn, true, "a failed request cannot pretend to be server-confirmed checkout");
  assert.equal(lastPayload.locationSampleWindowMs, 31000);
  assert.equal(pendingNotifications, 1, "network failure must not repeat the detected notification");
  const captured = lastPayload.capturedAtClient;
  // Simulate service restart and a return inside after the confirmed exit.
  await runtime.startAttendanceGeofence(active, [{ ...zone, updatedAt: "v2" }]);
  networkWorks = true;
  await watchdog({ data: { locations: [location(clock, 23)] } });
  assert.equal(requests, 2);
  assert.equal(lastPayload.capturedAtClient, captured);
  assert.equal(savedRecords, 1);
  assert.equal(checkedIn, false);
  await watchdog({ data: { locations: [location(clock)] } });
  assert.equal(requests, 2, "completed sessions stop submitting");
});

test("queue retry keeps concurrent new events, uses one flush and updates local checkout state", async () => {
  let queue: any[] = [];
  let fetchCount = 0;
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  let checkedIn = true;
  let notifications = 0;
  const api = await mobileModule("lib/attendance-api.ts", {
    "@react-native-async-storage/async-storage": { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    "expo-crypto": { randomUUID }, "expo-constants": {},
    "@/lib/global-loading": { beginGlobalLoading: () => () => {} },
    "./attendance-notifications": { notifyAutoCheckoutSynced: async () => { notifications++; } },
    "@/lib/storage": {
      getSettings: async () => ({ autoSync: "false" }), getApiToken: async () => "token",
      getCurrentUser: async () => ({ id: "employee" }), getAttendanceQueue: async () => structuredClone(queue),
      setAttendanceQueue: async (items: any[]) => { queue = structuredClone(items); },
      addAttendance: async () => {}, setCheckedIn: async (value: boolean) => { checkedIn = value; },
    },
  }, { fetch: async (_url: string, options: any) => {
    fetchCount++; started(); await releasePromise;
    return new Response(JSON.stringify({ ...JSON.parse(options.body), id: "checkout", type: "checkout" }), { status: 201 });
  } });
  const payload = { userId: "employee", actionSource: "geofence_exit", requestId: "first-exit-event",
    capturedAtClient: new Date().toISOString() };
  await api.enqueueAttendanceAction("checkout", payload);
  const sameExit = await api.enqueueAttendanceAction("checkout", { ...payload, capturedAtClient: "2000-01-01T00:00:00Z" });
  assert.equal(sameExit.capturedAtClient, payload.capturedAtClient, "all submitters must use the first confirmed evidence");
  const first = api.flushAttendanceQueue();
  const duplicate = api.flushAttendanceQueue();
  await startedPromise;
  await api.enqueueAttendanceAction("checkout", { ...payload, requestId: "new-exit-event" });
  release();
  await Promise.all([first, duplicate]);
  assert.equal(fetchCount, 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].payload.requestId, "new-exit-event");
  assert.equal(checkedIn, false);
  assert.equal(notifications, 1);
});

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
    getGeofenceById: async (id: string) => id === office.id ? office : null,
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
    const automatic = { actionSource: "geofence_exit", activeAttendanceId, biometricVerified: false,
      latitude: office.latitude + .01, locationSampleWindowMs: 30000, requestId: "automatic-exit-retry-12345" };
    assert.equal(await post("checkout", { ...automatic, capturedAtClient: new Date(Date.parse(records.at(-1)!.timestamp) - 1000).toISOString() }), 400, "evidence must belong to this shift");
    // A delayed offline exit can arrive hours later, even after office assignments change.
    records.at(-1)!.timestamp = new Date(Date.now() - 4 * 3600000).toISOString();
    const detectedAt = new Date(Date.now() - 3 * 3600000).toISOString();
    zones = [];
    assert.equal(await post("checkout", { ...automatic, capturedAtClient: detectedAt }), 201);
    const afterExitCount = records.length;
    assert.equal(records.at(-1)!.timestamp, detectedAt);
    assert.equal(records.at(-1)!.geofenceId, office.id);
    assert.equal(await post("checkout", { ...automatic, capturedAtClient: detectedAt }), 200);
    assert.equal(records.length, afterExitCount, "retry must return the same checkout without duplicating it");
    zones = [office];
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
  const { dedupeAttendanceRosterMembers, isAttendanceRosterMember, isSystemAdministratorAccount } = await import("../lib/attendance-roster");
  const people = [{ id: "one", name: "Same Name", email: "one@example.test", role: "employee" }, { id: "two", name: "Same Name", email: "two@example.test", role: "employee" }];
  assert.equal(dedupeAttendanceRosterMembers(people).length, 2);
  const promotedAdmin = { id: "admin_one", name: "Promoted Admin", email: "promoted@example.test", role: "admin" };
  const promotedManager = { id: "manager_one", name: "Promoted Manager", email: "manager@example.test", role: "manager" };
  const superAdmin = { id: "dolibarr_1", name: "Workspace Owner", email: "owner@example.test", role: "admin" };
  assert.equal(isSystemAdministratorAccount(promotedAdmin), false);
  assert.equal(isAttendanceRosterMember(promotedAdmin), true);
  assert.equal(isAttendanceRosterMember(promotedManager), true);
  assert.equal(isSystemAdministratorAccount(superAdmin), true);
  assert.equal(isAttendanceRosterMember(superAdmin), false);
});
