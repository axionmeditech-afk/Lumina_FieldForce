import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useCallback, useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ThemeProvider, useAppTheme } from "@/contexts/ThemeContext";
import {
  ensureBackgroundLocationTracking,
  flushBackgroundLocationQueue,
  stopBackgroundLocationTracking,
} from "@/lib/background-location";
import { flushAttendanceQueue } from "@/lib/attendance-api";
import { getAttendance, getSettings, isCheckedIn, setCheckedIn, subscribeSettingsUpdates } from "@/lib/storage";
import type { AttendanceRecord } from "@/lib/types";
import { applyHapticsPolicy } from "@/lib/haptics-policy";
import {
  initializeDeviceNotifications,
  registerForPushTokenIfPossible,
  requestDeviceNotificationPermissionIfNeeded,
} from "@/lib/device-notifications";
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";

SplashScreen.preventAutoHideAsync();

function resolveCheckedInFromRecords(
  records: AttendanceRecord[],
  userId: string,
  userName?: string | null
): boolean | null {
  const normalizedUserName = (userName || "").trim().toLowerCase();
  const latest = records
    .filter(
      (entry) =>
        entry.userId === userId ||
        ((entry.userName || "").trim().toLowerCase() === normalizedUserName && normalizedUserName.length > 0)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!latest) return null;
  return latest.type === "checkin";
}

function FragmentKeyboardProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const KeyboardProviderSafe: React.ComponentType<{ children: React.ReactNode }> =
  Platform.OS === "android"
    ? FragmentKeyboardProvider
    : (() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          return require("react-native-keyboard-controller").KeyboardProvider;
        } catch {
          return FragmentKeyboardProvider;
        }
      })();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: "fade" }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="salary" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="expenses" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="audit" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="settings" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="sales-ai" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="visit-notes" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="route-tracking" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="employee/[id]" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="conversation/[id]" options={{ presentation: "card", animation: "slide_from_right" }} />
      <Stack.Screen name="support-thread/[id]" options={{ presentation: "card", animation: "slide_from_right" }} />
    </Stack>
  );
}

function AppShell() {
  const { colors, isDark } = useAppTheme();
  const { user } = useAuth();

  const applyRuntimeSettings = useCallback(
    async (overrides?: Record<string, string>) => {
      const settings = overrides ?? (await getSettings());
      applyHapticsPolicy(settings.notifications !== "false");
      await initializeDeviceNotifications();
      if (settings.notifications !== "false") {
        const granted = await requestDeviceNotificationPermissionIfNeeded();
        if (granted) {
          void registerForPushTokenIfPossible();
        }
      }

      if (!user?.id) {
        await stopBackgroundLocationTracking();
        return;
      }

      if (settings.locationTracking === "false") {
        await stopBackgroundLocationTracking();
        return;
      }

      const [checkedInFlag, attendanceRecords] = await Promise.all([isCheckedIn(), getAttendance()]);
      const derivedCheckedIn = resolveCheckedInFromRecords(attendanceRecords, user.id, user.name);
      const checkedIn = derivedCheckedIn ?? checkedInFlag;
      if (checkedIn !== checkedInFlag) {
        await setCheckedIn(checkedIn);
      }
      if (!checkedIn) {
        await stopBackgroundLocationTracking();
        return;
      }

      const trackingResult = await ensureBackgroundLocationTracking();
      if (!trackingResult.started) {
        return;
      }

      if (settings.offlineMode !== "true" && settings.autoSync !== "false") {
        await flushAttendanceQueue();
        await flushBackgroundLocationQueue();
      }
    },
    [user?.id, user?.name]
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        await applyRuntimeSettings();
      } catch {
        // Keep UI stable if runtime settings sync fails.
      }
    })();

    const unsubscribe = subscribeSettingsUpdates((settings) => {
      if (!mounted) return;
      void applyRuntimeSettings(settings).catch(() => {
        // Keep UI stable if a settings-triggered sync fails.
      });
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [applyRuntimeSettings]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardProviderSafe>
        <StatusBar style={isDark ? "light" : "dark"} />
        <RootLayoutNav />
      </KeyboardProviderSafe>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    if (fontsLoaded) {
      setAppReady(true);
    }
  }, [fontsLoaded]);

  useEffect(() => {
    const fallback = setTimeout(() => setAppReady(true), 4000);
    return () => clearTimeout(fallback);
  }, []);

  useEffect(() => {
    if (appReady) {
      SplashScreen.hideAsync();
    }
  }, [appReady]);

  if (!appReady) return null;

  return (
    <ThemeProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AppShell />
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
