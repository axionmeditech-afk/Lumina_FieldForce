import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Modal,
  TextInput,
  Switch,
  ActivityIndicator,
  RefreshControl,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import Animated, {
  FadeInDown,
  FadeInUp,
  ZoomIn,
  SlideInRight,
  FadeIn,
  Layout,
  withSpring,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  interpolateColor,
} from "react-native-reanimated";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { CalendarModal } from "@/components/CalendarModal";
import { canApproveLeaves } from "@/lib/role-access";
import type { LeaveRequest, LeaveSummary, LeaveType, PublicHoliday } from "@/lib/types";
import {
  listLeaveRequestsRemote,
  createLeaveRequestRemote,
  updateLeaveRequestStatusRemote,
  deleteLeaveRequestRemote,
  getLeavesSummaryRemote,
  getPublicHolidaysRemote,
  addPublicHolidayRemote,
  deletePublicHolidayRemote,
  getWeekendConfigRemote,
  saveWeekendConfigRemote,
  getUsersRemote,
  createCollectiveLeaveRemote,
} from "@/lib/attendance-api";
import { LeaveCalendar } from "@/components/LeaveCalendar";

// ─── Constants ──────────────────────────────────────────────────────
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3));
const { width: SCREEN_W } = Dimensions.get("window");

type TabKey = "my" | "pending" | "summary";

// ─── Palette ────────────────────────────────────────────────────────
const P = {
  blue: "#2563EB",
  blueLight: "#3B82F6",
  blueSoft: "#DBEAFE",
  orange: "#EA580C",
  orangeLight: "#F97316",
  orangeSoft: "#FFF7ED",
  emerald: "#059669",
  emeraldLight: "#10B981",
  emeraldSoft: "#D1FAE5",
  rose: "#E11D48",
  roseLight: "#F43F5E",
  roseSoft: "#FFE4E6",
  violet: "#7C3AED",
  violetSoft: "#EDE9FE",
  amber: "#D97706",
  amberSoft: "#FEF3C7",
  slate50: "#F8FAFC",
  slate100: "#F1F5F9",
  slate200: "#E2E8F0",
  slate400: "#94A3B8",
  slate500: "#64748B",
  slate600: "#475569",
  slate700: "#334155",
  slate800: "#1E293B",
  slate900: "#0F172A",
  white: "#FFFFFF",
};

// ─── Formatters ─────────────────────────────────────────────────────
function fmtDate(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtDateCompact(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}

function fmtRelative(dateStr: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return "Yesterday";
    if (diffD < 7) return `${diffD}d ago`;
    return fmtDate(dateStr.slice(0, 10));
  } catch {
    return "";
  }
}

// ─── Status helpers ─────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; icon: string; fg: string; bg: string }> = {
  pending: { label: "Pending", icon: "time-outline", fg: "#D97706", bg: "#FEF3C720" },
  approved: { label: "Approved", icon: "checkmark-circle", fg: "#059669", bg: "#D1FAE520" },
  rejected: { label: "Rejected", icon: "close-circle", fg: "#E11D48", bg: "#FFE4E620" },
};

const TYPE_CONFIG: Record<string, { label: string; icon: string; fg: string; bg: string; accent: string }> = {
  planned: { label: "Planned", icon: "calendar-outline", fg: "#2563EB", bg: "#DBEAFE", accent: "#2563EB" },
  unplanned: { label: "Unplanned", icon: "flash-outline", fg: "#EA580C", bg: "#FFF7ED", accent: "#EA580C" },
};

