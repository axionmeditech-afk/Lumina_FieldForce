import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { router, useIsFocused } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { getAttendanceStatus, getCompanyAttendanceToday } from "@/lib/attendance-api";
import { isSystemAdministratorAccount } from "@/lib/attendance-roster";
import { formatMumbaiDateKey, formatMumbaiTime, toMumbaiDateKey } from "@/lib/ist-time";
import { getAttendance } from "@/lib/storage";
import type { AttendanceRecord } from "@/lib/types";

type DashboardSnapshot = {
  records: AttendanceRecord[];
  active: AttendanceRecord | null;
  companyRecords: AttendanceRecord[];
  syncedAt: string;
};

type MetricCard = {
  id: string;
  label: string;
  value: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: string;
};

type ActionCard = {
  id: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: string;
  route: "/(tabs)/attendance" | "/(tabs)/account";
};

const SUPERVISOR_ROLES = new Set(["admin", "hr", "manager"]);
const SUPERVISOR_REFRESH_MS = 45_000;
const EMPLOYEE_REFRESH_MS = 90_000;
const MIN_REFRESH_GAP_MS = 12_000;

function getUserInitials(name?: string | null): string {
  const parts = (name || "LF")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "LF";
}

function formatRole(role?: string | null): string {
  if (!role) return "Employee";
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLatestByUser(records: AttendanceRecord[]): Map<string, AttendanceRecord> {
  const latest = new Map<string, AttendanceRecord>();
  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const record of sorted) latest.set(record.userId, record);
  return latest;
}

