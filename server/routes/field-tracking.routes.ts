import type { Express, Request } from 'express';
import type { Pool } from 'mysql2/promise';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { AppNotification, AttendanceRecord } from '@/lib/types';
import { toMumbaiDateKey } from '@/lib/ist-time';
import {
  computeRoute,
  getConfiguredRouteSource,
  getGeospatialProvider,
  isGeocoderConfigured,
  isRouterConfigured,
  matchTrace,
  searchPlaces,
} from '@/server/services/field-geospatial';
import { sendPushToUsers } from '@/server/services/push-notifications';

type Deps = {
  requireAuth: (req: any, res: any, next: any) => void;
  getMySqlPool: () => Promise<Pool>;
  isMySqlStateEnabled: () => boolean;
  resolveRequestCompanyId: (req: Request) => Promise<string | null>;
  getRequestUser: (req: Request) => { companyId?: string | null; companyIds?: string[] | null } | null;
  findActiveAttendance: (userId: string) => Promise<AttendanceRecord | null>;
  insertNotificationInMySql?: (notification: AppNotification) => Promise<void>;
};

const pointSchema = z.object({
  pointId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10_000).nullable(),
  speed: z.number().min(-1).max(300).nullable(),
  heading: z.number().min(-1).max(360).nullable(),
  battery: z.number().int().min(0).max(100).nullable(),
  mocked: z.boolean(),
  capturedAt: z.string().datetime(),
  syncedAt: z.string().datetime().nullable().optional(),
  routeEligible: z.boolean(),
  rejectionReason: z.string().max(64).nullable(),
});

const batchSchema = z.object({
  sessionId: z.string().uuid(),
  companyId: z.string().trim().min(1).max(64),
  sessionStartedAt: z.string().datetime(),
  points: z.array(pointSchema).min(1).max(100),
}).superRefine((value, context) => {
  value.points.forEach((point, index) => {
    if (point.sessionId !== value.sessionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['points', index, 'sessionId'],
        message: 'Point session does not match its batch.',
      });
    }
  });
});

const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const routeSchema = z.object({
  origin: coordinateSchema,
  destination: coordinateSchema.extend({
    placeId: z.string().max(256).optional(),
    name: z.string().min(1).max(200),
    address: z.string().max(500).optional().default(''),
  }),
  travelMode: z.enum(['auto', 'pedestrian', 'bicycle']).default('auto'),
  assignmentId: z.string().uuid().optional(),
});

const visitEvidenceSchema = z.object({
  location: coordinateSchema.extend({
    accuracy: z.number().min(0).max(10_000).nullable().optional(),
  }).nullable().optional(),
});

const scheduledDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00+05:30`);
  return Number.isFinite(parsed.getTime()) && toMumbaiDateKey(parsed) === value;
}, 'Choose a valid visit date.');

const scheduledTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Choose a valid 24-hour visit time.');

const assignmentSchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  place: coordinateSchema.extend({
    placeId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).default(''),
  }),
  scheduledDate: scheduledDateSchema,
  scheduledTime: scheduledTimeSchema,
  notes: z.string().trim().max(500).optional().default(''),
});

let tablePromise: Promise<void> | null = null;
let healthCache: { checkedAt: number; routerReachable: boolean; geocoderReachable: boolean } | null = null;

export function registerFieldTrackingRoutes(app: Express, deps: Deps) {
  const requireStore = async (req: Request, res: any, next: any) => {
    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({ message: 'Field tracking storage is not configured.' });
      return;
    }
    try {
      await ensureTables(await deps.getMySqlPool());
      next();
    } catch (error) {
      console.error('[field-tracking] schema setup failed', error);
      res.status(503).json({ message: 'Field tracking storage is unavailable.' });
    }
  };

  app.get('/api/field-tracking/health', deps.requireAuth, async (_req, res) => {
    if (healthCache && Date.now() - healthCache.checkedAt < 20_000) {
      res.json({ apiReachable: true, provider: getGeospatialProvider(), routerReachable: healthCache.routerReachable, geocoderReachable: healthCache.geocoderReachable });
      return;
    }
    // Hosted Stadia readiness is configuration-based. The mobile app polls this
    // endpoint frequently, so health checks must not consume geocoding credits.
    const hosted = getGeospatialProvider() === 'stadia';
    const [routerReachable, geocoderReachable] = hosted
      ? [isRouterConfigured(), isGeocoderConfigured()]
      : await Promise.all([
          probe(process.env.VALHALLA_URL || process.env.ROUTER_BASE_URL || '', '/status'),
          // Some Nominatim images expose /status inconsistently while their actual
          // search API is healthy. Probe the same lightweight endpoint the app uses.
          probe(process.env.NOMINATIM_URL || process.env.GEOCODER_BASE_URL || '', '/search?q=Ahmedabad&format=jsonv2&limit=1'),
        ]);
    healthCache = { checkedAt: Date.now(), routerReachable, geocoderReachable };
    res.json({ apiReachable: true, provider: getGeospatialProvider(), routerReachable, geocoderReachable });
  });

  app.get('/api/field-tracking/places/search', deps.requireAuth, async (req, res) => {
    const query = String(req.query.q || '').trim();
    if (query.length < 3 || query.length > 120) {
      res.status(400).json({ message: 'Enter at least 3 characters to search.' });
      return;
    }
    const latitude = Number(req.query.lat);
    const longitude = Number(req.query.lon);
    const bias = Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : undefined;
    try {
      res.json({ places: await searchPlaces(query, bias) });
    } catch (error) {
      res.status(503).json({ message: messageOf(error) });
    }
  });

  app.post('/api/field-tracking/route', deps.requireAuth, requireStore, async (req, res) => {
    const parsed = routeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid route request.' });
      return;
    }
    try {
      let destination = parsed.data.destination;
      if (['employee', 'salesperson'].includes(req.auth?.role || '')) {
        const employeeId = String(req.auth?.sub || '').trim();
        const active = await requireActiveAttendance(employeeId, res, deps);
        if (!active) return;
        if (!parsed.data.assignmentId) {
          res.status(400).json({ code: 'ASSIGNMENT_REQUIRED', message: 'Choose an assigned visit before starting directions.' });
          return;
        }
        const pool = await deps.getMySqlPool();
        const [rows] = await pool.execute<any[]>(
          `SELECT id, company_id, place_id, place_name, place_address, latitude, longitude,
                  scheduled_date, scheduled_time
           FROM lff_place_assignments
           WHERE id=? AND employee_id=? AND status='pending' LIMIT 1`,
          [parsed.data.assignmentId, employeeId],
        );
        const assignment = rows[0];
        if (!assignment) {
          res.status(404).json({ code: 'VISIT_NOT_AVAILABLE', message: 'This visit is no longer pending for your account.' });
          return;
        }
        if (active.companyId && String(assignment.company_id) !== active.companyId) {
          res.status(403).json({ code: 'CHECK_IN_WORKSPACE_MISMATCH', message: 'Check in to the visit workspace before starting directions.' });
          return;
        }
        if (toSqlDateKey(assignment.scheduled_date) !== toMumbaiDateKey(new Date())) {
          res.status(409).json({ code: 'VISIT_NOT_SCHEDULED_TODAY', message: 'Directions are available only on the assigned visit date.' });
          return;
        }
        destination = {
          placeId: String(assignment.place_id),
          name: String(assignment.place_name),
          address: String(assignment.place_address || ''),
          latitude: Number(assignment.latitude),
          longitude: Number(assignment.longitude),
        };
      }
      const plan = await computeRoute(parsed.data.origin, destination, parsed.data.travelMode);
      if (plan.source === 'unavailable' || plan.coordinates.length < 2) {
        res.status(422).json({ message: 'No route was found inside the installed map region.' });
        return;
      }
      res.json({
        source: plan.source,
        distanceMetres: plan.distanceMetres,
        durationSeconds: plan.durationSeconds,
        coordinates: plan.coordinates,
        maneuvers: plan.maneuvers,
      });
    } catch (error) {
      const message = messageOf(error);
      res.status(/not_configured|unavailable/.test(message) ? 503 : 502).json({ message });
    }
  });

  // A visit is deliberately stored separately from the live GPS session. This
  // lets an admin assign work before the employee checks in, and preserves the
  // visit queue across app restarts and devices.
  app.get('/api/field-tracking/assignments', deps.requireAuth, requireStore, async (req, res) => {
    const companyId = await deps.resolveRequestCompanyId(req);
    const employeeId = String(req.auth?.sub || '').trim();
    if (!companyId || !employeeId) {
      res.status(403).json({ message: 'Workspace access is required for visit assignments.' });
      return;
    }
    const supervisor = ['admin', 'hr', 'manager'].includes(req.auth?.role || '');
    const pool = await deps.getMySqlPool();
    const [rows] = await pool.execute<any[]>(
      `SELECT id, company_id, employee_id, assigned_by, place_id, place_name, place_address,
              latitude, longitude, queue_order, scheduled_date, scheduled_time, notes, status, created_at, started_at, completed_at,
              arrival_latitude, arrival_longitude, arrival_accuracy,
              completion_latitude, completion_longitude, completion_accuracy
       FROM lff_place_assignments
       WHERE company_id=? ${supervisor ? '' : 'AND employee_id=?'}
       ORDER BY scheduled_date ASC, scheduled_time ASC,
                CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                employee_id, queue_order, created_at DESC`,
      supervisor ? [companyId] : [companyId, employeeId],
    );
    res.json({ assignments: rows.map(mapAssignment) });
  });

  app.post('/api/field-tracking/assignments', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required to assign a visit.' });
      return;
    }
    const parsed = assignmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid visit assignment.', issues: parsed.error.issues });
      return;
    }
    const companyId = await deps.resolveRequestCompanyId(req);
    if (!companyId) {
      res.status(403).json({ message: 'Select an authorised workspace first.' });
      return;
    }
    const today = toMumbaiDateKey(new Date());
    if (parsed.data.scheduledDate < today) {
      res.status(400).json({ message: 'A field visit cannot be assigned in the past.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [sequenceRows] = await pool.execute<any[]>(
      `SELECT COALESCE(MAX(queue_order), 0) AS last_order
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND scheduled_date=? AND status IN ('pending','in_progress')`,
      [companyId, parsed.data.employeeId, parsed.data.scheduledDate],
    );
    const queueOrder = Number(sequenceRows[0]?.last_order || 0) + 1;
    const id = randomUUID();
    await pool.execute(
      `INSERT INTO lff_place_assignments
        (id, company_id, employee_id, assigned_by, place_id, place_name, place_address,
         latitude, longitude, queue_order, scheduled_date, scheduled_time, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(3), NOW(3))`,
      [
        id, companyId, parsed.data.employeeId, String(req.auth?.sub || ''),
        parsed.data.place.placeId, parsed.data.place.name, parsed.data.place.address,
        parsed.data.place.latitude, parsed.data.place.longitude, queueOrder,
        parsed.data.scheduledDate, `${parsed.data.scheduledTime}:00`, parsed.data.notes || null,
      ],
    );
    const alertTitle = 'New field visit assigned';
    const alertBody = `${parsed.data.place.name} on ${parsed.data.scheduledDate} at ${parsed.data.scheduledTime}`;
    if (deps.insertNotificationInMySql) {
      await deps.insertNotificationInMySql({
        id: randomUUID(),
        companyId,
        title: alertTitle,
        body: alertBody,
        kind: 'alert',
        audience: 'employee',
        audienceUserIds: [parsed.data.employeeId],
        createdById: String(req.auth?.sub || ''),
        createdByName: 'FieldForce supervisor',
        createdAt: new Date().toISOString(),
        readByIds: [],
      }).catch((error) => console.warn('[field-tracking] assignment inbox alert failed', error));
    }
    res.status(201).json({
      assignment: {
        assignmentId: id, companyId, employeeId: parsed.data.employeeId,
        assignedBy: String(req.auth?.sub || ''), placeId: parsed.data.place.placeId,
        placeName: parsed.data.place.name, placeAddress: parsed.data.place.address,
        latitude: parsed.data.place.latitude, longitude: parsed.data.place.longitude,
        queueOrder, scheduledDate: parsed.data.scheduledDate, scheduledTime: parsed.data.scheduledTime,
        notes: parsed.data.notes || '', status: 'pending',
        createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
        arrivalLocation: null, completionLocation: null,
      },
    });
    // Delivery is best effort after the assignment is durable. A temporary
    // push-provider outage must never roll back or duplicate the field visit.
    void sendPushToUsers(pool, {
      userIds: [parsed.data.employeeId],
      companyId,
      payload: {
        title: alertTitle,
        body: alertBody,
        data: { screen: 'field-visits', kind: 'visit_assigned', assignmentId: id },
      },
    }).catch((error) => console.warn('[field-tracking] assignment push failed', error));
  });

  app.get('/api/field-tracking/check-in-eligibility', deps.requireAuth, requireStore, async (req, res) => {
    const scheduledDate = toMumbaiDateKey(new Date());
    const companyId = await deps.resolveRequestCompanyId(req);
    const employeeId = String(req.auth?.sub || '').trim();
    if (!companyId || !employeeId || !['employee', 'salesperson'].includes(req.auth?.role || '')) {
      res.json({ remoteCheckInAllowed: false, visitCount: 0, scheduledDate });
      return;
    }
    const eligibility = await getFieldVisitRemoteCheckInEligibility(
      await deps.getMySqlPool(),
      employeeId,
      scheduledDate,
      companyId,
    );
    res.json({ ...eligibility, scheduledDate });
  });

  app.post('/api/field-tracking/assignments/:assignmentId/start', deps.requireAuth, requireStore, async (req, res) => {
    const assignmentId = String(req.params.assignmentId || '').trim();
    const parsed = visitEvidenceSchema.safeParse(req.body);
    if (!assignmentId || !parsed.success || !parsed.data.location) {
      res.status(400).json({ message: 'A visit and current location are required to start the visit.' });
      return;
    }
    const employeeId = String(req.auth?.sub || '').trim();
    const active = await requireActiveAttendance(employeeId, res, deps);
    if (!active) return;
    const pool = await deps.getMySqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<any[]>(
        `SELECT * FROM lff_place_assignments WHERE id=? AND employee_id=? LIMIT 1 FOR UPDATE`,
        [assignmentId, employeeId],
      );
      const assignment = rows[0];
      if (!assignment || String(assignment.status) !== 'pending') {
        await connection.rollback();
        res.status(404).json({ message: 'This pending visit was not found for your account.' });
        return;
      }
      if (active.companyId && String(assignment.company_id) !== active.companyId) {
        await connection.rollback();
        res.status(403).json({ code: 'CHECK_IN_WORKSPACE_MISMATCH', message: 'This visit does not belong to your active check-in workspace.' });
        return;
      }
      if (toSqlDateKey(assignment.scheduled_date) !== toMumbaiDateKey(new Date())) {
        await connection.rollback();
        res.status(409).json({ code: 'VISIT_NOT_SCHEDULED_TODAY', message: 'This visit can be started only on its assigned date.' });
        return;
      }
      const [activeVisitRows] = await connection.execute<any[]>(
        `SELECT id FROM lff_place_assignments
         WHERE employee_id=? AND status='in_progress' AND id<>? LIMIT 1 FOR UPDATE`,
        [employeeId, assignmentId],
      );
      if (activeVisitRows.length) {
        await connection.rollback();
        res.status(409).json({ code: 'VISIT_ALREADY_ACTIVE', message: 'Complete your active visit before starting another one.' });
        return;
      }
      const location = parsed.data.location;
      const distance = haversineMetres(
        { latitude: location.latitude, longitude: location.longitude },
        { latitude: Number(assignment.latitude), longitude: Number(assignment.longitude) },
      );
      const arrivalRadius = Math.max(100, Math.min(150, Number(location.accuracy || 0) * 2));
      if (distance > arrivalRadius) {
        await connection.rollback();
        res.status(409).json({
          code: 'VISIT_LOCATION_REQUIRED',
          message: `Move within ${Math.round(arrivalRadius)} metres of the assigned place to start this visit.`,
          distanceMetres: Math.round(distance),
        });
        return;
      }
      await connection.execute(
        `UPDATE lff_place_assignments
         SET status='in_progress', started_at=NOW(3), arrival_latitude=?, arrival_longitude=?,
             arrival_accuracy=?, updated_at=NOW(3)
         WHERE id=? AND employee_id=? AND status='pending'`,
        [location.latitude, location.longitude, location.accuracy ?? null, assignmentId, employeeId],
      );
      const [updatedRows] = await connection.execute<any[]>(
        `SELECT id, company_id, employee_id, assigned_by, place_id, place_name, place_address,
                latitude, longitude, queue_order, scheduled_date, scheduled_time, notes, status, created_at, started_at, completed_at,
                arrival_latitude, arrival_longitude, arrival_accuracy,
                completion_latitude, completion_longitude, completion_accuracy
         FROM lff_place_assignments WHERE id=? LIMIT 1`,
        [assignmentId],
      );
      await connection.commit();
      res.json({ assignment: mapAssignment(updatedRows[0]) });
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      console.error('[field-tracking] start visit failed', error);
      res.status(503).json({ message: 'Could not start this visit. Please retry.' });
    } finally {
      connection.release();
    }
  });

  app.post('/api/field-tracking/assignments/:assignmentId/complete', deps.requireAuth, requireStore, async (req, res) => {
    const assignmentId = String(req.params.assignmentId || '').trim();
    if (!assignmentId) {
      res.status(400).json({ message: 'Visit assignment id is required.' });
      return;
    }
    const parsed = visitEvidenceSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid visit completion location.' });
      return;
    }
    const employeeId = String(req.auth?.sub || '').trim();
    const active = await requireActiveAttendance(employeeId, res, deps);
    if (!active) return;
    const pool = await deps.getMySqlPool();
    const location = parsed.data.location;
    const [result] = await pool.execute<any>(
      `UPDATE lff_place_assignments
       SET status='completed', completed_at=NOW(3), completion_latitude=?, completion_longitude=?,
           completion_accuracy=?, updated_at=NOW(3)
       WHERE id=? AND employee_id=? AND status='in_progress'`,
      [location?.latitude ?? null, location?.longitude ?? null, location?.accuracy ?? null, assignmentId, employeeId],
    );
    if (!result.affectedRows) {
      res.status(404).json({ message: 'Start this visit before marking it complete.' });
      return;
    }
    const [nextRows] = await pool.execute<any[]>(
      `SELECT id, company_id, employee_id, assigned_by, place_id, place_name, place_address,
              latitude, longitude, queue_order, scheduled_date, scheduled_time, notes, status, created_at, started_at, completed_at,
              arrival_latitude, arrival_longitude, arrival_accuracy,
              completion_latitude, completion_longitude, completion_accuracy
       FROM lff_place_assignments
       WHERE employee_id=? AND company_id=? AND scheduled_date=? AND status='pending'
       ORDER BY scheduled_time ASC, queue_order ASC, created_at ASC LIMIT 1`,
      [employeeId, active.companyId || await deps.resolveRequestCompanyId(req), toMumbaiDateKey(new Date())],
    );
    res.json({ ok: true, nextAssignment: nextRows[0] ? mapAssignment(nextRows[0]) : null });
  });

  app.post('/api/field-tracking/locations/batch', deps.requireAuth, requireStore, async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid location batch.', issues: parsed.error.issues });
      return;
    }
    const companyId = await resolveAuthorizedCompanyId(req, parsed.data.companyId, deps);
    const employeeId = req.auth?.sub || '';
    if (!companyId || !employeeId) {
      res.status(403).json({ message: 'Workspace access is required for field tracking.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO lff_tracking_sessions
          (id, company_id, employee_id, started_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE updated_at=NOW(3)`,
        [parsed.data.sessionId, companyId, employeeId, toSqlDate(parsed.data.sessionStartedAt)],
      );
      const [ownerRows] = await connection.execute<any[]>(
        `SELECT employee_id, company_id FROM lff_tracking_sessions WHERE id=? LIMIT 1 FOR UPDATE`,
        [parsed.data.sessionId],
      );
      const owner = ownerRows[0];
      if (!owner || String(owner.employee_id) !== employeeId || String(owner.company_id) !== companyId) {
        await connection.rollback();
        res.status(409).json({ message: 'Tracking session ownership does not match this account.' });
        return;
      }
      const committedAt = new Date().toISOString();
      const accepted: { pointId: string }[] = [];
      const rejected: { pointId: string; reason: string }[] = [];
      for (const point of parsed.data.points) {
        const [insertResult] = await connection.execute<any>(
          `INSERT IGNORE INTO lff_tracking_points
            (point_id, session_id, company_id, employee_id, sequence_no, latitude, longitude,
             accuracy, speed, heading, battery, mocked, captured_at, route_eligible,
             rejection_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
          [
            point.pointId, point.sessionId, companyId, employeeId, point.sequence,
            point.latitude, point.longitude, point.accuracy, point.speed, point.heading,
            point.battery, point.mocked ? 1 : 0, toSqlDate(point.capturedAt),
            point.routeEligible ? 1 : 0, point.rejectionReason,
          ],
        );
        if (insertResult.affectedRows > 0) {
          accepted.push({ pointId: point.pointId });
          continue;
        }
        const [existingRows] = await connection.execute<any[]>(
          `SELECT point_id FROM lff_tracking_points
           WHERE session_id=? AND (point_id=? OR sequence_no=?) LIMIT 1`,
          [point.sessionId, point.pointId, point.sequence],
        );
        if (String(existingRows[0]?.point_id || '') === point.pointId) accepted.push({ pointId: point.pointId });
        else rejected.push({ pointId: point.pointId, reason: 'sequence_conflict' });
      }
      await connection.execute(
        `UPDATE lff_tracking_sessions SET updated_at=NOW(3) WHERE id=?`,
        [parsed.data.sessionId],
      );
      await connection.commit();
      res.status(201).json({ accepted, rejected, committedAt });
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      console.error('[field-tracking] batch commit failed', error);
      res.status(503).json({ message: 'Location points are safely queued on the device; server sync will retry.' });
    } finally {
      connection.release();
    }
  });

  app.post('/api/field-tracking/sessions/:sessionId/complete', deps.requireAuth, requireStore, async (req, res) => {
    const sessionId = String(req.params.sessionId || '');
    const parsed = z.object({ endedAt: z.string().datetime() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid field shift end time.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [result] = await pool.execute<any>(
      `UPDATE lff_tracking_sessions
       SET ended_at=?, status='completed', updated_at=NOW(3)
       WHERE id=? AND employee_id=?`,
      [toSqlDate(parsed.data.endedAt), sessionId, req.auth?.sub || ''],
    );
    if (!result.affectedRows) {
      res.status(404).json({ message: 'Field tracking session was not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/field-tracking/employees', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required.' });
      return;
    }
    const requestedCompanyId = String(req.query.companyId || '').trim();
    const companyId = requestedCompanyId
      ? await resolveAuthorizedCompanyId(req, requestedCompanyId, deps)
      : await deps.resolveRequestCompanyId(req);
    if (!companyId) {
      res.status(403).json({ message: 'Workspace access is required for field history.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [rows] = await pool.execute<any[]>(
      `SELECT s.id AS session_id, s.employee_id, s.status AS session_status,
              COALESCE(a.user_name, s.employee_id) AS employee_name,
              p.latitude, p.longitude, p.accuracy, p.speed, p.heading,
              p.battery, p.captured_at, p.sequence_no
       FROM lff_tracking_sessions s
       LEFT JOIN lff_tracking_points p ON p.point_id=(
         SELECT p2.point_id FROM lff_tracking_points p2
         WHERE p2.session_id=s.id AND (p2.route_eligible=1 OR p2.rejection_reason='stationary_noise')
         ORDER BY p2.sequence_no DESC LIMIT 1
       )
       LEFT JOIN lff_attendance a ON a.id=(
         SELECT a2.id FROM lff_attendance a2
         WHERE a2.user_id=s.employee_id AND a2.type='checkin' AND a2.timestamp<=s.started_at
         ORDER BY a2.timestamp DESC LIMIT 1
       )
       WHERE s.company_id=? AND s.id=(
         SELECT s2.id FROM lff_tracking_sessions s2
         WHERE s2.company_id=s.company_id AND s2.employee_id=s.employee_id
         ORDER BY s2.updated_at DESC, s2.started_at DESC LIMIT 1
       )
       ORDER BY (s.status='active') DESC, p.captured_at DESC
       LIMIT 500`,
      [companyId],
    );
    res.json({ employees: rows });
  });

  app.get('/api/field-tracking/employees/:employeeId/calendar', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required.' });
      return;
    }
    const employeeId = String(req.params.employeeId || '').trim();
    const month = String(req.query.month || '').trim();
    const offsetMinutes = normalizeTimezoneOffset(req.query.tzOffsetMinutes);
    let bounds: ReturnType<typeof monthDateBounds>;
    try {
      bounds = monthDateBounds(month, offsetMinutes);
    } catch {
      res.status(400).json({ message: 'Choose a valid calendar month.' });
      return;
    }
    const requestedCompanyId = String(req.query.companyId || '').trim();
    const companyId = requestedCompanyId
      ? await resolveAuthorizedCompanyId(req, requestedCompanyId, deps)
      : await deps.resolveRequestCompanyId(req);
    if (!companyId || !employeeId) {
      res.status(403).json({ message: 'Workspace access is required for field history.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [employeeRows] = await pool.execute<any[]>(
      `SELECT 1 FROM lff_tracking_sessions WHERE company_id=? AND employee_id=? LIMIT 1`,
      [companyId, employeeId],
    );
    if (!employeeRows.length) {
      res.status(404).json({ message: 'No field history was found for this employee.' });
      return;
    }
    const [rows] = await pool.execute<any[]>(
      `SELECT session_id, sequence_no, latitude, longitude, accuracy, speed, captured_at, route_eligible, rejection_reason
       FROM lff_tracking_points
       WHERE company_id=? AND employee_id=? AND captured_at>=? AND captured_at<?
       ORDER BY captured_at ASC, session_id ASC, sequence_no ASC
       LIMIT 120000`,
      [companyId, employeeId, bounds.start, bounds.end],
    );
    const points = rows.map(mapKpiPoint).filter(isValidKpiPoint);
    const routeDates = points.map((point) => localDateKey(point.capturedAt, offsetMinutes));
    const [visitRows] = await pool.execute<any[]>(
      `SELECT status, scheduled_date FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND status<>'cancelled'
         AND scheduled_date>=? AND scheduled_date<DATE_ADD(?, INTERVAL 1 MONTH)`,
      [companyId, employeeId, `${month}-01`, `${month}-01`],
    );
    const visitCounts = new Map<string, { total: number; completed: number }>();
    for (const visit of visitRows) {
      const date = toSqlDateKey(visit.scheduled_date);
      if (!date) continue;
      const counts = visitCounts.get(date) ?? { total: 0, completed: 0 };
      counts.total += 1;
      if (String(visit.status) === 'completed') counts.completed += 1;
      visitCounts.set(date, counts);
    }
    const dates = [...new Set([...routeDates, ...visitCounts.keys()])];
    const days = dates.map((date) => {
      const summary = summarizeTrackingDay(points, date, offsetMinutes);
      const visits = visitCounts.get(date) ?? { total: 0, completed: 0 };
      return {
        date,
        sessionCount: summary.sessionCount,
        shiftSeconds: summary.shiftSeconds,
        movingSeconds: summary.movingSeconds,
        haltSeconds: summary.haltSeconds,
        haltCount: summary.haltCount,
        distanceMetres: summary.distanceMetres,
        visitTotal: visits.total,
        visitCompleted: visits.completed,
        acceptedPoints: summary.acceptedPoints,
        lastCapturedAt: summary.lastCapturedAt,
      };
    }).sort((left, right) => left.date.localeCompare(right.date));
    res.json({ employeeId, month, timezoneOffsetMinutes: offsetMinutes, days });
  });

  app.get('/api/field-tracking/employees/:employeeId/daily', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required.' });
      return;
    }
    const employeeId = String(req.params.employeeId || '').trim();
    const date = String(req.query.date || '').trim();
    const offsetMinutes = normalizeTimezoneOffset(req.query.tzOffsetMinutes);
    let bounds: ReturnType<typeof localDateBounds>;
    try {
      bounds = localDateBounds(date, offsetMinutes);
    } catch {
      res.status(400).json({ message: 'Choose a valid tracking date.' });
      return;
    }
    const requestedCompanyId = String(req.query.companyId || '').trim();
    const companyId = requestedCompanyId
      ? await resolveAuthorizedCompanyId(req, requestedCompanyId, deps)
      : await deps.resolveRequestCompanyId(req);
    if (!companyId || !employeeId) {
      res.status(403).json({ message: 'Workspace access is required for field history.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [sessionRows] = await pool.execute<any[]>(
      `SELECT id FROM lff_tracking_sessions WHERE company_id=? AND employee_id=? LIMIT 1`,
      [companyId, employeeId],
    );
    if (!sessionRows.length) {
      res.status(404).json({ message: 'No field history was found for this employee.' });
      return;
    }
    const [rows] = await pool.execute<any[]>(
      `SELECT session_id, sequence_no, latitude, longitude, accuracy, speed, captured_at, route_eligible, rejection_reason
       FROM lff_tracking_points
       WHERE company_id=? AND employee_id=? AND captured_at>=? AND captured_at<?
       ORDER BY captured_at ASC, session_id ASC, sequence_no ASC
       LIMIT 30000`,
      [companyId, employeeId, bounds.start, bounds.end],
    );
    const points = rows.map(mapKpiPoint).filter(isValidKpiPoint);
    const summary = summarizeTrackingDay(points, date, offsetMinutes);
    const [visitRows] = await pool.execute<any[]>(
      `SELECT status, scheduled_date, scheduled_time, created_at, started_at, completed_at,
              place_name, place_address, latitude, longitude
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND scheduled_date=? AND status<>'cancelled'
       ORDER BY scheduled_time ASC, queue_order ASC, created_at ASC`,
      [companyId, employeeId, date],
    );
    const today = localDateKey(Date.now(), offsetMinutes);
    const dayVisits = visitRows;
    const nextVisit = date === today
      ? dayVisits.find((visit) => ['pending', 'in_progress'].includes(String(visit.status)))
      : null;
    const latest = points.filter((point) => point.routeEligible).at(-1) ?? null;
    const nextLatitude = Number(nextVisit?.latitude);
    const nextLongitude = Number(nextVisit?.longitude);
    const distanceToNext = latest && Number.isFinite(nextLatitude) && Number.isFinite(nextLongitude)
      ? haversineMetres(latest, { latitude: nextLatitude, longitude: nextLongitude })
      : null;
    const routePoints = thinTrackingPoints(points.filter((point) => point.routeEligible && (point.accuracy == null || point.accuracy <= 80)));
    res.json({
      date,
      points: routePoints.map((point) => ({
        pointId: `${point.sessionId}:${point.sequence}`,
        sessionId: point.sessionId,
        sequence: point.sequence,
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: point.accuracy,
        speed: point.speed,
        heading: null,
        battery: null,
        mocked: false,
        capturedAt: new Date(point.capturedAt).toISOString(),
        syncedAt: null,
        routeEligible: true,
        rejectionReason: null,
      })),
      kpis: {
        sessionId: `${employeeId}:${date}`,
        employeeId,
        sessionStartedAt: points[0] ? new Date(points[0].capturedAt).toISOString() : bounds.start.toISOString(),
        shiftSeconds: summary.shiftSeconds,
        movingSeconds: summary.movingSeconds,
        haltSeconds: summary.haltSeconds,
        haltCount: summary.haltCount,
        activeHalt: summary.activeHalt,
        distanceMetres: summary.distanceMetres,
        averageMovingSpeedKmh: summary.averageMovingSpeedKmh,
        totalPoints: summary.totalPoints,
        acceptedPoints: summary.acceptedPoints,
        gpsAccuracyMetres: summary.gpsAccuracyMetres,
        lastCapturedAt: summary.lastCapturedAt,
        lastPointAgeSeconds: summary.lastPointAgeSeconds,
        visitTotal: dayVisits.length,
        visitCompleted: dayVisits.filter((visit) => String(visit.status) === 'completed').length,
        nextVisit: nextVisit ? {
          name: String(nextVisit.place_name || 'Next visit'),
          address: String(nextVisit.place_address || ''),
          distanceMetres: distanceToNext == null ? null : Math.round(distanceToNext),
          status: String(nextVisit.status) === 'in_progress' ? 'arrived' : 'en_route',
        } : null,
        activity: mapDailyActivity(summary.activity),
      },
    });
  });

  app.get('/api/field-tracking/sessions/:sessionId/matched-route', deps.requireAuth, requireStore, async (req, res) => {
    const sessionId = String(req.params.sessionId || '');
    const pool = await deps.getMySqlPool();
    const [sessions] = await pool.execute<any[]>(
      `SELECT employee_id, company_id FROM lff_tracking_sessions WHERE id=? LIMIT 1`,
      [sessionId],
    );
    const session = sessions[0];
    const ownsSession = String(session?.employee_id || '') === (req.auth?.sub || '');
    const supervisor = ['admin', 'hr', 'manager'].includes(req.auth?.role || '')
      && getAuthorizedCompanyIds(req, deps).has(String(session?.company_id || ''));
    if (!session || (!ownsSession && !supervisor)) {
      res.status(404).json({ message: 'Tracking session was not found.' });
      return;
    }
    const [rows] = await pool.execute<any[]>(
      `SELECT sequence_no, latitude, longitude, accuracy
       FROM lff_tracking_points
       WHERE session_id=? AND route_eligible=1 AND accuracy<=80
       ORDER BY sequence_no DESC LIMIT 80`,
      [sessionId],
    );
    const ordered = rows.reverse();
    const points = ordered.map((row) => ({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
    }));
    const lastSequence = Number(ordered.at(-1)?.sequence_no || 0);
    if (points.length < 2) {
      res.json({ source: 'raw', points, lastSequence });
      return;
    }
    // The supervisor dashboard polls this endpoint every few seconds. Returning
    // the accepted GPS trace keeps live monitoring current without spending a
    // paid map-matching request on every poll. Explicit matching remains
    // available for a deliberate audit/export request only.
    const wantsMatched = req.query.match === '1' || req.query.match === 'true';
    if (!wantsMatched) {
      res.json({ source: 'raw', points, lastSequence });
      return;
    }
    const matched = await matchTrace(points).catch(() => points);
    res.json({ source: matched === points ? 'raw' : getConfiguredRouteSource(), points: matched, lastSequence });
  });

  app.get('/api/field-tracking/sessions/:sessionId/kpis', deps.requireAuth, requireStore, async (req, res) => {
    const sessionId = String(req.params.sessionId || '');
    const pool = await deps.getMySqlPool();
    const [sessions] = await pool.execute<any[]>(
      `SELECT id, employee_id, company_id, started_at, ended_at, status
       FROM lff_tracking_sessions WHERE id=? LIMIT 1`,
      [sessionId],
    );
    const session = sessions[0];
    const ownsSession = String(session?.employee_id || '') === (req.auth?.sub || '');
    const supervisor = ['admin', 'hr', 'manager'].includes(req.auth?.role || '')
      && getAuthorizedCompanyIds(req, deps).has(String(session?.company_id || ''));
    if (!session || (!ownsSession && !supervisor)) {
      res.status(404).json({ message: 'Tracking session was not found.' });
      return;
    }

    const [pointRows] = await pool.execute<any[]>(
      `SELECT sequence_no, latitude, longitude, accuracy, speed, captured_at, route_eligible, rejection_reason
       FROM lff_tracking_points
       WHERE session_id=?
       ORDER BY sequence_no ASC
       LIMIT 10000`,
      [sessionId],
    );
    const allPoints = pointRows.map((row) => mapKpiPoint({ ...row, session_id: sessionId })).filter(isValidKpiPoint);
    const offsetMinutes = normalizeTimezoneOffset(req.query.tzOffsetMinutes);
    const requestedDate = String(req.query.date || '').trim();
    const latestPoint = allPoints.filter((point) => point.routeEligible).at(-1) ?? allPoints.at(-1) ?? null;
    const selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : localDateKey(latestPoint?.capturedAt ?? Date.now(), offsetMinutes);
    const [visitRows] = await pool.execute<any[]>(
      `SELECT COUNT(*) AS total_count, SUM(status='completed') AS completed_count
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND scheduled_date=? AND status<>'cancelled'`,
      [session.company_id, session.employee_id, selectedDate],
    );
    const [nextVisitRows] = await pool.execute<any[]>(
      `SELECT place_name, place_address, latitude, longitude, status
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND scheduled_date=? AND status IN ('pending','in_progress')
       ORDER BY CASE status WHEN 'in_progress' THEN 0 ELSE 1 END, scheduled_time ASC, queue_order ASC, created_at ASC
       LIMIT 1`,
      [session.company_id, session.employee_id, selectedDate],
    );
    const points = allPoints.filter((point) => localDateKey(point.capturedAt, offsetMinutes) === selectedDate);
    const accepted = points.filter((point) => point.routeEligible && (point.accuracy == null || point.accuracy <= 80));
    const latest = accepted.at(-1) ?? null;
    const now = Date.now();
    const daySummary = summarizeTrackingDay(points, selectedDate, offsetMinutes, now);
    const nextVisit = nextVisitRows[0];
    const nextLatitude = Number(nextVisit?.latitude);
    const nextLongitude = Number(nextVisit?.longitude);
    const distanceToNext = latest && Number.isFinite(nextLatitude) && Number.isFinite(nextLongitude)
      ? haversineMetres(latest, { latitude: nextLatitude, longitude: nextLongitude })
      : null;
    const arrivalRadius = latest?.accuracy != null ? Math.max(50, Math.min(100, latest.accuracy * 2)) : 75;

    res.json({
      sessionId,
      employeeId: String(session.employee_id),
      sessionStartedAt: points[0] ? new Date(points[0].capturedAt).toISOString() : asIsoDate(session.started_at),
      shiftSeconds: daySummary.shiftSeconds,
      movingSeconds: daySummary.movingSeconds,
      haltSeconds: daySummary.haltSeconds,
      haltCount: daySummary.haltCount,
      activeHalt: daySummary.activeHalt,
      distanceMetres: daySummary.distanceMetres,
      averageMovingSpeedKmh: daySummary.averageMovingSpeedKmh,
      totalPoints: daySummary.totalPoints,
      acceptedPoints: daySummary.acceptedPoints,
      gpsAccuracyMetres: daySummary.gpsAccuracyMetres,
      lastCapturedAt: daySummary.lastCapturedAt,
      lastPointAgeSeconds: daySummary.lastPointAgeSeconds,
      visitTotal: Number(visitRows[0]?.total_count || 0),
      visitCompleted: Number(visitRows[0]?.completed_count || 0),
      nextVisit: nextVisit ? {
        name: String(nextVisit.place_name || 'Next visit'),
        address: String(nextVisit.place_address || ''),
        distanceMetres: distanceToNext == null ? null : Math.round(distanceToNext),
        status: String(nextVisit.status) === 'in_progress' || (distanceToNext != null && distanceToNext <= arrivalRadius) ? 'arrived' : 'en_route',
      } : null,
      activity: mapDailyActivity(daySummary.activity).slice(0, 8),
    });
  });

  app.get('/api/field-tracking/live', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required.' });
      return;
    }
    const requestedCompanyId = String(req.query.companyId || '').trim();
    const companyId = requestedCompanyId
      ? await resolveAuthorizedCompanyId(req, requestedCompanyId, deps)
      : await deps.resolveRequestCompanyId(req);
    if (!companyId) {
      res.status(403).json({ message: 'Workspace access is required for live tracking.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [rows] = await pool.execute<any[]>(
      `SELECT s.id AS session_id, s.employee_id,
              COALESCE(a.user_name, s.employee_id) AS employee_name,
              p.latitude, p.longitude, p.accuracy,
              p.speed, p.heading, p.captured_at, p.sequence_no
       FROM lff_tracking_sessions s
       JOIN lff_tracking_points p ON p.point_id=(
         SELECT p2.point_id FROM lff_tracking_points p2
         WHERE p2.session_id=s.id AND (p2.route_eligible=1 OR p2.rejection_reason='stationary_noise')
         ORDER BY p2.sequence_no DESC LIMIT 1
       )
       LEFT JOIN lff_attendance a ON a.id=(
         SELECT a2.id FROM lff_attendance a2
         WHERE a2.user_id=s.employee_id AND a2.type='checkin' AND a2.timestamp<=s.started_at
         ORDER BY a2.timestamp DESC LIMIT 1
       )
       WHERE s.company_id=? AND s.status='active'
       ORDER BY p.captured_at DESC LIMIT 500`,
      [companyId || ''],
    );
    res.json({ employees: rows });
  });
}

function getAuthorizedCompanyIds(req: Request, deps: Deps): Set<string> {
  const user = deps.getRequestUser(req);
  return new Set(
    [...(user?.companyIds || []), user?.companyId || '']
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
}

async function resolveAuthorizedCompanyId(req: Request, requestedCompanyId: string, deps: Deps): Promise<string | null> {
  const normalized = requestedCompanyId.trim();
  if (!normalized) return null;
  if (getAuthorizedCompanyIds(req, deps).has(normalized)) return normalized;

  // Some authenticated Dolibarr users are resolved on demand rather than being
  // present in the in-memory user cache. Match their server-resolved workspace
  // before rejecting a legitimate location upload.
  const resolvedCompanyId = await deps.resolveRequestCompanyId(req);
  return resolvedCompanyId === normalized ? normalized : null;
}

async function requireActiveAttendance(employeeId: string, res: any, deps: Deps): Promise<AttendanceRecord | null> {
  if (!employeeId) {
    res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Sign in again before starting field work.' });
    return null;
  }
  const active = await deps.findActiveAttendance(employeeId);
  if (!active) {
    res.status(403).json({ code: 'CHECK_IN_REQUIRED', message: 'Check in before starting directions or a visit.' });
    return null;
  }
  return active;
}

async function ensureTables(pool: Pool): Promise<void> {
  if (!tablePromise) {
    tablePromise = (async () => {
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS lff_tracking_sessions (
          id VARCHAR(64) NOT NULL,
          company_id VARCHAR(64) NOT NULL,
          employee_id VARCHAR(64) NOT NULL,
          started_at DATETIME(3) NOT NULL,
          ended_at DATETIME(3) NULL,
          status ENUM('active','completed') NOT NULL DEFAULT 'active',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          PRIMARY KEY (id),
          KEY idx_lff_tracking_sessions_company_status (company_id, status),
          KEY idx_lff_tracking_sessions_employee_started (employee_id, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS lff_tracking_points (
          point_id VARCHAR(64) NOT NULL,
          session_id VARCHAR(64) NOT NULL,
          company_id VARCHAR(64) NOT NULL,
          employee_id VARCHAR(64) NOT NULL,
          sequence_no INT UNSIGNED NOT NULL,
          latitude DECIMAL(10,7) NOT NULL,
          longitude DECIMAL(10,7) NOT NULL,
          accuracy DECIMAL(8,2) NULL,
          speed DECIMAL(8,3) NULL,
          heading DECIMAL(7,2) NULL,
          battery TINYINT UNSIGNED NULL,
          mocked TINYINT(1) NOT NULL DEFAULT 0,
          captured_at DATETIME(3) NOT NULL,
          route_eligible TINYINT(1) NOT NULL DEFAULT 0,
          rejection_reason VARCHAR(64) NULL,
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (point_id),
          UNIQUE KEY uq_lff_tracking_points_session_sequence (session_id, sequence_no),
          KEY idx_lff_tracking_points_company_time (company_id, captured_at),
          KEY idx_lff_tracking_points_employee_time (employee_id, captured_at),
          CONSTRAINT fk_lff_tracking_points_session FOREIGN KEY (session_id)
            REFERENCES lff_tracking_sessions(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS lff_place_assignments (
          id VARCHAR(64) NOT NULL,
          company_id VARCHAR(64) NOT NULL,
          employee_id VARCHAR(64) NOT NULL,
          assigned_by VARCHAR(64) NOT NULL,
          place_id VARCHAR(256) NOT NULL,
          place_name VARCHAR(200) NOT NULL,
          place_address VARCHAR(500) NOT NULL DEFAULT '',
          latitude DECIMAL(10,7) NOT NULL,
          longitude DECIMAL(10,7) NOT NULL,
          queue_order INT UNSIGNED NOT NULL,
          scheduled_date DATE NOT NULL,
          scheduled_time TIME NOT NULL,
          notes VARCHAR(500) NULL,
          status ENUM('pending','in_progress','completed','cancelled') NOT NULL DEFAULT 'pending',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          started_at DATETIME(3) NULL,
          completed_at DATETIME(3) NULL,
          arrival_latitude DECIMAL(10,7) NULL,
          arrival_longitude DECIMAL(10,7) NULL,
          arrival_accuracy DECIMAL(8,2) NULL,
          completion_latitude DECIMAL(10,7) NULL,
          completion_longitude DECIMAL(10,7) NULL,
          completion_accuracy DECIMAL(8,2) NULL,
          PRIMARY KEY (id),
          KEY idx_lff_place_assignments_employee_queue (company_id, employee_id, status, queue_order),
          KEY idx_lff_place_assignments_company_status (company_id, status),
          KEY idx_lff_place_assignments_employee_schedule (company_id, employee_id, scheduled_date, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
      // Add the visit lifecycle fields to databases created by earlier builds.
      await pool.execute(
        `ALTER TABLE lff_place_assignments
         MODIFY COLUMN status ENUM('pending','in_progress','completed','cancelled') NOT NULL DEFAULT 'pending'`,
      );
      await ensureColumn(pool, 'lff_place_assignments', 'scheduled_date', 'DATE NULL AFTER queue_order');
      await ensureColumn(pool, 'lff_place_assignments', 'scheduled_time', 'TIME NULL AFTER scheduled_date');
      await ensureColumn(pool, 'lff_place_assignments', 'started_at', 'DATETIME(3) NULL AFTER updated_at');
      // Legacy assignments predate scheduling. Give them a deterministic local
      // work date/time before enforcing the new non-null contract.
      await pool.execute(
        `UPDATE lff_place_assignments
         SET scheduled_date=COALESCE(scheduled_date,
               CASE WHEN status IN ('pending','in_progress')
                    THEN DATE(CONVERT_TZ(UTC_TIMESTAMP(3), '+00:00', '+05:30'))
                    ELSE DATE(CONVERT_TZ(COALESCE(started_at, completed_at, created_at), '+00:00', '+05:30')) END),
             scheduled_time=COALESCE(scheduled_time,
               TIME(CONVERT_TZ(COALESCE(started_at, created_at), '+00:00', '+05:30')))
         WHERE scheduled_date IS NULL OR scheduled_time IS NULL`,
      );
      await pool.execute(
        `ALTER TABLE lff_place_assignments
         MODIFY COLUMN scheduled_date DATE NOT NULL,
         MODIFY COLUMN scheduled_time TIME NOT NULL`,
      );
      await ensureColumn(pool, 'lff_place_assignments', 'arrival_latitude', 'DECIMAL(10,7) NULL AFTER completed_at');
      await ensureColumn(pool, 'lff_place_assignments', 'arrival_longitude', 'DECIMAL(10,7) NULL AFTER arrival_latitude');
      await ensureColumn(pool, 'lff_place_assignments', 'arrival_accuracy', 'DECIMAL(8,2) NULL AFTER arrival_longitude');
      await ensureColumn(pool, 'lff_place_assignments', 'completion_latitude', 'DECIMAL(10,7) NULL AFTER arrival_accuracy');
      await ensureColumn(pool, 'lff_place_assignments', 'completion_longitude', 'DECIMAL(10,7) NULL AFTER completion_latitude');
      await ensureColumn(pool, 'lff_place_assignments', 'completion_accuracy', 'DECIMAL(8,2) NULL AFTER completion_longitude');
      await ensureIndex(
        pool,
        'lff_place_assignments',
        'idx_lff_place_assignments_employee_schedule',
        '(company_id, employee_id, scheduled_date, status)',
      );
    })().catch((error) => {
      tablePromise = null;
      throw error;
    });
  }
  await tablePromise;
}

async function ensureColumn(pool: Pool, table: string, column: string, definition: string): Promise<void> {
  const [rows] = await pool.execute<any[]>(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [table, column],
  );
  if (!rows.length) await pool.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function ensureIndex(pool: Pool, table: string, index: string, columns: string): Promise<void> {
  const [rows] = await pool.execute<any[]>(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=? LIMIT 1`,
    [table, index],
  );
  if (!rows.length) await pool.execute(`CREATE INDEX \`${index}\` ON \`${table}\` ${columns}`);
}

