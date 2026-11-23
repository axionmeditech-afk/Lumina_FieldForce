import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FieldTrackingCalendar,
  FieldTrackingDaily,
  LiveConnectionState,
  LiveEmployee,
  RoutePoint,
} from '../types';
import { getFieldHealth } from '../api';
import { getApiToken } from '@/lib/storage';
import { getApiBaseUrlCandidates } from '@/lib/attendance-api';
import { toMumbaiDateKey } from '@/lib/ist-time';
import { deriveLiveTrackingStatus } from '../live-health';

const timezoneOffsetMinutes = 5 * 60 + 30;

function localDateKey(date = new Date()): string {
  return toMumbaiDateKey(date);
}

async function fetchJsonFast<T>(url: string, token: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const request = (async () => {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as T | { message?: string } | null;
    if (!response.ok) throw new Error((body as { message?: string } | null)?.message || `tracking_${response.status}`);
    return body as T;
  })();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Field history request timed out.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapEmployee(row: any): LiveEmployee {
  const name = String(row.employee_name || row.employee_id || 'Employee');
  const words = name.trim().split(/\s+/).filter(Boolean);
  const capturedAt = row.captured_at ? new Date(row.captured_at).toISOString() : new Date(0).toISOString();
  const heartbeatAt = row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null;
  // A stationary employee may correctly produce no route geometry. Liveness is
  // therefore driven by the explicit engine heartbeat, with the last GPS point
  // retained only as a compatibility fallback for pre-heartbeat deployments.
  const sessionStatus: LiveEmployee['sessionStatus'] = row.session_status === 'active'
    ? 'active'
    : row.session_status === 'waiting' ? 'waiting' : 'completed';
  const attendanceActive = row.attendance_active === true
    || Number(row.attendance_active) === 1
    || String(row.attendance_type || '').toLowerCase() === 'checkin';
  const trackingActive = sessionStatus === 'active' && row.tracking_active !== 0 && String(row.tracking_active) !== '0';
  const status = deriveLiveTrackingStatus({
    attendanceActive,
    trackingActive,
    heartbeatAt,
    capturedAt,
  });
  return {
    employeeId: String(row.employee_id),
    companyId: String(row.company_id || ''),
    sessionId: String(row.session_id),
    name,
    initials: (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : name.slice(0, 2)).toUpperCase(),
    roleLabel: 'Field employee',
    sequence: Number(row.sequence_no || 0),
    latitude: Number(row.latitude || 0),
    longitude: Number(row.longitude || 0),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
    speed: row.speed == null ? null : Number(row.speed),
    heading: row.heading == null ? null : Number(row.heading),
    battery: row.battery == null ? null : Number(row.battery),
    capturedAt,
    heartbeatAt,
    runtimeState: row.runtime_state || null,
    pendingPoints: Math.max(0, Number(row.pending_points || 0)),
    runtimeError: row.runtime_error || null,
    samplingProfile: row.sampling_profile || null,
    heartbeatGapSeconds: row.heartbeat_gap_seconds == null
      ? (heartbeatAt ? Math.max(0, Math.floor((Date.now() - Date.parse(heartbeatAt)) / 1000)) : null)
      : Math.max(0, Number(row.heartbeat_gap_seconds)),
    locationGapSeconds: row.location_gap_seconds == null
      ? (capturedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(capturedAt)) / 1000)) : null)
      : Math.max(0, Number(row.location_gap_seconds)),
    recoveredGapSeconds: row.recovered_gap_seconds == null ? null : Math.max(0, Number(row.recovered_gap_seconds)),
    gapCount: Math.max(0, Number(row.gap_count || 0)),
    status,
    sessionStatus,
    attendanceActive,
    trackingActive,
    offRoute: false,
  };
}

