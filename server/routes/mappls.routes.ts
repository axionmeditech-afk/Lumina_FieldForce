import type { Express } from "express";

export type MapplsRouteDeps = Record<string, any>;

export function registerMapplsRoutes(app: Express, deps: MapplsRouteDeps) {
  const {
    requireAuth,
    firstString,
    parseCoordinatePair,
    parseOptionalQueryFloat,
    parseOptionalInteger,
    searchMapplsPlaces,
    reverseGeocodeMapplsCoordinates,
  } = deps;

  app.get("/api/mappls/places/autosuggest", requireAuth, async (req, res) => {
    const query = firstString(req.query.query);
    if (!query) {
      res.status(400).json({ message: "query is required." });
      return;
    }

    const locationPair =
      parseCoordinatePair(firstString(req.query.location)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
        const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();

    const limit = parseOptionalInteger(req.query.limit ?? req.query.itemCount);
    const response = await searchMapplsPlaces("autosuggest", query, {
      latitude: locationPair?.latitude ?? null,
      longitude: locationPair?.longitude ?? null,
      region: firstString(req.query.region) || null,
      limit,
    });

    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }

    res.json(response);
  });

  app.get("/api/mappls/places/text-search", requireAuth, async (req, res) => {
    const query = firstString(req.query.query);
    if (!query) {
      res.status(400).json({ message: "query is required." });
      return;
    }

    const locationPair =
      parseCoordinatePair(firstString(req.query.location)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
        const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();

    const limit = parseOptionalInteger(req.query.limit ?? req.query.itemCount);
    const response = await searchMapplsPlaces("text", query, {
      latitude: locationPair?.latitude ?? null,
      longitude: locationPair?.longitude ?? null,
      region: firstString(req.query.region) || null,
      limit,
    });

    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }

    res.json(response);
  });

  app.get("/api/mappls/reverse-geocode", requireAuth, async (req, res) => {
    const pointFromPair = parseCoordinatePair(firstString(req.query.location));
    const lat = parseOptionalQueryFloat(req.query.latitude ?? req.query.lat);
    const lng = parseOptionalQueryFloat(req.query.longitude ?? req.query.lng ?? req.query.lon);
    const point =
      pointFromPair ||
      (lat !== null && lng !== null
        ? {
            latitude: lat,
            longitude: lng,
          }
        : null);

    if (!point || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      res.status(400).json({
        message:
          "Valid latitude and longitude are required. Use latitude/longitude or location=lat,lng.",
      });
      return;
    }

    const response = await reverseGeocodeMapplsCoordinates(point.latitude, point.longitude);
    if (!response) {
      res.status(400).json({
        message:
          "Mappls places API key missing. Configure MAPPLS_PLACES_API_KEY or MAPPLS_REST_API_KEY in server env.",
      });
      return;
    }
    res.json(response);
  });


}