export async function getFieldVisitAutoCheckoutProtection(
  pool: Pool,
  employeeId: string,
  scheduledDate: string,
  companyId?: string | null,
): Promise<{ protected: boolean; visitCount: number }> {
  if (!employeeId || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    return { protected: false, visitCount: 0 };
  }
  await ensureTables(pool);
  const params: string[] = [employeeId, scheduledDate];
  const companyFilter = companyId ? ' AND company_id=?' : '';
  if (companyId) params.push(companyId);
  const [rows] = await pool.execute<any[]>(
    `SELECT COUNT(*) AS visit_count
     FROM lff_place_assignments
     WHERE employee_id=? AND scheduled_date=? AND status<>'cancelled'${companyFilter}`,
    params,
  );
  const visitCount = Math.max(0, Number(rows[0]?.visit_count || 0));
  return { protected: visitCount > 0, visitCount };
}

/**
 * An employee-facing user may begin a scheduled field-work day from their current
 * location. The server, rather than the mobile client, owns this exception so
 * an arbitrary employee cannot bypass the office attendance boundary.
 */
export async function getFieldVisitRemoteCheckInEligibility(
  pool: Pool,
  employeeId: string,
  scheduledDate: string,
  companyId: string,
): Promise<{ remoteCheckInAllowed: boolean; visitCount: number }> {
  if (!employeeId || !companyId || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
    return { remoteCheckInAllowed: false, visitCount: 0 };
  }
  await ensureTables(pool);
  const [rows] = await pool.execute<any[]>(
    `SELECT COUNT(*) AS visit_count
     FROM lff_place_assignments
     WHERE employee_id=? AND company_id=? AND scheduled_date=? AND status<>'cancelled'`,
    [employeeId, companyId, scheduledDate],
  );
  const visitCount = Math.max(0, Number(rows[0]?.visit_count || 0));
  return { remoteCheckInAllowed: visitCount > 0, visitCount };
}

