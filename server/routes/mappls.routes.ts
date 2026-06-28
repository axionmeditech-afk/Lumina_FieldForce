import type { Express } from "express";

export type MapplsRouteDeps = Record<string, any>;

export function registerMapplsRoutes(app: Express, deps: MapplsRouteDeps) {
  const {
    requireAuth,
    firstString,
    parseCoordinatePair,
    parseOptionalQueryFloat,
    parseOptionalInteger,
    parseBooleanQuery,
    parseCoordinatesList,
    searchMapplsPlaces,
    reverseGeocodeMapplsCoordinates,
    getMapplsDirectionsForCoordinates,
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

  app.get("/api/mappls/route/preview", requireAuth, async (req, res) => {
    const origin =
      parseCoordinatePair(firstString(req.query.origin)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.origin_latitude ?? req.query.origin_lat);
        const lng = parseOptionalQueryFloat(
          req.query.origin_longitude ?? req.query.origin_lng ?? req.query.origin_lon
        );
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();
    const destination =
      parseCoordinatePair(firstString(req.query.destination)) ||
      (() => {
        const lat = parseOptionalQueryFloat(req.query.destination_latitude ?? req.query.destination_lat);
        const lng = parseOptionalQueryFloat(
          req.query.destination_longitude ?? req.query.destination_lng ?? req.query.destination_lon
        );
        if (lat === null || lng === null) return null;
        if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        return { latitude: lat, longitude: lng };
      })();
    const waypoints = parseCoordinatesList(firstString(req.query.waypoints));

    if (!origin || !destination) {
      res.status(400).json({
        message:
          "origin and destination are required. Use origin=lat,lng and destination=lat,lng.",
      });
      return;
    }

    const routePoints = [origin, ...waypoints, destination];
    const directions = await getMapplsDirectionsForCoordinates(routePoints, {
      resource: firstString(req.query.resource) || null,
      profile: firstString(req.query.profile) || null,
      overview: firstString(req.query.overview) || null,
      geometries: firstString(req.query.geometries) || null,
      alternatives: parseBooleanQuery(req.query.alternatives, false),
      steps: parseBooleanQuery(req.query.steps, true),
      region: firstString(req.query.region) || null,
      routeType: parseOptionalInteger(req.query.rtype),
    });

    if (!directions) {
      res.status(400).json({
        message: "Mappls routing API key missing. Configure MAPPLS_ROUTING_API_KEY in server env.",
      });
      return;
    }

    res.json({
      provider: "mappls",
      origin,
      destination,
      waypointCount: waypoints.length,
      routePointCount: routePoints.length,
      directions,
    });
  });


}