function getActiveAttendanceForUser(records: AttendanceRecord[], userId?: string): AttendanceRecord | null {
  if (!userId) return null;
  const latest = records
    .filter((record) => record.userId === userId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return latest?.type === "checkin" ? latest : null;
}

function getTodayCompanyRecords(records: AttendanceRecord[], companyId?: string | null): AttendanceRecord[] {
  const today = toMumbaiDateKey(new Date());
  return records.filter((record) => {
    if (toMumbaiDateKey(record.timestamp) !== today) return false;
    if (!companyId) return true;
    return !record.companyId || record.companyId === companyId;
  });
}

function isRecordForCompany(record: AttendanceRecord | null | undefined, companyId?: string | null): boolean {
  if (!record || !companyId) return true;
  return !record.companyId || record.companyId === companyId;
}

function formatRecordTitle(record: AttendanceRecord, ownUserId?: string): string {
  const actor = record.userId === ownUserId ? "You" : record.userName || "Employee";
  return `${actor} ${record.type === "checkin" ? "checked in" : "checked out"}`;
}

function formatRecordSubtitle(record: AttendanceRecord): string {
  const zone = record.geofenceName?.trim() || "Office geofence";
  const locationState = record.isInsideGeofence === false ? "outside geofence" : "verified";
  return `${zone} - ${locationState} at ${formatMumbaiTime(record.timestamp)}`;
}

export default function Dashboard() {
  const { user, company } = useAuth();
  const { colors, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const busyRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const hasSnapshotRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);

  const isSupervisor = SUPERVISOR_ROLES.has(user?.role || "");
  const isSuperAdminAttendanceExempt = user ? isSystemAdministratorAccount(user) : false;
  const activeCompanyId = company?.id || "";
  const todayKey = toMumbaiDateKey(new Date());
  const todayLabel = formatMumbaiDateKey(todayKey);

  const hydrateFromCache = useCallback(async () => {
    if (!user) return;
    try {
      const cachedRecords = await getAttendance();
      setSnapshot((current) => {
        const ownRecords = cachedRecords
          .filter((record) => record.userId === user.id)
          .filter((record) => isRecordForCompany(record, activeCompanyId));
        const cachedActive = getActiveAttendanceForUser(cachedRecords, user.id);
        hasSnapshotRef.current = true;
        return {
          records: ownRecords,
          active: isRecordForCompany(cachedActive, activeCompanyId)
            ? cachedActive
            : null,
          companyRecords: isSupervisor ? getTodayCompanyRecords(cachedRecords, activeCompanyId) : [],
          syncedAt: current?.syncedAt || "Cached",
        };
      });
    } catch {
      // Cache hydration is best-effort; network refresh still runs.
    }
  }, [activeCompanyId, isSupervisor, user]);

  const refresh = useCallback(async (force = false) => {
    if (!user || busyRef.current || AppState.currentState !== "active") return;
    if (!force && Date.now() - lastRefreshAtRef.current < MIN_REFRESH_GAP_MS) return;
    busyRef.current = true;
    lastRefreshAtRef.current = Date.now();
    setBusy(force || !hasSnapshotRef.current);
    try {
      const [status, companyRecords] = await Promise.all([
        getAttendanceStatus(),
        isSupervisor ? getCompanyAttendanceToday(activeCompanyId) : Promise.resolve([]),
      ]);
      const scopedRecords = activeCompanyId
        ? status.records.filter((record) => isRecordForCompany(record, activeCompanyId))
        : status.records;
      const scopedActive = isRecordForCompany(status.active, activeCompanyId) ? status.active : null;
      const nextSnapshot = {
        records: scopedRecords,
        active: scopedActive,
        companyRecords,
        syncedAt: formatMumbaiTime(new Date(), { includeZoneLabel: true }),
      };
      hasSnapshotRef.current = true;
      setSnapshot(nextSnapshot);
      setError("");
    } catch (event) {
      setError(event instanceof Error ? event.message : "Unable to refresh attendance");
      if (!hasSnapshotRef.current) void hydrateFromCache();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [activeCompanyId, hydrateFromCache, isSupervisor, user]);

  useEffect(() => {
    if (!focused) return;
    const initialTimer = setTimeout(() => {
      void hydrateFromCache();
      void refresh();
    }, 0);
    const timer = setInterval(() => {
      void refresh();
    }, isSupervisor ? SUPERVISOR_REFRESH_MS : EMPLOYEE_REFRESH_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void hydrateFromCache();
        void refresh();
      }
    });
    return () => {
      clearTimeout(initialTimer);
      clearInterval(timer);
      subscription.remove();
    };
  }, [focused, hydrateFromCache, isSupervisor, refresh]);

  const teamLatest = useMemo(
    () => getLatestByUser(snapshot?.companyRecords || []),
    [snapshot?.companyRecords],
  );
  const ownRecords = snapshot?.records || [];
  const visibleRecords = isSupervisor && snapshot?.companyRecords.length
    ? snapshot.companyRecords
    : ownRecords;
  const latestActivity = useMemo(
    () => [...visibleRecords].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5),
    [visibleRecords],
  );

  const checkedInNow = useMemo(
    () => [...teamLatest.values()].filter((record) => record.type === "checkin").length,
    [teamLatest],
  );
  const checkedOutToday = useMemo(
    () => [...teamLatest.values()].filter((record) => record.type === "checkout").length,
    [teamLatest],
  );
  const verifiedToday = useMemo(
    () => visibleRecords.filter((record) => record.isInsideGeofence !== false).length,
    [visibleRecords],
  );

  const heroInsights = useMemo(() => {
    const ownStatus = snapshot?.active ? "Checked in" : snapshot ? "Checked out" : "Loading";
    if (isSuperAdminAttendanceExempt) {
      return [
        { id: "owner", label: "My status", value: "Owner" },
        { id: "team", label: "Team active", value: snapshot ? String(checkedInNow) : "--" },
        { id: "verified", label: "Verified logs", value: snapshot ? String(verifiedToday) : "--" },
      ];
    }
    if (isSupervisor) {
      return [
        { id: "status", label: "My status", value: ownStatus },
        { id: "team", label: "Team active", value: snapshot ? String(checkedInNow) : "--" },
        { id: "verified", label: "Team logs", value: snapshot ? String(verifiedToday) : "--" },
      ];
    }
    return [
      { id: "status", label: "My status", value: ownStatus },
      { id: "office", label: "Office zone", value: snapshot?.active?.geofenceName || company?.attendanceZoneLabel || "--" },
      { id: "sync", label: "Last sync", value: snapshot?.syncedAt || "--" },
    ];
  }, [
    checkedInNow,
    checkedOutToday,
    company?.attendanceZoneLabel,
    isSupervisor,
    isSuperAdminAttendanceExempt,
    snapshot,
    verifiedToday,
  ]);

  const metricCards = useMemo<MetricCard[]>(() => {
    if (isSuperAdminAttendanceExempt) {
      return [
        {
          id: "owner",
          label: "Owner Mode",
          value: "Owner",
          hint: "Attendance is not required for the workspace owner",
          icon: "shield-checkmark-outline",
          tone: colors.primary,
        },
        {
          id: "active",
          label: "Active Now",
          value: snapshot ? String(checkedInNow) : "--",
          hint: "Employees currently checked in",
          icon: "radio-button-on-outline",
          tone: colors.success,
        },
        {
          id: "logs",
          label: "Team Logs",
          value: snapshot ? String(snapshot.companyRecords.length) : "--",
          hint: `Records for ${todayLabel}`,
          icon: "document-text-outline",
          tone: colors.warning,
        },
      ];
    }
    if (isSupervisor) {
      return [
        {
          id: "status",
          label: "My Status",
          value: snapshot?.active ? "IN" : snapshot ? "OUT" : "--",
          hint: snapshot?.active?.geofenceName || "Your own attendance is required",
          icon: "finger-print-outline",
          tone: snapshot?.active ? colors.success : colors.textTertiary,
        },
        {
          id: "active",
          label: "Active Now",
          value: snapshot ? String(checkedInNow) : "--",
          hint: "Employees currently checked in",
          icon: "radio-button-on-outline",
          tone: colors.success,
        },
        {
          id: "logs",
          label: "Attendance Logs",
          value: snapshot ? String(snapshot.companyRecords.length) : "--",
          hint: `Records for ${todayLabel}`,
          icon: "document-text-outline",
          tone: colors.primary,
        },
        {
          id: "geo",
          label: "Geofence Verified",
          value: snapshot ? String(verifiedToday) : "--",
          hint: "Accepted inside-office evidence",
          icon: "shield-checkmark-outline",
          tone: colors.warning,
        },
      ];
    }
    return [
      {
        id: "status",
        label: "Current Status",
        value: snapshot?.active ? "IN" : snapshot ? "OUT" : "--",
        hint: snapshot?.active?.geofenceName || "Open attendance to verify location",
        icon: "finger-print-outline",
        tone: snapshot?.active ? colors.success : colors.textTertiary,
      },
      {
        id: "today",
        label: "Today's Logs",
        value: snapshot ? String(snapshot.records.length) : "--",
        hint: "Confirmed server records",
        icon: "time-outline",
        tone: colors.primary,
      },
      {
        id: "sync",
        label: "Sync Health",
        value: error ? "Issue" : "Live",
        hint: error ? "Showing last confirmed data" : snapshot?.syncedAt || "Waiting for sync",
        icon: error ? "warning-outline" : "cloud-done-outline",
        tone: error ? colors.danger : colors.success,
      },
    ];
  }, [
    checkedInNow,
    colors,
    error,
    isSupervisor,
    isSuperAdminAttendanceExempt,
    snapshot,
    todayLabel,
    verifiedToday,
  ]);

  const actions = useMemo<ActionCard[]>(
    () => [
      {
        id: "attendance",
        title: "Attendance & Geofencing",
        subtitle: "Check in, check out, office boundary status",
        icon: "location-outline",
        tone: colors.primary,
        route: "/(tabs)/attendance",
      },
      {
        id: "account",
        title: user?.role === "admin" ? "Account & Access" : "Account",
        subtitle: user?.role === "admin" ? "Employee access approvals" : "Profile and session controls",
        icon: "person-circle-outline",
        tone: colors.secondary,
        route: "/(tabs)/account",
      },
    ],
    [colors.primary, colors.secondary, user?.role],
  );

  return (
    <AppCanvas>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh(true)} tintColor={colors.primary} />}
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: 0,
            paddingBottom: Math.max(insets.bottom, 20) + 28,
          },
        ]}
      >
        <View style={styles.heroWrap}>
          <LinearGradient
            colors={isDark ? ["#182338", "#111A2F", "#0E1628"] : ["#FFFFFF", "#FBFAFF", "#F6F8FF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.heroCard, { paddingTop: insets.top + 10 }]}
          >
            <LinearGradient
              pointerEvents="none"
              colors={isDark ? ["rgba(59,130,246,0.28)", "rgba(99,102,241,0.14)"] : ["#6A63FF", "#2FA3F6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.9 }}
              style={styles.heroTopCap}
            />

            <View style={styles.heroHeaderRow}>
              <DrawerToggleButton iconColor="#FFFFFF" iconSize={34} style={styles.menuButton} />
              <View style={styles.heroDateChip}>
                <Ionicons name="calendar-outline" size={13} color="#E8F4FF" />
                <Text style={styles.heroDateText}>{todayLabel}</Text>
              </View>
            </View>

            <View style={styles.heroProfileStack}>
              <Pressable
                onPress={() => router.push("/(tabs)/account")}
                style={[
                  styles.heroAvatarWrap,
                  {
                    backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#FFFFFF",
                    borderColor: isDark ? "rgba(255,255,255,0.14)" : "rgba(15, 23, 42, 0.06)",
                  },
                ]}
              >
                {user?.avatar ? (
                  <Image source={{ uri: user.avatar }} style={styles.heroAvatarImage} />
                ) : (
                  <Text style={[styles.heroAvatarFallback, { color: colors.text }]}>
                    {getUserInitials(user?.name)}
                  </Text>
                )}
              </Pressable>
              <Text style={[styles.heroGreetingText, { color: isDark ? "#8FB9FF" : colors.textTertiary }]}>
                {formatRole(user?.role)} Dashboard
              </Text>
              <Text style={[styles.heroTitleText, { color: colors.text }]} numberOfLines={1}>
                {user?.name || "Lumina User"}
              </Text>
              <Text style={[styles.heroHandleText, { color: colors.textTertiary }]} numberOfLines={1}>
                {company?.name || user?.companyName || "Lumina FieldForce"}
              </Text>
            </View>

            <View
              style={[
                styles.heroInsightRow,
                {
                  backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.72)",
                  borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(15, 23, 42, 0.06)",
                },
              ]}
            >
              {heroInsights.map((item, index) => (
                <React.Fragment key={item.id}>
                  <View style={styles.heroInsightItem}>
                    <Text style={[styles.heroInsightValue, { color: colors.text }]} numberOfLines={1}>
                      {item.value}
                    </Text>
                    <Text style={[styles.heroInsightLabel, { color: colors.textSecondary }]} numberOfLines={1}>
                      {item.label}
                    </Text>
                  </View>
                  {index < heroInsights.length - 1 ? (
                    <View
                      style={[
                        styles.heroDivider,
                        { backgroundColor: isDark ? "rgba(255,255,255,0.12)" : "rgba(15, 23, 42, 0.08)" },
                      ]}
                    />
                  ) : null}
                </React.Fragment>
              ))}
            </View>
          </LinearGradient>
        </View>

        {error ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh()}
            style={[styles.syncWarning, { borderColor: `${colors.danger}33`, backgroundColor: `${colors.danger}12` }]}
          >
            <Ionicons name="warning-outline" size={18} color={colors.danger} />
            <Text style={[styles.syncWarningText, { color: colors.danger }]}>
              Refresh failed. {snapshot ? "Showing last confirmed data. " : ""}Tap to retry.
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>
              {isSupervisor ? "Live Attendance" : "My Attendance"}
            </Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
              {isSupervisor ? "Team presence and geofence health" : "Server confirmed status and sync health"}
            </Text>
          </View>
          <Text style={[styles.lastSyncText, { color: colors.textTertiary }]}>
            {snapshot?.syncedAt || "Syncing..."}
          </Text>
        </View>

        <View style={styles.metricGrid}>
          {metricCards.map((metric) => (
            <View
              key={metric.id}
              style={[
                styles.metricCard,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.backgroundElevated,
                  shadowColor: colors.cardShadow,
                },
              ]}
            >
              <View style={[styles.metricIconWrap, { backgroundColor: `${metric.tone}17` }]}>
                <Ionicons name={metric.icon} size={21} color={metric.tone} />
              </View>
              <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>{metric.label}</Text>
              <Text style={[styles.metricValue, { color: colors.text }]} numberOfLines={1}>
                {metric.value}
              </Text>
              <Text style={[styles.metricHint, { color: colors.textTertiary }]} numberOfLines={2}>
                {metric.hint}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
              Only attendance, geofencing, and account tools
            </Text>
          </View>
        </View>

        <View style={styles.actionGrid}>
          {actions.map((action) => (
            <Pressable
              key={action.id}
              accessibilityRole="button"
              onPress={() => router.push(action.route)}
              style={({ pressed }) => [
                styles.actionCard,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.backgroundElevated,
                  opacity: pressed ? 0.82 : 1,
                  shadowColor: colors.cardShadow,
                },
              ]}
            >
              <View style={[styles.actionIconWrap, { backgroundColor: `${action.tone}16` }]}>
                <Ionicons name={action.icon} size={23} color={action.tone} />
              </View>
              <View style={styles.actionCopy}>
                <Text style={[styles.actionTitle, { color: colors.text }]}>{action.title}</Text>
                <Text style={[styles.actionSubtitle, { color: colors.textSecondary }]}>{action.subtitle}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Attendance Timeline</Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary }]}>
              {isSupervisor ? "Latest team check-in and check-out events" : "Your latest check-in and check-out events"}
            </Text>
          </View>
        </View>

        <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
          {latestActivity.length ? (
            latestActivity.map((record, index) => (
              <View
                key={record.id}
                style={[
                  styles.timelineRow,
                  index < latestActivity.length - 1 && { borderBottomColor: colors.borderLight, borderBottomWidth: 1 },
                ]}
              >
                <View
                  style={[
                    styles.timelineIcon,
                    {
                      backgroundColor: record.type === "checkin" ? `${colors.success}16` : `${colors.warning}17`,
                    },
                  ]}
                >
                  <Ionicons
                    name={record.type === "checkin" ? "log-in-outline" : "log-out-outline"}
                    size={18}
                    color={record.type === "checkin" ? colors.success : colors.warning}
                  />
                </View>
                <View style={styles.timelineCopy}>
                  <Text style={[styles.timelineTitle, { color: colors.text }]}>
                    {formatRecordTitle(record, user?.id)}
                  </Text>
                  <Text style={[styles.timelineSubtitle, { color: colors.textSecondary }]} numberOfLines={2}>
                    {formatRecordSubtitle(record)}
                  </Text>
                </View>
                <Text style={[styles.timelineTime, { color: colors.textTertiary }]}>
                  {formatMumbaiTime(record.timestamp)}
                </Text>
              </View>
            ))
          ) : (
            <View style={styles.emptyTimeline}>
              <Ionicons name="finger-print-outline" size={30} color={colors.textTertiary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No attendance yet</Text>
              <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
                Open attendance to create the first verified geofence record.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    width: "100%",
    maxWidth: 1060,
    alignSelf: "center",
    paddingHorizontal: 18,
  },
  heroWrap: {
    marginHorizontal: -18,
    marginBottom: 18,
  },
  heroCard: {
    borderRadius: 0,
    paddingHorizontal: 24,
    paddingBottom: 18,
    position: "relative",
    overflow: "hidden",
  },
  heroTopCap: {
    position: "absolute",
    top: -4,
    left: 0,
    right: 0,
    height: 146,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  heroHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginTop: 2,
    marginBottom: 6,
    gap: 8,
  },
  menuButton: {
    marginTop: 2,
  },
  heroDateChip: {
    minHeight: 36,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroDateText: {
    color: "#E8F4FF",
    fontFamily: "Inter_600SemiBold",
    fontSize: 11.8,
  },
  heroProfileStack: {
    alignItems: "center",
    marginTop: -10,
    paddingHorizontal: 6,
  },
  heroAvatarWrap: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 7,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    marginTop: -2,
    marginBottom: 8,
    shadowColor: "#0F172A",
    shadowOpacity: 0.14,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 6,
  },
  heroAvatarImage: {
    width: "100%",
    height: "100%",
  },
  heroAvatarFallback: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
  },
  heroGreetingText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    textAlign: "center",
  },
  heroTitleText: {
    marginTop: 2,
    fontFamily: "Inter_700Bold",
    fontSize: 31,
    textAlign: "center",
  },
  heroHandleText: {
    marginTop: 4,
    fontFamily: "Inter_500Medium",
    fontSize: 13.5,
    textAlign: "center",
  },
  heroInsightRow: {
    marginTop: 18,
    minHeight: 58,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  heroInsightItem: {
    flex: 1,
    alignItems: "center",
    minWidth: 0,
  },
  heroInsightValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  heroInsightLabel: {
    marginTop: 2,
    fontFamily: "Inter_500Medium",
    fontSize: 10.5,
    textTransform: "uppercase",
  },
  heroDivider: {
    width: 1,
    height: 32,
    marginHorizontal: 8,
  },
  syncWarning: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    marginBottom: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  syncWarningText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 18,
  },
  sectionHeaderRow: {
    marginTop: 4,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
  },
  sectionSubtitle: {
    marginTop: 3,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  lastSyncText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 22,
  },
  metricCard: {
    flexGrow: 1,
    flexBasis: 180,
    minHeight: 154,
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  metricIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  metricLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  metricValue: {
    marginTop: 5,
    fontFamily: "Inter_700Bold",
    fontSize: 28,
  },
  metricHint: {
    marginTop: 6,
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 17,
  },
  actionGrid: {
    gap: 12,
    marginBottom: 24,
  },
  actionCard: {
    minHeight: 84,
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  actionIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  actionCopy: {
    flex: 1,
    gap: 3,
  },
  actionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 15.5,
  },
  actionSubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 17,
  },
  timelineCard: {
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 22,
  },
  timelineRow: {
    minHeight: 82,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  timelineIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  timelineCopy: {
    flex: 1,
    gap: 3,
  },
  timelineTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 14.5,
  },
  timelineSubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 17,
  },
  timelineTime: {
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
  },
  emptyTimeline: {
    padding: 26,
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  emptyBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});
