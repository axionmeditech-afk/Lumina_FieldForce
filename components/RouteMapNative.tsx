import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
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
  customerName?: string;
  latitude: number;
  longitude: number;
  status?: "pending" | "in_progress" | "completed";
  markerKind?: "planned_stop" | "visit_history";
  summary?: string | null;
  detail?: string | null;
  isNearby?: boolean;
  distanceMeters?: number | null;
}

export interface QuickSalePoint {
  id: string;
  customerName: string;
  latitude: number;
  longitude: number;
  orderId: string;
  itemCount: number;
  totalAmount: number;
  soldAt: string;
  customerAddress?: string | null;
  customerEmail?: string | null;
  visitLabel?: string | null;
  visitDepartureNotes?: string | null;
  visitDepartedAt?: string | null;
  summary?: string | null;
  detail?: string | null;
  isNearby?: boolean;
  distanceMeters?: number | null;
}

type WebMapMarkerPayload = {
  id: string;
  kind: "route" | "planned_stop" | "quick_sale";
  lat: number;
  lng: number;
  color: string;
  renderMode?: "standard" | "pulse_only";
  label?: string;
  title?: string;
  summary?: string | null;
  detail?: string | null;
  isNearby?: boolean;
  distanceMeters?: number | null;
};

interface RouteMapNativeProps {
  points: LocationLog[];
  halts: RouteHalt[];
  multiRoutes?: MultiRoutePath[];
  plannedStops?: PlannedStopPoint[];
  quickSalePoints?: QuickSalePoint[];
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
  markers: WebMapMarkerPayload[];
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
      .route-marker-wrap {
        position: relative;
        width: 28px;
        height: 28px;
      }
      .route-marker {
        width: 22px;
        height: 22px;
        position: absolute;
        top: 3px;
        left: 3px;
        border-radius: 999px;
        border: 3px solid #ffffff;
        box-shadow: 0 10px 16px rgba(2, 6, 23, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
        font-size: 10px;
        font-weight: 800;
      }
      .route-marker--ghost {
        opacity: 0;
        border-color: transparent;
        box-shadow: none;
      }
      .route-marker--nearby {
        width: 24px;
        height: 24px;
        top: 2px;
        left: 2px;
      }
      .route-marker-pulse {
        position: absolute;
        inset: 0;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.25;
        animation: markerPulse 1.75s ease-out infinite;
      }
      @keyframes markerPulse {
        0% { transform: scale(0.82); opacity: 0.34; }
        70% { transform: scale(1.75); opacity: 0; }
        100% { transform: scale(1.75); opacity: 0; }
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
        const icon = L.divIcon({
          className: "",
          html: \`
            <div class="route-marker-wrap" style="color: \${marker.color || "#22d3ee"}">
              \${marker.isNearby ? '<div class="route-marker-pulse"></div>' : ""}
              <div class="route-marker \${marker.isNearby ? "route-marker--nearby" : ""} \${marker.renderMode === "pulse_only" ? "route-marker--ghost" : ""}" style="background: \${marker.color || "#22d3ee"}">
                \${marker.label || ""}
              </div>
            </div>
          \`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        const mapMarker = L.marker([marker.lat, marker.lng], { icon }).addTo(map);
        if (marker.kind === "planned_stop") {
          mapMarker.on("click", () => {
            const payload = JSON.stringify({ type: "planned_stop_press", stopId: marker.id });
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(payload);
            }
          });
        } else if (marker.kind === "quick_sale") {
          mapMarker.on("click", () => {
            const payload = JSON.stringify({ type: "quick_sale_press", quickSaleId: marker.id });
            if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
              window.ReactNativeWebView.postMessage(payload);
            }
          });
        }
      });
    </script>
  </body>
</html>`;
}

function buildMaptilerHtml(payload: {
  center: { latitude: number; longitude: number };
  bounds: [[number, number], [number, number]] | null;
  routes: Array<{ coords: Array<[number, number]>; color: string }>;
  markers: WebMapMarkerPayload[];
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
        position: relative;
      }
      .route-marker--nearby {
        width: 24px;
        height: 24px;
      }
      .route-marker-pulse {
        position: absolute;
        inset: -5px;
        border-radius: 999px;
        background: inherit;
        opacity: 0.25;
        animation: markerPulse 1.75s ease-out infinite;
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
      .route-marker--ghost {
        opacity: 0;
        border-color: transparent;
        box-shadow: none;
      }
      @keyframes markerPulse {
        0% { transform: scale(0.82); opacity: 0.34; }
        70% { transform: scale(1.75); opacity: 0; }
        100% { transform: scale(1.75); opacity: 0; }
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
          el.className = marker.isNearby ? "route-marker route-marker--nearby" : "route-marker";
          if (marker.renderMode === "pulse_only") {
            el.className += " route-marker--ghost";
          }
          el.style.background = marker.color || "#22d3ee";
          if (marker.isNearby) {
            const pulse = document.createElement("div");
            pulse.className = "route-marker-pulse";
            el.appendChild(pulse);
          }
          if (marker.label) {
            const label = document.createElement("div");
            label.className = "route-marker-label";
            label.textContent = marker.label;
            el.appendChild(label);
          }
          if (marker.kind === "planned_stop") {
            el.addEventListener("click", () => {
              const payload = JSON.stringify({ type: "planned_stop_press", stopId: marker.id });
              if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                window.ReactNativeWebView.postMessage(payload);
              }
            });
          } else if (marker.kind === "quick_sale") {
            el.addEventListener("click", () => {
              const payload = JSON.stringify({ type: "quick_sale_press", quickSaleId: marker.id });
              if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                window.ReactNativeWebView.postMessage(payload);
              }
            });
          }
          new maplibregl.Marker({ element: el }).setLngLat([marker.lng, marker.lat]).addTo(map);
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

function getHistoricalVisitAccent(colors: typeof Colors.light): string {
  return colors.primary || "#2563EB";
}

function resolvePlannedStopColor(
  stop: PlannedStopPoint,
  colors: typeof Colors.light
): string {
  if (stop.markerKind === "visit_history") return getHistoricalVisitAccent(colors);
  if (stop.status === "completed") return colors.success;
  if (stop.status === "in_progress") return colors.warning;
  return colors.secondary;
}

function getNearbyStopAccent(colors: typeof Colors.light): string {
  return colors.warning || "#F59E0B";
}

function getQuickSaleAccent(colors: typeof Colors.light): string {
  return colors.primary || "#6D28D9";
}

function getPlannedStopTitle(stop: PlannedStopPoint): string {
  return stop.customerName || stop.label;
}

function getPlannedStopSummary(stop: PlannedStopPoint): string | null {
  if (stop.summary?.trim()) return stop.summary.trim();
  if (stop.markerKind === "visit_history") return "Past visit completed here.";
  if (stop.status === "completed") return "Completed";
  if (stop.status === "in_progress") return "In progress";
  return "Pending";
}

function getPlannedStopDetail(stop: PlannedStopPoint): string | null {
  return stop.detail?.trim() || null;
}

function getQuickSaleSummary(point: QuickSalePoint): string {
  if (point.summary?.trim()) return point.summary.trim();
  return `Order #${point.orderId} | ${point.itemCount} items | INR ${Math.round(point.totalAmount)}`;
}

function getQuickSaleDetail(point: QuickSalePoint): string | null {
  if (point.detail?.trim()) return point.detail.trim();
  return point.customerAddress || point.customerEmail || null;
}

function isHistoryPulseOnly(stop: PlannedStopPoint): boolean {
  return stop.markerKind === "visit_history";
}

export function RouteMapNative({
  points,
  halts,
  multiRoutes,
  plannedStops,
  quickSalePoints,
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
  const normalizedQuickSalePoints = useMemo(
    () =>
      (quickSalePoints || []).filter(
        (point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
      ),
    [quickSalePoints]
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
  const nearbyPulse = useRef(new Animated.Value(0)).current;
  const [selectedPlannedStopId, setSelectedPlannedStopId] = useState<string | null>(null);
  const [selectedQuickSaleId, setSelectedQuickSaleId] = useState<string | null>(null);
  const [isInsightModalVisible, setInsightModalVisible] = useState(false);

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
        ...normalizedQuickSalePoints.map((point) => ({
          latitude: point.latitude,
          longitude: point.longitude,
        })),
      ];
    }
    return [
      ...coords,
      ...normalizedPlannedStops.map((stop) => ({
        latitude: stop.latitude,
        longitude: stop.longitude,
      })),
      ...normalizedQuickSalePoints.map((point) => ({
        latitude: point.latitude,
        longitude: point.longitude,
      })),
    ];
  }, [coords, hasMultiRoutes, normalizedMultiRoutes, normalizedPlannedStops, normalizedQuickSalePoints]);

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
    ? flattenedMultiRoutePoints.length > 0 ||
      normalizedPlannedStops.length > 0 ||
      normalizedQuickSalePoints.length > 0
    : points.length > 0 ||
      normalizedPlannedStops.length > 0 ||
      normalizedQuickSalePoints.length > 0;
  const panelPoints = hasMultiRoutes ? flattenedMultiRoutePoints : points;
  const panelHalts = hasMultiRoutes ? [] : halts;
  const nearbyStops = useMemo(
    () => normalizedPlannedStops.filter((stop) => stop.isNearby),
    [normalizedPlannedStops]
  );
  const nearbyQuickSales = useMemo(
    () => normalizedQuickSalePoints.filter((point) => point.isNearby),
    [normalizedQuickSalePoints]
  );
  const selectedPlannedStop = useMemo(
    () => normalizedPlannedStops.find((stop) => stop.id === selectedPlannedStopId) ?? null,
    [normalizedPlannedStops, selectedPlannedStopId]
  );
  const selectedQuickSale = useMemo(
    () => normalizedQuickSalePoints.find((point) => point.id === selectedQuickSaleId) ?? null,
    [normalizedQuickSalePoints, selectedQuickSaleId]
  );
  const cardQuickSale = selectedQuickSale;
  const cardPlannedStop = selectedPlannedStop;

  const selectPlannedStop = (stopId: string, openModal = false) => {
    setSelectedPlannedStopId(stopId);
    setSelectedQuickSaleId(null);
    if (openModal) {
      setInsightModalVisible(true);
    }
  };
  const selectQuickSale = (quickSaleId: string, openModal = false) => {
    setSelectedQuickSaleId(quickSaleId);
    setSelectedPlannedStopId(null);
    if (openModal) {
      setInsightModalVisible(true);
    }
  };
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
    const markers: WebMapMarkerPayload[] = [];
    if (hasMultiRoutes) {
      for (const route of multiRouteDefs) {
        if (route.endPoint) {
          markers.push({
            id: `${route.id}_end`,
            kind: "route",
            lat: route.endPoint.latitude,
            lng: route.endPoint.longitude,
            color: route.color,
          });
        }
      }
    } else {
      if (startPoint) {
        markers.push({
          id: "route_start",
          kind: "route",
          lat: startPoint.latitude,
          lng: startPoint.longitude,
          color: colors.success,
          label: "S",
        });
      }
      if (endPoint) {
        markers.push({
          id: "route_end",
          kind: "route",
          lat: endPoint.latitude,
          lng: endPoint.longitude,
          color: colors.danger,
          label: "E",
        });
      }
      for (const halt of halts) {
        markers.push({
          id: halt.id,
          kind: "route",
          lat: halt.latitude,
          lng: halt.longitude,
          color: "#F59E0B",
          label: "H",
        });
      }
    }
    for (const stop of normalizedPlannedStops) {
      const historyPulseOnly = isHistoryPulseOnly(stop);
      markers.push({
        id: stop.id,
        kind: "planned_stop",
        lat: stop.latitude,
        lng: stop.longitude,
        renderMode: historyPulseOnly ? "pulse_only" : "standard",
        color:
          historyPulseOnly
            ? getHistoricalVisitAccent(colors)
            : stop.isNearby && stop.markerKind !== "visit_history"
            ? getNearbyStopAccent(colors)
            : resolvePlannedStopColor(stop, colors),
        label: historyPulseOnly ? "" : stop.isNearby ? "!" : "P",
        title: stop.customerName || stop.label,
        summary: stop.summary,
        detail: stop.detail,
        isNearby: Boolean(stop.isNearby),
        distanceMeters: stop.distanceMeters ?? null,
      });
    }
    for (const quickSale of normalizedQuickSalePoints) {
      markers.push({
        id: quickSale.id,
        kind: "quick_sale",
        lat: quickSale.latitude,
        lng: quickSale.longitude,
        color: quickSale.isNearby ? getQuickSaleAccent(colors) : `${getQuickSaleAccent(colors)}CC`,
        label: quickSale.isNearby ? "$" : "Q",
        title: quickSale.customerName,
        summary: `Order #${quickSale.orderId} · ${quickSale.itemCount} items · INR ${Math.round(
          quickSale.totalAmount
        )}`,
        detail: quickSale.customerAddress || quickSale.customerEmail || null,
        isNearby: Boolean(quickSale.isNearby),
        distanceMeters: quickSale.distanceMeters ?? null,
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
    normalizedQuickSalePoints,
    startPoint,
  ]);

  useEffect(() => {
    if (selectedPlannedStopId && !normalizedPlannedStops.some((stop) => stop.id === selectedPlannedStopId)) {
      setSelectedPlannedStopId(null);
    }
  }, [normalizedPlannedStops, selectedPlannedStopId]);

  useEffect(() => {
    if (
      selectedQuickSaleId &&
      !normalizedQuickSalePoints.some((point) => point.id === selectedQuickSaleId)
    ) {
      setSelectedQuickSaleId(null);
    }
  }, [normalizedQuickSalePoints, selectedQuickSaleId]);

  useEffect(() => {
    if (isInsightModalVisible && !selectedPlannedStop && !selectedQuickSale) {
      setInsightModalVisible(false);
    }
  }, [isInsightModalVisible, selectedPlannedStop, selectedQuickSale]);

  useEffect(() => {
    if (!nearbyStops.length) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(nearbyPulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(nearbyPulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
      nearbyPulse.stopAnimation();
      nearbyPulse.setValue(0);
    };
  }, [nearbyPulse, nearbyQuickSales.length, nearbyStops.length]);

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

  const nearbyPulseOuterStyle = useMemo(
    () => ({
      transform: [
        {
          scale: nearbyPulse.interpolate({
            inputRange: [0, 1],
            outputRange: [0.9, 1.8],
          }),
        },
      ],
      opacity: nearbyPulse.interpolate({
        inputRange: [0, 1],
        outputRange: [0.34, 0],
      }),
    }),
    [nearbyPulse]
  );

  const renderPlannedStopMarker = (stop: PlannedStopPoint) => {
    const historyPulseOnly = isHistoryPulseOnly(stop);
    const pulseColor = historyPulseOnly ? getHistoricalVisitAccent(colors) : getNearbyStopAccent(colors);

    return (
      <Pressable
        collapsable={false}
        onPress={() => selectPlannedStop(stop.id, false)}
        style={styles.markerTouchArea}
      >
        {stop.isNearby ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.nearbyPulseRing,
              { backgroundColor: pulseColor },
              nearbyPulseOuterStyle,
            ]}
          />
        ) : null}
        {historyPulseOnly ? null : (
          <View
            style={[
              styles.pinWrap,
              {
                backgroundColor: stop.isNearby
                  ? getNearbyStopAccent(colors)
                  : resolvePlannedStopColor(stop, colors),
              },
              stop.isNearby ? styles.pinWrapNearby : null,
            ]}
          >
            <Text style={styles.pinText}>{stop.isNearby ? "!" : "P"}</Text>
          </View>
        )}
      </Pressable>
    );
  };

  const handleWebMapMessage = useMemo(
    () => (event: { nativeEvent?: { data?: string } }) => {
      const raw = event.nativeEvent?.data;
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { type?: string; stopId?: string; quickSaleId?: string };
        if (parsed.type === "planned_stop_press" && parsed.stopId) {
          selectPlannedStop(parsed.stopId, false);
        }
        if (parsed.type === "quick_sale_press" && parsed.quickSaleId) {
          selectQuickSale(parsed.quickSaleId, false);
        }
      } catch {
        // ignore malformed web map events
      }
    },
    []
  );

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

  const selectedInsightCard = cardQuickSale ?? cardPlannedStop;
  const selectedInsightAccent = cardQuickSale
    ? getQuickSaleAccent(colors)
    : cardPlannedStop?.markerKind === "visit_history"
      ? getHistoricalVisitAccent(colors)
      : getNearbyStopAccent(colors);
  const selectedInsightEyebrow = cardQuickSale
    ? "QUICK SALE"
    : cardPlannedStop?.markerKind === "visit_history"
      ? "VISIT HISTORY"
      : "NEARBY CUSTOMER";
  const insightDetailText = cardQuickSale
    ? getQuickSaleDetail(cardQuickSale)
    : cardPlannedStop
      ? getPlannedStopDetail(cardPlannedStop)
      : null;

  const nearbyInfoCard = selectedInsightCard ? (
    <Pressable
      pointerEvents="box-none"
      onPress={() => {
        if (selectedQuickSale || selectedPlannedStop) {
          setInsightModalVisible(true);
        }
      }}
      style={[
        styles.nearbyCard,
        {
          borderColor: colors.border,
          backgroundColor: colors.backgroundElevated,
          shadowColor: colors.cardShadow,
        },
      ]}
    >
      <View style={styles.nearbyCardTopRow}>
        <View style={styles.nearbyCardTextWrap}>
          <Text style={[styles.nearbyEyebrow, { color: selectedInsightAccent, fontFamily: "Inter_700Bold" }]}>
            {selectedInsightEyebrow}
          </Text>
          <Text style={[styles.nearbyTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            {cardQuickSale ? cardQuickSale.customerName : cardPlannedStop ? getPlannedStopTitle(cardPlannedStop) : ""}
          </Text>
        </View>
        <View style={[styles.nearbyDistancePill, { backgroundColor: `${selectedInsightAccent}18` }]}>
          <Text
            style={[
              styles.nearbyDistanceText,
              { color: selectedInsightAccent, fontFamily: "Inter_700Bold" },
            ]}
          >
            {selectedInsightCard.distanceMeters ? `${selectedInsightCard.distanceMeters} m` : "Nearby"}
          </Text>
        </View>
      </View>
      {cardQuickSale ? (
        <Text style={[styles.nearbySummary, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
          Order #{selectedQuickSale.orderId} · {selectedQuickSale.itemCount} items · INR{" "}
          {Math.round(selectedQuickSale.totalAmount)}
        </Text>
      ) : null}
      {selectedInsightCard.summary ? (
        <Text style={[styles.nearbySummary, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
          {selectedInsightCard.summary}
        </Text>
      ) : null}
      {selectedInsightCard.detail ? (
        <Text style={[styles.nearbyDetail, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
          {selectedInsightCard.detail}
        </Text>
      ) : null}
    </Pressable>
  ) : null;

  const closeInsightModal = () => {
    setInsightModalVisible(false);
  };

  const insightModal = (selectedPlannedStop || selectedQuickSale) ? (
    <Modal
      transparent
      animationType="fade"
      visible={isInsightModalVisible}
      onRequestClose={closeInsightModal}
    >
      <Pressable style={[styles.detailOverlay, { backgroundColor: colors.overlay }]} onPress={closeInsightModal}>
        <Pressable
          onPress={() => {}}
          style={[
            styles.detailCard,
            {
              backgroundColor: colors.backgroundElevated,
              borderColor: colors.border,
              shadowColor: colors.cardShadow,
            },
          ]}
        >
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.detailScrollContent}>
            <View style={styles.detailHeader}>
              <View style={styles.detailHeaderText}>
                <Text
                  style={[
                    styles.detailEyebrow,
                    {
                      color: selectedQuickSale
                        ? getQuickSaleAccent(colors)
                        : selectedPlannedStop?.markerKind === "visit_history"
                          ? getHistoricalVisitAccent(colors)
                          : getNearbyStopAccent(colors),
                      fontFamily: "Inter_700Bold",
                    },
                  ]}
                >
                  {selectedQuickSale
                    ? "QUICK SALE"
                    : selectedPlannedStop?.markerKind === "visit_history"
                      ? "VISIT HISTORY"
                      : "PLANNED VISIT"}
                </Text>
                <Text style={[styles.detailTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  {selectedQuickSale
                    ? selectedQuickSale.customerName
                    : selectedPlannedStop
                      ? getPlannedStopTitle(selectedPlannedStop)
                      : ""}
                </Text>
              </View>
              <Pressable onPress={closeInsightModal} style={styles.detailCloseButton}>
                <Text style={[styles.detailCloseText, { color: colors.textSecondary, fontFamily: "Inter_700Bold" }]}>
                  Close
                </Text>
              </Pressable>
            </View>

            {selectedQuickSale ? (
              <>
                <Text style={[styles.detailSummary, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  {getQuickSaleSummary(selectedQuickSale)}
                </Text>
                <View style={styles.detailMetaList}>
                  <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                    Sold at: {formatMumbaiTime(selectedQuickSale.soldAt)}
                  </Text>
                  {selectedQuickSale.customerAddress ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Address: {selectedQuickSale.customerAddress}
                    </Text>
                  ) : null}
                  {selectedQuickSale.customerEmail ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Email: {selectedQuickSale.customerEmail}
                    </Text>
                  ) : null}
                  {selectedQuickSale.visitLabel ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Visit: {selectedQuickSale.visitLabel}
                    </Text>
                  ) : null}
                  {selectedQuickSale.visitDepartedAt ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Departed: {formatMumbaiTime(selectedQuickSale.visitDepartedAt)}
                    </Text>
                  ) : null}
                  {selectedQuickSale.visitDepartureNotes ? (
                    <View style={[styles.detailNoteBox, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                      <Text style={[styles.detailNoteLabel, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                        Visit Notes
                      </Text>
                      <Text style={[styles.detailNoteText, { color: colors.text, fontFamily: "Inter_400Regular" }]}>
                        {selectedQuickSale.visitDepartureNotes}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </>
            ) : selectedPlannedStop ? (
              <>
                {getPlannedStopSummary(selectedPlannedStop) ? (
                  <Text style={[styles.detailSummary, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    {getPlannedStopSummary(selectedPlannedStop)}
                  </Text>
                ) : null}
                {getPlannedStopDetail(selectedPlannedStop) ? (
                  <Text style={[styles.detailBody, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                    {getPlannedStopDetail(selectedPlannedStop)}
                  </Text>
                ) : null}
                <View style={styles.detailMetaList}>
                  {typeof selectedPlannedStop.distanceMeters === "number" ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Distance: {selectedPlannedStop.distanceMeters} m
                    </Text>
                  ) : null}
                  {selectedPlannedStop.status ? (
                    <Text style={[styles.detailMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      Status: {selectedPlannedStop.status.replace("_", " ")}
                    </Text>
                  ) : null}
                </View>
              </>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null;

  const renderMapWithFooter = (mapNode: React.ReactNode) => (
    <View style={styles.mapBlock}>
      {mapNode}
      {nearbyInfoCard}
      {insightModal}
    </View>
  );

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

      return renderMapWithFooter(
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
                onSelected={() => selectPlannedStop(stop.id, false)}
              >
                {renderPlannedStopMarker(stop)}
              </MapplsGL.PointAnnotation>
            ))}
            {normalizedQuickSalePoints.map((sale) => (
              <MapplsGL.PointAnnotation
                key={`quick_sale_${sale.id}`}
                id={`quick_sale_${sale.id}`}
                coordinate={[sale.longitude, sale.latitude]}
                onSelected={() => {
                  selectQuickSale(sale.id, false);
                }}
              >
                <Pressable
                  collapsable={false}
                  onPress={() => {
                    selectQuickSale(sale.id, false);
                  }}
                  style={styles.markerTouchArea}
                >
                  {sale.isNearby ? (
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.nearbyPulseRing,
                        { backgroundColor: getQuickSaleAccent(colors) },
                        nearbyPulseOuterStyle,
                      ]}
                    />
                  ) : null}
                  <View
                    style={[
                      styles.pinWrap,
                      { backgroundColor: getQuickSaleAccent(colors) },
                      sale.isNearby ? styles.pinWrapNearby : null,
                    ]}
                  >
                    <Text style={styles.pinText}>{sale.isNearby ? "$" : "Q"}</Text>
                  </View>
                </Pressable>
              </MapplsGL.PointAnnotation>
            ))}
          </MapplsGL.MapView>
        </View>
      );
    }

    const centerCoordinate: [number, number] = [region.longitude, region.latitude];

    if (hasMultiRoutes) {
      return renderMapWithFooter(
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
                onSelected={() => selectPlannedStop(stop.id, false)}
              >
                {renderPlannedStopMarker(stop)}
              </MapplsGL.PointAnnotation>
            ))}
            {normalizedQuickSalePoints.map((sale) => (
              <MapplsGL.PointAnnotation
                key={`quick_sale_${sale.id}`}
                id={`quick_sale_${sale.id}`}
                coordinate={[sale.longitude, sale.latitude]}
                onSelected={() => {
                  selectQuickSale(sale.id, false);
                }}
              >
                <Pressable
                  collapsable={false}
                  onPress={() => {
                    selectQuickSale(sale.id, false);
                  }}
                  style={styles.markerTouchArea}
                >
                  {sale.isNearby ? (
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.nearbyPulseRing,
                        { backgroundColor: getQuickSaleAccent(colors) },
                        nearbyPulseOuterStyle,
                      ]}
                    />
                  ) : null}
                  <View
                    style={[
                      styles.pinWrap,
                      { backgroundColor: getQuickSaleAccent(colors) },
                      sale.isNearby ? styles.pinWrapNearby : null,
                    ]}
                  >
                    <Text style={styles.pinText}>{sale.isNearby ? "$" : "Q"}</Text>
                  </View>
                </Pressable>
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

    return renderMapWithFooter(
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
              onSelected={() => selectPlannedStop(stop.id, false)}
            >
              {renderPlannedStopMarker(stop)}
            </MapplsGL.PointAnnotation>
          ))}
          {normalizedQuickSalePoints.map((sale) => (
            <MapplsGL.PointAnnotation
              key={`quick_sale_${sale.id}`}
              id={`quick_sale_${sale.id}`}
              coordinate={[sale.longitude, sale.latitude]}
              onSelected={() => {
                selectQuickSale(sale.id, false);
              }}
            >
              <Pressable
                onPress={() => {
                  selectQuickSale(sale.id, false);
                }}
                style={styles.markerTouchArea}
              >
                {sale.isNearby ? (
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.nearbyPulseRing,
                      { backgroundColor: getQuickSaleAccent(colors) },
                      nearbyPulseOuterStyle,
                    ]}
                  />
                ) : null}
                <View
                  style={[
                    styles.pinWrap,
                    { backgroundColor: getQuickSaleAccent(colors) },
                    sale.isNearby ? styles.pinWrapNearby : null,
                  ]}
                >
                  <Text style={styles.pinText}>{sale.isNearby ? "$" : "Q"}</Text>
                </View>
              </Pressable>
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

    return renderMapWithFooter(
      <View style={[styles.container, { height, borderColor: colors.border }]}> 
        <WebView
          originWhitelist={["*"]}
          source={{ html: mapHtml }}
          style={StyleSheet.absoluteFill}
          scrollEnabled
          nestedScrollEnabled
          javaScriptEnabled
          domStorageEnabled
          onMessage={handleWebMapMessage}
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

  return renderMapWithFooter(
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
                    stop.summary
                      ? `${stop.summary}${stop.detail ? ` · ${stop.detail}` : ""}`
                      : stop.status === "completed"
                        ? "Completed"
                        : stop.status === "in_progress"
                          ? "In progress"
                          : "Pending"
                  }
                  onPress={() => selectPlannedStop(stop.id, false)}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  {renderPlannedStopMarker(stop)}
                </Marker>
              ))}
              {normalizedQuickSalePoints.map((sale) => (
                <Marker
                  key={`quick_sale_${sale.id}`}
                  coordinate={{ latitude: sale.latitude, longitude: sale.longitude }}
                  title={`Quick Sale: ${sale.customerName}`}
                  description={`Order #${sale.orderId} · ${sale.itemCount} items · INR ${Math.round(
                    sale.totalAmount
                  )}${sale.customerAddress ? ` · ${sale.customerAddress}` : ""}`}
                  onPress={() => {
                    selectQuickSale(sale.id, false);
                  }}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <Pressable
                    collapsable={false}
                    onPress={() => {
                      selectQuickSale(sale.id, false);
                    }}
                    style={styles.markerTouchArea}
                  >
                    {sale.isNearby ? (
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          styles.nearbyPulseRing,
                          { backgroundColor: getQuickSaleAccent(colors) },
                          nearbyPulseOuterStyle,
                        ]}
                      />
                    ) : null}
                    <View
                      style={[
                        styles.pinWrap,
                        { backgroundColor: getQuickSaleAccent(colors) },
                        sale.isNearby ? styles.pinWrapNearby : null,
                      ]}
                    >
                      <Text style={styles.pinText}>{sale.isNearby ? "$" : "Q"}</Text>
                    </View>
                  </Pressable>
                </Marker>
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
                  stop.summary
                    ? `${stop.summary}${stop.detail ? ` · ${stop.detail}` : ""}`
                    : stop.status === "completed"
                      ? "Completed"
                      : stop.status === "in_progress"
                        ? "In progress"
                        : "Pending"
                }
                onPress={() => selectPlannedStop(stop.id, false)}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                {renderPlannedStopMarker(stop)}
              </Marker>
            ))
          : null}
        {hasMultiRoutes
          ? normalizedQuickSalePoints.map((sale) => (
              <Marker
                key={`quick_sale_${sale.id}`}
                coordinate={{ latitude: sale.latitude, longitude: sale.longitude }}
                title={`Quick Sale: ${sale.customerName}`}
                description={`Order #${sale.orderId} · ${sale.itemCount} items · INR ${Math.round(
                  sale.totalAmount
                )}${sale.customerAddress ? ` · ${sale.customerAddress}` : ""}`}
                onPress={() => {
                  selectQuickSale(sale.id, false);
                }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <Pressable
                  collapsable={false}
                  onPress={() => {
                    selectQuickSale(sale.id, false);
                  }}
                  style={styles.markerTouchArea}
                >
                  {sale.isNearby ? (
                    <Animated.View
                      pointerEvents="none"
                      style={[
                        styles.nearbyPulseRing,
                        { backgroundColor: getQuickSaleAccent(colors) },
                        nearbyPulseOuterStyle,
                      ]}
                    />
                  ) : null}
                  <View
                    style={[
                      styles.pinWrap,
                      { backgroundColor: getQuickSaleAccent(colors) },
                      sale.isNearby ? styles.pinWrapNearby : null,
                    ]}
                  >
                    <Text style={styles.pinText}>{sale.isNearby ? "$" : "Q"}</Text>
                  </View>
                </Pressable>
              </Marker>
            ))
          : null}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  mapBlock: {
    gap: 10,
  },
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
  markerTouchArea: {
    width: 44,
    height: 44,
    position: "relative",
    overflow: "visible",
    alignItems: "center",
    justifyContent: "center",
  },
  nearbyPulseRing: {
    position: "absolute",
    left: 5,
    top: 5,
    width: 34,
    height: 34,
    borderRadius: 999,
  },
  pinWrap: {
    position: "absolute",
    left: 11,
    top: 11,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
  pinWrapNearby: {
    left: 10,
    top: 10,
    width: 24,
    height: 24,
    borderRadius: 12,
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
  nearbyCard: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
    gap: 4,
  },
  nearbyCardTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  nearbyCardTextWrap: {
    flex: 1,
    gap: 3,
  },
  nearbyEyebrow: {
    fontSize: 10,
    letterSpacing: 0.9,
  },
  nearbyTitle: {
    fontSize: 15,
    lineHeight: 19,
  },
  nearbyDistancePill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  nearbyDistanceText: {
    fontSize: 11,
  },
  nearbySummary: {
    fontSize: 12,
    lineHeight: 17,
  },
  nearbyDetail: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  detailOverlay: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  detailCard: {
    borderWidth: 1,
    borderRadius: 22,
    maxHeight: "76%",
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  detailScrollContent: {
    padding: 18,
    gap: 14,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailHeaderText: {
    flex: 1,
    gap: 4,
  },
  detailEyebrow: {
    fontSize: 11,
    letterSpacing: 0.8,
  },
  detailTitle: {
    fontSize: 20,
    lineHeight: 24,
  },
  detailCloseButton: {
    paddingVertical: 6,
  },
  detailCloseText: {
    fontSize: 12,
  },
  detailSummary: {
    fontSize: 13,
    lineHeight: 19,
  },
  detailBody: {
    fontSize: 12.5,
    lineHeight: 19,
  },
  detailMetaList: {
    gap: 8,
  },
  detailMetaText: {
    fontSize: 12,
    lineHeight: 18,
  },
  detailNoteBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 6,
  },
  detailNoteLabel: {
    fontSize: 12,
  },
  detailNoteText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
});
