type Coordinate = { latitude: number; longitude: number };
type TracePoint = Coordinate & { accuracy?: number | null };

export type RouteSource = "stadia-valhalla" | "self-hosted-valhalla" | "unavailable";

type RoutePlan = {
  source: RouteSource;
  distanceMetres: number | null;
  durationSeconds: number | null;
  coordinates: Coordinate[];
  maneuvers: Array<{
    type: number;
    instruction: string;
    verbalInstruction: string | null;
    streetNames: string[];
    distanceMeters: number;
    durationSeconds: number;
    beginShapeIndex: number;
    endShapeIndex: number;
  }>;
};

const STADIA_DEFAULT_BASE_URL = "https://api.stadiamaps.com";

function stadiaApiKey(): string {
  return process.env.STADIA_MAPS_API_KEY?.trim() || "";
}

function usesStadia(): boolean {
  return stadiaApiKey().length > 0;
}

function stadiaBaseUrl(): string {
  return (process.env.STADIA_MAPS_BASE_URL?.trim() || STADIA_DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function getGeospatialProvider(): "stadia" | "self-hosted" | "unconfigured" {
  if (usesStadia()) return "stadia";
  if (configuredUrl("NOMINATIM_URL", "GEOCODER_BASE_URL", "VALHALLA_URL", "ROUTER_BASE_URL")) return "self-hosted";
  return "unconfigured";
}

export function isGeocoderConfigured(): boolean {
  return usesStadia() || Boolean(configuredUrl("NOMINATIM_URL", "GEOCODER_BASE_URL"));
}

export function isRouterConfigured(): boolean {
  return usesStadia() || Boolean(configuredUrl("VALHALLA_URL", "ROUTER_BASE_URL"));
}

export function getConfiguredRouteSource(): Exclude<RouteSource, "unavailable"> {
  return usesStadia() ? "stadia-valhalla" : "self-hosted-valhalla";
}

function configuredUrl(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value.replace(/\/$/, "");
  }
  return "";
}

function timeoutMs(): number {
  const value = Number(process.env.GEOSPATIAL_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1_000 && value <= 60_000 ? value : 9_000;
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    accept: "application/json",
    "user-agent": process.env.OSM_USER_AGENT?.trim() || "LuminaFieldForce/1.0",
  };
  if (usesStadia()) result.authorization = `Stadia-Auth ${stadiaApiKey()}`;
  return result;
}

export async function searchPlaces(query: string, bias?: Coordinate) {
  const base = usesStadia() ? stadiaBaseUrl() : configuredUrl("NOMINATIM_URL", "GEOCODER_BASE_URL");
  if (!base) throw new Error("geocoder_not_configured");
  const url = new URL(usesStadia() ? `${base}/geocoding/v1/search` : `${base}/search`);
  if (usesStadia()) {
    url.searchParams.set("text", query.trim());
    url.searchParams.set("size", "7");
    url.searchParams.set("lang", "en");
    if (bias) {
      url.searchParams.set("focus.point.lat", String(bias.latitude));
      url.searchParams.set("focus.point.lon", String(bias.longitude));
    }
  } else {
    url.searchParams.set("q", query.trim());
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("dedupe", "1");
    url.searchParams.set("limit", "7");
    if (bias) {
      const span = 0.45;
      url.searchParams.set("viewbox", `${bias.longitude - span},${bias.latitude + span},${bias.longitude + span},${bias.latitude - span}`);
      url.searchParams.set("bounded", "0");
    }
  }
  const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs()) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500
    ? "geocoder_unavailable"
    : `geocoder_search_${response.status}`);
  if (usesStadia()) {
    const payload = await response.json() as StadiaFeatureCollection;
    return (payload.features ?? []).flatMap((feature) => {
      const place = toStadiaPlace(feature);
      return place ? [place] : [];
    });
  }
  const payload = await response.json() as unknown[];
  return payload.flatMap((value) => toNominatimPlace(value));
}