function mapAssignment(row: Record<string, unknown>) {
  return {
    assignmentId: String(row.id || ''),
    companyId: String(row.company_id || ''),
    employeeId: String(row.employee_id || ''),
    assignedBy: String(row.assigned_by || ''),
    placeId: String(row.place_id || ''),
    placeName: String(row.place_name || 'Assigned place'),
    placeAddress: String(row.place_address || ''),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    queueOrder: Number(row.queue_order || 0),
    scheduledDate: toSqlDateKey(row.scheduled_date),
    scheduledTime: toSqlTime(row.scheduled_time),
    notes: String(row.notes || ''),
    status: String(row.status || 'pending'),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
    arrivalLocation: row.arrival_latitude == null || row.arrival_longitude == null ? null : {
      latitude: Number(row.arrival_latitude),
      longitude: Number(row.arrival_longitude),
      accuracy: row.arrival_accuracy == null ? null : Number(row.arrival_accuracy),
    },
    completionLocation: row.completion_latitude == null || row.completion_longitude == null ? null : {
      latitude: Number(row.completion_latitude),
      longitude: Number(row.completion_longitude),
      accuracy: row.completion_accuracy == null ? null : Number(row.completion_accuracy),
    },
  };
}

function toSqlDateKey(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
  return match?.[1] || '';
}

