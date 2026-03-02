import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";
import type { LiveMapPoint } from "@/lib/attendance-api";
import type { ThemePalette } from "@/constants/colors";

interface LiveMapPanelProps {
  points: LiveMapPoint[];
  colors: ThemePalette;
  onPointPress?: (point: LiveMapPoint) => void;
}

function projectPoint(
  latitude: number,
  longitude: number,
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): { x: number; y: number } {
  const latRange = Math.max(0.001, maxLat - minLat);
  const lngRange = Math.max(0.001, maxLng - minLng);
  const x = ((longitude - minLng) / lngRange) * 100;
  const y = 100 - ((latitude - minLat) / latRange) * 100;
  return { x, y };
}

export function LiveMapPanel({ points, colors, onPointPress }: LiveMapPanelProps) {
  const allLat = points.map((point) => point.latitude);
  const allLng = points.map((point) => point.longitude);
  const minLat = allLat.length ? Math.min(...allLat) - 0.02 : 0;
  const maxLat = allLat.length ? Math.max(...allLat) + 0.02 : 1;
  const minLng = allLng.length ? Math.min(...allLng) - 0.02 : 0;
  const maxLng = allLng.length ? Math.max(...allLng) + 0.02 : 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: colors.text }]}>Live Field Map</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{points.length} active</Text>
      </View>

      <View style={[styles.canvasShell, { borderColor: colors.borderLight }]}>
        <Svg width="100%" height="180" viewBox="0 0 100 100" preserveAspectRatio="none">
          <Rect x="0" y="0" width="100" height="100" fill={colors.surfaceSecondary} />
          {points.map((point) => {
            const p = projectPoint(point.latitude, point.longitude, minLat, maxLat, minLng, maxLng);
            return (
              <Circle
                key={point.id}
                cx={p.x}
                cy={p.y}
                r={2.5}
                fill={point.isInsideGeofence ? colors.success : colors.danger}
                stroke={colors.backgroundElevated}
                strokeWidth={0.8}
              />
            );
          })}
        </Svg>
      </View>

      <View style={styles.list}>
        {points.slice(0, 4).map((point) => (
          <Pressable
            key={`${point.userId}_${point.capturedAt}`}
            style={styles.item}
            onPress={() => onPointPress?.(point)}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: point.isInsideGeofence ? colors.success : colors.danger },
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.itemTitle, { color: colors.text }]}>{point.userId}</Text>
              <Text style={[styles.itemSub, { color: colors.textSecondary }]}>
                {point.geofenceName ?? "No zone"} • {new Date(point.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 10,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  subtitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  canvasShell: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  list: {
    gap: 8,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  itemTitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
  },
  itemSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
  },
});