// ═══════════════════════════════════════════════════════════════════
// SCREEN
// ═══════════════════════════════════════════════════════════════════
export default function LeaveManagementScreen() {
  const { user, company } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const isPrivileged = canApproveLeaves(user?.role);

  // ─── State ──────────────────────────────────────────────────
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [summaries, setSummaries] = useState<LeaveSummary[]>([]);
  const [holidays, setHolidays] = useState<PublicHoliday[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("my");
  const [weekendDays, setWeekendDays] = useState<number[]>([0]);
  const [showWeekendModal, setShowWeekendModal] = useState(false);
  const [tempWeekendDays, setTempWeekendDays] = useState<number[]>([]);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarTarget, setCalendarTarget] = useState<"start" | "end" | "collStart" | "collEnd">("start");
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form
  const [usersList, setUsersList] = useState<any[]>([]);

  // Individual Form
  const [formStartDate, setFormStartDate] = useState("");
  const [formEndDate, setFormEndDate] = useState("");
  const [formStartAmPm, setFormStartAmPm] = useState("morning");
  const [formEndAmPm, setFormEndAmPm] = useState("afternoon");
  const [formApprovedBy, setFormApprovedBy] = useState("");
  
  // Collective Form
  const [showCollectiveModal, setShowCollectiveModal] = useState(false);
  const [collectiveUsers, setCollectiveUsers] = useState<string[]>([]);
  const [collectiveStartDate, setCollectiveStartDate] = useState("");
  const [collectiveEndDate, setCollectiveEndDate] = useState("");
  const [collectiveStartAmPm, setCollectiveStartAmPm] = useState("morning");
  const [collectiveEndAmPm, setCollectiveEndAmPm] = useState("afternoon");
  const [collectiveType, setCollectiveType] = useState("planned");
  const [collectiveApprovedBy, setCollectiveApprovedBy] = useState("");
  const [collectiveNote, setCollectiveNote] = useState("");
  const [collectiveAutoValidate, setCollectiveAutoValidate] = useState(false);

  const [formLeaveType, setFormLeaveType] = useState<LeaveType>("planned");
  const [formHalfDay, setFormHalfDay] = useState(false);
  const [formNote, setFormNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // ─── Data ───────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      setErrorMsg(null);
      const [leavesData, summaryData, holidaysData, weekendData, usersData] = await Promise.allSettled([
        listLeaveRequestsRemote({ year: currentYear }),
        getLeavesSummaryRemote({ month: currentMonth, year: currentYear }),
        getPublicHolidaysRemote(),
        getWeekendConfigRemote(),
        getUsersRemote(),
      ]);
      if (leavesData.status === "fulfilled") setLeaves(leavesData.value);
      if (summaryData.status === "fulfilled") setSummaries(summaryData.value);
      if (holidaysData.status === "fulfilled") setHolidays(holidaysData.value);
      if (weekendData.status === "fulfilled") setWeekendDays(weekendData.value.weekendDays);
      if (usersData.status === "fulfilled") setUsersList(usersData.value);
    } catch (err) {
      setErrorMsg("Unable to load leave data. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentMonth, currentYear]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchData();
  }, [fetchData]);

  // ─── Computed ───────────────────────────────────────────────
  const myLeaves = useMemo(() => leaves.filter((l) => l.userId === user?.id), [leaves, user?.id]);
  const pendingLeaves = useMemo(() => leaves.filter((l) => l.status === "pending"), [leaves]);
  const mySummary = useMemo(() => summaries.find((s) => s.userId === user?.id) || null, [summaries, user?.id]);

  const plannedCount = mySummary?.totalPlannedMonth ?? 0;
  const unplannedCount = mySummary?.totalUnplannedMonth ?? 0;
  const totalCount = mySummary?.totalLeavesMonth ?? 0;
  const pendingCount = pendingLeaves.length;
  const displayLeaves = activeTab === "my" ? myLeaves : activeTab === "pending" ? pendingLeaves : [];

  // ─── Actions ────────────────────────────────────────────────
  const handleSubmitLeave = async () => {
    if (!formStartDate) {
      Alert.alert("Date Required", "Please select a start date.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const newLeave = await createLeaveRequestRemote({
        leaveDate: formStartDate,
        leaveEndDate: formEndDate || formStartDate,
        startAmPm: formStartAmPm,
        endAmPm: formEndAmPm,
        leaveType: formLeaveType,
        approvedBy: formApprovedBy,
        note: formNote || undefined,
        userId: user?.id,
        userName: user?.name,
        userEmail: user?.email,
        companyId: company?.id,
      });
      setLeaves((prev) => [newLeave, ...prev]);
      setShowRequestModal(false);
      resetForm();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Request Submitted", "Your leave request has been submitted successfully.");
    } catch (err) {
      console.error("[LeaveManagement] submit error:", err);
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert("Submit Failed", message);
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setFormStartDate("");
    setFormEndDate("");
    setFormStartAmPm("morning");
    setFormEndAmPm("afternoon");
    setFormApprovedBy("");
    setFormLeaveType("planned");
    setFormHalfDay(false);
    setFormNote("");
  };
  const handleCollectiveSubmit = async () => {
    if (collectiveUsers.length === 0 || !collectiveStartDate) {
      Alert.alert("Required", "Please select users and a start date.");
      return;
    }
    setSubmitting(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await createCollectiveLeaveRemote({
        userIds: collectiveUsers,
        startDate: collectiveStartDate,
        endDate: collectiveEndDate || collectiveStartDate,
        startAmPm: collectiveStartAmPm,
        endAmPm: collectiveEndAmPm,
        leaveType: collectiveType,
        approvedBy: collectiveApprovedBy,
        autoValidate: collectiveAutoValidate,
        note: collectiveNote
      });
      setShowCollectiveModal(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Success", "Collective leaves created!");
      fetchData(); // Refresh UI
    } catch {
      Alert.alert("Error", "Failed to create collective leaves.");
    } finally {
      setSubmitting(false);
    }
  };


  const handleApproveReject = async (leaveId: string, status: "approved" | "rejected") => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await updateLeaveRequestStatusRemote(leaveId, status, reviewComment || undefined);
      setLeaves((prev) =>
        prev.map((l) =>
          l.id === leaveId
            ? { ...l, status, reviewedByName: user?.name || "", reviewedAt: new Date().toISOString(), reviewComment }
            : l
        )
      );
      setReviewingId(null);
      setReviewComment("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      console.error("[LeaveManagement] approve/reject error:", err);
      const message = err instanceof Error ? err.message : "Failed to update status.";
      Alert.alert("Action Failed", message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  
  const handleAddHoliday = async (day: number, month: number, year: number, isCollective?: boolean) => {
    if (isCollective) {
      setCollectiveStartDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
      setShowCollectiveModal(true);
      return;
    }
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await addPublicHolidayRemote({ day, month, year, code: "Collective Leave" });
      setHolidays(prev => [...prev, res]);
    } catch {
      Alert.alert("Error", "Could not add holiday");
    }
  };
  const handleDeleteHoliday = async (id: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await deletePublicHolidayRemote(id);
      setHolidays(prev => prev.filter(h => h.id !== id));
    } catch {
      Alert.alert("Error", "Could not remove holiday");
    }
  };
  const handleSaveWeekends = async () => {
    try {
      await saveWeekendConfigRemote(tempWeekendDays);
      setWeekendDays(tempWeekendDays);
      setShowWeekendModal(false);
    } catch {
      Alert.alert("Error", "Could not save weekends");
    }
  };

  const handleDelete = async (leaveId: string) => {
    Alert.alert("Cancel Request", "Are you sure you want to cancel this leave request?", [
      { text: "Keep", style: "cancel" },
      {
        text: "Cancel Request",
        style: "destructive",
        onPress: async () => {
          try {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            await deleteLeaveRequestRemote(leaveId);
            setLeaves((prev) => prev.filter((l) => l.id !== leaveId));
          } catch (err) {
            console.error("[LeaveManagement] delete error:", err);
            Alert.alert("Failed", "Unable to cancel request.");
          }
        },
      },
    ]);
  };

  // ─── Dynamic colors ────────────────────────────────────────
  const cardBg = isDark ? "rgba(30,41,59,0.85)" : "rgba(255,255,255,0.92)";
  const cardBorder = isDark ? "rgba(71,85,105,0.4)" : "rgba(226,232,240,0.8)";
  const surfaceBg = isDark ? "rgba(15,23,42,0.6)" : "rgba(241,245,249,0.8)";

  // ═════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════
  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 8 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={P.blue} />}
      >
        {/* Nav */}
        <View style={styles.navWrap}>
          <DrawerToggleButton />
        </View>

        {/* ─── Hero ────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(500)}>
          <LinearGradient
            colors={["#0F172A", "#1E293B"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.hero}
          >
            <View style={styles.heroContent}>
              <View style={styles.heroRow}>
                <View style={styles.heroIconWrap}>
                  <Ionicons name="calendar" size={22} color="#FFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.heroTitle}>Leave Management</Text>
                  <Text style={styles.heroSub}>
                    {MONTHS[currentMonth - 1]} {currentYear}
                  </Text>
                </View>
                <Pressable onPress={() => { setShowRequestModal(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }} style={styles.heroBtn}>
                  <Ionicons name="add" size={16} color={"#FFF"} />
                  <Text style={styles.heroBtnTxt}>New</Text>
                </Pressable>
              </View>
            </View>
            {/* Decorations */}
            <View style={[styles.heroOrb, { width: 200, height: 200, top: -70, right: -50, opacity: 0.06 }]} />
            <View style={[styles.heroOrb, { width: 120, height: 120, bottom: -40, right: 30, opacity: 0.05 }]} />
            <View style={[styles.heroOrb, { width: 80, height: 80, top: 5, right: 90, opacity: 0.04 }]} />
            <View style={[styles.heroOrb, { width: 50, height: 50, bottom: 10, left: -10, opacity: 0.04 }]} />
          </LinearGradient>
        </Animated.View>

        
        {/* --- Company Calendar --- */}
        <Animated.View entering={FadeInDown.duration(450).delay(150)}>
          <LeaveCalendar
            month={currentMonth}
            year={currentYear}
            leaves={leaves}
            holidays={holidays}
            weekendDays={weekendDays}
            isPrivileged={isPrivileged}
            colors={colors}
            isDark={isDark}
            onAddHoliday={handleAddHoliday}
            onDeleteHoliday={handleDeleteHoliday}
            onConfigureWeekends={() => { setTempWeekendDays(weekendDays); setShowWeekendModal(true); }}
          />
        </Animated.View>

        {/* ─── Stats ───────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(500).delay(80)} style={styles.statsGrid}>
          {[
            { value: plannedCount, label: "Planned", icon: "calendar-outline" as const, fg: P.blue, bg: isDark ? "#1E3A5F" : P.blueSoft },
            { value: unplannedCount, label: "Unplanned", icon: "flash-outline" as const, fg: P.orangeLight, bg: isDark ? "#3D2307" : P.orangeSoft },
            { value: totalCount, label: "Total", icon: "pie-chart-outline" as const, fg: P.violet, bg: isDark ? "#2D1B69" : P.violetSoft },
          ].map((stat, i) => (
            <View
              key={stat.label}
              style={[styles.statCard, { backgroundColor: cardBg, borderColor: cardBorder }]}
            >
              <View style={[styles.statIcon, { backgroundColor: stat.bg }]}>
                <Ionicons name={stat.icon} size={16} color={stat.fg} />
              </View>
              <Text style={[styles.statVal, { color: colors.text }]}>{stat.value}</Text>
              <Text style={[styles.statLbl, { color: colors.textSecondary }]}>{stat.label}</Text>
            </View>
          ))}
        </Animated.View>

        {/* ─── Pending Alert ───────────────────────────── */}
        {isPrivileged && pendingCount > 0 && (
          <Animated.View entering={FadeInDown.duration(400).delay(150)}>
            <Pressable
              onPress={() => { setActiveTab("pending"); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              style={[styles.alertBanner, { backgroundColor: isDark ? "#422006" : "#FFF7ED", borderColor: isDark ? "#92400E40" : "#FDBA7440" }]}
            >
              <View style={[styles.alertDot, { backgroundColor: P.amber }]} />
              <Text style={[styles.alertText, { color: P.amber }]}>
                {pendingCount} {pendingCount === 1 ? "request" : "requests"} awaiting review
              </Text>
              <Ionicons name="arrow-forward" size={14} color={P.amber} />
            </Pressable>
          </Animated.View>
        )}

        {/* ─── Error ───────────────────────────────────── */}
        {errorMsg && (
          <Animated.View entering={FadeIn.duration(300)}>
            <View style={[styles.errorBanner, { backgroundColor: isDark ? "#3B0E0E" : P.roseSoft, borderColor: isDark ? "#7F1D1D60" : "#FDA4AF40" }]}>
              <Ionicons name="warning" size={16} color={P.roseLight} />
              <Text style={[styles.errorText, { color: P.roseLight }]}>{errorMsg}</Text>
            </View>
          </Animated.View>
        )}

        {/* ─── Tabs ────────────────────────────────────── */}
        <Animated.View entering={FadeInDown.duration(450).delay(200)} style={styles.tabRow}>
          {(["my", ...(isPrivileged ? ["pending", "summary"] as const : [])] as TabKey[]).map((tab) => {
            const active = activeTab === tab;
            return (
              <Pressable
                key={tab}
                onPress={() => { setActiveTab(tab); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                style={[
                  styles.tab,
                  active
                    ? { backgroundColor: isDark ? "#1E3A5F" : P.blueSoft, borderColor: P.blue }
                    : { backgroundColor: surfaceBg, borderColor: cardBorder },
                ]}
              >
                <Text style={[styles.tabLabel, { color: active ? P.blue : colors.textSecondary, fontFamily: active ? "Inter_600SemiBold" : "Inter_400Regular" }]}>
                  {tab === "my" ? "My Leaves" : tab === "pending" ? "Pending" : "Team Summary"}
                </Text>
                {tab === "pending" && pendingCount > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{pendingCount > 99 ? "99+" : pendingCount}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </Animated.View>

        {/* ─── Content ─────────────────────────────────── */}
        {loading ? (
          <View style={styles.loaderWrap}>
            <ActivityIndicator size="large" color={P.blue} />
            <Text style={[styles.loaderText, { color: colors.textTertiary }]}>Loading leaves...</Text>
          </View>
        ) : activeTab === "summary" ? (
          <SummarySection summaries={summaries} month={currentMonth} colors={colors} isDark={isDark} cardBg={cardBg} cardBorder={cardBorder} />
        ) : displayLeaves.length === 0 ? (
          <EmptyState
            tab={activeTab}
            colors={colors}
            isDark={isDark}
            cardBg={cardBg}
            cardBorder={cardBorder}
            onRequest={() => { setShowRequestModal(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }}
          />
        ) : (
          displayLeaves.map((leave, idx) => (
            <LeaveCard
              key={leave.id}
              leave={leave}
              index={idx}
              tab={activeTab}
              isPrivileged={isPrivileged}
              reviewingId={reviewingId}
              reviewComment={reviewComment}
              colors={colors}
              isDark={isDark}
              cardBg={cardBg}
              cardBorder={cardBorder}
              currentUserId={user?.id}
              setReviewingId={setReviewingId}
              setReviewComment={setReviewComment}
              onApprove={(id) => void handleApproveReject(id, "approved")}
              onReject={(id) => void handleApproveReject(id, "rejected")}
              onDelete={(id) => void handleDelete(id)}
            />
          ))
        )}

        {/* ─── Public Holidays ─────────────────────────── */}
        {holidays.length > 0 && (
          <Animated.View entering={FadeInDown.duration(450).delay(300)}>
            <View style={[styles.section, { backgroundColor: cardBg, borderColor: cardBorder }]}>
              <View style={styles.sectionHeader}>
                <View style={[styles.sectionIconWrap, { backgroundColor: isDark ? "#422006" : P.amberSoft }]}>
                  <Ionicons name="sunny" size={16} color={P.amber} />
                </View>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Public Holidays</Text>
              </View>
              {holidays.map((h, idx) => (
                <View
                  key={h.id || idx}
                  style={[styles.holidayItem, idx < holidays.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: cardBorder }]}
                >
                  <View style={[styles.holidayDatePill, { backgroundColor: isDark ? "#422006" : P.amberSoft }]}>
                    <Text style={[styles.holidayDateTxt, { color: P.amber }]}>
                      {String(h.day).padStart(2, "0")}/{String(h.month).padStart(2, "0")}
                    </Text>
                  </View>
                  <Text style={[styles.holidayName, { color: colors.text }]} numberOfLines={1}>
                    {h.code || h.dayRule || `Holiday`}
                  </Text>
                </View>
              ))}
            </View>
          </Animated.View>
        )}

        <View style={{ height: 110 }} />
      </ScrollView>

      {/* ─── Request Modal ─────────────────────────────── */}
      
      {/* ─── NEW LEAVE REQUEST MODAL ─── */}
      <Modal visible={showRequestModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowRequestModal(false)}>
        <View style={{ flex: 1, backgroundColor: isDark ? P.slate900 : "#F8FAFC" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>New Leave Request</Text>
            <Pressable onPress={() => setShowRequestModal(false)}><Ionicons name="close" size={24} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }}>
            <Text style={styles.fldLabel}>Start Date</Text>
            <Pressable style={styles.dateBtn} onPress={() => { setCalendarTarget("start"); setShowCalendar(true); }}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formStartDate ? colors.text : colors.textSecondary }}>{formStartDate ? new Date(formStartDate).toLocaleDateString() : "Select Start Date"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formStartAmPm === "morning" ? P.blue : cardBorder, backgroundColor: formStartAmPm === "morning" ? P.blue + "15" : "transparent" }]} onPress={() => setFormStartAmPm("morning")}>
                <Text style={{ color: formStartAmPm === "morning" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Morning</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formStartAmPm === "afternoon" ? P.blue : cardBorder, backgroundColor: formStartAmPm === "afternoon" ? P.blue + "15" : "transparent" }]} onPress={() => setFormStartAmPm("afternoon")}>
                <Text style={{ color: formStartAmPm === "afternoon" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>End Date (Optional)</Text>
            <Pressable style={styles.dateBtn} onPress={() => { setCalendarTarget("end"); setShowCalendar(true); }}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formEndDate ? colors.text : colors.textSecondary }}>{formEndDate ? new Date(formEndDate).toLocaleDateString() : "Same as Start Date"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formEndAmPm === "morning" ? P.blue : cardBorder, backgroundColor: formEndAmPm === "morning" ? P.blue + "15" : "transparent" }]} onPress={() => setFormEndAmPm("morning")}>
                <Text style={{ color: formEndAmPm === "morning" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Morning</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formEndAmPm === "afternoon" ? P.blue : cardBorder, backgroundColor: formEndAmPm === "afternoon" ? P.blue + "15" : "transparent" }]} onPress={() => setFormEndAmPm("afternoon")}>
                <Text style={{ color: formEndAmPm === "afternoon" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>Leave Type</Text>
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formLeaveType === "planned" ? P.blue : cardBorder }]} onPress={() => setFormLeaveType("planned")}>
                <Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Planned</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formLeaveType === "unplanned" ? P.orange : cardBorder }]} onPress={() => setFormLeaveType("unplanned")}>
                <Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Unplanned</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>Approved By (Optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
              {usersList.map(u => (
                <Pressable key={u.id} style={[{ padding: 10, borderWidth: 1, borderColor: formApprovedBy === u.id ? P.blue : cardBorder, borderRadius: 10, marginRight: 8, backgroundColor: formApprovedBy === u.id ? P.blue+"15" : "transparent" }]} onPress={() => setFormApprovedBy(u.id)}>
                  <Text style={{ color: formApprovedBy === u.id ? P.blue : colors.text }}>{u.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={styles.fldLabel}>Description</Text>
            <TextInput
              style={[styles.input, { borderColor: cardBorder, color: colors.text, minHeight: 80, textAlignVertical: "top" }]}
              placeholder="Why are you taking leave?"
              placeholderTextColor={colors.textTertiary}
              value={formNote}
              onChangeText={setFormNote}
              multiline
            />

            <Pressable onPress={handleSubmitLeave} disabled={!formStartDate || submitting} style={[styles.submitBtn, { backgroundColor: P.blue, marginTop: 20, marginBottom: 50, opacity: (!formStartDate || submitting) ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Submit Request</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* ─── COLLECTIVE LEAVE MODAL ─── */}
      <Modal visible={showCollectiveModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowCollectiveModal(false)}>
        <View style={{ flex: 1, backgroundColor: isDark ? P.slate900 : "#F8FAFC" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>Collective Leave</Text>
            <Pressable onPress={() => setShowCollectiveModal(false)}><Ionicons name="close" size={24} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }}>
            <Text style={styles.fldLabel}>Select Users</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {usersList.map(u => (
                <Pressable key={u.id} style={[{ padding: 8, borderWidth: 1, borderColor: collectiveUsers.includes(u.id) ? P.blue : cardBorder, borderRadius: 10, backgroundColor: collectiveUsers.includes(u.id) ? P.blue+"15" : "transparent" }]} onPress={() => setCollectiveUsers(prev => prev.includes(u.id) ? prev.filter(id => id !== u.id) : [...prev, u.id])}>
                  <Text style={{ color: collectiveUsers.includes(u.id) ? P.blue : colors.text, fontSize: 12 }}>{u.name}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.fldLabel}>Start Date</Text>
            <Pressable style={[styles.input, { borderColor: cardBorder, justifyContent: "center", marginBottom: 16 }]} onPress={() => { setCalendarTarget("collStart"); setShowCalendar(true); }}>
              <Text style={{ color: collectiveStartDate ? colors.text : colors.textTertiary }}>{collectiveStartDate || "YYYY-MM-DD"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveStartAmPm === "morning" ? P.blue : cardBorder }]} onPress={() => setCollectiveStartAmPm("morning")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Morning</Text></Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveStartAmPm === "afternoon" ? P.blue : cardBorder }]} onPress={() => setCollectiveStartAmPm("afternoon")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text></Pressable>
            </View>

            <Text style={styles.fldLabel}>End Date (Optional)</Text>
            <Pressable style={[styles.input, { borderColor: cardBorder, justifyContent: "center", marginBottom: 16 }]} onPress={() => { setCalendarTarget("collEnd"); setShowCalendar(true); }}>
              <Text style={{ color: collectiveEndDate ? colors.text : colors.textTertiary }}>{collectiveEndDate || "YYYY-MM-DD"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveEndAmPm === "morning" ? P.blue : cardBorder }]} onPress={() => setCollectiveEndAmPm("morning")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Morning</Text></Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveEndAmPm === "afternoon" ? P.blue : cardBorder }]} onPress={() => setCollectiveEndAmPm("afternoon")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text></Pressable>
            </View>

            <Text style={styles.fldLabel}>Auto Validate?</Text>
            <Switch value={collectiveAutoValidate} onValueChange={setCollectiveAutoValidate} style={{ alignSelf: "flex-start", marginBottom: 16 }} />

            <Pressable onPress={handleCollectiveSubmit} disabled={submitting} style={[styles.submitBtn, { backgroundColor: P.orange, marginTop: 20, marginBottom: 50, opacity: submitting ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Create Collective Leaves</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>


      
            <Modal visible={showWeekendModal} transparent animationType="fade" onRequestClose={() => setShowWeekendModal(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 16 }}>
          <View style={{ backgroundColor: isDark ? P.slate900 : "#FFF", borderRadius: 20, overflow: "hidden", maxHeight: "90%" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
              <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>Configure Weekends</Text>
              <Pressable onPress={() => setShowWeekendModal(false)}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 20 }} contentContainerStyle={{ paddingVertical: 20, gap: 8 }}>
              <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 8 }}>Select your company's designated off days.</Text>
              {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((dayName, i) => {
                const isActive = tempWeekendDays.includes(i);
                return (
                  <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderColor: cardBorder }}>
                    <Text style={{ color: isActive ? P.blue : colors.text, fontSize: 16, fontFamily: "Inter_500Medium" }}>{dayName}</Text>
                    <Switch
                      value={isActive}
                      onValueChange={(val) => setTempWeekendDays(prev => val ? [...prev, i] : prev.filter(d => d !== i))}
                      trackColor={{ false: isDark ? "#334155" : "#E2E8F0", true: P.blue }}
                    />
                  </View>
                );
              })}
            </ScrollView>
            <View style={{ padding: 20, borderTopWidth: 1, borderColor: cardBorder, backgroundColor: isDark ? P.slate900 : "#FFF" }}>
              <Pressable onPress={handleSaveWeekends} disabled={submitting} style={[styles.submitBtn, { backgroundColor: P.blue, opacity: submitting ? 0.5 : 1 }]}>
                {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Save Weekend Settings</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Calendar */}
      <CalendarModal
        visible={showCalendar}
        value={calendarTarget === "start" ? formStartDate : calendarTarget === "end" ? formEndDate : calendarTarget === "collStart" ? collectiveStartDate : collectiveEndDate}
        onClose={() => setShowCalendar(false)}
        onSelect={(dateStr: string) => {
           if (calendarTarget === "start") setFormStartDate(dateStr);
           else if (calendarTarget === "end") setFormEndDate(dateStr);
           else if (calendarTarget === "collStart") setCollectiveStartDate(dateStr);
           else setCollectiveEndDate(dateStr);
           setShowCalendar(false);
        }}
        colors={colors}
      />
    </AppCanvas>
  );
}

