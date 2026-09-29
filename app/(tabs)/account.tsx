import { getAttendanceStatus, getUserGeofences } from "@/lib/attendance-api";
import { startAttendanceGeofence } from "@/lib/attendance-background";
import { EmployeeAccessPanel } from "@/components/EmployeeAccessPanel";
import React, { useState } from "react";
import { Alert, Button, Text, View, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";

export default function Account() {
  const { user, company, logout } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return <ScrollView contentContainerStyle={{ padding: 24, paddingTop: insets.top + 20, gap: 20, backgroundColor: colors.background }}>
    <DrawerToggleButton />
    <Text style={{ fontSize: 28, color: colors.text }}>Account</Text>
    <Text style={{ color: colors.text }}>{user?.name}</Text>
    <Text style={{ color: colors.textSecondary }}>{user?.email}</Text>
    <Text style={{ color: colors.textSecondary }}>{company?.name} · {user?.role}</Text>
    <Button title={busy ? "Signing out…" : "Sign out"} disabled={busy} onPress={async () => {
      setBusy(true);
      try { await logout(); } catch (error) { Alert.alert("Sign out", error instanceof Error ? error.message : "Please retry."); }
      finally { setBusy(false); }
    }} />
    <Text style={{ color: colors.textSecondary }}>Automatic checkout uses background location only during an active check-in. Allow location all the time / Always when prompted.</Text>
    <Button title="Enable background auto-checkout" disabled={busy} onPress={async () => {
      setBusy(true);
      try {
        const { active } = await getAttendanceStatus();
        if (!active) { Alert.alert("Check in first", "Background geofencing is enabled only for an active attendance session."); return; }
        const enabled = await startAttendanceGeofence(active, await getUserGeofences(active.userId), true);
        Alert.alert(enabled ? "Auto-checkout enabled" : "Background location unavailable", enabled ? "Your checked-in office is now monitored while the app is in the background." : "Use a native app build and enable Always / Allow all the time location permission in device settings.");
      } catch (e) { Alert.alert("Setup failed", e instanceof Error ? e.message : "Please retry"); }
      finally { setBusy(false); }
    }} />
    {user?.role === "admin" && <EmployeeAccessPanel />}
  </ScrollView>;
}
