import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

const ATTENDANCE_CHANNEL_ID = "attendance_auto_checkout";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let channelReady = false;
let permissionAskedThisRun = false;

export async function ensureAttendanceNotificationChannel(): Promise<void> {
  if (Platform.OS === "web" || channelReady) return;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(ATTENDANCE_CHANNEL_ID, {
      name: "Attendance checkout alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 180, 250],
      lightColor: "#2563EB",
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      sound: "default",
    });
  }
  channelReady = true;
}

export async function ensureAttendanceNotificationPermission(request = false): Promise<boolean> {
  if (Platform.OS === "web") return false;
  await ensureAttendanceNotificationChannel().catch(() => undefined);
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && request && !permissionAskedThisRun) {
    permissionAskedThisRun = true;
    permissions = await Notifications.requestPermissionsAsync();
  }
  return permissions.granted || permissions.status === Notifications.PermissionStatus.GRANTED;
}

export async function notifyAutoCheckoutPending(options: {
  detectedAt: string;
  distanceMeters?: number | null;
}): Promise<void> {
  if (!(await ensureAttendanceNotificationPermission(false))) return;
  const detected = new Date(options.detectedAt);
  const timeLabel = Number.isFinite(detected.getTime())
    ? detected.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "the detected time";
  const distanceLabel =
    typeof options.distanceMeters === "number" && Number.isFinite(options.distanceMeters)
      ? ` (${Math.round(options.distanceMeters)}m from office)`
      : "";
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Checkout detected outside office",
      body: `You left the office at ${timeLabel}${distanceLabel}. Open Lumina once to sync checkout.`,
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.HIGH,
      data: { screen: "attendance", kind: "auto_checkout_pending", detectedAt: options.detectedAt },
    },
    trigger: null,
  });
}

export async function notifyAutoCheckoutSynced(options: {
  detectedAt?: string | null;
} = {}): Promise<void> {
  if (!(await ensureAttendanceNotificationPermission(false))) return;
  const detected = options.detectedAt ? new Date(options.detectedAt) : null;
  const timeLabel = detected && Number.isFinite(detected.getTime())
    ? detected.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Attendance checked out",
      body: timeLabel
        ? `Your checkout detected at ${timeLabel} has been synced.`
        : "Your auto-checkout has been synced.",
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.DEFAULT,
      data: { screen: "attendance", kind: "auto_checkout_synced" },
    },
    trigger: null,
  });
}
