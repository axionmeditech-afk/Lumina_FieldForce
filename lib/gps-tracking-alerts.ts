import AsyncStorage from "@react-native-async-storage/async-storage";
import { sendDeviceLocalNotification } from "@/lib/device-notifications";
import { addAttendanceAnomaly } from "@/lib/storage";
import type { AppUser } from "@/lib/types";

const GPS_DISABLED_STATE_KEY = "@trackforce_gps_disabled_state_v1";
const GPS_DISABLED_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;

type GpsDisabledState = Record<
  string,
  {
    startedAt: string;
    lastNotifiedAt: string;
  }
>;

function toUserKey(userId: string): string {
  return userId.trim();
}

async function readState(): Promise<GpsDisabledState> {
  const raw = await AsyncStorage.getItem(GPS_DISABLED_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as GpsDisabledState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state: GpsDisabledState): Promise<void> {
  await AsyncStorage.setItem(GPS_DISABLED_STATE_KEY, JSON.stringify(state));
}

function shouldNotify(lastNotifiedAt: string | null, nowMs: number): boolean {
  if (!lastNotifiedAt) return true;
  const lastMs = new Date(lastNotifiedAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= GPS_DISABLED_NOTIFY_COOLDOWN_MS;
}

export async function recordGpsDisabledDuringCheckIn(
  user: Pick<AppUser, "id" | "companyId">,
  reason = "Device location services are off."
): Promise<void> {
  const userKey = toUserKey(user.id);
  if (!userKey) return;

  const state = await readState();
  const current = state[userKey];
  const now = new Date();
  const nowIso = now.toISOString();
  const notify = shouldNotify(current?.lastNotifiedAt ?? null, now.getTime());

  if (!current) {
    await addAttendanceAnomaly({
      id: `gps_disabled_${userKey}_${now.getTime()}`,
      userId: user.id,
      companyId: user.companyId ?? undefined,
      attendanceId: null,
      type: "gps_disabled",
      severity: "high",
      details: `${reason} Route tracking paused until GPS is enabled again.`,
      createdAt: nowIso,
    });
  }

  if (notify) {
    await sendDeviceLocalNotification({
      title: "GPS Required",
      body: "You are checked in. Please keep phone Location/GPS ON for route tracking.",
      channelId: "alerts",
      groupKey: "gps-disabled",
      data: {
        kind: "gps-disabled",
        userId: user.id,
      },
    });
  }

  state[userKey] = {
    startedAt: current?.startedAt ?? nowIso,
    lastNotifiedAt: notify ? nowIso : current?.lastNotifiedAt ?? nowIso,
  };
  await writeState(state);
}

export async function recordGpsRestoredDuringCheckIn(
  user: Pick<AppUser, "id" | "companyId">
): Promise<void> {
  const userKey = toUserKey(user.id);
  if (!userKey) return;

  const state = await readState();
  const current = state[userKey];
  if (!current) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const startedMs = new Date(current.startedAt).getTime();
  const durationMinutes = Number.isFinite(startedMs)
    ? Math.max(1, Math.round((now.getTime() - startedMs) / 60000))
    : null;

  await addAttendanceAnomaly({
    id: `gps_restored_${userKey}_${now.getTime()}`,
    userId: user.id,
    companyId: user.companyId ?? undefined,
    attendanceId: null,
    type: "gps_restored",
    severity: "medium",
    details:
      durationMinutes !== null
        ? `GPS/location services restored after ${durationMinutes} minute(s).`
        : "GPS/location services restored.",
    createdAt: nowIso,
  });

  delete state[userKey];
  await writeState(state);
}

export async function hasGpsDisabledDuringCheckIn(userId: string): Promise<boolean> {
  const userKey = toUserKey(userId);
  if (!userKey) return false;
  const state = await readState();
  return Boolean(state[userKey]);
}
