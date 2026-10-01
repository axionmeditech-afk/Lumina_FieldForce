import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";

export interface GeofenceMapPoint {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  summary?: string | null;
  detail?: string | null;
}

type GeofenceMapColors = {
  primary?: string;
  text?: string;
  textSecondary?: string;
  surface?: string;
  surfaceSecondary?: string;
  border?: string;
};

function isValidCoordinate(point: GeofenceMapPoint | null | undefined): point is GeofenceMapPoint {
  return (
    Boolean(point) &&
    typeof point?.latitude === "number" &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === "number" &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}

function getColors(colors?: unknown): Required<GeofenceMapColors> {
  const palette = (colors && typeof colors === "object" ? colors : {}) as GeofenceMapColors;
  return {
    primary: palette.primary || "#2563EB",
    text: palette.text || "#0F172A",
    textSecondary: palette.textSecondary || "#64748B",
    surface: palette.surface || "#FFFFFF",
    surfaceSecondary: palette.surfaceSecondary || "#F1F5F9",
    border: palette.border || "#D9E2EF",
  };
}

export function GeofenceMap({
  points,
  height = 220,
  colors,
}: {
  points: GeofenceMapPoint[];
  colors?: unknown;
  height?: number;
}) {
  const palette = getColors(colors);
  const safePoints = Array.isArray(points) ? points.filter(isValidCoordinate) : [];
  const office = safePoints[0];

  if (!office) {
    return (
      <View style={[styles.fallback, { minHeight: height, backgroundColor: palette.surfaceSecondary }]}> 
        <Ionicons name="map-outline" size={28} color={palette.primary} />
        <Text style={[styles.title, { color: palette.text }]}>Office location preview</Text>
        <Text style={[styles.subtitle, { color: palette.textSecondary }]}>Select a valid office GPS location to preview the zone.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { minHeight: height, backgroundColor: palette.surface, borderColor: palette.border }]}> 
      <View style={[styles.compass, { backgroundColor: `${palette.primary}14`, borderColor: `${palette.primary}2E` }]}> 
        <Ionicons name="navigate-circle" size={42} color={palette.primary} />
      </View>
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>{office.label || "Office geofence"}</Text>
      {office.summary ? <Text style={[styles.subtitle, { color: palette.textSecondary }]} numberOfLines={2}>{office.summary}</Text> : null}
      <View style={[styles.coordBox, { backgroundColor: palette.surfaceSecondary, borderColor: palette.border }]}> 
        <View style={styles.coordRow}>
          <Text style={[styles.coordLabel, { color: palette.textSecondary }]}>Latitude</Text>
          <Text style={[styles.coordValue, { color: palette.text }]}>{office.latitude.toFixed(6)}</Text>
        </View>
        <View style={styles.coordRow}>
          <Text style={[styles.coordLabel, { color: palette.textSecondary }]}>Longitude</Text>
          <Text style={[styles.coordValue, { color: palette.text }]}>{office.longitude.toFixed(6)}</Text>
        </View>
        <View style={styles.coordRow}>
          <Text style={[styles.coordLabel, { color: palette.textSecondary }]}>Attendance radius</Text>
          <Text style={[styles.coordValue, { color: palette.text }]}>500 m</Text>
        </View>
      </View>
      <Text style={[styles.hint, { color: palette.textSecondary }]}>Native map preview is disabled in release builds to keep attendance stable on every device.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    borderWidth: 1,
    gap: 10,
  },
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    gap: 8,
  },
  compass: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    textAlign: "center",
  },
  coordBox: {
    alignSelf: "stretch",
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  coordRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  coordLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  coordValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
  },
  hint: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
    textAlign: "center",
  },
});
