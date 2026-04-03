import React, { useEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "expo-router/drawer";
import { Ionicons } from "@expo/vector-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
// eslint-disable-next-line import/no-unresolved
import AddTeamIcon from "@hugeicons/core-free-icons/AddTeamIcon";
// eslint-disable-next-line import/no-unresolved
import AiAudioIcon from "@hugeicons/core-free-icons/AiAudioIcon";
// eslint-disable-next-line import/no-unresolved
import AnalyticsUpIcon from "@hugeicons/core-free-icons/AnalyticsUpIcon";
// eslint-disable-next-line import/no-unresolved
import Award04Icon from "@hugeicons/core-free-icons/Award04Icon";
// eslint-disable-next-line import/no-unresolved
import ClipboardClockIcon from "@hugeicons/core-free-icons/ClipboardClockIcon";
// eslint-disable-next-line import/no-unresolved
import Configuration01Icon from "@hugeicons/core-free-icons/Configuration01Icon";
// eslint-disable-next-line import/no-unresolved
import DashboardSquare02Icon from "@hugeicons/core-free-icons/DashboardSquare02Icon";
// eslint-disable-next-line import/no-unresolved
import FingerPrintScanIcon from "@hugeicons/core-free-icons/FingerPrintScanIcon";
// eslint-disable-next-line import/no-unresolved
import Invoice04Icon from "@hugeicons/core-free-icons/Invoice04Icon";
// eslint-disable-next-line import/no-unresolved
import MoreVerticalCircle02Icon from "@hugeicons/core-free-icons/MoreVerticalCircle02Icon";
// eslint-disable-next-line import/no-unresolved
import Note04Icon from "@hugeicons/core-free-icons/Note04Icon";
// eslint-disable-next-line import/no-unresolved
import Notification01Icon from "@hugeicons/core-free-icons/Notification01Icon";
// eslint-disable-next-line import/no-unresolved
import Route03Icon from "@hugeicons/core-free-icons/Route03Icon";
// eslint-disable-next-line import/no-unresolved
import CustomerService01Icon from "@hugeicons/core-free-icons/CustomerService01Icon";
// eslint-disable-next-line import/no-unresolved
import WarehouseIcon from "@hugeicons/core-free-icons/WarehouseIcon";
// eslint-disable-next-line import/no-unresolved
import WalletAdd02Icon from "@hugeicons/core-free-icons/WalletAdd02Icon";
import {
  DrawerContentScrollView,
  DrawerItemList,
  type DrawerContentComponentProps,
  useDrawerStatus,
} from "@react-navigation/drawer";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { canAccessAdminControls, canAccessSalesModule } from "@/lib/role-access";
import { getUnreadNotificationsCount } from "@/lib/storage";

type DrawerIconProps = {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  focused: boolean;
  size: number;
  offsetX?: number;
  badgeCount?: number;
};

const DRAWER_WIDTH = 396;

function getDrawerPalette(isDark: boolean) {
  if (isDark) {
    return {
      panelBackground: "#10264B",
      panelBorder: "rgba(196, 214, 255, 0.18)",
      pillBackground: "#EEF4FF",
      pillText: "#143764",
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
      segmentTrackBorder: "rgba(196, 214, 255, 0.2)",
      segmentTrackBackground: "rgba(255, 255, 255, 0.06)",
      segmentGhostText: "rgba(214, 228, 255, 0.88)",
      footerText: "#F2F7FF",
      footerMeta: "rgba(208, 224, 255, 0.68)",
    };
  }

  return {
    panelBackground: "#FBF7F0",
    panelBorder: "rgba(25, 52, 92, 0.08)",
    pillBackground: "#E8EDF5",
    pillText: "#173A69",
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
    segmentTrackBorder: "rgba(25, 52, 92, 0.1)",
    segmentTrackBackground: "rgba(223, 230, 240, 0.52)",
    segmentGhostText: "rgba(44, 64, 97, 0.78)",
    footerText: "#2F4C77",
    footerMeta: "rgba(78, 98, 128, 0.74)",
  };
}

function DrawerIcon({
  icon,
  activeIcon,
  focused,
  size,
  offsetX = 0,
  badgeCount = 0,
}: DrawerIconProps) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);
  const badgeLabel = useMemo(() => {
    if (!badgeCount || badgeCount <= 0) return "";
    return badgeCount > 99 ? "99+" : String(badgeCount);
  }, [badgeCount]);
  return (
    <View
      style={[
        styles.iconShell,
        {
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
        {badgeLabel ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badgeLabel}</Text>
          </View>
        ) : null}
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
  const drawerStatus = useDrawerStatus();
  const scrollRef = useRef<ScrollView | null>(null);
  const palette = getDrawerPalette(isDark);
  const brandLabel = company?.name?.trim() || "Lumina";
  const roleLabel = (user?.role ?? "staff").toUpperCase();
  const branchLabel = company?.primaryBranch ?? user?.branch ?? "Workspace";

  useEffect(() => {
    if (drawerStatus !== "open") return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [drawerStatus]);

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
              {roleLabel} • {branchLabel}
            </Text>
          </View>
          {!props.isLargeScreen ? (
            <Pressable
              onPress={() => props.navigation.closeDrawer()}
              style={({ pressed }) => [
                styles.closePill,
                { backgroundColor: palette.closePillBackground },
                { opacity: pressed ? 0.86 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Close navigation menu"
              hitSlop={6}
            >
              <Text style={[styles.closePillText, { color: palette.closePillText }]}>Close</Text>
            </Pressable>
          ) : (
            <View style={[styles.closePillStatic, { backgroundColor: palette.closePillStaticBackground }]}>
              <Text style={[styles.closePillText, styles.closePillTextStatic, { color: palette.closePillTextStatic }]}>Menu</Text>
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
            {company?.name ?? "Enterprise Suite Pro"}
          </Text>
          <Text style={[styles.footerMeta, { color: palette.footerMeta }]}>
            Crafted for focused field operations
          </Text>
        </View>
      </View>
    </DrawerContentScrollView>
  );
}

function DashboardDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={DashboardSquare02Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function AttendanceDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={FingerPrintScanIcon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function TeamDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={AddTeamIcon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function TasksDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={ClipboardClockIcon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function SalesAiDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={AiAudioIcon}
          size={iconSize}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function ViewNotesDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Note04Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function SalesPosDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Invoice04Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function AdminReportsDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={AnalyticsUpIcon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function AdminIncentivesDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Award04Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function AdminStockDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={WarehouseIcon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function RouteTrackingDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Route03Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function BankAccountsDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={WalletAdd02Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function NotificationsDrawerIcon({
  focused,
  size,
  badgeCount = 0,
}: {
  focused: boolean;
  size: number;
  badgeCount?: number;
}) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);
  const badgeLabel = badgeCount > 99 ? "99+" : badgeCount > 0 ? String(badgeCount) : "";

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Notification01Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
        {badgeLabel ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badgeLabel}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function SupportDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={CustomerService01Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function AdminControlsDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={Configuration01Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

function MoreDrawerIcon({ focused, size }: { focused: boolean; size: number }) {
  const { isDark } = useAppTheme();
  const palette = getDrawerPalette(isDark);
  const iconColor = focused ? palette.activeIconColor : palette.inactiveIconColor;
  const iconSize = Math.max(size, 20);

  return (
    <View style={styles.iconShell}>
      <View style={styles.iconInner}>
        <HugeiconsIcon
          icon={MoreVerticalCircle02Icon}
          size={iconSize}
          color={iconColor}
          strokeWidth={1.7}
        />
      </View>
    </View>
  );
}

export default function SidebarLayout() {
  const { isDark } = useAppTheme();
  const { user } = useAuth();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 1024;
  const palette = getDrawerPalette(isDark);
  const isAdmin = user?.role === "admin";
  const canSeeSalesAi = canAccessSalesModule(user?.role);
  const canSeeAdminControls = canAccessAdminControls(user?.role);
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState(0);

  useEffect(() => {
    let active = true;

    const loadUnreadCount = async () => {
      try {
        const count = await getUnreadNotificationsCount();
        if (active) setUnreadNotificationsCount(count);
      } catch {
        if (active) setUnreadNotificationsCount((current) => current);
      }
    };

    void loadUnreadCount();
    const interval = setInterval(loadUnreadCount, 20000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [user?.id]);

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
          width: DRAWER_WIDTH,
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
          fontSize: 23,
          lineHeight: 31,
          letterSpacing: -0.7,
          marginLeft: 2,
        },
        drawerItemStyle: {
          marginHorizontal: 0,
          marginVertical: 2,
          borderRadius: 18,
          paddingHorizontal: 0,
          minHeight: 56,
        },
      }}
    >
        <Drawer.Screen
          name="index"
          options={{
            title: "Dashboard",
            drawerIcon: ({ focused, size }) => <DashboardDrawerIcon focused={focused} size={size} />,
          }}
        />
      <Drawer.Screen
        name="attendance"
        options={{
          title: "Attendance",
          drawerIcon: ({ focused, size }) => <AttendanceDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="team"
        options={{
          title: "Team",
          drawerIcon: ({ focused, size }) => <TeamDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="tasks"
        options={{
          title: "Tasks",
          drawerIcon: ({ focused, size }) => <TasksDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="sales"
        options={{
          title: "Sales AI",
          drawerItemStyle: canSeeSalesAi ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <SalesAiDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="visit-notes"
        options={{
          title: "View Notes",
          drawerItemStyle: canSeeSalesAi ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <ViewNotesDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="sales-pos-admin"
        options={{
          title: "Sales POS",
          drawerItemStyle: isAdmin ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <SalesPosDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="admin-reports"
        options={{
          title: "Admin Reports",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <AdminReportsDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="admin-incentives"
        options={{
          title: "Admin Incentives",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <AdminIncentivesDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="admin-stock"
        options={{
          title: "Admin Stock",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <AdminStockDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="route-tracking-admin"
        options={{
          title: "Route Tracking",
          drawerItemStyle: isAdmin ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <RouteTrackingDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="bank-accounts"
        options={{
          title: "Bank Accounts",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => <BankAccountsDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="bank-details"
        options={{
          title: "Bank Details",
          drawerItemStyle: canSeeAdminControls ? { display: "none" } : undefined,
          drawerIcon: ({ focused, size }) => <BankAccountsDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="notifications"
        options={{
          title: "Notifications",
          drawerIcon: ({ focused, size }) => (
            <NotificationsDrawerIcon
              focused={focused}
              size={size}
              badgeCount={unreadNotificationsCount}
            />
          ),
        }}
      />
      <Drawer.Screen
        name="support"
        options={{
          title: "Support",
          drawerIcon: ({ focused, size }) => <SupportDrawerIcon focused={focused} size={size} />,
        }}
      />
      <Drawer.Screen
        name="admin-controls"
        options={{
          title: "Admin Controls",
          drawerItemStyle: canSeeAdminControls ? undefined : { display: "none" },
          drawerIcon: ({ focused, size }) => (
            <AdminControlsDrawerIcon focused={focused} size={size} />
          ),
        }}
      />
      <Drawer.Screen
        name="more"
        options={{
          title: "More",
          drawerIcon: ({ focused, size }) => <MoreDrawerIcon focused={focused} size={size} />,
        }}
      />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  iconShell: {
    width: 20,
    height: 22,
    borderRadius: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  iconInner: {
    width: 20,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -8,
    right: -12,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: "#E11D48",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontFamily: "Inter_700Bold",
  },
  sidebarPanel: {
    borderRadius: 34,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 20,
    paddingBottom: 18,
    minHeight: 720,
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
    color: "#F7FAFF",
    fontSize: 25,
    letterSpacing: -0.9,
    fontFamily: "Inter_700Bold",
  },
  brandMeta: {
    color: "rgba(214, 228, 255, 0.76)",
    fontSize: 11,
    letterSpacing: 1.2,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
  },
  closePill: {
    minWidth: 94,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F4F8FF",
    paddingHorizontal: 18,
  },
  closePillStatic: {
    minWidth: 94,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(244, 248, 255, 0.12)",
    paddingHorizontal: 18,
  },
  closePillText: {
    color: "#173966",
    fontSize: 15,
    letterSpacing: -0.2,
    fontFamily: "Inter_500Medium",
  },
  closePillTextStatic: {
    color: "#F2F7FF",
  },
  drawerBody: {
    marginTop: 2,
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
    color: "#F2F7FF",
    fontSize: 13.5,
    letterSpacing: -0.2,
    fontFamily: "Inter_500Medium",
  },
  footerMeta: {
    color: "rgba(208, 224, 255, 0.68)",
    fontSize: 11.5,
    lineHeight: 17,
    letterSpacing: 0.2,
    fontFamily: "Inter_400Regular",
  },
});