export async function reverseGeocode(latitude: number, longitude: number) {
  const base = usesStadia() ? stadiaBaseUrl() : configuredUrl("NOMINATIM_URL", "GEOCODER_BASE_URL");
  if (!base) throw new Error("geocoder_not_configured");
  const url = new URL(usesStadia() ? `${base}/geocoding/v1/reverse` : `${base}/reverse`);
  if (usesStadia()) {
    url.searchParams.set("point.lat", String(latitude));
    url.searchParams.set("point.lon", String(longitude));
    url.searchParams.set("size", "1");
    url.searchParams.set("lang", "en");
  } else {
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
  }
  const response = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs()) });
  if (!response.ok) throw new Error("geocoder_unavailable");
  if (usesStadia()) {
    const feature = ((await response.json()) as StadiaFeatureCollection).features?.[0];
    return feature ? toStadiaPlace(feature) : null;
  }
  return toNominatimPlace(await response.json())[0] ?? null;
}

export async function computeRoute(
  origin: Coordinate,
  destination: Coordinate,
  travelMode: "auto" | "pedestrian" | "bicycle",
): Promise<RoutePlan> {
  const base = usesStadia() ? stadiaBaseUrl() : configuredUrl("VALHALLA_URL", "ROUTER_BASE_URL");
  if (!base) return unavailableRoute();
  const response = await fetch(usesStadia() ? `${base}/route/v1` : `${base}/route`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      locations: [
        { lat: origin.latitude, lon: origin.longitude, type: "break" },
        { lat: destination.latitude, lon: destination.longitude, type: "break" },
      ],
      costing: travelMode === "pedestrian" ? "pedestrian" : travelMode === "bicycle" ? "bicycle" : "auto",
      units: "kilometers",
      directions_options: { units: "kilometers", language: "en-US" },
    }),
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500
    ? "router_unavailable"
    : `route_provider_${response.status}`);
  const payload = await response.json() as ValhallaResponse;
  const summary = payload.trip?.summary;
  const legs = payload.trip?.legs ?? [];
  if (!summary || !legs.length || legs.some((leg) => !leg.shape)) return unavailableRoute();

  const coordinates: Coordinate[] = [];
  const maneuvers: RoutePlan["maneuvers"] = [];
  let shapeOffset = 0;
  for (const leg of legs) {
    const shape = decodePolyline(leg.shape!, 6);
    coordinates.push(...(coordinates.length ? shape.slice(1) : shape));
    for (const maneuver of leg.maneuvers ?? []) {
      maneuvers.push({
        type: finite(maneuver.type) ?? 0,
        instruction: maneuver.instruction?.trim() || "Continue on the route",
        verbalInstruction: maneuver.verbal_pre_transition_instruction?.trim() || maneuver.verbal_transition_alert_instruction?.trim() || null,
        streetNames: Array.isArray(maneuver.street_names) ? maneuver.street_names.filter((name): name is string => typeof name === "string") : [],
        distanceMeters: Math.round(Math.max(0, finite(maneuver.length) ?? 0) * 1_000),
        durationSeconds: Math.round(Math.max(0, finite(maneuver.time) ?? 0)),
        beginShapeIndex: shapeOffset + Math.max(0, Math.trunc(finite(maneuver.begin_shape_index) ?? 0)),
        endShapeIndex: shapeOffset + Math.max(0, Math.trunc(finite(maneuver.end_shape_index) ?? 0)),
      });
    }
    shapeOffset += Math.max(0, shape.length - 1);
  }
  const distance = finite(summary.length);
  const duration = finite(summary.time);
  return {
    source: getConfiguredRouteSource(),
    distanceMetres: distance == null ? null : Math.round(distance * 1_000),
    durationSeconds: duration == null ? null : Math.round(duration),
    coordinates,
    maneuvers,
  };
}

