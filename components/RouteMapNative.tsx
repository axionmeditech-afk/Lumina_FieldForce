import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import MapView, {
  Marker,
  Polyline,
  type LatLng,
  type Region,
} from "react-native-maps";
import { WebView } from "react-native-webview";
import Constants from "expo-constants";
import type Colors from "@/constants/colors";
import { formatMumbaiTime } from "@/lib/ist-time";
import type { LocationLog, RouteHalt, RoutePathPoint } from "@/lib/types";
import { RouteMapPanel } from "@/components/RouteMapPanel";

type RouteMapMode = "polyline" | "tracking";

export interface MultiRoutePath {
  userId: string;
  label?: string;
  color?: string;
  points: LocationLog[];
}

export interface PlannedStopPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  status?: "pending" | "in_progress" | "completed";
}

interface RouteMapNativeProps {
  points: LocationLog[];
  halts: RouteHalt[];
  multiRoutes?: MultiRoutePath[];
  plannedStops?: PlannedStopPoint[];
  routePath?: RoutePathPoint[];
  mapMode?: RouteMapMode;
  colors: typeof Colors.light;
  height?: number;
}

interface TrackingWidgetRefLike {
  startTracking: (trackingData: {
    currentLocation: [number, number];
    speedInMillis?: number;
    latentViz?: "route" | "fly" | "jump";
  }) => void;
}

function buildRegion(coords: LatLng[]): Region | null {
  if (!coords.length) return null;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const coord of coords) {
    minLat = Math.min(minLat, coord.latitude);
    maxLat = Math.max(maxLat, coord.latitude);
    minLng = Math.min(minLng, coord.longitude);
    maxLng = Math.max(maxLng, coord.longitude);
  }

  const latitude = (minLat + maxLat) / 2;
  const longitude = (minLng + maxLng) / 2;
  const latitudeDelta = Math.max(0.012, (maxLat - minLat) * 1.8);
  const longitudeDelta = Math.max(0.012, (maxLng - minLng) * 1.8);

  return {
    latitude,
    longitude,
    latitudeDelta,
    longitudeDelta,
  };
}

function buildBounds(coords: LatLng[]): [[number, number], [number, number]] | null {
  if (!coords.length) return null;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const coord of coords) {
    minLat = Math.min(minLat, coord.latitude);
    maxLat = Math.max(maxLat, coord.latitude);
    minLng = Math.min(minLng, coord.longitude);
    maxLng = Math.max(maxLng, coord.longitude);
  }

  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}