function toSqlTime(value: unknown): string {
  const match = /^(\d{2}:\d{2})/.exec(String(value || ''));
  return match?.[1] || '09:00';
}

async function probe(baseValue: string, path: string): Promise<boolean> {
  const base = baseValue.trim().replace(/\/$/, '');
  if (!base) return false;
  try {
    const token = (process.env.GEOSPATIAL_API_TOKEN || '').trim();
    const response = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function toSqlDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_date');
  return parsed;
}

type KpiPoint = {
  sessionId: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  capturedAt: number;
  routeEligible: boolean;
  rejectionReason: string | null;
};

type DailyTrackingSummary = {
  date: string;
  sessionCount: number;
  shiftSeconds: number;
  movingSeconds: number;
  haltSeconds: number;
  haltCount: number;
  activeHalt: boolean;
  distanceMetres: number;
  averageMovingSpeedKmh: number | null;
  totalPoints: number;
  acceptedPoints: number;
  gpsAccuracyMetres: number | null;
  lastCapturedAt: string | null;
  lastPointAgeSeconds: number | null;
  activity: FieldActivityEvent[];
};

function normalizeTimezoneOffset(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(-720, Math.min(840, Math.round(parsed))) : 330;
}

function localDateKey(milliseconds: number, offsetMinutes: number): string {
  return new Date(milliseconds + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function localDateBounds(date: string, offsetMinutes: number): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid_tracking_date');
  const localMidnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(localMidnightUtc)) throw new Error('invalid_tracking_date');
  const startMs = localMidnightUtc - offsetMinutes * 60_000;
  return { start: new Date(startMs), end: new Date(startMs + 24 * 60 * 60 * 1000) };
}

function monthDateBounds(month: string, offsetMinutes: number): { start: Date; end: Date; firstDate: string; nextDate: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('invalid_tracking_month');
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) throw new Error('invalid_tracking_month');
  const firstDate = `${year.toString().padStart(4, '0')}-${monthNumber.toString().padStart(2, '0')}-01`;
  const nextMonthUtc = Date.UTC(year, monthNumber, 1);
  const nextDate = new Date(nextMonthUtc).toISOString().slice(0, 10);
  const start = localDateBounds(firstDate, offsetMinutes).start;
  const end = localDateBounds(nextDate, offsetMinutes).start;
  return { start, end, firstDate, nextDate };
}

