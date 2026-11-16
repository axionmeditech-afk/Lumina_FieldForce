import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldSessionKpis, LiveConnectionState, LiveEmployee, RoutePoint } from '../types';
import { getFieldHealth } from '../api';
import { getApiToken } from '@/lib/storage';
import { getApiBaseUrlCandidates } from '@/lib/attendance-api';

function mergePoints(current: RoutePoint[], incoming: RoutePoint[]): RoutePoint[] {
  const bySequence = new Map(current.map((point) => [point.sequence, point]));
  for (const point of incoming) bySequence.set(point.sequence, point);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-5000);
}

async function fetchKpisFast(baseUrl: string, token: string, sessionId: string): Promise<FieldSessionKpis> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_500);
  try {
    const response = await fetch(`${baseUrl}/field-tracking/sessions/${encodeURIComponent(sessionId)}/kpis`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`kpis_${response.status}`);
    return await response.json() as FieldSessionKpis;
  } finally {
    clearTimeout(timeout);
  }
}

export function useLiveRoute() {
  const [employee, setEmployee] = useState<LiveEmployee | null>(null);
  const [employees, setEmployees] = useState<LiveEmployee[]>([]);
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState({ apiReachable: false, routerReachable: false, geocoderReachable: false });
  const [kpis, setKpis] = useState<FieldSessionKpis | null>(null);
  const [kpiState, setKpiState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const mountedRef = useRef(true);
  
  const employeeRef = useRef<LiveEmployee | null>(null);
  const employeesRef = useRef<LiveEmployee[]>([]);
  const selectedEmployeeIdRef = useRef<string | null>(null);
  const pointsRef = useRef<RoutePoint[]>([]);
  const lastSequenceRef = useRef(0);
  const refreshingRef = useRef(false);

  const applyPoints = useCallback((incoming: RoutePoint[], replace = false) => {
    const next = replace ? [...incoming].sort((a, b) => a.sequence - b.sequence).slice(-5000) : mergePoints(pointsRef.current, incoming);
    pointsRef.current = next;
    lastSequenceRef.current = next.at(-1)?.sequence ?? 0;
    if (mountedRef.current) setPoints(next);
  }, []);

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
      
      const response = await fetch(`${bases[0]}/field-tracking/live`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`live_${response.status}`);
      const body = await response.json();
      
      // The backend returns an array of rows under `employees`.
      // Let's map it to LiveEmployee structure.
      const rawEmployees: any[] = body.employees || [];
      const incomingEmployees: LiveEmployee[] = rawEmployees.map(row => {
        const name = String(row.employee_name || row.employee_id || 'Employee');
        const words = name.trim().split(/\s+/).filter(Boolean);
        return ({
        employeeId: row.employee_id,
        sessionId: row.session_id,
        name,
        initials: (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : name.slice(0, 2)).toUpperCase(),
        roleLabel: 'Field employee',
        sequence: row.sequence_no,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        accuracy: row.accuracy ? Number(row.accuracy) : null,
        speed: row.speed ? Number(row.speed) : null,
        heading: row.heading ? Number(row.heading) : null,
        battery: row.battery,
        capturedAt: row.captured_at,
        status: 'live',
        sessionStatus: 'active',
        offRoute: false
        });
      });

      if (!incomingEmployees.length) {
        employeeRef.current = null;
        employeesRef.current = [];
        selectedEmployeeIdRef.current = null;
        pointsRef.current = [];
        lastSequenceRef.current = 0;
        if (mountedRef.current) {
          setEmployee(null);
          setEmployees([]);
          setPoints([]);
          setKpis(null);
          setKpiState('idle');
          setConnectionState('waiting');
          setError(null);
        }
        return;
      }

      employeesRef.current = incomingEmployees;
      if (mountedRef.current) setEmployees(incomingEmployees);
      
      const selected = (selectedEmployeeIdRef.current
        ? incomingEmployees.find((item) => item.employeeId === selectedEmployeeIdRef.current)
        : null)
        ?? incomingEmployees.find((item) => item.sessionStatus === 'active')
        ?? incomingEmployees[0]!;
      
      selectedEmployeeIdRef.current = selected.employeeId;
      const sessionChanged = employeeRef.current?.sessionId !== selected.sessionId;
      employeeRef.current = selected;
      if (mountedRef.current) setEmployee(selected);
      if (sessionChanged && mountedRef.current) {
        setKpis(null);
        setKpiState('loading');
      }

      // Start KPI delivery immediately. Route matching can call Valhalla and must
      // never delay the dashboard's basic live details.
      void fetchKpisFast(bases[0]!, token, selected.sessionId)
        .then((nextKpis) => {
          if (mountedRef.current && employeeRef.current?.sessionId === selected.sessionId) {
            setKpis(nextKpis);
            setKpiState('ready');
          }
        })
        .catch(() => {
          if (mountedRef.current && employeeRef.current?.sessionId === selected.sessionId) setKpiState('unavailable');
        });

      // Fetch route points for selected employee
      const routeResponse = await fetch(`${bases[0]}/field-tracking/sessions/${encodeURIComponent(selected.sessionId)}/matched-route`, {
        headers: { authorization: `Bearer ${token}` }
      });
      
      if (routeResponse.ok) {
        const routeBody = await routeResponse.json();
        // The API returns points directly. Let's adapt them to RoutePoint shape.
        const routePoints: RoutePoint[] = (routeBody.points || []).map((p: any, i: number) => ({
          pointId: `mock-${i}`,
          sessionId: selected.sessionId,
          sequence: i,
          latitude: p.latitude,
          longitude: p.longitude,
          accuracy: p.accuracy,
          speed: null,
          heading: null,
          battery: null,
          mocked: false,
          capturedAt: new Date().toISOString(),
          routeEligible: true,
          rejectionReason: null
        }));
        applyPoints(routePoints, sessionChanged);
      }

      setError(null);
      if (mountedRef.current) setConnectionState('live');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'live_connection_failed';
      if (mountedRef.current) {
        setConnectionState('offline');
        setError(message);
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [applyPoints]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      mountedRef.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  const selectEmployee = useCallback((employeeId: string) => {
    if (selectedEmployeeIdRef.current === employeeId) return;
    const selected = employeesRef.current.find((item) => item.employeeId === employeeId);
    if (!selected) return;
    selectedEmployeeIdRef.current = employeeId;
    employeeRef.current = selected;
    lastSequenceRef.current = 0;
    applyPoints([], true);
    if (mountedRef.current) {
      setEmployee(selected);
      setKpis(null);
      setKpiState('loading');
      setConnectionState('recovering');
    }
    void refresh();
  }, [applyPoints, refresh]);

  const latest = [...points].reverse().find((point) => point.routeEligible || point.rejectionReason === 'stationary_noise') ?? null;
  return { employee, employees, points, latest, connectionState, error, serverHealth, kpis, kpiState, refresh, selectEmployee };
}
