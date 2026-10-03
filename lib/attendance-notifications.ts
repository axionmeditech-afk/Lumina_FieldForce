import { Platform } from "react-native";
import Constants from "expo-constants";

type NotificationsModule = typeof import("expo-notifications");

const ATTENDANCE_CHANNEL_ID = "attendance_auto_checkout";

let channelReady = false;
let permissionAskedThisRun = false;
let notificationsModule: NotificationsModule | null | undefined;
let handlerConfigured = false;

function isExpoGo(): boolean {
  return Constants.appOwnership === "expo" || Constants.executionEnvironment === "storeClient";
}

async function getNotificationsModule(): Promise<NotificationsModule | null> {
  if (Platform.OS === "web" || isExpoGo()) return null;
  if (notificationsModule !== undefined) return notificationsModule;
  try {
    notificationsModule = await import("expo-notifications");
  } catch {
    notificationsModule = null;
  }
  if (notificationsModule && !handlerConfigured) {
    notificationsModule.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
    handlerConfigured = true;
  }
  return notificationsModule;
}

export async function ensureAttendanceNotificationChannel(): Promise<void> {
  if (channelReady) return;
  const notifications = await getNotificationsModule();
  if (!notifications) return;
  if (Platform.OS === "android") {
    await notifications.setNotificationChannelAsync(ATTENDANCE_CHANNEL_ID, {
      name: "Attendance checkout alerts",
      importance: notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 180, 250],
      lightColor: "#2563EB",
      lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
      sound: "default",
    });
  }
  channelReady = true;
}

export async function ensureAttendanceNotificationPermission(request = false): Promise<boolean> {
  const notifications = await getNotificationsModule();
  if (!notifications) return false;
  await ensureAttendanceNotificationChannel().catch(() => undefined);
  let permissions = await notifications.getPermissionsAsync();
  if (!permissions.granted && request && !permissionAskedThisRun) {
    permissionAskedThisRun = true;
    permissions = await notifications.requestPermissionsAsync();
  }
  return permissions.granted || permissions.status === notifications.PermissionStatus.GRANTED;
}

export async function notifyAutoCheckoutPending(options: {
  detectedAt: string;
  distanceMeters?: number | null;
}): Promise<void> {
  const notifications = await getNotificationsModule();
  if (!notifications) return;
  if (!(await ensureAttendanceNotificationPermission(false))) return;
  const detected = new Date(options.detectedAt);
  const timeLabel = Number.isFinite(detected.getTime())
    ? detected.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "the detected time";
  const distanceLabel =
    typeof options.distanceMeters === "number" && Number.isFinite(options.distanceMeters)
      ? ` (${Math.round(options.distanceMeters)}m from office)`
      : "";
  await notifications.scheduleNotificationAsync({
    content: {
      title: "Checkout detected outside office",
      body: `Office exit confirmed at ${timeLabel}${distanceLabel}. Checkout is saved on this phone and syncing automatically.`,
      sound: "default",
      priority: notifications.AndroidNotificationPriority.HIGH,
      data: { screen: "attendance", kind: "auto_checkout_pending", detectedAt: options.detectedAt },
    },
    identifier: "attendance_auto_checkout",
    trigger: Platform.OS === "android" ? { channelId: ATTENDANCE_CHANNEL_ID } : null,
  });
}

export async function notifyAutoCheckoutSynced(options: {
  detectedAt?: string | null;
} = {}): Promise<void> {
  const notifications = await getNotificationsModule();
  if (!notifications) return;
  if (!(await ensureAttendanceNotificationPermission(false))) return;
  const detected = options.detectedAt ? new Date(options.detectedAt) : null;
  const timeLabel = detected && Number.isFinite(detected.getTime())
    ? detected.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  await notifications.scheduleNotificationAsync({
    content: {
      title: "Attendance checked out",
      body: timeLabel
        ? `Your checkout detected at ${timeLabel} has been synced.`
        : "Your auto-checkout has been synced.",
      sound: "default",
      priority: notifications.AndroidNotificationPriority.DEFAULT,
      data: { screen: "attendance", kind: "auto_checkout_synced" },
    },
    identifier: "attendance_auto_checkout",
    trigger: Platform.OS === "android" ? { channelId: ATTENDANCE_CHANNEL_ID } : null,
  });
}
