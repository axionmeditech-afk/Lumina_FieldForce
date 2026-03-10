import type { LocationLog, RoutePathPoint, RouteDirections, RouteDistanceMatrix } from "@/lib/types";

const MAPPLS_ROUTE_BASE_URL = "https://route.mappls.com/route";
const DEFAULT_DIRECTION_RESOURCE = "route_adv";
const DEFAULT_DISTANCE_RESOURCE = "distance_matrix";
const DEFAULT_PROFILE = "driving";
const DEFAULT_OVERVIEW = "full";
const DEFAULT_GEOMETRIES = "polyline6";
const MAX_ROUTE_POSITIONS = 25;
const MAX_DISTANCE_POSITIONS = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 200;

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const directionCache = new Map<string, CacheEntry<RouteDirections>>();
const matrixCache = new Map<string, CacheEntry<RouteDistanceMatrix>>();

function getMapplsRoutingApiKey(): string {
  return (
    process.env.MAPPLS_ROUTING_API_KEY?.trim() ||
    process.env.MAPPLS_REST_API_KEY?.trim() ||
    process.env.MAPPLS_ACCESS_TOKEN?.trim() ||
    process.env.EXPO_PUBLIC_MAPPLS_ROUTING_API_KEY?.trim() ||
    ""
  );
}

function toCoordToken(point: { latitude: number; longitude: number }): string {
  // Mappls direction & matrix REST APIs expect coordinates in longitude,latitude format.
  return `${point.longitude},${point.latitude}`;
}

function sanitizeProfile(value: string | null | undefined): string {
  const profile = (value || DEFAULT_PROFILE).trim().toLowerCase();
  if (profile === "driving" || profile === "biking" || profile === "walking" || profile === "trucking") {
    return profile;
  }
  return DEFAULT_PROFILE;
}

function sanitizeDirectionResource(value: string | null | undefined): string {
  const resource = (value || DEFAULT_DIRECTION_RESOURCE).trim().toLowerCase();
  if (resource === "route_adv" || resource === "route_eta" || resource === "route_traffic") {
    return resource;
  }
  return DEFAULT_DIRECTION_RESOURCE;
}

function sanitizeDistanceResource(value: string | null | undefined): string {
  const resource = (value || DEFAULT_DISTANCE_RESOURCE).trim().toLowerCase();
  if (
    resource === "distance_matrix" ||
    resource === "distance_matrix_eta" ||
    resource === "distance_matrix_traffic"
  ) {
    return resource;
  }
  return DEFAULT_DISTANCE_RESOURCE;
}

function sanitizeOverview(value: string | null | undefined): string {
  const overview = (value || DEFAULT_OVERVIEW).trim().toLowerCase();
  if (overview === "full" || overview === "simplified" || overview === "false") return overview;
  return DEFAULT_OVERVIEW;
}

function sanitizeGeometries(value: string | null | undefined): string {
  const geometries = (value || DEFAULT_GEOMETRIES).trim().toLowerCase();
  if (geometries === "polyline" || geometries === "polyline6" || geometries === "geojson") {
    return geometries;
  }
  return DEFAULT_GEOMETRIES;
}

