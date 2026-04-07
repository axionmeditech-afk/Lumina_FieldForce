import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import Animated, {
  Extrapolation,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  FadeInUp,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
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
  getExpenses,
  getNotificationsForCurrentUser,
  STORAGE_KEYS,
  getSupportThreadsForCurrentUser,
  getTasks,
  getTeams,
  subscribeStorageUpdates,
} from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
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
import { canAccessSalesModule, isSalesRole } from "@/lib/role-access";

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

type DashboardSection =
  | {
      id: string;
      kind: "metrics" | "quickLinks" | "support";
      title: string;
      subtitle: string;
      delay: number;
    }
  | {
      id: string;
      kind: "visits" | "pulse" | "activity" | "footer";
      title?: string;
      subtitle?: string;
      delay: number;
    };

const LATE_THRESHOLD_HOUR = 9;
const LATE_THRESHOLD_MINUTE = 45;
const DASHBOARD_POLL_INTERVAL_MS = 15_000;
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

function normalizeIdentity(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

function hasOpenAttendanceSession(
  records: AttendanceRecord[],
  userId?: string | null,
  userName?: string | null
): boolean {
  const normalizedUserName = normalizeIdentity(userName);
  const latest = records
    .filter(
      (entry) =>
        (userId && entry.userId === userId) ||
        (normalizedUserName.length > 0 && normalizeIdentity(entry.userName) === normalizedUserName)
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return latest?.type === "checkin";
}

function getTaskLabel(task: Task): string {
  return task.visitLocationLabel?.trim() || task.title.trim() || "Field visit";
}

function getGreetingLabel(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function getUserInitials(name?: string | null): string {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return "LF";
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "LF";
}

function getSectionEyebrow(sectionId: DashboardSection["id"], isSalesperson: boolean): string {
  switch (sectionId) {
    case "metrics":
      return isSalesperson ? "TODAY" : "OVERVIEW";
    case "visits":
      return "FIELD FLOW";
    case "pulse":
      return "OPERATIONS";
    case "quick_links":
      return "WORKSPACE";
    case "support":
      return "SUPPORT";
    case "activity":
      return "LIVE LOG";
    case "footer":
      return "SUMMARY";
    default:
      return "";
  }
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
  const isSalesperson = isSalesRole(userRole);
  const links: QuickLink[] = [];

  if (canAccessSalesModule(userRole)) {
    links.push({
      id: "sales",
      title: "Sales",
      subtitle: "Conversation intelligence",
      icon: "trending-up-outline",
      color: "#2F7AF8",
      route: "/(tabs)/sales",
    });
  }

  links.push({
    id: "attendance",
    title: "Attendance",
    subtitle: "Check-ins and approvals",
    icon: "time-outline",
    color: colors.primary,
    route: "/(tabs)/attendance",
  });

  if (!isSalesperson) {
    links.push({
      id: "team",
      title: "Team",
      subtitle: "Member status and ownership",
      icon: "people-outline",
      color: colors.secondary,
      route: "/(tabs)/team",
    });
  }

  links.push(
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
    }
  );

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
  const [clockNow, setClockNow] = useState(() => new Date());
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
  const [, setLastSyncedAt] = useState<string | null>(null);
  const inFlightLoadRef = useRef<Promise<void> | null>(null);

  useLenisScrollEngine(scrollRef);

  const scrollY = useSharedValue(0);

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
        setClockNow(new Date());
        void loadDashboard();
      }
    });
    return () => {
      appStateSubscription.remove();
    };
  }, [loadDashboard]);

  useEffect(() => {
    const intervalId = setInterval(() => {
      setClockNow(new Date());
    }, 30_000);
    return () => {
      clearInterval(intervalId);
    };
  }, []);

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

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadDashboard();
    } finally {
      setRefreshing(false);
    }
  }, [loadDashboard]);

  const snapshot = useMemo<DashboardSnapshot>(() => {
    const todayKey = toLocalDateKey(clockNow);
    const employeeRoster = employees.filter((employee) => employee.role !== "admin");
    const validAttendance = attendance.filter((record) => record.approvalStatus !== "rejected");
    const checkedInNowCount = employeeRoster.filter((employee) =>
      hasOpenAttendanceSession(validAttendance, employee.id, employee.name)
    ).length;
    const todayRecords = validAttendance.filter(
      (record) => toLocalDateKey(new Date(record.timestamp)) === todayKey
    );
    const todayCheckins = todayRecords.filter((record) => record.type === "checkin");
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
      (record) =>
        record.type === "checkin" &&
        record.approvalStatus === "pending"
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
      totalEmployees: employeeRoster.length,
      presentToday: checkedInNowCount,
      lateToday,
      onLeave: Math.max(employeeRoster.length - checkedInNowCount, 0),
      activeNow: employeeRoster.filter((employee) => employee.status === "active").length,
      idleNow: employeeRoster.filter((employee) => employee.status === "idle").length,
      offlineNow: employeeRoster.filter((employee) => employee.status === "offline").length,
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
  }, [attendance, clockNow, conversations, employees, expenses, notifications, supportThreads, tasks, user]);

  const isSalesperson = isSalesRole(user?.role);
  const todayKey = useMemo(() => toLocalDateKey(clockNow), [clockNow]);
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
  const userPendingExpenses = useMemo(() => {
    if (!user) return 0;
    return expenses.filter((expense) => expense.userId === user.id && expense.status === "pending")
      .length;
  }, [expenses, user]);

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
              label: "Checked In Now",
              value: `${snapshot.presentToday}/${snapshot.totalEmployees || 0}`,
              hint: `${snapshot.presentToday} open attendance sessions`,
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
  const currentDateLabel = useMemo(
    () =>
      clockNow.toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [clockNow]
  );
  const greeting = useMemo(() => getGreetingLabel(), [clockNow]);
  const heroEmailText = useMemo(() => {
    const email = user?.email?.trim();
    if (email) {
      return email;
    }
    return "@lumina.app";
  }, [user?.email]);
  const heroInsights = useMemo(
    () => [
      {
        id: "active_now",
        value: `${snapshot.activeNow}`,
        label: "Live now",
      },
      {
        id: "checked_in",
        value: `${snapshot.presentToday}`,
        label: "Checked in",
      },
      {
        id: "visits_scheduled",
        value: todaysVisits.length === 0 ? "NO" : "YES",
        label: "Visits scheduled",
      },
    ],
    [snapshot.activeNow, snapshot.presentToday, todaysVisits.length]
  );

  const dashboardSections = useMemo<DashboardSection[]>(
    () =>
      isSalesperson
        ? [
            {
              id: "metrics",
              kind: "metrics",
              title: "My Progress",
              subtitle: "Today's visits, tasks, and alerts",
              delay: 40,
            },
            {
              id: "visits",
              kind: "visits",
              title: "Today's Visits",
              subtitle: "Your field stops and route flow",
              delay: 120,
            },
            {
              id: "quick_links",
              kind: "quickLinks",
              title: "My Shortcuts",
              subtitle: "Tools you use every day",
              delay: 170,
            },
            {
              id: "support",
              kind: "support",
              title: "My Support",
              subtitle: "Your open requests and updates",
              delay: 220,
            },
          ]
        : [
            {
              id: "metrics",
              kind: "metrics",
              title: "Live Metrics",
              subtitle: "Real-time operational health",
              delay: 40,
            },
            {
              id: "pulse",
              kind: "pulse",
              title: "Operational Pulse",
              subtitle: "Attendance + execution trend",
              delay: 120,
            },
            {
              id: "quick_links",
              kind: "quickLinks",
              title: "Quick Actions",
              subtitle: "Jump directly into modules",
              delay: 170,
            },
            {
              id: "support",
              kind: "support",
              title: "Support Priority",
              subtitle: "Open threads requiring attention",
              delay: 220,
            },
            {
              id: "activity",
              kind: "activity",
              title: "Activity Timeline",
              subtitle: "Latest actions across operations",
              delay: 260,
            },
            {
              id: "footer",
              kind: "footer",
              delay: 300,
            },
          ],
    [isSalesperson]
  );
  const metricsSection = dashboardSections.find((section) => section.kind === "metrics") ?? null;
  const visitsSection = dashboardSections.find((section) => section.kind === "visits") ?? null;
  const pulseSection = dashboardSections.find((section) => section.kind === "pulse") ?? null;
  const quickLinksSection =
    dashboardSections.find((section) => section.kind === "quickLinks") ?? null;
  const supportSection = dashboardSections.find((section) => section.kind === "support") ?? null;
  const activitySection = dashboardSections.find((section) => section.kind === "activity") ?? null;
  const footerSection = dashboardSections.find((section) => section.kind === "footer") ?? null;

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
            paddingTop: 0,
            paddingBottom: Math.max(insets.bottom, 20) + 28,
          },
        ]}
      >
        <Animated.View entering={FadeInUp.duration(420)} style={[styles.heroWrap, heroAnimatedStyle]}>
          <LinearGradient
            colors={
              isDark
                ? ["#182338", "#111A2F", "#0E1628"]
                : ["#FFFFFF", "#FBFAFF", "#F6F8FF"]
            }
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[
              styles.heroCard,
              {
                borderColor: isDark ? colors.border : "rgba(15, 23, 42, 0.07)",
                paddingTop: insets.top + 10,
              },
            ]}
            >
              <LinearGradient
                pointerEvents="none"
              colors={
                isDark
                  ? ["rgba(59,130,246,0.28)", "rgba(99,102,241,0.14)"]
                  : ["#6A63FF", "#2FA3F6"]
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0.9 }}
              style={styles.heroTopCap}
            />
            <View
              pointerEvents="none"
              style={[styles.heroGridOverlay, { borderColor: isDark ? `${colors.backgroundElevated}24` : "rgba(15, 23, 42, 0.04)" }]}
            />
            <View style={styles.heroHeaderRow}>
              <DrawerToggleButton iconColor="#FFFFFF" iconSize={34} style={{ marginTop: 2 }} />
              <View style={styles.heroHeaderMeta}>
                <View
                  style={[
                    styles.heroDateChip,
                    {
                      backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.18)",
                      borderColor: isDark ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.22)",
                    },
                  ]}
                >
                  <Ionicons name="calendar-outline" size={13} color="#E8F4FF" />
                  <Text style={[styles.heroDateText, { color: "#E8F4FF" }]}>
                    {currentDateLabel}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.heroProfileStack}>
              <Pressable
                onPress={() => router.push("/settings")}
                style={[
                  styles.heroAvatarWrap,
                  {
                    backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#FFFFFF",
                    borderColor: isDark ? "rgba(255,255,255,0.14)" : "rgba(15, 23, 42, 0.06)",
                  },
                ]}
              >
                {user.avatar ? (
                  <Image source={{ uri: user.avatar }} style={styles.heroAvatarImage} />
                ) : (
                  <Text style={[styles.heroAvatarFallback, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {getUserInitials(user.name)}
                  </Text>
                )}
              </Pressable>
              <Text style={[styles.heroGreetingText, { color: isDark ? "#8FB9FF" : colors.textTertiary }]}>
                {greeting}
              </Text>
              <Text style={[styles.heroTitleText, { color: colors.text }]} numberOfLines={1}>
                {user.name}
              </Text>
              <Text style={[styles.heroHandleText, { color: colors.textTertiary }]}>
                {heroEmailText}
              </Text>
            </View>

            <View
              style={[
                styles.heroInsightRow,
                isDark
                  ? {
                      backgroundColor: "rgba(255,255,255,0.04)",
                      borderColor: "rgba(255,255,255,0.06)",
                    }
                  : styles.heroInsightRowLight,
              ]}
            >
              {heroInsights.map((item, index) => (
                <React.Fragment key={item.id}>
                  <View style={styles.heroInsightItem}>
                    <Text style={[styles.heroInsightValue, { color: colors.text }]}>{item.value}</Text>
                    <Text style={[styles.heroInsightLabel, { color: colors.textSecondary }]}>{item.label}</Text>
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
                    isDark
                      ? {
                          borderColor: `${highlight.tone}38`,
                          backgroundColor: "rgba(255,255,255,0.06)",
                        }
                      : {
                          borderColor: `${highlight.tone}20`,
                          backgroundColor: "#FFFFFF",
                        },
                  ]}
                >
                  <View style={[styles.commandStripIcon, { backgroundColor: `${highlight.tone}14` }]}>
                    <Ionicons name={highlight.icon} size={16} color={highlight.tone} />
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
          </LinearGradient>
        </Animated.View>

        {metricsSection ? (
        <Animated.View entering={FadeInDown.duration(420).delay(metricsSection.delay)} style={styles.sectionWrap}>
          <View style={styles.sectionHeaderRow}>
            <View style={styles.sectionHeaderContent}>
              <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                {getSectionEyebrow(metricsSection.id, isSalesperson)}
              </Text>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {metricsSection.title}
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {metricsSection.subtitle}
              </Text>
            </View>
            <View style={[styles.sectionActionChip, { backgroundColor: isDark ? colors.surface : "#FFFFFF", borderColor: colors.border }]}>
              <Text style={[styles.sectionActionText, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                This Week
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
            </View>
          </View>
          <View style={styles.metricGrid}>
            {metricCards.map((card, index) => (
              <Animated.View
                key={card.id}
                entering={FadeInDown.duration(340).delay(metricsSection.delay + 40 + index * 30)}
                style={[
                  styles.metricCard,
                  {
                    borderColor: isDark ? `${card.tone}24` : "transparent",
                    backgroundColor:
                      isDark
                        ? colors.backgroundElevated
                        : ["#EEEDFF", "#FFF2E7", "#E7F6FF", "#ECFAEF"][index % 4],
                  },
                ]}
              >
                <View style={[styles.metricCardGlow, { backgroundColor: isDark ? `${card.tone}14` : `${card.tone}10` }]} />
                <View style={styles.metricHeader}>
                  <Text style={[styles.metricLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    {card.label}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                </View>
                <Text style={[styles.metricValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  {card.value}
                </Text>
                <Text style={[styles.metricHint, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                  {card.hint}
                </Text>
                <View style={[styles.metricAccentTrack, { backgroundColor: "transparent" }]}>
                  <View style={[styles.metricAccentFill, { backgroundColor: `${card.tone}22` }]} />
                </View>
              </Animated.View>
            ))}
          </View>
        </Animated.View>
        ) : null}

        {visitsSection ? (
          <Animated.View
            entering={FadeInDown.duration(420).delay(visitsSection.delay)}
            style={[
              styles.sectionCard,
              { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
            ]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.primary}26` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                {getSectionEyebrow(visitsSection.id, isSalesperson)}
              </Text>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {visitsSection.title}
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {visitsSection.subtitle}
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
        ) : pulseSection ? (
          <Animated.View
            entering={FadeInDown.duration(420).delay(pulseSection.delay)}
            style={[
              styles.pulseCard,
              { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
            ]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.primary}26` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                {getSectionEyebrow(pulseSection.id, isSalesperson)}
              </Text>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {pulseSection.title}
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {pulseSection.subtitle}
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
        ) : null}

        {quickLinksSection ? (
        <Animated.View entering={FadeInDown.duration(420).delay(quickLinksSection.delay)} style={styles.sectionWrap}>
          <View style={styles.sectionHeaderRow}>
            <View style={styles.sectionHeaderContent}>
              <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                {getSectionEyebrow(quickLinksSection.id, isSalesperson)}
              </Text>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {quickLinksSection.title}
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {quickLinksSection.subtitle}
              </Text>
            </View>
            <View style={[styles.sectionActionChip, { backgroundColor: isDark ? colors.surface : "#FFFFFF", borderColor: colors.border }]}>
              <Text style={[styles.sectionActionText, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                All
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.textSecondary} />
            </View>
          </View>

          <View style={styles.quickGrid}>
            {quickLinks.map((link) => (
              <Pressable
                key={link.id}
                onPress={() => router.push(link.route as never)}
                style={[
                  styles.quickCard,
                  {
                    borderColor: isDark ? colors.border : "rgba(15, 23, 42, 0.05)",
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
        ) : null}

        {supportSection ? (
        <Animated.View
          entering={FadeInDown.duration(420).delay(supportSection.delay)}
          style={[styles.sectionCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
        >
          <View style={[styles.cardSheen, { backgroundColor: `${colors.warning}24` }]} />
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
              {getSectionEyebrow(supportSection.id, isSalesperson)}
            </Text>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {supportSection.title}
            </Text>
            <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {supportSection.subtitle}
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
        ) : null}

        {activitySection ? (
          <Animated.View
            entering={FadeInDown.duration(420).delay(activitySection.delay)}
            style={[styles.sectionCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
          >
            <View style={[styles.cardSheen, { backgroundColor: `${colors.secondary}24` }]} />
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionEyebrow, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                {getSectionEyebrow(activitySection.id, isSalesperson)}
              </Text>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {activitySection.title}
              </Text>
              <Text style={[styles.sectionCaption, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {activitySection.subtitle}
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

        {footerSection ? (
          <Animated.View entering={FadeInDown.duration(420).delay(footerSection.delay)} style={styles.footerSummaryRow}>
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
    width: "100%",
    maxWidth: 1060,
    alignSelf: "center",
    paddingHorizontal: 18,
  },
  heroWrap: {
    marginHorizontal: -18,
    marginBottom: 14,
  },
  heroCard: {
    borderRadius: 0,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 16,
    borderWidth: 0,
    position: "relative",
    overflow: "hidden",
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
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
  heroOrb: {
    position: "absolute",
    width: 150,
    height: 150,
    borderRadius: 999,
  },
  heroOrbLeft: {
    top: -56,
    left: -34,
  },
  heroOrbRight: {
    right: -44,
    bottom: -74,
  },
  heroShimmer: {
    position: "absolute",
    width: 180,
    height: 220,
    top: -60,
    borderRadius: 40,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  heroGridOverlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 0,
    borderRadius: 0,
  },
  heroHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginTop: 2,
    marginBottom: 6,
    gap: 8,
  },
  heroHeaderMeta: {
    alignItems: "flex-end",
    gap: 8,
  },
  heroDateChip: {
    minHeight: 36,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 2,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroDateText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11.8,
    letterSpacing: 0.2,
  },
  heroRoleChip: {
    minHeight: 38,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 2,
    paddingHorizontal: 9,
    justifyContent: "space-between",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  heroRoleText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11.8,
    letterSpacing: -0.15,
  },
  heroRoleCountChip: {
    minWidth: 26,
    height: 24,
    borderRadius: 999,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  heroRoleCountText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11.5,
    letterSpacing: -0.15,
  },
  heroGreetingText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12.5,
    letterSpacing: 0.2,
    textAlign: "center",
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
    letterSpacing: -0.8,
  },
  heroTitleText: {
    marginTop: 2,
    fontFamily: "Inter_700Bold",
    fontSize: 31,
    letterSpacing: -1.2,
    textAlign: "center",
  },
  heroHandleText: {
    marginTop: 4,
    fontFamily: "Inter_500Medium",
    fontSize: 13.5,
    letterSpacing: -0.2,
    textAlign: "center",
  },
  heroSubtitleText: {
    marginTop: 6,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
    maxWidth: "84%",
    textAlign: "center",
  },
  heroInsightRow: {
    marginTop: 18,
    minHeight: 58,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(148,163,184,0.10)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.56)",
  },
  heroInsightRowLight: {
    backgroundColor: "rgba(255,255,255,0.72)",
    borderColor: "rgba(15, 23, 42, 0.06)",
  },
  heroInsightItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  heroInsightValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    letterSpacing: -0.7,
  },
  heroInsightLabel: {
    marginTop: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 10.8,
    textAlign: "center",
  },
  heroDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  heroBadgeRow: {
    marginTop: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  heroBadge: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  heroBadgeText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  commandStripRow: {
    marginTop: 18,
    marginBottom: 2,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
  },
  commandStripCard: {
    width: "48.2%",
    minHeight: 88,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    overflow: "hidden",
  },
  commandStripIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  commandStripValue: {
    fontSize: 22,
    letterSpacing: -0.8,
  },
  commandStripLabel: {
    marginTop: 4,
    fontSize: 12.2,
    lineHeight: 17,
  },
  sectionWrap: {
    marginTop: 2,
    marginBottom: 14,
  },
  sectionHeader: {
    marginBottom: 10,
  },
  sectionHeaderRow: {
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionHeaderContent: {
    flex: 1,
  },
  sectionEyebrow: {
    marginBottom: 4,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  sectionTitle: {
    fontSize: 18,
    letterSpacing: -0.5,
  },
  sectionCaption: {
    marginTop: 3,
    fontSize: 12.8,
  },
  sectionActionChip: {
    minHeight: 40,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    shadowColor: "#0F172A",
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  sectionActionText: {
    fontSize: 12.5,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 12,
  },
  metricCard: {
    width: "48.2%",
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 132,
    position: "relative",
    overflow: "hidden",
    shadowColor: "#13263F",
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  metricCardGlow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 48,
  },
  metricHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  metricLabel: {
    fontSize: 13.2,
    flex: 1,
  },
  metricValue: {
    marginTop: 18,
    fontSize: 34,
    letterSpacing: -1.2,
  },
  metricHint: {
    marginTop: 5,
    fontSize: 12.2,
    lineHeight: 17.5,
  },
  metricAccentTrack: {
    marginTop: 10,
    width: "100%",
    height: 28,
    borderRadius: 999,
    overflow: "hidden",
    justifyContent: "center",
  },
  metricAccentFill: {
    width: "32%",
    height: 8,
    borderRadius: 999,
    alignSelf: "flex-end",
  },
  pulseCard: {
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 16,
    marginBottom: 12,
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
    marginBottom: 14,
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
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
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
    fontSize: 18,
  },
  quickGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 12,
    },
  quickCard: {
    width: "48.4%",
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 126,
    shadowColor: "#13263F",
    shadowOpacity: 0.06,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  quickCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  quickIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
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
    marginTop: 14,
    fontSize: 15.5,
    letterSpacing: -0.4,
  },
  quickSubtitle: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17.5,
  },
  sectionCard: {
    borderRadius: 26,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 15,
    paddingBottom: 12,
    marginBottom: 12,
    overflow: "hidden",
    shadowColor: "#13263F",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 2,
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
    marginTop: 12,
    borderRadius: 16,
    minHeight: 48,
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
    gap: 10,
    paddingVertical: 12,
  },
  threadStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  threadTitle: {
    fontSize: 13,
  },
  threadMeta: {
    marginTop: 2,
    fontSize: 11.5,
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
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  activityIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
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
    fontSize: 13,
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
    fontSize: 11.7,
    lineHeight: 17.5,
  },
  activityTime: {
    marginTop: 3,
    fontSize: 10.5,
  },
  footerSummaryRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  footerSummaryCard: {
    flex: 1,
    borderRadius: 22,
    borderWidth: 1,
    minHeight: 98,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
  },
  footerSummaryLabel: {
    fontSize: 11,
  },
  footerSummaryValue: {
    fontSize: 18,
  },
  emptyStateWrap: {
    flex: 1,
    paddingHorizontal: 20,
  },
  emptyStateCard: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
    gap: 10,
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

