import type { Express, Request } from 'express';
import type { Pool } from 'mysql2/promise';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { computeRoute, matchTrace, searchPlaces } from '@/server/services/field-geospatial';

type Deps = {
  requireAuth: (req: any, res: any, next: any) => void;
  getMySqlPool: () => Promise<Pool>;
  isMySqlStateEnabled: () => boolean;
  resolveRequestCompanyId: (req: Request) => Promise<string | null>;
  getRequestUser: (req: Request) => { companyId?: string | null; companyIds?: string[] | null } | null;
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
});

const assignmentSchema = z.object({
  employeeId: z.string().trim().min(1).max(64),
  place: coordinateSchema.extend({
    placeId: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).default(''),
  }),
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
      res.json({ apiReachable: true, routerReachable: healthCache.routerReachable, geocoderReachable: healthCache.geocoderReachable });
      return;
    }
    const [routerReachable, geocoderReachable] = await Promise.all([
      probe(process.env.VALHALLA_URL || process.env.ROUTER_BASE_URL || '', '/status'),
      // Some Nominatim images expose /status inconsistently while their actual
      // search API is healthy. Probe the same lightweight endpoint the app uses.
      probe(process.env.NOMINATIM_URL || process.env.GEOCODER_BASE_URL || '', '/search?q=Ahmedabad&format=jsonv2&limit=1'),
    ]);
    healthCache = { checkedAt: Date.now(), routerReachable, geocoderReachable };
    res.json({ apiReachable: true, routerReachable, geocoderReachable });
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

  app.post('/api/field-tracking/route', deps.requireAuth, async (req, res) => {
    const parsed = routeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid route request.' });
      return;
    }
    try {
      const plan = await computeRoute(parsed.data.origin, parsed.data.destination, parsed.data.travelMode);
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
              latitude, longitude, queue_order, notes, status, created_at, completed_at
       FROM lff_place_assignments
       WHERE company_id=? ${supervisor ? '' : 'AND employee_id=?'}
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, employee_id, queue_order, created_at DESC`,
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
    const pool = await deps.getMySqlPool();
    const [sequenceRows] = await pool.execute<any[]>(
      `SELECT COALESCE(MAX(queue_order), 0) AS last_order
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND status='pending'`,
      [companyId, parsed.data.employeeId],
    );
    const queueOrder = Number(sequenceRows[0]?.last_order || 0) + 1;
    const id = randomUUID();
    await pool.execute(
      `INSERT INTO lff_place_assignments
        (id, company_id, employee_id, assigned_by, place_id, place_name, place_address,
         latitude, longitude, queue_order, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(3), NOW(3))`,
      [
        id, companyId, parsed.data.employeeId, String(req.auth?.sub || ''),
        parsed.data.place.placeId, parsed.data.place.name, parsed.data.place.address,
        parsed.data.place.latitude, parsed.data.place.longitude, queueOrder, parsed.data.notes || null,
      ],
    );
    res.status(201).json({
      assignment: {
        assignmentId: id, companyId, employeeId: parsed.data.employeeId,
        assignedBy: String(req.auth?.sub || ''), placeId: parsed.data.place.placeId,
        placeName: parsed.data.place.name, placeAddress: parsed.data.place.address,
        latitude: parsed.data.place.latitude, longitude: parsed.data.place.longitude,
        queueOrder, notes: parsed.data.notes || '', status: 'pending',
        createdAt: new Date().toISOString(), completedAt: null,
      },
    });
  });

  app.post('/api/field-tracking/assignments/:assignmentId/complete', deps.requireAuth, requireStore, async (req, res) => {
    const assignmentId = String(req.params.assignmentId || '').trim();
    if (!assignmentId) {
      res.status(400).json({ message: 'Visit assignment id is required.' });
      return;
    }
    const employeeId = String(req.auth?.sub || '').trim();
    const pool = await deps.getMySqlPool();
    const [result] = await pool.execute<any>(
      `UPDATE lff_place_assignments
       SET status='completed', completed_at=NOW(3), updated_at=NOW(3)
       WHERE id=? AND employee_id=? AND status='pending'`,
      [assignmentId, employeeId],
    );
    if (!result.affectedRows) {
      res.status(404).json({ message: 'This pending visit was not found for your account.' });
      return;
    }
    res.json({ ok: true });
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
    const matched = await matchTrace(points).catch(() => points);
    res.json({ source: matched === points ? 'raw' : 'self-hosted-valhalla', points: matched, lastSequence });
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
      `SELECT sequence_no, latitude, longitude, accuracy, speed, captured_at, route_eligible
       FROM lff_tracking_points
       WHERE session_id=?
       ORDER BY sequence_no ASC
       LIMIT 10000`,
      [sessionId],
    );
    const [visitRows] = await pool.execute<any[]>(
      `SELECT
          COUNT(*) AS total_count,
          SUM(status='completed') AS completed_count
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND status<>'cancelled'`,
      [session.company_id, session.employee_id],
    );
    const [nextVisitRows] = await pool.execute<any[]>(
      `SELECT place_name, place_address, latitude, longitude
       FROM lff_place_assignments
       WHERE company_id=? AND employee_id=? AND status='pending'
       ORDER BY queue_order ASC, created_at ASC
       LIMIT 1`,
      [session.company_id, session.employee_id],
    );

    const points = pointRows.map((row) => ({
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      speed: row.speed == null ? null : Number(row.speed),
      capturedAt: asDateMillis(row.captured_at),
      routeEligible: Boolean(row.route_eligible),
    })).filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Number.isFinite(point.capturedAt));
    const accepted = points.filter((point) => point.routeEligible && (point.accuracy == null || point.accuracy <= 80));
    const latest = accepted.at(-1) ?? null;
    const now = Date.now();
    const shiftStartedAt = asDateMillis(session.started_at);
    const shiftEndedAt = session.status === 'completed' ? asDateMillis(session.ended_at) : now;
    const shiftSeconds = Number.isFinite(shiftStartedAt)
      ? Math.max(0, Math.floor((Math.max(shiftStartedAt, shiftEndedAt) - shiftStartedAt) / 1000))
      : 0;
    const distanceMetres = gpsDistanceMetres(accepted);
    const fieldActivity = deriveFieldActivity(accepted, now);
    const movingSeconds = Math.max(0, shiftSeconds - Math.min(shiftSeconds, fieldActivity.totalHaltSeconds));
    const averageMovingSpeedKmh = movingSeconds >= 60 && distanceMetres > 0
      ? Number(((distanceMetres / movingSeconds) * 3.6).toFixed(1))
      : null;
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
      sessionStartedAt: asIsoDate(session.started_at),
      shiftSeconds,
      movingSeconds,
      haltSeconds: fieldActivity.totalHaltSeconds,
      haltCount: fieldActivity.haltCount,
      activeHalt: fieldActivity.activeHalt,
      distanceMetres: Math.round(distanceMetres),
      averageMovingSpeedKmh,
      totalPoints: points.length,
      acceptedPoints: accepted.length,
      gpsAccuracyMetres: latest?.accuracy ?? null,
      lastCapturedAt: latest ? new Date(latest.capturedAt).toISOString() : null,
      lastPointAgeSeconds: latest ? Math.max(0, Math.floor((now - latest.capturedAt) / 1000)) : null,
      visitTotal: Number(visitRows[0]?.total_count || 0),
      visitCompleted: Number(visitRows[0]?.completed_count || 0),
      nextVisit: nextVisit ? {
        name: String(nextVisit.place_name || 'Next visit'),
        address: String(nextVisit.place_address || ''),
        distanceMetres: distanceToNext == null ? null : Math.round(distanceToNext),
        status: distanceToNext != null && distanceToNext <= arrivalRadius ? 'arrived' : 'en_route',
      } : null,
      activity: fieldActivity.events.slice(-8).reverse().map((event) => ({
        id: event.id,
        type: event.type,
        startedAt: new Date(event.startedAt).toISOString(),
        endedAt: event.endedAt == null ? null : new Date(event.endedAt).toISOString(),
        distanceMetres: Math.round(event.distanceMetres),
        start: { latitude: event.start.latitude, longitude: event.start.longitude },
        end: { latitude: event.end.latitude, longitude: event.end.longitude },
        active: event.active,
      })),
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
          notes VARCHAR(500) NULL,
          status ENUM('pending','completed','cancelled') NOT NULL DEFAULT 'pending',
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          completed_at DATETIME(3) NULL,
          PRIMARY KEY (id),
          KEY idx_lff_place_assignments_employee_queue (company_id, employee_id, status, queue_order),
          KEY idx_lff_place_assignments_company_status (company_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      );
    })().catch((error) => {
      tablePromise = null;
      throw error;
    });
  }
  await tablePromise;
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
    notes: String(row.notes || ''),
    status: String(row.status || 'pending'),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
  };
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
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  capturedAt: number;
  routeEligible: boolean;
};

function asDateMillis(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value || '')).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function asIsoDate(value: unknown): string {
  const milliseconds = asDateMillis(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : new Date(0).toISOString();
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

function gpsDistanceMetres(points: KpiPoint[]): number {
  return points.reduce((total, point, index) => {
    if (index === 0) return total;
    const previous = points[index - 1]!;
    const elapsedSeconds = (point.capturedAt - previous.capturedAt) / 1000;
    // A long data gap cannot be represented by a straight line reliably.
    if (elapsedSeconds <= 0 || elapsedSeconds > 15 * 60) return total;
    return total + haversineMetres(previous, point);
  }, 0);
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
  haltCount: number;
  activeHalt: boolean;
  events: FieldActivityEvent[];
} {
  const minimumHaltSeconds = 3 * 60;
  const haltRadiusMetres = 45;
  const haltRanges: Array<{ start: number; end: number; active: boolean; durationSeconds: number }> = [];

  for (let start = 0; start < points.length - 1;) {
    let end = start;
    let pathDistance = 0;
    while (end + 1 < points.length) {
      const current = points[end]!;
      const next = points[end + 1]!;
      const elapsed = (next.capturedAt - current.capturedAt) / 1000;
      const nextDistanceFromAnchor = haversineMetres(points[start]!, next);
      if (elapsed <= 0 || elapsed > 15 * 60 || nextDistanceFromAnchor > haltRadiusMetres) break;
      pathDistance += haversineMetres(current, next);
      end += 1;
    }

    const startedAt = points[start]!.capturedAt;
    const endedAt = points[end]!.capturedAt;
    const durationSeconds = Math.max(0, (endedAt - startedAt) / 1000);
    const isLatestCluster = end === points.length - 1 && now - endedAt <= 5 * 60 * 1000;
    // A small GPS drift inside the halt radius is expected; larger movement is not a halt.
    if (end > start && durationSeconds >= minimumHaltSeconds && pathDistance <= haltRadiusMetres * 1.5) {
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

  let cursor = 0;
  haltRanges.forEach((halt) => {
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
  addMovement(cursor, points.length - 1);

  return {
    totalHaltSeconds: Math.round(haltRanges.reduce((total, halt) => total + halt.durationSeconds, 0)),
    haltCount: haltRanges.length,
    activeHalt: haltRanges.some((halt) => halt.active),
    events,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Geospatial service request failed.';
}
