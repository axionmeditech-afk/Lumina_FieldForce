import React, { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { isSalesRole } from "@/lib/role-access";
import type { UserRole } from "@/lib/types";

const SIGNUP_ROLES: { label: string; value: UserRole }[] = [
  { label: "Admin", value: "admin" },
  { label: "Sales", value: "salesperson" },
  { label: "Employee", value: "employee" },
  { label: "Manager", value: "manager" },
  { label: "HR", value: "hr" },
];
const AUTH_BRAND_NAME = "Lumina FieldForce";
const AUTH_HERO_GRADIENT = ["#0F4C81", "#79B9FF"] as const;
const AUTH_BUTTON_GRADIENT = ["#0E63C9", "#67B7FF"] as const;

export default function LoginScreen() {
  const { login, signup } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [branch, setBranch] = useState("");
  const [pincode, setPincode] = useState("");
  const [role, setRole] = useState<UserRole>("salesperson");
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const screenSubtitle = useMemo(() => {
    return "";
  }, [mode]);
  const selectedRoleLabel = useMemo(
    () => SIGNUP_ROLES.find((entry) => entry.value === role)?.label ?? "Sales",
    [role]
  );
  const signInLabel = mode === "signin" ? "Email or Username" : "Email Address";
  const signInPlaceholder = mode === "signin" ? "email or username" : "name@enterprise.com";
  const signInKeyboardType = mode === "signin" ? "default" : "email-address";

  const handleAuthAction = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert("Missing Fields", "Please enter your email/username and password");
      return;
    }
    if (mode === "signup") {
      if (!fullName.trim() || !companyName.trim()) {
        Alert.alert("Missing Fields", "Please enter full name and company name");
        return;
      }
      if (isSalesRole(role) && (!branch.trim() || !pincode.trim())) {
        Alert.alert("Missing Fields", "Please enter location and pincode for sales staff");
        return;
      }
    }

    setLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      if (mode === "signin") {
        const success = await login(email.trim(), password);
        if (!success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Alert.alert(
            "Login Failed",
            "Invalid email/username or password. Please try again or create an account."
          );
          return;
        }
      } else {
        const signupResult = await signup({
          name: fullName.trim(),
          companyName: companyName.trim(),
          branch: branch.trim() || "Main Branch",
          pincode: pincode.trim(),
          role,
          email: email.trim().toLowerCase(),
          password,
        });
        if (!signupResult.ok) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Alert.alert("Signup Failed", signupResult.message || "Unable to create account");
          return;
        }
        if (!signupResult.authenticated) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert(
            "Request Submitted",
            signupResult.message ||
              "Your request was sent to admin. Your Dolibarr user stays disabled until approval."
          );
          setMode("signin");
          setPassword("");
          return;
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(tabs)");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppCanvas>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingTop: 0, paddingBottom: insets.bottom + 44 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            entering={FadeInUp.duration(600)}
            style={[styles.header, { paddingTop: insets.top + 8 }]}
          >
            <View style={styles.heroGlowLayer} pointerEvents="none">
              <View
                style={[styles.heroGlowOrb, styles.heroGlowOrbPrimary, { backgroundColor: "rgba(64, 156, 255, 0.28)" }]}
              />
              <View
                style={[styles.heroGlowOrb, styles.heroGlowOrbSecondary, { backgroundColor: "rgba(13, 87, 181, 0.2)" }]}
              />
            </View>

            <LinearGradient
              colors={AUTH_HERO_GRADIENT as unknown as string[]}
              start={{ x: 0.1, y: 0 }}
              end={{ x: 0.9, y: 1 }}
              style={styles.heroBackdrop}
            />
            <View style={styles.heroPanel}>
              <View style={styles.brandRow}>
                <View style={styles.logoContainer}>
                  <Image
                    source={require("../assets/images/logo.png")}
                    style={styles.logoImage}
                    resizeMode="contain"
                  />
                </View>
                <Text style={[styles.brandRowTitle, { color: "#F7FBFF" }]}>{AUTH_BRAND_NAME}</Text>
              </View>

              <View
                style={[
                  styles.heroBadge,
                  styles.heroBadgeMinimal,
                  { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.16)" },
                ]}
              >
                <View style={[styles.heroBadgeDot, { backgroundColor: "#FFFFFF" }]} />
                <Text style={[styles.heroBadgeText, { color: "#EAF3FF" }]}>
                  Enterprise sales workspace
                </Text>
              </View>
              <Text style={[styles.subtitle, { color: "rgba(240,247,255,0.84)" }]}>{screenSubtitle}</Text>
            </View>
          </Animated.View>

          <Animated.View
            entering={FadeInDown.duration(600).delay(200)}
            style={[
              styles.formContainer,
              {
                backgroundColor: "#FFFFFF",
                borderColor: "rgba(15, 76, 129, 0.08)",
                paddingBottom: 34,
                marginBottom: 6,
              },
            ]}
          >
            <View style={styles.formHeader}>
              <Text style={[styles.formEyebrow, { color: colors.primary }]}>
                {mode === "signin" ? "Welcome Back" : "Create Access Request"}
              </Text>
              <Text style={[styles.formTitle, { color: colors.text }]}>
                {mode === "signin" ? "Access your workspace" : "Request your company workspace"}
              </Text>
            </View>

            <View style={[styles.modeSwitch, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
              <Pressable
                onPress={() => {
                  setMode("signin");
                  setRoleDropdownOpen(false);
                }}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: mode === "signin" ? colors.primary : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    { color: mode === "signin" ? "#FFFFFF" : colors.textSecondary },
                  ]}
                >
                  Sign In
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setMode("signup");
                  setRoleDropdownOpen(false);
                }}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: mode === "signup" ? colors.primary : "transparent",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.modeChipText,
                    { color: mode === "signup" ? "#FFFFFF" : colors.textSecondary },
                  ]}
                >
                  Sign Up
                </Text>
              </Pressable>
            </View>

            {mode === "signup" ? (
              <>
                <InputField
                  colors={colors}
                  label="Full Name"
                  placeholder="Your name"
                  icon="person-outline"
                  value={fullName}
                  onChangeText={setFullName}
                />
                <InputField
                  colors={colors}
                  label="Company Name"
                  placeholder="Your company"
                  icon="business-outline"
                  value={companyName}
                  onChangeText={setCompanyName}
                />
                <InputField
                  colors={colors}
                  label="Location / Area"
                  placeholder="e.g. Maninagar, Ahmedabad"
                  icon="location-outline"
                  value={branch}
                  onChangeText={setBranch}
                />
                <InputField
                  colors={colors}
                  label="Pincode"
                  placeholder="e.g. 380015"
                  icon="navigate-outline"
                  value={pincode}
                  onChangeText={setPincode}
                  keyboardType="number-pad"
                />
                <View style={styles.inputWrapper}>
                  <Text style={[styles.inputLabel, { color: colors.textSecondary }]}>Role</Text>
                  <View style={styles.roleSelectWrap}>
                    <Pressable
                      onPress={() => setRoleDropdownOpen((current) => !current)}
                      style={[
                        styles.roleSelectButton,
                        {
                          backgroundColor: colors.backgroundElevated,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.roleSelectText, { color: colors.text }]}>
                        {selectedRoleLabel}
                      </Text>
                      <Ionicons
                        name={roleDropdownOpen ? "chevron-up-outline" : "chevron-down-outline"}
                        size={18}
                        color={colors.textSecondary}
                      />
                    </Pressable>
                    {roleDropdownOpen ? (
                      <View
                        style={[
                          styles.roleDropdown,
                          {
                            backgroundColor: colors.backgroundElevated,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        {SIGNUP_ROLES.map((entry) => (
                          <Pressable
                            key={entry.value}
                            onPress={() => {
                              setRole(entry.value);
                              setRoleDropdownOpen(false);
                            }}
                            style={[
                              styles.roleDropdownItem,
                              {
                                backgroundColor:
                                  role === entry.value ? colors.surfaceSecondary : "transparent",
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.roleDropdownText,
                                {
                                  color: role === entry.value ? colors.primary : colors.textSecondary,
                                },
                              ]}
                            >
                              {entry.label}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </View>
                </View>
              </>
            ) : null}

            <InputField
              colors={colors}
              label={signInLabel}
              placeholder={signInPlaceholder}
              icon="mail-outline"
              value={email}
              onChangeText={setEmail}
              keyboardType={signInKeyboardType}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.inputWrapper}>
              <Text style={[styles.inputLabel, { color: colors.textSecondary }]}>Security Password</Text>
              <View
                style={[
                  styles.inputContainer,
                  { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                ]}
              >
                <Ionicons name="lock-closed-outline" size={20} color={colors.textTertiary} />
                <TextInput
                  style={[styles.input, { color: colors.text, fontFamily: "Inter_400Regular" }]}
                  placeholder="********"
                  placeholderTextColor={colors.textTertiary}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} hitSlop={8}>
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color={colors.textTertiary}
                  />
                </Pressable>
              </View>
            </View>

            <Pressable
              onPress={handleAuthAction}
              disabled={loading}
              style={({ pressed }) => [
                styles.loginButton,
                {
                  opacity: pressed || loading ? 0.9 : 1,
                },
              ]}
            >
              <LinearGradient
                colors={AUTH_BUTTON_GRADIENT as unknown as string[]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.loginButtonGradient}
              >
                {loading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.loginButtonText}>
                    {mode === "signin" ? "Authenticate" : "Request Access"}
                  </Text>
                )}
              </LinearGradient>
            </Pressable>

            <View style={[styles.formFooter, { borderTopColor: colors.borderLight }]}>
              <MaterialCommunityIcons name="lightning-bolt-circle" size={18} color={colors.primary} />
              <Text style={[styles.formFooterText, { color: colors.textSecondary }]}>
                {mode === "signin"
                  ? "Use your approved company credentials to continue."
                  : "New accounts stay pending until admin approval."}
              </Text>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppCanvas>
  );
}

function InputField({
  colors,
  label,
  placeholder,
  icon,
  value,
  onChangeText,
  keyboardType,
  autoCapitalize,
  autoCorrect,
}: {
  colors: ReturnType<typeof useAppTheme>["colors"];
  label: string;
  placeholder: string;
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: "default" | "email-address" | "number-pad";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
}) {
  return (
    <View style={styles.inputWrapper}>
      <Text style={[styles.inputLabel, { color: colors.textSecondary }]}>{label}</Text>
      <View style={[styles.inputContainer, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
        <Ionicons name={icon} size={20} color={colors.textTertiary} />
        <TextInput
          style={[styles.input, { color: colors.text, fontFamily: "Inter_400Regular" }]}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          value={value}
          onChangeText={onChangeText}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
  },
  header: {
    marginBottom: 0,
    minHeight: 230,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  heroGlowLayer: {
    position: "absolute",
    inset: 0,
  },
  heroGlowOrb: {
    position: "absolute",
    borderRadius: 999,
  },
  heroGlowOrbPrimary: {
    width: 180,
    height: 180,
    top: -18,
    right: -20,
  },
  heroGlowOrbSecondary: {
    width: 140,
    height: 140,
    left: -12,
    bottom: 8,
  },
  heroBackdrop: {
    position: "absolute",
    left: -18,
    right: -18,
    top: -18,
    bottom: 18,
    borderBottomLeftRadius: 68,
    borderBottomRightRadius: 68,
    opacity: 0.96,
    transform: [{ scaleX: 1.04 }],
  },
  heroPanel: {
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 6,
    alignItems: "center",
    width: "100%",
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    width: "100%",
  },
  logoContainer: {
    width: 100,
    height: 100,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  logoImage: {
    width: "100%",
    height: "100%",
  },
  brandRowTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.7,
  },
  heroBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  heroBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  heroBadgeText: {
    fontSize: 10.5,
    fontFamily: "Inter_600SemiBold",
  },
  heroBadgeMinimal: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: -10,
    marginBottom: 15,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 17,
    maxWidth: 280,
    textAlign: "center",
  },
  formContainer: {
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
    gap: 14,
    marginTop: -42,
    shadowColor: "#0F172A",
    shadowOpacity: 0.16,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
  formHeader: {
    gap: 4,
  },
  formEyebrow: {
    fontSize: 11.5,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  formTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.45,
  },
  modeSwitch: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 4,
    flexDirection: "row",
    marginBottom: 8,
  },
  modeChip: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  modeChipText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  inputWrapper: {
    gap: 8,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    marginLeft: 2,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 16,
    height: 52,
    gap: 12,
    borderWidth: 1.2,
  },
  input: {
    flex: 1,
    fontSize: 15,
  },
  roleSelectWrap: {
    gap: 8,
  },
  roleSelectButton: {
    minHeight: 48,
    borderRadius: 14,
    borderWidth: 1.2,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  roleSelectText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  roleDropdown: {
    borderRadius: 14,
    borderWidth: 1.2,
    padding: 6,
    gap: 4,
  },
  roleDropdownItem: {
    minHeight: 36,
    borderRadius: 10,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  roleDropdownText: {
    fontSize: 13.5,
    fontFamily: "Inter_500Medium",
  },
  loginButton: {
    marginTop: 8,
    height: 56,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  loginButtonGradient: {
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  loginButtonText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.2,
    color: "#FFFFFF",
  },
  formFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderTopWidth: 1,
    paddingTop: 14,
    marginTop: 4,
  },
  formFooterText: {
    flex: 1,
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
});
