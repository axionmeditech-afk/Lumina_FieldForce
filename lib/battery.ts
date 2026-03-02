import * as Battery from "expo-battery";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeBatteryLevelPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const scaled = value <= 1 ? value * 100 : value;
  return Math.round(clamp(scaled, 0, 100));
}

let lastResolvedAt = 0;
let lastResolvedValue: number | null = null;

export async function getBatteryLevelPercent(options?: { maxAgeMs?: number }): Promise<number | null> {
  const maxAgeMs = Math.max(0, options?.maxAgeMs ?? 30_000);
  const now = Date.now();
  if (maxAgeMs > 0 && now - lastResolvedAt <= maxAgeMs) {
    return lastResolvedValue;
  }
  try {
    const rawLevel = await Battery.getBatteryLevelAsync();
    const normalized = normalizeBatteryLevelPercent(rawLevel);
    lastResolvedAt = Date.now();
    lastResolvedValue = normalized;
    return normalized;
  } catch {
    return lastResolvedValue;
  }
}

