const MAPPLS_ATLAS_BASE_URL = "https://atlas.mappls.com";
const MAPPLS_PLACE_DETAILS_BASE_URL = "https://place.mappls.com";
const REQUEST_TIMEOUT_MS = Math.max(
  1200,
  Number(process.env.MAPPLS_PLACES_TIMEOUT_MS || 2500)
);
const DETAIL_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PLACE_RESULTS = 20;
const ENABLE_PLACE_DETAIL_ENRICHMENT =
  (process.env.MAPPLS_PLACES_DETAIL_ENRICHMENT || "false").trim().toLowerCase() === "true";

export interface MapplsPlaceSuggestion {
  id: string;
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  eloc: string | null;
}

export interface MapplsPlaceSearchResponse {
  provider: "mappls";
  mode: "autosuggest" | "text";
  query: string;
  suggestions: MapplsPlaceSuggestion[];
  source: string | null;
  error: string | null;
}

export interface MapplsReverseGeocodeResponse {
  provider: "mappls";
  latitude: number;
  longitude: number;
  label: string | null;
  address: string | null;
  locality: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  source: string | null;
  error: string | null;
}

type PlaceDetailCacheEntry = {
  expiresAt: number;
  value: {
    label: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  };
};

const placeDetailCache = new Map<string, PlaceDetailCacheEntry>();

function getMapplsPlacesApiKey(): string {
  return (
    process.env.MAPPLS_PLACES_API_KEY?.trim() ||
    process.env.MAPPLS_REST_API_KEY?.trim() ||
    process.env.MAPPLS_ACCESS_TOKEN?.trim() ||
    process.env.MAPPLS_ROUTING_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_MAPPLS_ROUTING_API_KEY?.trim() ||
    ""
  );
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const next = trimText(value);
    if (next) return next;
  }
  return "";
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeCoordinates(
  latitudeRaw: unknown,
  longitudeRaw: unknown
): { latitude: number; longitude: number } | null {
  const latitude = toFiniteNumber(latitudeRaw);
  const longitude = toFiniteNumber(longitudeRaw);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
    return { latitude, longitude };
  }
  if (Math.abs(longitude) <= 90 && Math.abs(latitude) <= 180) {
    return { latitude: longitude, longitude: latitude };
  }
  return null;
}

function parseCoordinatesFromRecord(value: Record<string, unknown>): {
  latitude: number | null;
  longitude: number | null;
} {
  const direct = normalizeCoordinates(
    value.latitude ?? value.lat ?? value.y,
    value.longitude ?? value.lng ?? value.lon ?? value.x
  );
  if (direct) return direct;

  const locationArrayCandidates = [value.location, value.coordinates, value.center, value.coordinate];
  for (const candidate of locationArrayCandidates) {
    if (!Array.isArray(candidate) || candidate.length < 2) continue;
    const lng = candidate[0];
    const lat = candidate[1];
    const next = normalizeCoordinates(lat, lng);
    if (next) return next;
  }

  return { latitude: null, longitude: null };
}

function clampLimit(value: number | null | undefined, fallback = 8): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_PLACE_RESULTS, Math.floor(value)));
}

function buildSearchError(prefix: string, status: number, text: string): string {
  const body = text.trim();
  if (!body) return `${prefix} failed with HTTP ${status}.`;
  return `${prefix} failed with HTTP ${status}: ${body.slice(0, 220)}`;
}

