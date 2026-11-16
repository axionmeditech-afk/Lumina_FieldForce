import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { router, usePathname } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { planFieldRoute, type FieldVisitAssignment } from '@/lib/field-tracking/api';
import { distanceToRoute, formatDistance, formatDuration, haversineMetres } from '@/lib/field-tracking/geo';
import type { Coordinate, RoutePlan } from '@/lib/field-tracking/types';

type NavigationStatus = 'preview' | 'active' | 'arrived';
type StoredSession = {
  visit: FieldVisitAssignment;
  route: RoutePlan;
  position: Coordinate | null;
  heading: number | null;
  status: NavigationStatus;
  updatedAt: string;
};
type NavigationProgress = {
  instruction: string;
  maneuverIndex: number;
  distanceToManeuver: number;
  remainingDistance: number;
  remainingDuration: number;
};
type NavigationContextValue = {
  session: StoredSession | null;
  progress: NavigationProgress | null;
  busy: boolean;
  expandNonce: number;
  screenExpanded: boolean;
  setPreview: (session: Omit<StoredSession, 'status' | 'updatedAt'>) => Promise<void>;
  start: () => Promise<void>;
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
  const lastRerouteRef = useRef(0);

  const storageKey = userId ? `@lumina_visit_navigation:v1:${userId}` : null;
  const stopWatch = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);

  useEffect(() => {
    stopWatch();
    spokenRef.current.clear();
    offRouteSamplesRef.current = 0;
    setSession(null);
    setHydrated(false);
    setScreenExpanded(false);
    if (!storageKey) { setHydrated(true); return; }
    void AsyncStorage.getItem(storageKey).then((raw) => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as StoredSession;
        if (saved?.visit?.assignmentId && saved?.route?.coordinates?.length >= 2) setSession(saved);
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
    const nearestIndex = position ? nearestRouteIndex(position, session.route.coordinates) : 0;
    const maneuverIndex = session.route.maneuvers.findIndex((item) => item.beginShapeIndex > nearestIndex + 0.15);
    const selectedIndex = maneuverIndex >= 0 ? maneuverIndex : Math.max(0, session.route.maneuvers.length - 1);
    const maneuver = session.route.maneuvers[selectedIndex];
    const total = Math.max(1, routeLength(session.route.coordinates));
    const covered = position ? distanceAlongRoute(position, session.route.coordinates, nearestIndex) : 0;
    const scale = session.route.distanceMetres ? session.route.distanceMetres / total : 1;
    const remainingDistance = Math.max(0, Math.round((total - covered) * scale));
    const distanceToManeuver = maneuver
      ? Math.max(0, Math.round(Math.max(0, routeDistanceBetween(session.route.coordinates, nearestIndex, maneuver.beginShapeIndex)) * scale))
      : 0;
    return {
      instruction: maneuver?.instruction || 'Continue on the route',
      maneuverIndex: selectedIndex,
      distanceToManeuver,
      remainingDistance,
      remainingDuration: session.route.distanceMetres && session.route.durationSeconds
        ? Math.round(session.route.durationSeconds * (remainingDistance / session.route.distanceMetres))
        : session.route.durationSeconds || 0,
    };
  }, [session]);

  const setPreview = useCallback(async (next: Omit<StoredSession, 'status' | 'updatedAt'>) => {
    stopWatch();
    Speech.stop();
    spokenRef.current.clear();
    offRouteSamplesRef.current = 0;
    setSession({ ...next, status: 'preview', updatedAt: new Date().toISOString() });
  }, [stopWatch]);

  const startWatch = useCallback(async () => {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== 'granted') throw new Error('Allow precise location for turn-by-turn directions.');
    stopWatch();
    watchRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, distanceInterval: 5, timeInterval: 3_000 },
      (location) => setSession((current) => current ? {
        ...current,
        position: { latitude: location.coords.latitude, longitude: location.coords.longitude },
        heading: Number.isFinite(location.coords.heading) ? location.coords.heading : null,
        updatedAt: new Date().toISOString(),
      } : null),
    );
  }, [stopWatch]);

  const start = useCallback(async () => {
    if (!session || session.route.coordinates.length < 2) throw new Error('Route is still loading.');
    setBusy(true);
    try {
      await startWatch();
      spokenRef.current.clear();
      offRouteSamplesRef.current = 0;
      setSession((current) => current ? { ...current, status: 'active', updatedAt: new Date().toISOString() } : null);
      speak('Directions started. Follow the highlighted route.');
    } finally { setBusy(false); }
  }, [session, startWatch]);

  const stop = useCallback((announce = false) => {
    stopWatch();
    setSession((current) => current ? { ...current, status: 'preview', updatedAt: new Date().toISOString() } : null);
    if (announce) speak('Directions stopped.'); else Speech.stop();
  }, [stopWatch]);

  const clear = useCallback(async () => {
    stopWatch();
    Speech.stop();
    setSession(null);
    if (storageKey) await AsyncStorage.removeItem(storageKey);
  }, [storageKey, stopWatch]);

  useEffect(() => {
    if (session?.status !== 'active') return;
    void startWatch().catch(() => stop());
    return stopWatch;
  }, [session?.status, startWatch, stop, stopWatch]);

  useEffect(() => {
    if (!session || session.status !== 'active' || !session.position || !progress) return;
    if (haversineMetres(session.position, session.visit) <= 50) {
      stopWatch();
      setSession((current) => current ? { ...current, status: 'arrived', updatedAt: new Date().toISOString() } : null);
      speak('You have arrived at your destination. Mark the visit complete when finished.');
      return;
    }
    if (progress.distanceToManeuver <= 180) {
      const spokenKey = String(progress.maneuverIndex);
      if (!spokenRef.current.has(spokenKey)) {
        spokenRef.current.add(spokenKey);
        speak(`In ${Math.max(1, Math.round(progress.distanceToManeuver))} metres, ${progress.instruction}`);
      }
    }
    const offRoute = distanceToRoute(session.position, session.route.coordinates) > 50;
    offRouteSamplesRef.current = offRoute ? offRouteSamplesRef.current + 1 : 0;
    if (offRouteSamplesRef.current < 3 || busy || Date.now() - lastRerouteRef.current < 15_000) return;
    lastRerouteRef.current = Date.now();
    offRouteSamplesRef.current = 0;
    setBusy(true);
    void planFieldRoute(session.position, toPlace(session.visit), 'auto').then((nextRoute) => {
      if (nextRoute.source === 'self-hosted-valhalla' && nextRoute.coordinates.length >= 2) {
        setSession((current) => current ? { ...current, route: nextRoute, updatedAt: new Date().toISOString() } : null);
        spokenRef.current.clear();
        speak('Route updated.');
      }
    }).catch(() => undefined).finally(() => setBusy(false));
  }, [busy, progress, session, stopWatch]);

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
function routeLength(route: Coordinate[]) { return route.reduce((sum, point, index) => index ? sum + haversineMetres(route[index - 1]!, point) : 0, 0); }
function nearestRouteIndex(position: Coordinate, route: Coordinate[]) { let best = 0; let distance = Number.POSITIVE_INFINITY; route.forEach((point, index) => { const next = haversineMetres(position, point); if (next < distance) { best = index; distance = next; } }); return best; }
function distanceAlongRoute(position: Coordinate, route: Coordinate[], index: number) { return routeDistanceBetween(route, 0, index) + haversineMetres(position, route[Math.min(index, route.length - 1)]!); }
function routeDistanceBetween(route: Coordinate[], from: number, to: number) { let total = 0; for (let index = Math.max(1, from + 1); index <= Math.min(to, route.length - 1); index += 1) total += haversineMetres(route[index - 1]!, route[index]!); return total; }
function turnIcon(instruction: string): keyof typeof Ionicons.glyphMap { const text = instruction.toLowerCase(); if (text.includes('left') || text.includes('u-turn')) return 'return-down-back'; if (text.includes('right')) return 'return-down-forward'; if (text.includes('roundabout')) return 'sync'; return 'arrow-up'; }
function speak(text: string) { void Speech.speak(text, { language: 'en-IN', rate: 0.95, pitch: 1 }); }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, value)); }

const FLOATING_CARD_WIDTH = 286;
const FLOATING_CARD_HEIGHT = 92;

const styles = StyleSheet.create({
  overlay: { position: 'absolute', width: FLOATING_CARD_WIDTH, zIndex: 1000, elevation: 1000 },
  card: { minHeight: FLOATING_CARD_HEIGHT, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 14, paddingRight: 10, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5E0EE', elevation: 12, shadowColor: '#0F172A', shadowOpacity: .22, shadowRadius: 15, shadowOffset: { width: 0, height: 7 } },
  pressed: { opacity: .86 }, icon: { width: 48, height: 48, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769D2' }, copy: { flex: 1, minWidth: 0 }, instruction: { color: '#14233C', fontSize: 13, fontWeight: '900' }, meta: { color: '#64748B', fontSize: 10, marginTop: 4 }, expand: { minWidth: 52, alignItems: 'center' }, expandText: { color: '#1769D2', fontSize: 10, fontWeight: '800', marginTop: 1 },
  dragHandle: { position: 'absolute', right: 12, top: -10, width: 38, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D5E0EE', elevation: 14 },
});
