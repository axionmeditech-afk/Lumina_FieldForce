import { getApiBaseUrlCandidates } from '@/lib/attendance-api';
import { getApiToken } from '@/lib/storage';
import type { Coordinate, PlaceSearchResult, RoutePlan, RoutePoint, TrackingSession } from './types';

type RequestOptions = RequestInit & { timeoutMs?: number };

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getApiToken();
  if (!token) throw new Error('Please sign in again to use field tracking.');
  const bases = await getApiBaseUrlCandidates();
  if (!bases.length) throw new Error('Backend is not configured.');
  const method = (options.method || 'GET').toUpperCase();
  const candidates = ['GET', 'HEAD'].includes(method) ? bases : bases.slice(0, 1);
  let finalError: Error | null = null;
  for (const base of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    try {
      const response = await fetch(`${base}${path}`, {
        ...options,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      if (!response.ok) throw new Error(body?.message || body?.error || `Field tracking request failed (${response.status}).`);
      return body as T;
    } catch (error) {
      finalError = error instanceof Error
        ? new Error(error.name === 'AbortError' ? 'Field tracking request timed out.' : error.message)
        : new Error('Field tracking request failed.');
    } finally {
      clearTimeout(timeout);
    }
  }
  throw finalError ?? new Error('Field tracking backend is unavailable.');
}

export async function getFieldHealth(): Promise<{ apiReachable: boolean; routerReachable: boolean; geocoderReachable: boolean }> {
  try {
    return await requestJson('/field-tracking/health', { timeoutMs: 5_000 });
  } catch {
    return { apiReachable: false, routerReachable: false, geocoderReachable: false };
  }
}

export async function searchFieldPlaces(query: string, bias?: Coordinate): Promise<PlaceSearchResult[]> {
  const params = new URLSearchParams({ q: query.trim() });
  if (bias) {
    params.set('lat', String(bias.latitude));
    params.set('lon', String(bias.longitude));
  }
  const result = await requestJson<{ places: PlaceSearchResult[] }>(`/field-tracking/places/search?${params}`);
  return result.places;
}

export function planFieldRoute(origin: Coordinate, destination: PlaceSearchResult, travelMode: 'auto' | 'pedestrian' | 'bicycle'): Promise<RoutePlan> {
  return requestJson('/field-tracking/route', {
    method: 'POST',
    timeoutMs: 18_000,
    body: JSON.stringify({ origin, destination, travelMode }),
  });
}

export async function fetchMatchedRoute(sessionId: string): Promise<{ source: 'self-hosted-valhalla' | 'raw'; points: Coordinate[]; lastSequence: number }> {
  return requestJson(`/field-tracking/sessions/${encodeURIComponent(sessionId)}/matched-route`, { timeoutMs: 14_000 });
}

export async function uploadFieldPoints(session: TrackingSession, points: RoutePoint[]): Promise<{
  accepted: { pointId: string }[];
  rejected: { pointId?: string; reason?: string }[];
  committedAt: string;
}> {
  return requestJson('/field-tracking/locations/batch', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: session.id,
      companyId: session.companyId,
      sessionStartedAt: session.startedAt,
      points,
    }),
  });
}

export function completeFieldSession(sessionId: string, endedAt: string): Promise<{ ok: boolean }> {
  return requestJson(`/field-tracking/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ endedAt }),
  });
}
