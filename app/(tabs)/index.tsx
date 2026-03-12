import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import Animated, {
  Easing,
  Extrapolation,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  FadeInUp,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import {
  getAttendance,
  getAuditLogs,
  getConversations,
  getEmployees,
  getExpenses,
  getNotificationsForCurrentUser,
  STORAGE_KEYS,
  getSupportThreadsForCurrentUser,
  getTasks,
  getTeams,
  subscribeStorageUpdates,
} from "@/lib/storage";
import type {
  AppNotification,
  AttendanceRecord,
  AuditLog,
  Conversation,
  DashboardStats,
  Employee,
  Expense,
  SupportThread,
  Task,
  Team,
  UserRole,
} from "@/lib/types";
import { canAccessSalesModule } from "@/lib/role-access";

type ActivityEntry = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  title: string;
  subtitle: string;
  timestamp: string;
  badge?: string;
};

type DashboardSnapshot = DashboardStats & {
  taskCompletionRate: number;
  inProgressTasks: number;
  pendingSignIns: number;
  openSupportThreads: number;
  unreadNotifications: number;
  todayCheckouts: number;
  highIntentDeals: number;
};

type QuickLink = {
  id: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  route: string;
};

type MetricCard = {
  id: string;
  label: string;
  value: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: string;
};

type CommandHighlight = {
  id: string;
  label: string;
  value: string;
  icon: keyof typeof Ionicons.glyphMap;
  tone: string;
};

type HeroBadge = {
  id: string;
  text: string;
  icon: keyof typeof Ionicons.glyphMap | keyof typeof MaterialCommunityIcons.glyphMap;
  iconLib?: "ion" | "mci";
};

const LATE_THRESHOLD_HOUR = 9;
const LATE_THRESHOLD_MINUTE = 45;
const DASHBOARD_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_CLOCK_TICK_MS = 10_000;
const STORAGE_EVENT_THROTTLE_MS = 900;
const DASHBOARD_WATCH_KEYS = new Set<string>([
  STORAGE_KEYS.EMPLOYEES,
  STORAGE_KEYS.ATTENDANCE,
  STORAGE_KEYS.TASKS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.CONVERSATIONS,
  STORAGE_KEYS.NOTIFICATIONS,
  STORAGE_KEYS.SUPPORT_THREADS,
  STORAGE_KEYS.TEAMS,
  STORAGE_KEYS.AUDIT_LOGS,
  STORAGE_KEYS.ACCESS_REQUESTS,
]);

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTimestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimeLabel(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "--";
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatRelativeTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "Now";
  const diffMs = Date.now() - parsed.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));
  if (diffMinutes < 1) return "Now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatLiveSyncLabel(timestamp: string | null): string {
  if (!timestamp) return "Syncing...";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "Syncing...";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (diffSeconds <= 8) return "Live now";
  if (diffSeconds < 60) return `Updated ${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `Updated ${diffMinutes}m ago`;
  return `Updated ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function normalizeIdentity(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

function getTaskLabel(task: Task): string {
  return task.visitLocationLabel?.trim() || task.title.trim() || "Field visit";
}

function roleLabel(role?: UserRole | null): string {
  if (!role) return "Team";
  if (role === "salesperson") return "Sales";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getGreetingLabel(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function useLenisScrollEngine(scrollRef: React.RefObject<any>): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof window === "undefined") return;

    let rafId = 0;
    let lenisInstance: { raf: (time: number) => void; destroy?: () => void } | null = null;
    let cancelled = false;

    const init = async () => {
      try {
        const moduleRef = await import("lenis");
        if (cancelled) return;

        const LenisCtor =
          (moduleRef as { default?: any; Lenis?: any }).default ||
          (moduleRef as { Lenis?: any }).Lenis ||
          moduleRef;

        const wrapper =
          scrollRef.current && typeof scrollRef.current.getScrollableNode === "function"
            ? scrollRef.current.getScrollableNode()
            : null;
        const content =
          wrapper && wrapper.firstElementChild ? wrapper.firstElementChild : undefined;

        lenisInstance = new LenisCtor({
          duration: 1.05,
          lerp: 0.09,
          smoothWheel: true,
          smoothTouch: false,
          wheelMultiplier: 0.95,
          ...(wrapper ? { wrapper, content } : {}),
        });

        const tick = (time: number) => {
          lenisInstance?.raf(time);
          rafId = window.requestAnimationFrame(tick);
        };
        rafId = window.requestAnimationFrame(tick);
      } catch {
        // Fallback to native ScrollView behavior when Lenis cannot initialize.
      }
    };

    void init();

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      lenisInstance?.destroy?.();
    };
  }, [scrollRef]);
}

function buildQuickLinks(
  userRole: UserRole | undefined,
  colors: ReturnType<typeof useAppTheme>["colors"]
): QuickLink[] {
  const isSalesperson = userRole === "salesperson";
  const links: QuickLink[] = [
    {
      id: "attendance",
      title: "Attendance",
      subtitle: "Check-ins and approvals",
      icon: "time-outline",
      color: colors.primary,
      route: "/(tabs)/attendance",
    },
    ...(isSalesperson
      ? []
      : [
          {
            id: "team",
            title: "Team",
            subtitle: "Member status and ownership",
            icon: "people-outline",
            color: colors.secondary,
            route: "/(tabs)/team",
          },
        ]),
    {
      id: "tasks",
      title: "Tasks",
      subtitle: "Execution and deadlines",
      icon: "checkbox-outline",
      color: colors.success,
      route: "/(tabs)/tasks",
    },
    {
      id: "support",
      title: "Support",
      subtitle: "Live support threads",
      icon: "help-buoy-outline",
      color: colors.warning,
      route: "/(tabs)/support",
    },
    {
      id: "notifications",
      title: "Alerts",
      subtitle: "Broadcast and updates",
      icon: "notifications-outline",
      color: colors.textSecondary,
      route: "/(tabs)/notifications",
    },
  ];

  if (canAccessSalesModule(userRole)) {
    links.unshift({
      id: "sales",
      title: "Sales",
      subtitle: "Conversation intelligence",
      icon: "trending-up-outline",
      color: "#2F7AF8",
      route: "/(tabs)/sales",
    });
  }

  if (userRole === "admin") {
    links.push({
      id: "admin",
      title: "Admin",
      subtitle: "Controls and approvals",
      icon: "settings-outline",
      color: colors.accent,
      route: "/(tabs)/admin-controls",
    });
    links.push({
      id: "route",
      title: "Route Track",
      subtitle: "Sales movement and halts",
      icon: "navigate-outline",
      color: colors.primary,
      route: "/(tabs)/route-tracking-admin",
    });
  }

  return links;
}

