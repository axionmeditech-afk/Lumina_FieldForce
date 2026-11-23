import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { router, usePathname } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { getAttendanceStatus } from '@/lib/attendance-api';
import { confirmFieldVisitArrival, getFieldVisitAssignments, planFieldRoute, type FieldVisitAssignment } from '@/lib/field-tracking/api';
import { formatDistance, formatDuration } from '@/lib/field-tracking/geo';
import { buildRouteMetrics, headingDifference, projectOnRoute, remainingRoute } from '@/lib/field-tracking/navigation-geometry';
import type { Coordinate, RoutePlan } from '@/lib/field-tracking/types';
import { subscribeToVisitNavigationCheckout } from '@/lib/field-tracking/visit-navigation-lifecycle';
import { appendArrivalEvidence } from '@/lib/field-tracking/visit-evidence-core';
import { isEvidenceInsideVisitGeofence, toVisitLocationEvidence } from '@/lib/field-tracking/visit-evidence';
import type { VisitLocationEvidence } from '@/lib/field-tracking/visit-policy';
import { notifyRouteUpdated, notifyVisitArrived, notifyVisitNavigationStarted } from '@/lib/employee-notifications';

type NavigationStatus = 'preview' | 'active' | 'arrived';
type StoredSession = {
  visit: FieldVisitAssignment;
  route: RoutePlan;
  position: Coordinate | null;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  status: NavigationStatus;
  updatedAt: string;
};
type NavigationProgress = {
  instruction: string;
  maneuverIndex: number;
  distanceToManeuver: number;
  remainingDistance: number;
  remainingDuration: number;
  remainingRoute: Coordinate[];
  snappedPosition: Coordinate | null;
  routeHeading: number | null;
  distanceFromRoute: number;
};
type NavigationContextValue = {
  session: StoredSession | null;
  progress: NavigationProgress | null;
  busy: boolean;
  expandNonce: number;
  screenExpanded: boolean;
  setPreview: (session: Omit<StoredSession, 'status' | 'updatedAt'>) => Promise<void>;
  start: (session?: Omit<StoredSession, 'status' | 'updatedAt'>) => Promise<void>;
  stop: (announce?: boolean) => void;
  clear: () => Promise<void>;
  requestExpand: () => void;
  setScreenExpanded: (expanded: boolean) => void;
};

const VisitNavigationContext = createContext<NavigationContextValue | null>(null);

const EMPTY_ROUTE: RoutePlan = { source: 'unavailable', distanceMetres: null, durationSeconds: null, coordinates: [], maneuvers: [] };

