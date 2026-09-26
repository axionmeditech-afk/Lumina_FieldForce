import React, { useState } from "react";
import { Alert, Button, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";

export default function Account() {
  const { user, company, logout } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return <View style={{ flex: 1, padding: 24, paddingTop: insets.top + 20, gap: 20, backgroundColor: colors.background }}>
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
  </View>;
}