function buildActivityFeed(
  userId: string,
  colors: ReturnType<typeof useAppTheme>["colors"],
  attendance: AttendanceRecord[],
  supportThreads: SupportThread[],
  notifications: AppNotification[],
  auditLogs: AuditLog[]
): ActivityEntry[] {
  const sortedAttendance = [...attendance].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const sortedThreads = [...supportThreads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sortedNotifications = [...notifications].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sortedAuditLogs = [...auditLogs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const attendanceEntries: ActivityEntry[] = sortedAttendance.slice(0, 5).map((record) => ({
    id: `att_${record.id}`,
    icon: record.type === "checkin" ? "enter-outline" : "exit-outline",
    iconColor: record.type === "checkin" ? colors.success : colors.warning,
    title: `${record.userName} ${record.type === "checkin" ? "checked in" : "checked out"}`,
    subtitle: record.geofenceName || "Location update captured",
    timestamp: record.timestamp,
    badge:
      record.approvalStatus && record.approvalStatus !== "approved"
        ? record.approvalStatus.toUpperCase()
        : undefined,
  }));

  const supportEntries: ActivityEntry[] = sortedThreads.slice(0, 4).map((thread) => ({
    id: `sup_${thread.id}`,
    icon: "chatbubble-ellipses-outline",
    iconColor: thread.status === "open" ? colors.warning : colors.success,
    title: `Support: ${thread.subject}`,
    subtitle: `${thread.requestedByName} (${thread.requestedByRole.toUpperCase()})`,
    timestamp: thread.updatedAt,
    badge: thread.status.toUpperCase(),
  }));

  const notificationEntries: ActivityEntry[] = sortedNotifications.slice(0, 4).map((item) => {
    const unread = !(item.readByIds || []).includes(userId);
    return {
      id: `notif_${item.id}`,
      icon: "notifications-outline",
      iconColor: unread ? colors.primary : colors.textTertiary,
      title: item.title,
      subtitle: item.body,
      timestamp: item.createdAt,
      badge: unread ? "UNREAD" : undefined,
    };
  });

  const auditEntries: ActivityEntry[] = sortedAuditLogs.slice(0, 4).map((log) => ({
    id: `audit_${log.id}`,
    icon: "shield-checkmark-outline",
    iconColor: colors.secondary,
    title: log.action,
    subtitle: log.details,
    timestamp: log.timestamp,
  }));

  return [...attendanceEntries, ...supportEntries, ...notificationEntries, ...auditEntries]
    .sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp))
    .slice(0, 10);
}

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const { user } = useAuth();
  const scrollRef = useRef<ScrollView | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [supportThreads, setSupportThreads] = useState<SupportThread[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [liveClockTick, setLiveClockTick] = useState(0);
  const inFlightLoadRef = useRef<Promise<void> | null>(null);

  useLenisScrollEngine(scrollRef);

  const scrollY = useSharedValue(0);
  const ambientPhase = useSharedValue(0);

  useEffect(() => {
    ambientPhase.value = withRepeat(
      withTiming(1, {
        duration: 5200,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true
    );
  }, [ambientPhase]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = event.contentOffset.y;
    },
  });
  const heroAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(scrollY.value, [0, 180], [0, -26], Extrapolation.CLAMP),
      },
    ],
    opacity: interpolate(scrollY.value, [0, 180], [1, 0.9], Extrapolation.CLAMP),
  }));
  const ambientOrbLeftStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(ambientPhase.value, [0, 1], [-12, 20]) },
      { translateY: interpolate(ambientPhase.value, [0, 1], [0, -18]) },
    ],
    opacity: interpolate(ambientPhase.value, [0, 1], [0.52, 0.82]),
  }));
  const ambientOrbRightStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(ambientPhase.value, [0, 1], [16, -10]) },
      { translateY: interpolate(ambientPhase.value, [0, 1], [-10, 8]) },
    ],
    opacity: interpolate(ambientPhase.value, [0, 1], [0.38, 0.72]),
  }));
  const heroShimmerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: interpolate(ambientPhase.value, [0, 1], [-180, 220]) },
      { rotate: "-18deg" },
    ],
    opacity: interpolate(ambientPhase.value, [0, 1], [0.15, 0.3]),
  }));

  const loadDashboard = useCallback(async () => {
    if (inFlightLoadRef.current) {
      await inFlightLoadRef.current;
      return;
    }

    const run = (async () => {
      if (!user) {
        setEmployees([]);
        setAttendance([]);
        setTasks([]);
        setExpenses([]);
        setConversations([]);
        setNotifications([]);
        setSupportThreads([]);
        setTeams([]);
        setAuditLogs([]);
        setLastSyncedAt(null);
        setLoading(false);
        return;
      }

      try {
        const [
          employeeData,
          attendanceData,
          taskData,
          expenseData,
          conversationData,
          notificationData,
          supportData,
          teamData,
          auditData,
        ] = await Promise.all([
          getEmployees(),
          getAttendance(),
          getTasks(),
          getExpenses(),
          getConversations(),
          getNotificationsForCurrentUser(),
          getSupportThreadsForCurrentUser(),
          getTeams(),
          getAuditLogs(),
        ]);

        setEmployees(employeeData);
        setAttendance(attendanceData);
        setTasks(taskData);
        setExpenses(expenseData);
        setConversations(conversationData);
        setNotifications(notificationData);
        setSupportThreads(supportData);
        setTeams(teamData);
        setAuditLogs(auditData);
        setLastSyncedAt(new Date().toISOString());
      } finally {
        setLoading(false);
      }
    })();

    inFlightLoadRef.current = run;
    try {
      await run;
    } finally {
      inFlightLoadRef.current = null;
    }
  }, [user]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useFocusEffect(
    useCallback(() => {
      void loadDashboard();
      const pollId = setInterval(() => {
        void loadDashboard();
      }, DASHBOARD_POLL_INTERVAL_MS);
      return () => {
        clearInterval(pollId);
      };
    }, [loadDashboard])
  );

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void loadDashboard();
      }
    });
    return () => {
      appStateSubscription.remove();
    };
  }, [loadDashboard]);

  useEffect(() => {
    let lastTriggeredAt = 0;
    const unsubscribe = subscribeStorageUpdates((event) => {
      if (!DASHBOARD_WATCH_KEYS.has(event.key)) return;
      const now = Date.now();
      if (now - lastTriggeredAt < STORAGE_EVENT_THROTTLE_MS) return;
      lastTriggeredAt = now;
      void loadDashboard();
    });
    return unsubscribe;
  }, [loadDashboard]);

  useEffect(() => {
    const tickId = setInterval(() => {
      setLiveClockTick((current) => current + 1);
    }, DASHBOARD_CLOCK_TICK_MS);
    return () => {
      clearInterval(tickId);
    };
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadDashboard();
    } finally {
      setRefreshing(false);
    }
  }, [loadDashboard]);

  const snapshot = useMemo<DashboardSnapshot>(() => {
    const todayKey = toLocalDateKey(new Date());
    const validAttendance = attendance.filter((record) => record.approvalStatus !== "rejected");
    const todayRecords = validAttendance.filter(
      (record) => toLocalDateKey(new Date(record.timestamp)) === todayKey
    );
    const todayCheckins = todayRecords.filter((record) => record.type === "checkin");
    const presentUserIds = new Set(todayCheckins.map((record) => record.userId));
    const lateToday = todayCheckins.filter((record) => {
      const parsed = new Date(record.timestamp);
      if (Number.isNaN(parsed.getTime())) return false;
      return (
        parsed.getHours() > LATE_THRESHOLD_HOUR ||
        (parsed.getHours() === LATE_THRESHOLD_HOUR &&
          parsed.getMinutes() > LATE_THRESHOLD_MINUTE)
      );
    }).length;
    const todayCheckouts = todayRecords.filter((record) => record.type === "checkout").length;
    const pendingSignIns = attendance.filter(
      (record) => record.type === "checkin" && record.approvalStatus === "pending"
    ).length;
    const pendingTasks = tasks.filter((task) => task.status === "pending").length;
    const inProgressTasks = tasks.filter((task) => task.status === "in_progress").length;
    const completedTasks = tasks.filter((task) => task.status === "completed").length;
    const pendingExpenses = expenses.filter((expense) => expense.status === "pending").length;
    const avgInterestScore =
      conversations.length === 0
        ? 0
        : Number(
            (
              conversations.reduce((total, entry) => total + entry.interestScore, 0) /
              conversations.length
            ).toFixed(1)
          );

    return {
      totalEmployees: employees.length,
      presentToday: presentUserIds.size,
      lateToday,
      onLeave: Math.max(employees.length - presentUserIds.size, 0),
      activeNow: employees.filter((employee) => employee.status === "active").length,
      idleNow: employees.filter((employee) => employee.status === "idle").length,
      offlineNow: employees.filter((employee) => employee.status === "offline").length,
      pendingTasks,
      pendingExpenses,
      totalConversations: conversations.length,
      avgInterestScore,
      taskCompletionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0,
      inProgressTasks,
      pendingSignIns,
      openSupportThreads: supportThreads.filter((thread) => thread.status === "open").length,
      unreadNotifications: user
        ? notifications.filter((item) => !(item.readByIds || []).includes(user.id)).length
        : 0,
      todayCheckouts,
      highIntentDeals: conversations.filter((entry) => entry.buyingIntent === "high").length,
    };
  }, [attendance, conversations, employees, expenses, notifications, supportThreads, tasks, user]);

  const isSalesperson = user?.role === "salesperson";
  const todayKey = useMemo(() => toLocalDateKey(new Date()), [liveClockTick]);
  const userTasks = useMemo(() => {
    if (!user) return [] as Task[];
    const normalizedName = normalizeIdentity(user.name);
    const normalizedEmail = normalizeIdentity(user.email);
    return tasks.filter((task) => {
      if (task.assignedTo === user.id) return true;
      const assignedName = normalizeIdentity(task.assignedToName);
      return (
        (normalizedName && assignedName === normalizedName) ||
        (normalizedEmail && assignedName === normalizedEmail)
      );
    });
  }, [tasks, user]);
  const userPendingTasks = useMemo(
    () => userTasks.filter((task) => task.status === "pending").length,
    [userTasks]
  );
  const userInProgressTasks = useMemo(
    () => userTasks.filter((task) => task.status === "in_progress").length,
    [userTasks]
  );
  const todaysVisits = useMemo(() => {
    return userTasks
      .filter((task) => task.taskType === "field_visit")
      .filter((task) => (task.visitPlanDate || task.dueDate) === todayKey)
      .sort((a, b) => {
        const seqA = typeof a.visitSequence === "number" ? a.visitSequence : Number.POSITIVE_INFINITY;
        const seqB = typeof b.visitSequence === "number" ? b.visitSequence : Number.POSITIVE_INFINITY;
        if (seqA !== seqB) return seqA - seqB;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }, [todayKey, userTasks]);
  const visitsCompleted = useMemo(
    () => todaysVisits.filter((task) => task.status === "completed").length,
    [todaysVisits]
  );
  const visitsInProgress = useMemo(
    () => todaysVisits.filter((task) => task.status === "in_progress").length,
    [todaysVisits]
  );
  const visitsPending = useMemo(
    () => todaysVisits.filter((task) => task.status === "pending").length,
    [todaysVisits]
  );
  const nextVisit = useMemo(
    () => todaysVisits.find((task) => task.status !== "completed") ?? null,
    [todaysVisits]
  );
  const userPendingExpenses = useMemo(() => {
    if (!user) return 0;
    return expenses.filter((expense) => expense.userId === user.id && expense.status === "pending")
      .length;
  }, [expenses, user]);
  const userAttendanceToday = useMemo(() => {
    if (!user) return [] as AttendanceRecord[];
    return attendance.filter(
      (record) => record.userId === user.id && toLocalDateKey(new Date(record.timestamp)) === todayKey
    );
  }, [attendance, todayKey, user]);
  const hasCheckedIn = userAttendanceToday.some((record) => record.type === "checkin");
  const hasCheckedOut = userAttendanceToday.some((record) => record.type === "checkout");
  const attendanceStatus = hasCheckedOut ? "Checked out" : hasCheckedIn ? "Checked in" : "Not checked in";

  const quickLinks = useMemo(() => buildQuickLinks(user?.role, colors), [colors, user?.role]);

  const metricCards = useMemo<MetricCard[]>(
    () =>
      isSalesperson
        ? [
            {
              id: "visits",
              label: "Visits Today",
              value: `${visitsCompleted}/${todaysVisits.length}`,
              hint: `${visitsPending} pending · ${visitsInProgress} active`,
              icon: "navigate-outline",
              tone: colors.primary,
            },
            {
              id: "tasks",
              label: "My Tasks",
              value: `${userPendingTasks + userInProgressTasks}`,
              hint: `${userPendingTasks} pending · ${userInProgressTasks} active`,
              icon: "checkbox-outline",
              tone: colors.success,
            },
            {
              id: "alerts",
              label: "My Alerts",
              value: `${snapshot.unreadNotifications}`,
              hint: `${snapshot.openSupportThreads} support threads`,
              icon: "notifications-outline",
              tone: colors.warning,
            },
            {
              id: "expenses",
              label: "Expenses",
              value: `${userPendingExpenses}`,
              hint: "Pending approvals",
              icon: "receipt-outline",
              tone: colors.secondary,
            },
          ]
        : [
            {
              id: "present",
              label: "Present Today",
              value: `${snapshot.presentToday}/${snapshot.totalEmployees || 0}`,
              hint: `${snapshot.lateToday} late arrivals`,
              icon: "person-add-outline",
              tone: colors.success,
            },
            {
              id: "tasks",
              label: "Task Completion",
              value: `${snapshot.taskCompletionRate}%`,
              hint: `${snapshot.pendingTasks} pending · ${snapshot.inProgressTasks} running`,
              icon: "checkbox-outline",
              tone: colors.primary,
            },
            {
              id: "support",
              label: "Support Queue",
              value: `${snapshot.openSupportThreads}`,
              hint: `${snapshot.unreadNotifications} unread alerts`,
              icon: "help-buoy-outline",
              tone: colors.warning,
            },
            {
              id: "sales",
              label: "High Intent",
              value: `${snapshot.highIntentDeals}`,
              hint: `${snapshot.totalConversations} total conversations`,
              icon: "sparkles-outline",
              tone: colors.secondary,
            },
          ],
    [
      colors.primary,
      colors.secondary,
      colors.success,
      colors.warning,
      isSalesperson,
      snapshot,
      todaysVisits.length,
      userInProgressTasks,
      userPendingExpenses,
      userPendingTasks,
      visitsCompleted,
      visitsInProgress,
      visitsPending,
    ]
  );

  const commandHighlights = useMemo<CommandHighlight[]>(
    () =>
      isSalesperson
        ? [
            {
              id: "visits_total",
              label: "Visits Today",
              value: `${todaysVisits.length}`,
              icon: "navigate-outline",
              tone: colors.primary,
            },
            {
              id: "tasks_pending",
              label: "Pending Tasks",
              value: `${userPendingTasks}`,
              icon: "checkbox-outline",
              tone: colors.success,
            },
            {
              id: "alerts_unread",
              label: "Unread Alerts",
              value: `${snapshot.unreadNotifications}`,
              icon: "notifications-outline",
              tone: colors.warning,
            },
            {
              id: "expenses_pending",
              label: "Pending Expenses",
              value: `${userPendingExpenses}`,
              icon: "receipt-outline",
              tone: colors.secondary,
            },
          ]
        : [
            {
              id: "active_staff",
              label: "Active Staff",
              value: `${snapshot.activeNow}`,
              icon: "pulse-outline",
              tone: colors.success,
            },
            {
              id: "unread_alerts",
              label: "Unread Alerts",
              value: `${snapshot.unreadNotifications}`,
              icon: "notifications-outline",
              tone: colors.primary,
            },
            {
              id: "pending_signins",
              label: "Pending Sign-ins",
              value: `${snapshot.pendingSignIns}`,
              icon: "finger-print-outline",
              tone: colors.warning,
            },
            {
              id: "team_online",
              label: "Team Presence",
              value: `${snapshot.activeNow + snapshot.idleNow}/${snapshot.totalEmployees || 0}`,
              icon: "people-circle-outline",
              tone: colors.secondary,
            },
          ],
    [
      colors.primary,
      colors.secondary,
      colors.success,
      colors.warning,
      isSalesperson,
      snapshot,
      todaysVisits.length,
      userPendingExpenses,
      userPendingTasks,
    ]
  );

  const presentRatio = useMemo(() => {
    if (snapshot.totalEmployees <= 0) return 0;
    return Math.round((snapshot.presentToday / snapshot.totalEmployees) * 100);
  }, [snapshot.presentToday, snapshot.totalEmployees]);

  const activityFeed = useMemo(
    () =>
      user
        ? buildActivityFeed(user.id, colors, attendance, supportThreads, notifications, auditLogs)
        : [],
    [attendance, auditLogs, colors, notifications, supportThreads, user]
  );

  const prioritySupportThreads = useMemo(() => {
    return [...supportThreads]
      .filter((thread) => thread.status === "open")
      .sort((a, b) => toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt))
      .slice(0, 4);
  }, [supportThreads]);

  const isSalesVisible = canAccessSalesModule(user?.role);
  const liveSyncLabel = useMemo(
    () => formatLiveSyncLabel(lastSyncedAt),
    [lastSyncedAt, liveClockTick]
  );
  const currentDateLabel = useMemo(
    () =>
      new Date().toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [liveClockTick]
  );
  const greeting = useMemo(() => getGreetingLabel(), [liveClockTick]);
  const heroSubtitle = isSalesperson
    ? "Your visits, tasks, and alerts for today."
    : "Workforce command center with live attendance, support queue, and execution signals.";
  const heroInsights = useMemo(
    () =>
      isSalesperson
        ? [
            {
              id: "visits_done",
              value: `${visitsCompleted}/${todaysVisits.length}`,
              label: "Visits done",
            },
            {
              id: "tasks_pending",
              value: `${userPendingTasks}`,
              label: "Pending tasks",
            },
            {
              id: "alerts_unread",
              value: `${snapshot.unreadNotifications}`,
              label: "Unread alerts",
            },
          ]
        : [
            {
              id: "active_now",
              value: `${snapshot.activeNow}`,
              label: "Active now",
            },
            {
              id: "pending_signins",
              value: `${snapshot.pendingSignIns}`,
              label: "Pending sign-ins",
            },
            {
              id: "today_checkouts",
              value: `${snapshot.todayCheckouts}`,
              label: "Checkouts today",
            },
          ],
    [
      isSalesperson,
      snapshot.activeNow,
      snapshot.pendingSignIns,
      snapshot.todayCheckouts,
      snapshot.unreadNotifications,
      todaysVisits.length,
      userPendingTasks,
      visitsCompleted,
    ]
  );
  const heroBadges = useMemo<HeroBadge[]>(
    () =>
      isSalesperson
        ? [
            {
              id: "sync",
              icon: "radio-outline",
              text: liveSyncLabel,
            },
            {
              id: "attendance",
              icon: hasCheckedOut
                ? "checkmark-done-outline"
                : hasCheckedIn
                  ? "checkmark-circle-outline"
                  : "time-outline",
              text: attendanceStatus,
            },
            {
              id: "next_visit",
              icon: "navigate-outline",
              text: nextVisit ? `Next: ${getTaskLabel(nextVisit)}` : "No visits scheduled",
            },
          ]
        : [
            {
              id: "sync",
              icon: "radio-outline",
              text: liveSyncLabel,
            },
            {
              id: "velocity",
              icon: "lightning-bolt-outline",
              iconLib: "mci",
              text: `${snapshot.taskCompletionRate}% delivery velocity`,
            },
            {
              id: "support",
              icon: "chatbubbles-outline",
              text: `${snapshot.openSupportThreads} open support threads`,
            },
          ],
    [
      attendanceStatus,
      hasCheckedIn,
      hasCheckedOut,
      isSalesperson,
      liveSyncLabel,
      nextVisit,
      snapshot.openSupportThreads,
      snapshot.taskCompletionRate,
    ]
  );

  if (!user) {
    return (
      <AppCanvas>
        <View style={[styles.emptyStateWrap, { paddingTop: insets.top + 24 }]}>
          <View style={styles.navToggleWrap}>
            <DrawerToggleButton />
          </View>
          <View
            style={[
              styles.emptyStateCard,
              { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
            ]}
          >
            <Ionicons name="person-circle-outline" size={44} color={colors.textTertiary} />
            <Text style={[styles.emptyStateTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Session Not Available
            </Text>
            <Text
              style={[
                styles.emptyStateBody,
                { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
              ]}
            >
              Please sign in again to load your dashboard data.
            </Text>
          </View>
        </View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <Animated.ScrollView
        ref={scrollRef as any}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + 10,
            paddingBottom: Math.max(insets.bottom, 20) + 28,
          },
        ]}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInUp.duration(420)} style={[styles.heroWrap, heroAnimatedStyle]}>
          <LinearGradient
            colors={
              isDark
                ? [colors.accent, colors.primary, colors.secondary]
                : [colors.heroStart, colors.heroEnd, colors.primary]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.heroCard}
          >
            <Animated.View
              pointerEvents="none"
              style={[
                styles.heroOrb,
                styles.heroOrbLeft,
                { backgroundColor: `${colors.backgroundElevated}24` },
                ambientOrbLeftStyle,
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.heroOrb,
                styles.heroOrbRight,
                { backgroundColor: `${colors.secondary}26` },
                ambientOrbRightStyle,
              ]}
            />
            <Animated.View pointerEvents="none" style={[styles.heroShimmer, heroShimmerStyle]} />
            <View
              pointerEvents="none"
              style={[styles.heroGridOverlay, { borderColor: `${colors.backgroundElevated}24` }]}
            />
            <View style={styles.heroHeaderRow}>
              <View style={styles.heroDateChip}>
                <Ionicons name="calendar-outline" size={13} color="#E8F4FF" />
                <Text style={styles.heroDateText}>{currentDateLabel}</Text>
              </View>
              <View style={styles.heroRoleChip}>
                <Text style={styles.heroRoleText}>{roleLabel(user.role)}</Text>
              </View>
            </View>

            <Text style={styles.heroGreetingText}>{greeting}</Text>
            <Text style={styles.heroTitleText}>{user.name}</Text>
            <Text style={styles.heroSubtitleText}>{heroSubtitle}</Text>

            <View style={styles.heroInsightRow}>
              {heroInsights.map((item, index) => (
                <React.Fragment key={item.id}>
                  <View style={styles.heroInsightItem}>
                    <Text style={styles.heroInsightValue}>{item.value}</Text>
                    <Text style={styles.heroInsightLabel}>{item.label}</Text>
                  </View>
                  {index < heroInsights.length - 1 ? <View style={styles.heroDivider} /> : null}
                </React.Fragment>
              ))}
            </View>

            <View style={styles.heroBadgeRow}>
              {heroBadges.map((badge) => (
                <View key={badge.id} style={styles.heroBadge}>
                  {badge.iconLib === "mci" ? (
                    <MaterialCommunityIcons name={badge.icon} size={13} color="#DDF5FF" />
                  ) : (
                    <Ionicons name={badge.icon} size={13} color="#DDF5FF" />
                  )}
                  <Text style={styles.heroBadgeText}>{badge.text}</Text>
                </View>
              ))}
            </View>
          </LinearGradient>
        </Animated.View>

        <View style={styles.commandStripRow}>
          {commandHighlights.map((highlight, index) => (
            <Animated.View
              key={highlight.id}
              entering={
                index % 2 === 0
                  ? FadeInLeft.duration(420).delay(70 + index * 35)
                  : FadeInRight.duration(420).delay(70 + index * 35)
              }
              style={[
                styles.commandStripCard,
                {
                  borderColor: `${highlight.tone}4A`,
                  backgroundColor: `${highlight.tone}12`,
                },
              ]}
            >
              <View style={[styles.commandStripIcon, { backgroundColor: `${highlight.tone}1E` }]}>
                <Ionicons name={highlight.icon} size={14} color={highlight.tone} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    styles.commandStripValue,
                    { color: colors.text, fontFamily: "Inter_700Bold" },
                  ]}
                >
                  {highlight.value}
                </Text>
                <Text
                  style={[
                    styles.commandStripLabel,
                    { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                  ]}
                >
                  {highlight.label}
                </Text>
              </View>
            </Animated.View>
          ))}
        </View>

        <Animated.View entering={FadeInDown.duration(420).delay(40)} style={styles.sectionWrap}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {isSalesperson ? "My Progress" : "Live Metrics"}
            </Text>
            <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {isSalesperson ? "Today's visits, tasks, and alerts" : "Real-time operational health"}
            </Text>
          </View>
          <View style={styles.metricGrid}>
            {metricCards.map((card, index) => (
              <Animated.View
                key={card.id}
                entering={FadeInDown.duration(340).delay(80 + index * 30)}
                style={[
                  styles.metricCard,
                  {
                    borderColor: `${card.tone}40`,
                    backgroundColor: colors.backgroundElevated,
                  },
                ]}
              >
                <View style={[styles.metricCardGlow, { backgroundColor: `${card.tone}14` }]} />
                <View style={styles.metricHeader}>
                  <View style={[styles.metricIconWrap, { backgroundColor: `${card.tone}14` }]}>
                    <Ionicons name={card.icon} size={16} color={card.tone} />
                  </View>
                  <Text style={[styles.metricLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    {card.label}
                  </Text>
                </View>
                <Text style={[styles.metricValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  {card.value}
                </Text>
                <Text style={[styles.metricHint, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                  {card.hint}
                </Text>
                <View style={[styles.metricAccentTrack, { backgroundColor: colors.borderLight }]}>
                  <View style={[styles.metricAccentFill, { backgroundColor: card.tone }]} />
                </View>
              </Animated.View>
            ))}
          </View>
        </Animated.View>

        {isSalesperson ? (
          <Animated.View
            entering={FadeInDown.duration(420).delay(120)}
            style={[
              styles.sectionCard,
              { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
            ]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.primary}26` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                Today&apos;s Visits
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Your field stops and route flow
              </Text>
            </View>

            {todaysVisits.length === 0 ? (
              <View style={styles.emptyInlineWrap}>
                <Ionicons name="flag-outline" size={18} color={colors.textTertiary} />
                <Text style={[styles.emptyInlineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No visits assigned for today.
                </Text>
              </View>
            ) : (
              todaysVisits.slice(0, 4).map((task, index) => {
                const statusColor =
                  task.status === "completed"
                    ? colors.success
                    : task.status === "in_progress"
                      ? colors.primary
                      : colors.warning;
                const statusLabel =
                  task.status === "completed"
                    ? "Completed"
                    : task.status === "in_progress"
                      ? "In progress"
                      : "Pending";
                const subtitle = task.visitLocationAddress?.trim() || task.description || "Field visit";
                return (
                  <View
                    key={task.id}
                    style={[
                      styles.activityRow,
                      index < Math.min(4, todaysVisits.length) - 1 && {
                        borderBottomWidth: 1,
                        borderBottomColor: colors.borderLight,
                      },
                    ]}
                  >
                    <View style={[styles.activityIconWrap, { backgroundColor: `${statusColor}16` }]}>
                      <Ionicons name="navigate-outline" size={16} color={statusColor} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.activityTitleRow}>
                        <Text style={[styles.activityTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          {task.visitSequence ? `#${task.visitSequence} ` : ""}
                          {getTaskLabel(task)}
                        </Text>
                        <View style={[styles.activityBadge, { backgroundColor: `${statusColor}18` }]}>
                          <Text style={[styles.activityBadgeText, { color: statusColor, fontFamily: "Inter_600SemiBold" }]}>
                            {statusLabel}
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[styles.activitySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
                        numberOfLines={2}
                      >
                        {subtitle}
                      </Text>
                      <Text style={[styles.activityTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                        {task.visitPlanDate || task.dueDate}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}

            <Pressable
              onPress={() => router.push("/(tabs)/sales" as never)}
              style={({ pressed }) => [
                styles.salesCtaButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Ionicons name="map-outline" size={16} color="#FFFFFF" />
              <Text style={styles.salesCtaText}>Open Sales Day</Text>
            </Pressable>
          </Animated.View>
        ) : (
          <Animated.View
            entering={FadeInDown.duration(420).delay(120)}
            style={[
              styles.pulseCard,
              { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
            ]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.primary}26` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                Operational Pulse
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Attendance + execution trend
              </Text>
            </View>

            <View style={styles.progressRow}>
              <View style={styles.progressHeader}>
                <Text style={[styles.progressLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  Attendance Coverage
                </Text>
                <Text style={[styles.progressValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {presentRatio}%
                </Text>
              </View>
              <View style={[styles.progressTrack, { backgroundColor: colors.borderLight }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(100, Math.max(0, presentRatio))}%`,
                      backgroundColor: colors.success,
                    },
                  ]}
                />
              </View>
            </View>

            <View style={styles.progressRow}>
              <View style={styles.progressHeader}>
                <Text style={[styles.progressLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  Task Throughput
                </Text>
                <Text style={[styles.progressValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {snapshot.taskCompletionRate}%
                </Text>
              </View>
              <View style={[styles.progressTrack, { backgroundColor: colors.borderLight }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(100, Math.max(0, snapshot.taskCompletionRate))}%`,
                      backgroundColor: colors.primary,
                    },
                  ]}
                />
              </View>
            </View>

            {isSalesVisible ? (
              <View
                style={[
                  styles.salesStrip,
                  { borderColor: colors.border, backgroundColor: `${colors.secondary}0E` },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.salesStripLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    Avg Interest Score
                  </Text>
                  <Text style={[styles.salesStripValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {snapshot.avgInterestScore.toFixed(1)}
                  </Text>
                </View>
                <View style={styles.salesStripDivider} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.salesStripLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    High Intent Deals
                  </Text>
                  <Text style={[styles.salesStripValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {snapshot.highIntentDeals}
                  </Text>
                </View>
              </View>
            ) : null}
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.duration(420).delay(170)} style={styles.sectionWrap}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {isSalesperson ? "My Shortcuts" : "Quick Actions"}
            </Text>
            <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {isSalesperson ? "Tools you use every day" : "Jump directly into modules"}
            </Text>
          </View>

          <View style={styles.quickGrid}>
            {quickLinks.map((link) => (
              <Pressable
                key={link.id}
                onPress={() => router.push(link.route as never)}
                style={[
                  styles.quickCard,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.backgroundElevated,
                  },
                ]}
              >
                <View style={styles.quickCardHeader}>
                  <View style={[styles.quickIconWrap, { backgroundColor: `${link.color}16` }]}>
                    <Ionicons name={link.icon} size={18} color={link.color} />
                  </View>
                  <View style={[styles.quickArrowWrap, { borderColor: `${link.color}44` }]}>
                    <Ionicons name="arrow-forward" size={12} color={link.color} />
                  </View>
                </View>
                <Text style={[styles.quickTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {link.title}
                </Text>
                <Text style={[styles.quickSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {link.subtitle}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(420).delay(220)}
          style={[styles.sectionCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
        >
          <View style={[styles.cardSheen, { backgroundColor: `${colors.warning}24` }]} />
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {isSalesperson ? "My Support" : "Support Priority"}
            </Text>
            <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {isSalesperson ? "Your open requests and updates" : "Open threads requiring attention"}
            </Text>
          </View>

          {prioritySupportThreads.length === 0 ? (
            <View style={styles.emptyInlineWrap}>
              <Ionicons name="checkmark-done-outline" size={18} color={colors.success} />
              <Text style={[styles.emptyInlineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                No open support requests right now.
              </Text>
            </View>
          ) : (
            prioritySupportThreads.map((thread, index) => (
              <View
                key={thread.id}
                style={[
                  styles.threadRow,
                  index < prioritySupportThreads.length - 1 && {
                    borderBottomWidth: 1,
                    borderBottomColor: colors.borderLight,
                  },
                ]}
              >
                <View style={[styles.threadStatusDot, { backgroundColor: thread.priority === "high" ? colors.warning : colors.primary }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.threadTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                    {thread.subject}
                  </Text>
                  <Text style={[styles.threadMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                    {thread.requestedByName} · {thread.requestedByRole.toUpperCase()} ·{" "}
                    {formatRelativeTime(thread.updatedAt)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.threadChip,
                    {
                      backgroundColor:
                        thread.priority === "high" ? `${colors.warning}18` : `${colors.primary}18`,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.threadChipText,
                      {
                        color: thread.priority === "high" ? colors.warning : colors.primary,
                        fontFamily: "Inter_600SemiBold",
                      },
                    ]}
                  >
                    {thread.priority.toUpperCase()}
                  </Text>
                </View>
              </View>
            ))
          )}
        </Animated.View>

        {!isSalesperson ? (
          <Animated.View
            entering={FadeInDown.duration(420).delay(260)}
            style={[styles.sectionCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.secondary}24` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                Activity Timeline
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Latest actions across operations
              </Text>
            </View>

            {loading ? (
              <View style={styles.loadingWrap}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : activityFeed.length === 0 ? (
              <View style={styles.emptyInlineWrap}>
                <Ionicons name="information-circle-outline" size={18} color={colors.textTertiary} />
                <Text style={[styles.emptyInlineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Live activity will appear once operations start.
                </Text>
              </View>
            ) : (
              activityFeed.map((entry, index) => (
                <View
                  key={entry.id}
                  style={[
                    styles.activityRow,
                    index < activityFeed.length - 1 && {
                      borderBottomWidth: 1,
                      borderBottomColor: colors.borderLight,
                    },
                  ]}
                >
                  <View style={[styles.activityIconWrap, { backgroundColor: `${entry.iconColor}14` }]}>
                    <Ionicons name={entry.icon} size={16} color={entry.iconColor} />
                  </View>

                  <View style={{ flex: 1 }}>
                    <View style={styles.activityTitleRow}>
                      <Text style={[styles.activityTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {entry.title}
                      </Text>
                      {entry.badge ? (
                        <View style={[styles.activityBadge, { backgroundColor: `${colors.primary}18` }]}>
                          <Text style={[styles.activityBadgeText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                            {entry.badge}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.activitySubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]} numberOfLines={2}>
                      {entry.subtitle}
                    </Text>
                    <Text style={[styles.activityTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      {formatTimeLabel(entry.timestamp)} · {formatRelativeTime(entry.timestamp)}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </Animated.View>
        ) : null}

        {!isSalesperson ? (
          <Animated.View entering={FadeInDown.duration(420).delay(300)} style={styles.footerSummaryRow}>
            <View
              style={[
                styles.footerSummaryCard,
                { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
              ]}
            >
              <Ionicons name="people-outline" size={18} color={colors.primary} />
              <Text style={[styles.footerSummaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Teams
              </Text>
              <Text style={[styles.footerSummaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {teams.length}
              </Text>
            </View>

            <View
              style={[
                styles.footerSummaryCard,
                { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
              ]}
            >
              <Ionicons name="receipt-outline" size={18} color={colors.warning} />
              <Text style={[styles.footerSummaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Pending Expenses
              </Text>
              <Text style={[styles.footerSummaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {snapshot.pendingExpenses}
              </Text>
            </View>
          </Animated.View>
        ) : null}
      </Animated.ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 18,
  },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 10,
  },
  heroWrap: {
    marginBottom: 12,
  },
  heroCard: {
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    position: "relative",
    overflow: "hidden",
    shadowColor: "#0A1D35",
    shadowOpacity: 0.24,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 9 },
    elevation: 4,
  },
  heroOrb: {
    position: "absolute",
    width: 180,
    height: 180,
    borderRadius: 999,
  },
  heroOrbLeft: {
    top: -74,
    left: -56,
  },
  heroOrbRight: {
    right: -68,
    bottom: -92,
  },
  heroShimmer: {
    position: "absolute",
    width: 210,
    height: 260,
    top: -80,
    borderRadius: 40,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  heroGridOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderRadius: 22,
  },
  heroHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
    gap: 8,
  },
  heroDateChip: {
    minHeight: 30,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
    paddingHorizontal: 11,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroDateText: {
    color: "#E8F4FF",
    fontFamily: "Inter_600SemiBold",
    fontSize: 11.5,
    letterSpacing: 0.2,
  },
  heroRoleChip: {
    minHeight: 30,
    borderRadius: 999,
    backgroundColor: "rgba(9,20,38,0.22)",
    paddingHorizontal: 10,
    justifyContent: "center",
  },
  heroRoleText: {
    color: "#F3F8FF",
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.4,
  },
  heroGreetingText: {
    color: "#D8EBFF",
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  heroTitleText: {
    marginTop: 2,
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    letterSpacing: -0.3,
  },
  heroSubtitleText: {
    marginTop: 6,
    color: "#E6F1FF",
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 18,
    maxWidth: "95%",
  },
  heroInsightRow: {
    marginTop: 14,
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: "rgba(7, 16, 34, 0.24)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  heroInsightItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  heroInsightValue: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 17,
  },
  heroInsightLabel: {
    marginTop: 2,
    color: "#D8E9FF",
    fontFamily: "Inter_400Regular",
    fontSize: 10.5,
  },
  heroDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  heroBadgeRow: {
    marginTop: 11,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  heroBadge: {
    minHeight: 28,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroBadgeText: {
    color: "#E3F0FF",
    fontFamily: "Inter_500Medium",
    fontSize: 10.5,
  },
  commandStripRow: {
    marginTop: 1,
    marginBottom: 9,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  commandStripCard: {
    width: "48.6%",
    minHeight: 66,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  commandStripIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  commandStripValue: {
    fontSize: 15,
    letterSpacing: -0.2,
  },
  commandStripLabel: {
    marginTop: 1,
    fontSize: 10.8,
  },
  sectionWrap: {
    marginTop: 2,
    marginBottom: 10,
  },
  sectionHeader: {
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 16,
    letterSpacing: -0.2,
  },
  sectionCaption: {
    marginTop: 2,
    fontSize: 12,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
  },
  metricCard: {
    width: "48.6%",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 114,
    position: "relative",
    overflow: "hidden",
    shadowColor: "#13263F",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  metricCardGlow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 36,
  },
  metricHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  metricIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  metricLabel: {
    fontSize: 11.5,
    flex: 1,
  },
  metricValue: {
    marginTop: 8,
    fontSize: 21,
    letterSpacing: -0.3,
  },
  metricHint: {
    marginTop: 4,
    fontSize: 11,
    lineHeight: 16,
  },
  metricAccentTrack: {
    marginTop: 6,
    width: "100%",
    height: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  metricAccentFill: {
    width: "68%",
    height: "100%",
    borderRadius: 999,
  },
  pulseCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
    marginBottom: 10,
    overflow: "hidden",
  },
  cardSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
  },
  progressRow: {
    marginBottom: 12,
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  progressLabel: {
    fontSize: 12,
  },
  progressValue: {
    fontSize: 12.5,
  },
  progressTrack: {
    width: "100%",
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  salesStrip: {
    marginTop: 2,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  salesStripDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: "rgba(148,163,184,0.28)",
    marginHorizontal: 10,
  },
  salesStripLabel: {
    fontSize: 11.5,
  },
  salesStripValue: {
    marginTop: 3,
    fontSize: 17,
  },
  quickGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
  },
  quickCard: {
    width: "48.6%",
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 104,
    shadowColor: "#13263F",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  quickCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  quickIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  quickArrowWrap: {
    width: 23,
    height: 23,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  quickTitle: {
    marginTop: 8,
    fontSize: 13.5,
  },
  quickSubtitle: {
    marginTop: 3,
    fontSize: 11.3,
    lineHeight: 16,
  },
  sectionCard: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    marginBottom: 10,
    overflow: "hidden",
  },
  emptyInlineWrap: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  emptyInlineText: {
    fontSize: 12.5,
    flex: 1,
  },
  salesCtaButton: {
    marginTop: 10,
    borderRadius: 10,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  salesCtaText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
  },
  threadStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  threadTitle: {
    fontSize: 12.8,
  },
  threadMeta: {
    marginTop: 2,
    fontSize: 11.3,
  },
  threadChip: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  threadChipText: {
    fontSize: 10,
    letterSpacing: 0.3,
  },
  loadingWrap: {
    minHeight: 94,
    alignItems: "center",
    justifyContent: "center",
  },
  activityRow: {
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  activityIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  activityTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 6,
  },
  activityTitle: {
    flex: 1,
    fontSize: 12.8,
    lineHeight: 18,
  },
  activityBadge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  activityBadgeText: {
    fontSize: 9.5,
    letterSpacing: 0.3,
  },
  activitySubtitle: {
    marginTop: 2,
    fontSize: 11.5,
    lineHeight: 17,
  },
  activityTime: {
    marginTop: 3,
    fontSize: 10.5,
  },
  footerSummaryRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  footerSummaryCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 82,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  footerSummaryLabel: {
    fontSize: 11,
  },
  footerSummaryValue: {
    fontSize: 18,
  },
  emptyStateWrap: {
    flex: 1,
    paddingHorizontal: 18,
  },
  emptyStateCard: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 18,
    padding: 22,
    alignItems: "center",
    gap: 8,
  },
  emptyStateTitle: {
    fontSize: 18,
  },
  emptyStateBody: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
});

