import React, { useEffect, useMemo, useRef } from "react";
import { Redirect } from "expo-router";
import {
  Drawer,
  DrawerContentScrollView,
  DrawerItemList,
  type DrawerContentComponentProps,
} from "expo-router/drawer";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";

const DRAWER_WIDTH = 396;

function getDrawerPalette(isDark: boolean) {
  if (isDark) {
    return {
      panelBackground: "#10264B",
      panelBorder: "rgba(196, 214, 255, 0.18)",
      mutedText: "rgba(224, 235, 255, 0.76)",
      footerLine: "rgba(196, 214, 255, 0.16)",
      activeIconColor: "#F7FAFF",
      inactiveIconColor: "#AFC3EB",
      activeTintColor: "#F7FAFF",
      inactiveTintColor: "#AFC3EB",
      activeBackgroundColor: "rgba(255, 255, 255, 0.08)",
      brandName: "#F7FAFF",
      brandMeta: "rgba(214, 228, 255, 0.76)",
      closePillBackground: "#F4F8FF",
      closePillStaticBackground: "rgba(244, 248, 255, 0.12)",
      closePillText: "#173966",
      closePillTextStatic: "#F2F7FF",
      footerText: "#F2F7FF",
      footerMeta: "rgba(208, 224, 255, 0.68)",
    };
  }

  return {
    panelBackground: "#FBF7F0",
    panelBorder: "rgba(25, 52, 92, 0.08)",
    mutedText: "rgba(49, 67, 97, 0.72)",
    footerLine: "rgba(20, 38, 67, 0.1)",
    activeIconColor: "#173A69",
    inactiveIconColor: "#45638F",
    activeTintColor: "#173A69",
    inactiveTintColor: "#274C82",
    activeBackgroundColor: "#E9EDF2",
    brandName: "#173A69",
    brandMeta: "rgba(45, 69, 104, 0.68)",
    closePillBackground: "#FFFFFF",
    closePillStaticBackground: "#EEF2F7",
    closePillText: "#173A69",
    closePillTextStatic: "#385887",
    footerText: "#2F4C77",
    footerMeta: "rgba(78, 98, 128, 0.74)",
  };
}

function DrawerIcon({
  focused,
  size,
  name,
  focusedName,
}: {
  focused: boolean;
  size: number;
  name: keyof typeof Ionicons.glyphMap;
  focusedName: keyof typeof Ionicons.glyphMap;
}) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  return (
    <View style={styles.iconShell}>
      <Ionicons
        name={focused ? focusedName : name}
        size={Math.max(size, 20)}
        color={focused ? palette.activeIconColor : palette.inactiveIconColor}
      />
    </View>
  );
}

