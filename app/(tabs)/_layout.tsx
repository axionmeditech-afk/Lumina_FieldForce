import React from "react";
import { ActivityIndicator, Text, View, useWindowDimensions } from "react-native";
import { Redirect } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { DrawerContentScrollView, DrawerItemList } from "expo-router/drawer";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";

export default function AttendanceLayout() {
  const { user, company, isLoading } = useAuth();
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  if (isLoading) return <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator /></View>;
  if (!user) return <Redirect href="/login" />;
  return <Drawer drawerContent={props => <DrawerContentScrollView {...props}>
    <View style={{ padding: 24, gap: 8, borderBottomWidth: 1, borderColor: colors.border, marginBottom: 16 }}>
      <Text style={{ color: colors.primary, fontSize: 22, fontWeight: "700" }}>Lumina FieldForce</Text>
      <Text style={{ color: colors.text }}>{company?.name}</Text>
      <Text style={{ color: colors.textSecondary }}>{user.name} ? {user.role}</Text>
    </View>
    <DrawerItemList {...props} />
  </DrawerContentScrollView>} screenOptions={{ headerShown: false, drawerActiveTintColor: colors.primary,
    drawerStyle: { backgroundColor: colors.background, width: Math.min(320, width * .85) }, drawerInactiveTintColor: colors.text,
    drawerType: width >= 1100 ? "permanent" : "front" }}>
    <Drawer.Screen name="index" options={{ title: "Dashboard", drawerIcon: ({ color, size }) => <Ionicons name="grid-outline" color={color} size={size} /> }} />
    <Drawer.Screen name="attendance" options={{ title: "Attendance & Geofencing", drawerIcon: ({ color, size }) => <Ionicons name="location-outline" color={color} size={size} /> }} />
    <Drawer.Screen name="account" options={{ title: "Account & Access", drawerIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} /> }} />
  </Drawer>;
}
