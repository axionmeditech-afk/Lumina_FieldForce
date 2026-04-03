import React from "react";
import { Pressable, StyleSheet, useWindowDimensions, type ViewStyle } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
// eslint-disable-next-line import/no-unresolved
import PanelLeftCloseIcon from "@hugeicons/core-free-icons/PanelLeftCloseIcon";
import { DrawerActions } from "@react-navigation/native";
import { useNavigation } from "expo-router";
import { useAppTheme } from "@/contexts/ThemeContext";

type DrawerToggleButtonProps = {
  style?: ViewStyle;
  showOnLargeScreens?: boolean;
  iconColor?: string;
  iconSize?: number;
};

export function DrawerToggleButton({
  style,
  showOnLargeScreens = false,
  iconColor,
  iconSize = 28,
}: DrawerToggleButtonProps) {
  const navigation = useNavigation();
  const { colors } = useAppTheme();
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
          opacity: pressed ? 0.72 : 1,
        },
        style,
      ]}
    >
      <HugeiconsIcon
        icon={PanelLeftCloseIcon}
        size={iconSize}
        color={iconColor ?? colors.text}
        strokeWidth={1.7}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
});
