import React from "react";
import { Image, Text, View } from "react-native";
import { useAppTheme } from "@/contexts/ThemeContext";
export function StartScreen() {
  const { colors } = useAppTheme();
  return <View accessibilityLabel="Loading Lumina FieldForce" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, backgroundColor: colors.background }}>
    <Image source={require("../assets/images/logo.png")} style={{ width: 90, height: 90 }} resizeMode="contain" />
    <Text style={{ color: colors.text, fontSize: 24, fontWeight: "700" }}>Lumina FieldForce</Text>
  </View>;
}
