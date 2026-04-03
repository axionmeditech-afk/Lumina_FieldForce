import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DolibarrOrder } from "@/lib/attendance-api";
import { haversineDistanceMeters } from "@/lib/geofence";
import { sendDeviceLocalNotification } from "@/lib/device-notifications";
import type { QuickSaleLocationLog, Task } from "@/lib/types";

const LOCATION_REMINDER_CATALOG_KEY = "@trackforce_location_reminder_catalog_v1";
const LOCATION_REMINDER_SENT_KEY = "@trackforce_location_reminder_sent_v1";
const LOCATION_REMINDER_RADIUS_METERS = 250;
const LOCATION_REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const RECENT_ORDER_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;

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

function normalizeMatchText(value: string | null | undefined): string {
  return (value || "")
    .toLowerCase()
    .replace(/^#\d+\s*/g, "")
    .replace(/^visit\s*\d+\s*[:\-]?\s*/g, "")
    .replace(/^dr\.?\s+/g, "")
    .replace(/^doctor\s+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getVisitTaskLabel(task: Task): string {
  return task.visitLocationLabel?.trim() || task.title?.trim() || "Planned visit";
}

function parseOrderDate(order: DolibarrOrder): string | null {
  const raw = order.date_commande ?? order.date_creation ?? order.date;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function parseOrderTotal(order: DolibarrOrder): number | null {
  const raw = order.total_ttc ?? order.total_ht ?? order.total;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatShortDate(value: string | null): string {
  if (!value) return "recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "recently";
  return parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

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

function getOrderCustomerLabel(order: DolibarrOrder): string {
  return order.thirdparty_name?.toString().trim() || order.socname?.trim() || order.label?.trim() || "";
}

function readSentKey(userId: string, entryId: string): string {
  return `${userId}:${entryId}`;
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
  const recentCutoff = Date.now() - RECENT_ORDER_WINDOW_MS;
  const visitItems = input.tasks
    .filter((task) => task.taskType === "field_visit")
    .filter((task) => task.status === "completed" || Boolean(task.departureAt))
    .filter(
      (task) =>
        typeof task.visitLatitude === "number" &&
        Number.isFinite(task.visitLatitude) &&
        typeof task.visitLongitude === "number" &&
        Number.isFinite(task.visitLongitude)
    )
    .map((task) => {
      const taskLabel = getVisitTaskLabel(task);
      const noteSnippet = truncateText(task.visitDepartureNotes || task.meetingNotes || "");
      const matchedOrders = input.recentOrders
        .map((order) => ({
          order,
          customerLabel: getOrderCustomerLabel(order),
          date: parseOrderDate(order),
          total: parseOrderTotal(order),
        }))
        .filter((entry) => {
          if (!entry.customerLabel) return false;
          const normalizedTaskLabel = normalizeMatchText(taskLabel);
          const normalizedCustomerLabel = normalizeMatchText(entry.customerLabel);
          if (!normalizedCustomerLabel || !normalizedTaskLabel) return false;
          const labelMatches =
            normalizedTaskLabel.includes(normalizedCustomerLabel) ||
            normalizedCustomerLabel.includes(normalizedTaskLabel);
          if (!labelMatches) return false;
          if (!entry.date) return true;
          return new Date(entry.date).getTime() >= recentCutoff;
        })
        .sort((left, right) => {
          const leftTime = left.date ? new Date(left.date).getTime() : 0;
          const rightTime = right.date ? new Date(right.date).getTime() : 0;
          return rightTime - leftTime;
        });

      const latestOrder = matchedOrders[0] || null;
      const title = `${taskLabel} nearby`;
      let body = `You are near a past visit for ${taskLabel}.`;
      if (latestOrder) {
        const amountLabel = formatCurrency(latestOrder.total);
        const countLabel =
          matchedOrders.length > 1 ? `${matchedOrders.length} recent orders` : "a recent order";
        body = `${taskLabel} also has ${countLabel}. Latest ${formatShortDate(latestOrder.date)}${
          amountLabel ? ` for ${amountLabel}` : ""
        }.`;
      }
      if (noteSnippet) {
        body = `${body} Last note: ${noteSnippet}`;
      }
      return {
        id: `visit_${task.id}`,
        taskId: task.id,
        salespersonId: input.salespersonId,
        companyId: input.companyId ?? null,
        label: taskLabel,
        latitude: task.visitLatitude as number,
        longitude: task.visitLongitude as number,
        title,
        body,
        updatedAt: new Date().toISOString(),
      } satisfies LocationReminderCatalogEntry;
    });

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

  const items = [...visitItems, ...quickSaleItems];

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

  const catalog = await readCatalog();
  if (!catalog.items.length) return;

  const sentStore = await readSentStore();
  const now = Date.now();
  const eligible = catalog.items
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
    data: {
      taskId: nearest.entry.taskId,
      kind: "location-reminder",
      distanceMeters: Math.round(nearest.distanceMeters),
    },
  });

  sentStore[readSentKey(input.userId, nearest.entry.id)] = new Date().toISOString();
  await writeSentStore(sentStore);
}
