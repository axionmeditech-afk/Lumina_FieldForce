import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  Alert,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import * as ExpoLocation from "expo-location";
import type { LocationObject } from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { evaluateGeofenceStatus } from "@/lib/geofence";
import {
  addAttendance,
  addAttendanceAnomaly,
  addLocationLog,
  getAttendance,
  getEmployees,
  getGeofencesForUser,
  getSettings,
  isCheckedIn,
  setCheckedIn,
  updateAttendanceApproval,
} from "@/lib/storage";
import type { AttendanceRecord, Geofence, GeofenceEvaluation } from "@/lib/types";
import {
  attendanceCheckIn,
  attendanceCheckOut,
  flushAttendanceQueue,
  getUserGeofences,
  queueAttendanceRequest,
} from "@/lib/attendance-api";
import { flushBackgroundLocationQueue, queueLocationPoint } from "@/lib/background-location";
import {
  ensureLocationServicesEnabled,
  getVerifiedLocationEvidence,
  getLocationPermissionSnapshot,
  isMockLocation,
  requestLocationPermissionBundle,
  startSignificantLocationTracking,
} from "@/lib/location-service";
import { verifyBiometricForAttendance } from "@/lib/biometric-attendance";
import { getBatteryLevelPercent } from "@/lib/battery";
import { isBackendReachable } from "@/lib/network";
import { getClientSecurityStatus } from "@/lib/security-client";
import { canReviewAttendanceSignIns } from "@/lib/role-access";

const LOCATION_REFRESH_MS = 1 * 60 * 1000;
const STRICT_LOCATION_ACCURACY_METERS = 180;
const RELAXED_LOCATION_ACCURACY_METERS = 220;
const TRACKING_TIME_INTERVAL_MS = 1 * 60 * 1000;
const TRACKING_DISTANCE_INTERVAL_METERS = 0;
const ROUTE_POINT_PERSIST_INTERVAL_MS = 1 * 60 * 1000;
const MIN_STABLE_LOCATION_SAMPLES = 2;
const STABLE_LOCATION_MAX_DRIFT_METERS = 90;
const AHMEDABAD_TEST_EMAIL = "ahmedabad@trackforce.ai";
const AHMEDABAD_OFFICE_LATITUDE = 23.0252;
const AHMEDABAD_OFFICE_LONGITUDE = 72.5713;
const AHMEDABAD_OFFICE_LOCK_ACCURACY_METERS = 25;

type BannerType = "inside" | "outside" | "weak" | "boundary";

function getBannerConfig(type: BannerType, colors: ReturnType<typeof useAppTheme>["colors"]) {
  if (type === "inside") {
    return {
      bg: `${colors.success}1C`,
      border: `${colors.success}55`,
      text: colors.success,
      icon: "checkmark-circle",
      label: "Inside geofence",
    };
  }
  if (type === "boundary") {
    return {
      bg: `${colors.warning}1A`,
      border: `${colors.warning}55`,
      text: colors.warning,
      icon: "navigate-circle-outline",
      label: "Near geofence boundary",
    };
  }
  if (type === "weak") {
    return {
      bg: `${colors.warning}1A`,
      border: `${colors.warning}55`,
      text: colors.warning,
      icon: "radio-outline",
      label: "Weak GPS signal",
    };
  }
  return {
    bg: `${colors.danger}1A`,
    border: `${colors.danger}55`,
    text: colors.danger,
    icon: "alert-circle",
    label: "Outside geofence",
  };
}

function isConfirmedInsideZone(state: GeofenceEvaluation): boolean {
  return state.inside && state.insideConfirmed !== false;
}

function isWithinZoneShift(zone: Geofence | null): boolean {
  if (!zone?.workingHoursStart || !zone.workingHoursEnd) return true;
  const [sH, sM] = zone.workingHoursStart.split(":").map(Number);
  const [eH, eM] = zone.workingHoursEnd.split(":").map(Number);
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sH * 60 + sM;
  const endMins = eH * 60 + eM;
  if (endMins >= startMins) {
    return nowMins >= startMins && nowMins <= endMins;
  }
  return nowMins >= startMins || nowMins <= endMins;
}

function makeLocalAttendanceRecord(
  userId: string,
  userName: string,
  type: "checkin" | "checkout",
  latitude: number,
  longitude: number,
  evaluation: GeofenceEvaluation,
  photoUrl: string | null,
  deviceId: string,
  notes?: string
): AttendanceRecord {
  const now = new Date().toISOString();
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    userName,
    type,
    timestamp: now,
    timestampServer: now,
    location: { lat: latitude, lng: longitude },
    geofenceId: evaluation.activeZone?.id ?? null,
    geofenceName: evaluation.activeZone?.name ?? null,
    photoUrl,
    deviceId,
    isInsideGeofence: isConfirmedInsideZone(evaluation),
    source: "mobile",
    notes,
  };
}