function buildOsmHtml(payload: {
  center: { latitude: number; longitude: number };
  bounds: [[number, number], [number, number]] | null;
  routes: Array<{ coords: Array<[number, number]>; color: string }>;
  markers: Array<{ lat: number; lng: number; color: string; label?: string }>;
}) {
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" />
    <link
      rel="stylesheet"
      href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
      crossorigin=""
    />
    <style>
      html, body { height: 100%; margin: 0; padding: 0; }
      body { background: #0b1020; }
      #map { height: 100%; width: 100%; position: relative; }
      .map-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(120% 120% at 15% 10%, rgba(255, 255, 255, 0.12), transparent 55%),
          radial-gradient(120% 120% at 85% 90%, rgba(15, 118, 110, 0.16), transparent 55%),
          linear-gradient(180deg, rgba(15, 23, 42, 0.15), transparent 35%, rgba(15, 23, 42, 0.18));
        mix-blend-mode: soft-light;
      }
      .leaflet-container { background: #0b1020; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .leaflet-control-zoom {
        border: 0;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 10px 20px rgba(15, 23, 42, 0.25);
      }
      .leaflet-control-zoom a {
        background: #101a2d;
        color: #ffffff;
        border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      }
      .leaflet-control-zoom a:last-child { border-bottom: 0; }
      .leaflet-control-zoom a:hover { background: #111827; }
      .leaflet-control-zoom .leaflet-disabled { background: #1f2937; color: #94a3b8; }
      .leaflet-control-attribution {
        font-size: 10px;
        color: #dbeafe;
        background: rgba(2, 6, 23, 0.62);
        padding: 2px 6px;
        border-radius: 999px;
      }
      .leaflet-top.leaflet-left {
        left: auto;
        right: 12px;
        top: auto;
        bottom: 12px;
      }
      .leaflet-bottom.leaflet-right {
        right: 12px;
        bottom: 12px;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-overlay"></div>
    <script
      src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
      crossorigin=""
    ></script>
    <script>
      const data = ${safeJson};
      const map = L.map("map", {
        zoomControl: true,
        attributionControl: true,
        dragging: true,
        touchZoom: true,
        doubleClickZoom: true,
        boxZoom: false,
        keyboard: false,
      });
      L.control.attribution({ prefix: false }).addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        subdomains: "abcd",
        attribution: "© OpenStreetMap, © CARTO",
      }).addTo(map);

      if (data.bounds) {
        map.fitBounds(data.bounds, { padding: [24, 24] });
      } else {
        map.setView([data.center.latitude, data.center.longitude], 13);
      }

      (data.routes || []).forEach((route) => {
        if (!route.coords || route.coords.length < 2) return;
        L.polyline(route.coords, { color: route.color, weight: 4, opacity: 0.95 }).addTo(map);
      });

      (data.markers || []).forEach((marker) => {
        L.circleMarker([marker.lat, marker.lng], {
          radius: 6,
          color: marker.color,
          fillColor: marker.color,
          fillOpacity: 0.95,
          weight: 2,
        }).addTo(map);
      });
    </script>
  </body>
</html>`;
}

function buildMaptilerHtml(payload: {
  center: { latitude: number; longitude: number };
  bounds: [[number, number], [number, number]] | null;
  routes: Array<{ coords: Array<[number, number]>; color: string }>;
  markers: Array<{ lat: number; lng: number; color: string; label?: string }>;
  styleUrl: string;
  maptilerKey?: string;
}) {
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes" />
    <link
      href="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css"
      rel="stylesheet"
    />
    <style>
      html, body, #map { height: 100%; margin: 0; padding: 0; }
      body { background: #0b1020; }
      #map { position: relative; }
      .map-overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(120% 120% at 15% 10%, rgba(255, 255, 255, 0.12), transparent 55%),
          radial-gradient(120% 120% at 85% 90%, rgba(14, 116, 144, 0.2), transparent 55%),
          linear-gradient(180deg, rgba(2, 6, 23, 0.1), transparent 35%, rgba(2, 6, 23, 0.25));
        mix-blend-mode: soft-light;
      }
      .maplibregl-ctrl-group {
        border-radius: 12px;
        overflow: hidden;
        border: 0;
        box-shadow: 0 10px 22px rgba(15, 23, 42, 0.35);
      }
      .maplibregl-ctrl button {
        background: #101a2d;
      }
      .maplibregl-ctrl button:hover {
        background: #1a2640;
      }
      .maplibregl-ctrl-attrib {
        background: rgba(2, 6, 23, 0.55);
        color: #dbeafe;
        border-radius: 999px;
        padding: 2px 6px;
        margin: 0 10px 10px 0;
      }
      .route-marker {
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 3px solid #ffffff;
        box-shadow: 0 10px 16px rgba(2, 6, 23, 0.4);
      }
      .route-marker-label {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        color: #ffffff;
        font-weight: 700;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div class="map-overlay"></div>
    <script src="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js"></script>
    <script>
      const data = ${safeJson};
      const map = new maplibregl.Map({
        container: "map",
        style: data.styleUrl,
        center: [data.center.longitude, data.center.latitude],
        zoom: 12.8,
        pitch: 0,
        bearing: 0,
        antialias: true
      });

      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 80, unit: "metric" }), "bottom-left");

      map.on("load", () => {
        if (data.bounds) {
          const min = data.bounds[0];
          const max = data.bounds[1];
          const bounds = new maplibregl.LngLatBounds([min[1], min[0]], [max[1], max[0]]);
          map.fitBounds(bounds, { padding: 40, duration: 0 });
        }

        const features = [];
        (data.routes || []).forEach((route) => {
          if (!route.coords || route.coords.length < 2) return;
          features.push({
            type: "Feature",
            properties: { color: route.color || "#22d3ee" },
            geometry: {
              type: "LineString",
              coordinates: route.coords.map((c) => [c[1], c[0]])
            }
          });
        });
        if (features.length) {
          map.addSource("routeLines", {
            type: "geojson",
            data: { type: "FeatureCollection", features }
          });
          map.addLayer({
            id: "routeLinesCasing",
            type: "line",
            source: "routeLines",
            paint: {
              "line-color": "rgba(15, 23, 42, 0.85)",
              "line-width": 7,
              "line-opacity": 0.9
            }
          });
          map.addLayer({
            id: "routeLinesLayer",
            type: "line",
            source: "routeLines",
            paint: {
              "line-color": ["get", "color"],
              "line-width": 4.5,
              "line-opacity": 0.95
            }
          });
        }

        (data.markers || []).forEach((marker) => {
          const el = document.createElement("div");
          el.className = "route-marker";
          el.style.background = marker.color || "#22d3ee";
          if (marker.label) {
            const label = document.createElement("div");
            label.className = "route-marker-label";
            label.textContent = marker.label;
            el.appendChild(label);
          }
          new maplibregl.Marker({ element: el })
            .setLngLat([marker.lng, marker.lat])
            .addTo(map);
        });
      });
    </script>
  </body>
</html>`;
}

function toLatLng(points: LocationLog[]): LatLng[] {
  return points.map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
  }));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveTrackingStepMs(
  fromAt: string,
  toAt: string,
  playbackFactor: number,
  minMs: number,
  maxMs: number
): number {
  const from = new Date(fromAt).getTime();
  const to = new Date(toAt).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return clamp(1200, minMs, maxMs);
  }
  const scaled = Math.round((to - from) / Math.max(1, playbackFactor));
  return clamp(scaled, minMs, maxMs);
}

function isValidLocationPoint(point: LocationLog): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

function formatBatteryLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
}

