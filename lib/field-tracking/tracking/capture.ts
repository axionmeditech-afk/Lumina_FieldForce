import * as Crypto from 'expo-crypto';
import type * as Location from 'expo-location';
import type { RoutePoint } from '../types';
import { classifyLocation } from './filter';
import { getActiveSession, getLastEligiblePoint, getLastPoint, insertPointWithNextSequence } from './database';

let captureChain: Promise<RoutePoint | null> = Promise.resolve(null);
const listeners = new Set<() => void>();

export function subscribeToCapturedPoints(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function persistFieldLocation(location: Location.LocationObject): Promise<RoutePoint | null> {
  const next = captureChain.then(() => persistInternal(location)).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'active_session_missing') return null;
    throw error;
  });
  captureChain = next.catch(() => null);
  return next;
}

export async function waitForFieldCaptures(): Promise<void> {
  await captureChain;
}

async function persistInternal(location: Location.LocationObject): Promise<RoutePoint | null> {
  const session = await getActiveSession();
  if (!session) return null;
  const previous = await getLastEligiblePoint(session.id);
  const classification = classifyLocation(location, previous);
  const timestamp = Number.isFinite(location.timestamp) ? location.timestamp : Date.now();
  if (classification.rejectionReason === 'stationary_noise') {
    const last = await getLastPoint(session.id);
    if (last?.rejectionReason === 'stationary_noise' && timestamp - Date.parse(last.capturedAt) < 30_000) return null;
  }
  const point = await insertPointWithNextSequence({
    pointId: Crypto.randomUUID(),
    sessionId: session.id,
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy,
    speed: location.coords.speed,
    heading: location.coords.heading,
    battery: null,
    mocked: Boolean(location.mocked),
    capturedAt: new Date(timestamp).toISOString(),
    syncedAt: null,
    routeEligible: classification.routeEligible,
    rejectionReason: classification.rejectionReason,
  });
  for (const listener of listeners) listener();
  return point;
}