function resolveCheckedInFromRecords(records: AttendanceRecord[], userId: string, userName?: string): boolean | null {
  const normalizedUserName = (userName || "").trim().toLowerCase();
  const latest = records
    .filter(
      (entry) =>
        entry.userId === userId ||
        ((entry.userName || "").trim().toLowerCase() === normalizedUserName && normalizedUserName.length > 0)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (!latest) return null;
  return latest.type === "checkin";
}

export default function AttendanceScreen() {
  const { user, company } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [pendingSignIns, setPendingSignIns] = useState<AttendanceRecord[]>([]);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [evaluation, setEvaluation] = useState<GeofenceEvaluation>({
    inside: false,
    insideConfirmed: false,
    activeZone: null,
    nearestDistanceMeters: Number.POSITIVE_INFINITY,
    confidenceBufferMeters: 15,
    distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
    signalWeak: true,
    warning: "Waiting for GPS",
  });
  const [checkedInState, setCheckedInState] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(true);
  const [gpsEvidence, setGpsEvidence] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [approvalActionId, setApprovalActionId] = useState<string | null>(null);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionExplainerOpen, setPermissionExplainerOpen] = useState(true);
  const [autoPromptVisible, setAutoPromptVisible] = useState(false);
  const [locationReady, setLocationReady] = useState(false);
  const prevInsideRef = useRef(false);
  const locationWatchRef = useRef<{ remove: () => void } | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const routePersistLastAtMsRef = useRef<number>(0);
  const latestEvidenceRef = useRef<{
    sampleCount: number;
    sampleWindowMs: number;
    bestAccuracyMeters: number | null;
  } | null>(null);
  const successScale = useSharedValue(1);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: successScale.value }],
  }));

  const canReviewSignIns = canReviewAttendanceSignIns(user?.role);
  const isSalespersonFieldCheckIn = user?.role === "salesperson";
  const todayHeading = "Today's Log";
  const isAhmedabadOfficeLockUser = useMemo(
    () => (user?.email || "").trim().toLowerCase() === AHMEDABAD_TEST_EMAIL,
    [user?.email]
  );

  const openAppSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const applyAhmedabadOfficeLocationLock = useCallback(
    (location: LocationObject): LocationObject => {
      if (!isAhmedabadOfficeLockUser) return location;
      const incomingAccuracy = location.coords.accuracy;
      const normalizedAccuracy =
        typeof incomingAccuracy === "number" && Number.isFinite(incomingAccuracy)
          ? Math.min(incomingAccuracy, AHMEDABAD_OFFICE_LOCK_ACCURACY_METERS)
          : AHMEDABAD_OFFICE_LOCK_ACCURACY_METERS;
      return {
        ...location,
        coords: {
          ...location.coords,
          latitude: AHMEDABAD_OFFICE_LATITUDE,
          longitude: AHMEDABAD_OFFICE_LONGITUDE,
          accuracy: normalizedAccuracy,
        },
      };
    },
    [isAhmedabadOfficeLockUser]
  );

  const showPermissionBlockedAlert = useCallback(() => {
    Alert.alert(
      "Location Permission Blocked",
      "Please enable location permission from device settings to continue.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: openAppSettings },
      ]
    );
  }, [openAppSettings]);

  const loadBaseData = useCallback(async () => {
    if (!user?.id) return;
    const [localAttendance, currentCheckIn] = await Promise.all([getAttendance(), isCheckedIn()]);
    const userRecords = localAttendance.filter(
      (entry) => entry.userId === user.id || entry.userName === user.name
    );
    setRecords(userRecords);
    if (canReviewSignIns) {
      const employees = await getEmployees();
      const roleByEmployeeId = new Map(employees.map((employee) => [employee.id, employee.role]));
      const roleByName = new Map(employees.map((employee) => [employee.name, employee.role]));
      const pending = localAttendance
        .filter((entry) => {
          if (entry.type !== "checkin") return false;
          if ((entry.approvalStatus ?? "approved") !== "pending") return false;
          if (entry.userId === user.id) return false;
          const recordRole = roleByEmployeeId.get(entry.userId) ?? roleByName.get(entry.userName) ?? "salesperson";
          return recordRole !== "admin" && recordRole !== "manager";
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setPendingSignIns(pending);
    } else {
      setPendingSignIns([]);
    }
    const derivedCheckIn = resolveCheckedInFromRecords(localAttendance, user.id, user.name);
    const resolvedCheckIn = derivedCheckIn ?? currentCheckIn;
    setCheckedInState(resolvedCheckIn);
    if (resolvedCheckIn !== currentCheckIn) {
      await setCheckedIn(resolvedCheckIn);
    }
  }, [canReviewSignIns, user?.id, user?.name]);

  const loadGeofenceAssignments = useCallback(async () => {
    if (!user?.id) return;
    try {
      const online = await isBackendReachable();
      if (online) {
        const zones = await getUserGeofences(user.id);
        setGeofences(zones);
        return;
      }
    } catch {
      // fallback handled below
    }
    const cached = await getGeofencesForUser(user.id);
    setGeofences(cached);
  }, [user?.id]);

  useEffect(() => {
    let active = true;
    (async () => {
      const locationPermissions = await getLocationPermissionSnapshot();
      if (!active) return;
      if (locationPermissions.foreground) {
        setPermissionExplainerOpen(false);
      }
    })().catch(() => {
      // fallback: keep modal visible and allow explicit retry
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    routePersistLastAtMsRef.current = 0;
  }, [user?.id]);

  const handleLocationUpdate = useCallback(
    async (location: LocationObject, options?: { skipRoutePersistence?: boolean }) => {
      if (!user?.id) return;
      const effectiveLocation = applyAhmedabadOfficeLocationLock(location);
      const nextEvaluation = evaluateGeofenceStatus(
        geofences,
        effectiveLocation.coords.latitude,
        effectiveLocation.coords.longitude,
        effectiveLocation.coords.accuracy ?? undefined
      );
      const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
      setEvaluation(nextEvaluation);
      setGpsLoading(false);
      setLocationReady(true);

      const shouldPersistRoutePoint =
        (!isSalespersonFieldCheckIn || checkedInState) && !options?.skipRoutePersistence;
      const nowMs = Date.now();
      const canPersistRoutePoint =
        shouldPersistRoutePoint &&
        (routePersistLastAtMsRef.current <= 0 ||
          nowMs - routePersistLastAtMsRef.current >= ROUTE_POINT_PERSIST_INTERVAL_MS);
      if (canPersistRoutePoint) {
        routePersistLastAtMsRef.current = nowMs;
        void (async () => {
          const capturedAt = new Date(nowMs).toISOString();
          try {
            await addLocationLog({
              id: `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              userId: user.id,
              latitude: effectiveLocation.coords.latitude,
              longitude: effectiveLocation.coords.longitude,
              accuracy: effectiveLocation.coords.accuracy ?? null,
              speed: effectiveLocation.coords.speed ?? null,
              heading: effectiveLocation.coords.heading ?? null,
              batteryLevel,
              geofenceId: nextEvaluation.activeZone?.id ?? null,
              geofenceName: nextEvaluation.activeZone?.name ?? null,
              isInsideGeofence: nextEvaluation.inside,
              capturedAt,
            });
          } catch {
            // never fail active session because local location persistence failed
          }
          try {
            await queueLocationPoint({
              userId: user.id,
              latitude: effectiveLocation.coords.latitude,
              longitude: effectiveLocation.coords.longitude,
              accuracy: effectiveLocation.coords.accuracy ?? null,
              speed: effectiveLocation.coords.speed ?? null,
              heading: effectiveLocation.coords.heading ?? null,
              batteryLevel,
              capturedAt,
            });
            await flushBackgroundLocationQueue();
          } catch {
            // offline/API failure: point is persisted in queue for retry.
          }
        })();
      }

      const shouldPrompt =
        isConfirmedInsideZone(nextEvaluation) &&
        !checkedInState &&
        !prevInsideRef.current &&
        isWithinZoneShift(nextEvaluation.activeZone);
      prevInsideRef.current = isConfirmedInsideZone(nextEvaluation);
      if (shouldPrompt) {
        void (async () => {
          try {
            const settings = await getSettings();
            if (settings.notifications !== "false") {
              setAutoPromptVisible(true);
            }
          } catch {
            // ignore settings read failure for passive prompt
          }
        })();
      }
    },
    [applyAhmedabadOfficeLocationLock, checkedInState, geofences, isSalespersonFieldCheckIn, user?.id]
  );

  const refreshLocation = useCallback(
    async (strict = false, options?: { skipRoutePersistence?: boolean }) => {
      const enabled = await ensureLocationServicesEnabled();
      if (!enabled) {
        latestEvidenceRef.current = null;
        setGpsEvidence("");
        setLocationReady(false);
        setEvaluation({
          inside: false,
          insideConfirmed: false,
          activeZone: null,
          nearestDistanceMeters: Number.POSITIVE_INFINITY,
          confidenceBufferMeters: 15,
          distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
          signalWeak: true,
          warning: "GPS services are disabled",
        });
        return null;
      }

      try {
        const evidence = await getVerifiedLocationEvidence({
          minAccuracyMeters: isAhmedabadOfficeLockUser
            ? strict
              ? 350
              : 450
            : strict
              ? STRICT_LOCATION_ACCURACY_METERS
              : RELAXED_LOCATION_ACCURACY_METERS,
          maxAttempts: isAhmedabadOfficeLockUser ? (strict ? 3 : 2) : strict ? 8 : 5,
          requiredStableSamples: isAhmedabadOfficeLockUser
            ? 1
            : strict
              ? MIN_STABLE_LOCATION_SAMPLES
              : 1,
          maxDriftMeters: isAhmedabadOfficeLockUser
            ? 250
            : strict
              ? Math.max(STABLE_LOCATION_MAX_DRIFT_METERS, 120)
              : 180,
        });
        const effectiveLocation = applyAhmedabadOfficeLocationLock(evidence.location);
        const bestAccuracyMeters = isAhmedabadOfficeLockUser
          ? typeof evidence.bestAccuracyMeters === "number"
            ? Math.min(evidence.bestAccuracyMeters, AHMEDABAD_OFFICE_LOCK_ACCURACY_METERS)
            : AHMEDABAD_OFFICE_LOCK_ACCURACY_METERS
          : evidence.bestAccuracyMeters;
        const effectiveEvidence = {
          ...evidence,
          location: effectiveLocation,
          bestAccuracyMeters,
        };
        latestEvidenceRef.current = {
          sampleCount: effectiveEvidence.sampleCount,
          sampleWindowMs: effectiveEvidence.sampleWindowMs,
          bestAccuracyMeters: effectiveEvidence.bestAccuracyMeters,
        };
        setGpsEvidence(
          `GPS lock: ${effectiveEvidence.sampleCount} samples / ${Math.max(
            1,
            Math.round(effectiveEvidence.sampleWindowMs / 1000)
          )}s | best +/-${effectiveEvidence.bestAccuracyMeters ?? "?"}m | avg +/-${
            effectiveEvidence.averageAccuracyMeters ?? "?"
          }m${
            isAhmedabadOfficeLockUser ? " | office-pinned" : ""
          }`
        );
        await handleLocationUpdate(effectiveEvidence.location, options);
        return effectiveEvidence;
      } catch {
        let fallbackLocation: LocationObject | null = null;
        try {
          fallbackLocation = await ExpoLocation.getCurrentPositionAsync({
            accuracy: strict ? ExpoLocation.Accuracy.Balanced : ExpoLocation.Accuracy.Low,
            mayShowUserSettingsDialog: true,
          });
        } catch {
          // fall through to last-known fallback
        }

        if (!fallbackLocation) {
          fallbackLocation = await ExpoLocation.getLastKnownPositionAsync({
            maxAge: 20 * 60 * 1000,
            requiredAccuracy: strict ? 450 : 1200,
          });
        }

        if (fallbackLocation) {
          const effectiveFallbackLocation = applyAhmedabadOfficeLocationLock(fallbackLocation);
          const fallbackAccuracy =
            typeof effectiveFallbackLocation.coords.accuracy === "number" &&
            Number.isFinite(effectiveFallbackLocation.coords.accuracy)
              ? Math.round(effectiveFallbackLocation.coords.accuracy)
              : null;
          latestEvidenceRef.current = {
            sampleCount: 1,
            sampleWindowMs: 0,
            bestAccuracyMeters: fallbackAccuracy,
          };
          setGpsEvidence(
            `GPS fallback: ${
              fallbackAccuracy !== null ? `+/-${fallbackAccuracy}m` : "accuracy unknown"
            }${isAhmedabadOfficeLockUser ? " | office-pinned" : ""}`
          );
          await handleLocationUpdate(effectiveFallbackLocation, options);
          return {
            location: effectiveFallbackLocation,
            sampleCount: 1,
            sampleWindowMs: 0,
            averageAccuracyMeters: fallbackAccuracy,
            bestAccuracyMeters: fallbackAccuracy,
          };
        }

        latestEvidenceRef.current = null;
        setGpsEvidence("");
        setLocationReady(false);
        setEvaluation({
          inside: false,
          insideConfirmed: false,
          activeZone: null,
          nearestDistanceMeters: Number.POSITIVE_INFINITY,
          confidenceBufferMeters: 15,
          distanceFromBoundaryMeters: Number.NEGATIVE_INFINITY,
          signalWeak: true,
          warning: "Unable to fetch current GPS location",
        });
        return null;
      }
    },
    [applyAhmedabadOfficeLocationLock, handleLocationUpdate, isAhmedabadOfficeLockUser]
  );

  const beginTracking = useCallback(async () => {
    if (!user?.id) return;
    if (locationWatchRef.current || heartbeatRef.current) return;
    try {
      locationWatchRef.current = await startSignificantLocationTracking(handleLocationUpdate, {
        timeIntervalMs: TRACKING_TIME_INTERVAL_MS,
        distanceIntervalMeters: TRACKING_DISTANCE_INTERVAL_METERS,
      });
    } catch {
      // watch fallback: periodic polling only
    }
    if (!heartbeatRef.current) {
      heartbeatRef.current = setInterval(() => {
        void refreshLocation().catch(() => {
          // keep heartbeat alive even if one refresh attempt fails
        });
      }, LOCATION_REFRESH_MS);
    }
  }, [handleLocationUpdate, refreshLocation, user?.id]);

  const stopTracking = useCallback(() => {
    locationWatchRef.current?.remove();
    locationWatchRef.current = null;
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    void loadBaseData();
    void loadGeofenceAssignments();
    void flushAttendanceQueue();
  }, [loadBaseData, loadGeofenceAssignments, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const shouldTrackLive = checkedInState || !locationReady;
    if (shouldTrackLive) {
      void refreshLocation();
      void beginTracking();
    } else {
      stopTracking();
    }
    return () => {
      stopTracking();
    };
  }, [
    beginTracking,
    checkedInState,
    refreshLocation,
    stopTracking,
    user?.id,
  ]);

  const requestPermissions = useCallback(async () => {
    setPermissionLoading(true);
    try {
      const locationPermission = await requestLocationPermissionBundle({ requireBackground: true });
      if (!locationPermission.foreground) {
        if (!locationPermission.foregroundCanAskAgain) {
          showPermissionBlockedAlert();
        } else {
          Alert.alert(
            "Location Required",
            "Foreground location permission is mandatory for secure attendance."
          );
        }
        return;
      }

      const gpsEnabled = await ensureLocationServicesEnabled();
      if (!gpsEnabled) {
        Alert.alert(
          "Turn On GPS",
          "Please enable device location services, then tap Grant Permissions again."
        );
        return;
      }

      setPermissionExplainerOpen(false);
      const strictLocation = await refreshLocation(true);
      if (!strictLocation) {
        Alert.alert("Location Unavailable", "Could not fetch live GPS location. Please try again.");
      }
    } finally {
      setPermissionLoading(false);
    }
  }, [refreshLocation, showPermissionBlockedAlert]);

  const animateSuccess = useCallback(() => {
    successScale.value = withSequence(withTiming(1.04, { duration: 140 }), withTiming(1, { duration: 160 }));
  }, [successScale]);

  const triggerPostCheckInServices = useCallback(() => {
    const jobs: Promise<unknown>[] = [flushAttendanceQueue(), beginTracking(), refreshLocation()];
    void Promise.allSettled(jobs);
  }, [beginTracking, refreshLocation]);

  const submitAttendance = useCallback(
    async (type: "checkin" | "checkout") => {
      if (!user?.id) return;
      setActionLoading(true);
      try {
        const biometricRequired = true;
        let biometricVerified = false;
        let biometricType: string | null = null;
        let biometricFailureReason: string | null = null;

        const preCaptureEvidence = await refreshLocation(false, { skipRoutePersistence: true });
        if (!preCaptureEvidence) {
          Alert.alert("Location Unavailable", "Unable to fetch live GPS location. Please try again.");
          return;
        }

        if (biometricRequired) {
          const biometricResult = await verifyBiometricForAttendance(type, {
            userId: user.id,
            // Always ask biometric for each action (check-in and check-out).
            enforceDaily: false,
          });
          biometricType = biometricResult.method;
          biometricVerified = biometricResult.success;
          if (!biometricResult.success) {
            biometricFailureReason =
              biometricResult.errorMessage || biometricResult.errorCode || "Biometric verification failed";
            await addAttendanceAnomaly({
              id: `anomaly_${Date.now()}`,
              userId: user.id,
              attendanceId: null,
              type: "biometric_failed",
              severity: "high",
              details: `${type.toUpperCase()} blocked: ${biometricFailureReason}`,
              createdAt: new Date().toISOString(),
            });
            const canOpenSecuritySettings =
              biometricResult.errorCode === "passcode_not_set" ||
              biometricResult.errorCode === "not_enrolled" ||
              biometricResult.errorCode === "not_available";
            Alert.alert("Identity Verification Failed", biometricFailureReason, [
              { text: "Cancel", style: "cancel" },
              ...(canOpenSecuritySettings
                ? [{ text: "Open Settings", onPress: openAppSettings }]
                : []),
            ]);
            return;
          }
        }

        if (type === "checkin") {
          // Start location tracking immediately after successful fingerprint verification.
          void Promise.allSettled([beginTracking(), refreshLocation()]);
        }

        const postCaptureEvidence = preCaptureEvidence;
        const postCaptureLocation = postCaptureEvidence.location;

        const finalEvaluation = evaluateGeofenceStatus(
          geofences,
          postCaptureLocation.coords.latitude,
          postCaptureLocation.coords.longitude,
          postCaptureLocation.coords.accuracy ?? undefined
        );
        const finalZoneName = finalEvaluation.activeZone?.name ?? "Unassigned Zone";

        const security = await getClientSecurityStatus(isMockLocation(postCaptureLocation));
        const capturedAtClient = new Date().toISOString();
        const accuracyMeters = postCaptureLocation.coords.accuracy;
        const roundedAccuracyMeters =
          typeof accuracyMeters === "number" && Number.isFinite(accuracyMeters)
            ? Math.round(accuracyMeters)
            : null;
        const metadataNote = [
          `GPS ${postCaptureLocation.coords.latitude.toFixed(5)}, ${postCaptureLocation.coords.longitude.toFixed(5)}`,
          roundedAccuracyMeters === null ? "accuracy:unknown" : `+/-${roundedAccuracyMeters}m`,
          capturedAtClient,
          finalZoneName,
          biometricRequired && biometricVerified
            ? `Identity:${biometricType || "verified"}`
            : "Identity:optional_or_off",
        ].join(" | ");
        const payload = {
          userId: user.id,
          userName: user.name,
          latitude: postCaptureLocation.coords.latitude,
          longitude: postCaptureLocation.coords.longitude,
          geofenceId: finalEvaluation.activeZone?.id ?? null,
          geofenceName: finalZoneName,
          photoBase64: null,
          photoMimeType: null,
          photoType: type,
          deviceId: security.deviceId,
          isInsideGeofence: isConfirmedInsideZone(finalEvaluation),
          notes: metadataNote,
          mockLocationDetected: security.mockLocationSuspected,
          locationAccuracyMeters: postCaptureLocation.coords.accuracy ?? null,
          capturedAtClient,
          photoCapturedAt: null,
          geofenceDistanceMeters: finalEvaluation.nearestDistanceMeters,
          faceDetected: false,
          faceCount: null,
          faceDetector: null,
          locationSampleCount: postCaptureEvidence.sampleCount,
          locationSampleWindowMs: postCaptureEvidence.sampleWindowMs,
          biometricRequired,
          biometricVerified,
          biometricType,
          biometricFailureReason,
        } as const;

        let record: AttendanceRecord;
        try {
          record = type === "checkin" ? await attendanceCheckIn(payload) : await attendanceCheckOut(payload);
        } catch {
          await queueAttendanceRequest({ type, payload });
          record = makeLocalAttendanceRecord(
            user.id,
            user.name,
            type,
            payload.latitude,
            payload.longitude,
            finalEvaluation,
            null,
            payload.deviceId,
            payload.notes
          );
          await addAttendanceAnomaly({
            id: `anomaly_${Date.now()}`,
            userId: user.id,
            attendanceId: record.id,
            type: "offline_backfill",
            severity: "medium",
            details: `${type.toUpperCase()} queued after API sync fallback`,
            createdAt: new Date().toISOString(),
          });
        }

        // Attendance approvals are disabled; onboarding approval already happens at signup request stage.
        const requiresApproval = false;
        const approvalAwareRecord: AttendanceRecord = {
          ...record,
          approvalStatus: requiresApproval ? "pending" : "approved",
          approvalReviewedById: requiresApproval ? null : user.id,
          approvalReviewedByName: requiresApproval ? null : user.name,
          approvalReviewedAt: requiresApproval ? null : new Date().toISOString(),
          approvalComment: null,
        };

        await addAttendance(approvalAwareRecord);
        await setCheckedIn(type === "checkin");
        setCheckedInState(type === "checkin");
        if (type === "checkin") {
          try {
            // Seed first route point from the same check-in coordinates for admin route timeline.
            const batteryLevel = await getBatteryLevelPercent({ maxAgeMs: 0 });
            await addLocationLog({
              id: `loc_checkin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              userId: user.id,
              latitude: payload.latitude,
              longitude: payload.longitude,
              accuracy: payload.locationAccuracyMeters ?? null,
              speed: null,
              heading: null,
              batteryLevel,
              geofenceId: payload.geofenceId ?? null,
              geofenceName: payload.geofenceName ?? null,
              isInsideGeofence: payload.isInsideGeofence,
              capturedAt: capturedAtClient,
            });
            await queueLocationPoint({
              userId: user.id,
              latitude: payload.latitude,
              longitude: payload.longitude,
              accuracy: payload.locationAccuracyMeters ?? null,
              speed: null,
              heading: null,
              batteryLevel,
              capturedAt: capturedAtClient,
            });
            void flushBackgroundLocationQueue().catch(() => {
              // queue will retry sync on next heartbeat/background flush.
            });
            const seededAtMs = new Date(capturedAtClient).getTime();
            if (Number.isFinite(seededAtMs)) {
              routePersistLastAtMsRef.current = seededAtMs;
            }
          } catch {
            // Route seeding must never block attendance check-in completion.
          }
          triggerPostCheckInServices();
        }
        if (type === "checkout" && isSalespersonFieldCheckIn) {
          stopTracking();
        }
        void loadBaseData();
        if (requiresApproval) {
          Alert.alert(
            "Sign-in Submitted",
            "Your check-in was captured and is now pending manager/admin approval."
          );
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
          // ignore haptics runtime failures
        });
        animateSuccess();
      } catch (error) {
        Alert.alert("Attendance Failed", error instanceof Error ? error.message : "Unknown error");
      } finally {
        setActionLoading(false);
      }
    },
    [
      animateSuccess,
      beginTracking,
      geofences,
      isSalespersonFieldCheckIn,
      loadBaseData,
      refreshLocation,
      stopTracking,
      triggerPostCheckInServices,
      user?.id,
      user?.name,
      user?.role,
    ]
  );

  const handleSignInApproval = useCallback(
    async (attendanceId: string, status: "approved" | "rejected") => {
      if (!user?.id || !canReviewSignIns) return;
      setApprovalActionId(attendanceId);
      try {
        const updated = await updateAttendanceApproval(attendanceId, status, {
          id: user.id,
          name: user.name,
        });
        if (!updated) {
          Alert.alert("Not Found", "This sign-in request is no longer available.");
        }
        await loadBaseData();
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
          // ignore haptics runtime failures
        });
      } catch (error) {
        Alert.alert("Action Failed", error instanceof Error ? error.message : "Unable to update request.");
      } finally {
        setApprovalActionId(null);
      }
    },
    [canReviewSignIns, loadBaseData, user?.id, user?.name]
  );

  const workingHours = useMemo(() => {
    if (!records.length) return "0h 0m";
    const today = new Date().toISOString().slice(0, 10);
    const todayEntries = records
      .filter((entry) => entry.timestamp.startsWith(today))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    let minutes = 0;
    let checkInTime: Date | null = null;
    for (const entry of todayEntries) {
      if (entry.type === "checkin") {
        checkInTime = new Date(entry.timestamp);
      } else if (entry.type === "checkout" && checkInTime) {
        minutes += (new Date(entry.timestamp).getTime() - checkInTime.getTime()) / 60000;
        checkInTime = null;
      }
    }
    if (checkInTime) {
      minutes += (Date.now() - checkInTime.getTime()) / 60000;
    }
    return `${Math.max(0, Math.floor(minutes / 60))}h ${Math.max(0, Math.floor(minutes % 60))}m`;
  }, [records]);

  const bannerType: BannerType = evaluation.signalWeak ? "weak" : "inside";
  const banner = getBannerConfig(bannerType, colors);
  const zoneName = isSalespersonFieldCheckIn
    ? "Field Route Tracking"
    : evaluation.activeZone?.name ?? "No zone";
  const canCheckIn = locationReady;
  const canSubmitAction = locationReady;

  return (
    <AppCanvas>
      <Modal visible={permissionExplainerOpen} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Enable Secure Attendance</Text>
            <Text style={[styles.modalText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Tap Grant Permissions to allow location. Sales check-in will start live GPS route tracking with battery level."
                : "Tap Grant Permissions to allow location. Secure check-in uses fingerprint verification and starts live location tracking."}
            </Text>
            <Pressable
              style={[styles.modalButton, { backgroundColor: colors.primary, opacity: permissionLoading ? 0.86 : 1 }]}
              onPress={requestPermissions}
              disabled={permissionLoading}
            >
              {permissionLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.modalButtonText}>Grant Permissions</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={autoPromptVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              You arrived at {zoneName}
            </Text>
            <Text style={[styles.modalText, { color: colors.textSecondary }]}>
              Check in now to record geo-verified attendance.
            </Text>
            <View style={styles.modalRow}>
              <Pressable
                style={[styles.modalGhostButton, { borderColor: colors.border }]}
                onPress={() => setAutoPromptVisible(false)}
              >
                <Text style={[styles.modalGhostText, { color: colors.textSecondary }]}>Later</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, { backgroundColor: colors.primary, flex: 1 }]}
                onPress={() => {
                  setAutoPromptVisible(false);
                  void submitAttendance("checkin");
                }}
              >
                <Text style={styles.modalButtonText}>Check In</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Secure Attendance</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {isSalespersonFieldCheckIn
            ? `${company?.name || "Company"} time-based check-in with live GPS + battery tracking`
            : `${company?.name || "Company"} fingerprint-based secure check-in with live location tracking`}
        </Text>
        {isAhmedabadOfficeLockUser ? (
          <Text style={[styles.gpsEvidenceText, { color: colors.success }]}>
            Ahmedabad demo account is pinned to office location for biometric testing.
          </Text>
        ) : null}

        <View style={[styles.banner, { backgroundColor: banner.bg, borderColor: banner.border }]}>
          <Ionicons name={banner.icon as never} size={18} color={banner.text} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerText, { color: banner.text }]}>{banner.label}</Text>
            <Text style={[styles.bannerSubText, { color: colors.textSecondary }]}>
              {isSalespersonFieldCheckIn
                ? "Route and battery tracking will start automatically after check-in."
                : "Live route and battery tracking starts immediately after fingerprint verification."}
            </Text>
          </View>
          {gpsLoading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
        </View>
        {gpsEvidence ? (
          <Text style={[styles.gpsEvidenceText, { color: colors.textSecondary }]}>{gpsEvidence}</Text>
        ) : null}

        <View style={styles.statRow}>
          <View style={[styles.statCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.statValue, { color: colors.text }]}>{workingHours}</Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Today&apos;s Hours</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.statValue, { color: colors.text }]}>{zoneName}</Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Live Zone</Text>
          </View>
        </View>

        <Animated.View style={pulseStyle}>
          <Pressable
            disabled={actionLoading || permissionLoading || permissionExplainerOpen || !canSubmitAction}
            onPress={() => void submitAttendance(checkedInState ? "checkout" : "checkin")}
            style={({ pressed }) => [{ opacity: pressed || actionLoading ? 0.88 : 1 }]}
          >
            <LinearGradient
              colors={
                checkedInState
                  ? isDark
                    ? ["#7f1d1d", "#b91c1c"]
                    : ["#ef4444", "#dc2626"]
                  : isDark
                    ? ["#0b4f6c", "#1d4ed8"]
                    : [colors.heroStart, colors.heroEnd]
              }
              style={styles.actionButton}
            >
              {actionLoading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons
                    name={checkedInState ? "log-out-outline" : "log-in-outline"}
                    size={24}
                    color="#fff"
                  />
                  <Text style={styles.actionText}>{checkedInState ? "Secure Check-Out" : "Secure Check-In"}</Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>

        {!checkedInState && !canCheckIn ? (
          <Text style={[styles.helperWarning, { color: colors.danger }]}>
            Wait for location to be ready, then verify your fingerprint to complete secure check-in.
          </Text>
        ) : null}

        {canReviewSignIns ? (
          <View style={styles.approvalSection}>
            <View style={styles.approvalHeaderRow}>
              <Text style={[styles.logsTitle, { color: colors.text, marginTop: 4, marginBottom: 0 }]}>
                Pending Sign-ins
              </Text>
              <View style={[styles.approvalCountChip, { backgroundColor: colors.warning + "1A" }]}>
                <Text style={[styles.approvalCountText, { color: colors.warning }]}>
                  {pendingSignIns.length}
                </Text>
              </View>
            </View>
            <View style={[styles.logList, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {pendingSignIns.length === 0 ? (
                <View style={styles.emptyLog}>
                  <Ionicons name="checkmark-done-outline" size={20} color={colors.success} />
                  <Text style={[styles.emptyLogText, { color: colors.textSecondary }]}>
                    No pending sign-in approvals.
                  </Text>
                </View>
              ) : (
                pendingSignIns.slice(0, 8).map((entry, idx) => {
                  const busy = approvalActionId === entry.id;
                  const locationLabel = entry.location
                    ? `${entry.location.lat.toFixed(5)}, ${entry.location.lng.toFixed(5)}`
                    : "Location unavailable";
                  return (
                    <View
                      key={`approval_${entry.id}`}
                      style={[
                        styles.approvalItemRow,
                        idx < Math.min(pendingSignIns.length, 8) - 1 && {
                          borderBottomWidth: 1,
                          borderBottomColor: colors.borderLight,
                        },
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.logType, { color: colors.text }]}>{entry.userName}</Text>
                        <Text style={[styles.logMeta, { color: colors.textSecondary }]}>
                          {entry.geofenceName ?? locationLabel} -{" "}
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </Text>
                      </View>
                      <View style={styles.approvalActionsRow}>
                        <Pressable
                          style={[
                            styles.approvalRejectButton,
                            { borderColor: colors.danger, opacity: busy ? 0.65 : 1 },
                          ]}
                          onPress={() => void handleSignInApproval(entry.id, "rejected")}
                          disabled={Boolean(approvalActionId)}
                        >
                          {busy ? (
                            <ActivityIndicator size="small" color={colors.danger} />
                          ) : (
                            <Text style={[styles.approvalRejectText, { color: colors.danger }]}>
                              Reject
                            </Text>
                          )}
                        </Pressable>
                        <Pressable
                          style={[
                            styles.approvalApproveButton,
                            { backgroundColor: colors.success, opacity: busy ? 0.65 : 1 },
                          ]}
                          onPress={() => void handleSignInApproval(entry.id, "approved")}
                          disabled={Boolean(approvalActionId)}
                        >
                          {busy ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={styles.approvalApproveText}>Accept</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          </View>
        ) : null}

        <Text style={[styles.logsTitle, { color: colors.text }]}>{todayHeading}</Text>
        <View style={[styles.logList, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          {records.length === 0 ? (
            <View style={styles.emptyLog}>
              <Ionicons name="time-outline" size={20} color={colors.textTertiary} />
              <Text style={[styles.emptyLogText, { color: colors.textSecondary }]}>No records yet today</Text>
            </View>
          ) : (
            records.slice(0, 8).map((entry, idx) => {
              const approvalState = entry.type === "checkin" ? entry.approvalStatus ?? "approved" : null;
              const approvalLabel =
                approvalState === "pending"
                  ? "Pending approval"
                  : approvalState === "rejected"
                    ? "Rejected"
                    : approvalState === "approved"
                      ? "Approved"
                      : null;
              return (
                <View
                  key={entry.id}
                  style={[
                    styles.logRow,
                    idx < Math.min(records.length, 8) - 1 && { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
                  ]}
                >
                  <View
                    style={[
                      styles.logDot,
                      { backgroundColor: entry.type === "checkin" ? colors.success : colors.danger },
                    ]}
                  />
                  <View style={{ flex: 1 }}>
                    {(() => {
                      const locationLabel = entry.location
                        ? `${entry.location.lat.toFixed(5)}, ${entry.location.lng.toFixed(5)}`
                        : "Location unavailable";
                      return (
                        <>
                          <Text style={[styles.logType, { color: colors.text }]}>
                            {entry.type === "checkin" ? "Check In" : "Check Out"}
                          </Text>
                          <Text style={[styles.logMeta, { color: colors.textSecondary }]}>
                            {entry.geofenceName ?? locationLabel} -{" "}
                            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            {approvalLabel ? ` | ${approvalLabel}` : ""}
                          </Text>
                        </>
                      );
                    })()}
                  </View>
                  <Ionicons
                    name={entry.isInsideGeofence ? "shield-checkmark" : "alert-circle"}
                    size={16}
                    color={entry.isInsideGeofence ? colors.success : colors.warning}
                  />
                </View>
              );
            })
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 20,
  },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 10,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 4,
    marginBottom: 14,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  banner: {
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    marginBottom: 12,
  },
  bannerText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  bannerSubText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 1,
  },
  gpsEvidenceText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: -6,
    marginBottom: 10,
  },
  statRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 14,
  },
  statCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  statValue: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  statLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  actionButton: {
    borderRadius: 18,
    minHeight: 64,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 10,
    boxShadow: "0px 16px 30px rgba(0,0,0,0.18)",
  },
  actionText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  helperWarning: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: 10,
    marginBottom: 6,
  },
  approvalSection: {
    marginTop: 12,
    marginBottom: 4,
    gap: 10,
  },
  approvalHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  approvalCountChip: {
    minWidth: 34,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 9,
  },
  approvalCountText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  approvalItemRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  approvalActionsRow: {
    flexDirection: "row",
    gap: 8,
  },
  approvalRejectButton: {
    minWidth: 72,
    minHeight: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  approvalApproveButton: {
    minWidth: 72,
    minHeight: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  approvalRejectText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  approvalApproveText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  logsTitle: {
    marginTop: 16,
    marginBottom: 10,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  logList: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  logRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  logType: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  logMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
    marginTop: 2,
  },
  emptyLog: {
    padding: 22,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  emptyLogText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderBottomWidth: 0,
    padding: 18,
    gap: 12,
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  modalText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  modalButton: {
    borderRadius: 12,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  modalRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  modalGhostButton: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalGhostText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
});

