import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { getFieldHealth } from './api';
import { routeDistance } from './geo';
import type { RoutePoint, TrackerSnapshot, TrackerState } from './types';
import { subscribeToCapturedPoints } from './tracking/capture';
import { countPending, getActiveSession, getLatestSession, getRoute, getRouteAfter, getState, setSessionCompanyIfMissing } from './tracking/database';
import { readFieldPermissions, restoreFieldTracker, startFieldTracking, stopFieldTracking } from './tracking/tracker';
import { syncFieldOutbox } from './tracking/sync';

const initialSnapshot: TrackerSnapshot = {
  state: 'stopped',
  session: null,
  points: [],
  pendingCount: 0,
  distanceMetres: 0,
  lastCapturedAt: null,
  lastSyncedAt: null,
  lastError: null,
  precisePermission: false,
  backgroundPermission: false,
  locationServicesEnabled: false,
  backgroundCapable: false,
  networkConnected: true,
  serverReachable: false,
  routerReachable: false,
  geocoderReachable: false,
};

function mergePoints(current: RoutePoint[], incoming: RoutePoint[]): RoutePoint[] {
  const bySequence = new Map(current.map((point) => [point.sequence, point]));
  for (const point of incoming) bySequence.set(point.sequence, point);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-5_000);
}

export function useFieldTracker(employeeId: string | null | undefined, companyId: string | null | undefined) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const pointsRef = useRef<RoutePoint[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const diagnosticsAtRef = useRef(0);

  const refresh = useCallback(async (forceRoute = false, forceDiagnostics = false) => {
    if (!employeeId) {
      pointsRef.current = [];
      sessionIdRef.current = null;
      setSnapshot(initialSnapshot);
      return;
    }
    const active = await getActiveSession(employeeId);
    const session = active ?? await getLatestSession(employeeId);
    let points: RoutePoint[] = [];
    if (session) {
      if (forceRoute || sessionIdRef.current !== session.id) points = await getRoute(session.id);
      else points = mergePoints(pointsRef.current, await getRouteAfter(session.id, pointsRef.current.at(-1)?.sequence ?? 0));
      sessionIdRef.current = session.id;
      pointsRef.current = points;
    } else {
      sessionIdRef.current = null;
      pointsRef.current = [];
    }

    const shouldReadDiagnostics = forceDiagnostics || Date.now() - diagnosticsAtRef.current > 12_000;
    const [pendingCount, network, permissions, health, state, lastCapturedAt, lastSyncedAt, trackerError, syncError] = await Promise.all([
      countPending(employeeId),
      NetInfo.fetch(),
      shouldReadDiagnostics ? readFieldPermissions() : Promise.resolve(null),
      shouldReadDiagnostics ? getFieldHealth() : Promise.resolve(null),
      getState('tracker_state') as Promise<TrackerState | null>,
      getState('last_captured_at'),
      getState('last_synced_at'),
      getState('last_tracker_error'),
      getState('last_sync_error'),
    ]);
    if (shouldReadDiagnostics) diagnosticsAtRef.current = Date.now();
    setSnapshot((current) => ({
      state: active ? (state || 'tracking') : 'stopped',
      session,
      points,
      pendingCount,
      distanceMetres: routeDistance(points),
      lastCapturedAt,
      lastSyncedAt,
      lastError: trackerError || syncError || null,
      precisePermission: permissions?.precisePermission ?? current.precisePermission,
      backgroundPermission: permissions?.backgroundPermission ?? current.backgroundPermission,
      locationServicesEnabled: permissions?.locationServicesEnabled ?? current.locationServicesEnabled,
      backgroundCapable: permissions?.backgroundCapable ?? current.backgroundCapable,
      networkConnected: Boolean(network.isConnected && network.isInternetReachable !== false),
      serverReachable: health?.apiReachable ?? current.serverReachable,
      routerReachable: health?.routerReachable ?? current.routerReachable,
      geocoderReachable: health?.geocoderReachable ?? current.geocoderReachable,
    }));
  }, [employeeId]);

  useEffect(() => {
    pointsRef.current = [];
    sessionIdRef.current = null;
    void getActiveSession(employeeId || undefined)
      .then((session) => session && companyId ? setSessionCompanyIfMissing(session.id, companyId) : undefined)
      .then(() => restoreFieldTracker(employeeId || undefined))
      .catch((error: unknown) => console.warn('Unable to restore field tracking', error))
      .finally(() => {
        void syncFieldOutbox(employeeId || undefined, true).finally(() => refresh(true, true));
      });
    let captureTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeCapture = subscribeToCapturedPoints(() => {
      if (captureTimer) return;
      captureTimer = setTimeout(() => {
        captureTimer = null;
        void refresh();
      }, 180);
    });
    const timer = setInterval(() => void refresh(), 10_000);
    const unsubscribeNetwork = NetInfo.addEventListener((network) => {
      if (network.isConnected) void syncFieldOutbox(employeeId || undefined, true).then(() => refresh(true, true));
    });
    return () => {
      if (captureTimer) clearTimeout(captureTimer);
      clearInterval(timer);
      unsubscribeCapture();
      unsubscribeNetwork();
    };
  }, [companyId, employeeId, refresh]);

  const start = useCallback(async () => {
    if (!employeeId) throw new Error('Signed-in employee was not found.');
    if (!companyId) throw new Error('Select a workspace before starting field tracking.');
    setBusy(true);
    try {
      await startFieldTracking(employeeId, companyId);
    } finally {
      diagnosticsAtRef.current = 0;
      await refresh(true, true);
      setBusy(false);
    }
  }, [companyId, employeeId, refresh]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await stopFieldTracking(employeeId || undefined);
    } finally {
      diagnosticsAtRef.current = 0;
      await refresh(true, true);
      setBusy(false);
    }
  }, [employeeId, refresh]);

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      await syncFieldOutbox(employeeId || undefined, true);
    } finally {
      await refresh(true, true);
      setBusy(false);
    }
  }, [employeeId, refresh]);

  return { snapshot, busy, start, stop, sync, refresh };
}
