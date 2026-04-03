import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { usePathname } from "expo-router";
import Svg, { Path } from "react-native-svg";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useAppTheme } from "@/contexts/ThemeContext";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const TRANSITION_DURATION_MS = 760;
const COVER_STAGE_END = 0.42;

export function PageTransitionOverlay() {
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const { isDark } = useAppTheme();
  const progress = useSharedValue(0);
  const mountedRef = useRef(false);
  const [visible, setVisible] = useState(false);

  const overlayColor = useMemo(() => {
    return isDark ? "#020817" : "#0F172A";
  }, [isDark]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    setVisible(true);
    cancelAnimation(progress);
    progress.value = 0;
    progress.value = withTiming(
      1,
      {
        duration: TRANSITION_DURATION_MS,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
      },
      (finished) => {
        if (finished) {
          runOnJS(setVisible)(false);
        }
      }
    );
  }, [pathname, progress]);

  const animatedProps = useAnimatedProps(() => {
    const p = Math.max(0, Math.min(1, progress.value));
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const midX = w / 2;

    if (p <= COVER_STAGE_END) {
      const t = p / COVER_STAGE_END;
      const edgeY = h * t;
      const curveDepth = h * (0.28 + (1 - t) * 0.1);
      const controlY = edgeY + curveDepth;
      return {
        d: `M 0 0 V ${edgeY} Q ${midX} ${controlY} ${w} ${edgeY} V 0 Z`,
      };
    }

    const t = (p - COVER_STAGE_END) / (1 - COVER_STAGE_END);
    const edgeY = h * t;
    const curveLift = h * (0.22 * (1 - t));
    const controlY = edgeY - curveLift;
    return {
      d: `M 0 ${h} V ${edgeY} Q ${midX} ${controlY} ${w} ${edgeY} V ${h} Z`,
    };
  });

  if (!visible || width <= 0 || height <= 0) {
    return null;
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={styles.overlay}>
        <AnimatedPath animatedProps={animatedProps} fill={overlayColor} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
});