// ═══════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════

function EmptyState({ tab, colors, isDark, cardBg, cardBorder, onRequest }: any) {
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View style={[styles.emptyWrap, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <View style={[styles.emptyIconCircle, { backgroundColor: isDark ? "#1E3A5F" : P.blueSoft }]}>
          <Ionicons name={tab === "my" ? "calendar-outline" : "checkmark-done-outline"} size={36} color={P.blue} />
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {tab === "my" ? "No leave requests yet" : "All caught up!"}
        </Text>
        <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>
          {tab === "my" ? "Tap the button below to submit your first leave request" : "No pending requests to review"}
        </Text>
        
      </View>
    </Animated.View>
  );
}

function SummarySection({ summaries, month, colors, isDark, cardBg, cardBorder }: any) {
  return (
    <Animated.View entering={FadeInDown.duration(400)}>
      <View style={[styles.section, { backgroundColor: cardBg, borderColor: cardBorder }]}>
        <View style={styles.sectionHeader}>
          <View style={[styles.sectionIconWrap, { backgroundColor: isDark ? "#2D1B69" : P.violetSoft }]}>
            <Ionicons name="people" size={16} color={P.violet} />
          </View>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>
            Team Summary — {MONTHS[month - 1]}
          </Text>
        </View>
        {summaries.length === 0 ? (
          <Text style={[styles.emptySmall, { color: colors.textTertiary }]}>No approved leaves this month</Text>
        ) : (
          <>
            <View style={[styles.tblHead, { borderBottomColor: cardBorder }]}>
              <Text style={[styles.tblH, styles.tblName, { color: colors.textTertiary }]}>EMPLOYEE</Text>
              <Text style={[styles.tblH, styles.tblNum, { color: P.blue }]}>PL</Text>
              <Text style={[styles.tblH, styles.tblNum, { color: P.orangeLight }]}>UPL</Text>
              <Text style={[styles.tblH, styles.tblNum, { color: P.violet }]}>TOT</Text>
            </View>
            {summaries.map((s: LeaveSummary, idx: number) => (
              <View key={s.userId + idx} style={[styles.tblRow, idx < summaries.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: cardBorder }]}>
                <Text style={[styles.tblCell, styles.tblName, { color: colors.text }]} numberOfLines={1}>{s.userName}</Text>
                <Text style={[styles.tblCell, styles.tblNum, { color: P.blue, fontFamily: "Inter_600SemiBold" }]}>{s.totalPlannedMonth}</Text>
                <Text style={[styles.tblCell, styles.tblNum, { color: P.orangeLight, fontFamily: "Inter_600SemiBold" }]}>{s.totalUnplannedMonth}</Text>
                <Text style={[styles.tblCell, styles.tblNum, { color: P.violet, fontFamily: "Inter_700Bold" }]}>{s.totalLeavesMonth}</Text>
              </View>
            ))}
          </>
        )}
      </View>
    </Animated.View>
  );
}

