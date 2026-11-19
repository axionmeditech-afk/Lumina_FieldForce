import { getApiBaseUrlCandidates } from '@/lib/attendance-api';
import { getApiToken } from '@/lib/storage';
import type { Coordinate, FieldSessionKpis, PlaceSearchResult, RoutePlan, RoutePoint, TrackingSession } from './types';

type RequestOptions = RequestInit & { timeoutMs?: number; retryAcrossBases?: boolean };

class NonRetryableFieldRequestError extends Error {}

export type FieldVisitAssignment = {
  assignmentId: string;
  companyId: string;
  employeeId: string;
  assignedBy: string;
  placeId: string;
  placeName: string;
  placeAddress: string;
  latitude: number;
  longitude: number;
  queueOrder: number;
  scheduledDate: string;
  scheduledTime: string;
  notes: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  arrivalLocation: (Coordinate & { accuracy: number | null }) | null;
  completionLocation: (Coordinate & { accuracy: number | null }) | null;
};

export type VisitEvidenceLocation = Coordinate & { accuracy?: number | null };

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = await getApiToken();
  if (!token) throw new Error('Please sign in again to use field tracking.');
  const bases = await getApiBaseUrlCandidates();
  if (!bases.length) throw new Error('Backend is not configured.');
  const { timeoutMs = 12_000, retryAcrossBases = false, ...requestInit } = options;
  const method = (requestInit.method || 'GET').toUpperCase();
  const candidates = ['GET', 'HEAD'].includes(method) || retryAcrossBases ? bases : bases.slice(0, 1);
  const deadline = Date.now() + timeoutMs;
  let finalError: Error | null = null;
  for (const base of candidates) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const controller = new AbortController();
    const candidateTimeoutMs = Math.min(20_000, remainingMs);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      // React Native's fetch implementation does not consistently reject when
      // AbortController fires (notably after a network hand-off or a sleeping
      // Render instance). Race the complete fetch + body read against a real
      // rejection so a directions button can never spin forever.
      const request = (async () => {
        const response = await fetch(`${base}${path}`, {
          ...requestInit,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            ...(options.headers || {}),
          },
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
        return { response, body };
      })();
      const hardTimeout = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Field tracking request timed out.'));
        }, candidateTimeoutMs);
      });
      const { response, body } = await Promise.race([request, hardTimeout]);
      if (!response.ok) {
        const message = body?.message || body?.error || `Field tracking request failed (${response.status}).`;
        // Business/auth failures are deterministic across both services.
        // Retry only transient gateway/server failures on the secondary host.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) {
          throw new NonRetryableFieldRequestError(message);
        }
        finalError = new Error(message);
        continue;
      }
      return body as T;
    } catch (error) {
      if (error instanceof NonRetryableFieldRequestError) throw error;
      finalError = error instanceof Error
        ? new Error(error.name === 'AbortError' ? 'Field tracking request timed out.' : error.message)
        : new Error('Field tracking request failed.');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw finalError ?? new Error('Field tracking backend is unavailable.');
}

export async function getFieldHealth(): Promise<{ apiReachable: boolean; provider?: 'stadia' | 'self-hosted' | 'unconfigured'; routerReachable: boolean; geocoderReachable: boolean }> {
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

export function planFieldRoute(origin: Coordinate, destination: PlaceSearchResult, travelMode: 'auto' | 'pedestrian' | 'bicycle', assignmentId?: string): Promise<RoutePlan> {
  return requestJson('/field-tracking/route', {
    method: 'POST',
    // Render cold-start plus the upstream route computation can legitimately
    // exceed the previous 18 second limit. Keep it bounded, but allow enough
    // time for one cold production request to finish.
    timeoutMs: 35_000,
    retryAcrossBases: true,
    body: JSON.stringify({ origin, destination, travelMode, assignmentId }),
  });
}

export async function fetchMatchedRoute(sessionId: string): Promise<{ source: 'stadia-valhalla' | 'self-hosted-valhalla' | 'raw'; points: Coordinate[]; lastSequence: number }> {
  return requestJson(`/field-tracking/sessions/${encodeURIComponent(sessionId)}/matched-route`, { timeoutMs: 14_000 });
}

export async function fetchFieldSessionKpis(sessionId: string): Promise<FieldSessionKpis> {
  return requestJson(`/field-tracking/sessions/${encodeURIComponent(sessionId)}/kpis`, { timeoutMs: 10_000 });
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

export async function getFieldVisitAssignments(): Promise<FieldVisitAssignment[]> {
  const result = await requestJson<{ assignments: FieldVisitAssignment[] }>('/field-tracking/assignments');
  return result.assignments;
}

export function createFieldVisitAssignment(input: {
  employeeId: string;
  place: PlaceSearchResult;
  scheduledDate: string;
  scheduledTime: string;
  notes?: string;
}): Promise<{ assignment: FieldVisitAssignment }> {
  return requestJson('/field-tracking/assignments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function startFieldVisitAssignment(assignmentId: string, location: VisitEvidenceLocation): Promise<{ assignment: FieldVisitAssignment }> {
  return requestJson(`/field-tracking/assignments/${encodeURIComponent(assignmentId)}/start`, {
    method: 'POST',
    body: JSON.stringify({ location }),
  });
}

export type FieldCheckInEligibility = {
  remoteCheckInAllowed: boolean;
  visitCount: number;
  scheduledDate: string;
};

export function getFieldCheckInEligibility(): Promise<FieldCheckInEligibility> {
  return requestJson('/field-tracking/check-in-eligibility', { timeoutMs: 8_000 });
}

export function completeFieldVisitAssignment(assignmentId: string, location?: VisitEvidenceLocation): Promise<{ ok: boolean; nextAssignment: FieldVisitAssignment | null }> {
  return requestJson(`/field-tracking/assignments/${encodeURIComponent(assignmentId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ location: location || null }),
  });
}
