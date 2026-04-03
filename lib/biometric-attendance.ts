import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export interface BiometricSupportStatus {
  available: boolean;
  enrolled: boolean;
  method: string | null;
  supportedTypes?: LocalAuthentication.AuthenticationType[];
  hasDeviceCredential?: boolean;
  enrolledLevel?: LocalAuthentication.SecurityLevel;
  reason?: string;
  errorCode?: string;
}

export interface BiometricVerificationResult {
  success: boolean;
  method: string | null;
  errorCode?: string;
  errorMessage?: string;
  cachedForToday?: boolean;
}

function pickPrimaryMethod(
  types: LocalAuthentication.AuthenticationType[],
  enrolledLevel: LocalAuthentication.SecurityLevel
): string | null {
  const supportedBiometricMethods: string[] = [];

  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    supportedBiometricMethods.push("fingerprint");
  }
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
    supportedBiometricMethods.push("face");
  }
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
    supportedBiometricMethods.push("iris");
  }

  if (supportedBiometricMethods.length === 1) {
    return supportedBiometricMethods[0];
  }
  if (supportedBiometricMethods.length > 1) {
    return "biometric";
  }
  if (enrolledLevel === LocalAuthentication.SecurityLevel.SECRET) {
    return "device_credential";
  }
  return null;
}

type DailyVerificationEntry = {
  dateKey: string;
  method: string | null;
  verifiedAt: string;
};

type DailyVerificationStore = Record<string, DailyVerificationEntry>;