export function summarizeTrackingDay(points: KpiPoint[], date: string, offsetMinutes: number, now = Date.now()): DailyTrackingSummary {
  const dayPoints = points
    .filter((point) => Number.isFinite(point.capturedAt) && localDateKey(point.capturedAt, offsetMinutes) === date)
    .sort((left, right) => left.capturedAt - right.capturedAt || left.sequence - right.sequence);
  // Route points describe travelled geometry. Stationary-noise points are not
  // drawn on the map, but are valuable evidence that the device stayed at the
  // same place. Keeping both sets separate prevents GPS jitter from inflating
  // distance while still allowing accurate halt durations.
  const accepted = dayPoints.filter(isTrackingEvidence);
  const bySession = new Map<string, KpiPoint[]>();
  for (const point of accepted) {
    const list = bySession.get(point.sessionId) ?? [];
    list.push(point);
    bySession.set(point.sessionId, list);
  }

  let shiftSeconds = 0;
  let movingSeconds = 0;
  let haltSeconds = 0;
  let haltCount = 0;
  let activeHalt = false;
  let distanceMetres = 0;
  const activity: FieldActivityEvent[] = [];
  const today = localDateKey(now, offsetMinutes);
  for (const sessionPoints of bySession.values()) {
    const first = sessionPoints[0];
    const last = sessionPoints.at(-1);
    if (!first || !last) continue;
    const recentlyActive = date === today && now - last.capturedAt >= 0 && now - last.capturedAt <= LIVE_POINT_FRESHNESS_MS;
    const derived = deriveFieldActivity(sessionPoints, recentlyActive ? now : last.capturedAt);
    shiftSeconds += observedTrackingSeconds(sessionPoints, recentlyActive ? now : null);
    movingSeconds += derived.movingSeconds;
    distanceMetres += gpsDistanceMetres(sessionPoints);
    haltSeconds += derived.totalHaltSeconds;
    haltCount += derived.haltCount;
    activeHalt = activeHalt || derived.activeHalt;
    activity.push(...derived.events);
  }
  const boundedHaltSeconds = Math.min(shiftSeconds, Math.max(0, Math.round(haltSeconds)));
  const boundedMovingSeconds = Math.min(
    Math.max(0, shiftSeconds - boundedHaltSeconds),
    Math.max(0, Math.round(movingSeconds)),
  );
  const latest = accepted.at(-1) ?? null;
  return {
    date,
    sessionCount: bySession.size,
    shiftSeconds,
    movingSeconds: boundedMovingSeconds,
    haltSeconds: boundedHaltSeconds,
    haltCount,
    activeHalt,
    distanceMetres: Math.round(distanceMetres),
    averageMovingSpeedKmh: boundedMovingSeconds >= 60 && distanceMetres > 0
      ? Number(((distanceMetres / boundedMovingSeconds) * 3.6).toFixed(1))
      : null,
    totalPoints: dayPoints.length,
    acceptedPoints: accepted.length,
    gpsAccuracyMetres: latest?.accuracy ?? null,
    lastCapturedAt: latest ? new Date(latest.capturedAt).toISOString() : null,
    lastPointAgeSeconds: latest ? Math.max(0, Math.floor((now - latest.capturedAt) / 1000)) : null,
    activity: activity.sort((left, right) => left.startedAt - right.startedAt),
  };
}

