export const FIXED_EMPLOYEE_VISIT_LEAD_MINUTES = 120;
export const VISIT_GEOFENCE_RADIUS_METRES = 120;
export const VISIT_MAX_ACCURACY_METRES = 80;
export const VISIT_EVIDENCE_MAX_AGE_MS = 30_000;
export const VISIT_EVIDENCE_FUTURE_TOLERANCE_MS = 5_000;
export const VISIT_MIN_EVIDENCE_SAMPLES = 2;
export const VISIT_MIN_SAMPLE_WINDOW_MS = 1_500;

export type VisitSchedulePolicy = {
  scheduledAt: string | null;
  directionsAvailableAt: string | null;
  directionsAllowed: boolean;
  remoteCheckInAllowed: boolean;
  reason: 'available' | 'overdue' | 'not_today' | 'not_open' | 'remote_window_expired' | 'invalid_schedule';
};

/**
 * Visit scheduling is evaluated in India Standard Time because field visits
 * and attendance dates are stored as Mumbai-local calendar values.
 *
 * Fixed-location employees get a bounded travel window before the visit. If
 * they miss it, they must check in at their office geofence, but directions
 * remain available so the assigned work can still be completed. Overdue work
 * is also executable after a current check-in, while only a same-day visit can
 * grant remote check-in. Salespeople retain all-day remote eligibility for
 * same-day assigned work.
 */
export function evaluateVisitSchedulePolicy(
  role: string | null | undefined,
  scheduledDate: string,
  scheduledTime: string,
  nowMs = Date.now(),
  leadMinutes = FIXED_EMPLOYEE_VISIT_LEAD_MINUTES,
): VisitSchedulePolicy {
  const time = String(scheduledTime || '').slice(0, 5);
  const scheduledAtMs = Date.parse(`${scheduledDate}T${time}:00+05:30`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isFinite(scheduledAtMs)) {
    return {
      scheduledAt: null,
      directionsAvailableAt: null,
      directionsAllowed: false,
      remoteCheckInAllowed: false,
      reason: 'invalid_schedule',
    };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || '';
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const scheduledAt = new Date(scheduledAtMs).toISOString();
  const opensAtMs = scheduledAtMs - Math.max(15, Math.min(480, leadMinutes)) * 60_000;
  const directionsAvailableAt = new Date(opensAtMs).toISOString();
  // A pending visit from an earlier day remains executable after a fresh
  // attendance check-in. It never grants remote check-in or protects today's
  // attendance from auto-checkout; those server queries remain date-exact.
  if (scheduledDate < today) {
    return { scheduledAt, directionsAvailableAt, directionsAllowed: true, remoteCheckInAllowed: false, reason: 'overdue' };
  }
  if (scheduledDate > today) {
    return { scheduledAt, directionsAvailableAt, directionsAllowed: false, remoteCheckInAllowed: false, reason: 'not_today' };
  }
  if (role === 'salesperson') {
    return { scheduledAt, directionsAvailableAt, directionsAllowed: true, remoteCheckInAllowed: true, reason: 'available' };
  }
  if (nowMs < opensAtMs) {
    return { scheduledAt, directionsAvailableAt, directionsAllowed: false, remoteCheckInAllowed: false, reason: 'not_open' };
  }
  if (nowMs > scheduledAtMs) {
    return { scheduledAt, directionsAvailableAt, directionsAllowed: true, remoteCheckInAllowed: false, reason: 'remote_window_expired' };
  }
  return { scheduledAt, directionsAvailableAt, directionsAllowed: true, remoteCheckInAllowed: true, reason: 'available' };
}

export type VisitLocationEvidence = {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
  mocked?: boolean;
};

export function isVisitEvidenceFresh(sample: VisitLocationEvidence, nowMs = Date.now()): boolean {
  const capturedAt = Date.parse(sample.capturedAt);
  return Number.isFinite(capturedAt)
    && capturedAt <= nowMs + VISIT_EVIDENCE_FUTURE_TOLERANCE_MS
    && nowMs - capturedAt <= VISIT_EVIDENCE_MAX_AGE_MS;
}
