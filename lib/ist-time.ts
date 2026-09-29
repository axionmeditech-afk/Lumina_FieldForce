const IST_OFFSET_MINUTES = 5 * 60 + 30;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_SHORT_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const MUMBAI_TIMEZONE_LABEL = "IST (Mumbai)";

type DateInput = Date | string | number | null | undefined;

interface MumbaiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0");
}

function toDate(value: DateInput): Date | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return null;
}

function toMumbaiParts(value: DateInput): MumbaiParts | null {
  const parsed = toDate(value);
  if (!parsed) return null;
  const shifted = new Date(parsed.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function parseDateKey(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function toMumbaiDateKey(value: DateInput): string {
  const parts = toMumbaiParts(value);
  if (!parts) return "";
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function isMumbaiDateKey(value: DateInput, dateKey: string): boolean {
  if (!dateKey) return false;
  return toMumbaiDateKey(value) === dateKey;
}

export function getMumbaiDateKeyByOffset(dayOffset: number): string {
  const numericOffset = Number.isFinite(dayOffset) ? Math.trunc(dayOffset) : 0;
  return toMumbaiDateKey(new Date(Date.now() + numericOffset * DAY_MS));
}

export function getMumbaiDateUtcRange(
  dateKey: string
): { startAt: string; endAt: string } | null {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  const startUtc = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0) - IST_OFFSET_MS
  );
  const endUtc = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, 23, 59, 59, 999) - IST_OFFSET_MS
  );
  return {
    startAt: startUtc.toISOString(),
    endAt: endUtc.toISOString(),
  };
}

export function getMumbaiDateEndIso(dateKey: string): string | null {
  return getMumbaiDateUtcRange(dateKey)?.endAt ?? null;
}

export function formatMumbaiDate(value: DateInput): string {
  const parts = toMumbaiParts(value);
  if (!parts) return "--";
  const monthName = MONTH_SHORT_NAMES[parts.month - 1] || MONTH_SHORT_NAMES[0];
  return `${monthName} ${parts.day}, ${parts.year}`;
}

export function formatMumbaiDateKey(dateKey: string): string {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  const monthName = MONTH_SHORT_NAMES[parsed.month - 1] || MONTH_SHORT_NAMES[0];
  return `${monthName} ${parsed.day}, ${parsed.year}`;
}

export function formatMumbaiTime(
  value: DateInput,
  options?: {
    withSeconds?: boolean;
    includeZoneLabel?: boolean;
  }
): string {
  const parts = toMumbaiParts(value);
  if (!parts) return "--:--";
  const hour12 = parts.hour % 12 || 12;
  const meridiem = parts.hour >= 12 ? "PM" : "AM";
  const base = options?.withSeconds
    ? `${pad2(hour12)}:${pad2(parts.minute)}:${pad2(parts.second)} ${meridiem}`
    : `${pad2(hour12)}:${pad2(parts.minute)} ${meridiem}`;
  return options?.includeZoneLabel ? `${base} IST` : base;
}

export function formatMumbaiDateTime(
  value: DateInput,
  options?: {
    withSeconds?: boolean;
    includeZoneLabel?: boolean;
  }
): string {
  const date = formatMumbaiDate(value);
  const time = formatMumbaiTime(value, options);
  if (date === "--" || time === "--:--") return "--";
  return `${date} ${time}`;
}
