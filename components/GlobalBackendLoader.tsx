import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppTheme } from "@/contexts/ThemeContext";
import { getGlobalLoadingCount, subscribeGlobalLoading } from "@/lib/global-loading";

export function GlobalBackendLoader() {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [pendingCount, setPendingCount] = useState(() => getGlobalLoadingCount());
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeGlobalLoading(setPendingCount), []);

  useEffect(() => {
    if (pendingCount <= 0) {
      const timer = setTimeout(() => setVisible(false), 180);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setVisible(true), 650);
    return () => clearTimeout(timer);
  }, [pendingCount]);

  if (!visible) return null;

  return (
    <View pointerEvents="none" style={[styles.host, { top: insets.top + 10 }]}>
      <Animated.View
        entering={FadeInDown.duration(180)}
        exiting={FadeOutUp.duration(140)}
        style={[
          styles.pill,
          {
            backgroundColor: colors.backgroundElevated,
            borderColor: colors.border,
            shadowColor: "#000000",
          },
        ]}
      >
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={[styles.text, { color: colors.textSecondary }]}>Loading</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 9999,
    alignItems: "center",
  },
  pill: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 8,
  },
  text: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
});
