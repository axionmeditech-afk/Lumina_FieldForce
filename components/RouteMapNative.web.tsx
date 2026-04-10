import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type Colors from "@/constants/colors";
import { RouteMapPanel } from "@/components/RouteMapPanel";
import type { LocationLog, RouteHalt, RoutePathPoint } from "@/lib/types";

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

function toRoutePointPath(path: RoutePathPoint[] | undefined): LocationLog[] {
  if (!Array.isArray(path) || path.length === 0) return [];
  const now = Date.now();
  return path.map((point, index) => ({
    id: `web_route_path_${index}`,
    userId: "web",
    latitude: point.latitude,
    longitude: point.longitude,
    isInsideGeofence: false,
    capturedAt: new Date(now + index * 1000).toISOString(),
  }));
}

export function RouteMapNative({
  points,
  halts,
  multiRoutes,
  routePath,
  plannedStops,
  quickSalePoints,
  mapMode = "tracking",
  colors,
  height = 240,
}: RouteMapNativeProps) {
  const panelPoints = useMemo(() => {
    if (Array.isArray(points) && points.length > 0) return points;

    const mergedRoutes = (multiRoutes || []).flatMap((route) => route.points || []);
    if (mergedRoutes.length > 0) return mergedRoutes;

    if (mapMode === "polyline") {
      return toRoutePointPath(routePath);
    }

    return toRoutePointPath(routePath);
  }, [mapMode, multiRoutes, points, routePath]);

  const plannedCount = plannedStops?.length ?? 0;
  const quickSaleCount = quickSalePoints?.length ?? 0;

  return (
    <View style={styles.container}>
      <RouteMapPanel points={panelPoints} halts={halts || []} colors={colors} height={height} />
      <View style={[styles.metaRow, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
        <Text style={[styles.metaText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
          Web preview map mode is enabled
        </Text>
        <Text style={[styles.metaText, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
          Stops {plannedCount} • Sales {quickSaleCount}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
  },
  metaRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  metaText: {
    fontSize: 11.5,
  },
});