function LeaveCard({
  leave, index, tab, isPrivileged, reviewingId, reviewComment,
  colors, isDark, cardBg, cardBorder, currentUserId,
  setReviewingId, setReviewComment, onApprove, onReject, onDelete,
}: any) {
  const typeCfg = TYPE_CONFIG[leave.leaveType] || TYPE_CONFIG.planned;
  const statusCfg = STATUS_CONFIG[leave.status] || STATUS_CONFIG.pending;

  return (
    <Animated.View entering={SlideInRight.duration(350).delay(index * 50)}>
      <View style={[styles.card, { backgroundColor: cardBg, borderColor: cardBorder, borderLeftColor: typeCfg.accent, borderLeftWidth: 3 }]}>
        {/* Row 1: Date + Status */}
        <View style={styles.cardRow1}>
          <View style={styles.cardDateWrap}>
            <Ionicons name="calendar-outline" size={15} color={typeCfg.fg} />
            <Text style={[styles.cardDate, { color: colors.text }]}>{fmtDate(leave.leaveDate)}</Text>
            {leave.isHalfDay && (
              <View style={[styles.halfBadge, { backgroundColor: isDark ? "#2D1B69" : P.violetSoft }]}>
                <Text style={[styles.halfBadgeTxt, { color: P.violet }]}>½</Text>
              </View>
            )}
          </View>
          <View style={[styles.statusPill, { backgroundColor: statusCfg.bg }]}>
            <Ionicons name={statusCfg.icon as any} size={12} color={statusCfg.fg} />
            <Text style={[styles.statusPillTxt, { color: statusCfg.fg }]}>{statusCfg.label}</Text>
          </View>
        </View>

        {/* Row 2: Type + Days */}
        <View style={styles.cardRow2}>
          <View style={[styles.typeBadge, { backgroundColor: isDark ? typeCfg.fg + "15" : typeCfg.bg }]}>
            <Ionicons name={typeCfg.icon as any} size={12} color={typeCfg.fg} />
            <Text style={[styles.typeBadgeTxt, { color: typeCfg.fg }]}>{typeCfg.label}</Text>
          </View>
          <Text style={[styles.daysText, { color: colors.textSecondary }]}>
            {leave.leaveDays} {leave.leaveDays === 1 ? "day" : "days"}
          </Text>
        </View>

        {/* Employee name (admin view) */}
        {tab === "pending" && leave.userName && (
          <View style={styles.metaRow}>
            <Ionicons name="person-circle-outline" size={14} color={colors.textTertiary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>{leave.userName}</Text>
            {leave.createdAt && (
              <Text style={[styles.metaTime, { color: colors.textTertiary }]}>• {fmtRelative(leave.createdAt)}</Text>
            )}
          </View>
        )}

        {/* Note */}
        {leave.note ? (
          <Text style={[styles.noteText, { color: colors.textSecondary }]} numberOfLines={2}>
            "{leave.note}"
          </Text>
        ) : null}

        {/* Review info */}
        {leave.reviewedByName && leave.status !== "pending" && (
          <View style={[styles.reviewInfoWrap, { backgroundColor: isDark ? "rgba(30,41,59,0.5)" : "rgba(241,245,249,0.8)", borderColor: cardBorder }]}>
            <Ionicons
              name={leave.status === "approved" ? "checkmark-circle" : "close-circle"}
              size={13}
              color={leave.status === "approved" ? P.emerald : P.rose}
            />
            <Text style={[styles.reviewInfoTxt, { color: colors.textTertiary }]}>
              {leave.status === "approved" ? "Approved" : "Rejected"} by {leave.reviewedByName}
              {leave.reviewComment ? ` — "${leave.reviewComment}"` : ""}
            </Text>
          </View>
        )}

        {/* Admin actions */}
        {isPrivileged && leave.status === "pending" && tab === "pending" && (
          <View style={[styles.adminWrap, { borderTopColor: cardBorder }]}>
            {reviewingId === leave.id ? (
              <>
                <TextInput
                  style={[styles.reviewField, { color: colors.text, borderColor: cardBorder, backgroundColor: isDark ? P.slate800 : P.slate50 }]}
                  placeholder="Add a comment (optional)"
                  placeholderTextColor={colors.textTertiary}
                  value={reviewComment}
                  onChangeText={setReviewComment}
                  multiline
                />
                <View style={styles.adminBtnRow}>
                  <Pressable onPress={() => onApprove(leave.id)} style={[styles.adminBtn, { backgroundColor: isDark ? "#05301E" : P.emeraldSoft }]}>
                    <Ionicons name="checkmark-circle" size={16} color={P.emerald} />
                    <Text style={[styles.adminBtnTxt, { color: P.emerald }]}>Approve</Text>
                  </Pressable>
                  <Pressable onPress={() => onReject(leave.id)} style={[styles.adminBtn, { backgroundColor: isDark ? "#3B0E0E" : P.roseSoft }]}>
                    <Ionicons name="close-circle" size={16} color={P.rose} />
                    <Text style={[styles.adminBtnTxt, { color: P.rose }]}>Reject</Text>
                  </Pressable>
                  <Pressable onPress={() => { setReviewingId(null); setReviewComment(""); }} style={styles.adminCancelBtn}>
                    <Text style={[styles.adminCancelTxt, { color: colors.textTertiary }]}>Cancel</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <View style={styles.adminBtnRow}>
                <Pressable onPress={() => onApprove(leave.id)} style={[styles.adminBtn, { backgroundColor: isDark ? "#05301E" : P.emeraldSoft }]}>
                  <Ionicons name="checkmark-circle" size={15} color={P.emerald} />
                  <Text style={[styles.adminBtnTxt, { color: P.emerald }]}>Approve</Text>
                </Pressable>
                <Pressable onPress={() => onReject(leave.id)} style={[styles.adminBtn, { backgroundColor: isDark ? "#3B0E0E" : P.roseSoft }]}>
                  <Ionicons name="close-circle" size={15} color={P.rose} />
                  <Text style={[styles.adminBtnTxt, { color: P.rose }]}>Reject</Text>
                </Pressable>
                <Pressable onPress={() => setReviewingId(leave.id)} style={[styles.adminBtn, { backgroundColor: isDark ? "#1E3A5F" : P.blueSoft }]}>
                  <Ionicons name="chatbubble-ellipses-outline" size={15} color={P.blue} />
                  <Text style={[styles.adminBtnTxt, { color: P.blue }]}>Comment</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {/* Delete own pending */}
        {tab === "my" && leave.status === "pending" && leave.userId === currentUserId && (
          <Pressable onPress={() => onDelete(leave.id)} style={styles.cancelRow}>
            <Ionicons name="trash-outline" size={13} color={P.rose} />
            <Text style={[styles.cancelTxt, { color: P.rose }]}>Cancel Request</Text>
          </Pressable>
        )}
      </View>
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════
const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 20 },
  navWrap: { alignSelf: "flex-start", marginBottom: 6 },

  // Hero
  hero: { borderRadius: 24, padding: 22, marginBottom: 16, overflow: "hidden", minHeight: 100 },
  heroContent: { zIndex: 2 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  heroIconWrap: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center" },
  heroTitle: { color: "#FFF", fontSize: 20, letterSpacing: -0.5, fontFamily: "Inter_700Bold" },
  heroSub: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },
  heroBtn: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, gap: 4 },
  heroBtnTxt: { color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 13 },
  heroOrb: { position: "absolute", borderRadius: 999, backgroundColor: "#FFF" },

  // Stats
  statsGrid: { flexDirection: "row", gap: 10, marginBottom: 14 },
  statCard: { flex: 1, borderRadius: 18, borderWidth: 1, padding: 14, alignItems: "center", gap: 6 },
  statIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  statVal: { fontSize: 24, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
  statLbl: { fontSize: 11, fontFamily: "Inter_500Medium", letterSpacing: 0.3, textTransform: "uppercase" },

  // Alert
  alertBanner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  alertDot: { width: 8, height: 8, borderRadius: 4 },
  alertText: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold" },

  // Error
  errorBanner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14, borderWidth: 1, marginBottom: 14 },
  errorText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium" },

  // Tabs
  tabRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  tab: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 12, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  tabLabel: { fontSize: 13 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: P.amber, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FFF", fontSize: 10, fontFamily: "Inter_700Bold" },

  // Loader
  loaderWrap: { paddingVertical: 60, alignItems: "center", gap: 12 },
  loaderText: { fontSize: 13, fontFamily: "Inter_400Regular" },

  // Empty
  emptyWrap: { borderRadius: 24, borderWidth: 1, padding: 40, alignItems: "center", gap: 14, marginBottom: 16 },
  emptyIconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  emptyDesc: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, maxWidth: 260 },
  emptyBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12, marginTop: 4 },
  emptyBtnTxt: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  emptySmall: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", paddingVertical: 16 },

  // Section
  section: { borderRadius: 22, borderWidth: 1, padding: 18, marginBottom: 16 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  sectionIconWrap: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  sectionTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // Summary table
  tblHead: { flexDirection: "row", paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 2 },
  tblH: { fontSize: 10, fontFamily: "Inter_600SemiBold", letterSpacing: 0.5, textTransform: "uppercase" },
  tblName: { flex: 2.5 },
  tblNum: { flex: 1, textAlign: "center" },
  tblRow: { flexDirection: "row", paddingVertical: 11, alignItems: "center" },
  tblCell: { fontSize: 13, fontFamily: "Inter_400Regular" },

  // Holidays
  holidayItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  holidayDatePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  holidayDateTxt: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  holidayName: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular" },

  // Leave Card
  card: { borderRadius: 20, borderWidth: 1, padding: 16, marginBottom: 10 },
  cardRow1: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  cardDateWrap: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  cardDate: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  halfBadge: { width: 22, height: 22, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  halfBadgeTxt: { fontSize: 12, fontFamily: "Inter_700Bold" },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusPillTxt: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  cardRow2: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
  typeBadge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  typeBadgeTxt: { fontSize: 11.5, fontFamily: "Inter_500Medium" },
  daysText: { fontSize: 12, fontFamily: "Inter_400Regular" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  metaText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  metaTime: { fontSize: 11, fontFamily: "Inter_400Regular" },
  noteText: { fontSize: 12.5, fontFamily: "Inter_400Regular", fontStyle: "italic", lineHeight: 18, marginTop: 4, marginBottom: 4, opacity: 0.85 },
  reviewInfoWrap: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  reviewInfoTxt: { flex: 1, fontSize: 11.5, fontFamily: "Inter_400Regular", lineHeight: 16 },

  // Admin
  adminWrap: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
  reviewField: { borderWidth: 1, borderRadius: 12, padding: 10, fontSize: 13, fontFamily: "Inter_400Regular", minHeight: 40, marginBottom: 8 },
  adminBtnRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  adminBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
  adminBtnTxt: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  adminCancelBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  adminCancelTxt: { fontSize: 12, fontFamily: "Inter_400Regular" },

  // Cancel
  cancelRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 8, paddingVertical: 4 },
  cancelTxt: { fontSize: 12, fontFamily: "Inter_500Medium" },

  // FAB
  fabWrap: { position: "absolute", right: 20 },
  fab: { shadowColor: "#1D4ED8", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 16, elevation: 10, borderRadius: 26 },
  fabGrad: { flexDirection: "row", alignItems: "center", gap: 8, height: 52, paddingHorizontal: 24, borderRadius: 26 },
  fabLabel: { color: "#FFF", fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // Modal
  modalOuter: { flex: 1, justifyContent: "flex-end" },
  modalBg: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)" },
  modalSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, borderBottomWidth: 0, paddingHorizontal: 24, paddingBottom: 36, maxHeight: "85%" },
  handleWrap: { alignItems: "center", paddingVertical: 12 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  modalHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  modalTitle: { fontSize: 20, letterSpacing: -0.3, fontFamily: "Inter_700Bold" },

  // Form
  fldLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8, marginTop: 4 },
  dateBtn: { flexDirection: "row", alignItems: "center", gap: 10, height: 50, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, marginBottom: 18 },
  dateBtnTxt: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular" },
  typeRow: { flexDirection: "row", gap: 10, marginBottom: 18 },
  typePill: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 48, borderRadius: 14, borderWidth: 1.5 },
  typePillTxt: { fontSize: 14 },
  switchWrap: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14, borderWidth: 1, marginBottom: 18 },
  switchTitle: { fontSize: 14, fontFamily: "Inter_500Medium" },
  switchDesc: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  noteField: { borderWidth: 1, borderRadius: 14, padding: 14, fontSize: 14, fontFamily: "Inter_400Regular", minHeight: 80, textAlignVertical: "top", marginBottom: 20 },
  submitBtn: { borderRadius: 16, overflow: "hidden" },
  submitGrad: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 54, borderRadius: 16 },
  submitTxt: { color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
