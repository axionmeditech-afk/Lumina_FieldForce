import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

let notificationsInitialized = false;
let pushTokenRequested = false;

function isNativeRuntime(): boolean {
  return Platform.OS === "android" || Platform.OS === "ios";
}

function isExpoGoClient(): boolean {
  const ownership = Constants.appOwnership;
  const executionEnvironment = (Constants as { executionEnvironment?: string }).executionEnvironment;
  return ownership === "expo" || executionEnvironment === "storeClient";
}

function isAndroid13OrAbove(): boolean {
  if (Platform.OS !== "android") return false;
  const version =
    typeof Platform.Version === "number" ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
  return Number.isFinite(version) && version >= 33;
}

async function ensureAndroidNotificationChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "General",
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 180, 250],
    lightColor: "#3B82F6",
    sound: "default",
  });
  await Notifications.setNotificationChannelAsync("alerts", {
    name: "Alerts",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 320, 180, 320],
    lightColor: "#EF4444",
    sound: "default",
  });
}

export async function initializeDeviceNotifications(): Promise<void> {
  if (!isNativeRuntime()) return;
  if (notificationsInitialized) return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  await ensureAndroidNotificationChannels();

  notificationsInitialized = true;
}

export async function areDeviceNotificationsGranted(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  await initializeDeviceNotifications();
  if (Platform.OS === "android" && !isAndroid13OrAbove()) {
    return true;
  }
  try {
    const permission = await Notifications.getPermissionsAsync();
    return permission.granted;
  } catch {
    return false;
  }
}

export async function requestDeviceNotificationPermissionIfNeeded(): Promise<boolean> {
  if (!isNativeRuntime()) return false;
  await initializeDeviceNotifications();
  if (Platform.OS === "android" && !isAndroid13OrAbove()) {
    return true;
  }

  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.canAskAgain === false) return false;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function registerForPushTokenIfPossible(): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  if (isExpoGoClient()) return null;
  if (pushTokenRequested) return null;
  pushTokenRequested = true;

  try {
    const granted = await requestDeviceNotificationPermissionIfNeeded();
    if (!granted) return null;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.easConfig?.projectId ||
      undefined;
    if (!projectId) return null;

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data || null;
  } catch {
    return null;
  }
}

export async function sendDeviceLocalNotification(input: {
  title: string;
  body: string;
  data?: Record<string, string | number | boolean | null>;
  channelId?: string;
}): Promise<void> {
  if (!isNativeRuntime()) return;
  await initializeDeviceNotifications();
  const granted =
    (await areDeviceNotificationsGranted()) || (await requestDeviceNotificationPermissionIfNeeded());
  if (!granted) return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        body: input.body,
        sound: "default",
        data: input.data || {},
        ...(Platform.OS === "android" && input.channelId ? { channelId: input.channelId } : {}),
      },
      trigger: null,
    });
  } catch {
    if (Platform.OS === "android") {
      await ensureAndroidNotificationChannels();
      await Notifications.scheduleNotificationAsync({
        content: {
          title: input.title,
          body: input.body,
          sound: "default",
          data: input.data || {},
          ...(Platform.OS === "android" && input.channelId ? { channelId: input.channelId } : {}),
        },
        trigger: null,
      });
    }
  }
}