export async function matchTrace(points: TracePoint[]): Promise<Coordinate[]> {
  const base = usesStadia() ? stadiaBaseUrl() : configuredUrl("VALHALLA_URL", "ROUTER_BASE_URL");
  if (!base || points.length < 2) return points;
  try {
    const accuracyValues = points
      .map((point) => point.accuracy)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    const accuracy = Math.max(5, Math.min(80, Math.round(accuracyValues[Math.floor(accuracyValues.length / 2)] ?? 25)));
    const response = await fetch(usesStadia() ? `${base}/map_match/v1` : `${base}/trace_route`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        shape: points.map((point) => ({ lat: point.latitude, lon: point.longitude })),
        costing: "auto",
        shape_match: "map_snap",
        gps_accuracy: accuracy,
        search_radius: Math.max(20, Math.min(100, accuracy * 2)),
        units: "kilometers",
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!response.ok) return points;
    const payload = await response.json() as ValhallaResponse;
    const encoded = payload.trip?.legs?.[0]?.shape;
    return encoded ? decodePolyline(encoded, 6) : points;
  } catch {
    return points;
  }
}

function toNominatimPlace(value: unknown): Array<{
  placeId: string; name: string; address: string; latitude: number; longitude: number; primaryType: string | null;
}> {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  const id = finite(item.osm_id);
  const kind = item.osm_type === "node" ? "N" : item.osm_type === "way" ? "W" : item.osm_type === "relation" ? "R" : null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || id == null || !kind) return [];
  const address = typeof item.display_name === "string" ? item.display_name : "";
  return [{
    placeId: `nominatim:${kind}${id}`,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : address || "Selected place",
    address,
    latitude,
    longitude,
    primaryType: typeof item.type === "string" ? item.type : typeof item.category === "string" ? item.category : null,
  }];
}

type StadiaFeatureCollection = { features?: StadiaFeature[] };
type StadiaFeature = {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: {
    gid?: string;
    name?: string;
    label?: string;
    layer?: string;
    locality?: string;
    region?: string;
    country?: string;
    formatted_address_lines?: string[];
  };
};

function toStadiaPlace(value: StadiaFeature): {
  placeId: string; name: string; address: string; latitude: number; longitude: number; primaryType: string | null;
} | null {
  const coordinates = value.geometry?.coordinates;
  const properties = value.properties;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !properties?.gid) return null;
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const name = properties.name?.trim() || properties.label?.trim() || "Selected place";
  const address = properties.label?.trim()
    || properties.formatted_address_lines?.filter(Boolean).join(", ")
    || [name, properties.locality, properties.region, properties.country].filter(Boolean).join(", ");
  return {
    placeId: `stadia:${properties.gid}`,
    name,
    address,
    latitude,
    longitude,
    primaryType: properties.layer ?? null,
  };
}

function unavailableRoute(): RoutePlan {
  return { source: "unavailable", distanceMetres: null, durationSeconds: null, coordinates: [], maneuvers: [] };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodePolyline(encoded: string, precision: number): Coordinate[] {
  const values: Coordinate[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const factor = 10 ** precision;
  while (index < encoded.length) {
    const lat = decodeValue(encoded, index); index = lat.next; latitude += lat.delta;
    const lon = decodeValue(encoded, index); index = lon.next; longitude += lon.delta;
    values.push({ latitude: latitude / factor, longitude: longitude / factor });
  }
  return values;
}

function decodeValue(encoded: string, start: number): { delta: number; next: number } {
  let result = 0;
  let shift = 0;
  let index = start;
  let byte = 0;
  do {
    byte = encoded.charCodeAt(index++) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index < encoded.length);
  return { delta: result & 1 ? ~(result >> 1) : result >> 1, next: index };
}

type ValhallaResponse = {
  trip?: {
    summary?: { length?: number; time?: number };
    legs?: Array<{
      shape?: string;
      maneuvers?: Array<{
        type?: number; instruction?: string; verbal_pre_transition_instruction?: string;
        verbal_transition_alert_instruction?: string; street_names?: unknown[];
        length?: number; time?: number; begin_shape_index?: number; end_shape_index?: number;
      }>;
    }>;
  };
};
