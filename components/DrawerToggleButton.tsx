import React from "react";
import { Pressable, StyleSheet, useWindowDimensions, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { DrawerActions } from "@react-navigation/native";
import { useNavigation } from "expo-router";
import { useAppTheme } from "@/contexts/ThemeContext";

type DrawerToggleButtonProps = {
  style?: ViewStyle;
  showOnLargeScreens?: boolean;
};

export function DrawerToggleButton({
  style,
  showOnLargeScreens = false,
}: DrawerToggleButtonProps) {
  const navigation = useNavigation();
  const { colors, isDark } = useAppTheme();
  const { width } = useWindowDimensions();

  if (!showOnLargeScreens && width >= 1024) {
    return null;
  }

  return (
    <Pressable
      onPress={() => navigation.dispatch(DrawerActions.toggleDrawer())}
      accessibilityRole="button"
      accessibilityLabel="Toggle navigation menu"
      hitSlop={8}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isDark ? "rgba(16, 24, 39, 0.78)" : "rgba(255, 255, 255, 0.88)",
          borderColor: colors.border,
          opacity: pressed ? 0.84 : 1,
        },
        style,
      ]}
    >
      <Ionicons name="menu" size={20} color={colors.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
