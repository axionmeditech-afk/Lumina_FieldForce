import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveConnectionState, LiveEmployee, RoutePoint } from '../types';
import { getFieldHealth } from '../api';
import { getApiToken } from '@/lib/storage';
import { getApiBaseUrlCandidates } from '@/lib/attendance-api';

function mergePoints(current: RoutePoint[], incoming: RoutePoint[]): RoutePoint[] {
  const bySequence = new Map(current.map((point) => [point.sequence, point]));
  for (const point of incoming) bySequence.set(point.sequence, point);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-5000);
}

export function useLiveRoute() {
  const [employee, setEmployee] = useState<LiveEmployee | null>(null);
  const [employees, setEmployees] = useState<LiveEmployee[]>([]);
  const [points, setPoints] = useState<RoutePoint[]>([]);
  const [connectionState, setConnectionState] = useState<LiveConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [serverHealth, setServerHealth] = useState({ apiReachable: false, routerReachable: false, geocoderReachable: false });
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
      const incomingEmployees: LiveEmployee[] = rawEmployees.map(row => ({
        employeeId: row.employee_id,
        sessionId: row.session_id,
        name: `Employee ${row.employee_id.slice(-4)}`, // Fallback, maybe backend should return name
        initials: row.employee_id.slice(0, 2).toUpperCase(),
        roleLabel: 'Field Worker',
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
      }));

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
      setConnectionState('recovering');
    }
    void refresh();
  }, [applyPoints, refresh]);

  const latest = [...points].reverse().find((point) => point.routeEligible || point.rejectionReason === 'stationary_noise') ?? null;
  return { employee, employees, points, latest, connectionState, error, serverHealth, refresh, selectEmployee };
}