async function fetchJsonFromCandidates(
  urls: URL[],
  errorPrefix: string
): Promise<{ payload: unknown; source: string } | { payload: null; source: null; error: string }> {
  const failures: string[] = [];
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), { signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        failures.push(buildSearchError(errorPrefix, response.status, text));
        continue;
      }
      if (!text.trim()) {
        return { payload: {}, source: url.toString() };
      }
      try {
        return {
          payload: JSON.parse(text),
          source: url.toString(),
        };
      } catch {
        failures.push(`${errorPrefix} returned invalid JSON from ${url.toString()}.`);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${errorPrefix} failed.`);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    payload: null,
    source: null,
    error: failures.length ? failures.join(" | ") : `${errorPrefix} failed.`,
  };
}

function getArrayFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  }

  const root = (payload ?? {}) as Record<string, unknown>;
  const candidates = [
    root.suggestions,
    root.suggestedLocations,
    root.results,
    root.data,
    root.places,
    root.copResults,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object")
    );
  }
  return [];
}

function makeSuggestionKey(suggestion: MapplsPlaceSuggestion): string {
  const eloc = suggestion.eloc?.toLowerCase() || "";
  if (eloc) return `eloc:${eloc}`;
  if (suggestion.latitude !== null && suggestion.longitude !== null) {
    return `coord:${suggestion.latitude.toFixed(5)},${suggestion.longitude.toFixed(5)}`;
  }
  return `name:${suggestion.label.toLowerCase()}|${(suggestion.address || "").toLowerCase()}`;
}

function mapEntryToSuggestion(entry: Record<string, unknown>, index: number): MapplsPlaceSuggestion | null {
  const addressTokens =
    entry.addressTokens && typeof entry.addressTokens === "object"
      ? (entry.addressTokens as Record<string, unknown>)
      : null;

  const label = firstText(
    entry.placeName,
    entry.place_name,
    entry.poi,
    entry.name,
    addressTokens?.poi,
    addressTokens?.locality,
    entry.eLoc,
    entry.mapplsPin
  );
  if (!label) return null;

  const address = firstText(
    entry.placeAddress,
    entry.place_address,
    entry.address,
    entry.formattedAddress,
    entry.placeDisplayName,
    addressTokens?.city
  );

  const eloc = firstText(entry.eLoc, entry.eloc, entry.mapplsPin, entry.mappls_pin) || null;
  const coords = parseCoordinatesFromRecord(entry);

  return {
    id: `mappls_${eloc || index}`,
    label,
    address: address || null,
    latitude: coords.latitude,
    longitude: coords.longitude,
    eloc,
  };
}

function setPlaceDetailCache(
  eloc: string,
  value: { label: string | null; address: string | null; latitude: number | null; longitude: number | null }
): void {
  placeDetailCache.set(eloc, {
    value,
    expiresAt: Date.now() + DETAIL_CACHE_TTL_MS,
  });
}

function getPlaceDetailCache(
  eloc: string
): { label: string | null; address: string | null; latitude: number | null; longitude: number | null } | null {
  const hit = placeDetailCache.get(eloc);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    placeDetailCache.delete(eloc);
    return null;
  }
  return hit.value;
}

async function resolveMapplsPlaceDetails(
  eloc: string,
  apiKey: string
): Promise<{ label: string | null; address: string | null; latitude: number | null; longitude: number | null } | null> {
  const cached = getPlaceDetailCache(eloc);
  if (cached) return cached;

  const urls = [
    new URL(`${MAPPLS_ATLAS_BASE_URL}/api/places/place_detail`),
    new URL(`${MAPPLS_ATLAS_BASE_URL}/api/places/place-details`),
    new URL(`${MAPPLS_PLACE_DETAILS_BASE_URL}/O2O/entity/place-details/${encodeURIComponent(eloc)}`),
  ];
  for (const url of urls) {
    if (url.pathname.includes("/place-details/")) {
      url.searchParams.set("access_token", apiKey);
      url.searchParams.set("token", apiKey);
    } else {
      url.searchParams.set("place_id", eloc);
      url.searchParams.set("access_token", apiKey);
      url.searchParams.set("token", apiKey);
    }
  }

  const response = await fetchJsonFromCandidates(urls, "Mappls place detail request");
  if (!("payload" in response) || response.payload === null) return null;

  const root = (response.payload ?? {}) as Record<string, unknown>;
  const candidate =
    (root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : null) ||
    (root.place && typeof root.place === "object" ? (root.place as Record<string, unknown>) : null) ||
    root;
  const label = firstText(candidate.placeName, candidate.place_name, candidate.name) || null;
  const address = firstText(
    candidate.placeAddress,
    candidate.place_address,
    candidate.address,
    candidate.formattedAddress
  ) || null;
  const coords = parseCoordinatesFromRecord(candidate);
  const mapped = {
    label,
    address,
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
  setPlaceDetailCache(eloc, mapped);
  return mapped;
}

function buildAutosuggestUrls(
  query: string,
  apiKey: string,
  options?: { latitude?: number | null; longitude?: number | null; region?: string | null; limit?: number | null }
): URL[] {
  const region = trimText(options?.region).toLowerCase() || "ind";
  const limit = clampLimit(options?.limit, 8);
  const urls: URL[] = [];

  const addUrl = (pathname: string, withLngLatBias: boolean, withLatLngBias: boolean) => {
    const url = new URL(`${MAPPLS_ATLAS_BASE_URL}${pathname}`);
    url.searchParams.set("query", query);
    url.searchParams.set("access_token", apiKey);
    url.searchParams.set("token", apiKey);
    url.searchParams.set("region", region);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("itemCount", String(limit));
    if (
      typeof options?.latitude === "number" &&
      Number.isFinite(options.latitude) &&
      typeof options?.longitude === "number" &&
      Number.isFinite(options.longitude)
    ) {
      if (withLngLatBias) {
        url.searchParams.set("location", `${options.longitude},${options.latitude}`);
      }
      if (withLatLngBias) {
        url.searchParams.set("location", `${options.latitude},${options.longitude}`);
      }
    }
    urls.push(url);
  };

  addUrl("/api/places/autosuggest", true, false);
  addUrl("/api/places/autosuggest", false, true);

  return urls;
}

function buildTextSearchUrls(
  query: string,
  apiKey: string,
  options?: { latitude?: number | null; longitude?: number | null; region?: string | null; limit?: number | null }
): URL[] {
  const region = trimText(options?.region).toLowerCase() || "ind";
  const limit = clampLimit(options?.limit, 8);
  const urls: URL[] = [];
  const addUrl = (pathname: string) => {
    const url = new URL(`${MAPPLS_ATLAS_BASE_URL}${pathname}`);
    url.searchParams.set("query", query);
    url.searchParams.set("access_token", apiKey);
    url.searchParams.set("token", apiKey);
    url.searchParams.set("region", region);
    url.searchParams.set("limit", String(limit));
    if (
      typeof options?.latitude === "number" &&
      Number.isFinite(options.latitude) &&
      typeof options?.longitude === "number" &&
      Number.isFinite(options.longitude)
    ) {
      url.searchParams.set("location", `${options.longitude},${options.latitude}`);
    }
    urls.push(url);
  };
  addUrl("/api/places/textsearch");
  return urls;
}

async function enrichSuggestionsWithPlaceDetails(
  suggestions: MapplsPlaceSuggestion[],
  apiKey: string
): Promise<MapplsPlaceSuggestion[]> {
  if (!ENABLE_PLACE_DETAIL_ENRICHMENT) {
    return suggestions;
  }
  const output: MapplsPlaceSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (
      suggestion.latitude !== null &&
      suggestion.longitude !== null
    ) {
      output.push(suggestion);
      continue;
    }
    if (!suggestion.eloc) {
      output.push(suggestion);
      continue;
    }
    try {
      const detail = await resolveMapplsPlaceDetails(suggestion.eloc, apiKey);
      if (!detail) {
        output.push(suggestion);
        continue;
      }
      output.push({
        ...suggestion,
        label: detail.label || suggestion.label,
        address: detail.address || suggestion.address,
        latitude: detail.latitude ?? suggestion.latitude,
        longitude: detail.longitude ?? suggestion.longitude,
      });
    } catch {
      output.push(suggestion);
    }
  }
  return output;
}

export async function searchMapplsPlaces(
  mode: "autosuggest" | "text",
  queryRaw: string,
  options?: { latitude?: number | null; longitude?: number | null; region?: string | null; limit?: number | null }
): Promise<MapplsPlaceSearchResponse | null> {
  const apiKey = getMapplsPlacesApiKey();
  if (!apiKey) return null;
  const query = trimText(queryRaw);
  if (!query) {
    return {
      provider: "mappls",
      mode,
      query,
      suggestions: [],
      source: null,
      error: "query is required",
    };
  }

  const urls =
    mode === "autosuggest"
      ? buildAutosuggestUrls(query, apiKey, options)
      : buildTextSearchUrls(query, apiKey, options);
  const response = await fetchJsonFromCandidates(urls, "Mappls places request");
  if (response.payload === null) {
    return {
      provider: "mappls",
      mode,
      query,
      suggestions: [],
      source: null,
      error: "error" in response ? response.error : "Mappls places request failed.",
    };
  }

  const suggestions = getArrayFromPayload(response.payload)
    .map((entry, index) => mapEntryToSuggestion(entry, index))
    .filter((entry): entry is MapplsPlaceSuggestion => Boolean(entry));

  const deduped = new Map<string, MapplsPlaceSuggestion>();
  for (const suggestion of suggestions) {
    deduped.set(makeSuggestionKey(suggestion), suggestion);
  }
  const initial = Array.from(deduped.values()).slice(0, clampLimit(options?.limit, 8));
  const enriched = await enrichSuggestionsWithPlaceDetails(initial, apiKey);

  const finalDeduped = new Map<string, MapplsPlaceSuggestion>();
  for (const suggestion of enriched) {
    finalDeduped.set(makeSuggestionKey(suggestion), suggestion);
  }

  return {
    provider: "mappls",
    mode,
    query,
    suggestions: Array.from(finalDeduped.values()).slice(0, clampLimit(options?.limit, 8)),
    source: response.source,
    error: null,
  };
}

function buildReverseGeocodeUrls(
  latitude: number,
  longitude: number,
  apiKey: string
): URL[] {
  const urls = [
    new URL(`${MAPPLS_ATLAS_BASE_URL}/api/places/reverse_geocode`),
    new URL(`${MAPPLS_ATLAS_BASE_URL}/api/places/reverse-geocode`),
    new URL("https://search.mappls.com/search/geoCode/reverse"),
  ];
  for (const url of urls) {
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lng", String(longitude));
    url.searchParams.set("access_token", apiKey);
    url.searchParams.set("token", apiKey);
  }
  return urls;
}

function pickReverseEntry(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) {
    return payload.find((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) ?? null;
  }
  const root = (payload ?? {}) as Record<string, unknown>;
  const candidates = [root.results, root.data, root.copResults, root.places];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const first = candidate.find(
      (item): item is Record<string, unknown> => Boolean(item && typeof item === "object")
    );
    if (first) return first;
  }
  return root && Object.keys(root).length > 0 ? root : null;
}

export async function reverseGeocodeMapplsCoordinates(
  latitude: number,
  longitude: number
): Promise<MapplsReverseGeocodeResponse | null> {
  const apiKey = getMapplsPlacesApiKey();
  if (!apiKey) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      provider: "mappls",
      latitude,
      longitude,
      label: null,
      address: null,
      locality: null,
      city: null,
      state: null,
      pincode: null,
      source: null,
      error: "valid latitude and longitude are required",
    };
  }

  const response = await fetchJsonFromCandidates(
    buildReverseGeocodeUrls(latitude, longitude, apiKey),
    "Mappls reverse geocode request"
  );
  if (response.payload === null) {
    return {
      provider: "mappls",
      latitude,
      longitude,
      label: null,
      address: null,
      locality: null,
      city: null,
      state: null,
      pincode: null,
      source: null,
      error: "error" in response ? response.error : "Mappls reverse geocode request failed.",
    };
  }

  const entry = pickReverseEntry(response.payload);
  if (!entry) {
    return {
      provider: "mappls",
      latitude,
      longitude,
      label: null,
      address: null,
      locality: null,
      city: null,
      state: null,
      pincode: null,
      source: response.source,
      error: null,
    };
  }

  const label = firstText(entry.placeName, entry.place_name, entry.name, entry.locality) || null;
  const address =
    firstText(
      entry.formattedAddress,
      entry.placeAddress,
      entry.place_address,
      entry.address
    ) || null;
  const locality = firstText(entry.locality, entry.subLocality, entry.subLocalityName) || null;
  const city = firstText(entry.city, entry.district) || null;
  const state = firstText(entry.state, entry.region) || null;
  const pincode = firstText(entry.pincode, entry.postcode, entry.postalCode) || null;

  return {
    provider: "mappls",
    latitude,
    longitude,
    label,
    address,
    locality,
    city,
    state,
    pincode,
    source: response.source,
    error: null,
  };
}
