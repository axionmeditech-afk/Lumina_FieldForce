import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCanvas } from "../../components/AppCanvas";
import { AdminCompanySetupPanel } from "../../components/AdminCompanySetupPanel";
import { DrawerToggleButton } from "../../components/DrawerToggleButton";
import { EmployeeAccessPanel } from "../../components/EmployeeAccessPanel";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { getAttendanceStatus, getUserGeofences } from "@/lib/attendance-api";
import { getAttendanceGeofenceRuntimeStatus, startAttendanceGeofence } from "@/lib/attendance-background";
import { getLocationPermissionSnapshot, requestLocationPermissionBundle } from "@/lib/location-service";

function formatRole(role?: string | null): string {
  if (!role) return "Employee";
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getInitials(name?: string | null): string {
  const parts = (name || "Lumina FieldForce")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "LF";
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

type AutoCheckoutSetupState = "checking" | "idle" | "enabled" | "needs_permission" | "needs_checkin" | "unavailable";

export default function Account() {
  const { user, company, logout } = useAuth();
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [autoCheckoutBusy, setAutoCheckoutBusy] = useState(false);
  const [autoCheckoutState, setAutoCheckoutState] = useState<AutoCheckoutSetupState>("checking");
  const [autoCheckoutHint, setAutoCheckoutHint] = useState("Checking background setup...");
  const [accessPanelVersion, setAccessPanelVersion] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const isAdmin = user?.role === "admin";
  const userName = user?.name?.trim() || "Lumina User";
  const companyName = company?.name?.trim() || user?.companyName?.trim() || "Workspace";
  const branchName = company?.primaryBranch?.trim() || user?.branch?.trim() || "Main Branch";
  const roleLabel = formatRole(user?.role);
  const initials = useMemo(() => getInitials(userName), [userName]);

  const refreshAutoCheckoutSetup = useCallback(async () => {
    try {
      const [runtime, permission, status] = await Promise.all([
        getAttendanceGeofenceRuntimeStatus(),
        getLocationPermissionSnapshot(),
        getAttendanceStatus().catch(() => ({ active: null })),
      ]);
      if (!runtime.available) {
        setAutoCheckoutState("unavailable");
        setAutoCheckoutHint("Install the APK/native build to use background auto-checkout.");
        return;
      }
      if (!permission.foreground || !permission.background) {
        setAutoCheckoutState("needs_permission");
        setAutoCheckoutHint("Allow location all the time from permission settings.");
        return;
      }
      if (runtime.fullyEnabled) {
        setAutoCheckoutState("enabled");
        setAutoCheckoutHint("Enabled. Office exit will be checked in the background during active attendance.");
        return;
      }
      if (!status.active) {
        setAutoCheckoutState("needs_checkin");
        setAutoCheckoutHint("Check in first, then enable auto-checkout for that attendance session.");
        return;
      }
      setAutoCheckoutState("idle");
      setAutoCheckoutHint("Ready. Enable it after check-in to monitor your saved office boundary.");
    } catch {
      setAutoCheckoutState("idle");
      setAutoCheckoutHint("Tap enable to verify permissions and start background monitoring.");
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshAutoCheckoutSetup();
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshAutoCheckoutSetup]);

  const openPermissionSettings = useCallback(() => {
    Alert.alert(
      "Enable background access",
      "In App Info, set Location to \"Allow all the time\". For better reliability, also set Battery usage to Unrestricted if your phone shows that option.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
    } catch (error) {
      Alert.alert("Sign out", error instanceof Error ? error.message : "Please retry.");
    } finally {
      setSigningOut(false);
    }
  };

  const enableBackgroundCheckout = async () => {
    if (autoCheckoutBusy) return;
    if (autoCheckoutState === "enabled") {
      Alert.alert("Auto-checkout enabled", "Background geofence monitoring is already active for your current check-in.");
      return;
    }
    setAutoCheckoutBusy(true);
    try {
      const permission = await requestLocationPermissionBundle();
      if (!permission.foreground || !permission.background) {
        setAutoCheckoutState("needs_permission");
        setAutoCheckoutHint("Background location is off. Enable \"Allow all the time\" in app settings.");
        openPermissionSettings();
        return;
      }

      const { active } = await getAttendanceStatus();
      if (!active) {
        setAutoCheckoutState("needs_checkin");
        setAutoCheckoutHint("Check in first, then enable auto-checkout.");
        Alert.alert("Check in first", "Background geofencing is enabled only for an active attendance session.");
        return;
      }
      const geofences = await getUserGeofences(active.userId);
      if (!geofences.length) {
        setAutoCheckoutState("idle");
        setAutoCheckoutHint("Office geofence missing. Ask admin to save your office location first.");
        Alert.alert(
          "Office geofence missing",
          "Ask admin to save your office geofence first. Auto-checkout needs one active office boundary.",
        );
        return;
      }
      const enabled = await startAttendanceGeofence(active, geofences, true);
      if (enabled) {
        setAutoCheckoutState("enabled");
        setAutoCheckoutHint("Enabled. Office exit will be checked in the background during this check-in.");
        Alert.alert("Auto-checkout enabled", "Your checked-in office is now monitored in the background.");
      } else {
        setAutoCheckoutState("needs_permission");
        setAutoCheckoutHint("Background service did not start. Check location and battery settings.");
        openPermissionSettings();
      }
    } catch (error) {
      Alert.alert("Setup failed", error instanceof Error ? error.message : "Please retry.");
    } finally {
      setAutoCheckoutBusy(false);
      void refreshAutoCheckoutSetup();
    }
  };

  const autoCheckoutStatusTone =
    autoCheckoutState === "enabled"
      ? colors.success
      : autoCheckoutState === "needs_permission" || autoCheckoutState === "unavailable"
        ? colors.warning
        : colors.primary;
  const autoCheckoutButtonLabel =
    autoCheckoutBusy
      ? "Checking setup..."
      : autoCheckoutState === "enabled"
        ? "Enabled"
        : autoCheckoutState === "needs_permission"
          ? "Open permission settings"
          : "Enable auto-checkout";
  const autoCheckoutButtonIcon =
    autoCheckoutState === "enabled"
      ? "checkmark-circle"
      : autoCheckoutState === "needs_permission"
        ? "settings-outline"
        : "radio-outline";

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
        <LinearGradient
          colors={isDark ? ["#14233A", "#0D1628", "#0B1220"] : ["#FFFFFF", "#F7FBFF", "#EEF5FF"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.hero, { borderColor: colors.border, shadowColor: colors.cardShadow }]}
        >
          <LinearGradient
            pointerEvents="none"
            colors={
              isDark
                ? ["rgba(99,166,255,0.46)", "rgba(32,200,143,0.18)"]
                : ["rgba(14,95,216,0.18)", "rgba(25,139,244,0.08)"]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroGlow}
          />
          <View style={styles.heroTop}>
            <DrawerToggleButton />
            <View style={[styles.rolePill, { backgroundColor: `${colors.primary}14`, borderColor: `${colors.primary}22` }]}>
              <Ionicons name="shield-checkmark-outline" size={14} color={colors.primary} />
              <Text style={[styles.rolePillText, { color: colors.primary }]}>{roleLabel}</Text>
            </View>
          </View>

          <View style={styles.titleBlock}>
            <Text style={[styles.title, { color: colors.text }]}>Account & Access</Text>
            <Text style={[styles.titleSubtitle, { color: colors.textSecondary }]}>
              Profile, company and access controls
            </Text>
          </View>

          <View style={styles.greetingRow}>
            <Text style={[styles.greetingText, { color: colors.textSecondary }]}>{getGreeting()},</Text>
            <Text style={[styles.readyText, { color: colors.success }]}>Signed in</Text>
          </View>

          <View style={styles.profileRow}>
            <View
              style={[
                styles.avatar,
                {
                  backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#FFFFFF",
                  borderColor: isDark ? "rgba(255,255,255,0.14)" : "rgba(14,95,216,0.10)",
                },
              ]}
            >
              {user?.avatar ? (
                <Image source={{ uri: user.avatar }} style={styles.avatarImage} />
              ) : (
                <Text style={[styles.avatarText, { color: colors.primary }]}>{initials}</Text>
              )}
            </View>
            <View style={styles.profileCopy}>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                {userName}
              </Text>
              <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>
                {user?.email || "Signed in user"}
              </Text>
              <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={2}>
                {companyName} - {branchName}
              </Text>
            </View>
          </View>

          <View style={styles.statusGrid}>
            <View
              style={[
                styles.statusChip,
                {
                  borderColor: colors.borderLight,
                  backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.72)",
                },
              ]}
            >
              <Ionicons name="business-outline" size={16} color={colors.primary} />
              <View style={styles.statusCopy}>
                <Text style={[styles.statusLabel, { color: colors.textTertiary }]}>Company</Text>
                <Text style={[styles.statusValue, { color: colors.text }]} numberOfLines={1}>
                  {companyName}
                </Text>
              </View>
            </View>
            <View
              style={[
                styles.statusChip,
                {
                  borderColor: colors.borderLight,
                  backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.72)",
                },
              ]}
            >
              <Ionicons name="location-outline" size={16} color={colors.success} />
              <View style={styles.statusCopy}>
                <Text style={[styles.statusLabel, { color: colors.textTertiary }]}>Office zone</Text>
                <Text style={[styles.statusValue, { color: colors.text }]} numberOfLines={1}>
                  {branchName}
                </Text>
              </View>
            </View>
          </View>
        </LinearGradient>

        <View
          style={[
            styles.card,
            {
              borderColor: colors.border,
              backgroundColor: colors.backgroundElevated,
              shadowColor: colors.cardShadow,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <View style={[styles.cardIcon, { backgroundColor: `${colors.primary}14` }]}>
              <Ionicons name="navigate-circle-outline" size={24} color={colors.primary} />
            </View>
            <View style={styles.cardCopy}>
              <View style={styles.cardTitleRow}>
                <Text style={[styles.cardTitle, { color: colors.text }]}>Background Auto-Checkout</Text>
                <View style={[styles.betaPill, { backgroundColor: `${autoCheckoutStatusTone}14` }]}>
                  <Text style={[styles.betaPillText, { color: autoCheckoutStatusTone }]}>
                    {autoCheckoutState === "enabled" ? "Enabled" : "Geofence"}
                  </Text>
                </View>
              </View>
              <Text style={[styles.cardSubtitle, { color: colors.textSecondary }]}>
                {autoCheckoutHint}
              </Text>
            </View>
          </View>

          <View style={styles.checklist}>
            {[
              "Active check-in required",
              "Saved office geofence required",
              "Allow all the time location required",
              "Keep battery unrestricted for best reliability",
            ].map((item) => (
              <View key={item} style={styles.checkRow}>
                <Ionicons name="checkmark-circle" size={17} color={colors.success} />
                <Text style={[styles.checkText, { color: colors.textSecondary }]}>{item}</Text>
              </View>
            ))}
          </View>

          <Pressable
            disabled={autoCheckoutBusy}
            onPress={() => {
              if (autoCheckoutState === "needs_permission") {
                openPermissionSettings();
                return;
              }
              void enableBackgroundCheckout();
            }}
            style={({ pressed }) => [
              styles.primaryButton,
              {
                backgroundColor: autoCheckoutState === "enabled" ? colors.success : colors.primary,
                opacity: autoCheckoutBusy || pressed ? 0.76 : 1,
              },
            ]}
          >
            {autoCheckoutBusy ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Ionicons name={autoCheckoutButtonIcon} size={18} color="#FFFFFF" />
            )}
            <Text style={styles.primaryButtonText}>
              {autoCheckoutButtonLabel}
            </Text>
          </Pressable>
        </View>

        {isAdmin ? (
          <>
            <AdminCompanySetupPanel onSaved={() => setAccessPanelVersion((current) => current + 1)} />
            <EmployeeAccessPanel key={accessPanelVersion} />
          </>
        ) : null}

        <Pressable
          disabled={signingOut}
          onPress={() => void signOut()}
          style={({ pressed }) => [
            styles.signOutButton,
            {
              borderColor: `${colors.danger}44`,
              backgroundColor: `${colors.danger}10`,
              opacity: signingOut || pressed ? 0.74 : 1,
            },
          ]}
        >
          {signingOut ? (
            <ActivityIndicator color={colors.danger} size="small" />
          ) : (
            <Ionicons name="log-out-outline" size={18} color={colors.danger} />
          )}
          <Text style={[styles.signOutText, { color: colors.danger }]}>
            {signingOut ? "Signing out..." : "Sign out"}
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
    borderRadius: 30,
    borderWidth: 1,
    padding: 18,
    gap: 16,
    overflow: "hidden",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  heroGlow: {
    position: "absolute",
    top: -90,
    right: -100,
    width: 260,
    height: 260,
    borderRadius: 130,
  },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rolePill: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rolePillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  titleBlock: {
    gap: 4,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  greetingText: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  readyText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  avatar: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 6,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
  },
  avatarText: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
  },
  profileCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 30,
    letterSpacing: -0.5,
  },
  titleSubtitle: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 18,
  },
  name: {
    fontFamily: "Inter_700Bold",
    fontSize: 21,
    letterSpacing: -0.2,
  },
  meta: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  statusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  statusChip: {
    flexGrow: 1,
    flexBasis: 180,
    minHeight: 58,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statusCopy: {
    flex: 1,
    minWidth: 0,
  },
  statusLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    textTransform: "uppercase",
  },
  statusValue: {
    marginTop: 2,
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    gap: 16,
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 9 },
    elevation: 3,
  },
  cardHeader: {
    flexDirection: "row",
    gap: 12,
  },
  cardIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
  },
  cardCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  cardTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  betaPill: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  betaPillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10.5,
  },
  cardSubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  checklist: {
    gap: 8,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    lineHeight: 17,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    flexDirection: "row",
    gap: 8,
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