function CustomDrawerContent(
  props: DrawerContentComponentProps & { isLargeScreen: boolean },
) {
  const { colors, isDark } = useAppTheme();
  const { user, company } = useAuth();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);
  const activeRouteKey = props.state.routes[props.state.index]?.key;
  const previousRouteKey = useRef(activeRouteKey);
  const palette = getDrawerPalette(isDark);
  const brandLabel = company?.name?.trim() || "Lumina";
  const roleLabel = (user?.role ?? "staff").toUpperCase();
  const branchLabel = company?.primaryBranch ?? user?.branch ?? "Workspace";

  useEffect(() => {
    if (!activeRouteKey || previousRouteKey.current === activeRouteKey) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    previousRouteKey.current = activeRouteKey;
  }, [activeRouteKey]);

  return (
    <DrawerContentScrollView
      {...props}
      ref={scrollRef}
      contentContainerStyle={{
        paddingTop: insets.top + 6,
        paddingBottom: insets.bottom + 18,
        paddingHorizontal: 14,
      }}
      style={{ backgroundColor: "transparent" }}
      showsVerticalScrollIndicator={false}
    >
      <View
        style={[
          styles.sidebarPanel,
          {
            backgroundColor: palette.panelBackground,
            borderColor: palette.panelBorder,
            shadowColor: colors.cardShadow,
          },
        ]}
      >
        <View style={styles.sidebarTopRow}>
          <View style={styles.brandBlock}>
            <Text style={[styles.brandName, { color: palette.brandName }]} numberOfLines={1}>
              {brandLabel}
            </Text>
            <Text style={[styles.brandMeta, { color: palette.brandMeta }]} numberOfLines={1}>
              {roleLabel} - {branchLabel}
            </Text>
          </View>
          {!props.isLargeScreen ? (
            <Pressable
              onPress={() => props.navigation.closeDrawer()}
              style={({ pressed }) => [
                styles.closePill,
                { backgroundColor: palette.closePillBackground, opacity: pressed ? 0.86 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Close navigation menu"
              hitSlop={6}
            >
              <Text style={[styles.closePillText, { color: palette.closePillText }]}>Close</Text>
            </Pressable>
          ) : (
            <View
              style={[
                styles.closePillStatic,
                { backgroundColor: palette.closePillStaticBackground },
              ]}
            >
              <Text
                style={[
                  styles.closePillText,
                  styles.closePillTextStatic,
                  { color: palette.closePillTextStatic },
                ]}
              >
                Menu
              </Text>
            </View>
          )}
        </View>

        <View style={styles.drawerBody}>
          <Text style={[styles.drawerHeading, { color: palette.mutedText }]}>Navigation</Text>
          <DrawerItemList {...props} />
        </View>

        <View style={[styles.footerDivider, { backgroundColor: palette.footerLine }]} />
        <View style={styles.footerBlock}>
          <Text style={[styles.footerText, { color: palette.footerText }]}>
            {company?.name ?? "Lumina FieldForce"}
          </Text>
          <Text style={[styles.footerMeta, { color: palette.footerMeta }]}>
            Attendance and geofencing operations
          </Text>
        </View>
      </View>
    </DrawerContentScrollView>
  );
}

export default function AttendanceLayout() {
  const { user, company, isLoading } = useAuth();
  const { colors, isDark } = useAppTheme();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 1024;
  const palette = getDrawerPalette(isDark);
  const drawerWidth = useMemo(() => Math.min(DRAWER_WIDTH, Math.max(300, width * 0.86)), [width]);

  if (isLoading) {
    return (
      <View style={[styles.loadingShell, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!user) return <Redirect href="/login" />;

  return (
    <Drawer
      backBehavior="history"
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
          width: drawerWidth,
          backgroundColor: "transparent",
          borderRightWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        drawerActiveTintColor: palette.activeTintColor,
        drawerInactiveTintColor: palette.inactiveTintColor,
        drawerActiveBackgroundColor: palette.activeBackgroundColor,
        drawerLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 18,
          lineHeight: 25,
          marginLeft: 2,
        },
        drawerItemStyle: {
          marginHorizontal: 0,
          marginVertical: 2,
          borderRadius: 18,
          paddingHorizontal: 0,
          minHeight: 54,
        },
      }}
    >
      <Drawer.Screen
        name="index"
        options={{
          title: "Dashboard",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon focused={focused} size={size} name="grid-outline" focusedName="grid" />
          ),
        }}
      />
      <Drawer.Screen
        name="attendance"
        options={{
          title: "Attendance & Geofencing",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon
              focused={focused}
              size={size}
              name="location-outline"
              focusedName="location"
            />
          ),
        }}
      />
      <Drawer.Screen
        name="account"
        options={{
          title: company?.name ? "Account & Access" : "Account",
          drawerIcon: ({ focused, size }) => (
            <DrawerIcon
              focused={focused}
              size={size}
              name="person-circle-outline"
              focusedName="person-circle"
            />
          ),
        }}
      />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  loadingShell: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  iconShell: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarPanel: {
    borderRadius: 34,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 20,
    paddingBottom: 18,
    minHeight: 520,
    shadowOpacity: 0.18,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  sidebarTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  brandBlock: {
    flex: 1,
    gap: 4,
  },
  brandName: {
    fontSize: 25,
    fontFamily: "Inter_700Bold",
  },
  brandMeta: {
    fontSize: 11,
    letterSpacing: 1.2,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
  },
  closePill: {
    minWidth: 82,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  closePillStatic: {
    minWidth: 82,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  closePillText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  closePillTextStatic: {
    color: "#F2F7FF",
  },
  drawerBody: {
    marginTop: 18,
  },
  drawerHeading: {
    fontFamily: "Inter_500Medium",
    fontSize: 10.5,
    letterSpacing: 2.4,
    textTransform: "uppercase",
    marginLeft: 8,
    marginBottom: 10,
  },
  footerDivider: {
    height: 1,
    borderRadius: 999,
    marginTop: 18,
    marginBottom: 16,
  },
  footerBlock: {
    gap: 4,
    paddingHorizontal: 2,
  },
  footerText: {
    fontSize: 13.5,
    fontFamily: "Inter_500Medium",
  },
  footerMeta: {
    fontSize: 11.5,
    lineHeight: 17,
    fontFamily: "Inter_400Regular",
  },
});
