import React from "react";
import { Drawer } from "expo-router/drawer";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import {
  DrawerContentScrollView,
  DrawerItemList,
  type DrawerContentComponentProps,
} from "@react-navigation/drawer";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { canAccessAdminControls, canAccessSalesModule } from "@/lib/role-access";

type DrawerIconProps = {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  focused: boolean;
  size: number;
  offsetX?: number;
};

function DrawerIcon({
  icon,
  activeIcon,
  focused,
  size,
  offsetX = 0,
}: DrawerIconProps) {
  const { colors } = useAppTheme();
  const iconColor = focused ? colors.primary : colors.textSecondary;
  const iconSize = size;
  return (
    <View
      style={[
        styles.iconShell,
        {
          backgroundColor: focused ? `${colors.primary}1C` : "transparent",
          borderColor: focused ? `${colors.primary}40` : "transparent",
          marginLeft: offsetX,
        },
      ]}
    >
      <View style={styles.iconInner}>
        <Ionicons
          name={focused ? activeIcon : icon}
          size={iconSize}
          color={iconColor}
        />
      </View>
    </View>
  );
}

function CustomDrawerContent(
  props: DrawerContentComponentProps & { isLargeScreen: boolean }
) {
  const { colors, isDark } = useAppTheme();
  const { user, company } = useAuth();
  const insets = useSafeAreaInsets();
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "TF";

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={{ paddingTop: 0, paddingBottom: insets.bottom + 14 }}
      style={{ backgroundColor: colors.backgroundElevated }}
      showsVerticalScrollIndicator={false}
    >
      <LinearGradient
        colors={isDark ? [colors.heroEnd, colors.heroStart] : [colors.heroStart, colors.heroEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.profileCard}
      >
        {!props.isLargeScreen ? (
          <Pressable
            onPress={() => props.navigation.closeDrawer()}
            style={({ pressed }) => [
              styles.closeButton,
              { opacity: pressed ? 0.86 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Close navigation menu"
            hitSlop={6}
          >
            <Ionicons name="close" size={18} color="#FFFFFF" />
          </Pressable>
        ) : null}
        <View style={styles.avatarShell}>
          {user?.avatar ? (
            <Image source={{ uri: user.avatar }} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{initials}</Text>
          )}
        </View>
        <View style={styles.profileInfo}>
          <Text style={styles.profileName}>{user?.name ?? "TrackForce User"}</Text>
          <Text style={styles.profileMeta}>
            {(user?.role ?? "staff").toUpperCase()} | {company?.primaryBranch ?? user?.branch ?? "Enterprise Suite"}
          </Text>
        </View>
      </LinearGradient>

      <View style={styles.drawerBody}>
        <Text style={[styles.drawerHeading, { color: colors.textTertiary }]}>Navigation</Text>
        <DrawerItemList {...props} />
      </View>
    </DrawerContentScrollView>
  );
}

export default function SidebarLayout() {
  const { colors, isDark } = useAppTheme();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 1024;
  const isAdmin = user?.role === "admin";
  const canSeeSalesAi = canAccessSalesModule(user?.role);
  const canSeeAdminControls = canAccessAdminControls(user?.role);

  return (
    <Drawer
      defaultStatus={isLargeScreen ? "open" : "closed"}
      drawerContent={(props) => (
        <CustomDrawerContent {...props} isLargeScreen={isLargeScreen} />
      )}
      screenOptions={{
        headerShown: false,
        drawerType: isLargeScreen ? "permanent" : "front",
        swipeEdgeWidth: isLargeScreen ? 0 : 84,
        overlayColor: isLargeScreen
          ? "transparent"
          : isDark
            ? "rgba(2, 10, 20, 0.68)"
            : "rgba(9, 20, 38, 0.30)",
        drawerStyle: {
          width: 300,
          backgroundColor: colors.backgroundElevated,
          borderRightWidth: 1,
          borderRightColor: colors.border,
        },
        drawerActiveTintColor: colors.primary,
        drawerInactiveTintColor: colors.textSecondary,
        drawerActiveBackgroundColor: `${colors.primary}14`,
        drawerLabelStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 14,
          marginLeft: -6,
        },
        drawerItemStyle: {
          marginHorizontal: 10,
          marginVertical: 3,
          borderRadius: 14,
          paddingHorizontal: 6,
          minHeight: 50,
        },
      }}
    >
      <Drawer.Screen
        name="index"
        options={{
          title: "Dashboard",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="grid-outline" activeIcon="grid" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="attendance"
        options={{
          title: "Attendance",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="time-outline" activeIcon="time" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="team"
        options={{
          title: "Team",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="people-outline" activeIcon="people" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="tasks"
        options={{
          title: "Tasks",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="clipboard-outline" activeIcon="clipboard" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="sales"
        options={{
          title: "Sales AI",
          drawerItemStyle: canSeeSalesAi ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon
              icon="sparkles-outline"
              activeIcon="sparkles"
              focused={focused}
              size={size}
              offsetX={18}
            />
          ),
        }}
      />
      <Drawer.Screen
        name="route-tracking-admin"
        options={{
          title: "Route Tracking",
          drawerItemStyle: isAdmin ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="map-outline" activeIcon="map" focused={focused} size={size} offsetX={18} />
          ),
        }}
      />
      <Drawer.Screen
        name="notifications"
        options={{
          title: "Notifications",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="notifications-outline" activeIcon="notifications" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="support"
        options={{
          title: "Support",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="help-buoy-outline" activeIcon="help-buoy" focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="admin-controls"
        options={{
          title: "Admin Controls",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon icon="construct-outline" activeIcon="construct" focused={focused} size={size} offsetX={18} />
          ),
        }}
      />
      <Drawer.Screen
        name="more"
        options={{
          title: "More",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon
              icon="ellipsis-horizontal-circle-outline"
              activeIcon="ellipsis-horizontal-circle"
              focused={focused}
              size={size}
            />
          ),
        }}
      />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  iconShell: {
    width: 34,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  iconInner: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  profileCard: {
    marginHorizontal: 12,
    marginTop: 10,
    borderRadius: 20,
    minHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    shadowColor: "#0A2E67",
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  closeButton: {
    position: "absolute",
    right: 10,
    top: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.22)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.32)",
  },
  avatarShell: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.22)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    letterSpacing: 0.4,
  },
  avatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 16,
  },
  profileInfo: {
    flex: 1,
    gap: 3,
  },
  profileName: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  profileMeta: {
    color: "rgba(255,255,255,0.80)",
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
  },
  drawerBody: {
    marginTop: 14,
  },
  drawerHeading: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginLeft: 18,
    marginBottom: 4,
  },
});