function compactSequential(points: LocationLog[]): LocationLog[] {
  if (points.length <= 1) return [...points];
  const out: LocationLog[] = [];
  let lastKey = "";
  for (const point of points) {
    const key = `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
    if (key === lastKey) continue;
    out.push(point);
    lastKey = key;
  }
  return out;
}

function pickEvenlySpaced(points: LocationLog[], maxCount: number): LocationLog[] {
  if (points.length <= maxCount) return [...points];
  if (maxCount < 2) return [points[0]];

  const first = points[0];
  const last = points[points.length - 1];
  const interior = points.slice(1, -1);
  const interiorSlots = Math.max(0, maxCount - 2);

  if (!interior.length || interiorSlots === 0) {
    return [first, last];
  }

  const sampled: LocationLog[] = [first];
  for (let i = 0; i < interiorSlots; i += 1) {
    const idx = Math.floor((i * interior.length) / interiorSlots);
    sampled.push(interior[Math.min(interior.length - 1, idx)]);
  }
  sampled.push(last);
  return compactSequential(sampled);
}

function decodePolyline(encoded: string, precision = 6): RoutePathPoint[] {
  const coordinates: RoutePathPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 10 ** precision;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push({
      latitude: lat / factor,
      longitude: lng / factor,
    });
  }

  return coordinates;
}

function buildCacheKey(prefix: string, fields: Array<string | number | boolean | null | undefined>): string {
  const base = fields.map((field) => (field === undefined ? "" : String(field))).join("|");
  return `${prefix}:${base}`;
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function toRoutePathFromLogs(points: LocationLog[]): RoutePathPoint[] {
  return points.map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
  }));
}

function parseDirectionsPayload(payload: unknown, geometryType: string): {
  path: RoutePathPoint[];
  distanceMeters: number | null;
  durationSeconds: number | null;
  routeId: string | null;
} {
  const body = (payload ?? {}) as Record<string, unknown>;
  const routes = Array.isArray(body.routes) ? body.routes : [];
  const first = routes[0] as Record<string, unknown> | undefined;
  if (!first) {
    return { path: [], distanceMeters: null, durationSeconds: null, routeId: null };
  }

  const distanceMeters =
    typeof first.distance === "number" && Number.isFinite(first.distance) ? first.distance : null;
  const durationSeconds =
    typeof first.duration === "number" && Number.isFinite(first.duration) ? first.duration : null;
  const routeId = typeof first.routeId === "string" ? first.routeId : null;

  if (geometryType === "geojson" && Array.isArray(first.geometry)) {
    const path: RoutePathPoint[] = (first.geometry as unknown[])
      .map((item) => {
        if (!Array.isArray(item) || item.length < 2) return null;
        const longitude = Number(item[0]);
        const latitude = Number(item[1]);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        return { latitude, longitude };
      })
      .filter((item): item is RoutePathPoint => Boolean(item));
    return { path, distanceMeters, durationSeconds, routeId };
  }

  if (typeof first.geometry === "string") {
    const precision = geometryType === "polyline" ? 5 : 6;
    try {
      const path = decodePolyline(first.geometry, precision);
      return { path, distanceMeters, durationSeconds, routeId };
    } catch {
      return { path: [], distanceMeters, durationSeconds, routeId };
    }
  }

  return { path: [], distanceMeters, durationSeconds, routeId };
}

function buildDirectionError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return `Mappls routing request failed with HTTP ${status}`;
  return `Mappls routing request failed with HTTP ${status}: ${trimmed.slice(0, 220)}`;
}

function buildMatrixError(status: number, bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return `Mappls distance matrix request failed with HTTP ${status}`;
  return `Mappls distance matrix request failed with HTTP ${status}: ${trimmed.slice(0, 220)}`;
}

export async function getMapplsDirectionsForLogs(
  rawPoints: LocationLog[],
  options?: {
    resource?: string | null;
    profile?: string | null;
    overview?: string | null;
    geometries?: string | null;
    alternatives?: boolean;
    steps?: boolean;
    region?: string | null;
    routeType?: number | null;
  }
): Promise<RouteDirections | null> {
  const apiKey = getMapplsRoutingApiKey();
  if (!apiKey) return null;

  const compacted = compactSequential(rawPoints);
  if (compacted.length < 2) return null;

  const sampled = pickEvenlySpaced(compacted, MAX_ROUTE_POSITIONS);
  const resource = sanitizeDirectionResource(options?.resource ?? process.env.MAPPLS_ROUTING_RESOURCE);
  const profile = sanitizeProfile(options?.profile ?? process.env.MAPPLS_ROUTING_PROFILE);
  const overview = sanitizeOverview(options?.overview ?? process.env.MAPPLS_ROUTING_OVERVIEW);
  const geometries = sanitizeGeometries(options?.geometries ?? process.env.MAPPLS_ROUTING_GEOMETRIES);
  const steps = options?.steps ?? true;
  const alternatives = options?.alternatives ?? false;
  const region = (options?.region ?? process.env.MAPPLS_ROUTING_REGION ?? "").trim().toLowerCase();
  const routeTypeEnv = process.env.MAPPLS_ROUTING_RTYPE;
  const routeTypeRaw =
    options?.routeType ?? (routeTypeEnv && /^-?\d+$/.test(routeTypeEnv) ? Number(routeTypeEnv) : null);
  const routeType = typeof routeTypeRaw === "number" && Number.isFinite(routeTypeRaw) ? routeTypeRaw : null;

  const cacheKey = buildCacheKey("dir", [
    resource,
    profile,
    overview,
    geometries,
    steps,
    alternatives,
    region,
    routeType,
    sampled.length,
    sampled[0].capturedAt,
    sampled[sampled.length - 1].capturedAt,
    sampled.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(";"),
  ]);
  const cached = getCached(directionCache, cacheKey);
  if (cached) return cached;

  const positionToken = sampled.map(toCoordToken).join(";");
  const endpoint = `${MAPPLS_ROUTE_BASE_URL}/direction/${resource}/${profile}/${positionToken}`;
  const url = new URL(endpoint);
  url.searchParams.set("access_token", apiKey);
  url.searchParams.set("steps", steps ? "true" : "false");
  url.searchParams.set("alternatives", alternatives ? "true" : "false");
  url.searchParams.set("overview", overview);
  url.searchParams.set("geometries", geometries);
  if (region) url.searchParams.set("region", region);
  if (routeType !== null) url.searchParams.set("rtype", String(routeType));

  const baseFallbackPath = toRoutePathFromLogs(sampled);
  try {
    const response = await fetch(url.toString());
    const text = await response.text();
    if (!response.ok) {
      const failed: RouteDirections = {
        provider: "mappls",
        enabled: true,
        path: baseFallbackPath,
        profile,
        resource,
        geometries,
        distanceMeters: null,
        durationSeconds: null,
        routeId: null,
        sampledPointCount: sampled.length,
        rawPointCount: rawPoints.length,
        error: buildDirectionError(response.status, text),
      };
      setCached(directionCache, cacheKey, failed);
      return failed;
    }

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }

    const parsed = parseDirectionsPayload(payload, geometries);
    const next: RouteDirections = {
      provider: "mappls",
      enabled: true,
      path: parsed.path.length >= 2 ? parsed.path : baseFallbackPath,
      profile,
      resource,
      geometries,
      distanceMeters: parsed.distanceMeters,
      durationSeconds: parsed.durationSeconds,
      routeId: parsed.routeId,
      sampledPointCount: sampled.length,
      rawPointCount: rawPoints.length,
      error: null,
    };
    setCached(directionCache, cacheKey, next);
    return next;
  } catch (error) {
    const failed: RouteDirections = {
      provider: "mappls",
      enabled: true,
      path: baseFallbackPath,
      profile,
      resource,
      geometries,
      distanceMeters: null,
      durationSeconds: null,
      routeId: null,
      sampledPointCount: sampled.length,
      rawPointCount: rawPoints.length,
      error: error instanceof Error ? error.message : "Mappls routing request failed",
    };
    setCached(directionCache, cacheKey, failed);
    return failed;
  }
}

function parseMatrixPayload(payload: unknown): {
  durations: number[][];
  distances: number[][];
} {
  const body = (payload ?? {}) as Record<string, unknown>;
  const root = (body.results ?? body) as Record<string, unknown>;
  const durationsRaw = Array.isArray(root.durations) ? root.durations : [];
  const distancesRaw = Array.isArray(root.distances) ? root.distances : [];

  const durations = durationsRaw.map((row) =>
    Array.isArray(row)
      ? row.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
      : []
  );
  const distances = distancesRaw.map((row) =>
    Array.isArray(row)
      ? row.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
      : []
  );
  return { durations, distances };
}

export async function getMapplsDistanceMatrixForLogs(
  rawPoints: LocationLog[],
  options?: {
    resource?: string | null;
    profile?: string | null;
    region?: string | null;
    routeType?: number | null;
  }
): Promise<RouteDistanceMatrix | null> {
  const apiKey = getMapplsRoutingApiKey();
  if (!apiKey) return null;

  const compacted = compactSequential(rawPoints);
  if (compacted.length < 2) return null;

  const sampled = pickEvenlySpaced(compacted, MAX_DISTANCE_POSITIONS);
  const resource = sanitizeDistanceResource(options?.resource ?? process.env.MAPPLS_DISTANCE_RESOURCE);
  const profile = sanitizeProfile(options?.profile ?? process.env.MAPPLS_DISTANCE_PROFILE);
  const region = (options?.region ?? process.env.MAPPLS_DISTANCE_REGION ?? "").trim().toLowerCase();
  const routeTypeEnv = process.env.MAPPLS_DISTANCE_RTYPE;
  const routeTypeRaw =
    options?.routeType ?? (routeTypeEnv && /^-?\d+$/.test(routeTypeEnv) ? Number(routeTypeEnv) : null);
  const routeType = typeof routeTypeRaw === "number" && Number.isFinite(routeTypeRaw) ? routeTypeRaw : null;

  const cacheKey = buildCacheKey("dm", [
    resource,
    profile,
    region,
    routeType,
    sampled.length,
    sampled[0].capturedAt,
    sampled[sampled.length - 1].capturedAt,
    sampled.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(";"),
  ]);
  const cached = getCached(matrixCache, cacheKey);
  if (cached) return cached;

  const coordinateTokens = sampled.map(toCoordToken);
  const endpoint = `${MAPPLS_ROUTE_BASE_URL}/dm/${resource}/${profile}/${coordinateTokens.join(";")}`;
  const url = new URL(endpoint);
  url.searchParams.set("access_token", apiKey);
  if (region) url.searchParams.set("region", region);
  if (routeType !== null) url.searchParams.set("rtype", String(routeType));

  try {
    const response = await fetch(url.toString());
    const text = await response.text();
    if (!response.ok) {
      const failed: RouteDistanceMatrix = {
        provider: "mappls",
        enabled: true,
        profile,
        resource,
        rawPointCount: rawPoints.length,
        sampledPointCount: sampled.length,
        coordinates: coordinateTokens,
        durations: [],
        distances: [],
        error: buildMatrixError(response.status, text),
      };
      setCached(matrixCache, cacheKey, failed);
      return failed;
    }

    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }

    const parsed = parseMatrixPayload(payload);
    const next: RouteDistanceMatrix = {
      provider: "mappls",
      enabled: true,
      profile,
      resource,
      rawPointCount: rawPoints.length,
      sampledPointCount: sampled.length,
      coordinates: coordinateTokens,
      durations: parsed.durations,
      distances: parsed.distances,
      error: null,
    };
    setCached(matrixCache, cacheKey, next);
    return next;
  } catch (error) {
    const failed: RouteDistanceMatrix = {
      provider: "mappls",
      enabled: true,
      profile,
      resource,
      rawPointCount: rawPoints.length,
      sampledPointCount: sampled.length,
      coordinates: coordinateTokens,
      durations: [],
      distances: [],
      error: error instanceof Error ? error.message : "Mappls distance matrix request failed",
    };
    setCached(matrixCache, cacheKey, failed);
    return failed;
  }
}

export interface MapplsCoordinatePoint {
  latitude: number;
  longitude: number;
}

function toSyntheticLocationLogs(points: MapplsCoordinatePoint[], prefix: string): LocationLog[] {
  const baseTs = Date.now();
  return points.map((point, index) => ({
    id: `${prefix}_${index}`,
    userId: prefix,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: null,
    speed: null,
    heading: null,
    batteryLevel: null,
    geofenceId: null,
    geofenceName: null,
    isInsideGeofence: false,
    capturedAt: new Date(baseTs + index * 1000).toISOString(),
  }));
}

export async function getMapplsDirectionsForCoordinates(
  points: MapplsCoordinatePoint[],
  options?: {
    resource?: string | null;
    profile?: string | null;
    overview?: string | null;
    geometries?: string | null;
    alternatives?: boolean;
    steps?: boolean;
    region?: string | null;
    routeType?: number | null;
  }
): Promise<RouteDirections | null> {
  if (!Array.isArray(points) || points.length < 2) return null;
  const logs = toSyntheticLocationLogs(points, "mappls_preview");
  return getMapplsDirectionsForLogs(logs, options);
}

export async function getMapplsDistanceMatrixForCoordinates(
  points: MapplsCoordinatePoint[],
  options?: {
    resource?: string | null;
    profile?: string | null;
    region?: string | null;
    routeType?: number | null;
  }
): Promise<RouteDistanceMatrix | null> {
  if (!Array.isArray(points) || points.length < 2) return null;
  const logs = toSyntheticLocationLogs(points, "mappls_matrix");
  return getMapplsDistanceMatrixForLogs(logs, options);
}
