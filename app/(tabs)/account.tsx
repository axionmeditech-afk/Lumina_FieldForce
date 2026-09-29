import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCanvas } from "../../components/AppCanvas";
import { AdminCompanySetupPanel } from "../../components/AdminCompanySetupPanel";
import { DrawerToggleButton } from "../../components/DrawerToggleButton";
import { EmployeeAccessPanel } from "../../components/EmployeeAccessPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { getAttendanceStatus, getUserGeofences } from "@/lib/attendance-api";
import { startAttendanceGeofence } from "@/lib/attendance-background";

function formatRole(role?: string | null): string {
  if (!role) return "Employee";
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function Account() {
  const { user, company, logout } = useAuth();
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === "admin";

  const signOut = async () => {
    setBusy(true);
    try {
      await logout();
    } catch (error) {
      Alert.alert("Sign out", error instanceof Error ? error.message : "Please retry.");
    } finally {
      setBusy(false);
    }
  };

  const enableBackgroundCheckout = async () => {
    setBusy(true);
    try {
      const { active } = await getAttendanceStatus();
      if (!active) {
        Alert.alert("Check in first", "Background geofencing is enabled only for an active attendance session.");
        return;
      }
      const enabled = await startAttendanceGeofence(active, await getUserGeofences(active.userId), true);
      Alert.alert(
        enabled ? "Auto-checkout enabled" : "Background location unavailable",
        enabled
          ? "Your checked-in office is now monitored while the app is in the background."
          : "Use a native app build and enable Always / Allow all the time location permission in device settings.",
      );
    } catch (error) {
      Alert.alert("Setup failed", error instanceof Error ? error.message : "Please retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppCanvas>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 14,
            paddingBottom: Math.max(insets.bottom, 20) + 28,
          },
        ]}
      >
        <View
          style={[
            styles.hero,
            {
              borderColor: colors.border,
              backgroundColor: isDark ? "rgba(13,22,40,0.92)" : "rgba(255,255,255,0.92)",
            },
          ]}
        >
          <View style={styles.heroTop}>
            <DrawerToggleButton />
            <View style={[styles.rolePill, { backgroundColor: `${colors.primary}14` }]}>
              <Ionicons name="shield-checkmark-outline" size={14} color={colors.primary} />
              <Text style={[styles.rolePillText, { color: colors.primary }]}>{formatRole(user?.role)}</Text>
            </View>
          </View>
          <View style={styles.profileRow}>
            <View style={[styles.avatar, { backgroundColor: `${colors.primary}16` }]}>
              <Text style={[styles.avatarText, { color: colors.primary }]}>
                {(user?.name || "LF").trim().slice(0, 2).toUpperCase()}
              </Text>
            </View>
            <View style={styles.profileCopy}>
              <Text style={[styles.title, { color: colors.text }]}>Account & Access</Text>
              <Text style={[styles.name, { color: colors.text }]}>{user?.name || "Lumina User"}</Text>
              <Text style={[styles.meta, { color: colors.textSecondary }]}>{user?.email}</Text>
              <Text style={[styles.meta, { color: colors.textSecondary }]}>
                {company?.name || user?.companyName || "Workspace"} - {company?.primaryBranch || user?.branch || "Main Branch"}
              </Text>
            </View>
          </View>
        </View>

        <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
          <View style={styles.cardHeader}>
            <Ionicons name="navigate-circle-outline" size={22} color={colors.primary} />
            <View style={styles.cardCopy}>
              <Text style={[styles.cardTitle, { color: colors.text }]}>Background Auto-Checkout</Text>
              <Text style={[styles.cardSubtitle, { color: colors.textSecondary }]}>
                Works only during an active check-in and uses the saved office geofence.
              </Text>
            </View>
          </View>
          <Pressable
            disabled={busy}
            onPress={() => void enableBackgroundCheckout()}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary, opacity: busy || pressed ? 0.76 : 1 },
            ]}
          >
            <Text style={styles.primaryButtonText}>Enable background auto-checkout</Text>
          </Pressable>
        </View>

        {isAdmin ? (
          <>
            <AdminCompanySetupPanel />
            <EmployeeAccessPanel />
          </>
        ) : null}

        <Pressable
          disabled={busy}
          onPress={() => void signOut()}
          style={({ pressed }) => [
            styles.signOutButton,
            {
              borderColor: `${colors.danger}44`,
              backgroundColor: `${colors.danger}10`,
              opacity: busy || pressed ? 0.74 : 1,
            },
          ]}
        >
          <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          <Text style={[styles.signOutText, { color: colors.danger }]}>
            {busy ? "Working..." : "Sign out"}
          </Text>
        </Pressable>
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  content: {
    width: "100%",
    maxWidth: 1060,
    alignSelf: "center",
    paddingHorizontal: 18,
    gap: 16,
  },
  hero: {
    borderRadius: 26,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rolePill: {
    minHeight: 34,
    borderRadius: 999,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rolePillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  avatar: {
    width: 66,
    height: 66,
    borderRadius: 33,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
  },
  profileCopy: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
  },
  name: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  meta: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  cardHeader: {
    flexDirection: "row",
    gap: 12,
  },
  cardCopy: {
    flex: 1,
    gap: 3,
  },
  cardTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
  },
  cardSubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  signOutButton: {
    minHeight: 50,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  signOutText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
});
