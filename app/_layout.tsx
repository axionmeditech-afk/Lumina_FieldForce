import { AppState } from "react-native";
import { reconcileAttendanceGeofence } from "@/lib/attendance-background";
import "@/lib/attendance-background";
import React, { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ThemeProvider, useAppTheme } from "@/contexts/ThemeContext";
import { retireLegacyLocationTracking } from "@/lib/retire-legacy-tracking";
import { useFonts } from "expo-font";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
SplashScreen.preventAutoHideAsync();
function AppShell() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const reconcile = () => { void reconcileAttendanceGeofence().catch(console.warn); };
    reconcile();
    const sub = AppState.addEventListener("change", state => { if (state === "active") reconcile(); });
    return () => sub.remove();
  }, [user?.id]);
  const { colors, isDark } = useAppTheme();
  useEffect(() => { void retireLegacyLocationTracking().catch(console.warn); }, []);
  return <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
    <StatusBar style={isDark ? "light" : "dark"} />
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" /><Stack.Screen name="login" /><Stack.Screen name="(tabs)" />
    </Stack>
  </GestureHandlerRootView>;
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
