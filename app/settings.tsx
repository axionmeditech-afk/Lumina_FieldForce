import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
  Keyboard,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import type { ThemeMode } from "@/constants/colors";
import { getSettings, updateCurrentUserProfile, updateSettings } from "@/lib/storage";
import * as ImagePicker from "expo-image-picker";
import {
  getDolibarrIntegrationSettings,
  testDolibarrIntegration,
  updateDolibarrIntegrationSettings,
} from "@/lib/attendance-api";
import {
  ensureBackgroundLocationTracking,
  flushBackgroundLocationQueue,
  stopBackgroundLocationTracking,
} from "@/lib/background-location";
import { isBackendReachable } from "@/lib/network";

export default function SettingsScreen() {
  const { user, company, updateCompany, refreshSession } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors, mode, setMode } = useAppTheme();
  const isAdmin = user?.role === "admin";

  const [companyName, setCompanyName] = useState("");
  const [primaryBranch, setPrimaryBranch] = useState("");
  const [headquarters, setHeadquarters] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [notifications, setNotifications] = useState(true);
  const [locationTracking, setLocationTracking] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const biometricLogin = true;
  const [profilePhotoUri, setProfilePhotoUri] = useState<string | null>(user?.avatar ?? null);
  const [profilePhotoDirty, setProfilePhotoDirty] = useState(false);
  const [isPickingProfilePhoto, setIsPickingProfilePhoto] = useState(false);
  const [backendApiUrl, setBackendApiUrl] = useState("");
  const [dolibarrEnabled, setDolibarrEnabled] = useState(true);
  const [dolibarrEndpoint, setDolibarrEndpoint] = useState("");
  const [dolibarrApiKey, setDolibarrApiKey] = useState("");
  const [showDolibarrApiKey, setShowDolibarrApiKey] = useState(false);
  const [isTestingBackend, setIsTestingBackend] = useState(false);
  const [isTestingDolibarr, setIsTestingDolibarr] = useState(false);
  const [backendHealthNote, setBackendHealthNote] = useState("Unknown");
  const [dolibarrHealthNote, setDolibarrHealthNote] = useState("Unknown");
  const [isSaving, setIsSaving] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const aiKeyFromEnv = (
    process.env.EXPO_PUBLIC_GROQ_API_KEY ||
    process.env.GROQ_API_KEY ||
    ""
  ).trim();
  const configuredAiModel = (
    process.env.EXPO_PUBLIC_GROQ_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-20b"
  ).trim();
  const hasAiEnvKey = Boolean(
    (process.env.EXPO_PUBLIC_GROQ_API_KEY || "").trim() ||
      (process.env.GROQ_API_KEY || "").trim() ||
      aiKeyFromEnv
  );

  useEffect(() => {
    setCompanyName(company?.name || "");
    setPrimaryBranch(company?.primaryBranch || "");
    setHeadquarters(company?.headquarters || "");
    setSupportEmail(company?.supportEmail || "");
  }, [company]);

  useEffect(() => {
    setProfilePhotoUri(user?.avatar ?? null);
    setProfilePhotoDirty(false);
  }, [user?.avatar]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const settings = await getSettings();
        if (!mounted) return;
        setNotifications(settings.notifications !== "false");
        setLocationTracking(settings.locationTracking !== "false");
        setAutoSync(settings.autoSync !== "false");
        setOfflineMode(settings.offlineMode === "true");
        setBackendApiUrl(settings.backendApiUrl || "");
        setDolibarrEnabled(true);
        setDolibarrEndpoint(settings.dolibarrEndpoint || "");
        setDolibarrApiKey(settings.dolibarrApiKey || "");
        if (!isAdmin) {
          setBackendHealthNote("Managed by Admin");
          setDolibarrHealthNote("Managed by Admin");
          return;
        }

        const backendReachable = await isBackendReachable(2500);
        if (!mounted) return;
        setBackendHealthNote(backendReachable ? "Connected" : "Unreachable");

        if (backendReachable) {
          try {
            const remoteDolibarr = await getDolibarrIntegrationSettings();
            if (!mounted) return;
            setDolibarrEnabled(true);
            setDolibarrEndpoint(remoteDolibarr.endpoint || settings.dolibarrEndpoint || "");
            setDolibarrHealthNote(
              remoteDolibarr.configured
                ? remoteDolibarr.enabled
                  ? "Configured"
                  : "Disabled"
                : "Not Configured"
            );
          } catch {
            if (mounted) {
              setDolibarrHealthNote(
                settings.dolibarrEnabled === "true" &&
                  Boolean((settings.dolibarrEndpoint || "").trim()) &&
                  Boolean((settings.dolibarrApiKey || "").trim())
                  ? "Configured (Local)"
                  : "Not Configured"
              );
            }
          }
        } else {
          setDolibarrHealthNote(
            settings.dolibarrEnabled === "true" &&
              Boolean((settings.dolibarrEndpoint || "").trim()) &&
              Boolean((settings.dolibarrApiKey || "").trim())
              ? "Configured (Offline)"
              : "Not Configured"
          );
        }
      } finally {
        if (mounted) {
          setSettingsLoaded(true);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [isAdmin]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    if (!settingsLoaded) {
      Alert.alert("Please wait", "Settings are still loading.");
      return;
    }
    if (isAdmin && !companyName.trim()) {
      Alert.alert("Company Required", "Company name cannot be empty.");
      return;
    }

    Keyboard.dismiss();
    setIsSaving(true);

    if (isAdmin && dolibarrEnabled && (!dolibarrEndpoint.trim() || !dolibarrApiKey.trim())) {
      Alert.alert(
        "Dolibarr Config Required",
        "Enable Dolibarr only after entering endpoint and API key."
      );
      setIsSaving(false);
      return;
    }

    const nextSettings: Record<string, string> = {
      notifications: notifications ? "true" : "false",
      biometricLogin: "true",
    };
    if (isAdmin) {
      const normalizedOfflineMode = offlineMode;
      const normalizedAutoSync = normalizedOfflineMode ? false : autoSync;
      nextSettings.locationTracking = locationTracking ? "true" : "false";
      nextSettings.autoSync = normalizedAutoSync ? "true" : "false";
      nextSettings.offlineMode = normalizedOfflineMode ? "true" : "false";
      nextSettings.backendApiUrl = backendApiUrl.trim();
      nextSettings.dolibarrEnabled = "true";
      nextSettings.dolibarrEndpoint = dolibarrEndpoint.trim();
      nextSettings.dolibarrApiKey = dolibarrApiKey.trim();
    }

    const withTimeout = async <T,>(
      promise: Promise<T>,
      timeoutMs: number,
      timeoutMessage = "Operation timed out. Please retry."
    ): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        }),
      ]);

    try {
      if (isAdmin) {
        await withTimeout(
          updateCompany({
            name: companyName.trim(),
            primaryBranch: primaryBranch.trim() || "Main Branch",
            headquarters: headquarters.trim() || "India",
            supportEmail: supportEmail.trim() || "support@company.com",
          }),
          10_000
        );
      }

      if (profilePhotoDirty) {
        await withTimeout(
          updateCurrentUserProfile({
            avatar: profilePhotoUri,
          }),
          10_000
        );
        await withTimeout(refreshSession(), 10_000);
      }

      await withTimeout(updateSettings(nextSettings), 10_000);

      // Verify persistence so save tap never silently fails.
      const persisted = await withTimeout(getSettings(), 10_000);
      const hasMismatch = Object.entries(nextSettings).some(
        ([key, value]) => (persisted[key] ?? "") !== value
      );
      if (hasMismatch) {
        throw new Error("Settings sync validation failed. Please retry once.");
      }

      let integrationWarning = "";
      if (isAdmin) {
        const backendReachable = await withTimeout(
          isBackendReachable(3000),
          4_000,
          "Backend reachability check timed out."
        ).catch(() => false);
        setBackendHealthNote(backendReachable ? "Connected" : "Unreachable");

        if (backendReachable) {
          try {
            const remoteDolibarr = await withTimeout(
              updateDolibarrIntegrationSettings({
                enabled: true,
                endpoint: dolibarrEndpoint.trim(),
                apiKey: dolibarrApiKey.trim(),
              }),
              10_000,
              "Dolibarr sync timed out."
            );
            setDolibarrHealthNote(
              remoteDolibarr.configured
                ? remoteDolibarr.enabled
                  ? "Configured"
                  : "Disabled"
                : "Not Configured"
            );
          } catch (error) {
            integrationWarning =
              error instanceof Error ? error.message : "Could not sync Dolibarr to backend.";
            setDolibarrHealthNote("Sync Failed");
          }
        } else {
          setDolibarrHealthNote(
            dolibarrEnabled && Boolean(dolibarrEndpoint.trim()) && Boolean(dolibarrApiKey.trim())
              ? "Configured (Offline)"
              : "Not Configured"
          );
        }
      }

      // Keep save action fast; background tracking reconfiguration runs asynchronously.
      if (isAdmin) {
        const normalizedOfflineMode = offlineMode;
        const normalizedAutoSync = normalizedOfflineMode ? false : autoSync;
        void (async () => {
          try {
            if (locationTracking) {
              const trackingResult = await withTimeout(
                ensureBackgroundLocationTracking(),
                15_000,
                "Background tracking timed out."
              );
              if (normalizedAutoSync && !normalizedOfflineMode) {
                await withTimeout(
                  flushBackgroundLocationQueue(),
                  15_000,
                  "Background sync timed out."
                );
              }
              if (!trackingResult.started && trackingResult.reason) {
                Alert.alert("Tracking Note", trackingResult.reason);
              }
            } else {
              await withTimeout(
                stopBackgroundLocationTracking(),
                15_000,
                "Stopping background tracking timed out."
              );
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Background tracking setup failed.";
            Alert.alert("Tracking Note", message);
          }
        })();
      }

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (integrationWarning) {
        Alert.alert(
          "Settings Saved",
          `Company profile and app preferences updated.\n\nDolibarr sync warning: ${integrationWarning}`
        );
      } else {
        Alert.alert(
          "Settings Saved",
          isAdmin
            ? "Company profile and app preferences updated."
            : "General settings and profile updated."
        );
      }
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const message = error instanceof Error ? error.message : "Unable to save settings.";
      Alert.alert("Save Failed", message);
    } finally {
      setIsSaving(false);
    }
  }, [
    autoSync,
    backendApiUrl,
    companyName,
    dolibarrApiKey,
    dolibarrEnabled,
    dolibarrEndpoint,
    headquarters,
    isAdmin,
    isSaving,
    locationTracking,
    notifications,
    offlineMode,
    profilePhotoDirty,
    profilePhotoUri,
    primaryBranch,
    refreshSession,
    settingsLoaded,
    supportEmail,
    updateCurrentUserProfile,
    updateCompany,
  ]);

  const handleThemeModeChange = async (nextMode: ThemeMode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await setMode(nextMode);
  };

  const handleOfflineModeToggle = useCallback((nextValue: boolean) => {
    setOfflineMode(nextValue);
    if (nextValue) {
      setAutoSync(false);
    }
  }, []);

  const handleAutoSyncToggle = useCallback((nextValue: boolean) => {
    setAutoSync(nextValue);
    if (nextValue) {
      setOfflineMode(false);
    }
  }, []);

  const handleTestBackend = useCallback(async () => {
    if (!isAdmin) return;
    if (isTestingBackend) return;
    setIsTestingBackend(true);
    try {
      const online = await isBackendReachable(4500);
      const next = online ? "Connected" : "Unreachable";
      setBackendHealthNote(next);
      Alert.alert("Backend Check", online ? "Backend is reachable." : "Backend is not reachable.");
    } finally {
      setIsTestingBackend(false);
    }
  }, [isAdmin, isTestingBackend]);

  const handleTestDolibarr = useCallback(async () => {
    if (!isAdmin) return;
    if (isTestingDolibarr) return;
    setIsTestingDolibarr(true);
    try {
      const result = await testDolibarrIntegration({
        enabled: true,
        endpoint: dolibarrEndpoint.trim(),
        apiKey: dolibarrApiKey.trim(),
      });
      setDolibarrHealthNote(result.ok ? "Connected" : "Failed");
      Alert.alert("Dolibarr Test", result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dolibarr test failed.";
      setDolibarrHealthNote("Failed");
      Alert.alert("Dolibarr Test Failed", message);
    } finally {
      setIsTestingDolibarr(false);
    }
  }, [dolibarrApiKey, dolibarrEnabled, dolibarrEndpoint, isAdmin, isTestingDolibarr]);

  const handlePickProfilePhoto = useCallback(async () => {
    if (isPickingProfilePhoto) return;
    setIsPickingProfilePhoto(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission Required", "Allow photo library access to upload profile photo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });
      if (result.canceled) return;
      const uri = result.assets?.[0]?.uri;
      if (!uri) return;
      setProfilePhotoUri(uri);
      setProfilePhotoDirty(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } finally {
      setIsPickingProfilePhoto(false);
    }
  }, [isPickingProfilePhoto]);

  const handleRemoveProfilePhoto = useCallback(() => {
    setProfilePhotoUri(null);
    setProfilePhotoDirty(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Settings</Text>
          <Pressable
            onPress={() => void handleSave()}
            disabled={isSaving || !settingsLoaded}
            hitSlop={12}
            style={({ pressed }) => [
              styles.saveHeaderButton,
              {
                backgroundColor: colors.primary,
                opacity: pressed || isSaving || !settingsLoaded ? 0.75 : 1,
              },
            ]}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                <Text style={styles.saveHeaderButtonText}>Save</Text>
              </>
            )}
          </Pressable>
        </View>

        {isAdmin ? (
          <Animated.View entering={FadeInDown.duration(400).delay(100)}>
            <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
              COMPANY PROFILE
            </Text>
            <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <View style={styles.inputRow}>
                <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>Company Name</Text>
                <TextInput
                  style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={companyName}
                  onChangeText={setCompanyName}
                  placeholder="Enter company name"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <View style={styles.inputRow}>
                <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>Primary Branch</Text>
                <TextInput
                  style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={primaryBranch}
                  onChangeText={setPrimaryBranch}
                  placeholder="Enter primary branch"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <View style={styles.inputRow}>
                <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>Headquarters</Text>
                <TextInput
                  style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={headquarters}
                  onChangeText={setHeadquarters}
                  placeholder="Enter headquarters address"
                  placeholderTextColor={colors.textTertiary}
                />
              </View>
              <View style={styles.inputRow}>
                <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>Support Email</Text>
                <TextInput
                  style={[styles.textInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={supportEmail}
                  onChangeText={setSupportEmail}
                  placeholder="support@company.com"
                  placeholderTextColor={colors.textTertiary}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            </View>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeInDown.duration(400).delay(100)}>
            <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
              MY PROFILE
            </Text>
            <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <View style={styles.profilePhotoRow}>
                <View style={[styles.profilePhotoWrap, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
                  {profilePhotoUri ? (
                    <Image source={{ uri: profilePhotoUri }} style={styles.profilePhotoImage} />
                  ) : (
                    <Ionicons name="person-circle-outline" size={46} color={colors.textTertiary} />
                  )}
                </View>
                <View style={styles.profilePhotoMeta}>
                  <Text style={[styles.profileName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                    {user?.name || "User"}
                  </Text>
                  <Text style={[styles.profileEmail, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    {user?.email || "-"}
                  </Text>
                  <Text style={[styles.profileRole, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
                    {(user?.role || "-").toUpperCase()} | {user?.branch || "-"}
                  </Text>
                </View>
              </View>
              <View style={styles.profilePhotoActions}>
                <Pressable
                  onPress={() => void handlePickProfilePhoto()}
                  disabled={isPickingProfilePhoto}
                  style={({ pressed }) => [
                    styles.profileActionButton,
                    {
                      backgroundColor: colors.primary,
                      opacity: pressed || isPickingProfilePhoto ? 0.76 : 1,
                    },
                  ]}
                >
                  {isPickingProfilePhoto ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="image-outline" size={14} color="#FFFFFF" />
                      <Text style={styles.profileActionButtonText}>Upload Photo</Text>
                    </>
                  )}
                </Pressable>
                <Pressable
                  onPress={handleRemoveProfilePhoto}
                  disabled={!profilePhotoUri}
                  style={({ pressed }) => [
                    styles.profileActionGhostButton,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.surfaceSecondary,
                      opacity: pressed || !profilePhotoUri ? 0.5 : 1,
                    },
                  ]}
                >
                  <Ionicons name="trash-outline" size={14} color={colors.textSecondary} />
                  <Text style={[styles.profileActionGhostText, { color: colors.textSecondary }]}>Remove</Text>
                </Pressable>
              </View>
            </View>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.duration(400).delay(150)}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
            APPEARANCE
          </Text>
          <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.themeRow}>
              {(["system", "light", "dark"] as ThemeMode[]).map((themeMode) => {
                const selected = mode === themeMode;
                return (
                  <Pressable
                    key={themeMode}
                    onPress={() => handleThemeModeChange(themeMode)}
                    style={[
                      styles.themeChip,
                      {
                        backgroundColor: selected ? colors.primary : colors.surfaceSecondary,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.themeChipText,
                        {
                          color: selected ? "#FFFFFF" : colors.textSecondary,
                          fontFamily: "Inter_500Medium",
                        },
                      ]}
                    >
                      {themeMode === "system" ? "System" : themeMode === "light" ? "Light" : "Dark"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Animated.View>

        {isAdmin ? (
          <Animated.View entering={FadeInDown.duration(400).delay(200)}>
            <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
              TRACKING & SYNC
            </Text>
            <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <ToggleRow
                icon="location-outline"
                iconColor="#22C55E"
                label="Location Tracking"
                description="Track employee location during work hours"
                value={locationTracking}
                onToggle={setLocationTracking}
                colors={colors}
              />
              <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
              <ToggleRow
                icon="sync-outline"
                iconColor="#3B82F6"
                label="Auto Sync"
                description="Sync data when online"
                value={autoSync}
                onToggle={handleAutoSyncToggle}
                colors={colors}
              />
              <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
              <ToggleRow
                icon="cloud-offline-outline"
                iconColor="#F59E0B"
                label="Offline Mode"
                description="Cache data for offline access"
                value={offlineMode}
                onToggle={handleOfflineModeToggle}
                colors={colors}
              />
            </View>
          </Animated.View>
        ) : null}

        <Animated.View entering={FadeInDown.duration(400).delay(300)}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
            SECURITY
          </Text>
          <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <InfoRow
              icon="finger-print-outline"
              iconColor="#8B5CF6"
              label="Biometric Attendance"
              value="Always ON (Admin Locked)"
              colors={colors}
            />
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(400)}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
            NOTIFICATIONS
          </Text>
          <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <ToggleRow
              icon="notifications-outline"
              iconColor="#EC4899"
              label="Push Notifications"
              description="Receive alerts and reminders"
              value={notifications}
              onToggle={setNotifications}
              colors={colors}
            />
          </View>
        </Animated.View>

        {isAdmin ? (
          <>
            <Animated.View entering={FadeInDown.duration(400).delay(500)}>
              <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
                INTEGRATIONS
              </Text>
              <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
                  <ToggleRow
                    icon="server-outline"
                    iconColor="#0EA5E9"
                    label="Dolibarr ERP Sync"
                    description="Push attendance records to Dolibarr"
                    value={dolibarrEnabled}
                    onToggle={() => setDolibarrEnabled(true)}
                    disabled
                    colors={colors}
                  />
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <View style={styles.inputRow}>
                  <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                    Backend API URL
                  </Text>
                  <TextInput
                    style={[
                      styles.textInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.border,
                        fontFamily: "Inter_400Regular",
                      },
                    ]}
                    value={backendApiUrl}
                    onChangeText={setBackendApiUrl}
                    placeholder="https://your-domain.com or http://192.168.x.x:5000"
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    onPress={() => void handleTestBackend()}
                    disabled={isTestingBackend}
                    style={({ pressed }) => [
                      styles.testButton,
                      {
                        backgroundColor: colors.primary,
                        opacity: pressed || isTestingBackend ? 0.76 : 1,
                      },
                    ]}
                  >
                    {isTestingBackend ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons name="pulse-outline" size={15} color="#FFFFFF" />
                        <Text style={styles.testButtonText}>Test Backend</Text>
                      </>
                    )}
                  </Pressable>
                  <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    Status: {backendHealthNote}
                  </Text>
                </View>
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <View style={styles.inputRow}>
                  <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                    Dolibarr Endpoint
                  </Text>
                  <TextInput
                    style={[
                      styles.textInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.border,
                        fontFamily: "Inter_400Regular",
                      },
                    ]}
                    value={dolibarrEndpoint}
                    onChangeText={setDolibarrEndpoint}
                    placeholder="https://dolibarr.example.com/api/index.php/..."
                    placeholderTextColor={colors.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.inlineInputRow}>
                    <TextInput
                      style={[
                        styles.textInput,
                        styles.inlineInput,
                        {
                          color: colors.text,
                          backgroundColor: colors.surfaceSecondary,
                          borderColor: colors.border,
                          fontFamily: "Inter_400Regular",
                        },
                      ]}
                      value={dolibarrApiKey}
                      onChangeText={setDolibarrApiKey}
                      placeholder="Dolibarr API key"
                      placeholderTextColor={colors.textTertiary}
                      autoCapitalize="none"
                      secureTextEntry={!showDolibarrApiKey}
                    />
                    <Pressable
                      onPress={() => setShowDolibarrApiKey((current) => !current)}
                      style={[
                        styles.eyeButton,
                        {
                          borderColor: colors.border,
                          backgroundColor: colors.surfaceSecondary,
                        },
                      ]}
                    >
                      <Ionicons
                        name={showDolibarrApiKey ? "eye-off-outline" : "eye-outline"}
                        size={18}
                        color={colors.textSecondary}
                      />
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={() => void handleTestDolibarr()}
                    disabled={isTestingDolibarr}
                    style={({ pressed }) => [
                      styles.testButton,
                      {
                        backgroundColor: "#0EA5E9",
                        opacity: pressed || isTestingDolibarr ? 0.76 : 1,
                      },
                    ]}
                  >
                    {isTestingDolibarr ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-done-outline" size={15} color="#FFFFFF" />
                        <Text style={styles.testButtonText}>Test Dolibarr</Text>
                      </>
                    )}
                  </Pressable>
                  <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    Status: {dolibarrHealthNote}
                  </Text>
                </View>
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <InfoRow
                  icon="cloud-outline"
                  iconColor="#6366F1"
                  label="Cloud Storage"
                  value={offlineMode ? "Local cache only (offline)" : autoSync ? "Local + Cloud Sync" : "Local cache (manual sync)"}
                  colors={colors}
                />
              </View>
            </Animated.View>

            <Animated.View entering={FadeInDown.duration(400).delay(550)}>
              <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
                SALES AI
              </Text>
              <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
                <View style={styles.inputRow}>
                  <Text style={[styles.inputLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                    Env-managed credentials
                  </Text>
                  <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    AI and speech keys are loaded from `.env`/code config (Revup primary with AssemblyAI/HF fallback).
                  </Text>
                </View>
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <InfoRow
                  icon="sparkles-outline"
                  iconColor={hasAiEnvKey ? "#22C55E" : "#F59E0B"}
                  label="AI Provider Key"
                  value={hasAiEnvKey ? "Configured" : "Missing"}
                  colors={colors}
                />
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <InfoRow
                  icon="layers-outline"
                  iconColor="#3B82F6"
                  label="AI Model"
                  value={configuredAiModel}
                  colors={colors}
                />
                <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
                <InfoRow
                  icon="radio-outline"
                  iconColor={backendHealthNote === "Connected" ? "#22C55E" : "#F59E0B"}
                  label="Speech API Path"
                  value={backendHealthNote === "Connected" ? "Reachable" : "Using fallback/offline"}
                  colors={colors}
                />
              </View>
            </Animated.View>
          </>
        ) : (
          <Animated.View entering={FadeInDown.duration(400).delay(500)}>
            <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
              INTEGRATIONS
            </Text>
            <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <InfoRow
                icon="lock-closed-outline"
                iconColor={colors.warning}
                label="API & Integration Settings"
                value="Managed by Admin"
                colors={colors}
              />
            </View>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.duration(400).delay(600)}>
          <Text style={[styles.sectionLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
            ABOUT
          </Text>
          <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <InfoRow icon="information-circle-outline" iconColor={colors.textSecondary} label="Version" value="1.0.0" colors={colors} />
            <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
            <InfoRow icon="business-outline" iconColor={colors.textSecondary} label="Company" value={company?.name || "-"} colors={colors} />
            <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
            <InfoRow icon="location-outline" iconColor={colors.textSecondary} label="Branch" value={company?.primaryBranch || user?.branch || "-"} colors={colors} />
            <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
            <InfoRow icon="person-outline" iconColor={colors.textSecondary} label="Role" value={user?.role?.toUpperCase() || "-"} colors={colors} />
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(650)}>
          <Pressable
            onPress={() => void handleSave()}
            disabled={isSaving || !settingsLoaded}
            style={({ pressed }) => [
              styles.saveFooterButton,
              {
                backgroundColor: colors.primary,
                opacity: pressed || isSaving || !settingsLoaded ? 0.76 : 1,
              },
            ]}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="save-outline" size={18} color="#FFFFFF" />
                <Text style={styles.saveFooterButtonText}>Save Settings</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

  function ToggleRow({
    icon,
    iconColor,
    label,
    description,
    value,
    onToggle,
    disabled,
    colors,
  }: {
    icon: string;
    iconColor: string;
    label: string;
    description: string;
    value: boolean;
    onToggle: (v: boolean) => void;
    disabled?: boolean;
    colors: ReturnType<typeof useAppTheme>["colors"];
  }) {
  return (
    <View style={styles.toggleRow}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + "15" }]}>
        <Ionicons name={icon as any} size={18} color={iconColor} />
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.rowLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>{label}</Text>
        <Text style={[styles.rowDesc, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>{description}</Text>
      </View>
        <Switch
          value={value}
          disabled={disabled}
          onValueChange={(v) => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onToggle(v);
          }}
          trackColor={{ false: colors.border, true: colors.primary + "60" }}
          thumbColor={value ? colors.primary : colors.textTertiary}
        />
    </View>
  );
}

function InfoRow({
  icon,
  iconColor,
  label,
  value,
  colors,
}: {
  icon: string;
  iconColor: string;
  label: string;
  value: string;
  colors: ReturnType<typeof useAppTheme>["colors"];
}) {
  return (
    <View style={styles.infoRow}>
      <View style={[styles.rowIcon, { backgroundColor: iconColor + "15" }]}>
        <Ionicons name={icon as any} size={18} color={iconColor} />
      </View>
      <Text style={[styles.rowLabel, { color: colors.text, fontFamily: "Inter_500Medium", flex: 1 }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingHorizontal: 20 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  saveHeaderButton: {
    minHeight: 34,
    minWidth: 76,
    borderRadius: 10,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 4,
  },
  saveHeaderButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  sectionLabel: {
    fontSize: 11,
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 16,
    paddingLeft: 4,
  },
  card: {
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 4,
  },
  themeRow: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  themeChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  themeChipText: {
    fontSize: 13,
  },
  inputRow: { padding: 16, gap: 8 },
  profilePhotoRow: {
    padding: 16,
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  profilePhotoWrap: {
    width: 72,
    height: 72,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  profilePhotoImage: {
    width: "100%",
    height: "100%",
  },
  profilePhotoMeta: {
    flex: 1,
    gap: 3,
  },
  profileName: {
    fontSize: 15,
  },
  profileEmail: {
    fontSize: 12.5,
  },
  profileRole: {
    fontSize: 11,
    letterSpacing: 0.3,
  },
  profilePhotoActions: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    flexDirection: "row",
    gap: 8,
  },
  profileActionButton: {
    minHeight: 38,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  profileActionButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  profileActionGhostButton: {
    minHeight: 38,
    borderRadius: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  profileActionGhostText: {
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
  },
  inputLabel: { fontSize: 14 },
  textInput: {
    height: 44,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 15,
    borderWidth: 1,
  },
  inlineInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inlineInput: {
    flex: 1,
  },
  eyeButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  helperText: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  testButton: {
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "flex-start",
  },
  testButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  rowContent: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 14 },
  rowDesc: { fontSize: 11 },
  divider: { height: 0.5, marginLeft: 60 },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  infoValue: { fontSize: 13 },
  saveFooterButton: {
    marginTop: 16,
    minHeight: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  saveFooterButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
