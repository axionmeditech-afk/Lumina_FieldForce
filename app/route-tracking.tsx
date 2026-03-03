import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import * as Location from "expo-location";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeInDown } from "react-native-reanimated";
import { AppCanvas } from "@/components/AppCanvas";
import { RouteMapNative } from "@/components/RouteMapNative";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import {
  getAdminDemoRouteTimeline,
  getAdminRouteTimeline,
  postLocationLog,
  type AdminRouteTimelineResponse,
} from "@/lib/attendance-api";
import { getBatteryLevelPercent } from "@/lib/battery";
import { buildDemoRoutePoints } from "@/lib/demo-route";
import { haversineDistanceMeters } from "@/lib/geofence";
import {
  ensureLocationServicesEnabled,
  getLocationPermissionSnapshot,
  getVerifiedLocationEvidence,
} from "@/lib/location-service";
import { buildRouteTimeline } from "@/lib/route-analytics";
import { addLocationLog, getAttendance, getEmployees, getLocationLogs } from "@/lib/storage";
import type { AttendanceRecord, Employee, LocationLog } from "@/lib/types";

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toShortDate(dateKey: string): string {
  const parsed = new Date(`${dateKey}T00:00:00`);
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toBatteryLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value <= 1 ? value * 100 : value;
  const rounded = Math.round(Math.max(0, Math.min(100, normalized)));
  return `${rounded}%`;
}

function toLocationKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}_${longitude.toFixed(4)}`;
}

function formatReverseGeocodeName(
  address: Location.LocationGeocodedAddress | undefined
): string | null {
  if (!address) return null;
  const compact = (value: string | null | undefined) => (value || "").trim();
  const unique = new Set<string>();
  const labels = [
    compact(address.name),
    compact(address.street),
    compact(address.district),
    compact(address.city),
    compact(address.subregion),
    compact(address.region),
  ].filter((value) => {
    if (!value) return false;
    const normalized = value.toLowerCase();
    if (unique.has(normalized)) return false;
    unique.add(normalized);
    return true;
  });
  if (!labels.length) return null;
  return labels.slice(0, 3).join(", ");
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function buildSelectedUserAliases(
  selectedEmployee: Employee | null,
  currentUser: { id: string; name: string; email: string } | null,
  attendance: AttendanceRecord[],
  selectedUserId: string
): Set<string> {
  const aliases = new Set<string>();
  if (selectedUserId) aliases.add(selectedUserId);
  if (selectedEmployee?.id) aliases.add(selectedEmployee.id);

  const employeeName = normalizeIdentity(selectedEmployee?.name);
  const employeeEmail = normalizeIdentity(selectedEmployee?.email);

  for (const entry of attendance) {
    if (!entry?.userId) continue;
    if (entry.userId === selectedUserId || entry.userId === selectedEmployee?.id) {
      aliases.add(entry.userId);
      continue;
    }
    if (employeeName && normalizeIdentity(entry.userName) === employeeName) {
      aliases.add(entry.userId);
    }
  }

  if (currentUser) {
    const userMatchesEmployee =
      (employeeEmail && normalizeIdentity(currentUser.email) === employeeEmail) ||
      (employeeName && normalizeIdentity(currentUser.name) === employeeName) ||
      currentUser.id === selectedUserId ||
      currentUser.id === selectedEmployee?.id;
    if (userMatchesEmployee) {
      aliases.add(currentUser.id);
    }
  }

  return aliases;
}

type TimelineRow =
  | {
      id: string;
      type: "attendance";
      at: string;
      text: string;
      icon: keyof typeof Ionicons.glyphMap;
      iconColor: string;
    }
  | {
      id: string;
      type: "moving" | "halt";
      startAt: string;
      endAt: string;
      text: string;
      icon: keyof typeof Ionicons.glyphMap;
      iconColor: string;
    };

export default function RouteTrackingScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [dayOffset, setDayOffset] = useState(0);
  const [dataSource, setDataSource] = useState<"live" | "demo">("live");
  const [mapMode, setMapMode] = useState<"tracking" | "polyline">("tracking");
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<AdminRouteTimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placeNameByLocationKey, setPlaceNameByLocationKey] = useState<Record<string, string>>({});
  const resolvingLocationKeysRef = useRef(new Set<string>());
  const LIVE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
  const ROUTE_POINT_MIN_MOVE_METERS = 22;
  const isExpoGo = Constants.appOwnership === "expo";
  const configuredMapProvider = (
    process.env.EXPO_PUBLIC_MAP_PROVIDER || (isExpoGo ? "google" : "mappls")
  )
    .trim()
    .toLowerCase();
  const mapProvider =
    configuredMapProvider === "mappls" && isExpoGo ? "google" : configuredMapProvider;

  const canViewTracking = user?.role === "admin" || user?.role === "manager" || user?.role === "hr";
  const selectedDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    return toLocalDateKey(date);
  }, [dayOffset]);
  const selectedEmployee = useMemo(
    () => employees.find((entry) => entry.id === selectedUserId) ?? null,
    [employees, selectedUserId]
  );

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const employeeData = await getEmployees();
      if (!mounted) return;
      const dedup = new Map<string, Employee>();
      for (const item of employeeData) dedup.set(item.id, item);
      const merged = Array.from(dedup.values()).sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(merged);
      if (merged.length > 0) {
        setSelectedUserId((current) => current || merged[0].id);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (mapProvider !== "mappls") {
      setMapMode("polyline");
    }
  }, [mapProvider]);

  const persistCurrentLocationPointIfMoved = useCallback(
    async (existingDayPoints: LocationLog[], aliases: Set<string>): Promise<boolean> => {
      if (!user || !selectedEmployee) return false;
      const todayKey = toLocalDateKey(new Date());
      if (selectedDate !== todayKey) return false;
      const canUseDeviceLocation = selectedUserId === user.id || aliases.has(user.id);
      if (!canUseDeviceLocation) return false;

      const permission = await getLocationPermissionSnapshot();
      let hasForegroundPermission = permission.foreground;
      if (!hasForegroundPermission && permission.foregroundCanAskAgain) {
        const request = await Location.requestForegroundPermissionsAsync();
        hasForegroundPermission = request.granted;
      }
      if (!hasForegroundPermission) return false;
      const gpsEnabled = await ensureLocationServicesEnabled();
      if (!gpsEnabled) return false;

      let coords:
        | {
            latitude: number;
            longitude: number;
            accuracy: number | null;
            speed: number | null;
            heading: number | null;
          }
        | null = null;
      try {
        const evidence = await getVerifiedLocationEvidence({
          minAccuracyMeters: 260,
          maxAttempts: 2,
          requiredStableSamples: 1,
          sampleWaitMs: 500,
          maxDriftMeters: 220,
        });
        coords = {
          latitude: evidence.location.coords.latitude,
          longitude: evidence.location.coords.longitude,
          accuracy: evidence.location.coords.accuracy ?? null,
          speed: evidence.location.coords.speed ?? null,
          heading: evidence.location.coords.heading ?? null,
        };
      } catch {
        const lastKnown = await Location.getLastKnownPositionAsync({
          maxAge: 10 * 60 * 1000,
          requiredAccuracy: 350,
        });
        if (!lastKnown) return false;
        coords = {
          latitude: lastKnown.coords.latitude,
          longitude: lastKnown.coords.longitude,
          accuracy: lastKnown.coords.accuracy ?? null,
          speed: lastKnown.coords.speed ?? null,
          heading: lastKnown.coords.heading ?? null,
        };
      }

      if (!coords) return false;
      const lastPoint = existingDayPoints[existingDayPoints.length - 1];
      if (lastPoint) {
        const movedDistance = haversineDistanceMeters(
          lastPoint.latitude,
          lastPoint.longitude,
          coords.latitude,
          coords.longitude
        );
        if (movedDistance < ROUTE_POINT_MIN_MOVE_METERS) {
          return false;
        }
      }

      const capturedAt = new Date().toISOString();
      const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 25_000 });
      const userIdForLog = selectedEmployee.id || user.id;

      await addLocationLog({
        id: `route_point_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: userIdForLog,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        speed: coords.speed,
        heading: coords.heading,
        batteryLevel,
        geofenceId: null,
        geofenceName: selectedEmployee.branch || null,
        isInsideGeofence: true,
        capturedAt,
      });

      void postLocationLog({
        userId: userIdForLog,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        speed: coords.speed,
        heading: coords.heading,
        batteryLevel,
        capturedAt,
      }).catch(() => {
        // Keep route UI responsive even when API sync fails.
      });

      return true;
    },
    [selectedDate, selectedEmployee, user]
  );

  const loadTimeline = useCallback(async () => {
    if (!selectedUserId || !canViewTracking) return;
    setLoading(true);
    setError(null);
    try {
      if (dataSource === "demo") {
        try {
          const remoteDemo = await getAdminDemoRouteTimeline(selectedUserId, selectedDate);
          setTimeline(remoteDemo);
          return;
        } catch {
          const demoPoints = buildDemoRoutePoints(selectedUserId, selectedDate);
          const demoTimeline = buildRouteTimeline(selectedUserId, selectedDate, demoPoints);
          const firstPoint = demoPoints[0];
          const lastPoint = demoPoints[demoPoints.length - 1];
          setTimeline({
            ...demoTimeline,
            attendanceEvents: [
              {
                id: `demo_checkin_local_${selectedUserId}_${selectedDate}`,
                type: "checkin",
                at: firstPoint?.capturedAt ?? new Date(`${selectedDate}T09:00:00`).toISOString(),
                geofenceName: firstPoint?.geofenceName ?? "Route Start",
                latitude: firstPoint?.latitude ?? null,
                longitude: firstPoint?.longitude ?? null,
              },
              {
                id: `demo_checkout_local_${selectedUserId}_${selectedDate}`,
                type: "checkout",
                at: lastPoint?.capturedAt ?? new Date(`${selectedDate}T12:05:00`).toISOString(),
                geofenceName: lastPoint?.geofenceName ?? "Route End",
                latitude: lastPoint?.latitude ?? null,
                longitude: lastPoint?.longitude ?? null,
              },
            ],
          });
          setError("Demo API unreachable, using local dummy route.");
          return;
        }
      }

      const [logsSnapshot, attendanceSnapshot] = await Promise.all([getLocationLogs(), getAttendance()]);
      const aliases = buildSelectedUserAliases(
        selectedEmployee,
        user ? { id: user.id, name: user.name, email: user.email } : null,
        attendanceSnapshot,
        selectedUserId
      );

      let allLocalLogsForAliases = logsSnapshot
        .filter((log) => aliases.has(log.userId))
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      let dayLocalPoints = allLocalLogsForAliases.filter((log) =>
        log.capturedAt.startsWith(selectedDate)
      );

      const createdCurrentPoint = await persistCurrentLocationPointIfMoved(dayLocalPoints, aliases);
      if (createdCurrentPoint) {
        const refreshedLogs = await getLocationLogs();
        allLocalLogsForAliases = refreshedLogs
          .filter((log) => aliases.has(log.userId))
          .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
        dayLocalPoints = allLocalLogsForAliases.filter((log) =>
          log.capturedAt.startsWith(selectedDate)
        );
      }

      if (!dayLocalPoints.length && selectedDate === toLocalDateKey(new Date()) && allLocalLogsForAliases.length) {
        // Show at least latest known user location on today's map even before movement timeline forms.
        dayLocalPoints = [allLocalLogsForAliases[allLocalLogsForAliases.length - 1]];
      }

      const localTimeline = buildRouteTimeline(selectedUserId, selectedDate, dayLocalPoints);
      const selectedEmployeeName = normalizeIdentity(selectedEmployee?.name);
      const localAttendanceEvents = attendanceSnapshot
        .filter((entry) => entry.timestamp.startsWith(selectedDate))
        .filter(
          (entry) =>
            aliases.has(entry.userId) ||
            (selectedEmployeeName && normalizeIdentity(entry.userName) === selectedEmployeeName)
        )
        .map((entry) => ({
          id: entry.id,
          type: entry.type,
          at: entry.timestamp,
          geofenceName: entry.geofenceName ?? null,
          latitude: entry.location?.lat ?? null,
          longitude: entry.location?.lng ?? null,
        }))
        .sort((a, b) => a.at.localeCompare(b.at));

      const localResolvedTimeline: AdminRouteTimelineResponse = {
        ...localTimeline,
        attendanceEvents: localAttendanceEvents,
      };

      const remoteCandidates = [
        selectedUserId,
        ...Array.from(aliases).filter((alias) => alias !== selectedUserId),
      ];
      let remoteTimeline: AdminRouteTimelineResponse | null = null;
      let remoteFailure: unknown = null;
      for (const candidateUserId of remoteCandidates) {
        try {
          const currentRemote = await getAdminRouteTimeline(candidateUserId, selectedDate);
          if (!remoteTimeline) {
            remoteTimeline = currentRemote;
          }
          if ((currentRemote.points?.length ?? 0) > 0 || (currentRemote.attendanceEvents?.length ?? 0) > 0) {
            remoteTimeline = currentRemote;
            break;
          }
        } catch (candidateError) {
          remoteFailure = candidateError;
        }
      }

      if (remoteTimeline && (remoteTimeline.points?.length ?? 0) > 0) {
        setTimeline(remoteTimeline);
        return;
      }

      const hasLocalData =
        (localResolvedTimeline.points?.length ?? 0) > 0 ||
        (localResolvedTimeline.attendanceEvents?.length ?? 0) > 0;

      if (hasLocalData) {
        setTimeline(localResolvedTimeline);
        setError("Showing current/local route points while live API catches up.");
        return;
      }

      if (remoteTimeline) {
        setTimeline(remoteTimeline);
        return;
      }

      throw remoteFailure instanceof Error ? remoteFailure : new Error("Unable to load route timeline.");
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : "Unable to load route timeline.");
    } finally {
      setLoading(false);
    }
  }, [
    canViewTracking,
    dataSource,
    persistCurrentLocationPointIfMoved,
    selectedDate,
    selectedEmployee,
    selectedUserId,
    user,
  ]);

  useEffect(() => {
    void loadTimeline();
  }, [loadTimeline]);

  useEffect(() => {
    if (!selectedUserId || !canViewTracking) return undefined;
    const timer = setInterval(() => {
      void loadTimeline();
    }, LIVE_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [canViewTracking, loadTimeline, selectedUserId, LIVE_REFRESH_INTERVAL_MS]);

  useEffect(() => {
    if (mapMode === "tracking" && (timeline?.points?.length ?? 0) < 2) {
      setMapMode("polyline");
    }
  }, [mapMode, timeline?.points?.length]);

  const rows = useMemo<TimelineRow[]>(() => {
    if (!timeline) return [];
    const haltById = new Map(timeline.halts.map((halt) => [halt.id, halt]));
    const attendanceRows: TimelineRow[] = timeline.attendanceEvents.map((event) => ({
      id: `att_${event.id}`,
      type: "attendance",
      at: event.at,
      icon: event.type === "checkin" ? "log-in-outline" : "log-out-outline",
      iconColor: event.type === "checkin" ? colors.success : colors.danger,
      text: `${event.type === "checkin" ? "Checked In" : "Checked Out"} at ${event.geofenceName || "Unknown Zone"}`,
    }));

    const segmentRows: TimelineRow[] = timeline.segments.map((segment) => {
      if (segment.type === "halt") {
        const halt = segment.haltId ? haltById.get(segment.haltId) : undefined;
        const startBattery = toBatteryLabel(halt?.startBatteryLevel);
        const endBattery = toBatteryLabel(halt?.endBatteryLevel);
        const averageBattery = toBatteryLabel(halt?.averageBatteryLevel);
        const batteryText =
          startBattery && endBattery
            ? ` | Battery ${startBattery} -> ${endBattery}`
            : averageBattery
              ? ` | Battery ${averageBattery}`
              : "";
        return {
          id: `seg_${segment.id}`,
          type: "halt",
          startAt: segment.startAt,
          endAt: segment.endAt,
          icon: "pause-circle-outline",
          iconColor: colors.warning,
          text: `Halt at ${segment.fromLabel} (${segment.durationMinutes} mins)${batteryText}`,
        };
      }
      const km = (segment.distanceMeters / 1000).toFixed(2);
      return {
        id: `seg_${segment.id}`,
        type: "moving",
        startAt: segment.startAt,
        endAt: segment.endAt,
        icon: "navigate-outline",
        iconColor: colors.primary,
        text: `Moving (${km} km, ${segment.durationMinutes} mins)`,
      };
    });

    const merged = [...attendanceRows, ...segmentRows];
    return merged.sort((a, b) => {
      const aStart = a.type === "attendance" ? a.at : a.startAt;
      const bStart = b.type === "attendance" ? b.at : b.startAt;
      return aStart.localeCompare(bStart);
    });
  }, [colors.danger, colors.primary, colors.success, colors.warning, timeline]);

  const routePointRows = useMemo(() => {
    if (!timeline?.points?.length) return [];
    return [...timeline.points]
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      .map((point) => ({
        id: point.id,
        at: point.capturedAt,
        geofenceName: point.geofenceName || null,
        latitude: point.latitude,
        longitude: point.longitude,
        locationKey: toLocationKey(point.latitude, point.longitude),
        locationName: placeNameByLocationKey[toLocationKey(point.latitude, point.longitude)] ?? null,
        battery: toBatteryLabel(point.batteryLevel),
      }));
  }, [placeNameByLocationKey, timeline?.points]);

  useEffect(() => {
    if (!routePointRows.length) return;
    let cancelled = false;

    const unresolved = routePointRows.filter(
      (point) =>
        !point.locationName && !resolvingLocationKeysRef.current.has(point.locationKey)
    );
    if (!unresolved.length) return;

    const resolveNames = async () => {
      for (const point of unresolved) {
        if (cancelled) break;
        resolvingLocationKeysRef.current.add(point.locationKey);
        try {
          const geoResults = await Location.reverseGeocodeAsync({
            latitude: point.latitude,
            longitude: point.longitude,
          });
          const resolvedName =
            formatReverseGeocodeName(geoResults[0]) ||
            point.geofenceName ||
            "Location unavailable";
          if (!cancelled) {
            setPlaceNameByLocationKey((current) =>
              current[point.locationKey]
                ? current
                : { ...current, [point.locationKey]: resolvedName }
            );
          }
        } catch {
          const fallbackName = point.geofenceName || "Location unavailable";
          if (!cancelled) {
            setPlaceNameByLocationKey((current) =>
              current[point.locationKey]
                ? current
                : { ...current, [point.locationKey]: fallbackName }
            );
          }
        } finally {
          resolvingLocationKeysRef.current.delete(point.locationKey);
        }
      }
    };

    void resolveNames();
    return () => {
      cancelled = true;
    };
  }, [routePointRows]);
  const latestRoutePoint = routePointRows.length
    ? routePointRows[routePointRows.length - 1]
    : null;

  if (!canViewTracking) {
    return (
      <AppCanvas>
        <View style={[styles.deniedWrap, { paddingTop: insets.top + 24 }]}>
          <Ionicons name="shield-outline" size={42} color={colors.textTertiary} />
          <Text style={[styles.deniedTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Access restricted
          </Text>
          <Text style={[styles.deniedText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            Route tracking dashboard is available for Admin/Manager roles.
          </Text>
          <Pressable onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.primary }]}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </Pressable>
        </View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 14 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            Route & Halt Tracking
          </Text>
          <Pressable onPress={() => void loadTimeline()} hitSlop={12}>
            <Ionicons name="refresh-outline" size={22} color={colors.primary} />
          </Pressable>
        </View>

        <Animated.View entering={FadeInDown.duration(350)} style={styles.controlsCard}>
          <Text style={[styles.label, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
            Employee
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {employees.map((employee) => {
              const active = employee.id === selectedUserId;
              return (
                <Pressable
                  key={employee.id}
                  onPress={() => setSelectedUserId(employee.id)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.primary : colors.backgroundElevated,
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      {
                        color: active ? "#FFFFFF" : colors.textSecondary,
                        fontFamily: "Inter_500Medium",
                      },
                    ]}
                  >
                    {employee.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.dateRow}>
            <Pressable
              onPress={() => setDayOffset((value) => value - 1)}
              style={[styles.dateButton, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
            >
              <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
            </Pressable>
            <View style={[styles.dateLabelWrap, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}>
              <Text style={[styles.dateLabel, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                {toShortDate(selectedDate)}
              </Text>
            </View>
            <Pressable
              onPress={() => setDayOffset((value) => Math.min(0, value + 1))}
              style={[styles.dateButton, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
            >
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </Pressable>
            <Pressable
              onPress={() => setDayOffset(0)}
              style={[styles.todayButton, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
          </View>

          <View style={styles.sourceRow}>
            <Pressable
              onPress={() => setDataSource("live")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    dataSource === "live" ? colors.primary : colors.backgroundElevated,
                  borderColor: dataSource === "live" ? colors.primary : colors.border,
                },
              ]}
            >
              <Ionicons
                name="cloud-outline"
                size={14}
                color={dataSource === "live" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: dataSource === "live" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Live API
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setDataSource("demo")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    dataSource === "demo" ? colors.secondary : colors.backgroundElevated,
                  borderColor: dataSource === "demo" ? colors.secondary : colors.border,
                },
              ]}
            >
              <Ionicons
                name="map-outline"
                size={14}
                color={dataSource === "demo" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: dataSource === "demo" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Demo API Route
              </Text>
            </Pressable>
          </View>
        </Animated.View>

        {loading ? (
          <View style={[styles.loadingWrap, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Loading route timeline...
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={[styles.errorWrap, { backgroundColor: colors.warning + "14", borderColor: colors.warning + "55" }]}>
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={[styles.errorText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>{error}</Text>
          </View>
        ) : null}

        {dataSource === "demo" ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.secondary + "16", borderColor: colors.secondary + "55" }]}>
            <Ionicons name="information-circle-outline" size={16} color={colors.secondary} />
            <Text style={[styles.infoText, { color: colors.secondary, fontFamily: "Inter_500Medium" }]}>
              Demo route is active. In this mode, the map and halt timeline are rendered using dummy API data.
            </Text>
          </View>
        ) : null}

        {mapProvider === "mappls" ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.primary + "16", borderColor: colors.primary + "55" }]}>
            <Ionicons name="map-outline" size={16} color={colors.primary} />
            <Text style={[styles.infoText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
              Map provider: Mappls (Android). Keep Mappls `*.a.conf/*.a.olf` files in `android/app` and run a dev build. Cluster ID is optional.
            </Text>
          </View>
        ) : null}

        {mapProvider === "mappls" ? (
          <View style={styles.sourceRow}>
            <Pressable
              onPress={() => setMapMode("tracking")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    mapMode === "tracking" ? colors.success : colors.backgroundElevated,
                  borderColor: mapMode === "tracking" ? colors.success : colors.border,
                },
              ]}
            >
              <Ionicons
                name="car-sport-outline"
                size={14}
                color={mapMode === "tracking" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: mapMode === "tracking" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Tracking Widget
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setMapMode("polyline")}
              style={[
                styles.sourceChip,
                {
                  backgroundColor:
                    mapMode === "polyline" ? colors.primary : colors.backgroundElevated,
                  borderColor: mapMode === "polyline" ? colors.primary : colors.border,
                },
              ]}
            >
              <Ionicons
                name="git-network-outline"
                size={14}
                color={mapMode === "polyline" ? "#FFFFFF" : colors.textSecondary}
              />
              <Text
                style={[
                  styles.sourceChipText,
                  {
                    color: mapMode === "polyline" ? "#FFFFFF" : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                  },
                ]}
              >
                Polyline
              </Text>
            </Pressable>
          </View>
        ) : null}

        {timeline?.directions?.enabled ? (
          <View style={[styles.infoWrap, { backgroundColor: colors.success + "16", borderColor: colors.success + "55" }]}>
            <Ionicons name="git-network-outline" size={16} color={colors.success} />
            <Text style={[styles.infoText, { color: colors.success, fontFamily: "Inter_500Medium" }]}>
              Road route: {timeline.directions.resource}/{timeline.directions.profile}
              {typeof timeline.directions.distanceMeters === "number"
                ? ` | ${(timeline.directions.distanceMeters / 1000).toFixed(2)} km`
                : ""}
              {typeof timeline.directions.durationSeconds === "number"
                ? ` | ${Math.max(1, Math.round(timeline.directions.durationSeconds / 60))} mins`
                : ""}
              {timeline.directions.error ? " | API fallback to sampled GPS" : ""}
            </Text>
          </View>
        ) : null}

        <Animated.View entering={FadeInDown.duration(350).delay(50)}>
          <RouteMapNative
            points={timeline?.points ?? []}
            halts={timeline?.halts ?? []}
            routePath={timeline?.directions?.path ?? undefined}
            mapMode={mapMode}
            colors={colors}
            height={Platform.OS === "web" ? 240 : 270}
          />
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(80)} style={styles.summaryRow}>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {timeline?.summary.totalDistanceKm.toFixed(2) ?? "0.00"} km
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Distance
            </Text>
          </View>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {timeline?.summary.totalHaltMinutes ?? 0} mins
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Halt Time
            </Text>
          </View>
          <View style={[styles.summaryCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {timeline?.summary.haltCount ?? 0}
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Halts
            </Text>
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(350).delay(95)}
          style={[styles.currentLocationCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
        >
          <View style={[styles.currentLocationIcon, { backgroundColor: `${colors.primary}18` }]}>
            <Ionicons name="locate-outline" size={16} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.currentLocationTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Current Location
            </Text>
            <Text style={[styles.currentLocationMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {latestRoutePoint
                ? `${latestRoutePoint.locationName || latestRoutePoint.geofenceName || "Resolving location..."} | ${toTime(
                    latestRoutePoint.at
                  )}${latestRoutePoint.battery ? ` | ${latestRoutePoint.battery}` : ""}`
                : "Waiting for live GPS point..."}
            </Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(120)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Route Points (GPS + Battery)
          </Text>
          <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            {routePointRows.length ? (
              routePointRows.map((point, idx) => (
                <View
                  key={`point_${point.id}`}
                  style={[
                    styles.row,
                    idx < routePointRows.length - 1 && {
                      borderBottomColor: colors.borderLight,
                      borderBottomWidth: 0.5,
                    },
                  ]}
                >
                  <View style={[styles.rowIconWrap, { backgroundColor: `${colors.secondary}18` }]}>
                    <Ionicons name="location-outline" size={16} color={colors.secondary} />
                  </View>
                  <View style={styles.rowTextWrap}>
                    <Text style={[styles.rowTime, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      {toTime(point.at)} | {point.battery || "--"}
                    </Text>
                    <Text style={[styles.rowText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      {point.locationName || point.geofenceName || "Resolving location..."}
                    </Text>
                  </View>
                </View>
              ))
            ) : (
              <View style={styles.emptyTimeline}>
                <Text style={[styles.emptyTimelineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No route points available.
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(350).delay(140)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Detailed Timeline {selectedEmployee ? `- ${selectedEmployee.name}` : ""}
          </Text>
          <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
            {rows.length ? (
              rows.map((row, idx) => {
                const startLabel = row.type === "attendance" ? toTime(row.at) : `${toTime(row.startAt)} - ${toTime(row.endAt)}`;
                return (
                  <View
                    key={row.id}
                    style={[
                      styles.row,
                      idx < rows.length - 1 && { borderBottomColor: colors.borderLight, borderBottomWidth: 0.5 },
                    ]}
                  >
                    <View style={[styles.rowIconWrap, { backgroundColor: `${row.iconColor}18` }]}>
                      <Ionicons name={row.icon} size={16} color={row.iconColor} />
                    </View>
                    <View style={styles.rowTextWrap}>
                      <Text style={[styles.rowTime, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {startLabel}
                      </Text>
                      <Text style={[styles.rowText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {row.text}
                      </Text>
                    </View>
                  </View>
                );
              })
            ) : (
              <View style={styles.emptyTimeline}>
                <Text style={[styles.emptyTimelineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No movement timeline generated for this date.
                </Text>
              </View>
            )}
          </View>
        </Animated.View>

        <View style={{ height: 38 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 18,
    paddingBottom: 24,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 19,
    letterSpacing: -0.25,
  },
  controlsCard: {
    gap: 10,
  },
  label: {
    fontSize: 12,
  },
  chipRow: {
    gap: 8,
    paddingRight: 20,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 12.5,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sourceRow: {
    flexDirection: "row",
    gap: 8,
  },
  sourceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 34,
    paddingHorizontal: 10,
  },
  sourceChipText: {
    fontSize: 12,
  },
  dateButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabelWrap: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabel: {
    fontSize: 13,
  },
  todayButton: {
    borderRadius: 10,
    minHeight: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  todayText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  loadingWrap: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 62,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
  },
  errorWrap: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    flex: 1,
  },
  infoWrap: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  infoText: {
    fontSize: 12,
    flex: 1,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
    gap: 2,
  },
  summaryValue: {
    fontSize: 15,
  },
  summaryLabel: {
    fontSize: 11,
  },
  currentLocationCard: {
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 62,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  currentLocationIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  currentLocationTitle: {
    fontSize: 12.5,
  },
  currentLocationMeta: {
    marginTop: 2,
    fontSize: 11.8,
    lineHeight: 17,
  },
  sectionTitle: {
    fontSize: 15,
    marginBottom: 8,
  },
  timelineCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTextWrap: {
    flex: 1,
    gap: 2,
  },
  rowTime: {
    fontSize: 12.5,
  },
  rowText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  emptyTimeline: {
    minHeight: 88,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  emptyTimelineText: {
    fontSize: 13,
    textAlign: "center",
  },
  deniedWrap: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 12,
  },
  deniedTitle: {
    fontSize: 20,
  },
  deniedText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  backButton: {
    marginTop: 6,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});

