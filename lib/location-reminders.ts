import AsyncStorage from "@react-native-async-storage/async-storage";
import { getNearbyVisitHistory, type DolibarrOrder } from "@/lib/attendance-api";
import { haversineDistanceMeters } from "@/lib/geofence";
import { sendDeviceLocalNotification } from "@/lib/device-notifications";
import { getCurrentUser, getQuickSaleLocationLogs } from "@/lib/storage";
import type { QuickSaleLocationLog, Task, VisitHistoryRecord } from "@/lib/types";

const LOCATION_REMINDER_CATALOG_KEY = "@trackforce_location_reminder_catalog_v1";
const LOCATION_REMINDER_SENT_KEY = "@trackforce_location_reminder_sent_v1";
const LOCATION_REMINDER_RADIUS_METERS = 250;
const LOCATION_REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const LOCATION_REMINDER_CATALOG_REFRESH_MS = 15 * 60 * 1000;

type LocationReminderCatalogEntry = {
  id: string;
  taskId: string;
  salespersonId: string;
  companyId?: string | null;
  label: string;
  latitude: number;
  longitude: number;
  title: string;
  body: string;
  updatedAt: string;
};

type LocationReminderCatalogPayload = {
  items: LocationReminderCatalogEntry[];
  updatedAt: string;
};

