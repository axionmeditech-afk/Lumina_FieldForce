import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { router, useIsFocused, useNavigation } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { useVisitNavigation } from '@/contexts/VisitNavigationContext';
import { getAttendanceStatus, getUsersRemote } from '@/lib/attendance-api';
import { getCurrentPositionWithTimeout, getLastKnownLocationSafe } from '@/lib/location-service';
import {
  completeFieldVisitAssignment,
  createFieldVisitAssignment,
  getFieldVisitAssignments,
  planFieldRoute,
  searchFieldPlaces,
  startFieldVisitAssignment,
  type FieldVisitAssignment,
} from '@/lib/field-tracking/api';
import { RouteMap } from '@/lib/field-tracking/components/RouteMap';
import { formatDistance, formatDuration, haversineMetres } from '@/lib/field-tracking/geo';
import type { PlaceSearchResult, RoutePlan } from '@/lib/field-tracking/types';
import { subscribeToVisitNavigationCheckout } from '@/lib/field-tracking/visit-navigation-lifecycle';
import { formatMumbaiDateKey, getMumbaiDateKeyByOffset, toMumbaiDateKey } from '@/lib/ist-time';

const EMPTY_ROUTE: RoutePlan = {
  source: 'unavailable', distanceMetres: null, durationSeconds: null, coordinates: [], maneuvers: [],
};

const isSupervisor = (role?: string | null) => ['admin', 'hr', 'manager'].includes(role || '');

