import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Polyline, Text as SvgText } from "react-native-svg";
import type { LocationLog, RouteHalt } from "@/lib/types";
import type Colors from "@/constants/colors";

interface RouteMapPanelProps {
  points: LocationLog[];
  halts: RouteHalt[];
  colors: typeof Colors.light;
  height?: number;
}

interface PlotPoint {
  x: number;
  y: number;
}

const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 520;
const PADDING = 58;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeBounds(points: LocationLog[]): {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
} {
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLng = Math.min(minLng, point.longitude);
    maxLng = Math.max(maxLng, point.longitude);
  }

  if (!Number.isFinite(minLat) || !Number.isFinite(maxLat)) {
    return { minLat: 0, maxLat: 1, minLng: 0, maxLng: 1 };
  }

  if (minLat === maxLat) {
    minLat -= 0.002;
    maxLat += 0.002;
  }
  if (minLng === maxLng) {
    minLng -= 0.002;
    maxLng += 0.002;
  }

  return { minLat, maxLat, minLng, maxLng };
}

function toPlotPoint(
  latitude: number,
  longitude: number,
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }
): PlotPoint {
  const latRange = Math.max(0.000001, bounds.maxLat - bounds.minLat);
  const lngRange = Math.max(0.000001, bounds.maxLng - bounds.minLng);
  const normalizedX = (longitude - bounds.minLng) / lngRange;
  const normalizedY = (latitude - bounds.minLat) / latRange;
  const x = PADDING + normalizedX * (VIEWBOX_WIDTH - PADDING * 2);
  const y = VIEWBOX_HEIGHT - PADDING - normalizedY * (VIEWBOX_HEIGHT - PADDING * 2);
  return {
    x: clamp(x, PADDING, VIEWBOX_WIDTH - PADDING),
    y: clamp(y, PADDING, VIEWBOX_HEIGHT - PADDING),
  };
}

export function RouteMapPanel({ points, halts, colors, height = 240 }: RouteMapPanelProps) {
  const computed = useMemo(() => {
    if (!points.length) {
      return {
        polylinePath: "",
        plottedPoints: [] as (PlotPoint & { timestamp: string })[],
        plottedHalts: [] as (RouteHalt & PlotPoint)[],
      };
    }

    const bounds = computeBounds(points);
    const plottedPoints = points.map((point) => {
      const plot = toPlotPoint(point.latitude, point.longitude, bounds);
      return { ...plot, timestamp: point.capturedAt };
    });
    const polylinePath = plottedPoints.map((point) => `${point.x},${point.y}`).join(" ");
    const plottedHalts = halts.map((halt) => {
      const plot = toPlotPoint(halt.latitude, halt.longitude, bounds);
      return { ...halt, ...plot };
    });
    return { polylinePath, plottedPoints, plottedHalts };
  }, [halts, points]);

  if (!points.length) {
    return (
      <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
        <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
          No route points for selected day
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
          GPS points will appear here once background tracking syncs.
        </Text>
      </View>
    );
  }

  const startPoint = computed.plottedPoints[0];
  const endPoint = computed.plottedPoints[computed.plottedPoints.length - 1];

  return (
    <View style={[styles.container, { height, borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}>
        <Line
          x1={PADDING}
          y1={PADDING}
          x2={PADDING}
          y2={VIEWBOX_HEIGHT - PADDING}
          stroke={colors.borderLight}
          strokeWidth={1}
        />
        <Line
          x1={PADDING}
          y1={VIEWBOX_HEIGHT - PADDING}
          x2={VIEWBOX_WIDTH - PADDING}
          y2={VIEWBOX_HEIGHT - PADDING}
          stroke={colors.borderLight}
          strokeWidth={1}
        />

        <Polyline
          points={computed.polylinePath}
          stroke={colors.primary}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />

        {computed.plottedPoints.map((point, idx) => (
          <Circle
            key={`${point.timestamp}_${idx}`}
            cx={point.x}
            cy={point.y}
            r={idx % 8 === 0 ? 3 : 2}
            fill={idx % 8 === 0 ? colors.primary : `${colors.primary}99`}
          />
        ))}

        {startPoint ? <Circle cx={startPoint.x} cy={startPoint.y} r={8} fill={colors.success} /> : null}
        {endPoint ? <Circle cx={endPoint.x} cy={endPoint.y} r={8} fill={colors.danger} /> : null}

        {computed.plottedHalts.map((halt, idx) => (
          <React.Fragment key={halt.id}>
            <Circle cx={halt.x} cy={halt.y} r={9} fill="#F59E0B" />
            <SvgText
              x={halt.x + 12}
              y={halt.y - 10}
              fill={colors.text}
              fontSize={20}
              fontWeight="600"
            >
              H{idx + 1}
            </SvgText>
          </React.Fragment>
        ))}
      </Svg>
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
    minHeight: 220,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    gap: 6,
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
});
