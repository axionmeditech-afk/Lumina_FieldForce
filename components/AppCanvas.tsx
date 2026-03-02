import React, { type ReactNode } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useAppTheme } from "@/contexts/ThemeContext";

interface AppCanvasProps {
  children: ReactNode;
  style?: ViewStyle;
}

export function AppCanvas({ children, style }: AppCanvasProps) {
  const { colors, isDark } = useAppTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }, style]}>
      <LinearGradient
        colors={
          isDark
            ? [colors.backgroundTint, colors.background, colors.background]
            : [colors.backgroundTint, colors.background, colors.backgroundElevated]
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.decorationLayer} pointerEvents="none">
        <View style={[styles.orb, styles.orbPrimary, { backgroundColor: `${colors.primary}28` }]} />
        <View style={[styles.orb, styles.orbAccent, { backgroundColor: `${colors.secondary}24` }]} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  decorationLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  orb: {
    position: "absolute",
    width: 240,
    height: 240,
    borderRadius: 999,
  },
  orbPrimary: {
    top: -120,
    right: -60,
  },
  orbAccent: {
    bottom: -130,
    left: -80,
  },
});
