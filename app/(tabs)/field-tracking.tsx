import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { RouteMap } from '@/lib/field-tracking/components/RouteMap';
import { fetchMatchedRoute, planFieldRoute, searchFieldPlaces } from '@/lib/field-tracking/api';
import { distanceToRoute, formatDistance, formatDuration, haversineMetres } from '@/lib/field-tracking/geo';
import type { Coordinate, PlaceSearchResult, RoutePlan } from '@/lib/field-tracking/types';
import { useFieldTracker } from '@/lib/field-tracking/useTracker';

const EMPTY_ROUTE: RoutePlan = {
  source: 'unavailable',
  distanceMetres: null,
  durationSeconds: null,
  coordinates: [],
  maneuvers: [],
};

import { AdminScreen } from '@/lib/field-tracking/admin/AdminScreen';

function EmployeeTrackingScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { user, company } = useAuth();
  const { snapshot, busy, start, stop, sync } = useFieldTracker(user?.id, company?.id ?? user?.companyId);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [destination, setDestination] = useState<PlaceSearchResult | null>(null);
  const [route, setRoute] = useState<RoutePlan>(EMPTY_ROUTE);
  const [planning, setPlanning] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [travelMode, setTravelMode] = useState<'auto' | 'pedestrian' | 'bicycle'>('auto');
  const [matchedRoute, setMatchedRoute] = useState<Coordinate[]>([]);
  const [matchedSource, setMatchedSource] = useState<'self-hosted-valhalla' | 'raw'>('raw');
  const rerouteSamplesRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const arrivalSamplesRef = useRef(0);
  const lastMatchedSequenceRef = useRef(0);

  const active = snapshot.session?.status === 'active';
  const activeWorkspaceChanged = Boolean(
    active && snapshot.session?.companyId && company?.id && snapshot.session.companyId !== company.id,
  );
  const latest = useMemo(
    () => snapshot.points.filter((point) => point.routeEligible || point.rejectionReason === 'stationary_noise').at(-1) ?? null,
    [snapshot.points],
  );
  const currentPosition = useMemo(
    () => latest ? { latitude: latest.latitude, longitude: latest.longitude } : null,
    [latest],
  );
  const routeIndex = useMemo(() => nearestRouteIndex(currentPosition, route.coordinates), [currentPosition, route.coordinates]);
  const progress = route.coordinates.length > 1 && routeIndex >= 0
    ? Math.max(0, Math.min(1, routeIndex / (route.coordinates.length - 1)))
    : 0;
  const remainingDistance = route.distanceMetres == null ? null : Math.round(route.distanceMetres * (1 - progress));
  const remainingDuration = route.durationSeconds == null ? null : Math.round(route.durationSeconds * (1 - progress));
  const nextManeuver = route.maneuvers.find((item) => item.endShapeIndex >= routeIndex) ?? route.maneuvers.at(-1) ?? null;

  const search = useCallback(async () => {
    const value = query.trim();
    if (value.length < 3) {
      Alert.alert('Enter a destination', 'Type at least 3 characters to search.');
      return;
    }
    setSearching(true);
    Keyboard.dismiss();
    try {
      setResults(await searchFieldPlaces(value, currentPosition ?? undefined));
    } catch (error) {
      Alert.alert('Place search unavailable', humanizeError(error));
    } finally {
      setSearching(false);
    }
  }, [currentPosition, query]);

  const buildRoute = useCallback(async (place: PlaceSearchResult, quiet = false) => {
    if (!currentPosition) {
      if (!quiet) Alert.alert('Waiting for GPS', 'Start field tracking and wait for a reliable live location first.');
      return;
    }
    setPlanning(true);
    try {
      const planned = await planFieldRoute(currentPosition, place, travelMode);
      if (planned.source !== 'self-hosted-valhalla' || planned.coordinates.length < 2) {
        throw new Error('No route was found inside the installed map region.');
      }
      setDestination(place);
      setRoute(planned);
      setResults([]);
      setQuery(place.name);
      rerouteSamplesRef.current = 0;
    } catch (error) {
      if (!quiet) Alert.alert('Route unavailable', humanizeError(error));
    } finally {
      setPlanning(false);
    }
  }, [currentPosition, travelMode]);

  useEffect(() => {
    const sessionId = snapshot.session?.id;
    const sequence = latest?.sequence ?? 0;
    if (!sessionId || sequence < 2 || sequence === lastMatchedSequenceRef.current) return;
    if (sequence - lastMatchedSequenceRef.current < 12 && lastMatchedSequenceRef.current > 0) return;
    lastMatchedSequenceRef.current = sequence;
    void fetchMatchedRoute(sessionId).then((matched) => {
      setMatchedRoute(matched.points);
      setMatchedSource(matched.source);
    }).catch(() => undefined);
  }, [latest?.sequence, snapshot.session?.id]);

  useEffect(() => {
    if (!navigationActive || !destination || !currentPosition || route.coordinates.length < 2) return;
    const offRouteDistance = distanceToRoute(currentPosition, route.coordinates);
    const offRouteThreshold = Math.max(60, Math.min(120, (latest?.accuracy ?? 40) * 1.6));
    rerouteSamplesRef.current = offRouteDistance > offRouteThreshold ? rerouteSamplesRef.current + 1 : 0;

    const arrivalThreshold = Math.max(45, Math.min(100, (latest?.accuracy ?? 30) * 1.5));
    const destinationDistance = haversineMetres(currentPosition, destination);
    arrivalSamplesRef.current = destinationDistance <= arrivalThreshold ? arrivalSamplesRef.current + 1 : 0;
    if (arrivalSamplesRef.current >= 2) {
      setNavigationActive(false);
      arrivalSamplesRef.current = 0;
      Alert.alert('Destination reached', `You have arrived at ${destination.name}.`);
      return;
    }

    if (rerouteSamplesRef.current >= 3 && Date.now() - lastRerouteAtRef.current > 20_000 && snapshot.networkConnected) {
      lastRerouteAtRef.current = Date.now();
      rerouteSamplesRef.current = 0;
      void buildRoute(destination, true);
    }
  }, [buildRoute, currentPosition, destination, latest?.accuracy, latest?.sequence, navigationActive, route.coordinates, snapshot.networkConnected]);

  const toggleTracking = async () => {
    try {
      if (active) {
        setNavigationActive(false);
        await stop();
      } else {
        await start();
      }
    } catch (error) {
      Alert.alert(active ? 'Could not end field shift' : 'Could not start field shift', humanizeError(error));
    }
  };

  const changeTravelMode = (mode: 'auto' | 'pedestrian' | 'bicycle') => {
    setTravelMode(mode);
    if (!destination || !currentPosition) return;
    setPlanning(true);
    void planFieldRoute(currentPosition, destination, mode)
      .then((planned) => {
        if (planned.source === 'self-hosted-valhalla' && planned.coordinates.length >= 2) setRoute(planned);
      })
      .catch((error) => Alert.alert('Route unavailable', humanizeError(error)))
      .finally(() => setPlanning(false));
  };

  const clearDestination = () => {
    setDestination(null);
    setRoute(EMPTY_ROUTE);
    setNavigationActive(false);
    setQuery('');
    setResults([]);
  };

  const statusText = !active
    ? snapshot.pendingCount > 0 ? `${snapshot.pendingCount} queued` : 'Ready'
    : !snapshot.locationServicesEnabled
      ? 'Location off'
      : !snapshot.networkConnected
        ? `${snapshot.pendingCount || 0} queued · Offline`
        : !snapshot.serverReachable
          ? `${snapshot.pendingCount || 0} queued · Sync unavailable`
          : snapshot.pendingCount > 0
            ? `${snapshot.pendingCount} queued`
            : 'Live';

  return (
    <View style={styles.screen}>
      <RouteMap
        points={snapshot.points}
        matchedRoute={matchedRoute}
        matchedRouteSource={matchedSource}
        plannedRoute={route.coordinates}
        destination={destination}
        progressPercent={progress * 100}
        navigationActive={navigationActive}
        previewRoute={Boolean(destination && !navigationActive)}
        heading={latest?.heading}
      />

      <View style={[styles.searchShell, { top: insets.top + 10 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          onPress={() => (navigation as any).openDrawer?.()}
          style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}
        >
          <Ionicons name="menu" size={25} color="#152238" />
        </Pressable>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={20} color="#64748B" />
          <TextInput
            value={query}
            onChangeText={(value) => { setQuery(value); if (!value.trim()) setResults([]); }}
            onSubmitEditing={() => void search()}
            placeholder="Where do you need to go?"
            placeholderTextColor="#7B8798"
            returnKeyType="search"
            style={styles.searchInput}
          />
          {searching || planning ? <ActivityIndicator size="small" color="#1769D2" /> : (
            <Pressable onPress={() => void search()} hitSlop={10}>
              <Ionicons name="arrow-forward-circle" size={28} color="#1769D2" />
            </Pressable>
          )}
        </View>
      </View>

      {results.length ? (
        <View style={[styles.resultsCard, { top: insets.top + 76 }]}>
          {results.slice(0, 5).map((place) => (
            <Pressable key={place.placeId} onPress={() => void buildRoute(place)} style={({ pressed }) => [styles.resultRow, pressed && styles.resultPressed]}>
              <Ionicons name="location-outline" size={20} color="#1769D2" />
              <View style={styles.resultCopy}>
                <Text style={styles.resultTitle} numberOfLines={1}>{place.name}</Text>
                <Text style={styles.resultAddress} numberOfLines={2}>{place.address}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      {navigationActive && nextManeuver ? (
        <View style={[styles.guidanceCard, { top: insets.top + 78 }]}>
          <View style={styles.guidanceIcon}><Ionicons name="navigate" size={26} color="#FFFFFF" /></View>
          <View style={styles.guidanceCopy}>
            <Text style={styles.guidanceTitle} numberOfLines={2}>{nextManeuver.instruction}</Text>
            <Text style={styles.guidanceMeta}>{formatDistance(remainingDistance ?? 0)} left · {formatDuration(remainingDuration ?? 0)}</Text>
          </View>
          <Pressable onPress={() => setNavigationActive(false)} style={styles.stopNavButton}>
            <Text style={styles.stopNavText}>Stop</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.bottomCard, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.statusRow}>
          <View style={[styles.liveDot, active && styles.liveDotActive]} />
          <View style={styles.statusCopy}>
            <Text style={styles.statusTitle}>{navigationActive ? destination?.name : 'Field Tracking'}</Text>
            <Text style={styles.statusMeta} numberOfLines={1}>
              {navigationActive
                ? `${formatDistance(remainingDistance ?? 0)} · ${formatDuration(remainingDuration ?? 0)}`
                : `${activeWorkspaceChanged ? 'Previous workspace' : company?.name || 'Workspace'} · ${statusText} · ${formatDistance(snapshot.distanceMetres)}`}
            </Text>
          </View>
          {snapshot.pendingCount > 0 ? (
            <Pressable onPress={() => void sync()} style={styles.syncButton} disabled={busy}>
              <Ionicons name="sync" size={18} color="#1769D2" />
            </Pressable>
          ) : null}
        </View>

        {destination && !navigationActive ? (
          <View style={styles.routeRow}>
            <View style={styles.routeMetrics}>
              <Text style={styles.routeTime}>{formatDuration(route.durationSeconds ?? 0)}</Text>
              <Text style={styles.routeDistance}>{formatDistance(route.distanceMetres ?? 0)}</Text>
            </View>
            <View style={styles.modeRow}>
              {(['auto', 'pedestrian', 'bicycle'] as const).map((mode) => (
                <Pressable
                  key={mode}
                  onPress={() => changeTravelMode(mode)}
                  style={[styles.modeButton, travelMode === mode && styles.modeButtonActive]}
                >
                  <Ionicons name={mode === 'auto' ? 'car' : mode === 'pedestrian' ? 'walk' : 'bicycle'} size={18} color={travelMode === mode ? '#FFFFFF' : '#475569'} />
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={() => setNavigationActive(true)}
              disabled={!active || route.coordinates.length < 2}
              style={({ pressed }) => [styles.goButton, (!active || route.coordinates.length < 2) && styles.disabled, pressed && styles.pressed]}
            >
              <Ionicons name="navigate" size={19} color="#FFFFFF" />
              <Text style={styles.goButtonText}>Start</Text>
            </Pressable>
            <Pressable onPress={clearDestination} accessibilityLabel="Clear destination" style={styles.clearButton}>
              <Ionicons name="close" size={20} color="#475569" />
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => void toggleTracking()}
            disabled={busy}
            style={({ pressed }) => [styles.shiftButton, active && styles.shiftButtonStop, busy && styles.disabled, pressed && styles.pressed]}
          >
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name={active ? 'stop-circle' : 'play-circle'} size={22} color="#FFFFFF" />}
            <Text style={styles.shiftButtonText}>{active ? 'End field shift' : 'Start field shift'}</Text>
          </Pressable>
        )}

        {active && snapshot.backgroundCapable && !snapshot.backgroundPermission ? (
          <Text style={styles.warningText}>Allow background location for tracking while the phone is locked.</Text>
        ) : null}
        {active && !snapshot.backgroundCapable ? (
          <Text style={styles.warningText}>Expo Go records only while this app is open. Use the installed Android app for locked-screen tracking.</Text>
        ) : null}
        {activeWorkspaceChanged ? (
          <Text style={styles.warningText}>This field shift belongs to the workspace where it was started. End it before tracking in the selected workspace.</Text>
        ) : null}
      </View>
    </View>
  );
}

function nearestRouteIndex(point: Coordinate | null, route: Coordinate[]): number {
  if (!point || !route.length) return -1;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  const step = Math.max(1, Math.floor(route.length / 500));
  for (let index = 0; index < route.length; index += step) {
    const distance = haversineMetres(point, route[index]!);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function humanizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Please try again.';
  const known: Record<string, string> = {
    self_hosted_geocoder_not_configured: 'Destination search is not configured on the server yet.',
    self_hosted_router_not_configured: 'The route engine is not configured on the server yet.',
    self_hosted_router_unavailable: 'The route engine is temporarily unavailable.',
  };
  return known[message] || message.replace(/_/g, ' ');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#E9EEF5' },
  searchShell: { position: 'absolute', left: 14, right: 14, flexDirection: 'row', gap: 10, alignItems: 'center' },
  roundButton: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.98)', borderWidth: 1, borderColor: '#D8E0EA', elevation: 5, shadowColor: '#0F172A', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  searchBox: { flex: 1, height: 54, borderRadius: 27, paddingHorizontal: 16, gap: 10, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.98)', borderWidth: 1, borderColor: '#D8E0EA', elevation: 5, shadowColor: '#0F172A', shadowOpacity: 0.14, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  searchInput: { flex: 1, color: '#111827', fontSize: 15, fontFamily: 'Inter_500Medium', paddingVertical: 0 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  resultsCard: { position: 'absolute', left: 74, right: 14, borderRadius: 20, paddingVertical: 6, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', elevation: 8, shadowColor: '#0F172A', shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: { width: 0, height: 7 } },
  resultRow: { minHeight: 64, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E7ECF2' },
  resultPressed: { backgroundColor: '#F4F7FB' },
  resultCopy: { flex: 1 },
  resultTitle: { color: '#111827', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  resultAddress: { color: '#64748B', fontSize: 11, lineHeight: 16, marginTop: 2, fontFamily: 'Inter_400Regular' },
  guidanceCard: { position: 'absolute', left: 14, right: 14, minHeight: 82, borderRadius: 22, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#142849', elevation: 7, shadowColor: '#020617', shadowOpacity: 0.25, shadowRadius: 14, shadowOffset: { width: 0, height: 7 } },
  guidanceIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.13)', alignItems: 'center', justifyContent: 'center' },
  guidanceCopy: { flex: 1 },
  guidanceTitle: { color: '#FFFFFF', fontSize: 15, lineHeight: 20, fontFamily: 'Inter_600SemiBold' },
  guidanceMeta: { color: '#CBD5E1', fontSize: 11, marginTop: 4, fontFamily: 'Inter_500Medium' },
  stopNavButton: { minWidth: 50, height: 36, borderRadius: 18, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  stopNavText: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  bottomCard: { position: 'absolute', left: 12, right: 12, bottom: 10, borderRadius: 26, paddingTop: 15, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.98)', borderWidth: 1, borderColor: '#D8E0EA', elevation: 10, shadowColor: '#0F172A', shadowOpacity: 0.19, shadowRadius: 18, shadowOffset: { width: 0, height: 9 } },
  statusRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 11 },
  liveDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#94A3B8' },
  liveDotActive: { backgroundColor: '#10A779', shadowColor: '#10A779', shadowOpacity: 0.35, shadowRadius: 5 },
  statusCopy: { flex: 1 },
  statusTitle: { color: '#111827', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  statusMeta: { color: '#64748B', fontSize: 11, marginTop: 3, fontFamily: 'Inter_400Regular' },
  syncButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EDF4FE' },
  routeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  routeMetrics: { minWidth: 54 },
  routeTime: { color: '#0B8C66', fontSize: 16, fontFamily: 'Inter_700Bold' },
  routeDistance: { color: '#64748B', fontSize: 11, marginTop: 2, fontFamily: 'Inter_500Medium' },
  modeRow: { flex: 1, flexDirection: 'row', gap: 5 },
  modeButton: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F0F3F7' },
  modeButtonActive: { backgroundColor: '#334155' },
  goButton: { height: 40, borderRadius: 20, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: '#1769D2' },
  goButtonText: { color: '#FFFFFF', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  clearButton: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF2F6' },
  shiftButton: { height: 50, borderRadius: 18, marginTop: 10, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769D2' },
  shiftButtonStop: { backgroundColor: '#C2413C' },
  shiftButtonText: { color: '#FFFFFF', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  warningText: { color: '#B45309', fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 9, fontFamily: 'Inter_500Medium' },
  disabled: { opacity: 0.48 },
});

export default function FieldTrackingScreen() {
  const { user } = useAuth();
  const isSupervisor = user?.role === 'admin' || user?.role === 'manager' || user?.role === 'hr';
  
  if (isSupervisor) {
    return <AdminScreen />;
  }
  return <EmployeeTrackingScreen />;
}

