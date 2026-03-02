import { Platform } from "react-native";
import { getOrCreateDeviceId } from "@/lib/storage";

export interface ClientSecurityStatus {
  rootedOrJailbroken: boolean;
  mockLocationSuspected: boolean;
  deviceId: string;
  platform: string;
}

export async function getClientSecurityStatus(
  mockLocationSuspected: boolean
): Promise<ClientSecurityStatus> {
  const deviceId = await getOrCreateDeviceId();

  // Without native anti-tamper libraries, we keep this conservative.
  // This is still logged and can be escalated by server heuristics.
  const rootedOrJailbroken = false;

  return {
    rootedOrJailbroken,
    mockLocationSuspected,
    deviceId,
    platform: Platform.OS,
  };
}
