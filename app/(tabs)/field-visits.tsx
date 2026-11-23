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
  deleteFieldVisitAssignment,
  getFieldVisitAssignments,
  planFieldRoute,
  searchFieldPlaces,
  startFieldVisitAssignment,
  type FieldVisitAssignment,
} from '@/lib/field-tracking/api';
import { captureFreshVisitEvidence } from '@/lib/field-tracking/visit-evidence';
import { evaluateVisitSchedulePolicy } from '@/lib/field-tracking/visit-policy';
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
  const companyId = company?.id;
  const userRole = user?.role;
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const visitNavigation = useVisitNavigation();
  const setVisitNavigationExpanded = visitNavigation.setScreenExpanded;
  const supervisor = isSupervisor(userRole);
  const [assignments, setAssignments] = useState<FieldVisitAssignment[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceSearchResult | null>(null);
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [mapSearchQuery, setMapSearchQuery] = useState('');
  const [mapSearchResults, setMapSearchResults] = useState<PlaceSearchResult[]>([]);
  const [mapSearching, setMapSearching] = useState(false);
  const [mapCandidate, setMapCandidate] = useState<PlaceSearchResult | null>(null);
  const [mapInitialCenter, setMapInitialCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedEmployeeCompanyId, setSelectedEmployeeCompanyId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [scheduledDate, setScheduledDate] = useState(() => defaultVisitDate());
  const [scheduledTime, setScheduledTime] = useState(() => defaultVisitTime());
  const [saving, setSaving] = useState(false);
  const [deletingVisitId, setDeletingVisitId] = useState<string | null>(null);
  const [selectedVisit, setSelectedVisit] = useState<FieldVisitAssignment | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [route, setRoute] = useState<RoutePlan>(EMPTY_ROUTE);
  const [routing, setRouting] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [checkedIn, setCheckedIn] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [visitActionBusy, setVisitActionBusy] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const offRouteSamplesRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const spokenRef = useRef(new Set<string>());

  // The provider survives drawer/tab navigation. This screen simply mirrors
  // it when the full map is opened again from the compact navigator.
  useEffect(() => {
    const saved = visitNavigation.session;
    if (!saved) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedVisit(saved.visit);
      setRoute(saved.route);
      setCurrentPosition(saved.position);
      setHeading(saved.heading);
      setNavigationActive(saved.status === 'active');
      setArrived(saved.status === 'arrived');
    });
    return () => { cancelled = true; };
  }, [visitNavigation.session]);

  useEffect(() => subscribeToVisitNavigationCheckout(() => {
    setCheckedIn(false);
    setNavigationActive(false);
    setArrived(false);
  }), []);

  useEffect(() => {
    if (!visitNavigation.expandNonce || !visitNavigation.session) return;
    const timer = setTimeout(() => setMapOpen(true), 0);
    return () => clearTimeout(timer);
  }, [visitNavigation.expandNonce, visitNavigation.session]);

  useEffect(() => {
    setVisitNavigationExpanded(mapOpen);
    return () => setVisitNavigationExpanded(false);
  }, [mapOpen, setVisitNavigationExpanded]);

  const reload = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const [nextAssignments, nextEmployees, attendance] = await Promise.all([
        getFieldVisitAssignments(userRole === 'admin' ? { allCompanies: true } : { companyId }),
        supervisor
          ? getUsersRemote(userRole === 'admin' ? { allCompanies: true } : { companyId })
          : Promise.resolve([]),
        supervisor ? Promise.resolve({ active: null }) : getAttendanceStatus().catch(() => ({ records: [], active: null })),
      ]);
      setAssignments(nextAssignments);
      // Any active non-admin workspace user can receive field work. Managers
      // and HR may also need an assigned visit; supervisor status controls the
      // screen permissions, not visit eligibility.
      setEmployees(nextEmployees.filter((item: any) => item.id && item.role !== 'admin'));
      if (!supervisor) setCheckedIn(Boolean(attendance.active));
    } catch (error) {
      if (!quiet) Alert.alert('Visit queue unavailable', humanize(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [companyId, supervisor, userRole]);

  useEffect(() => {
    if (!isFocused) return;
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [isFocused, reload]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const pending = useMemo(() => assignments.filter((item) => item.status === 'pending' || item.status === 'in_progress'), [assignments]);
  const employeeById = useMemo(() => new Map(employees.map((item: any) => [`${String(item.companyId || '')}:${String(item.id)}`, item])), [employees]);

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

  const openPlacePicker = async () => {
    setMapCandidate(selectedPlace);
    setMapSearchQuery(selectedPlace?.name || query);
    setMapSearchResults([]);
    setMapInitialCenter(selectedPlace ? { latitude: selectedPlace.latitude, longitude: selectedPlace.longitude } : null);
    setPlacePickerOpen(true);
    if (selectedPlace) return;
    const lastKnown = await getLastKnownLocationSafe({ requiredAccuracy: 500, maxAgeMs: 30 * 60_000 });
    if (lastKnown) {
      setMapInitialCenter({ latitude: lastKnown.coords.latitude, longitude: lastKnown.coords.longitude });
    }
  };

  const searchPlacesOnMap = async () => {
    const value = mapSearchQuery.trim();
    if (value.length < 3) {
      Alert.alert('Search a place', 'Enter at least 3 characters to search on the map.');
      return;
    }
    setMapSearching(true);
    try {
      const bias = mapCandidate ?? mapInitialCenter ?? undefined;
      setMapSearchResults(await searchFieldPlaces(value, bias));
    } catch (error) {
      Alert.alert('Place search unavailable', humanize(error));
    } finally {
      setMapSearching(false);
    }
  };

  const selectMapCoordinate = useCallback((coordinate: { latitude: number; longitude: number }) => {
    const latitude = Number(coordinate.latitude.toFixed(7));
    const longitude = Number(coordinate.longitude.toFixed(7));
    setMapCandidate({
      placeId: `manual:${latitude},${longitude}`,
      name: 'Custom map location',
      address: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      latitude,
      longitude,
      primaryType: 'manual_pin',
    });
    setMapSearchResults([]);
  }, []);

  const confirmMapPlace = () => {
    if (!mapCandidate) {
      Alert.alert('Select a location', 'Choose a search result or tap an exact point on the map first.');
      return;
    }
    setSelectedPlace(mapCandidate);
    setQuery(mapCandidate.name);
    setResults([]);
    setPlacePickerOpen(false);
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
        companyId: selectedEmployeeCompanyId || companyId,
        place: selectedPlace,
        scheduledDate,
        scheduledTime,
        notes,
      });
      setSelectedPlace(null);
      setSelectedEmployeeId(null);
      setSelectedEmployeeCompanyId(null);
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

  const deleteVisit = (visit: FieldVisitAssignment) => {
    Alert.alert(
      'Delete assigned visit?',
      `${visit.placeName} will be removed from the employee's active queue. This action remains recorded as cancelled for audit history.`,
      [
        { text: 'Keep visit', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setDeletingVisitId(visit.assignmentId);
            void deleteFieldVisitAssignment(visit.assignmentId).then(() => {
              setAssignments((current) => current.filter((item) => item.assignmentId !== visit.assignmentId));
              if (selectedVisit?.assignmentId === visit.assignmentId) setSelectedVisit(null);
            }).catch((error) => {
              Alert.alert('Could not delete visit', humanize(error));
            }).finally(() => setDeletingVisitId(null));
          },
        },
      ],
    );
  };

  const stopDirections = useCallback((announce = false) => {
    // Cancel native TTS before changing any navigation state. Async reroute or
    // screen lifecycle work must never leave an old instruction speaking.
    void Speech.stop();
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
    setNavigationActive(false);
    if (visitNavigation.session?.status === 'active') visitNavigation.stop(announce);
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
    setHeading(null);
    setArrived(Boolean(visit.arrivedAt));
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
      setHeading(nextHeading);
      setRoute(planned);
      await visitNavigation.start({
        visit: selectedVisit,
        route: planned,
        position,
        heading: nextHeading,
        speed: Number.isFinite(location.coords.speed) ? location.coords.speed : null,
        accuracy,
      });
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
    setVisitActionBusy(true);
    try {
      const samples = await captureFreshVisitEvidence();
      const result = await startFieldVisitAssignment(visit.assignmentId, { samples });
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
      const samples = await captureFreshVisitEvidence();
      const result = await completeFieldVisitAssignment(visit.assignmentId, { samples });
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
  const previewArrival = route.durationSeconds ? new Date(clockNow + route.durationSeconds * 1_000) : null;
  const mapPoints = useMemo(() => currentPosition ? [{
    pointId: 'visit-navigation-position', sessionId: 'visit-navigation', sequence: 1,
    latitude: currentPosition.latitude, longitude: currentPosition.longitude,
    accuracy: 12, speed: null, heading, battery: null, mocked: false,
    capturedAt: new Date().toISOString(), syncedAt: null, routeEligible: true, rejectionReason: null,
  }] : [], [currentPosition, heading]);

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
  const selectedVisitSchedulePolicy = selectedVisit
    ? evaluateVisitSchedulePolicy(user?.role, selectedVisit.scheduledDate, selectedVisit.scheduledTime, clockNow)
    : null;
  const selectedVisitDirectionsAllowed = Boolean(selectedVisitSchedulePolicy?.directionsAllowed);
  const directionsOpenLabel = selectedVisitSchedulePolicy?.directionsAvailableAt
    ? formatArrival(new Date(selectedVisitSchedulePolicy.directionsAvailableAt))
    : null;

  if (placePickerOpen && supervisor) {
    return (
      <View style={styles.mapScreen}>
        <RouteMap
          points={[]}
          follow={false}
          destination={mapCandidate}
          selectionEnabled
          initialCenter={mapInitialCenter}
          onMapPress={selectMapCoordinate}
        />
        <SafeAreaView style={styles.placePickerTop} edges={['top', 'left', 'right']}>
          <View style={styles.placePickerHeader}>
            <Pressable accessibilityLabel="Close map search" onPress={() => setPlacePickerOpen(false)} style={styles.menuButton}>
              <Ionicons name="arrow-back" size={22} color="#152238" />
            </Pressable>
            <View style={styles.placePickerSearchShell}>
              <Ionicons name="search" size={19} color="#64748B" />
              <TextInput
                value={mapSearchQuery}
                onChangeText={setMapSearchQuery}
                placeholder="Search area, place or address"
                placeholderTextColor="#7B8798"
                returnKeyType="search"
                onSubmitEditing={() => void searchPlacesOnMap()}
                style={styles.placePickerInput}
              />
              <Pressable accessibilityLabel="Search map" onPress={() => void searchPlacesOnMap()} disabled={mapSearching} style={styles.placePickerSearchButton}>
                {mapSearching ? <ActivityIndicator size="small" color="#FFFFFF" /> : <Ionicons name="arrow-forward" size={19} color="#FFFFFF" />}
              </Pressable>
            </View>
          </View>
          {mapSearchResults.length ? (
            <View style={styles.mapResultPanel}>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {mapSearchResults.map((place) => (
                  <Pressable
                    key={place.placeId}
                    onPress={() => {
                      setMapCandidate(place);
                      setMapInitialCenter({ latitude: place.latitude, longitude: place.longitude });
                      setMapSearchQuery(place.name);
                      setMapSearchResults([]);
                    }}
                    style={styles.mapResultRow}
                  >
                    <Ionicons name="location-outline" size={20} color="#1769D2" />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.placeName}>{place.name}</Text>
                      <Text style={styles.placeAddress} numberOfLines={2}>{place.address}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          <View pointerEvents="none" style={styles.mapTapHint}>
            <Ionicons name="hand-left-outline" size={16} color="#254D82" />
            <Text style={styles.mapTapHintText}>Search above or tap anywhere on the map to drop the pin.</Text>
          </View>
        </SafeAreaView>
        <SafeAreaView style={styles.placePickerBottom} edges={['bottom', 'left', 'right']}>
          <View style={styles.placePickerSelection}>
            <View style={[styles.placePickerPin, !mapCandidate && styles.placePickerPinEmpty]}>
              <Ionicons name={mapCandidate ? 'location' : 'map-outline'} size={21} color={mapCandidate ? '#FFFFFF' : '#64748B'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.placePickerSelectionTitle}>{mapCandidate?.name || 'No location selected'}</Text>
              <Text style={styles.placePickerSelectionAddress} numberOfLines={2}>{mapCandidate?.address || 'Tap the map or choose a search result.'}</Text>
            </View>
          </View>
          <Pressable onPress={confirmMapPlace} disabled={!mapCandidate} style={[styles.mapDoneButton, !mapCandidate && styles.disabledButton]}>
            <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
            <Text style={styles.completeButtonText}>Done</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  if (selectedVisit && mapOpen && !supervisor) {
    return (
      <View style={styles.mapScreen}>
        <RouteMap
          points={mapPoints}
          plannedRoute={navigationActive ? (visitNavigation.progress?.remainingRoute ?? route.coordinates) : route.coordinates}
          destination={selectedVisit}
          previewRoute={!navigationActive}
          navigationActive={navigationActive}
          progressPercent={navigationActive ? 0 : progressPercent}
          snappedPosition={navigationActive ? visitNavigation.progress?.snappedPosition : null}
          heading={navigationActive ? (visitNavigation.progress?.routeHeading ?? heading) : heading}
        />
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
            ) : !selectedVisitDirectionsAllowed ? (
              <View style={styles.previewRouteRow}><View style={[styles.previewIconShell, styles.lockedIcon]}><Ionicons name="time" size={22} color="#9A6200" /></View><View style={styles.maneuverCopy}><Text style={styles.previewRouteTitle}>Directions open at {directionsOpenLabel || selectedVisit.scheduledTime}</Text><Text style={styles.previewRouteMeta}>Fixed-location employees receive a two-hour travel window before the scheduled visit.</Text></View></View>
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
          </Pressable> : <Pressable onPress={() => void startDirections()} disabled={routing || !checkedIn || !selectedVisitDirectionsAllowed} style={[styles.directionsButton, (routing || !checkedIn || !selectedVisitDirectionsAllowed) && styles.disabledButton]}>
            {routing ? <ActivityIndicator color="#FFFFFF" /> : <Ionicons name={checkedIn && selectedVisitDirectionsAllowed ? 'navigate' : 'lock-closed'} size={20} color="#FFFFFF" />}<Text style={styles.completeButtonText}>{!selectedVisitScheduledToday ? 'Available on visit date' : !selectedVisitDirectionsAllowed ? `Opens ${directionsOpenLabel || selectedVisit.scheduledTime}` : checkedIn ? 'Start directions' : 'Check in to start directions'}</Text>
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
            <Pressable onPress={() => void openPlacePicker()} style={styles.searchByMapButton}>
              <View style={styles.searchByMapIcon}><Ionicons name="map" size={19} color="#1769D2" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.searchByMapTitle}>Search by map</Text>
                <Text style={styles.searchByMapDetail}>Search visually or tap an exact point to place the visit pin.</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color="#1769D2" />
            </Pressable>
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
                const employeeId = String(employee.id);
                const employeeCompanyId = String(employee.companyId || companyId || '');
                const selected = selectedEmployeeId === employeeId && selectedEmployeeCompanyId === employeeCompanyId;
                return <Pressable key={`${employeeCompanyId}:${employeeId}`} onPress={() => { setSelectedEmployeeId(employeeId); setSelectedEmployeeCompanyId(employeeCompanyId); }} style={[styles.employeeChip, selected && styles.employeeChipSelected]}><Text style={[styles.employeeChipText, selected && styles.employeeChipTextSelected]}>{employee.name || employee.login || 'Employee'}{userRole === 'admin' && employee.companyName ? ` · ${employee.companyName}` : ''}</Text></Pressable>;
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
              {supervisor ? <Text style={styles.visitMeta}>For: {employeeById.get(`${visit.companyId}:${visit.employeeId}`)?.name || visit.employeeId}</Text> : null}
              {visit.notes ? <Text style={styles.visitMeta}>Note: {visit.notes}</Text> : null}
            </View>
            {!supervisor ? <Ionicons name="navigate" size={21} color="#1769D2" /> : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete visit to ${visit.placeName}`}
                onPress={() => deleteVisit(visit)}
                disabled={deletingVisitId === visit.assignmentId}
                style={({ pressed }) => [styles.deleteVisitButton, pressed && styles.deleteVisitButtonPressed, deletingVisitId === visit.assignmentId && styles.dimmed]}
              >
                {deletingVisitId === visit.assignmentId
                  ? <ActivityIndicator size="small" color="#B42318" />
                  : <Ionicons name="trash-outline" size={19} color="#B42318" />}
              </Pressable>
            )}
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

function buildRouteMetrics(route: { latitude: number; longitude: number }[]): RouteMetrics {
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
  route: { latitude: number; longitude: number }[],
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
  searchByMapButton: { minHeight: 62, borderRadius: 15, borderWidth: 1, borderColor: '#CFE0FA', backgroundColor: '#F3F7FE', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 9, marginTop: 9 },
  searchByMapIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E3EDFF' },
  searchByMapTitle: { color: '#173A70', fontSize: 12, fontWeight: '900' },
  searchByMapDetail: { color: '#64748B', fontSize: 10, lineHeight: 14, marginTop: 2 },
  placeRow: { flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E6ECF4' }, placeName: { color: '#152238', fontSize: 13, fontWeight: '800' }, placeAddress: { color: '#64748B', fontSize: 11, lineHeight: 16, marginTop: 2 }, selectedText: { color: '#1769D2', fontSize: 12, fontWeight: '700', marginTop: 12 },
  label: { color: '#475569', fontSize: 11, fontWeight: '800', marginTop: 15, marginBottom: 8, textTransform: 'uppercase', letterSpacing: .5 }, employeeRow: { gap: 8, paddingRight: 8 }, employeeChip: { borderRadius: 16, borderWidth: 1, borderColor: '#D6E0ED', paddingHorizontal: 11, paddingVertical: 9, backgroundColor: '#F7F9FC' }, employeeChipSelected: { backgroundColor: '#1769D2', borderColor: '#1769D2' }, employeeChipText: { color: '#475569', fontSize: 12, fontWeight: '700' }, employeeChipTextSelected: { color: '#FFFFFF' },
  schedulePresetRow: { flexDirection: 'row', gap: 8, marginBottom: 10 }, schedulePreset: { minHeight: 34, borderRadius: 13, borderWidth: 1, borderColor: '#D6E0ED', paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7F9FC' }, schedulePresetSelected: { borderColor: '#1769D2', backgroundColor: '#EAF1FF' }, schedulePresetText: { color: '#64748B', fontSize: 11, fontWeight: '800' }, schedulePresetTextSelected: { color: '#1769D2' },
  scheduleInputRow: { flexDirection: 'row', gap: 9 }, scheduleInputBlock: { flex: 1.45 }, scheduleTimeBlock: { flex: 1 }, scheduleInputLabel: { color: '#64748B', fontSize: 10, fontWeight: '800', marginBottom: 5 }, scheduleInput: { minHeight: 46, borderRadius: 13, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 12, color: '#111827', backgroundColor: '#FBFCFE', fontSize: 13, fontWeight: '700' }, scheduleHelp: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 7 },
  notesInput: { marginTop: 14, minHeight: 60, paddingTop: 12, textAlignVertical: 'top' }, assignButton: { height: 48, borderRadius: 15, marginTop: 12, backgroundColor: '#1769D2', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, assignButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' }, dimmed: { opacity: .6 }, disabledButton: { opacity: .72, backgroundColor: '#7B8798' }, note: { color: '#9A6200', fontSize: 11, marginTop: 10 },
  sectionTitle: { color: '#10233F', fontSize: 16, fontWeight: '900', marginBottom: 10 }, empty: { borderWidth: 1, borderStyle: 'dashed', borderColor: '#D6E0ED', borderRadius: 18, alignItems: 'center', padding: 28, backgroundColor: '#FAFBFD' }, emptyTitle: { color: '#334155', fontSize: 14, fontWeight: '800', marginTop: 8 }, emptyBody: { color: '#64748B', fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 4 },
  visitCard: { minHeight: 82, borderRadius: 18, padding: 13, marginBottom: 9, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', flexDirection: 'row', alignItems: 'center', gap: 11 }, visitCardActive: { borderColor: '#73C8A5', backgroundColor: '#F2FCF7' }, orderBubble: { width: 29, height: 29, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF1FF' }, orderText: { color: '#1769D2', fontSize: 12, fontWeight: '900' }, visitTitle: { color: '#152238', fontSize: 13, fontWeight: '900' }, visitAddress: { color: '#64748B', fontSize: 11, lineHeight: 16, marginTop: 3 }, visitSchedule: { color: '#1769D2', fontSize: 10, lineHeight: 15, fontWeight: '800', marginTop: 5 }, visitMeta: { color: '#475569', fontSize: 10, lineHeight: 15, marginTop: 4 }, visitInProgress: { color: '#16835B', fontSize: 10, fontWeight: '900', marginTop: 5, textTransform: 'uppercase', letterSpacing: .45 },
  deleteVisitButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF1F0', borderWidth: 1, borderColor: '#F3C6C3' },
  deleteVisitButtonPressed: { backgroundColor: '#FFE3E0', transform: [{ scale: .96 }] },
  placePickerTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 13, paddingTop: 8 },
  placePickerHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  placePickerSearchShell: { flex: 1, height: 52, borderRadius: 18, borderWidth: 1, borderColor: '#D4DDE9', backgroundColor: 'rgba(255,255,255,.98)', flexDirection: 'row', alignItems: 'center', paddingLeft: 13, paddingRight: 5, elevation: 6, shadowColor: '#10233F', shadowOpacity: .13, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  placePickerInput: { flex: 1, height: 50, color: '#111827', fontSize: 13, paddingHorizontal: 9 },
  placePickerSearchButton: { width: 41, height: 41, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769D2' },
  mapResultPanel: { maxHeight: 260, marginLeft: 57, marginTop: 7, borderRadius: 16, borderWidth: 1, borderColor: '#DCE3EC', backgroundColor: 'rgba(255,255,255,.99)', paddingHorizontal: 12, elevation: 8, shadowColor: '#10233F', shadowOpacity: .15, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
  mapResultRow: { minHeight: 62, flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#E6ECF4' },
  mapTapHint: { alignSelf: 'center', maxWidth: 310, minHeight: 38, borderRadius: 14, backgroundColor: 'rgba(242,247,255,.96)', borderWidth: 1, borderColor: '#CFE0FA', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, marginTop: 9, elevation: 3 },
  mapTapHintText: { flex: 1, color: '#254D82', fontSize: 10, lineHeight: 14, fontWeight: '700' },
  placePickerBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 13, backgroundColor: 'rgba(245,248,252,.97)', borderTopWidth: 1, borderTopColor: '#DCE3EC' },
  placePickerSelection: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 10 },
  placePickerPin: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1769D2' },
  placePickerPinEmpty: { backgroundColor: '#E8EDF4' },
  placePickerSelectionTitle: { color: '#152238', fontSize: 13, fontWeight: '900' },
  placePickerSelectionAddress: { color: '#64748B', fontSize: 10, lineHeight: 14, marginTop: 2 },
  mapDoneButton: { height: 50, borderRadius: 16, backgroundColor: '#1769D2', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  mapTop: { position: 'absolute', top: 0, left: 0, right: 0, gap: 9, paddingHorizontal: 14, paddingTop: 8 }, destinationHeader: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10 }, destinationCopy: { flex: 1, minHeight: 52, borderRadius: 18, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 14, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.97)' }, destinationTitle: { color: '#152238', fontSize: 15, fontWeight: '900' }, destinationAddress: { color: '#64748B', fontSize: 11, marginTop: 3 }, routeCard: { width: '100%', minHeight: 74, borderRadius: 18, borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 15, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.97)' }, routeCardNavigating: { backgroundColor: '#1769D2', borderColor: '#1769D2', alignItems: 'stretch' }, maneuverRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 13 }, turnArrowShell: { width: 58, height: 58, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.14)' }, maneuverCopy: { flex: 1, minWidth: 0 }, routeMetric: { color: '#0B8C66', fontSize: 13, fontWeight: '900', marginTop: 5 }, routeMetricNavigating: { color: '#DCEBFF' }, directionInstruction: { color: '#FFFFFF', fontSize: 16, lineHeight: 21, fontWeight: '900' }, previewRouteRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 11 }, previewIconShell: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EAF1FF' }, arrivedIcon: { backgroundColor: '#E7F8EF' }, visitStartedIcon: { backgroundColor: '#E7F8EF' }, lockedIcon: { backgroundColor: '#FFF5D9' }, previewRouteTitle: { color: '#152238', fontSize: 14, fontWeight: '900' }, previewRouteMeta: { color: '#64748B', fontSize: 11, marginTop: 3, lineHeight: 16 }, mapBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 14 }, completeButton: { height: 52, borderRadius: 18, backgroundColor: '#16835B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, directionsButton: { height: 52, borderRadius: 18, backgroundColor: '#1769D2', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, stopDirectionsButton: { height: 52, borderRadius: 18, backgroundColor: '#BE3F3A', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, completeButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});