function buildHaltBatterySummary(halt: RouteHalt): string {
  const start = formatBatteryLabel(halt.startBatteryLevel);
  const end = formatBatteryLabel(halt.endBatteryLevel);
  const average = formatBatteryLabel(halt.averageBatteryLevel);
  if (start && end) return `Battery ${start} -> ${end}`;
  if (average) return `Battery ${average}`;
  return "Battery n/a";
}

const MULTI_ROUTE_COLORS = [
  "#0EA5E9",
  "#F97316",
  "#22C55E",
  "#EF4444",
  "#8B5CF6",
  "#EAB308",
  "#14B8A6",
  "#EC4899",
  "#6366F1",
  "#84CC16",
];

function resolveMultiRouteColor(index: number, provided?: string | null): string {
  const cleaned = (provided || "").trim();
  if (cleaned) return cleaned;
  return MULTI_ROUTE_COLORS[index % MULTI_ROUTE_COLORS.length];
}

function resolvePlannedStopColor(
  status: PlannedStopPoint["status"],
  colors: typeof Colors.light
): string {
  if (status === "completed") return colors.success;
  if (status === "in_progress") return colors.warning;
  return colors.secondary;
}

export function RouteMapNative({
  points,
  halts,
  multiRoutes,
  plannedStops,
  routePath,
  mapMode = "polyline",
  colors,
  height = 260,
}: RouteMapNativeProps) {
  const isExpoGo = Constants.appOwnership === "expo";
  const configuredMapProvider = (
    process.env.EXPO_PUBLIC_MAP_PROVIDER || "osm"
  )
    .trim()
    .toLowerCase();
  const mapProvider =
    configuredMapProvider === "mappls" && isExpoGo ? "osm" : configuredMapProvider;
  const shouldUseMappls = Platform.OS === "android" && mapProvider === "mappls" && !isExpoGo;
  const isOsmProvider = mapProvider === "osm" || mapProvider === "openstreetmap";
  const isMaptilerProvider = mapProvider === "maptiler";
  const maptilerStyleUrl = process.env.EXPO_PUBLIC_MAPTILER_STYLE_URL?.trim() || "";
  const maptilerKey = process.env.EXPO_PUBLIC_MAPTILER_KEY?.trim() || "";
  const mapplsClusterId = process.env.EXPO_PUBLIC_MAPPLS_CLUSTER_ID?.trim() || "";
  const mapplsRegion = process.env.EXPO_PUBLIC_MAPPLS_REGION?.trim() || "IND";
  const mapplsTrackingEnabled = (process.env.EXPO_PUBLIC_MAPPLS_TRACKING_WIDGET || "true")
    .trim()
    .toLowerCase() !== "false";
  const playbackFactor = parsePositiveInt(process.env.EXPO_PUBLIC_MAPPLS_TRACKING_PLAYBACK_SPEED, 150);
  const trackingMinStepMs = parsePositiveInt(process.env.EXPO_PUBLIC_MAPPLS_TRACKING_MIN_STEP_MS, 450);
  const trackingMaxStepMs = parsePositiveInt(process.env.EXPO_PUBLIC_MAPPLS_TRACKING_MAX_STEP_MS, 3200);
  const trackingRouteSpeedMs = parsePositiveInt(process.env.EXPO_PUBLIC_MAPPLS_TRACKING_ROUTE_SPEED_MS, 1400);

  const normalizedMultiRoutes = useMemo(
    () =>
      (multiRoutes || [])
        .map((route, index) => ({
          ...route,
          color: resolveMultiRouteColor(index, route.color),
          points: (route.points || []).filter(isValidLocationPoint),
        }))
        .filter((route) => route.points.length > 0),
    [multiRoutes]
  );
  const normalizedPlannedStops = useMemo(
    () =>
      (plannedStops || []).filter(
        (stop) => Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)
      ),
    [plannedStops]
  );
  const hasMultiRoutes = normalizedMultiRoutes.length > 0;
  const shouldUseTrackingWidget =
    shouldUseMappls && mapMode === "tracking" && mapplsTrackingEnabled && !hasMultiRoutes;

  const [mapplsModule, setMapplsModule] = useState<any | null>(null);
  const [trackingModule, setTrackingModule] = useState<any | null>(null);
  const mapplsSdk = useMemo(() => {
    if (!mapplsModule) return null;
    return mapplsModule.default ?? mapplsModule;
  }, [mapplsModule]);
  const trackingSdk = useMemo(() => {
    if (!trackingModule) return null;
    return trackingModule.default ?? trackingModule;
  }, [trackingModule]);
  const mapplsIsShim = Boolean(mapplsSdk && (mapplsSdk as any).__isShim);
  const trackingIsShim = Boolean(trackingSdk && (trackingSdk as any).__isShim);
  const TrackingWidget = useMemo(() => {
    const moduleRoot = trackingSdk as any;
    if (!moduleRoot) return null;
    return moduleRoot.MapplsTrackingWidget ?? moduleRoot.default?.MapplsTrackingWidget ?? null;
  }, [trackingSdk]);

  const mapRef = useRef<MapView | null>(null);
  const trackingWidgetRef = useRef<TrackingWidgetRefLike | null>(null);

  const coords = useMemo(() => {
    if (routePath && routePath.length >= 2) {
      return routePath.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
      }));
    }
    return toLatLng(points);
  }, [points, routePath]);

  const allCoords = useMemo(() => {
    if (hasMultiRoutes) {
      const routeCoords = normalizedMultiRoutes.flatMap((route) =>
        route.points.map((point) => ({
          latitude: point.latitude,
          longitude: point.longitude,
        }))
      );
      return [
        ...routeCoords,
        ...normalizedPlannedStops.map((stop) => ({
          latitude: stop.latitude,
          longitude: stop.longitude,
        })),
      ];
    }
    return [
      ...coords,
      ...normalizedPlannedStops.map((stop) => ({
        latitude: stop.latitude,
        longitude: stop.longitude,
      })),
    ];
  }, [coords, hasMultiRoutes, normalizedMultiRoutes, normalizedPlannedStops]);

  const region = useMemo(() => buildRegion(allCoords), [allCoords]);
  const bounds = useMemo(() => buildBounds(allCoords), [allCoords]);
  const startPoint = points[0];
  const endPoint = points[points.length - 1];
  const intermediatePoints = useMemo(
    () => points.slice(1, -1).filter(isValidLocationPoint),
    [points]
  );
  const trackingPoints = useMemo(() => points.filter(isValidLocationPoint), [points]);
  const trackingStartPoint = trackingPoints[0];
  const trackingEndPoint = trackingPoints[trackingPoints.length - 1];
  const trackingOrigin = trackingStartPoint
    ? `${trackingStartPoint.longitude},${trackingStartPoint.latitude}`
    : "";
  const trackingDestination = trackingEndPoint
    ? `${trackingEndPoint.longitude},${trackingEndPoint.latitude}`
    : "";
  const trackingOrderId = trackingStartPoint
    ? `trk_${trackingStartPoint.userId}_${trackingStartPoint.capturedAt.slice(0, 10)}`
    : `trk_${Date.now()}`;

  const trackingStyles = useMemo(
    () => ({
      routePolylineStyle: {
        lineColor: colors.primary,
        lineWidth: 4,
        lineOpacity: 0.96,
        lineCap: "round",
        lineJoin: "round",
      },
      dashRoutePolylineStyle: {
        lineColor: colors.primary,
        lineWidth: 3,
        lineOpacity: 0.62,
        lineCap: "round",
        lineJoin: "round",
        lineDasharray: [2, 4],
      },
      destinationIconStyle: {
        iconAllowOverlap: true,
        iconAnchor: "bottom",
        iconSize: 0.8,
      },
      OriginIconStyle: {
        iconAllowOverlap: true,
        iconAnchor: "bottom",
        iconSize: 0.8,
      },
      destinationRouteConnectorStyle: {
        lineColor: colors.textSecondary,
        lineWidth: 3,
        lineOpacity: 0.75,
        lineCap: "round",
        lineJoin: "round",
        lineDasharray: [2, 4],
      },
    }),
    [colors.primary, colors.textSecondary]
  );

  const flattenedMultiRoutePoints = useMemo(
    () => normalizedMultiRoutes.flatMap((route) => route.points),
    [normalizedMultiRoutes]
  );
  const hasAnyPoints = hasMultiRoutes
    ? flattenedMultiRoutePoints.length > 0 || normalizedPlannedStops.length > 0
    : points.length > 0 || normalizedPlannedStops.length > 0;
  const panelPoints = hasMultiRoutes ? flattenedMultiRoutePoints : points;
  const panelHalts = hasMultiRoutes ? [] : halts;
  const multiRouteDefs = useMemo(
    () =>
      normalizedMultiRoutes.map((route, index) => ({
        id: `multi_${index}_${route.userId}`,
        index,
        userId: route.userId,
        label: route.label || route.userId,
        color: route.color,
        coords: route.points.map((point) => ({
          latitude: point.latitude,
          longitude: point.longitude,
        })),
        startPoint: route.points[0] ?? null,
        endPoint: route.points[route.points.length - 1] ?? null,
      })),
    [normalizedMultiRoutes]
  );

  const osmRoutes = useMemo(() => {
    if (hasMultiRoutes) {
      return multiRouteDefs
        .filter((route) => route.coords.length >= 2)
        .map((route) => ({
          coords: route.coords.map((coord) => [coord.latitude, coord.longitude] as [number, number]),
          color: route.color,
        }));
    }
    if (coords.length >= 2) {
      return [
        {
          coords: coords.map((coord) => [coord.latitude, coord.longitude] as [number, number]),
          color: colors.primary,
        },
      ];
    }
    return [];
  }, [colors.primary, coords, hasMultiRoutes, multiRouteDefs]);

  const osmMarkers = useMemo(() => {
    const markers: Array<{ lat: number; lng: number; color: string; label?: string }> = [];
    if (hasMultiRoutes) {
      for (const route of multiRouteDefs) {
        if (route.endPoint) {
          markers.push({
            lat: route.endPoint.latitude,
            lng: route.endPoint.longitude,
            color: route.color,
          });
        }
      }
    } else {
      if (startPoint) {
        markers.push({
          lat: startPoint.latitude,
          lng: startPoint.longitude,
          color: colors.success,
          label: "S",
        });
      }
      if (endPoint) {
        markers.push({
          lat: endPoint.latitude,
          lng: endPoint.longitude,
          color: colors.danger,
          label: "E",
        });
      }
      for (const halt of halts) {
        markers.push({
          lat: halt.latitude,
          lng: halt.longitude,
          color: "#F59E0B",
          label: "H",
        });
      }
    }
    for (const stop of normalizedPlannedStops) {
      markers.push({
        lat: stop.latitude,
        lng: stop.longitude,
        color: resolvePlannedStopColor(stop.status, colors),
        label: "P",
      });
    }
    return markers;
  }, [
    colors,
    endPoint,
    halts,
    hasMultiRoutes,
    multiRouteDefs,
    normalizedPlannedStops,
    startPoint,
  ]);

  const mapHtml = useMemo(() => {
    if ((!isOsmProvider && !isMaptilerProvider) || !region) return null;
    if (isMaptilerProvider && maptilerStyleUrl) {
      return buildMaptilerHtml({
        center: { latitude: region.latitude, longitude: region.longitude },
        bounds,
        routes: osmRoutes,
        markers: osmMarkers,
        styleUrl: maptilerStyleUrl,
        maptilerKey,
      });
    }
    if (isOsmProvider) {
      return buildOsmHtml({
        center: { latitude: region.latitude, longitude: region.longitude },
        bounds,
        routes: osmRoutes,
        markers: osmMarkers,
      });
    }
    return null;
  }, [bounds, isMaptilerProvider, isOsmProvider, maptilerKey, maptilerStyleUrl, osmMarkers, osmRoutes, region]);

  useEffect(() => {
    if (!shouldUseMappls) {
      setMapplsModule(null);
      return;
    }
    let mounted = true;
    void import("mappls-map-react-native")
      .then((module) => {
        if (!mounted) return;
        setMapplsModule(module);
      })
      .catch(() => {
        if (!mounted) return;
        setMapplsModule(null);
      });
    return () => {
      mounted = false;
    };
  }, [shouldUseMappls]);

  useEffect(() => {
    if (!shouldUseTrackingWidget) {
      setTrackingModule(null);
      return;
    }
    let mounted = true;
    void import("mappls-tracking-react-native")
      .then((module) => {
        if (!mounted) return;
        setTrackingModule(module);
      })
      .catch(() => {
        if (!mounted) return;
        setTrackingModule(null);
      });
    return () => {
      mounted = false;
    };
  }, [shouldUseTrackingWidget]);

  const googleMapsApiKey = (Constants.expoConfig as any)?.android?.config?.googleMaps?.apiKey;
  const hasAndroidMapsKey =
    Platform.OS !== "android" || isExpoGo || mapProvider !== "google" || Boolean(googleMapsApiKey);

  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!mapRef.current || allCoords.length < 2) return;
    mapRef.current.fitToCoordinates(allCoords, {
      edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
      animated: true,
    });
  }, [allCoords]);

  useEffect(() => {
    if (!mapplsSdk || !shouldUseMappls) return;
    try {
      if (typeof mapplsSdk.setRegion === "function") {
        mapplsSdk.setRegion(mapplsRegion);
      }
      if (mapplsClusterId && typeof mapplsSdk.setClusterId === "function") {
        mapplsSdk.setClusterId(mapplsClusterId);
      }
    } catch {
      // no-op
    }
  }, [mapplsClusterId, mapplsRegion, mapplsSdk, shouldUseMappls]);

  useEffect(() => {
    if (!shouldUseTrackingWidget || !TrackingWidget) return;
    if (trackingPoints.length < 2) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sendPoint = (index: number) => {
      if (cancelled) return;
      const widget = trackingWidgetRef.current;
      if (!widget || typeof widget.startTracking !== "function") {
        timer = setTimeout(() => sendPoint(index), 350);
        return;
      }

      const current = trackingPoints[index];
      const nextIndex = index + 1 >= trackingPoints.length ? 0 : index + 1;
      const next = trackingPoints[nextIndex];
      const transitionMs = resolveTrackingStepMs(
        current.capturedAt,
        next?.capturedAt ?? current.capturedAt,
        playbackFactor,
        trackingMinStepMs,
        trackingMaxStepMs
      );

      try {
        widget.startTracking({
          currentLocation: [current.longitude, current.latitude],
          speedInMillis: transitionMs,
          latentViz: "jump",
        });
      } catch {
        // no-op
      }

      const waitMs = nextIndex === 0 ? Math.max(900, transitionMs) : transitionMs;
      timer = setTimeout(() => sendPoint(nextIndex), waitMs);
    };

    timer = setTimeout(() => sendPoint(0), 700);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    TrackingWidget,
    playbackFactor,
    shouldUseTrackingWidget,
    trackingMaxStepMs,
    trackingMinStepMs,
    trackingPoints,
  ]);

  if (Platform.OS === "web") {
    return <RouteMapPanel points={panelPoints} halts={panelHalts} colors={colors} height={height} />;
  }

  if (shouldUseMappls) {
    if (!mapplsSdk || mapplsIsShim) {
      return (
        <View style={{ gap: 8 }}>
          <RouteMapPanel points={panelPoints} halts={panelHalts} colors={colors} height={height} />
          <View
            style={[
              styles.noteBox,
              {
                borderColor: colors.warning + "55",
                backgroundColor: colors.warning + "14",
              },
            ]}
          >
            <Text style={[styles.noteText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
              Mappls SDK not loaded. Install `mappls-map-react-native`, set
              `EXPO_PUBLIC_ENABLE_MAPPLS_NATIVE=true`, and rebuild the Android app.
            </Text>
          </View>
        </View>
      );
    }

    if (!hasAnyPoints || !region) {
      return (
        <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated, height }]}> 
          <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
            No route points for selected day
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            The live route will render here as soon as location points are received from the API.
          </Text>
        </View>
      );
    }

    const MapplsGL = mapplsSdk as any;

    if (shouldUseTrackingWidget) {
      if (!trackingSdk || !TrackingWidget || trackingIsShim) {
        return (
          <View style={{ gap: 8 }}>
            <RouteMapPanel points={panelPoints} halts={panelHalts} colors={colors} height={height} />
            <View
              style={[
                styles.noteBox,
                {
                  borderColor: colors.warning + "55",
                  backgroundColor: colors.warning + "14",
                },
              ]}
            >
              <Text style={[styles.noteText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
                Tracking widget not loaded. Install `mappls-tracking-react-native`, set
                `EXPO_PUBLIC_ENABLE_MAPPLS_NATIVE=true`, and rebuild the Android app.
              </Text>
            </View>
          </View>
        );
      }

      if (trackingPoints.length < 2 || !trackingOrigin || !trackingDestination) {
        return (
          <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated, height }]}> 
            <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
              Tracking widget needs at least 2 GPS points
            </Text>
            <Text style={[styles.emptySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
              Animated tracking will start as soon as the next route sample is available.
            </Text>
          </View>
        );
      }

      return (
        <View style={[styles.container, { height, borderColor: colors.border }]}> 
          <MapplsGL.MapView style={StyleSheet.absoluteFill} onMapError={() => {}}>
            <TrackingWidget
              ref={trackingWidgetRef}
              orderId={trackingOrderId}
              originPoint={trackingOrigin}
              destinationPoint={trackingDestination}
              speedInMillis={trackingRouteSpeedMs}
              resource="route_eta"
              profile="driving"
              routeChangeBuffer={50}
              latentViz="jump"
              polylineRefresh={false}
              cameraZoomLevel={13}
              fitBoundsPadding={80}
              fitBoundsDuration={900}
              latentVizRadius={100}
              routePolylineStyle={trackingStyles.routePolylineStyle}
              destinationIconStyle={trackingStyles.destinationIconStyle}
              dashRoutePolylineStyle={trackingStyles.dashRoutePolylineStyle}
              OriginIconStyle={trackingStyles.OriginIconStyle}
              destinationRouteConnectorStyle={trackingStyles.destinationRouteConnectorStyle}
              enableDestinationRouteConnector
            />

            {halts.map((halt, idx) => (
              <MapplsGL.PointAnnotation
                key={halt.id}
                id={`route_halt_${idx}`}
                coordinate={[halt.longitude, halt.latitude]}
              >
                <View style={[styles.pinWrap, { backgroundColor: "#F59E0B" }]}> 
                  <Text style={styles.pinText}>H</Text>
                </View>
              </MapplsGL.PointAnnotation>
            ))}
            {normalizedPlannedStops.map((stop) => (
              <MapplsGL.PointAnnotation
                key={`planned_stop_${stop.id}`}
                id={`planned_stop_${stop.id}`}
                coordinate={[stop.longitude, stop.latitude]}
              >
                <View
                  style={[
                    styles.pinWrap,
                    { backgroundColor: resolvePlannedStopColor(stop.status, colors) },
                  ]}
                >
                  <Text style={styles.pinText}>P</Text>
                </View>
              </MapplsGL.PointAnnotation>
            ))}
          </MapplsGL.MapView>
        </View>
      );
    }

    const centerCoordinate: [number, number] = [region.longitude, region.latitude];

    if (hasMultiRoutes) {
      return (
        <View style={[styles.container, { height, borderColor: colors.border }]}> 
          <MapplsGL.MapView style={StyleSheet.absoluteFill} onMapError={() => {}}>
            <MapplsGL.Camera zoomLevel={12} centerCoordinate={centerCoordinate} />
            {multiRouteDefs.map((route) => (
              <React.Fragment key={route.id}>
                {route.coords.length >= 2 ? (
                  <MapplsGL.ShapeSource
                    id={`${route.id}_line_source`}
                    shape={{
                      type: "Feature",
                      properties: {},
                      geometry: {
                        type: "LineString",
                        coordinates: route.coords.map((coord) => [coord.longitude, coord.latitude]),
                      },
                    }}
                  >
                    <MapplsGL.LineLayer
                      id={`${route.id}_line_layer`}
                      style={{
                        lineColor: route.color,
                        lineWidth: 4,
                        lineOpacity: 0.95,
                      }}
                    />
                  </MapplsGL.ShapeSource>
                ) : null}
                {route.endPoint ? (
                  <MapplsGL.PointAnnotation
                    id={`${route.id}_end`}
                    coordinate={[route.endPoint.longitude, route.endPoint.latitude]}
                  >
                    <View style={[styles.pinWrap, { backgroundColor: route.color }]}> 
                      <Text style={styles.pinText}>{String(route.index + 1)}</Text>
                    </View>
                  </MapplsGL.PointAnnotation>
                ) : null}
              </React.Fragment>
            ))}
            {normalizedPlannedStops.map((stop) => (
              <MapplsGL.PointAnnotation
                key={`planned_stop_${stop.id}`}
                id={`planned_stop_${stop.id}`}
                coordinate={[stop.longitude, stop.latitude]}
              >
                <View
                  style={[
                    styles.pinWrap,
                    { backgroundColor: resolvePlannedStopColor(stop.status, colors) },
                  ]}
                >
                  <Text style={styles.pinText}>P</Text>
                </View>
              </MapplsGL.PointAnnotation>
            ))}
          </MapplsGL.MapView>
        </View>
      );
    }

    const routeFeature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: coords.map((coord) => [coord.longitude, coord.latitude]),
      },
    };

    return (
      <View style={[styles.container, { height, borderColor: colors.border }]}> 
        <MapplsGL.MapView style={StyleSheet.absoluteFill} onMapError={() => {}}>
          <MapplsGL.Camera zoomLevel={12} centerCoordinate={centerCoordinate} />
          <MapplsGL.ShapeSource id="routeLineSource" shape={routeFeature}>
            <MapplsGL.LineLayer
              id="routeLineLayer"
              style={{
                lineColor: colors.primary,
                lineWidth: 4,
                lineOpacity: 0.95,
              }}
            />
          </MapplsGL.ShapeSource>

          {startPoint ? (
            <MapplsGL.PointAnnotation
              id="route_start"
              coordinate={[startPoint.longitude, startPoint.latitude]}
            >
              <View style={[styles.pinWrap, { backgroundColor: colors.success }]}> 
                <Text style={styles.pinText}>S</Text>
              </View>
            </MapplsGL.PointAnnotation>
          ) : null}

          {endPoint ? (
            <MapplsGL.PointAnnotation
              id="route_end"
              coordinate={[endPoint.longitude, endPoint.latitude]}
            >
              <View style={[styles.pinWrap, { backgroundColor: colors.danger }]}> 
                <Text style={styles.pinText}>E</Text>
              </View>
            </MapplsGL.PointAnnotation>
          ) : null}

          {intermediatePoints.map((point, idx) => (
            <MapplsGL.PointAnnotation
              key={`route_pt_${point.id}`}
              id={`route_pt_${idx}`}
              coordinate={[point.longitude, point.latitude]}
            >
              <View style={[styles.pointDot, { backgroundColor: colors.secondary }]} />
            </MapplsGL.PointAnnotation>
          ))}

          {halts.map((halt, idx) => (
            <MapplsGL.PointAnnotation
              key={halt.id}
              id={`route_halt_${idx}`}
              coordinate={[halt.longitude, halt.latitude]}
            >
              <View style={[styles.pinWrap, { backgroundColor: "#F59E0B" }]}> 
                <Text style={styles.pinText}>H</Text>
              </View>
            </MapplsGL.PointAnnotation>
          ))}
          {normalizedPlannedStops.map((stop) => (
            <MapplsGL.PointAnnotation
              key={`planned_stop_${stop.id}`}
              id={`planned_stop_${stop.id}`}
              coordinate={[stop.longitude, stop.latitude]}
            >
              <View
                style={[
                  styles.pinWrap,
                  { backgroundColor: resolvePlannedStopColor(stop.status, colors) },
                ]}
              >
                <Text style={styles.pinText}>P</Text>
              </View>
            </MapplsGL.PointAnnotation>
          ))}
        </MapplsGL.MapView>
      </View>
    );
  }

  if (isOsmProvider || isMaptilerProvider) {
    if (isMaptilerProvider && !maptilerStyleUrl) {
      return (
        <View style={{ gap: 8 }}>
          <RouteMapPanel points={panelPoints} halts={panelHalts} colors={colors} height={height} />
          <View
            style={[
              styles.noteBox,
              {
                borderColor: colors.warning + "55",
                backgroundColor: colors.warning + "14",
              },
            ]}
          >
            <Text style={[styles.noteText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
              MapTiler style URL missing. Set `EXPO_PUBLIC_MAPTILER_STYLE_URL` and rebuild.
            </Text>
          </View>
        </View>
      );
    }
    if (!hasAnyPoints || !region) {
      return (
        <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated, height }]}> 
          <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
            No route points for selected day
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            The live route will render here as soon as location points are received from the API.
          </Text>
        </View>
      );
    }

    if (!mapHtml) {
      return (
        <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated, height }]}> 
          <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
            Loading map...
          </Text>
        </View>
      );
    }

    return (
      <View style={[styles.container, { height, borderColor: colors.border }]}> 
        <WebView
          originWhitelist={["*"]}
          source={{ html: mapHtml }}
          style={StyleSheet.absoluteFill}
          scrollEnabled
          nestedScrollEnabled
          javaScriptEnabled
          domStorageEnabled
        />
      </View>
    );
  }

  if (!hasAndroidMapsKey) {
    return (
      <View style={{ gap: 8 }}>
        <RouteMapPanel points={panelPoints} halts={panelHalts} colors={colors} height={height} />
        <View
          style={[
            styles.noteBox,
            {
              borderColor: colors.warning + "55",
              backgroundColor: colors.warning + "14",
            },
          ]}
        >
          <Text style={[styles.noteText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}> 
            Android Google Maps API key missing. Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`, or switch to Mappls with `EXPO_PUBLIC_MAP_PROVIDER=mappls`.
          </Text>
        </View>
      </View>
    );
  }

  if (!hasAnyPoints || !region) {
    return (
      <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated, height }]}> 
        <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
          No route points for selected day
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
          The live route will render here as soon as location points are received from the API.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { height, borderColor: colors.border }]}> 
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        showsUserLocation={false}
        showsCompass
        rotateEnabled={false}
      >
        {hasMultiRoutes
          ? multiRouteDefs.map((route) => (
              <React.Fragment key={route.id}>
                {route.coords.length >= 2 ? (
                  <Polyline coordinates={route.coords} strokeColor={route.color} strokeWidth={4} />
                ) : null}
                {route.endPoint ? (
                  <Marker
                    coordinate={{
                      latitude: route.endPoint.latitude,
                      longitude: route.endPoint.longitude,
                    }}
                    title={route.label}
                    description={`Last update: ${formatMumbaiTime(route.endPoint.capturedAt)}`}
                    pinColor={route.color}
                  />
                ) : null}
              </React.Fragment>
            ))
          : (
            <>
              <Polyline coordinates={coords} strokeColor={colors.primary} strokeWidth={4} />

              {startPoint ? (
                <Marker
                  coordinate={{ latitude: startPoint.latitude, longitude: startPoint.longitude }}
                  title="Route Start"
                  description={formatMumbaiTime(startPoint.capturedAt)}
                  pinColor={colors.success}
                />
              ) : null}

              {endPoint ? (
                <Marker
                  coordinate={{ latitude: endPoint.latitude, longitude: endPoint.longitude }}
                  title="Route End"
                  description={formatMumbaiTime(endPoint.capturedAt)}
                  pinColor={colors.danger}
                />
              ) : null}

              {intermediatePoints.map((point) => (
                <Marker
                  key={`route_point_${point.id}`}
                  coordinate={{ latitude: point.latitude, longitude: point.longitude }}
                  title="Route Point"
                  description={formatMumbaiTime(point.capturedAt)}
                  pinColor={colors.secondary}
                />
              ))}

              {halts.map((halt, idx) => (
                <Marker
                  key={halt.id}
                  coordinate={{ latitude: halt.latitude, longitude: halt.longitude }}
                  title={`Halt ${idx + 1}: ${halt.label}`}
                  description={`${halt.durationMinutes} mins (${formatMumbaiTime(halt.startAt)} - ${formatMumbaiTime(halt.endAt)}) | ${buildHaltBatterySummary(halt)}`}
                  pinColor="#F59E0B"
                />
              ))}
              {normalizedPlannedStops.map((stop) => (
                <Marker
                  key={`planned_stop_${stop.id}`}
                  coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
                  title={`Planned Stop: ${stop.label}`}
                  description={
                    stop.status === "completed"
                      ? "Completed"
                      : stop.status === "in_progress"
                        ? "In progress"
                        : "Pending"
                  }
                  pinColor={resolvePlannedStopColor(stop.status, colors)}
                />
              ))}
            </>
          )}
        {hasMultiRoutes
          ? normalizedPlannedStops.map((stop) => (
              <Marker
                key={`planned_stop_${stop.id}`}
                coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
                title={`Planned Stop: ${stop.label}`}
                description={
                  stop.status === "completed"
                    ? "Completed"
                    : stop.status === "in_progress"
                      ? "In progress"
                      : "Pending"
                }
                pinColor={resolvePlannedStopColor(stop.status, colors)}
              />
            ))
          : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  empty: {
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 18,
  },
  emptyTitle: {
    fontSize: 14,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 12,
    textAlign: "center",
    lineHeight: 17,
  },
  noteBox: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteText: {
    fontSize: 12,
    lineHeight: 17,
  },
  pinWrap: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
  pinText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
  },
  pointDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
});
