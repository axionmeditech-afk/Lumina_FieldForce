import React from "react";
import { ActivityIndicator, Image, Text, View } from "react-native";
import { useAppTheme } from "@/contexts/ThemeContext";
export function StartScreen({ title = "Lumina FieldForce", subtitle = "Loading your attendance workspace", hint = "" }: { title?: string; subtitle?: string; hint?: string }) {
  const { colors } = useAppTheme();
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 18, backgroundColor: colors.background }}>
    <Image source={require("../assets/images/logo.png")} style={{ width: 90, height: 90 }} resizeMode="contain" />
    <Text style={{ color: colors.text, fontSize: 24, fontWeight: "700" }}>{title}</Text>
    <Text style={{ color: colors.textSecondary }}>{subtitle}</Text>
    <ActivityIndicator color={colors.primary} />
    {!!hint && <Text style={{ color: colors.textSecondary }}>{hint}</Text>}
  </View>;
}