export function VisitNavigationProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expandNonce, setExpandNonce] = useState(0);
  const [screenExpanded, setScreenExpanded] = useState(false);
  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const spokenRef = useRef(new Set<string>());
  const offRouteSamplesRef = useRef(0);
  const wrongWaySamplesRef = useRef(0);
  const deviationStartedAtRef = useRef(0);
  const lastRerouteRef = useRef(0);
  const navigationGenerationRef = useRef(0);
  const voiceActiveRef = useRef(false);
  const arrivalEvidenceRef = useRef<VisitLocationEvidence[]>([]);
  const arrivalVerificationRef = useRef(false);
  const routeProgressRef = useRef<{ route: Coordinate[] | null; distance: number }>({ route: null, distance: 0 });

  const storageKey = userId ? `@lumina_visit_navigation:v1:${userId}` : null;
  const stopWatch = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);

  useEffect(() => {
    stopWatch();
    navigationGenerationRef.current += 1;
    voiceActiveRef.current = false;
    void Speech.stop();
    spokenRef.current.clear();
    offRouteSamplesRef.current = 0;
    arrivalEvidenceRef.current = [];
    arrivalVerificationRef.current = false;
    setSession(null);
    setHydrated(false);
    setScreenExpanded(false);
    if (!storageKey) { setHydrated(true); return; }
    void AsyncStorage.getItem(storageKey).then(async (raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as StoredSession;
        if (!saved?.visit?.assignmentId || saved?.route?.coordinates?.length < 2) return;
        const attendance = await getAttendanceStatus();
        if (!attendance.active) {
          await AsyncStorage.removeItem(storageKey);
          return;
        }
        setSession({ ...saved, speed: saved.speed ?? null, accuracy: saved.accuracy ?? null });
      } catch { void AsyncStorage.removeItem(storageKey); }
    }).finally(() => setHydrated(true));
  }, [storageKey, stopWatch]);

  useEffect(() => {
    if (!hydrated || !storageKey) return;
    if (!session) { void AsyncStorage.removeItem(storageKey); return; }
    void AsyncStorage.setItem(storageKey, JSON.stringify(session));
  }, [hydrated, session, storageKey]);

  const progress = useMemo<NavigationProgress | null>(() => {
    if (!session || !session.route.coordinates.length) return null;
    const position = session.position;
    const metrics = buildRouteMetrics(session.route.coordinates);
    if (routeProgressRef.current.route !== session.route.coordinates) {
      routeProgressRef.current = { route: session.route.coordinates, distance: 0 };
    }
    const projection = position
      ? projectOnRoute(position, session.route.coordinates, metrics, routeProgressRef.current.distance)
      : null;
    if (projection && projection.distanceFromRouteMetres < 150) {
      routeProgressRef.current.distance = Math.max(routeProgressRef.current.distance, projection.distanceAlongRouteMetres);
    }
    const shapePosition = projection?.shapePosition ?? 0;
    const maneuverIndex = session.route.maneuvers.findIndex((item) => item.beginShapeIndex > shapePosition + 0.15);
    const selectedIndex = maneuverIndex >= 0 ? maneuverIndex : Math.max(0, session.route.maneuvers.length - 1);
    const maneuver = session.route.maneuvers[selectedIndex];
    const total = Math.max(1, metrics.totalMetres);
    const covered = Math.min(total, routeProgressRef.current.distance);
    const scale = session.route.distanceMetres ? session.route.distanceMetres / total : 1;
    const remainingDistance = Math.max(0, Math.round((total - covered) * scale));
    const distanceToManeuver = maneuver
      ? Math.max(0, Math.round(((metrics.cumulativeMetres[Math.min(maneuver.beginShapeIndex, metrics.cumulativeMetres.length - 1)] ?? total) - covered) * scale))
      : 0;
    return {
      instruction: maneuver?.instruction || 'Continue on the route',
      maneuverIndex: selectedIndex,
      distanceToManeuver,
      remainingDistance,
      remainingDuration: session.route.distanceMetres && session.route.durationSeconds
        ? Math.round(session.route.durationSeconds * (remainingDistance / session.route.distanceMetres))
        : session.route.durationSeconds || 0,
      remainingRoute: remainingRoute(session.route.coordinates, projection),
      snappedPosition: projection && projection.distanceFromRouteMetres <= Math.max(45, Math.min(110, (session.accuracy ?? 25) * 1.7))
        ? projection.coordinate
        : null,
      routeHeading: projection && projection.distanceFromRouteMetres <= Math.max(45, Math.min(110, (session.accuracy ?? 25) * 1.7))
        ? projection.routeHeading
        : null,
      distanceFromRoute: projection?.distanceFromRouteMetres ?? Number.POSITIVE_INFINITY,
    };
  }, [session]);

  const announce = useCallback((text: string) => {
    if (!voiceActiveRef.current) return;
    void Speech.speak(text, { language: 'en-IN', rate: 0.95, pitch: 1 });
  }, []);

  const setPreview = useCallback(async (next: Omit<StoredSession, 'status' | 'updatedAt'>) => {
    setBusy(false);
    stopWatch();
    navigationGenerationRef.current += 1;
    voiceActiveRef.current = false;
    void Speech.stop();
    spokenRef.current.clear();
    offRouteSamplesRef.current = 0;
    wrongWaySamplesRef.current = 0;
    arrivalEvidenceRef.current = [];
    arrivalVerificationRef.current = false;
    deviationStartedAtRef.current = 0;
    routeProgressRef.current = { route: next.route.coordinates, distance: 0 };
    setSession({ ...next, status: 'preview', updatedAt: new Date().toISOString() });
  }, [stopWatch]);

  const startWatch = useCallback(async (visit: FieldVisitAssignment) => {
    let permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== 'granted' && permission.canAskAgain) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (permission.status !== 'granted') throw new Error('Allow precise location for turn-by-turn directions.');
    stopWatch();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const watchPromise = Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3_000 },
      (location) => {
        const evidence = toVisitLocationEvidence(location);
        arrivalEvidenceRef.current = evidence
          ? appendArrivalEvidence(arrivalEvidenceRef.current, evidence, visit)
          : [];
        setSession((current) => current ? {
          ...current,
          position: { latitude: location.coords.latitude, longitude: location.coords.longitude },
          heading: Number.isFinite(location.coords.heading) ? location.coords.heading : null,
          speed: Number.isFinite(location.coords.speed) ? location.coords.speed : null,
          accuracy: Number.isFinite(location.coords.accuracy) ? location.coords.accuracy : null,
          updatedAt: new Date().toISOString(),
        } : null);
      },
    ).then((subscription) => {
      if (timedOut) subscription.remove();
      return subscription;
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error('Live location watcher could not start. Turn on Precise Location and retry.'));
      }, 10_000);
    });
    try {
      watchRef.current = await Promise.race([watchPromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, [stopWatch]);

  const start = useCallback(async (next?: Omit<StoredSession, 'status' | 'updatedAt'>) => {
    const candidate = next || session;
    if (!candidate || candidate.route.coordinates.length < 2) throw new Error('Route is still loading.');
    setBusy(true);
    try {
      // The visit screen checks server attendance immediately before route
      // planning. Repeating the same 35-second request here made a successful
      // route look stuck in standalone builds.
      await startWatch(candidate.visit);
      navigationGenerationRef.current += 1;
      voiceActiveRef.current = true;
      spokenRef.current.clear();
      offRouteSamplesRef.current = 0;
      wrongWaySamplesRef.current = 0;
      arrivalEvidenceRef.current = [];
      arrivalVerificationRef.current = false;
      deviationStartedAtRef.current = 0;
      routeProgressRef.current = { route: candidate.route.coordinates, distance: 0 };
      setSession({ ...candidate, status: 'active', updatedAt: new Date().toISOString() });
      announce('Directions started. Follow the highlighted route.');
      void notifyVisitNavigationStarted(candidate.visit.assignmentId, candidate.visit.placeName).catch(() => undefined);
    } finally { setBusy(false); }
  }, [announce, session, startWatch]);

  const stop = useCallback((_announce = false) => {
    setBusy(false);
    voiceActiveRef.current = false;
    navigationGenerationRef.current += 1;
    void Speech.stop();
    stopWatch();
    offRouteSamplesRef.current = 0;
    wrongWaySamplesRef.current = 0;
    arrivalEvidenceRef.current = [];
    arrivalVerificationRef.current = false;
    deviationStartedAtRef.current = 0;
    setSession((current) => current ? { ...current, status: 'preview', updatedAt: new Date().toISOString() } : null);
  }, [stopWatch]);

  const clear = useCallback(async () => {
    setBusy(false);
    stopWatch();
    voiceActiveRef.current = false;
    navigationGenerationRef.current += 1;
    void Speech.stop();
    arrivalEvidenceRef.current = [];
    arrivalVerificationRef.current = false;
    setSession(null);
    if (storageKey) await AsyncStorage.removeItem(storageKey);
  }, [storageKey, stopWatch]);

  useEffect(() => subscribeToVisitNavigationCheckout(() => clear()), [clear]);

  // A supervisor can cancel a pending or active visit. Revalidate the durable
  // assignment while a route is open so a cancelled job also stops location,
  // voice guidance and the floating navigator on the employee device.
  useEffect(() => {
    const assignmentId = session?.visit.assignmentId;
    if (!assignmentId) return;
    let disposed = false;
    const verifyAssignment = async () => {
      try {
        const assignments = await getFieldVisitAssignments();
        const active = assignments.some((item) => item.assignmentId === assignmentId && ['pending', 'in_progress'].includes(item.status));
        if (!disposed && !active) await clear();
      } catch {
        // A transient network failure must not stop valid directions.
      }
    };
    const initial = setTimeout(() => void verifyAssignment(), 2_000);
    const timer = setInterval(() => void verifyAssignment(), 30_000);
    return () => {
      disposed = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [clear, session?.visit.assignmentId]);

  useEffect(() => {
    if (session?.status !== 'active') return;
    void getAttendanceStatus().then((attendance) => {
      if (!attendance.active) return clear();
      return startWatch(session.visit);
    }).catch(() => stop());
    return stopWatch;
  }, [clear, session?.status, session?.visit, startWatch, stop, stopWatch]);

  useEffect(() => {
    if (!session || session.status !== 'active' || !session.position || !progress) return;
    const arrivalEvidence = arrivalEvidenceRef.current;
    if (isEvidenceInsideVisitGeofence(arrivalEvidence, session.visit) && !arrivalVerificationRef.current) {
      arrivalVerificationRef.current = true;
      const assignmentId = session.visit.assignmentId;
      void confirmFieldVisitArrival(assignmentId, { samples: arrivalEvidence }).then((result) => {
        stopWatch();
        setSession((current) => current && current.visit.assignmentId === assignmentId
          ? { ...current, visit: result.assignment, status: 'arrived', updatedAt: new Date().toISOString() }
          : current);
        announce(`You have reached ${session.visit.placeName}. Start the visit when ready.`);
        void notifyVisitArrived(assignmentId, session.visit.placeName).catch(() => undefined);
        voiceActiveRef.current = false;
      }).catch(() => {
        // The server is authoritative for arrival. Keep navigating after a
        // transient failure and retry when another stable GPS sample arrives.
      }).finally(() => { arrivalVerificationRef.current = false; });
      return;
    }
    if (progress.distanceToManeuver <= 180) {
      const spokenKey = String(progress.maneuverIndex);
      if (!spokenRef.current.has(spokenKey)) {
        spokenRef.current.add(spokenKey);
        announce(`In ${Math.max(1, Math.round(progress.distanceToManeuver))} metres, ${progress.instruction}`);
      }
    }
    const rerouteThreshold = Math.max(45, Math.min(110, (session.accuracy ?? 25) * 1.7));
    const offRoute = progress.distanceFromRoute > rerouteThreshold;
    const heading = session.heading != null && session.heading >= 0 ? session.heading : null;
    const moving = (session.speed ?? 0) >= 1.8;
    const wrongWay = !offRoute && moving && heading != null && progress.routeHeading != null
      && headingDifference(heading, progress.routeHeading) >= 125;
    offRouteSamplesRef.current = offRoute ? offRouteSamplesRef.current + 1 : 0;
    wrongWaySamplesRef.current = wrongWay ? wrongWaySamplesRef.current + 1 : 0;
    const deviating = offRouteSamplesRef.current >= 3 || wrongWaySamplesRef.current >= 4;
    if (!deviating) {
      deviationStartedAtRef.current = 0;
      return;
    }
    if (!deviationStartedAtRef.current) deviationStartedAtRef.current = Date.now();
    if (Date.now() - deviationStartedAtRef.current < 5_000 || busy || Date.now() - lastRerouteRef.current < 15_000) return;
    lastRerouteRef.current = Date.now();
    offRouteSamplesRef.current = 0;
    wrongWaySamplesRef.current = 0;
    deviationStartedAtRef.current = 0;
    const generation = navigationGenerationRef.current;
    const assignmentId = session.visit.assignmentId;
    setBusy(true);
    void planFieldRoute(session.position, toPlace(session.visit), 'auto', session.visit.assignmentId).then((nextRoute) => {
      if (nextRoute.source !== 'unavailable' && nextRoute.coordinates.length >= 2) {
        setSession((current) => {
          if (!current || current.status !== 'active' || current.visit.assignmentId !== assignmentId || navigationGenerationRef.current !== generation) return current;
          routeProgressRef.current = { route: nextRoute.coordinates, distance: 0 };
          return { ...current, route: nextRoute, updatedAt: new Date().toISOString() };
        });
        spokenRef.current.clear();
        if (navigationGenerationRef.current === generation) announce('Route updated.');
        if (navigationGenerationRef.current === generation) {
          void notifyRouteUpdated(assignmentId, session.visit.placeName).catch(() => undefined);
        }
      }
    }).catch(() => undefined).finally(() => {
      if (navigationGenerationRef.current === generation) setBusy(false);
    });
  }, [announce, busy, progress, session, stopWatch]);

  const value = useMemo<NavigationContextValue>(() => ({
    session, progress, busy, expandNonce, screenExpanded,
    setPreview, start, stop, clear,
    requestExpand: () => { setScreenExpanded(true); setExpandNonce((value) => value + 1); router.push('/(tabs)/field-visits'); },
    setScreenExpanded,
  }), [busy, clear, expandNonce, progress, screenExpanded, session, setPreview, start, stop]);

  return <VisitNavigationContext.Provider value={value}>{children}</VisitNavigationContext.Provider>;
}

export function useVisitNavigation() {
  const value = useContext(VisitNavigationContext);
  if (!value) throw new Error('useVisitNavigation must be used within VisitNavigationProvider.');
  return value;
}

export function VisitNavigationMiniCard() {
  const { session, progress, requestExpand, screenExpanded, setScreenExpanded } = useVisitNavigation();
  const pathname = usePathname();
  const { width, height } = useWindowDimensions();
  const [position, setPosition] = useState({ x: 10, y: 76 });
  const positionRef = useRef(position);
  const dragStartRef = useRef(position);
  const updatePosition = useCallback((next: { x: number; y: number }) => {
    positionRef.current = next;
    setPosition(next);
  }, []);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragStartRef.current = positionRef.current; },
    onPanResponderMove: (_event, gesture) => updatePosition({
      x: clamp(dragStartRef.current.x + gesture.dx, 8, Math.max(8, width - FLOATING_CARD_WIDTH - 8)),
      y: clamp(dragStartRef.current.y + gesture.dy, 48, Math.max(48, height - FLOATING_CARD_HEIGHT - 16)),
    }),
  }), [height, updatePosition, width]);
  useEffect(() => {
    if (!pathname.includes('field-visits') && screenExpanded) setScreenExpanded(false);
  }, [pathname, screenExpanded, setScreenExpanded]);
  if (!session || session.status !== 'active' || screenExpanded || !pathname) return null;
  return <View pointerEvents="box-none" style={[styles.overlay, { left: position.x, top: position.y }]}>
    <Pressable onPress={requestExpand} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.icon}><Ionicons name={turnIcon(progress?.instruction || '')} size={27} color="#FFFFFF" /></View>
      <View style={styles.copy}><Text style={styles.instruction} numberOfLines={1}>{progress?.instruction || 'Continue on the route'}</Text><Text style={styles.meta}>{formatDistance(progress?.distanceToManeuver || 0)} to turn · {formatDistance(progress?.remainingDistance || 0)} left · {formatDuration(progress?.remainingDuration || 0)}</Text></View>
      <View style={styles.expand}><Ionicons name="expand" size={20} color="#1769D2" /><Text style={styles.expandText}>Open</Text></View>
    </Pressable>
    <View {...panResponder.panHandlers} style={styles.dragHandle} accessibilityLabel="Drag directions card">
      <Ionicons name="reorder-two" size={19} color="#64748B" />
    </View>
  </View>;
}

