import type { Express, RequestHandler } from "express";
import type { LocationLog } from "@/lib/types";

export type LocationRouteDeps = {
  requireAuth: RequestHandler;
  requireRoles: (...roles: any[]) => RequestHandler;
  firstString: (value: unknown) => string;
  ensureUserMatch: (req: any, userId: string) => boolean;
  isMySqlStateEnabled: () => boolean;
  storage: {
    getLocationLogsLatest: () => Promise<LocationLog[]>;
    getLocationLogsForDate: (date: string) => Promise<LocationLog[]>;
    getLocationLogsForUserDate: (userId: string, date: string) => Promise<LocationLog[]>;
    getAttendanceHistory: (userId: string) => Promise<any[]>;
  };
  listLocationLogsLatestFromMySql: () => Promise<LocationLog[]>;
  listLocationLogsForDateFromMySql: (date: string) => Promise<LocationLog[]>;
  listLocationLogsForUserDateFromMySql: (userId: string, date: string) => Promise<LocationLog[]>;
  listAttendanceHistoryFromMySql: (userId: string, dateKey: string) => Promise<any[]>;
  toMumbaiDateKey: (date: Date) => string;
  isIsoDateString: (value: string) => boolean;
  parseBooleanQuery: (value: unknown, defaultValue: boolean) => boolean;
  parseIntervalMinutes: (value: unknown, defaultValue: number) => number;
  downsampleLocationLogsByInterval: (logs: LocationLog[], intervalMinutes: number) => LocationLog[];
  isMumbaiDateKey: (isoValue: string, dateKey: string) => boolean;
  resolveRouteSessionWindow: (events: any[]) => any;
  filterLocationLogsToSessionWindow: (logs: LocationLog[], sessionWindow: any) => LocationLog[];
  buildRouteTimeline: (userId: string, date: string, points: LocationLog[]) => any;
  getRouteDailySummaryFromMySql: (userId: string, date: string) => Promise<any | null>;
  upsertRouteDailySummaryInMySql: (
    userId: string,
    date: string,
    timeline: any,
    attendanceEvents: any[],
    rawPointCount?: number,
  ) => Promise<void>;
  getMapplsDirectionsForLogs: (points: LocationLog[], options: any) => Promise<any>;
  getMapplsDistanceMatrixForLogs: (points: LocationLog[], options: any) => Promise<any>;
  parseOptionalInteger: (value: unknown) => number | null;
};

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export function registerLocationRoutes(app: Express, deps: LocationRouteDeps) {
  app.get(
    "/api/admin/live-map",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager"),
    async (_req, res) => {
      res.set(noStoreHeaders);
      if (deps.isMySqlStateEnabled()) {
        try {
          const latest = await deps.listLocationLogsLatestFromMySql();
          res.json(latest);
          return;
        } catch (error) {
          console.error("Failed to read latest location logs from MySQL", error);
        }
      }
      const latest = await deps.storage.getLocationLogsLatest();
      res.json(latest);
    },
  );

  app.get(
    "/api/admin/live-map/routes",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      res.set(noStoreHeaders);
      const requestedDate = deps.firstString(req.query.date) || deps.toMumbaiDateKey(new Date());
      if (!deps.isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const useRawPoints = deps.parseBooleanQuery(req.query.raw, false);
      const intervalMinutes = useRawPoints
        ? 0
        : deps.parseIntervalMinutes(req.query.interval_minutes, 1);
      let allPoints: LocationLog[] = [];
      if (deps.isMySqlStateEnabled()) {
        try {
          allPoints = await deps.listLocationLogsForDateFromMySql(requestedDate);
        } catch (error) {
          console.error("Failed to read location logs for date from MySQL", error);
          allPoints = await deps.storage.getLocationLogsForDate(requestedDate);
        }
      } else {
        allPoints = await deps.storage.getLocationLogsForDate(requestedDate);
      }
      const byUser = new Map<string, LocationLog[]>();
      for (const point of allPoints) {
        const bucket = byUser.get(point.userId) ?? [];
        bucket.push(point);
        byUser.set(point.userId, bucket);
      }

      const routes = Array.from(byUser.entries())
        .map(([userId, userPoints]) => {
          const sampled = useRawPoints
            ? [...userPoints].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
            : deps.downsampleLocationLogsByInterval(userPoints, intervalMinutes);
          return {
            userId,
            intervalMinutes,
            pointCount: sampled.length,
            points: sampled,
            latestPoint: sampled.length ? sampled[sampled.length - 1] : null,
          };
        })
        .sort((a, b) => {
          const aTime = a.latestPoint?.capturedAt || "";
          const bTime = b.latestPoint?.capturedAt || "";
          return bTime.localeCompare(aTime);
        });

      res.json({
        date: requestedDate,
        intervalMinutes,
        routes,
      });
    },
  );

  app.get(
    "/api/admin/route/:id",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager", "salesperson"),
    async (req, res) => {
      const userId = deps.firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      if (!deps.ensureUserMatch(req, userId)) {
        res.status(403).json({ message: "Token user mismatch" });
        return;
      }

      const requestedDate = deps.firstString(req.query.date) || deps.toMumbaiDateKey(new Date());
      if (!deps.isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }

      const useRawPoints = deps.parseBooleanQuery(req.query.raw, false);
      const intervalMinutes = useRawPoints
        ? 0
        : deps.parseIntervalMinutes(req.query.interval_minutes, 1);
      let rawLocationPoints: LocationLog[] = [];
      if (deps.isMySqlStateEnabled()) {
        try {
          rawLocationPoints = await deps.listLocationLogsForUserDateFromMySql(
            userId,
            requestedDate,
          );
        } catch (error) {
          console.error("Failed to read user location logs for date from MySQL", error);
          rawLocationPoints = await deps.storage.getLocationLogsForUserDate(userId, requestedDate);
        }
      } else {
        rawLocationPoints = await deps.storage.getLocationLogsForUserDate(userId, requestedDate);
      }
      const attendance = deps.isMySqlStateEnabled()
        ? await deps
            .listAttendanceHistoryFromMySql(userId, requestedDate)
            .catch(() => deps.storage.getAttendanceHistory(userId))
        : await deps.storage.getAttendanceHistory(userId);
      const attendanceEvents = attendance
        .filter((record) => deps.isMumbaiDateKey(record.timestamp, requestedDate))
        .map((record) => ({
          id: record.id,
          type: record.type,
          at: record.timestamp,
          geofenceName: record.geofenceName ?? null,
          latitude: record.location?.lat ?? null,
          longitude: record.location?.lng ?? null,
        }))
        .sort((a, b) => a.at.localeCompare(b.at));
      const sessionWindow = deps.resolveRouteSessionWindow(attendanceEvents);
      const windowedPoints = deps.filterLocationLogsToSessionWindow(
        rawLocationPoints,
        sessionWindow,
      );
      const points = useRawPoints
        ? [...windowedPoints].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
        : deps.downsampleLocationLogsByInterval(windowedPoints, intervalMinutes);
      if (!rawLocationPoints.length && deps.isMySqlStateEnabled()) {
        try {
          const summaryTimeline = await deps.getRouteDailySummaryFromMySql(userId, requestedDate);
          if (summaryTimeline) {
            res.json({
              ...summaryTimeline,
              intervalMinutes,
              directions: null,
              attendanceEvents: summaryTimeline.attendanceEvents?.length
                ? summaryTimeline.attendanceEvents
                : attendanceEvents,
            });
            return;
          }
        } catch (error) {
          console.warn(
            "Failed to read route daily summary from MySQL",
            error instanceof Error ? error.message : error,
          );
        }
      }
      const timeline = deps.buildRouteTimeline(userId, requestedDate, points);
      const timelineWithRawCount = {
        ...timeline,
        summary: {
          ...timeline.summary,
          rawPointCount: rawLocationPoints.length,
        },
      };
      if (points.length && deps.isMySqlStateEnabled()) {
        void deps.upsertRouteDailySummaryInMySql(
          userId,
          requestedDate,
          { ...timelineWithRawCount, source: "raw_logs" },
          attendanceEvents,
          rawLocationPoints.length,
        ).catch((error) => {
          console.warn(
            "Failed to upsert route daily summary",
            error instanceof Error ? error.message : error,
          );
        });
      }
      const directions = await deps.getMapplsDirectionsForLogs(points, {
        resource: deps.firstString(req.query.routing_resource) || null,
        profile: deps.firstString(req.query.routing_profile) || null,
        overview: deps.firstString(req.query.routing_overview) || null,
        geometries: deps.firstString(req.query.routing_geometries) || null,
        alternatives: deps.parseBooleanQuery(req.query.routing_alternatives, false),
        steps: deps.parseBooleanQuery(req.query.routing_steps, true),
        region: deps.firstString(req.query.routing_region) || null,
        routeType: deps.parseOptionalInteger(req.query.routing_rtype),
      });

      res.json({
        ...timelineWithRawCount,
        intervalMinutes,
        directions,
        attendanceEvents,
        source: "raw_logs",
      });
    },
  );

  app.get(
    "/api/admin/route/:id/matrix",
    deps.requireAuth,
    deps.requireRoles("admin", "hr", "manager", "salesperson"),
    async (req, res) => {
      const userId = deps.firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      if (!deps.ensureUserMatch(req, userId)) {
        res.status(403).json({ message: "Token user mismatch" });
        return;
      }

      const requestedDate = deps.firstString(req.query.date) || deps.toMumbaiDateKey(new Date());
      if (!deps.isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }

      const points = await deps.storage.getLocationLogsForUserDate(userId, requestedDate);

      if (points.length < 2) {
        res.status(400).json({ message: "At least 2 route points are required for matrix" });
        return;
      }

      const matrix = await deps.getMapplsDistanceMatrixForLogs(points, {
        resource: deps.firstString(req.query.distance_resource) || null,
        profile: deps.firstString(req.query.distance_profile) || null,
        region: deps.firstString(req.query.distance_region) || null,
        routeType: deps.parseOptionalInteger(req.query.distance_rtype),
      });

      if (!matrix) {
        res.status(400).json({
          message: "Mappls routing API key missing. Configure MAPPLS_ROUTING_API_KEY in server env.",
        });
        return;
      }

      res.json({
        userId,
        date: requestedDate,
        matrix,
      });
    },
  );
}