type SentReminderStore = Record<string, string>;

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function truncateText(value: string | null | undefined, maxLength = 92): string {
  const cleaned = (value || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function readSentKey(userId: string, entryId: string): string {
  return `${userId}:${entryId}`;
}

function mapVisitHistoryReminderEntry(
  entry: VisitHistoryRecord,
  input: { salespersonId: string; companyId?: string | null }
): LocationReminderCatalogEntry | null {
  if (
    typeof entry.visitLatitude !== "number" ||
    !Number.isFinite(entry.visitLatitude) ||
    typeof entry.visitLongitude !== "number" ||
    !Number.isFinite(entry.visitLongitude)
  ) {
    return null;
  }

  const label = entry.visitLabel?.trim() || "Past visit";
  const noteSnippet = truncateText(entry.visitDepartureNotes || entry.meetingNotes || "");
  let body = `You are near a past visit for ${label}.`;
  if (noteSnippet) {
    body = `${body} Last note: ${noteSnippet}`;
  }

  return {
    id: `visit_${entry.taskId}`,
    taskId: entry.taskId,
    salespersonId: input.salespersonId,
    companyId: input.companyId ?? null,
    label,
    latitude: entry.visitLatitude,
    longitude: entry.visitLongitude,
    title: `${label} nearby`,
    body,
    updatedAt: entry.updatedAt || new Date().toISOString(),
  } satisfies LocationReminderCatalogEntry;
}

async function readCatalog(): Promise<LocationReminderCatalogPayload> {
  const raw = await AsyncStorage.getItem(LOCATION_REMINDER_CATALOG_KEY);
  if (!raw) {
    return { items: [], updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(raw) as LocationReminderCatalogPayload;
    return {
      items: Array.isArray(parsed?.items) ? parsed.items : [],
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { items: [], updatedAt: new Date().toISOString() };
  }
}

async function ensureReminderCatalogReady(input: {
  userId: string;
  companyId?: string | null;
}): Promise<LocationReminderCatalogPayload> {
  const current = await readCatalog();
  const isFresh =
    Number.isFinite(new Date(current.updatedAt).getTime()) &&
    Date.now() - new Date(current.updatedAt).getTime() < LOCATION_REMINDER_CATALOG_REFRESH_MS;
  const hasCurrentUserItems = current.items.some(
    (entry) =>
      entry.salespersonId === input.userId &&
      (!entry.companyId || !input.companyId || entry.companyId === input.companyId)
  );

  if (current.items.length && hasCurrentUserItems && isFresh) {
    return current;
  }

  const currentUser = await getCurrentUser().catch(() => null);
  const quickSales = await getQuickSaleLocationLogs().catch(() => [] as QuickSaleLocationLog[]);

  await syncLocationReminderCatalog({
    salespersonId: input.userId,
    companyId: input.companyId ?? currentUser?.companyId ?? null,
    tasks: [],
    recentOrders: [],
    quickSales,
  });

  return readCatalog();
}

async function readSentStore(): Promise<SentReminderStore> {
  const raw = await AsyncStorage.getItem(LOCATION_REMINDER_SENT_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as SentReminderStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSentStore(store: SentReminderStore): Promise<void> {
  await AsyncStorage.setItem(LOCATION_REMINDER_SENT_KEY, JSON.stringify(store));
}

export async function syncLocationReminderCatalog(input: {
  salespersonId: string;
  companyId?: string | null;
  tasks: Task[];
  recentOrders: DolibarrOrder[];
  quickSales?: QuickSaleLocationLog[];
}): Promise<void> {
  const quickSaleItems = (input.quickSales || [])
    .filter(
      (sale) =>
        typeof sale.latitude === "number" &&
        Number.isFinite(sale.latitude) &&
        typeof sale.longitude === "number" &&
        Number.isFinite(sale.longitude)
    )
    .map((sale) => {
      const amountLabel = formatCurrency(sale.totalAmount);
      const noteSnippet = truncateText(sale.visitDepartureNotes || "");
      return {
        id: `quick_sale_${sale.id}`,
        taskId: sale.visitTaskId || sale.id,
        salespersonId: input.salespersonId,
        companyId: input.companyId ?? null,
        label: sale.customerName,
        latitude: sale.latitude,
        longitude: sale.longitude,
        title: `${sale.customerName} nearby`,
        body: `${sale.customerName} had a quick sale here${amountLabel ? ` for ${amountLabel}` : ""}.${
          noteSnippet ? ` Last note: ${noteSnippet}` : ""
        }`,
        updatedAt: new Date().toISOString(),
      } satisfies LocationReminderCatalogEntry;
    });

  const items = [...quickSaleItems];

  await AsyncStorage.setItem(
    LOCATION_REMINDER_CATALOG_KEY,
    JSON.stringify({
      items,
      updatedAt: new Date().toISOString(),
    } satisfies LocationReminderCatalogPayload)
  );
}

export async function maybeSendLocationReminder(input: {
  latitude: number;
  longitude: number;
  userId: string;
  companyId?: string | null;
}): Promise<void> {
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) return;

  const catalog = await ensureReminderCatalogReady({
    userId: input.userId,
    companyId: input.companyId ?? null,
  });
  const nearbyVisitHistory = await getNearbyVisitHistory({
    latitude: input.latitude,
    longitude: input.longitude,
    radiusMeters: LOCATION_REMINDER_RADIUS_METERS,
    salespersonId: input.userId,
    limit: 8,
  }).catch(() => [] as VisitHistoryRecord[]);

  const visitHistoryItems = nearbyVisitHistory
    .map((entry) =>
      mapVisitHistoryReminderEntry(entry, {
        salespersonId: input.userId,
        companyId: input.companyId ?? null,
      })
    )
    .filter((entry): entry is LocationReminderCatalogEntry => Boolean(entry));

  const combinedItems = [...visitHistoryItems, ...catalog.items];
  if (!combinedItems.length) return;

  const sentStore = await readSentStore();
  const now = Date.now();
  const eligible = combinedItems
    .filter((entry) => entry.salespersonId === input.userId)
    .filter((entry) => !entry.companyId || !input.companyId || entry.companyId === input.companyId)
    .map((entry) => ({
      entry,
      distanceMeters: haversineDistanceMeters(
        input.latitude,
        input.longitude,
        entry.latitude,
        entry.longitude
      ),
    }))
    .filter((entry) => entry.distanceMeters <= LOCATION_REMINDER_RADIUS_METERS)
    .filter((entry) => {
      const sentAt = sentStore[readSentKey(input.userId, entry.entry.id)];
      if (!sentAt) return true;
      const sentMs = new Date(sentAt).getTime();
      if (!Number.isFinite(sentMs)) return true;
      return now - sentMs >= LOCATION_REMINDER_COOLDOWN_MS;
    })
    .sort((left, right) => left.distanceMeters - right.distanceMeters);

  const nearest = eligible[0];
  if (!nearest) return;

  await sendDeviceLocalNotification({
    title: nearest.entry.title,
    body: `${nearest.entry.body} (${Math.round(nearest.distanceMeters)} m away)`,
    channelId: "alerts",
    data: {
      taskId: nearest.entry.taskId,
      kind: "location-reminder",
      distanceMeters: Math.round(nearest.distanceMeters),
    },
  });

  sentStore[readSentKey(input.userId, nearest.entry.id)] = new Date().toISOString();
  await writeSentStore(sentStore);
}