export default function FieldVisitsScreen() {
  const { user, company } = useAuth();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const visitNavigation = useVisitNavigation();
  const supervisor = isSupervisor(user?.role);
  const [assignments, setAssignments] = useState<FieldVisitAssignment[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSearchResult | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => defaultVisitDate());
  const [scheduledTime, setScheduledTime] = useState(() => defaultVisitTime());
  const [saving, setSaving] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<FieldVisitAssignment | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [route, setRoute] = useState<RoutePlan>(EMPTY_ROUTE);
  const [routing, setRouting] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [currentAccuracy, setCurrentAccuracy] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [checkedIn, setCheckedIn] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [visitActionBusy, setVisitActionBusy] = useState(false);
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const offRouteSamplesRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const spokenRef = useRef(new Set<string>());

  // The provider survives drawer/tab navigation. This screen simply mirrors
  // it when the full map is opened again from the compact navigator.
  useEffect(() => {
    const saved = visitNavigation.session;
    if (!saved) return;
    setSelectedVisit(saved.visit);
    setRoute(saved.route);
    setCurrentPosition(saved.position);
    setCurrentAccuracy(saved.accuracy);
    setHeading(saved.heading);
    setNavigationActive(saved.status === 'active');
    setArrived(saved.status === 'arrived');
  }, [visitNavigation.session?.updatedAt]);

  useEffect(() => subscribeToVisitNavigationCheckout(() => {
    setCheckedIn(false);
    setNavigationActive(false);
    setArrived(false);
  }), []);

  useEffect(() => {
    if (!visitNavigation.expandNonce || !visitNavigation.session) return;
    setMapOpen(true);
  }, [visitNavigation.expandNonce, visitNavigation.session]);

  useEffect(() => {
    visitNavigation.setScreenExpanded(mapOpen);
    return () => visitNavigation.setScreenExpanded(false);
  }, [mapOpen, visitNavigation.setScreenExpanded]);

  const reload = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const [nextAssignments, nextEmployees, attendance] = await Promise.all([
        getFieldVisitAssignments(),
        supervisor ? getUsersRemote({ companyId: company?.id }) : Promise.resolve([]),
        supervisor ? Promise.resolve({ active: null }) : getAttendanceStatus().catch(() => ({ records: [], active: null })),
      ]);
      setAssignments(nextAssignments);
      setEmployees(nextEmployees.filter((item: any) => item.id && !isSupervisor(item.role)));
      if (!supervisor) setCheckedIn(Boolean(attendance.active));
    } catch (error) {
      if (!quiet) Alert.alert('Visit queue unavailable', humanize(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [company?.id, supervisor]);

  useEffect(() => {
    if (!isFocused) return;
    void reload();
  }, [isFocused, reload]);

  const pending = useMemo(() => assignments.filter((item) => item.status === 'pending' || item.status === 'in_progress'), [assignments]);
  const employeeById = useMemo(() => new Map(employees.map((item: any) => [String(item.id), item])), [employees]);

  const searchPlaces = async () => {
    if (query.trim().length < 3) {
      Alert.alert('Search a place', 'Enter at least 3 characters for a precise location.');
      return;
    }
    setSearching(true);
    try {
      setResults(await searchFieldPlaces(query.trim()));
    } catch (error) {
      Alert.alert('Place search unavailable', humanize(error));
    } finally {
      setSearching(false);
    }
  };

  const assignVisit = async () => {
    if (!selectedEmployeeId || !selectedPlace) {
      Alert.alert('Choose employee and place', 'Select the field employee and an exact search result first.');
      return;
    }
    if (!isValidVisitDate(scheduledDate) || scheduledDate < getMumbaiDateKeyByOffset(0)) {
      Alert.alert('Choose visit date', 'Enter a valid current or future date as YYYY-MM-DD.');
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduledTime)) {
      Alert.alert('Choose visit time', 'Enter time in 24-hour HH:MM format, for example 14:30.');
      return;
    }
    setSaving(true);
    try {
      await createFieldVisitAssignment({
        employeeId: selectedEmployeeId,
        place: selectedPlace,
        scheduledDate,
        scheduledTime,
        notes,
      });
      setSelectedPlace(null);
      setSelectedEmployeeId(null);
      setQuery('');
      setResults([]);
      setNotes('');
      await reload(true);
      Alert.alert('Visit assigned', `Scheduled for ${formatVisitSchedule(scheduledDate, scheduledTime)}.`);
    } catch (error) {
      Alert.alert('Could not assign visit', humanize(error));
    } finally {
      setSaving(false);
    }
  };

  const stopDirections = useCallback((announce = false) => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
    setNavigationActive(false);
    if (visitNavigation.session?.status === 'active') visitNavigation.stop(announce);
    else if (announce) speak('Directions stopped.');
    else Speech.stop();
  }, [visitNavigation]);

  // Do not stop a navigation session when this screen unmounts. The root
  // provider keeps location, voice and rerouting alive while the user moves
  // through attendance, dashboard or the visit queue.
  useEffect(() => () => undefined, []);

  const openVisit = async (visit: FieldVisitAssignment) => {
    stopDirections();
    await visitNavigation.clear();
    setMapOpen(true);
    setSelectedVisit(visit);
    setRoute(EMPTY_ROUTE);
    setCurrentPosition(null);
    setCurrentAccuracy(null);
    setHeading(null);
    setArrived(false);
    setRerouting(false);
    offRouteSamplesRef.current = 0;
    spokenRef.current.clear();
  };

  const startDirections = async () => {
    if (!selectedVisit || selectedVisit.status !== 'pending') return;
    setRouting(true);
    try {
      const attendance = await getAttendanceStatus();
      setCheckedIn(Boolean(attendance.active));
      if (!attendance.active) {
        Alert.alert('Check-in required', 'Check in before starting directions for this visit.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Go to attendance', onPress: () => router.push('/(tabs)/attendance') },
        ]);
        return;
      }
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') throw new Error('Allow precise location to start directions.');
      // Expo's unbounded getCurrentPositionAsync can wait indefinitely on
      // some Android devices. Prefer a live fix, then a recent precise cached
      // fix, and always return control to the employee within a fixed window.
      const location = await getCurrentPositionWithTimeout(
        { accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true },
        12_000,
      ).catch(async () => {
        const cached = await getLastKnownLocationSafe({ requiredAccuracy: 120, maxAgeMs: 60_000 });
        if (!cached) throw new Error('GPS fix timed out. Move near an open area and retry.');
        return cached;
      });
      const position = { latitude: location.coords.latitude, longitude: location.coords.longitude };
      const nextHeading = Number.isFinite(location.coords.heading) ? location.coords.heading : null;
      const accuracy = Number.isFinite(location.coords.accuracy) ? location.coords.accuracy : null;
      const planned = await planFieldRoute(position, {
        placeId: selectedVisit.placeId, name: selectedVisit.placeName, address: selectedVisit.placeAddress,
        latitude: selectedVisit.latitude, longitude: selectedVisit.longitude, primaryType: null,
      }, 'auto', selectedVisit.assignmentId);
      if (planned.source === 'unavailable' || planned.coordinates.length < 2) throw new Error('No road route was found for this place.');
      setCurrentPosition(position);
      setCurrentAccuracy(accuracy);
      setHeading(nextHeading);
      setRoute(planned);
      await visitNavigation.start({ visit: selectedVisit, route: planned, position, heading: nextHeading, accuracy });
      setArrived(false);
      setNavigationActive(true);
    } catch (error) {
      setNavigationActive(false);
      Alert.alert('Directions unavailable', humanize(error));
    } finally {
      setRouting(false);
    }
  };

  const startVisit = async (visit: FieldVisitAssignment) => {
    if (!currentPosition) {
      Alert.alert('Current location required', 'Wait for a precise GPS fix before starting the visit.');
      return;
    }
    setVisitActionBusy(true);
    try {
      const result = await startFieldVisitAssignment(visit.assignmentId, { ...currentPosition, accuracy: currentAccuracy });
      stopDirections();
      await visitNavigation.clear();
      setSelectedVisit(result.assignment);
      setAssignments((current) => current.map((item) => item.assignmentId === result.assignment.assignmentId ? result.assignment : item));
      setRoute(EMPTY_ROUTE);
      setArrived(false);
      speak('Visit started. Complete it here when your work is finished.');
    } catch (error) {
      Alert.alert('Could not start visit', humanize(error));
    } finally {
      setVisitActionBusy(false);
    }
  };

  const completeVisit = async (visit: FieldVisitAssignment) => {
    setVisitActionBusy(true);
    try {
      const result = await completeFieldVisitAssignment(
        visit.assignmentId,
        currentPosition ? { ...currentPosition, accuracy: currentAccuracy } : undefined,
      );
      stopDirections();
      await visitNavigation.clear();
      setSelectedVisit(null);
      setMapOpen(false);
      setRoute(EMPTY_ROUTE);
      await reload(true);
      if (result.nextAssignment) {
        Alert.alert(
          'Visit completed',
          `Next suggested visit: ${result.nextAssignment.placeName}. Directions will start only when you choose them.`,
          [
            { text: 'Back to queue', style: 'cancel' },
            { text: 'View next visit', onPress: () => void openVisit(result.nextAssignment!) },
          ],
        );
      } else {
        Alert.alert('Visit completed', 'All currently assigned visits are complete.');
      }
    } catch (error) {
      Alert.alert('Could not complete visit', humanize(error));
    } finally {
      setVisitActionBusy(false);
    }
  };

  const routeMetrics = useMemo(() => buildRouteMetrics(route.coordinates), [route.coordinates]);
  const projection = useMemo(
    () => currentPosition ? projectOnRoute(currentPosition, route.coordinates, routeMetrics) : null,
    [currentPosition, route.coordinates, routeMetrics],
  );
  const nextManeuver = useMemo(() => {
    const shapePosition = projection?.shapePosition ?? 0;
    const index = route.maneuvers.findIndex((maneuver) => maneuver.beginShapeIndex > shapePosition + 0.15);
    const maneuverIndex = index >= 0 ? index : Math.max(0, route.maneuvers.length - 1);
    const maneuver = route.maneuvers[maneuverIndex] ?? null;
    const scale = routeMetrics.totalMeters > 0 && route.distanceMetres ? route.distanceMetres / routeMetrics.totalMeters : 1;
    const remainingDistance = Math.max(0, Math.round((routeMetrics.totalMeters - (projection?.distanceAlongRouteMeters ?? 0)) * scale));
    return {
      maneuver,
      maneuverIndex,
      distanceToManeuver: maneuver ? Math.max(0, Math.round(distanceToShapeIndex(projection, routeMetrics, maneuver.beginShapeIndex) * scale)) : 0,
      remainingDistance,
      remainingDuration: route.distanceMetres && route.durationSeconds ? Math.round(route.durationSeconds * (remainingDistance / route.distanceMetres)) : route.durationSeconds || 0,
    };
  }, [projection, route.distanceMetres, route.durationSeconds, route.maneuvers, routeMetrics]);
  const progressPercent = routeMetrics.totalMeters > 0 ? Math.max(0, Math.min(100, ((projection?.distanceAlongRouteMeters ?? 0) / routeMetrics.totalMeters) * 100)) : 0;
  const previewArrival = route.durationSeconds ? new Date(Date.now() + route.durationSeconds * 1_000) : null;
  const mapPoints = useMemo(() => currentPosition ? [{
    pointId: 'visit-navigation-position', sessionId: 'visit-navigation', sequence: 1,
    latitude: currentPosition.latitude, longitude: currentPosition.longitude,
    accuracy: 12, speed: null, heading, battery: null, mocked: false,
    capturedAt: new Date().toISOString(), syncedAt: null, routeEligible: true, rejectionReason: null,
  }] : [], [currentPosition, heading]);

  useEffect(() => {
    if (visitNavigation.session) return;
    if (!navigationActive || !selectedVisit || !currentPosition) return;
    const destinationDistance = haversineMetres(currentPosition, selectedVisit);
    if (destinationDistance > 100) return;
    setArrived(true);
    stopDirections();
    speak(`You have reached ${selectedVisit.placeName}. Start the visit when ready.`);
  }, [currentPosition, navigationActive, selectedVisit, stopDirections, visitNavigation.session]);

  useEffect(() => {
    if (visitNavigation.session) return;
    if (!navigationActive || !nextManeuver.maneuver) return;
    // Speak one precise prompt for each maneuver, rather than repeating the
    // same instruction at both the advance and immediate thresholds.
    if (nextManeuver.distanceToManeuver > 180) return;
    const key = String(nextManeuver.maneuverIndex);
    if (spokenRef.current.has(key)) return;
    spokenRef.current.add(key);
    const instruction = nextManeuver.maneuver.verbalInstruction || nextManeuver.maneuver.instruction;
    const metres = Math.max(1, Math.round(nextManeuver.distanceToManeuver));
    speak(`In ${metres} metres, ${instruction}`);
  }, [navigationActive, nextManeuver.distanceToManeuver, nextManeuver.maneuver, nextManeuver.maneuverIndex, visitNavigation.session]);

  useEffect(() => {
    if (visitNavigation.session) return;
    if (!navigationActive || !currentPosition || !selectedVisit || rerouting || route.coordinates.length < 2) return;
    const offRoute = (projection?.distanceFromRouteMeters ?? 0) > 50;
    offRouteSamplesRef.current = offRoute ? offRouteSamplesRef.current + 1 : 0;
    if (offRouteSamplesRef.current < 3 || Date.now() - lastRerouteAtRef.current < 15_000) return;
    lastRerouteAtRef.current = Date.now();
    offRouteSamplesRef.current = 0;
    setRerouting(true);
    void planFieldRoute(currentPosition, {
      placeId: selectedVisit.placeId, name: selectedVisit.placeName, address: selectedVisit.placeAddress,
      latitude: selectedVisit.latitude, longitude: selectedVisit.longitude, primaryType: null,
    }, 'auto', selectedVisit.assignmentId).then((nextRoute) => {
      if (nextRoute.source !== 'unavailable' && nextRoute.coordinates.length >= 2) {
        setRoute(nextRoute);
        spokenRef.current.clear();
        speak('Route updated.');
      }
    }).catch(() => undefined).finally(() => setRerouting(false));
  }, [currentPosition, navigationActive, projection?.distanceFromRouteMeters, rerouting, route.coordinates.length, selectedVisit, visitNavigation.session]);

  const selectedVisitScheduledToday = selectedVisit?.scheduledDate === toMumbaiDateKey(new Date());

  if (selectedVisit && mapOpen && !supervisor) {
    return (
      <View style={styles.mapScreen}>
        <RouteMap points={mapPoints} plannedRoute={route.coordinates} destination={selectedVisit} previewRoute={!navigationActive} navigationActive={navigationActive} progressPercent={progressPercent} heading={heading ?? undefined} />
        <SafeAreaView style={styles.mapTop} edges={['top', 'left', 'right']}>
          <View style={styles.destinationHeader}>
            <Pressable onPress={() => setMapOpen(false)} style={styles.menuButton}>
              <Ionicons name="arrow-back" size={22} color="#152238" />
            </Pressable>
            <View style={styles.destinationCopy}>
              <Text style={styles.destinationTitle} numberOfLines={1}>{selectedVisit.placeName}</Text>
              <Text style={styles.destinationAddress} numberOfLines={1}>{selectedVisit.placeAddress}</Text>
            </View>
          </View>
          <View style={[styles.routeCard, navigationActive && styles.routeCardNavigating]}>
            {routing ? <ActivityIndicator color="#1769D2" style={{ marginTop: 10 }} /> : navigationActive && nextManeuver.maneuver ? (
              <View style={styles.maneuverRow}><View style={styles.turnArrowShell}><Ionicons name={turnIcon(nextManeuver.maneuver.instruction)} size={39} color="#FFFFFF" /></View><View style={styles.maneuverCopy}><Text style={styles.directionInstruction} numberOfLines={2}>{nextManeuver.maneuver.instruction}</Text><Text style={[styles.routeMetric, styles.routeMetricNavigating]}>{formatDistance(nextManeuver.distanceToManeuver)} to next turn · {formatDistance(nextManeuver.remainingDistance)} remaining</Text></View></View>
            ) : selectedVisit.status === 'in_progress' ? (
              <View style={styles.previewRouteRow}><View style={[styles.previewIconShell, styles.visitStartedIcon]}><Ionicons name="briefcase" size={23} color="#16835B" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Visit in progress</Text><Text style={styles.previewRouteMeta}>Complete the assigned work, then record the visit completion here.</Text></View></View>
            ) : arrived ? (
              <View style={styles.previewRouteRow}><View style={[styles.previewIconShell, styles.arrivedIcon]}><Ionicons name="location" size={24} color="#16835B" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>You have reached {selectedVisit.placeName}</Text><Text style={styles.previewRouteMeta}>Start visit when you are ready to begin the assigned work.</Text></View></View>
            ) : route.distanceMetres != null ? (
              <View style={styles.previewRouteRow}><View style={styles.previewIconShell}><Ionicons name="navigate" size={24} color="#1769D2" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Best road route ready</Text><Text style={styles.routeMetric}>{formatDistance(route.distanceMetres)} · {formatDuration(route.durationSeconds || 0)}</Text><Text style={styles.previewRouteMeta}>{previewArrival ? `Arrive by ${formatArrival(previewArrival)}` : 'Arrival time calculating'} · Voice guidance ready</Text></View></View>
            ) : !selectedVisitScheduledToday ? (
              <View style={styles.previewRouteRow}><View style={[styles.previewIconShell, styles.lockedIcon]}><Ionicons name="calendar" size={22} color="#9A6200" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Scheduled for {formatVisitSchedule(selectedVisit.scheduledDate, selectedVisit.scheduledTime)}</Text><Text style={styles.previewRouteMeta}>Directions become available on the assigned visit date.</Text></View></View>
            ) : checkedIn ? (
              <View style={styles.previewRouteRow}><View style={styles.previewIconShell}><Ionicons name="navigate" size={24} color="#1769D2" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Ready for directions</Text><Text style={styles.previewRouteMeta}>The road route will be calculated only after you tap Start directions.</Text></View></View>
            ) : <View style={styles.previewRouteRow}><View style={[styles.previewIconShell, styles.lockedIcon]}><Ionicons name="lock-closed" size={22} color="#9A6200" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Check-in required</Text><Text style={styles.previewRouteMeta}>Complete attendance check-in before starting directions.</Text></View></View>}
          </View>
        </SafeAreaView>
        <SafeAreaView style={styles.mapBottom} edges={['bottom', 'left', 'right']}>
          {selectedVisit.status === 'in_progress' ? <Pressable onPress={() => void completeVisit(selectedVisit)} disabled={visitActionBusy} style={[styles.completeButton, visitActionBusy && styles.dimmed]}>
            {visitActionBusy ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />}<Text style={styles.completeButtonText}>Complete visit</Text>
          </Pressable> : arrived ? <Pressable onPress={() => void startVisit(selectedVisit)} disabled={visitActionBusy} style={[styles.completeButton, visitActionBusy && styles.dimmed]}>
            {visitActionBusy ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="briefcase" size={20} color="#FFFFFF" />}<Text style={styles.completeButtonText}>Start visit</Text>
          </Pressable> : navigationActive ? <Pressable onPress={() => stopDirections(true)} style={styles.stopDirectionsButton}>
            <Ionicons name="stop-circle" size={20} color="#FFFFFF" /><Text style={styles.completeButtonText}>{rerouting ? 'Rerouting…' : 'Stop directions'}</Text>
          </Pressable> : <Pressable onPress={() => void startDirections()} disabled={routing || !checkedIn || !selectedVisitScheduledToday} style={[styles.directionsButton, (routing || !checkedIn || !selectedVisitScheduledToday) && styles.disabledButton]}>
            {routing ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name={checkedIn && selectedVisitScheduledToday ? 'navigate' : 'lock-closed'} size={20} color="#FFFFFF" />}<Text style={styles.completeButtonText}>{!selectedVisitScheduledToday ? 'Available on visit date' : checkedIn ? 'Start directions' : 'Check in to start directions'}</Text>
          </Pressable>
          }
        </SafeAreaView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable onPress={() => (navigation as any).openDrawer?.()} style={styles.menuButton}>
          <Ionicons name="menu" size={25} color="#152238" />
        </Pressable>
        <Pressable onPress={() => void reload(true)} style={styles.refreshButton}>
          {refreshing ? <ActivityIndicator size="small" color="#1769D2" /> : <Ionicons name="refresh" size={21} color="#1769D2" />}
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{supervisor ? 'Assign field visits' : 'My visit queue'}</Text>
        <Text style={styles.subtitle}>{supervisor ? 'Search an exact place, choose a field employee, and send their next stop.' : 'Your assigned places appear in order. Open a visit for the live road route.'}</Text>

        {supervisor ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>New visit</Text>
            <View style={styles.searchRow}>
              <TextInput value={query} onChangeText={setQuery} placeholder="Search place or address" placeholderTextColor="#7B8798" onSubmitEditing={() => void searchPlaces()} style={styles.input} />
              <Pressable onPress={() => void searchPlaces()} style={styles.searchButton}>
                {searching ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="search" size={20} color="#FFFFFF" />}
              </Pressable>
            </View>
            {results.map((place) => (
              <Pressable key={place.placeId} onPress={() => { setSelectedPlace(place); setResults([]); setQuery(place.name); }} style={styles.placeRow}>
                <Ionicons name="location-outline" size={20} color="#1769D2" />
                <View style={{ flex: 1 }}><Text style={styles.placeName}>{place.name}</Text><Text style={styles.placeAddress}>{place.address}</Text></View>
              </Pressable>
            ))}
            {selectedPlace ? <Text style={styles.selectedText}>Place selected: {selectedPlace.name}</Text> : null}
            <Text style={styles.label}>Assign to</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.employeeRow}>
              {employees.map((employee: any) => {
                const selected = selectedEmployeeId === String(employee.id);
                return <Pressable key={String(employee.id)} onPress={() => setSelectedEmployeeId(String(employee.id))} style={[styles.employeeChip, selected && styles.employeeChipSelected]}><Text style={[styles.employeeChipText, selected && styles.employeeChipTextSelected]}>{employee.name || employee.login || 'Employee'}</Text></Pressable>;
              })}
            </ScrollView>
            {!employees.length && !loading ? <Text style={styles.note}>No field employee is available in this workspace.</Text> : null}
            <Text style={styles.label}>Visit date and time (IST)</Text>
            <View style={styles.schedulePresetRow}>
              {[
                { label: 'Today', value: getMumbaiDateKeyByOffset(0) },
                { label: 'Tomorrow', value: getMumbaiDateKeyByOffset(1) },
              ].map((preset) => (
                <Pressable
                  key={preset.value}
                  onPress={() => setScheduledDate(preset.value)}
                  style={[styles.schedulePreset, scheduledDate === preset.value && styles.schedulePresetSelected]}
                >
                  <Text style={[styles.schedulePresetText, scheduledDate === preset.value && styles.schedulePresetTextSelected]}>{preset.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.scheduleInputRow}>
              <View style={styles.scheduleInputBlock}>
                <Text style={styles.scheduleInputLabel}>Date</Text>
                <TextInput
                  value={scheduledDate}
                  onChangeText={setScheduledDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor="#7B8798"
                  maxLength={10}
                  autoCapitalize="none"
                  style={styles.scheduleInput}
                />
              </View>
              <View style={styles.scheduleTimeBlock}>
                <Text style={styles.scheduleInputLabel}>Time</Text>
                <TextInput
                  value={scheduledTime}
                  onChangeText={setScheduledTime}
                  placeholder="HH:MM"
                  placeholderTextColor="#7B8798"
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  style={styles.scheduleInput}
                />
              </View>
            </View>
            <Text style={styles.scheduleHelp}>Same-date assigned visits keep attendance active after the employee leaves the office geofence.</Text>
            <TextInput value={notes} onChangeText={setNotes} placeholder="Optional visit note" placeholderTextColor="#7B8798" multiline style={[styles.input, styles.notesInput]} />
            <Pressable onPress={() => void assignVisit()} disabled={saving} style={[styles.assignButton, saving && styles.dimmed]}>
              {saving ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name="send" size={18} color="#FFFFFF" />}
              <Text style={styles.assignButtonText}>Send to visit queue</Text>
            </Pressable>
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>{supervisor ? 'Assigned visits' : `Active queue · ${pending.length}`}</Text>
        {loading ? <ActivityIndicator color="#1769D2" style={{ marginTop: 30 }} /> : null}
        {!loading && !pending.length ? <View style={styles.empty}><Ionicons name="navigate-outline" size={30} color="#64748B" /><Text style={styles.emptyTitle}>No pending visits</Text><Text style={styles.emptyBody}>{supervisor ? 'Assign the first place above.' : 'Your admin will send places here when they are ready.'}</Text></View> : null}
        {pending.map((visit) => (
          <Pressable key={visit.assignmentId} onPress={() => supervisor ? undefined : void openVisit(visit)} style={[styles.visitCard, visit.status === 'in_progress' && styles.visitCardActive]}>
            <View style={styles.orderBubble}><Text style={styles.orderText}>{visit.queueOrder}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.visitTitle}>{visit.placeName}</Text>
              <Text style={styles.visitAddress}>{visit.placeAddress}</Text>
              <Text style={styles.visitSchedule}>{formatVisitSchedule(visit.scheduledDate, visit.scheduledTime)}</Text>
              {visit.status === 'in_progress' ? <Text style={styles.visitInProgress}>Visit in progress</Text> : null}
              {supervisor ? <Text style={styles.visitMeta}>For: {employeeById.get(visit.employeeId)?.name || visit.employeeId}</Text> : null}
              {visit.notes ? <Text style={styles.visitMeta}>Note: {visit.notes}</Text> : null}
            </View>
            {!supervisor ? <Ionicons name="navigate" size={21} color="#1769D2" /> : null}
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function humanize(error: unknown) {
  const message = error instanceof Error ? error.message : 'Please try again.';
  return message.replace(/_/g, ' ');
}

function defaultVisitDate(): string {
  return toMumbaiDateKey(new Date(Date.now() + 60 * 60_000));
}

function defaultVisitTime(): string {
  const shifted = new Date(Date.now() + (5 * 60 + 30) * 60_000 + 60 * 60_000);
  const roundedMinutes = Math.ceil(shifted.getUTCMinutes() / 15) * 15;
  shifted.setUTCMinutes(roundedMinutes, 0, 0);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

function isValidVisitDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00+05:30`);
  return Number.isFinite(parsed.getTime()) && toMumbaiDateKey(parsed) === value;
}

function formatVisitSchedule(date: string, time: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(time);
  if (!match) return formatMumbaiDateKey(date);
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${formatMumbaiDateKey(date)} · ${hour % 12 || 12}:${minute} ${suffix} IST`;
}

type RouteMetrics = { cumulativeMeters: number[]; totalMeters: number };
type RouteProjection = {
  coordinate: { latitude: number; longitude: number };
  distanceFromRouteMeters: number;
  distanceAlongRouteMeters: number;
  shapePosition: number;
};

function buildRouteMetrics(route: Array<{ latitude: number; longitude: number }>): RouteMetrics {
  const cumulativeMeters = [0];
  let totalMeters = 0;
  for (let index = 1; index < route.length; index += 1) {
    totalMeters += haversineMetres(route[index - 1]!, route[index]!);
    cumulativeMeters.push(totalMeters);
  }
  return { cumulativeMeters, totalMeters };
}

function projectOnRoute(
  location: { latitude: number; longitude: number },
  route: Array<{ latitude: number; longitude: number }>,
  metrics: RouteMetrics,
): RouteProjection | null {
  if (route.length < 2) return null;
  let best: RouteProjection | null = null;
  const latitudeScale = 111_320;
  const longitudeScale = Math.max(1, Math.cos((location.latitude * Math.PI) / 180) * 111_320);
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    const ax = (start.longitude - location.longitude) * longitudeScale;
    const ay = (start.latitude - location.latitude) * latitudeScale;
    const bx = (end.longitude - location.longitude) * longitudeScale;
    const by = (end.latitude - location.latitude) * latitudeScale;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
    const coordinate = {
      latitude: start.latitude + (end.latitude - start.latitude) * fraction,
      longitude: start.longitude + (end.longitude - start.longitude) * fraction,
    };
    const distanceFromRouteMeters = haversineMetres(location, coordinate);
    if (!best || distanceFromRouteMeters < best.distanceFromRouteMeters) {
      const segmentLength = (metrics.cumulativeMeters[index + 1] ?? 0) - (metrics.cumulativeMeters[index] ?? 0);
      best = {
        coordinate,
        distanceFromRouteMeters,
        distanceAlongRouteMeters: (metrics.cumulativeMeters[index] ?? 0) + segmentLength * fraction,
        shapePosition: index + fraction,
      };
    }
  }
  return best;
}

function distanceToShapeIndex(projection: RouteProjection | null, metrics: RouteMetrics, shapeIndex: number): number {
  if (!projection) return 0;
  const target = metrics.cumulativeMeters[Math.max(0, Math.min(metrics.cumulativeMeters.length - 1, shapeIndex))] ?? metrics.totalMeters;
  return Math.max(0, target - projection.distanceAlongRouteMeters);
}

function turnIcon(instruction: string): keyof typeof Ionicons.glyphMap {
  const text = instruction.toLowerCase();
  if (text.includes('u-turn') || text.includes('uturn')) return 'return-down-back';
  if (text.includes('left')) return 'return-down-back';
  if (text.includes('right')) return 'return-down-forward';
  if (text.includes('roundabout')) return 'sync';
  return 'arrow-up';
}

function formatArrival(value: Date): string {
  return value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function speak(text: string) {
  void Speech.speak(text, { language: 'en-IN', rate: 0.95, pitch: 1 });
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F8FC' }, mapScreen: { flex: 1, backgroundColor: '#E9EEF5' },
  header: { height: 72, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'space-between', flexDirection: 'row' },
  menuButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', elevation: 3 },
  refreshButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF1FF' },
  content: { paddingHorizontal: 18, paddingBottom: 36 }, title: { color: '#10233F', fontSize: 27, fontWeight: '900' }, subtitle: { color: '#64748B', fontSize: 13, lineHeight: 20, marginTop: 7, marginBottom: 18 },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', borderRadius: 20, padding: 15, marginBottom: 22 }, cardTitle: { color: '#10233F', fontSize: 15, fontWeight: '900', marginBottom: 12 },
  searchRow: { flexDirection: 'row', gap: 8 }, input: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 13, color: '#111827', backgroundColor: '#FBFCFE', fontSize: 13 }, searchButton: { width: 48, height: 48, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1769D2' },
  placeRow: { flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E6ECF4' }, placeName: { color: '#152238', fontSize: 13, fontWeight: '800' }, placeAddress: { color: '#64748B', fontSize: 11, lineHeight: 16, marginTop: 2 }, selectedText: { color: '#1769D2', fontSize: 12, fontWeight: '700', marginTop: 12 },
  label: { color: '#475569', fontSize: 11, fontWeight: '800', marginTop: 15, marginBottom: 8, textTransform: 'uppercase', letterSpacing: .5 }, employeeRow: { gap: 8, paddingRight: 8 }, employeeChip: { borderRadius: 16, borderWidth: 1, borderColor: '#D6E0ED', paddingHorizontal: 11, paddingVertical: 9, backgroundColor: '#F7F9FC' }, employeeChipSelected: { backgroundColor: '#1769D2', borderColor: '#1769D2' }, employeeChipText: { color: '#475569', fontSize: 12, fontWeight: '700' }, employeeChipTextSelected: { color: '#FFFFFF' },
  schedulePresetRow: { flexDirection: 'row', gap: 8, marginBottom: 10 }, schedulePreset: { minHeight: 34, borderRadius: 13, borderWidth: 1, borderColor: '#D6E0ED', paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F9FC' }, schedulePresetSelected: { borderColor: '#1769D2', backgroundColor: '#EAF1FF' }, schedulePresetText: { color: '#64748B', fontSize: 11, fontWeight: '800' }, schedulePresetTextSelected: { color: '#1769D2' },
  scheduleInputRow: { flexDirection: 'row', gap: 9 }, scheduleInputBlock: { flex: 1.45 }, scheduleTimeBlock: { flex: 1 }, scheduleInputLabel: { color: '#64748B', fontSize: 10, fontWeight: '800', marginBottom: 5 }, scheduleInput: { minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 12, color: '#111827', backgroundColor: '#FBFCFE', fontSize: 13, fontWeight: '700' }, scheduleHelp: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 7 },
  notesInput: { marginTop: 14, minHeight: 60, paddingTop: 12, textAlignVertical: 'top' }, assignButton: { height: 48, borderRadius: 15, marginTop: 12, backgroundColor: '#1769D2', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, assignButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' }, dimmed: { opacity: .6 }, disabledButton: { opacity: .72, backgroundColor: '#7B8798' }, note: { color: '#9A6200', fontSize: 11, marginTop: 10 },
  sectionTitle: { color: '#10233F', fontSize: 16, fontWeight: '900', marginBottom: 10 }, empty: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#D6E0ED', borderRadius: 18, alignItems: 'center', padding: 28, backgroundColor: '#FAFBFD' }, emptyTitle: { color: '#334155', fontSize: 14, fontWeight: '800', marginTop: 8 }, emptyBody: { color: '#64748B', fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 4 },
  visitCard: { minHeight: 82, borderRadius: 18, padding: 13, marginBottom: 9, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', flexDirection: 'row', alignItems: 'center', gap: 11 }, visitCardActive: { borderColor: '#73C8A5', backgroundColor: '#F2FCF7' }, orderBubble: { width: 29, height: 29, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF1FF' }, orderText: { color: '#1769D2', fontSize: 12, fontWeight: '900' }, visitTitle: { color: '#152238', fontSize: 13, fontWeight: '900' }, visitAddress: { color: '#64748B', fontSize: 11, lineHeight: 16, marginTop: 3 }, visitSchedule: { color: '#1769D2', fontSize: 10, lineHeight: 15, fontWeight: '800', marginTop: 5 }, visitMeta: { color: '#475569', fontSize: 10, lineHeight: 15, marginTop: 4 }, visitInProgress: { color: '#16835B', fontSize: 10, fontWeight: '900', marginTop: 5, textTransform: 'uppercase', letterSpacing: .45 },
  mapTop: { position: 'absolute', top: 0, left: 0, right: 0, gap: 9, paddingHorizontal: 14, paddingTop: 8 }, destinationHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10 }, destinationCopy: { flex: 1, minHeight: 52, borderRadius: 18, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 14, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.97)' }, destinationTitle: { color: '#152238', fontSize: 15, fontWeight: '900' }, destinationAddress: { color: '#64748B', fontSize: 11, marginTop: 3 }, routeCard: { width: '100%', minHeight: 74, borderRadius: 18, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 15, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.97)' }, routeCardNavigating: { backgroundColor: '#1769D2', borderColor: '#1769D2', alignItems: 'stretch' }, maneuverRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 13 }, turnArrowShell: { width: 58, height: 58, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.14)' }, maneuverCopy: { flex: 1, minWidth: 0 }, routeMetric: { color: '#0B8C66', fontSize: 13, fontWeight: '900', marginTop: 5 }, routeMetricNavigating: { color: '#DCEBFF' }, directionInstruction: { color: '#FFFFFF', fontSize: 16, lineHeight: 21, fontWeight: '900' }, previewRouteRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 11 }, previewIconShell: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF1FF' }, arrivedIcon: { backgroundColor: '#E7F8EF' }, visitStartedIcon: { backgroundColor: '#E7F8EF' }, lockedIcon: { backgroundColor: '#FFF5D9' }, previewRouteTitle: { color: '#152238', fontSize: 14, fontWeight: '900' }, previewRouteMeta: { color: '#64748B', fontSize: 11, marginTop: 3, lineHeight: 16 }, mapBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 14 }, completeButton: { height: 52, borderRadius: 18, backgroundColor: '#16835B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, directionsButton: { height: 52, borderRadius: 18, backgroundColor: '#1769D2', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, stopDirectionsButton: { height: 52, borderRadius: 18, backgroundColor: '#BE3F3A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, completeButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
