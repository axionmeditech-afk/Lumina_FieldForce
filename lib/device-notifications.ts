import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

let notificationsInitialized = false;
let pushTokenRequested = false;
const localNotificationGroupLastId = new Map<string, string>();

function normalizeNotificationText(value: string | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function normalizeNotificationGroupKey(value: string | undefined): string {
  return normalizeNotificationText(value).toLowerCase().slice(0, 120);
}

function buildVisibleNotificationContent(input: { title: string; body: string }): {
  title: string;
  body: string;
} {
  const rawTitle = normalizeNotificationText(input.title);
  const rawBody = normalizeNotificationText(input.body);
  const isGenericTitle =
    rawTitle.length === 0 || rawTitle.toLowerCase() === "notification";

  const title = isGenericTitle
    ? (rawBody ? rawBody.slice(0, 90) : "New Update")
    : rawTitle;
  const body = rawBody || (rawTitle && !isGenericTitle ? rawTitle : "You have a new update.");

  return { title, body };
}

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
  groupKey?: string;
  replaceExistingInGroup?: boolean;
}): Promise<void> {
  if (!isNativeRuntime()) return;
  await initializeDeviceNotifications();
  const granted =
    (await areDeviceNotificationsGranted()) || (await requestDeviceNotificationPermissionIfNeeded());
  if (!granted) return;
  const content = buildVisibleNotificationContent({
    title: input.title,
    body: input.body,
  });
  const groupKey = normalizeNotificationGroupKey(input.groupKey);
  const shouldReplaceInGroup = input.replaceExistingInGroup !== false;
  const previousGroupNotificationId =
    groupKey && shouldReplaceInGroup ? localNotificationGroupLastId.get(groupKey) : undefined;

  if (groupKey && previousGroupNotificationId) {
    try {
      await Notifications.dismissNotificationAsync(previousGroupNotificationId);
    } catch {
      // Ignore stale identifiers; we still want to deliver the latest notification.
    } finally {
      localNotificationGroupLastId.delete(groupKey);
    }
  }

  const schedule = async (): Promise<string> =>
    Notifications.scheduleNotificationAsync({
      content: {
        title: content.title,
        body: content.body,
        sound: "default",
        data: input.data || {},
        ...(Platform.OS === "android" && input.channelId ? { channelId: input.channelId } : {}),
        ...(Platform.OS === "ios" && groupKey ? { threadIdentifier: groupKey } : {}),
      },
      trigger: null,
    });

  try {
    const localId = await schedule();
    if (groupKey) {
      localNotificationGroupLastId.set(groupKey, localId);
    }
  } catch {
    if (Platform.OS === "android") {
      await ensureAndroidNotificationChannels();
      const localId = await schedule();
      if (groupKey) {
        localNotificationGroupLastId.set(groupKey, localId);
      }
    }
  }
}