function mapDailyActivity(events: FieldActivityEvent[]) {
  return events.slice(-12).reverse().map((event) => ({
    id: event.id,
    type: event.type,
    startedAt: new Date(event.startedAt).toISOString(),
    endedAt: event.endedAt == null ? null : new Date(event.endedAt).toISOString(),
    distanceMetres: Math.round(event.distanceMetres),
    start: { latitude: event.start.latitude, longitude: event.start.longitude },
    end: { latitude: event.end.latitude, longitude: event.end.longitude },
    active: event.active,
  }));
}

function thinTrackingPoints(points: KpiPoint[], maximum = 3000): KpiPoint[] {
  if (points.length <= maximum) return points;
  const step = (points.length - 1) / (maximum - 1);
  const thinned: KpiPoint[] = [];
  for (let index = 0; index < maximum; index += 1) thinned.push(points[Math.round(index * step)]!);
  return thinned;
}

function asDateMillis(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value || '')).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function asIsoDate(value: unknown): string {
  const milliseconds = asDateMillis(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : new Date(0).toISOString();
}

function mapKpiPoint(row: Record<string, unknown>): KpiPoint {
  return {
    sessionId: String(row.session_id || ''),
    sequence: Number(row.sequence_no || 0),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
    speed: row.speed == null ? null : Number(row.speed),
    capturedAt: asDateMillis(row.captured_at),
    routeEligible: Boolean(row.route_eligible),
    rejectionReason: row.rejection_reason == null ? null : String(row.rejection_reason),
  };
}

function isValidKpiPoint(point: KpiPoint): boolean {
  return Number.isFinite(point.latitude)
    && Number.isFinite(point.longitude)
    && Number.isFinite(point.capturedAt);
}

function haversineMetres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const formula = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(formula)));
}

