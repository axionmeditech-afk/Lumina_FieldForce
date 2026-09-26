import React from "react";
import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";

export default function AttendanceLayout() {
  const { user, isLoading } = useAuth();
  const { colors } = useAppTheme();
  if (isLoading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>;
  if (!user) return <Redirect href="/login" />;
  return <Drawer screenOptions={{ headerShown: false, drawerActiveTintColor: colors.primary,
    drawerStyle: { backgroundColor: colors.background }, drawerInactiveTintColor: colors.text }}>
    <Drawer.Screen name="index" options={{ drawerItemStyle: { display: "none" } }} />
    <Drawer.Screen name="attendance" options={{ title: "Attendance & Geofencing" }} />
    <Drawer.Screen name="account" options={{ title: "Account" }} />
    <Drawer.Screen name="employees" options={{ title: "Employee Access", drawerItemStyle: user.role === "admin" ? undefined : { display: "none" } }} />
  </Drawer>;
}