const DAILY_VERIFICATION_KEY = "@trackforce_attendance_daily_verification";

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function getDailyVerificationStore(): Promise<DailyVerificationStore> {
  const raw = await AsyncStorage.getItem(DAILY_VERIFICATION_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DailyVerificationStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function setDailyVerificationStore(store: DailyVerificationStore): Promise<void> {
  await AsyncStorage.setItem(DAILY_VERIFICATION_KEY, JSON.stringify(store));
}

function mapAuthErrorMessage(code: string): string {
  if (code === "passcode_not_set") {
    return "Phone screen lock is not set. Please set device PIN, pattern, password, face unlock, or fingerprint in device settings.";
  }
  if (code === "not_enrolled") {
    return "No device authentication is set up. Please enable face unlock, fingerprint, iris, or device PIN/password in phone settings.";
  }
  if (code === "not_available") {
    return "Device authentication is not available on this device.";
  }
  if (code === "user_cancel" || code === "system_cancel" || code === "app_cancel") {
    return "Verification was cancelled.";
  }
  if (code === "lockout" || code === "biometric_lockout") {
    return "Too many failed attempts. Try again after unlocking your phone.";
  }
  return code;
}

function isLegacyAndroidCredentialComboUnsupported(): boolean {
  return Platform.OS === "android" && typeof Platform.Version === "number" && Platform.Version < 30;
}

export async function getBiometricSupportStatus(): Promise<BiometricSupportStatus> {
  try {
    const [hasHardware, enrolled, supportedTypes, enrolledLevel] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);
    const method = pickPrimaryMethod(supportedTypes, enrolledLevel);
    const hasDeviceCredential = enrolledLevel === LocalAuthentication.SecurityLevel.SECRET;
    const hasKnownBiometricType = supportedTypes.length > 0;

    if (enrolled && method) {
      return {
        available: true,
        enrolled: true,
        method,
        supportedTypes,
        hasDeviceCredential,
        enrolledLevel,
      };
    }

    if (hasDeviceCredential) {
      return {
        available: true,
        enrolled: true,
        method: "device_credential",
        supportedTypes,
        hasDeviceCredential,
        enrolledLevel,
      };
    }

    if (hasHardware || hasKnownBiometricType) {
      return {
        available: true,
        enrolled: false,
        method,
        supportedTypes,
        hasDeviceCredential,
        enrolledLevel,
        reason:
          "No usable device authentication is set up. Please enable face unlock, fingerprint, iris, or device PIN/password in phone settings.",
        errorCode: "not_enrolled",
      };
    }

    return {
      available: false,
      enrolled: false,
      method: null,
      supportedTypes,
      hasDeviceCredential,
      enrolledLevel,
      reason:
        "This device does not have a supported biometric sensor or screen lock configured for secure verification.",
      errorCode: "not_available",
    };
  } catch (error) {
    return {
      available: false,
      enrolled: false,
      method: null,
      reason: error instanceof Error ? error.message : "Unable to verify biometric capability.",
      errorCode: "auth_exception",
    };
  }
}

async function authenticateWithPreferredMethod(
  action: "checkin" | "checkout",
  method: "fingerprint" | "face" | "device_credential",
  options?: { allowDeviceFallback?: boolean; strongOnly?: boolean }
): Promise<BiometricVerificationResult> {
  const isCheckIn = action === "checkin";
  const promptMessage = isCheckIn ? "Verify identity for Check-In" : "Verify identity for Check-Out";
  const basePromptDescription =
    "Secure attendance uses your device authentication to confirm identity.";
  const wantsDeviceFallback = options?.allowDeviceFallback === true;
  const canUseCombinedBiometricAndCredentialPrompt =
    method === "device_credential" || !isLegacyAndroidCredentialComboUnsupported();
  const disableDeviceFallback =
    method === "device_credential"
      ? false
      : wantsDeviceFallback && canUseCombinedBiometricAndCredentialPrompt
        ? false
        : true;
  const promptDescription =
    method === "fingerprint"
      ? disableDeviceFallback
        ? `${basePromptDescription} Use fingerprint to continue.`
        : `${basePromptDescription} You can use fingerprint or choose your phone PIN, pattern, or password.`
      : method === "face"
        ? disableDeviceFallback
          ? `${basePromptDescription} Use face unlock to continue.`
          : `${basePromptDescription} You can use face unlock or choose your phone PIN, pattern, or password.`
        : `${basePromptDescription} Use your device PIN, pattern, or password to continue.`;

  let response: LocalAuthentication.LocalAuthenticationResult;
  try {
    response = await LocalAuthentication.authenticateAsync({
      promptMessage,
      promptSubtitle:
        method === "fingerprint"
          ? "Use fingerprint to verify attendance"
          : method === "face"
            ? "Use face unlock to verify attendance"
            : "Use your device PIN, pattern, or password",
      promptDescription,
      cancelLabel: "Cancel",
      fallbackLabel: Platform.OS === "ios" ? "Use PIN / Password" : undefined,
      disableDeviceFallback,
      requireConfirmation: true,
      biometricsSecurityLevel:
        method === "device_credential" ? undefined : options?.strongOnly ? "strong" : "weak",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device authentication failed.";
    if (
      Platform.OS === "android" &&
      message.includes("BIOMETRIC_STRONG") &&
      message.includes("DEVICE_CREDENTIAL")
    ) {
      return {
        success: false,
        method,
        errorCode: "not_available",
        errorMessage:
          "This Android version does not support biometric and screen-lock fallback together. Please try again with your primary device authentication method.",
      };
    }
    return {
      success: false,
      method,
      errorCode: "auth_exception",
      errorMessage: message,
    };
  }

  if (response.success) {
    return {
      success: true,
      method,
      cachedForToday: false,
    };
  }

  const code = typeof response.error === "string" ? response.error : "authentication_failed";
  return {
    success: false,
    method,
    errorCode: code,
    errorMessage: mapAuthErrorMessage(code),
  };
}

export async function verifyBiometricForAttendance(
  action: "checkin" | "checkout",
  options?: { userId?: string; enforceDaily?: boolean }
): Promise<BiometricVerificationResult> {
  const enforceDaily = options?.enforceDaily !== false;
  const userId = options?.userId?.trim();
  const todayKey = toLocalDateKey(new Date());
  if (enforceDaily && userId) {
    const store = await getDailyVerificationStore();
    const entry = store[userId];
    if (entry?.dateKey === todayKey) {
      return {
        success: true,
        method: entry.method ?? "daily_verified",
        cachedForToday: true,
      };
    }
  }

  const support = await getBiometricSupportStatus();
  if (!support.available) {
    return {
      success: false,
      method: support.method,
      errorCode: support.errorCode ?? "biometric_unavailable",
      errorMessage: support.reason ?? "Device authentication is not available on this device.",
    };
  }

  if (!support.enrolled) {
    return {
      success: false,
      method: support.method,
      errorCode: support.errorCode ?? "not_enrolled",
      errorMessage: support.reason ?? mapAuthErrorMessage("not_enrolled"),
    };
  }

  try {
    const supportedTypes = support.supportedTypes ?? [];
    const hasFingerprint = supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const hasFace = supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const hasDeviceCredential = support.hasDeviceCredential ?? support.method === "device_credential";

    const persistSuccess = async (verifiedMethod: string) => {
      if (enforceDaily && userId) {
        const store = await getDailyVerificationStore();
        store[userId] = {
          dateKey: todayKey,
          method: verifiedMethod,
          verifiedAt: new Date().toISOString(),
        };
        await setDailyVerificationStore(store);
      }
      return {
        success: true as const,
        method: verifiedMethod,
        cachedForToday: false,
      };
    };

    let result: BiometricVerificationResult | null = null;

    if (hasFingerprint) {
      result = await authenticateWithPreferredMethod(action, "fingerprint", {
        allowDeviceFallback: true,
        strongOnly: true,
      });
      if (result.success) {
        return persistSuccess(result.method ?? "fingerprint");
      }
      return result;
    }

    if (hasFace) {
      result = await authenticateWithPreferredMethod(action, "face", {
        allowDeviceFallback: true,
        strongOnly: false,
      });
      if (result.success) {
        return persistSuccess(result.method ?? "face");
      }
      return result;
    }

    if (hasDeviceCredential) {
      result = await authenticateWithPreferredMethod(action, "device_credential", {
        allowDeviceFallback: true,
        strongOnly: false,
      });
    }

    if (result?.success) {
      return persistSuccess(result.method ?? support.method ?? "device_credential");
    }

    const code = result?.errorCode ?? "authentication_failed";
    return {
      success: false,
      method: result?.method ?? support.method,
      errorCode: code,
      errorMessage: mapAuthErrorMessage(code),
    };
  } catch (error) {
    return {
      success: false,
      method: support.method,
      errorCode: "auth_exception",
      errorMessage: error instanceof Error ? error.message : "Device authentication failed.",
    };
  }
}
