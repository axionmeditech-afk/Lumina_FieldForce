
import { Pressable, StyleSheet, useWindowDimensions, type ViewStyle } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
// eslint-disable-next-line import/no-unresolved

import { DrawerActions } from "expo-router/react-navigation";
import { useNavigation } from "expo-router";
import { useAppTheme } from "@/contexts/ThemeContext";

type DrawerToggleButtonProps = {
  style?: ViewStyle;
  showOnLargeScreens?: boolean;
  iconColor?: string;
  iconSize?: number;
  disabled?: boolean;
  onBlockedPress?: () => void;
};

export function DrawerToggleButton({
  style,
  showOnLargeScreens = true,
  iconColor,
  iconSize = 28,
  disabled = false,
  onBlockedPress,
}: DrawerToggleButtonProps) {
  const navigation = useNavigation();
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();

  if (!showOnLargeScreens && width >= 1024) {
    return null;
  }

  return (
    <Pressable
      onPress={() => {
        if (disabled) {
          onBlockedPress?.();
          return;
        }
        navigation.dispatch(DrawerActions.toggleDrawer());
      }}
      accessibilityRole="button"
      accessibilityLabel="Toggle navigation menu"
      hitSlop={8}
      style={({ pressed }) => [
        styles.button,
        {
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
        },
        style,
      ]}
    >
      <Ionicons
        name="menu-outline"
        size={iconSize}
        color={iconColor ?? colors.text}
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
