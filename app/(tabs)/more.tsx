import React, { useCallback, useEffect, useState } from "react";
import {
  Image,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { canAccessAdminControls, isSalesRole } from "@/lib/role-access";
import { getCurrentUserCompanyProfiles, switchCurrentUserCompany } from "@/lib/storage";
import type { CompanyProfile } from "@/lib/types";

interface MenuItem {
  title: string;
  subtitle: string;
  icon: string;
  iconLib: "ion" | "mci";
  color: string;
  route: string;
}

const PRIVILEGED_MENU_ITEMS: MenuItem[] = [
  { title: "Notifications", subtitle: "Company announcements", icon: "notifications-outline", iconLib: "ion", color: "#4F46E5", route: "/(tabs)/notifications" },
  { title: "Support", subtitle: "Employee help desk", icon: "help-buoy-outline", iconLib: "ion", color: "#14B8A6", route: "/(tabs)/support" },
  { title: "Salary", subtitle: "Payslips & breakdown", icon: "wallet-outline", iconLib: "ion", color: "#22C55E", route: "/salary" },
  { title: "Expenses", subtitle: "Claims & approvals", icon: "receipt-outline", iconLib: "ion", color: "#F59E0B", route: "/expenses" },
  { title: "Route Tracking", subtitle: "Live route & halt timeline", icon: "map-outline", iconLib: "ion", color: "#0EA5E9", route: "/route-tracking" },
  { title: "Audit Logs", subtitle: "Activity history", icon: "shield-checkmark-outline", iconLib: "ion", color: "#8B5CF6", route: "/audit" },
  { title: "Settings", subtitle: "App & branding", icon: "settings-outline", iconLib: "ion", color: "#64748B", route: "/settings" },
];

const EMPLOYEE_MENU_ITEMS: MenuItem[] = [
  { title: "Notifications", subtitle: "Company announcements", icon: "notifications-outline", iconLib: "ion", color: "#4F46E5", route: "/(tabs)/notifications" },
  { title: "Support", subtitle: "Ask for help", icon: "help-buoy-outline", iconLib: "ion", color: "#14B8A6", route: "/(tabs)/support" },
  { title: "Salary", subtitle: "Your payslips", icon: "wallet-outline", iconLib: "ion", color: "#22C55E", route: "/salary" },
  { title: "Expenses", subtitle: "Your claims", icon: "receipt-outline", iconLib: "ion", color: "#F59E0B", route: "/expenses" },
  { title: "Route Tracking", subtitle: "Your live route & halts", icon: "map-outline", iconLib: "ion", color: "#0EA5E9", route: "/route-tracking" },
  { title: "Settings", subtitle: "App & profile", icon: "settings-outline", iconLib: "ion", color: "#64748B", route: "/settings" },
];

export default function MoreScreen() {
  const { user, company, logout, refreshSession } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const isPrivileged = user?.role === "admin" || user?.role === "manager" || user?.role === "hr";
  const isSalesperson = isSalesRole(user?.role);
  const canSeeAdminControls = canAccessAdminControls(user?.role);
  const [companyOptions, setCompanyOptions] = useState<CompanyProfile[]>([]);
  const [switchingCompanyId, setSwitchingCompanyId] = useState<string | null>(null);
  const baseMenuItems = isPrivileged ? PRIVILEGED_MENU_ITEMS : EMPLOYEE_MENU_ITEMS;
  const menuItems = [
    ...baseMenuItems.filter((item) => !(isSalesperson && item.title === "Route Tracking")),
    ...(canSeeAdminControls
      ? [
          {
            title: "Admin Controls",
            subtitle: "Broadcast & runtime policies",
            icon: "construct-outline",
            iconLib: "ion" as const,
            color: "#DC2626",
            route: "/(tabs)/admin-controls",
          },
        ]
      : []),
  ];

  useEffect(() => {
    let mounted = true;
    (async () => {
      const companies = await getCurrentUserCompanyProfiles();
      if (!mounted) return;
      setCompanyOptions(companies);
    })();
    return () => {
      mounted = false;
    };
  }, [user?.id, user?.companyId]);

  const handleSwitchCompany = useCallback(
    async (companyId: string) => {
      if (switchingCompanyId || companyId === user?.companyId) return;
      setSwitchingCompanyId(companyId);
      try {
        await switchCurrentUserCompany(companyId);
        await refreshSession();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } finally {
        setSwitchingCompanyId(null);
      }
    },
    [refreshSession, switchingCompanyId, user?.companyId]
  );

  const handleLogout = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await logout();
    router.replace("/login");
  };

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInDown.duration(400)}>
          <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>More</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(100)} style={[styles.profileCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          <View style={[styles.profileAvatar, { backgroundColor: colors.primary + "20" }]}>
            {user?.avatar ? (
              <Image source={{ uri: user.avatar }} style={styles.profileAvatarImage} />
            ) : (
              <Text style={[styles.profileAvatarText, { color: colors.primary, fontFamily: "Inter_700Bold" }]}>
                {user?.name?.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </Text>
            )}
          </View>
          <View style={styles.profileInfo}>
            <Text style={[styles.profileName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              {user?.name}
            </Text>
            <Text style={[styles.profileEmail, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {user?.email}
            </Text>
            <View style={[styles.profileRoleChip, { backgroundColor: colors.primary + "15" }]}>
              <Text style={[styles.profileRole, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                {user?.role?.toUpperCase()} - {company?.primaryBranch || user?.branch}
              </Text>
            </View>
          </View>
        </Animated.View>

        {companyOptions.length > 1 ? (
          <Animated.View
            entering={FadeInDown.duration(400).delay(180)}
            style={[styles.companySwitchCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
          >
            <Text style={[styles.companySwitchTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Company Environment
            </Text>
            <Text
              style={[styles.companySwitchSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
            >
              Switch active company. Team, attendance, tasks, and users will stay scoped to selected company.
            </Text>
            <View style={styles.companyChipRow}>
              {companyOptions.map((option) => {
                const isActive = option.id === user?.companyId;
                const busy = switchingCompanyId === option.id;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => void handleSwitchCompany(option.id)}
                    disabled={Boolean(switchingCompanyId)}
                    style={[
                      styles.companyChip,
                      {
                        borderColor: isActive ? colors.primary : colors.border,
                        backgroundColor: isActive ? colors.primary + "15" : colors.surfaceSecondary,
                        opacity: busy ? 0.65 : 1,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.companyChipText,
                        { color: isActive ? colors.primary : colors.textSecondary, fontFamily: "Inter_500Medium" },
                      ]}
                    >
                      {option.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Animated.View>
        ) : null}

        <Animated.View entering={FadeInDown.duration(400).delay(220)} style={[styles.menuCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          {menuItems.map((item, idx) => (
            <Pressable
              key={item.route}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(item.route as any);
              }}
              style={({ pressed }) => [
                styles.menuItem,
                idx < menuItems.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: colors.borderLight },
                { opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <View style={[styles.menuIcon, { backgroundColor: item.color + "15" }]}>
                <Ionicons name={item.icon as any} size={20} color={item.color} />
              </View>
              <View style={styles.menuContent}>
                <Text style={[styles.menuTitle, { color: colors.text, fontFamily: "Inter_500Medium" }]}>{item.title}</Text>
                <Text style={[styles.menuSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>{item.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
            </Pressable>
          ))}
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(320)}>
          <Pressable
            onPress={handleLogout}
            style={({ pressed }) => [
              styles.logoutButton,
              { backgroundColor: colors.danger + "10", opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Ionicons name="log-out-outline" size={20} color={colors.danger} />
            <Text style={[styles.logoutText, { color: colors.danger, fontFamily: "Inter_600SemiBold" }]}>
              Sign Out
            </Text>
          </Pressable>
        </Animated.View>

        <Text style={[styles.version, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
          lumina fieldforce v1.0.0
        </Text>

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: 20 },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  headerTitle: { fontSize: 24, letterSpacing: -0.5, marginBottom: 20 },
  profileCard: {
    borderRadius: 22,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 16,
    borderWidth: 1,
  },
  profileAvatar: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  profileAvatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 16,
  },
  profileAvatarText: { fontSize: 20 },
  profileInfo: { flex: 1, gap: 4 },
  profileName: { fontSize: 17 },
  profileEmail: { fontSize: 13 },
  profileRoleChip: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginTop: 4,
  },
  profileRole: { fontSize: 10, letterSpacing: 0.5 },
  companySwitchCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
  },
  companySwitchTitle: {
    fontSize: 14,
  },
  companySwitchSubtitle: {
    marginTop: 4,
    fontSize: 11.5,
    lineHeight: 17,
  },
  companyChipRow: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  companyChip: {
    minHeight: 32,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  companyChipText: {
    fontSize: 11.5,
  },
  menuCard: {
    borderRadius: 22,
    overflow: "hidden",
    marginBottom: 16,
    borderWidth: 1,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  menuContent: { flex: 1, gap: 2 },
  menuTitle: { fontSize: 15 },
  menuSubtitle: { fontSize: 12 },
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 52,
    borderRadius: 14,
    gap: 8,
    marginBottom: 16,
  },
  logoutText: { fontSize: 15 },
  version: { textAlign: "center", fontSize: 12, marginBottom: 20 },
});
