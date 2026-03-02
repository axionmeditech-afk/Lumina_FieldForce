import type { LocationLog, RouteHalt, RouteSegment, RouteTimeline } from "@/lib/types";
import { haversineDistanceMeters } from "@/lib/geofence";

interface HaltWindow extends RouteHalt {
  startPointIndex: number;
  endPointIndex: number;
}

export interface RouteAnalyticsOptions {
  haltRadiusMeters?: number;
  haltMinDurationMinutes?: number;
  stationarySpeedMps?: number;
}

const DEFAULT_HALT_RADIUS_METERS = 45;
const DEFAULT_HALT_MIN_DURATION_MINUTES = 10;
const DEFAULT_STATIONARY_SPEED_MPS = 1.1;

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function toMs(value: string): number {
  return new Date(value).getTime();
}

function normalizeBatteryLevel(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const scaled = value <= 1 ? value * 100 : value;
  return Math.round(Math.max(0, Math.min(100, scaled)));
}

function getAverageBatteryLevel(points: LocationLog[]): number | null {
  const values = points
    .map((point) => normalizeBatteryLevel(point.batteryLevel))
    .filter((value): value is number => typeof value === "number");
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function computeEffectiveSpeedMps(distanceMeters: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return distanceMeters / (durationMs / 1000);
}

function mostCommonLabel(points: LocationLog[]): string {
  const bucket = new Map<string, number>();
  for (const point of points) {
    const key = point.geofenceName?.trim() || "Unknown location";
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  let winner = "Unknown location";
  let max = 0;
  for (const [key, count] of bucket) {
    if (count > max) {
      max = count;
      winner = key;
    }
  }
  return winner;
}

function averageLatLng(points: LocationLog[]): { latitude: number; longitude: number } {
  if (!points.length) {
    return { latitude: 0, longitude: 0 };
  }
  let lat = 0;
  let lng = 0;
  for (const point of points) {
    lat += point.latitude;
    lng += point.longitude;
  }
  return {
    latitude: lat / points.length,
    longitude: lng / points.length,
  };
}

function detectHalts(
  points: LocationLog[],
  options?: RouteAnalyticsOptions
): HaltWindow[] {
  if (points.length < 2) return [];

  const haltRadiusMeters = options?.haltRadiusMeters ?? DEFAULT_HALT_RADIUS_METERS;
  const haltMinDurationMinutes =
    options?.haltMinDurationMinutes ?? DEFAULT_HALT_MIN_DURATION_MINUTES;
  const stationarySpeedMps = options?.stationarySpeedMps ?? DEFAULT_STATIONARY_SPEED_MPS;
  const minHaltMs = haltMinDurationMinutes * 60 * 1000;
  const stepDistanceThreshold = Math.max(20, haltRadiusMeters * 0.75);

  const halts: HaltWindow[] = [];
  let runStartIndex: number | null = null;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const durationMs = Math.max(0, toMs(curr.capturedAt) - toMs(prev.capturedAt));
    const distanceMeters = haversineDistanceMeters(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
    const apiSpeed =
      typeof curr.speed === "number" && Number.isFinite(curr.speed) ? Math.max(0, curr.speed) : null;
    const effectiveSpeed = apiSpeed ?? computeEffectiveSpeedMps(distanceMeters, durationMs);
    const stationary = distanceMeters <= stepDistanceThreshold && effectiveSpeed <= stationarySpeedMps;

    if (stationary) {
      if (runStartIndex === null) {
        runStartIndex = i - 1;
      }
      continue;
    }

    if (runStartIndex !== null) {
      const runEndIndex = i - 1;
      const startAt = toMs(points[runStartIndex].capturedAt);
      const endAt = toMs(points[runEndIndex].capturedAt);
      const durationMsTotal = Math.max(0, endAt - startAt);
      if (durationMsTotal >= minHaltMs) {
        const runPoints = points.slice(runStartIndex, runEndIndex + 1);
        const center = averageLatLng(runPoints);
        const label = mostCommonLabel(runPoints);
        const startBatteryLevel = normalizeBatteryLevel(points[runStartIndex].batteryLevel);
        const endBatteryLevel = normalizeBatteryLevel(points[runEndIndex].batteryLevel);
        const averageBatteryLevel = getAverageBatteryLevel(runPoints);
        halts.push({
          id: `halt_${points[runStartIndex].userId}_${startAt}`,
          userId: points[runStartIndex].userId,
          startAt: points[runStartIndex].capturedAt,
          endAt: points[runEndIndex].capturedAt,
          durationMinutes: Math.max(1, Math.round(durationMsTotal / 60000)),
          latitude: center.latitude,
          longitude: center.longitude,
          pointCount: runPoints.length,
          label,
          startBatteryLevel,
          endBatteryLevel,
          averageBatteryLevel,
          startPointIndex: runStartIndex,
          endPointIndex: runEndIndex,
        });
      }
      runStartIndex = null;
    }
  }

  if (runStartIndex !== null) {
    const runEndIndex = points.length - 1;
    const startAt = toMs(points[runStartIndex].capturedAt);
    const endAt = toMs(points[runEndIndex].capturedAt);
    const durationMsTotal = Math.max(0, endAt - startAt);
    if (durationMsTotal >= minHaltMs) {
      const runPoints = points.slice(runStartIndex, runEndIndex + 1);
      const center = averageLatLng(runPoints);
      const label = mostCommonLabel(runPoints);
      const startBatteryLevel = normalizeBatteryLevel(points[runStartIndex].batteryLevel);
      const endBatteryLevel = normalizeBatteryLevel(points[runEndIndex].batteryLevel);
      const averageBatteryLevel = getAverageBatteryLevel(runPoints);
      halts.push({
        id: `halt_${points[runStartIndex].userId}_${startAt}`,
        userId: points[runStartIndex].userId,
        startAt: points[runStartIndex].capturedAt,
        endAt: points[runEndIndex].capturedAt,
        durationMinutes: Math.max(1, Math.round(durationMsTotal / 60000)),
        latitude: center.latitude,
        longitude: center.longitude,
        pointCount: runPoints.length,
        label,
        startBatteryLevel,
        endBatteryLevel,
        averageBatteryLevel,
        startPointIndex: runStartIndex,
        endPointIndex: runEndIndex,
      });
    }
  }

  return halts;
}

function makeMovingSegment(points: LocationLog[], startIndex: number, endIndex: number): RouteSegment | null {
  if (startIndex >= endIndex) return null;

  let distanceMeters = 0;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    distanceMeters += haversineDistanceMeters(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
  }

  const startAt = points[startIndex].capturedAt;
  const endAt = points[endIndex].capturedAt;
  const durationMs = Math.max(0, toMs(endAt) - toMs(startAt));
  const avgSpeedKph =
    durationMs > 0
      ? round((distanceMeters / 1000) / (durationMs / (60 * 60 * 1000)), 2)
      : null;

  return {
    id: `mv_${points[startIndex].userId}_${toMs(startAt)}`,
    type: "moving",
    startAt,
    endAt,
    durationMinutes: Math.max(1, Math.round(durationMs / 60000)),
    distanceMeters: Math.round(distanceMeters),
    avgSpeedKph,
    fromLabel: points[startIndex].geofenceName ?? "Route Start",
    toLabel: points[endIndex].geofenceName ?? "Route End",
  };
}

function makeHaltSegment(halt: HaltWindow): RouteSegment {
  return {
    id: `seg_${halt.id}`,
    type: "halt",
    startAt: halt.startAt,
    endAt: halt.endAt,
    durationMinutes: halt.durationMinutes,
    distanceMeters: 0,
    avgSpeedKph: 0,
    fromLabel: halt.label,
    toLabel: halt.label,
    haltId: halt.id,
  };
}

function dropIndexMetadata(halts: HaltWindow[]): RouteHalt[] {
  return halts.map(({ startPointIndex: _start, endPointIndex: _end, ...rest }) => rest);
}

export function buildRouteTimeline(
  userId: string,
  date: string,
  rawPoints: LocationLog[],
  options?: RouteAnalyticsOptions
): RouteTimeline {
  const points = [...rawPoints].sort((a, b) => toMs(a.capturedAt) - toMs(b.capturedAt));
  if (!points.length) {
    return {
      userId,
      date,
      points: [],
      halts: [],
      segments: [],
      summary: {
        totalDistanceKm: 0,
        totalMovingMinutes: 0,
        totalHaltMinutes: 0,
        haltCount: 0,
        pointCount: 0,
      },
    };
  }

  const haltsWithIndex = detectHalts(points, options);
  const segments: RouteSegment[] = [];
  let cursor = 0;

  for (const halt of haltsWithIndex) {
    if (halt.startPointIndex > cursor) {
      const moving = makeMovingSegment(points, cursor, halt.startPointIndex);
      if (moving) segments.push(moving);
    }
    segments.push(makeHaltSegment(halt));
    cursor = halt.endPointIndex;
  }

  if (cursor < points.length - 1) {
    const moving = makeMovingSegment(points, cursor, points.length - 1);
    if (moving) segments.push(moving);
  }

  const totalDistanceMeters = segments
    .filter((segment) => segment.type === "moving")
    .reduce((sum, segment) => sum + segment.distanceMeters, 0);
  const totalMovingMinutes = segments
    .filter((segment) => segment.type === "moving")
    .reduce((sum, segment) => sum + segment.durationMinutes, 0);
  const totalHaltMinutes = segments
    .filter((segment) => segment.type === "halt")
    .reduce((sum, segment) => sum + segment.durationMinutes, 0);

  return {
    userId,
    date,
    points,
    halts: dropIndexMetadata(haltsWithIndex),
    segments,
    summary: {
      totalDistanceKm: round(totalDistanceMeters / 1000, 2),
      totalMovingMinutes,
      totalHaltMinutes,
      haltCount: haltsWithIndex.length,
      pointCount: points.length,
    },
  };
}
