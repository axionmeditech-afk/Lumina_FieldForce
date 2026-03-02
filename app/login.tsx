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
import type { UserRole } from "@/lib/types";

const DEMO_ACCOUNTS = [
  { label: "Admin", email: "admin@trackforce.ai", password: "admin123", icon: "shield-checkmark" as const },
  { label: "HR", email: "hr@trackforce.ai", password: "hr123", icon: "people" as const },
  { label: "Manager", email: "manager@trackforce.ai", password: "manager123", icon: "briefcase" as const },
  { label: "Sales", email: "sales@trackforce.ai", password: "sales123", icon: "trending-up" as const },
  { label: "Ahmedabad", email: "ahmedabad@trackforce.ai", password: "ahmed123", icon: "location" as const },
];

const SIGNUP_ROLES: { label: string; value: UserRole }[] = [
  { label: "Sales", value: "salesperson" },
  { label: "Manager", value: "manager" },
  { label: "HR", value: "hr" },
];
const AUTH_BRAND_NAME = "Lumina FieldForce";

export default function LoginScreen() {
  const { login, signup } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [branch, setBranch] = useState("");
  const [role, setRole] = useState<UserRole>("salesperson");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const screenSubtitle = useMemo(() => {
    if (mode === "signin") {
      return `Sign in to ${AUTH_BRAND_NAME} with your company account`;
    }
    return `Join ${AUTH_BRAND_NAME}. Submit account request for admin approval and company access.`;
  }, [mode]);

  const handleAuthAction = async () => {
    if (!email.trim() || !password.trim()) {
      Alert.alert("Missing Fields", "Please enter both email and password");
      return;
    }
    if (mode === "signup") {
      if (!fullName.trim() || !companyName.trim()) {
        Alert.alert("Missing Fields", "Please enter full name and company name");
        return;
      }
    }

    setLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      if (mode === "signin") {
        const success = await login(email.trim().toLowerCase(), password);
        if (!success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Alert.alert("Login Failed", "Invalid email or password. Try demo access or create account.");
          return;
        }
      } else {
        const signupResult = await signup({
          name: fullName.trim(),
          companyName: companyName.trim(),
          branch: branch.trim() || "Main Branch",
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
            signupResult.message || "Your request was sent to admin. Login after approval."
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

  const handleDemoLogin = async (demoEmail: string, demoPassword: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEmail(demoEmail);
    setPassword(demoPassword);
    setLoading(true);
    const success = await login(demoEmail, demoPassword);
    setLoading(false);
    if (success) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(tabs)");
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
            { paddingTop: insets.top + 46, paddingBottom: insets.bottom + 40 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View entering={FadeInUp.duration(600)} style={styles.header}>
            <View style={styles.logoContainer}>
              <LinearGradient
                colors={[colors.heroStart, colors.heroEnd]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.logoBox}
              >
                <MaterialCommunityIcons name="shield-check" size={32} color="#FFFFFF" />
              </LinearGradient>
            </View>
            <Text style={[styles.title, { color: colors.text }]}>{AUTH_BRAND_NAME}</Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{screenSubtitle}</Text>
          </Animated.View>

          <Animated.View
            entering={FadeInDown.duration(600).delay(200)}
            style={[styles.formContainer, { backgroundColor: colors.glass, borderColor: colors.border }]}
          >
            <View style={[styles.modeSwitch, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
              <Pressable
                onPress={() => setMode("signin")}
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
                onPress={() => setMode("signup")}
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
                  label="Primary Branch"
                  placeholder="e.g. Ahmedabad Branch"
                  icon="location-outline"
                  value={branch}
                  onChangeText={setBranch}
                />
                <View style={styles.inputWrapper}>
                  <Text style={[styles.inputLabel, { color: colors.textSecondary }]}>Role</Text>
                  <View style={styles.roleRow}>
                    {SIGNUP_ROLES.map((entry) => (
                      <Pressable
                        key={entry.value}
                        onPress={() => setRole(entry.value)}
                        style={[
                          styles.roleChip,
                          {
                            backgroundColor: role === entry.value ? colors.primary : colors.surfaceSecondary,
                            borderColor: role === entry.value ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.roleChipText,
                            { color: role === entry.value ? "#FFFFFF" : colors.textSecondary },
                          ]}
                        >
                          {entry.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </>
            ) : null}

            <InputField
              colors={colors}
              label="Email Address"
              placeholder="name@enterprise.com"
              icon="mail-outline"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
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
                colors={[colors.heroStart, colors.heroEnd]}
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
          </Animated.View>

          {mode === "signin" ? (
            <Animated.View entering={FadeInDown.duration(600).delay(400)} style={styles.demoSection}>
              <View style={styles.dividerContainer}>
                <View style={[styles.divider, { backgroundColor: colors.border }]} />
                <Text style={[styles.demoTitle, { color: colors.textTertiary }]}>Demo Access</Text>
                <View style={[styles.divider, { backgroundColor: colors.border }]} />
              </View>
              <View style={styles.demoGrid}>
                {DEMO_ACCOUNTS.map((acc) => (
                  <Pressable
                    key={acc.email}
                    onPress={() => void handleDemoLogin(acc.email, acc.password)}
                    style={({ pressed }) => [
                      styles.demoCard,
                      {
                        backgroundColor: colors.backgroundElevated,
                        borderColor: colors.border,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Ionicons name={acc.icon} size={20} color={colors.primary} />
                    <Text style={[styles.demoLabel, { color: colors.text }]}>{acc.label}</Text>
                  </Pressable>
                ))}
              </View>
            </Animated.View>
          ) : null}
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
  keyboardType?: "default" | "email-address";
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
    alignItems: "center",
    marginBottom: 30,
  },
  logoContainer: {
    marginBottom: 20,
  },
  logoBox: {
    width: 74,
    height: 74,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 34,
    fontFamily: "Inter_700Bold",
    letterSpacing: -1.2,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 8,
    textAlign: "center",
    maxWidth: 320,
  },
  formContainer: {
    borderRadius: 28,
    borderWidth: 1,
    padding: 22,
    gap: 14,
  },
  modeSwitch: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 4,
    flexDirection: "row",
    marginBottom: 6,
  },
  modeChip: {
    flex: 1,
    minHeight: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  modeChipText: {
    fontSize: 12.5,
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
  roleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  roleChip: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  roleChipText: {
    fontSize: 11.5,
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
  demoSection: {
    marginTop: 28,
  },
  dividerContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 22,
    gap: 12,
  },
  divider: {
    flex: 1,
    height: 1,
  },
  demoTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  demoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    justifyContent: "center",
  },
  demoCard: {
    flex: 1,
    minWidth: "47%",
    height: 58,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderWidth: 1.2,
    gap: 12,
  },
  demoLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
});
