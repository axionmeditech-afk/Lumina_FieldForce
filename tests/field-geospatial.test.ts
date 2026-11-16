import assert from "node:assert/strict";
import test from "node:test";

import { computeRoute, matchTrace, searchPlaces } from "../server/services/field-geospatial";

test("Stadia adapter uses hosted endpoints, server auth, and normalizes responses", async () => {
  const previousKey = process.env.STADIA_MAPS_API_KEY;
  const previousBase = process.env.STADIA_MAPS_BASE_URL;
  const previousFetch = global.fetch;
  process.env.STADIA_MAPS_API_KEY = "test-stadia-key";
  process.env.STADIA_MAPS_BASE_URL = "https://api.stadiamaps.test";

  const requests: Array<{ url: string; authorization: string | null }> = [];
  const payloads = [
    {
      features: [{
        geometry: { type: "Point", coordinates: [72.5714, 23.0225] },
        properties: { gid: "openstreetmap:venue:1", name: "Test Place", label: "Test Place, Ahmedabad", layer: "venue" },
      }],
    },
    {
      trip: {
        summary: { length: 1.25, time: 180 },
        legs: [{ shape: "??AA", maneuvers: [{ type: 1, instruction: "Continue", length: 1.25, time: 180, begin_shape_index: 0, end_shape_index: 1 }] }],
      },
    },
    { trip: { legs: [{ shape: "??AA" }] } },
  ];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    return new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const places = await searchPlaces("Test Place", { latitude: 23.02, longitude: 72.57 });
    assert.equal(places[0]?.placeId, "stadia:openstreetmap:venue:1");
    assert.equal(places[0]?.name, "Test Place");

    const route = await computeRoute(
      { latitude: 23.02, longitude: 72.57 },
      { latitude: 23.03, longitude: 72.58 },
      "auto",
    );
    assert.equal(route.source, "stadia-valhalla");
    assert.equal(route.distanceMetres, 1250);
    assert.equal(route.coordinates.length, 2);

    const matched = await matchTrace([
      { latitude: 23.02, longitude: 72.57, accuracy: 12 },
      { latitude: 23.03, longitude: 72.58, accuracy: 14 },
    ]);
    assert.equal(matched.length, 2);

    assert.match(requests[0]!.url, /\/geocoding\/v1\/search\?/);
    assert.match(requests[1]!.url, /\/route\/v1$/);
    assert.match(requests[2]!.url, /\/map_match\/v1$/);
    assert.ok(requests.every((request) => request.authorization === "Stadia-Auth test-stadia-key"));
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STADIA_MAPS_API_KEY;
    else process.env.STADIA_MAPS_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.STADIA_MAPS_BASE_URL;
    else process.env.STADIA_MAPS_BASE_URL = previousBase;
  }
});
