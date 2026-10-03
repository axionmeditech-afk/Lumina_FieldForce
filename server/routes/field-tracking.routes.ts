import type { Express, Request } from 'express';
import type { Pool } from 'mysql2/promise';
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
      probe(process.env.NOMINATIM_URL || process.env.GEOCODER_BASE_URL || '', '/status?format=json'),
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

  app.post('/api/field-tracking/locations/batch', deps.requireAuth, requireStore, async (req, res) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid location batch.', issues: parsed.error.issues });
      return;
    }
    const companyId = resolveAuthorizedCompanyId(req, parsed.data.companyId, deps);
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

  app.get('/api/field-tracking/live', deps.requireAuth, requireStore, async (req, res) => {
    if (!['admin', 'hr', 'manager'].includes(req.auth?.role || '')) {
      res.status(403).json({ message: 'Supervisor access is required.' });
      return;
    }
    const requestedCompanyId = String(req.query.companyId || '').trim();
    const companyId = requestedCompanyId
      ? resolveAuthorizedCompanyId(req, requestedCompanyId, deps)
      : await deps.resolveRequestCompanyId(req);
    if (!companyId) {
      res.status(403).json({ message: 'Workspace access is required for live tracking.' });
      return;
    }
    const pool = await deps.getMySqlPool();
    const [rows] = await pool.execute<any[]>(
      `SELECT s.id AS session_id, s.employee_id, p.latitude, p.longitude, p.accuracy,
              p.speed, p.heading, p.captured_at, p.sequence_no
       FROM lff_tracking_sessions s
       JOIN lff_tracking_points p ON p.point_id=(
         SELECT p2.point_id FROM lff_tracking_points p2
         WHERE p2.session_id=s.id AND (p2.route_eligible=1 OR p2.rejection_reason='stationary_noise')
         ORDER BY p2.sequence_no DESC LIMIT 1
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

function resolveAuthorizedCompanyId(req: Request, requestedCompanyId: string, deps: Deps): string | null {
  const normalized = requestedCompanyId.trim();
  return normalized && getAuthorizedCompanyIds(req, deps).has(normalized) ? normalized : null;
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
    })().catch((error) => {
      tablePromise = null;
      throw error;
    });
  }
  await tablePromise;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Geospatial service request failed.';
}
