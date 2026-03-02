import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface BiometricSupportStatus {
  available: boolean;
  enrolled: boolean;
  method: string | null;
  reason?: string;
}

export interface BiometricVerificationResult {
  success: boolean;
  method: string | null;
  errorCode?: string;
  errorMessage?: string;
  cachedForToday?: boolean;
}

function pickPrimaryMethod(types: LocalAuthentication.AuthenticationType[]): string | null {
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
    return "fingerprint";
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
    return "Phone screen lock is not set. Please set phone PIN/pattern or fingerprint in device settings.";
  }
  if (code === "not_enrolled") {
    return "No fingerprint is enrolled. Please enroll fingerprint in phone settings.";
  }
  if (code === "not_available") {
    return "Biometric authentication is not available on this device.";
  }
  if (code === "user_cancel" || code === "system_cancel" || code === "app_cancel") {
    return "Verification was cancelled.";
  }
  if (code === "lockout" || code === "biometric_lockout") {
    return "Too many failed attempts. Try again after unlocking your phone.";
  }
  return code;
}

export async function getBiometricSupportStatus(): Promise<BiometricSupportStatus> {
  try {
    const [hasHardware, enrolled, supportedTypes] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const method = pickPrimaryMethod(supportedTypes);

    if (!hasHardware) {
      return {
        available: false,
        enrolled: false,
        method: null,
        reason: "Biometric hardware is not available on this device.",
      };
    }

    if (!enrolled) {
      return {
        available: true,
        enrolled: false,
        method: null,
        reason: "No fingerprint is enrolled. Please enroll fingerprint in phone settings.",
      };
    }

    if (!method) {
      return {
        available: true,
        enrolled: false,
        method: null,
        reason: "Fingerprint is not available on this device.",
      };
    }

    return {
      available: true,
      enrolled: true,
      method,
    };
  } catch (error) {
    return {
      available: false,
      enrolled: false,
      method: null,
      reason: error instanceof Error ? error.message : "Unable to verify biometric capability.",
    };
  }
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
      errorCode: "biometric_unavailable",
      errorMessage: support.reason ?? "Biometric auth is not available on this device.",
    };
  }

  if (!support.enrolled) {
    return {
      success: false,
      method: support.method,
      errorCode: "not_enrolled",
      errorMessage: mapAuthErrorMessage("not_enrolled"),
    };
  }

  try {
    const response = await LocalAuthentication.authenticateAsync({
      promptMessage:
        action === "checkin" ? "Verify fingerprint for Check-In" : "Verify fingerprint for Check-Out",
      cancelLabel: "Cancel",
      disableDeviceFallback: true,
    });

    if (response.success) {
      const verifiedMethod = support.method ?? (support.enrolled ? "fingerprint" : "device_credential");
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
        success: true,
        method: verifiedMethod,
        cachedForToday: false,
      };
    }

    const code = typeof response.error === "string" ? response.error : "auth_failed";
    return {
      success: false,
      method: support.method,
      errorCode: code,
      errorMessage: mapAuthErrorMessage(code),
    };
  } catch (error) {
    return {
      success: false,
      method: support.method,
      errorCode: "auth_exception",
      errorMessage: error instanceof Error ? error.message : "Biometric authentication failed.",
    };
  }
}