function toPlace(visit: FieldVisitAssignment) {
  return { placeId: visit.placeId, name: visit.placeName, address: visit.placeAddress, latitude: visit.latitude, longitude: visit.longitude, primaryType: null };
}
function turnIcon(instruction: string): keyof typeof Ionicons.glyphMap { const text = instruction.toLowerCase(); if (text.includes('left') || text.includes('u-turn')) return 'return-down-back'; if (text.includes('right')) return 'return-down-forward'; if (text.includes('roundabout')) return 'sync'; return 'arrow-up'; }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }

const FLOATING_CARD_WIDTH = 286;
const FLOATING_CARD_HEIGHT = 92;

const styles = StyleSheet.create({
  overlay: { position: 'absolute', width: FLOATING_CARD_WIDTH, zIndex: 1000, elevation: 1000 },
  card: { minHeight: FLOATING_CARD_HEIGHT, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 14, paddingRight: 10, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5E0EE', elevation: 12, shadowColor: '#0F172A', shadowOpacity: .22, shadowRadius: 15, shadowOffset: { width: 0, height: 7 } },
  pressed: { opacity: .86 }, icon: { width: 48, height: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769D2' }, copy: { flex: 1, minWidth: 0 }, instruction: { color: '#14233C', fontSize: 13, fontWeight: '900' }, meta: { color: '#64748B', fontSize: 10, marginTop: 4 }, expand: { minWidth: 52, alignItems: 'center' }, expandText: { color: '#1769D2', fontSize: 10, fontWeight: '800', marginTop: 1 },
  dragHandle: { position: 'absolute', right: 12, top: -10, width: 38, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5E0EE', elevation: 14 },
});