export function useLiveRoute(companyId?: string | null, allCompanies = false) {
  const today = localDateKey();
  const [employee, setEmployee] = useState<LiveEmployee | null>(null);
  const [employees, setEmployees] = useState<LiveEmployee[]>([]);
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState({ apiReachable: false, routerReachable: false, geocoderReachable: false });
  const [kpis, setKpis] = useState<FieldTrackingDaily['kpis'] | null>(null);
  const [kpiState, setKpiState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [selectedDate, setSelectedDateState] = useState(today);
  const [calendarMonth, setCalendarMonthState] = useState(today.slice(0, 7));
  const [calendarDays, setCalendarDays] = useState<FieldTrackingCalendar['days']>([]);
  const [calendarState, setCalendarState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const mountedRef = useRef(true);
  const employeeRef = useRef<LiveEmployee | null>(null);
  const employeesRef = useRef<LiveEmployee[]>([]);
  const selectedEmployeeKeyRef = useRef<string | null>(null);
  const selectedDateRef = useRef(today);
  const calendarMonthRef = useRef(today.slice(0, 7));
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    void getFieldHealth().then((nextHealth) => {
      if (mountedRef.current) setServerHealth(nextHealth);
    });
    try {
      const token = await getApiToken();
      if (!token) throw new Error('admin_login_failed');
      const bases = await getApiBaseUrlCandidates();
      if (!bases.length) throw new Error('Backend is not configured.');
      const base = bases[0]!;
      const encodedCompanyId = companyId ? encodeURIComponent(companyId) : '';
      const companyQuery = allCompanies
        ? '?allCompanies=1'
        : encodedCompanyId ? `?companyId=${encodedCompanyId}` : '';
      const directory = await fetchJsonFast<{ employees: any[] }>(`${base}/field-tracking/employees${companyQuery}`, token);
      const incomingEmployees = (directory.employees || []).map(mapEmployee);
      employeesRef.current = incomingEmployees;
      if (mountedRef.current) setEmployees(incomingEmployees);
      if (!incomingEmployees.length) {
        employeeRef.current = null;
        selectedEmployeeKeyRef.current = null;
        if (mountedRef.current) {
          setEmployee(null);
          setPoints([]);
          setKpis(null);
          setCalendarDays([]);
          setKpiState('idle');
          setCalendarState('ready');
          setConnectionState('waiting');
          setError(null);
        }
        return;
      }
      const selected = (selectedEmployeeKeyRef.current
        ? incomingEmployees.find((item) => `${item.companyId}:${item.employeeId}` === selectedEmployeeKeyRef.current)
        : null)
        ?? incomingEmployees.find((item) => item.sessionStatus === 'active')
        ?? incomingEmployees[0]!;
      selectedEmployeeKeyRef.current = `${selected.companyId}:${selected.employeeId}`;
      const employeeChanged = employeeRef.current?.employeeId !== selected.employeeId
        || employeeRef.current?.companyId !== selected.companyId;
      employeeRef.current = selected;
      if (mountedRef.current) {
        setEmployee(selected);
        if (employeeChanged) {
          setKpis(null);
          setPoints([]);
          setKpiState('loading');
          setCalendarState('loading');
        }
      }
      const encodedEmployee = encodeURIComponent(selected.employeeId);
      const offset = encodeURIComponent(String(timezoneOffsetMinutes));
      const selectedCompanyId = encodeURIComponent(selected.companyId || companyId || '');
      const companyParam = selectedCompanyId ? `&companyId=${selectedCompanyId}` : '';
      const calendarUrl = `${base}/field-tracking/employees/${encodedEmployee}/calendar?month=${encodeURIComponent(calendarMonthRef.current)}&tzOffsetMinutes=${offset}${companyParam}`;
      const dailyUrl = `${base}/field-tracking/employees/${encodedEmployee}/daily?date=${encodeURIComponent(selectedDateRef.current)}&tzOffsetMinutes=${offset}${companyParam}`;
      const [calendar, daily] = await Promise.all([
        fetchJsonFast<FieldTrackingCalendar>(calendarUrl, token, 10_000),
        fetchJsonFast<FieldTrackingDaily>(dailyUrl, token, 12_000),
      ]);
      if (mountedRef.current && selectedEmployeeKeyRef.current === `${selected.companyId}:${selected.employeeId}`) {
        setCalendarDays(calendar.days);
        setCalendarState('ready');
        setPoints(daily.points);
        setKpis(daily.kpis);
        setKpiState('ready');
        setConnectionState('live');
        setError(null);
      }
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'field_history_failed';
      if (mountedRef.current) {
        setConnectionState('offline');
        setError(message);
        setKpiState((current) => current === 'loading' ? 'unavailable' : current);
        setCalendarState((current) => current === 'loading' ? 'unavailable' : current);
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [allCompanies, companyId]);

  useEffect(() => {
    mountedRef.current = true;
    const initialRefresh = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      mountedRef.current = false;
      clearTimeout(initialRefresh);
      clearInterval(poll);
    };
  }, [refresh]);

  const selectEmployee = useCallback((employeeId: string, selectedCompanyId?: string) => {
    const selected = employeesRef.current.find((item) => item.employeeId === employeeId
      && (!selectedCompanyId || item.companyId === selectedCompanyId));
    if (!selected) return;
    selectedEmployeeKeyRef.current = `${selected.companyId}:${selected.employeeId}`;
    employeeRef.current = selected;
    const nextToday = localDateKey();
    selectedDateRef.current = nextToday;
    calendarMonthRef.current = nextToday.slice(0, 7);
    if (mountedRef.current) {
      setEmployee(selected);
      setSelectedDateState(nextToday);
      setCalendarMonthState(nextToday.slice(0, 7));
      setPoints([]);
      setKpis(null);
      setKpiState('loading');
      setCalendarState('loading');
      setConnectionState('recovering');
    }
    void refresh();
  }, [refresh]);

  const selectDate = useCallback((date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === selectedDateRef.current) return;
    selectedDateRef.current = date;
    if (date.slice(0, 7) !== calendarMonthRef.current) {
      calendarMonthRef.current = date.slice(0, 7);
      setCalendarMonthState(date.slice(0, 7));
    }
    setSelectedDateState(date);
    setPoints([]);
    setKpis(null);
    setKpiState('loading');
    setConnectionState('recovering');
    void refresh();
  }, [refresh]);

  const selectMonth = useCallback((month: string) => {
    if (!/^\d{4}-\d{2}$/.test(month) || month === calendarMonthRef.current) return;
    calendarMonthRef.current = month;
    const nextDate = month === localDateKey().slice(0, 7) ? localDateKey() : `${month}-01`;
    selectedDateRef.current = nextDate;
    setCalendarMonthState(month);
    setSelectedDateState(nextDate);
    setCalendarDays([]);
    setPoints([]);
    setKpis(null);
    setCalendarState('loading');
    setKpiState('loading');
    setConnectionState('recovering');
    void refresh();
  }, [refresh]);

  // Today remains the live/last-known view while attendance is open. A delayed
  // GPS feed must be shown as delayed/offline, not mislabeled as route history.
  const viewingLive = selectedDate === today && Boolean(employee?.attendanceActive);
  const latest = [...points].reverse().find((point) => point.routeEligible || point.rejectionReason === 'stationary_noise') ?? null;
  return {
    employee,
    employees,
    points,
    latest,
    connectionState,
    error,
    serverHealth,
    kpis,
    kpiState,
    refresh,
    selectEmployee,
    selectedDate,
    selectDate,
    calendarMonth,
    selectMonth,
    calendarDays,
    calendarState,
    viewingLive,
  };
}
