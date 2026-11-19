import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { getApiBaseUrlCandidates } from "@/lib/attendance-api";
import {
  ensureAttendanceNotificationPermission,
  getNotificationsModule,
} from "@/lib/attendance-notifications";
import { getApiToken, getOrCreateDeviceId } from "@/lib/storage";

const EMPLOYEE_ALERTS_CHANNEL = "employee_alerts";
const PUSH_REGISTRATION_KEY = "@lumina_employee_push_registration_v1";

type StoredRegistration = {
  token: string;
  userId: string;
  deviceId: string;
};

let registrationInFlight: Promise<boolean> | null = null;

async function authenticatedRequest(path: string, init: RequestInit): Promise<Response> {
  const token = await getApiToken();
  if (!token) throw new Error("No authenticated API session is available.");
  const candidates = await getApiBaseUrlCandidates();
  let lastError: unknown = null;
  for (const base of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7_000);
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.headers || {}),
        },
        signal: controller.signal,
      });
      if (response.status === 404 || response.status >= 500) {
        lastError = new Error(`Notification API returned HTTP ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Notification API is unavailable.");
}

export async function ensureEmployeeNotificationChannel(): Promise<void> {
  const notifications = await getNotificationsModule();
  if (!notifications || Platform.OS !== "android") return;
  await notifications.setNotificationChannelAsync(EMPLOYEE_ALERTS_CHANNEL, {
    name: "Employee alerts and field visits",
    description: "New field visits and important alerts from your supervisor.",
    importance: notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250],
    lightColor: "#2563EB",
    lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
    sound: "default",
  });
}

export async function registerEmployeePushNotifications(userId: string): Promise<boolean> {
  if (!userId || Platform.OS === "web") return false;
  if (registrationInFlight) return registrationInFlight;
  registrationInFlight = (async () => {
    const notifications = await getNotificationsModule();
    if (!notifications) return false;
    if (!(await ensureAttendanceNotificationPermission(true))) return false;
    await ensureEmployeeNotificationChannel();
    const projectId =
      Constants.easConfig?.projectId ||
      (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
    if (!projectId) {
      console.warn("[push] EAS projectId is missing; employee push registration skipped.");
      return false;
    }
    const expoToken = (await notifications.getExpoPushTokenAsync({ projectId })).data;
    const deviceId = await getOrCreateDeviceId();
    const response = await authenticatedRequest("/notifications/devices", {
      method: "POST",
      body: JSON.stringify({ token: expoToken, deviceId, platform: Platform.OS }),
    });
    if (!response.ok) throw new Error(`Push registration failed with HTTP ${response.status}`);
    await AsyncStorage.setItem(PUSH_REGISTRATION_KEY, JSON.stringify({ token: expoToken, userId, deviceId }));
    return true;
  })().catch((error) => {
    // Missing/invalid FCM credentials must not prevent login or app startup.
    console.warn("[push] employee notification registration unavailable", error instanceof Error ? error.message : error);
    return false;
  }).finally(() => {
    registrationInFlight = null;
  });
  return registrationInFlight;
}

export async function unregisterEmployeePushNotifications(): Promise<void> {
  const raw = await AsyncStorage.getItem(PUSH_REGISTRATION_KEY);
  if (!raw) return;
  let registration: StoredRegistration | null = null;
  try {
    registration = JSON.parse(raw) as StoredRegistration;
  } catch {
    await AsyncStorage.removeItem(PUSH_REGISTRATION_KEY);
    return;
  }
  try {
    await authenticatedRequest("/notifications/devices", {
      method: "DELETE",
      body: JSON.stringify({ token: registration.token, deviceId: registration.deviceId }),
    });
  } finally {
    await AsyncStorage.removeItem(PUSH_REGISTRATION_KEY);
  }
}

export async function installEmployeeNotificationTapHandler(
  navigate: (screen: "field-visits" | "attendance" | "notifications") => void,
): Promise<() => void> {
  const notifications = await getNotificationsModule();
  if (!notifications) return () => undefined;
  const open = (data: Record<string, unknown>) => {
    const screen = String(data.screen || "notifications");
    if (screen === "field-visits" || screen === "attendance" || screen === "notifications") {
      navigate(screen);
    }
  };
  const subscription = notifications.addNotificationResponseReceivedListener((response) => {
    open((response.notification.request.content.data || {}) as Record<string, unknown>);
  });
  const initial = await notifications.getLastNotificationResponseAsync();
  if (initial) {
    open((initial.notification.request.content.data || {}) as Record<string, unknown>);
    notifications.clearLastNotificationResponse();
  }
  return () => subscription.remove();
}