const MAX_OBSERVED_GAP_SECONDS = 3 * 60;
const LIVE_POINT_FRESHNESS_MS = 2 * 60_000;
const MINIMUM_HALT_SECONDS = 3 * 60;

function isTrackingEvidence(point: KpiPoint): boolean {
  const usableAccuracy = point.accuracy == null || point.accuracy <= 80;
  return usableAccuracy && (point.routeEligible || point.rejectionReason === 'stationary_noise');
}

function gpsNoiseGateMetres(left: KpiPoint, right: KpiPoint): number {
  const leftAccuracy = Math.max(0, left.accuracy ?? 10);
  const rightAccuracy = Math.max(0, right.accuracy ?? 10);
  return Math.max(5, Math.min(25, Math.hypot(leftAccuracy, rightAccuracy) * 0.35));
}

function gpsDistanceMetres(points: KpiPoint[]): number {
  return points.reduce((total, point, index) => {
    if (index === 0) return total;
    const previous = points[index - 1]!;
    const elapsedSeconds = (point.capturedAt - previous.capturedAt) / 1000;
    // A long data gap cannot be represented by a straight line reliably.
    if (elapsedSeconds <= 0 || elapsedSeconds > MAX_OBSERVED_GAP_SECONDS) return total;
    // Two stationary evidence samples describe dwell time, not travel.
    if (!previous.routeEligible && !point.routeEligible) return total;
    const distance = haversineMetres(previous, point);
    if (distance <= gpsNoiseGateMetres(previous, point)) return total;
    if (distance / elapsedSeconds > 70) return total;
    return total + distance;
  }, 0);
}

function observedTrackingSeconds(points: KpiPoint[], liveNow: number | null): number {
  let seconds = 0;
  for (let index = 1; index < points.length; index += 1) {
    const elapsed = (points[index]!.capturedAt - points[index - 1]!.capturedAt) / 1000;
    if (elapsed > 0 && elapsed <= MAX_OBSERVED_GAP_SECONDS) seconds += elapsed;
  }
  const last = points.at(-1);
  if (last && liveNow != null) {
    seconds += Math.max(0, Math.min(MAX_OBSERVED_GAP_SECONDS, (liveNow - last.capturedAt) / 1000));
  }
  return Math.round(seconds);
}

function splitContinuousPointRanges(points: KpiPoint[]): Array<{ start: number; end: number }> {
  if (!points.length) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    const elapsed = (points[index]!.capturedAt - points[index - 1]!.capturedAt) / 1000;
    if (elapsed <= 0 || elapsed > MAX_OBSERVED_GAP_SECONDS) {
      ranges.push({ start, end: index - 1 });
      start = index;
    }
  }
  ranges.push({ start, end: points.length - 1 });
  return ranges;
}

type FieldActivityEvent = {
  id: string;
  type: 'movement' | 'halt';
  startedAt: number;
  endedAt: number | null;
  distanceMetres: number;
  start: KpiPoint;
  end: KpiPoint;
  active: boolean;
};

function deriveFieldActivity(points: KpiPoint[], now: number): {
  totalHaltSeconds: number;
  movingSeconds: number;
  haltCount: number;
  activeHalt: boolean;
  events: FieldActivityEvent[];
} {
  const haltRanges: { start: number; end: number; active: boolean; durationSeconds: number }[] = [];

  for (const range of splitContinuousPointRanges(points)) {
    for (let start = range.start; start < range.end;) {
      let end = start;
      const anchor = points[start]!;
      while (end + 1 <= range.end) {
        const next = points[end + 1]!;
        const radius = Math.max(25, Math.min(50, Math.max(anchor.accuracy ?? 10, next.accuracy ?? 10) * 1.25));
        if (haversineMetres(anchor, next) > radius) break;
        end += 1;
      }

      const startedAt = anchor.capturedAt;
      const endedAt = points[end]!.capturedAt;
      const durationSeconds = Math.max(0, (endedAt - startedAt) / 1000);
      const isLatestCluster = end === points.length - 1 && now - endedAt >= 0 && now - endedAt <= LIVE_POINT_FRESHNESS_MS;
      if (end > start && durationSeconds >= MINIMUM_HALT_SECONDS) {
        haltRanges.push({
          start,
          end,
          active: isLatestCluster,
          durationSeconds: isLatestCluster ? Math.max(durationSeconds, (now - startedAt) / 1000) : durationSeconds,
        });
        start = end + 1;
      } else {
        start += 1;
      }
    }
  }

  const events: FieldActivityEvent[] = [];
  const addMovement = (fromIndex: number, toIndex: number) => {
    if (toIndex <= fromIndex) return;
    const from = points[fromIndex]!;
    const to = points[toIndex]!;
    const distanceMetres = gpsDistanceMetres(points.slice(fromIndex, toIndex + 1));
    if (distanceMetres < 5) return;
    events.push({
      id: `move-${from.capturedAt}-${to.capturedAt}`,
      type: 'movement',
      startedAt: from.capturedAt,
      endedAt: to.capturedAt,
      distanceMetres,
      start: from,
      end: to,
      active: false,
    });
  };

  for (const range of splitContinuousPointRanges(points)) {
    let cursor = range.start;
    const rangeHalts = haltRanges.filter((halt) => halt.start >= range.start && halt.end <= range.end);
    rangeHalts.forEach((halt) => {
      addMovement(cursor, halt.start);
      const from = points[halt.start]!;
      const to = points[halt.end]!;
      events.push({
        id: `halt-${from.capturedAt}-${to.capturedAt}`,
        type: 'halt',
        startedAt: from.capturedAt,
        endedAt: halt.active ? null : to.capturedAt,
        distanceMetres: haversineMetres(from, to),
        start: from,
        end: to,
        active: halt.active,
      });
      cursor = halt.end;
    });
    addMovement(cursor, range.end);
  }

  const movingSeconds = events
    .filter((event) => event.type === 'movement')
    .reduce((total, event) => total + Math.max(0, ((event.endedAt ?? event.startedAt) - event.startedAt) / 1000), 0);

  return {
    totalHaltSeconds: Math.round(haltRanges.reduce((total, halt) => total + halt.durationSeconds, 0)),
    movingSeconds: Math.round(movingSeconds),
    haltCount: haltRanges.length,
    activeHalt: haltRanges.some((halt) => halt.active),
    events,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Geospatial service request failed.';
}
