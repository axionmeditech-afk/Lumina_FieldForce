import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useFocusEffect } from "expo-router";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import {
  addAuditLog,
  addNotification,
  createCompanyProfile,
  getAllEmployees,
  getCompanyNotifications,
  getCompanyProfiles,
  getStockists,
  getSettings,
  getUserAccessRequests,
  removeCompanyProfile,
  reviewUserAccessRequest,
  updateSettings,
} from "@/lib/storage";
import type {
  AppNotification,
  CompanyProfile,
  Employee,
  NotificationAudience,
  StockistProfile,
  UserRole,
  UserAccessRequest,
} from "@/lib/types";
import { canAccessAdminControls, isSalesRole } from "@/lib/role-access";
import {
  getAdminAccessRequests,
  reviewAdminAccessRequest,
  syncApprovedEmployeeToDolibarr,
} from "@/lib/attendance-api";

const ASSIGNABLE_ACCESS_ROLES: UserRole[] = ["salesperson", "employee", "manager", "hr"];

function normalizeEmailKey(value: string): string {
  return value.trim().toLowerCase();
}

function mergePendingRequests(
  localRequests: UserAccessRequest[],
  remoteRequests: UserAccessRequest[]
): UserAccessRequest[] {
  const byEmail = new Map<string, UserAccessRequest>();
  for (const request of localRequests) {
    byEmail.set(normalizeEmailKey(request.email), request);
  }
  for (const request of remoteRequests) {
    // Remote should win so cross-device review uses server request ids.
    byEmail.set(normalizeEmailKey(request.email), request);
  }
  return Array.from(byEmail.values()).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

function normalizeDolibarrWarning(message: string): string {
  const raw = (message || "").trim();
  if (!raw) {
    return "Could not sync employee to Dolibarr HRM.";
  }
  const plain = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const merged = plain || raw;
  if (/cannot post\s*\/api\/integrations\/dolibarr\/hrm\/sync-employee/i.test(merged)) {
    return "Backend Dolibarr sync route is missing. Configure the Dolibarr endpoint and API key in Settings to use direct sync.";
  }
  if (
    /backend request failed/i.test(merged) ||
    /network request failed/i.test(merged) ||
    /failed to fetch/i.test(merged)
  ) {
    return "Backend is not reachable from this device. Use the public API domain in Settings > Backend API URL (example: https://api.yourdomain.com) and ensure the server is reachable.";
  }
  return merged;
}

export default function AdminControlsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user, refreshSession } = useAuth();
  const [recentNotifications, setRecentNotifications] = useState<AppNotification[]>([]);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [managerEmployees, setManagerEmployees] = useState<Employee[]>([]);
  const [companyStockists, setCompanyStockists] = useState<StockistProfile[]>([]);
  const [pendingAccessRequests, setPendingAccessRequests] = useState<UserAccessRequest[]>([]);
  const [selectedCompanyIdsByRequest, setSelectedCompanyIdsByRequest] = useState<
    Record<string, string[]>
  >({});
  const [selectedRoleByRequest, setSelectedRoleByRequest] = useState<Record<string, UserRole>>({});
  const [selectedManagerIdByRequest, setSelectedManagerIdByRequest] = useState<
    Record<string, string>
  >({});
  const [selectedStockistIdByRequest, setSelectedStockistIdByRequest] = useState<
    Record<string, string>
  >({});
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyBranch, setNewCompanyBranch] = useState("");
  const [newCompanyHeadquarters, setNewCompanyHeadquarters] = useState("");
  const [annTitle, setAnnTitle] = useState("");
  const [annBody, setAnnBody] = useState("");
  const [audience, setAudience] = useState<NotificationAudience>("all");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [locationTracking, setLocationTracking] = useState(true);
  const [autoSync, setAutoSync] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [busySavePolicy, setBusySavePolicy] = useState(false);
  const [busyAnnouncement, setBusyAnnouncement] = useState(false);
  const [busyCreateCompany, setBusyCreateCompany] = useState(false);
  const [busyDeleteCompanyId, setBusyDeleteCompanyId] = useState<string | null>(null);
  const [busyAccessRequestId, setBusyAccessRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canAccess = canAccessAdminControls(user?.role);

  const loadData = useCallback(async () => {
    const [
      settings,
      notifications,
      companies,
      localPendingRequests,
      allEmployees,
      stockists,
      remotePendingRequests,
    ] = await Promise.all([
      getSettings(),
      getCompanyNotifications(),
      getCompanyProfiles(),
      getUserAccessRequests("pending"),
      getAllEmployees(),
      getStockists({ scope: "accessible", refreshRemote: true }),
      getAdminAccessRequests("pending").catch(() => []),
    ]);
    const pendingRequests = mergePendingRequests(localPendingRequests, remotePendingRequests);

    setNotificationsEnabled(settings.notifications !== "false");
    setLocationTracking(settings.locationTracking !== "false");
    setAutoSync(settings.autoSync !== "false");
    setOfflineMode(settings.offlineMode === "true");
    setRecentNotifications(
      notifications
        .filter((item) => item.kind === "announcement" || item.kind === "policy")
        .slice(0, 10)
    );
    setCompanyProfiles(companies);
    setManagerEmployees(allEmployees.filter((employee) => employee.role === "manager"));
    setCompanyStockists(stockists);
    setPendingAccessRequests(pendingRequests);
    setSelectedRoleByRequest((current) => {
      const next = { ...current };
      let changed = false;
      for (const request of pendingRequests) {
        if (next[request.id]) continue;
        next[request.id] = request.approvedRole || request.requestedRole;
        changed = true;
      }
      for (const requestId of Object.keys(next)) {
        const stillPending = pendingRequests.some((request) => request.id === requestId);
        if (!stillPending) {
          delete next[requestId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    const validCompanyIds = new Set(companies.map((company) => company.id));
    setSelectedCompanyIdsByRequest((current) => {
      const next = { ...current };
      let changed = false;

      for (const [requestId, companyIds] of Object.entries(next)) {
        if (!companyIds?.length) continue;
        const filtered = companyIds.filter((companyId) => validCompanyIds.has(companyId));
        if (filtered.length !== companyIds.length) {
          next[requestId] = filtered;
          changed = true;
        }
      }

      for (const request of pendingRequests) {
        if (next[request.id]?.length) continue;
        const matchingCompanyId = request.requestedCompanyName
          ? companies.find(
              (company) =>
                company.name.toLowerCase() === request.requestedCompanyName?.toLowerCase()
            )?.id
          : undefined;
        next[request.id] = matchingCompanyId ? [matchingCompanyId] : [];
        changed = true;
      }

      for (const requestId of Object.keys(next)) {
        const stillPending = pendingRequests.some((request) => request.id === requestId);
        if (!stillPending) {
          delete next[requestId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setSelectedStockistIdByRequest((current) => {
      const next = { ...current };
      let changed = false;
      for (const request of pendingRequests) {
        if (next[request.id] !== undefined) continue;
        next[request.id] = request.assignedStockistId || "";
        changed = true;
      }
      for (const requestId of Object.keys(next)) {
        const stillPending = pendingRequests.some((request) => request.id === requestId);
        if (!stillPending) {
          delete next[requestId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const getManagersForRequest = useCallback(
    (requestId: string): Employee[] => {
      const selectedCompanyIds = selectedCompanyIdsByRequest[requestId] || [];
      if (!selectedCompanyIds.length) return managerEmployees;
      return managerEmployees.filter((manager) => selectedCompanyIds.includes(manager.companyId));
    },
    [managerEmployees, selectedCompanyIdsByRequest]
  );

  const getStockistsForRequest = useCallback(
    (requestId: string): StockistProfile[] => {
      const selectedCompanyIds = selectedCompanyIdsByRequest[requestId] || [];
      if (!selectedCompanyIds.length) return companyStockists;
      return companyStockists.filter((stockist) =>
        stockist.companyId ? selectedCompanyIds.includes(stockist.companyId) : true
      );
    },
    [companyStockists, selectedCompanyIdsByRequest]
  );

  useEffect(() => {
    if (!pendingAccessRequests.length) {
      setSelectedManagerIdByRequest({});
      return;
    }

    setSelectedManagerIdByRequest((current) => {
      const next = { ...current };
      let changed = false;

      for (const request of pendingAccessRequests) {
        const eligibleManagers = getManagersForRequest(request.id);
        const currentSelection = next[request.id] || "";
        const currentIsValid = eligibleManagers.some((manager) => manager.id === currentSelection);
        if (currentIsValid) continue;

        const requestAssignedManagerId = (request.assignedManagerId || "").trim();
        const requestAssignedIsValid = eligibleManagers.some(
          (manager) => manager.id === requestAssignedManagerId
        );

        const fallbackManagerId = requestAssignedIsValid
          ? requestAssignedManagerId
          : eligibleManagers[0]?.id || "";
        if (next[request.id] !== fallbackManagerId) {
          next[request.id] = fallbackManagerId;
          changed = true;
        }
      }

      for (const requestId of Object.keys(next)) {
        const stillPending = pendingAccessRequests.some((request) => request.id === requestId);
        if (!stillPending) {
          delete next[requestId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [getManagersForRequest, pendingAccessRequests]);

  useEffect(() => {
    if (!pendingAccessRequests.length) {
      setSelectedStockistIdByRequest({});
      return;
    }

    setSelectedStockistIdByRequest((current) => {
      const next = { ...current };
      let changed = false;

      for (const request of pendingAccessRequests) {
        const availableStockists = getStockistsForRequest(request.id);
        const currentSelection = next[request.id] ?? "";
        const isValidSelection =
          !currentSelection || availableStockists.some((stockist) => stockist.id === currentSelection);
        if (!isValidSelection) {
          next[request.id] = "";
          changed = true;
        }
        if (next[request.id] === undefined) {
          next[request.id] = request.assignedStockistId || "";
          changed = true;
        }
      }

      for (const requestId of Object.keys(next)) {
        const stillPending = pendingAccessRequests.some((request) => request.id === requestId);
        if (!stillPending) {
          delete next[requestId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [getStockistsForRequest, pendingAccessRequests]);

  const handleSavePolicy = useCallback(async () => {
    if (!user || busySavePolicy) return;
    setBusySavePolicy(true);
    try {
      await updateSettings({
        notifications: notificationsEnabled ? "true" : "false",
        locationTracking: locationTracking ? "true" : "false",
        autoSync: autoSync ? "true" : "false",
        offlineMode: offlineMode ? "true" : "false",
      });
      await addAuditLog({
        id: `audit_admin_policy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: user.id,
        userName: user.name,
        action: "Admin Policy Updated",
        details:
          `notifications=${notificationsEnabled}, locationTracking=${locationTracking}, ` +
          `autoSync=${autoSync}, offlineMode=${offlineMode}`,
        timestamp: new Date().toISOString(),
        module: "Admin Controls",
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } finally {
      setBusySavePolicy(false);
      await loadData();
    }
  }, [
    autoSync,
    busySavePolicy,
    loadData,
    locationTracking,
    notificationsEnabled,
    offlineMode,
    user,
  ]);

  const handleSendAnnouncement = useCallback(async () => {
    if (!user || busyAnnouncement || !annTitle.trim() || !annBody.trim()) return;
    setBusyAnnouncement(true);
    try {
      const now = new Date().toISOString();
      await addNotification({
        id: `notif_admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: annTitle.trim(),
        body: annBody.trim(),
        kind: "announcement",
        audience,
        createdById: user.id,
        createdByName: user.name,
        createdAt: now,
      });
      await addAuditLog({
        id: `audit_admin_announcement_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: user.id,
        userName: user.name,
        action: "Announcement Sent",
        details: `Audience=${audience}, Title=${annTitle.trim()}`,
        timestamp: now,
        module: "Admin Controls",
      });
      setAnnTitle("");
      setAnnBody("");
      setAudience("all");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadData();
    } finally {
      setBusyAnnouncement(false);
    }
  }, [annBody, annTitle, audience, busyAnnouncement, loadData, user]);

  const handleCreateCompany = useCallback(async () => {
    if (!user || busyCreateCompany) return;
    const name = newCompanyName.trim();
    if (!name) {
      Alert.alert("Company Name Required", "Please enter company name.");
      return;
    }

    setBusyCreateCompany(true);
    try {
      const created = await createCompanyProfile({
        name,
        primaryBranch: newCompanyBranch.trim() || "Main Branch",
        headquarters: newCompanyHeadquarters.trim() || "India",
      });
      if (!created) {
        Alert.alert("Unable to Create", "Company profile could not be created.");
        return;
      }
      await addAuditLog({
        id: `audit_admin_company_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: user.id,
        userName: user.name,
        action: "Company Environment Created",
        details: `${created.name} (${created.primaryBranch})`,
        timestamp: new Date().toISOString(),
        module: "Admin Controls",
      });
      setNewCompanyName("");
      setNewCompanyBranch("");
      setNewCompanyHeadquarters("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadData();
    } finally {
      setBusyCreateCompany(false);
    }
  }, [
    busyCreateCompany,
    loadData,
    newCompanyBranch,
    newCompanyHeadquarters,
    newCompanyName,
    user,
  ]);

  const handleDeleteCompany = useCallback(
    async (company: CompanyProfile) => {
      if (!user || busyDeleteCompanyId) return;
      if (companyProfiles.length <= 1) {
        Alert.alert("Cannot Delete", "At least one company environment is required.");
        return;
      }

      setBusyDeleteCompanyId(company.id);
      try {
        const removed = await removeCompanyProfile(company.id);
        if (!removed) {
          Alert.alert(
            "Unable to Delete",
            "This company environment cannot be deleted right now."
          );
          return;
        }
        await addAuditLog({
          id: `audit_admin_company_delete_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: "Company Environment Deleted",
          details: `${company.name} (${company.primaryBranch})`,
          timestamp: new Date().toISOString(),
          module: "Admin Controls",
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await Promise.all([loadData(), refreshSession()]);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete company environment.";
        Alert.alert("Delete Failed", message);
      } finally {
        setBusyDeleteCompanyId(null);
      }
    },
    [
      busyDeleteCompanyId,
      companyProfiles.length,
      loadData,
      refreshSession,
      user,
    ]
  );

  const confirmDeleteCompany = useCallback(
    (company: CompanyProfile) => {
      if (busyDeleteCompanyId) return;
      if (companyProfiles.length <= 1) {
        Alert.alert("Cannot Delete", "At least one company environment is required.");
        return;
      }
      Alert.alert(
        "Delete Company Environment",
        `Are you sure you want to delete ${company.name}? This will remove access for all assigned users.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => void handleDeleteCompany(company),
          },
        ]
      );
    },
    [busyDeleteCompanyId, companyProfiles.length, handleDeleteCompany]
  );

  const toggleCompanySelection = useCallback((requestId: string, companyId: string) => {
    setSelectedCompanyIdsByRequest((current) => {
      const selected = current[requestId] || [];
      const next = selected.includes(companyId)
        ? selected.filter((id) => id !== companyId)
        : [...selected, companyId];
      return { ...current, [requestId]: next };
    });
  }, []);

  const selectManagerForRequest = useCallback((requestId: string, managerId: string) => {
    setSelectedManagerIdByRequest((current) => ({
      ...current,
      [requestId]: managerId,
    }));
  }, []);

  const selectStockistForRequest = useCallback((requestId: string, stockistId: string) => {
    setSelectedStockistIdByRequest((current) => ({
      ...current,
      [requestId]: stockistId,
    }));
  }, []);

  const selectRoleForRequest = useCallback((requestId: string, role: UserRole) => {
    setSelectedRoleByRequest((current) => ({
      ...current,
      [requestId]: role,
    }));
  }, []);

  const removePendingRequestFromState = useCallback((requestId: string) => {
    setPendingAccessRequests((current) => current.filter((entry) => entry.id !== requestId));
    setSelectedRoleByRequest((current) => {
      if (!(requestId in current)) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
    setSelectedCompanyIdsByRequest((current) => {
      if (!(requestId in current)) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
    setSelectedManagerIdByRequest((current) => {
      if (!(requestId in current)) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
    setSelectedStockistIdByRequest((current) => {
      if (!(requestId in current)) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }, []);

  const handleReviewAccessRequest = useCallback(
    async (request: UserAccessRequest, action: "approved" | "rejected") => {
      if (!user || busyAccessRequestId) return;
      const selectedRole = selectedRoleByRequest[request.id] || request.requestedRole;
      const selectedCompanyIds = selectedCompanyIdsByRequest[request.id] || [];
      const selectedManagerId = (selectedManagerIdByRequest[request.id] || "").trim();
      const isSalesperson = isSalesRole(selectedRole);
      const selectedStockistId = (selectedStockistIdByRequest[request.id] || "").trim();
      const eligibleManagers = getManagersForRequest(request.id);
      const eligibleStockists = getStockistsForRequest(request.id);
      const selectedManager =
        !isSalesperson && selectedManagerId
          ? eligibleManagers.find((manager) => manager.id === selectedManagerId) || null
          : null;
      const selectedStockist =
        isSalesperson && selectedStockistId
          ? eligibleStockists.find((stockist) => stockist.id === selectedStockistId) || null
          : null;
      if (action === "approved" && selectedCompanyIds.length === 0) {
        Alert.alert("Select Companies", "Choose at least one company before approval.");
        return;
      }
      if (!isSalesperson && action === "approved" && selectedManagerId && !selectedManager) {
        Alert.alert("Invalid Manager", "Selected manager is not valid for this request.");
        return;
      }
      if (isSalesperson && action === "approved" && selectedStockistId && !selectedStockist) {
        Alert.alert("Invalid Channel Partner", "Selected channel partner is not valid.");
        return;
      }

      setBusyAccessRequestId(request.id);
      try {
        let remoteReviewError: Error | null = null;
        let remoteReviewed = false;
        try {
          await reviewAdminAccessRequest({
            requestId: request.id,
            action,
            role: selectedRole,
            companyIds: selectedCompanyIds,
            managerId: selectedManager?.id,
            managerName: selectedManager?.name,
            stockistId: selectedStockist?.id,
            stockistName: selectedStockist?.name,
          });
          remoteReviewed = true;
        } catch (error) {
          remoteReviewError =
            error instanceof Error ? error : new Error("Unable to review access request on backend.");
        }

        const localPendingRequests = await getUserAccessRequests("pending");
        const localMirrorRequest = localPendingRequests.find(
          (entry) => normalizeEmailKey(entry.email) === normalizeEmailKey(request.email)
        );

        let localReviewError: Error | null = null;
        let localReviewed = false;
        if (localMirrorRequest) {
          try {
            await reviewUserAccessRequest(
              localMirrorRequest.id,
              action,
              { id: user.id, name: user.name },
              {
                role: selectedRole,
                companyIds: selectedCompanyIds,
                managerId: selectedManager?.id,
                managerName: selectedManager?.name,
                stockistId: selectedStockist?.id,
                stockistName: selectedStockist?.name,
              }
            );
            localReviewed = true;
          } catch (error) {
            localReviewError =
              error instanceof Error
                ? error
                : new Error("Unable to review local access request mirror.");
          }
        }

        if (!remoteReviewed && !localReviewed) {
          throw remoteReviewError || localReviewError || new Error("Unable to review access request.");
        }

        removePendingRequestFromState(request.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        void addAuditLog({
          id: `audit_admin_access_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: action === "approved" ? "Access Request Approved" : "Access Request Rejected",
          details: `${request.name} (${request.email}) -> ${selectedRole.toUpperCase()}`,
          timestamp: new Date().toISOString(),
          module: "Admin Controls",
        }).catch(() => {});

        if (action === "approved") {
          void (async () => {
            try {
              const attemptSync = async () =>
                syncApprovedEmployeeToDolibarr({
                  name: request.name,
                  email: request.email,
                  role: selectedRole,
                  department: request.requestedDepartment,
                  branch: request.requestedBranch,
                  location: request.requestedBranch,
                  pincode: request.requestedPincode,
                });
              const firstAttempt = await attemptSync();
              if (!firstAttempt.ok) {
                await new Promise<void>((resolve) => setTimeout(resolve, 700));
                const secondAttempt = await attemptSync();
                if (!secondAttempt.ok) {
                  console.warn("Dolibarr employee sync failed after approval", {
                    firstAttempt,
                    secondAttempt,
                  });
                }
              }
            } catch (error) {
              console.warn("Dolibarr employee sync failed after approval", error);
            }
          })();
        }

        void loadData();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to review access request.";
        Alert.alert("Review Failed", message);
      } finally {
        setBusyAccessRequestId(null);
      }
    },
    [
      busyAccessRequestId,
      getManagersForRequest,
      getStockistsForRequest,
      loadData,
      removePendingRequestFromState,
      selectedCompanyIdsByRequest,
      selectedRoleByRequest,
      selectedManagerIdByRequest,
      selectedStockistIdByRequest,
      user,
    ]
  );

  const pendingCountLabel = useMemo(
    () => `${pendingAccessRequests.length} pending`,
    [pendingAccessRequests.length]
  );

  if (!canAccess) {
    return (
      <AppCanvas>
        <View style={[styles.lockedWrap, { paddingTop: insets.top + 16 }]}>
          <View style={styles.navToggleWrap}>
            <DrawerToggleButton />
          </View>
          <View
            style={[
              styles.lockedCard,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
            ]}
          >
            <Ionicons name="lock-closed-outline" size={42} color={colors.warning} />
            <Text style={[styles.lockedTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Admin Controls Restricted
            </Text>
            <Text style={[styles.lockedText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              This section is available only for admin role.
            </Text>
          </View>
        </View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInDown.duration(400)} style={styles.headerWrap}>
          <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            Admin Controls
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            Manage company environments, approvals, announcements, and policy controls.
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(40)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Company Environments
          </Text>
          <View style={styles.companyListWrap}>
            {companyProfiles.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No company environments available.</Text>
            ) : (
              companyProfiles.map((company) => (
                <View
                  key={company.id}
                  style={[
                    styles.companyRow,
                    { borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.companyName, { color: colors.text }]}>{company.name}</Text>
                    <Text style={[styles.companyMeta, { color: colors.textSecondary }]}>
                      {company.primaryBranch} | {company.headquarters}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => confirmDeleteCompany(company)}
                    disabled={busyDeleteCompanyId === company.id}
                    style={[
                      styles.companyDeleteButton,
                      {
                        borderColor: colors.danger,
                        backgroundColor: colors.danger + "12",
                      },
                    ]}
                  >
                    {busyDeleteCompanyId === company.id ? (
                      <ActivityIndicator size="small" color={colors.danger} />
                    ) : (
                      <Ionicons
                        name="trash-outline"
                        size={16}
                        color={colors.danger}
                      />
                    )}
                  </Pressable>
                </View>
              ))
            )}
          </View>

          <View style={styles.divider} />
          <Text style={[styles.subSectionTitle, { color: colors.textSecondary }]}>Create New Company</Text>
          <TextInput
            value={newCompanyName}
            onChangeText={setNewCompanyName}
            placeholder="Company name"
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <TextInput
            value={newCompanyBranch}
            onChangeText={setNewCompanyBranch}
            placeholder="Primary branch (optional)"
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <TextInput
            value={newCompanyHeadquarters}
            onChangeText={setNewCompanyHeadquarters}
            placeholder="Headquarters (optional)"
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <Pressable
            onPress={() => void handleCreateCompany()}
            disabled={busyCreateCompany || !newCompanyName.trim()}
            style={[
              styles.primaryButton,
              {
                backgroundColor: colors.success,
                opacity: busyCreateCompany || !newCompanyName.trim() ? 0.6 : 1,
              },
            ]}
          >
            {busyCreateCompany ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="business-outline" size={16} color="#fff" />
                <Text style={styles.primaryButtonText}>Create Company</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(80)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>Access Requests</Text>
            <View style={[styles.countChip, { backgroundColor: colors.warning + "1A" }]}>
              <Text style={[styles.countChipText, { color: colors.warning }]}>{pendingCountLabel}</Text>
            </View>
          </View>

          {pendingAccessRequests.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="checkmark-done-outline" size={20} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No pending access requests.</Text>
            </View>
          ) : (
            pendingAccessRequests.map((request, index) => {
              const selectedRole = selectedRoleByRequest[request.id] || request.requestedRole;
              const selectedCompanyIds = selectedCompanyIdsByRequest[request.id] || [];
              const selectedManagerId = selectedManagerIdByRequest[request.id] || "";
              const managersForRequest = getManagersForRequest(request.id);
              const stockistsForRequest = getStockistsForRequest(request.id);
              const selectedStockistId = selectedStockistIdByRequest[request.id] || "";
              const isBusy = busyAccessRequestId === request.id;
              return (
                <View
                  key={request.id}
                  style={[
                    styles.requestCard,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.background,
                      marginBottom: index === pendingAccessRequests.length - 1 ? 0 : 10,
                    },
                  ]}
                >
                  <Text style={[styles.requestTitle, { color: colors.text }]}>{request.name}</Text>
                  <Text style={[styles.requestMeta, { color: colors.textSecondary }]}>
                    {request.email}
                  </Text>
                  <Text style={[styles.requestMeta, { color: colors.textSecondary }]}>
                    Requested role: {request.requestedRole.toUpperCase()} | Assigning:{" "}
                    {selectedRole.toUpperCase()}
                  </Text>
                  <Text style={[styles.requestMeta, { color: colors.textTertiary }]}>
                    Requested company: {request.requestedCompanyName || "Not specified"}
                  </Text>
                  <Text style={[styles.requestMeta, { color: colors.textTertiary }]}>
                    Location: {request.requestedBranch || "Not specified"} · Pincode: {request.requestedPincode || "—"}
                  </Text>
                  {selectedRole !== request.requestedRole ? (
                    <Text style={[styles.requestMeta, { color: colors.success }]}>
                      Admin role override enabled for this approval.
                    </Text>
                  ) : null}

                  <Text style={[styles.assignLabel, { color: colors.textSecondary }]}>
                    Assign final role
                  </Text>
                  <View style={styles.assignChipRow}>
                    {ASSIGNABLE_ACCESS_ROLES.map((roleOption) => {
                      const selected = roleOption === selectedRole;
                      return (
                        <Pressable
                          key={`${request.id}_role_${roleOption}`}
                          onPress={() => selectRoleForRequest(request.id, roleOption)}
                          style={[
                            styles.assignChip,
                            {
                              borderColor: selected ? colors.warning : colors.border,
                              backgroundColor: selected
                                ? colors.warning + "16"
                                : colors.backgroundElevated,
                              opacity: isBusy ? 0.7 : 1,
                            },
                          ]}
                          disabled={isBusy}
                        >
                          <Text
                            style={[
                              styles.assignChipText,
                              { color: selected ? colors.warning : colors.textSecondary },
                            ]}
                          >
                            {roleOption.toUpperCase()}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Text style={[styles.assignLabel, { color: colors.textSecondary }]}>Assign to company environments</Text>
                  <View style={styles.assignChipRow}>
                    {companyProfiles.map((company) => {
                      const selected = selectedCompanyIds.includes(company.id);
                      return (
                        <Pressable
                          key={`${request.id}_${company.id}`}
                          onPress={() => toggleCompanySelection(request.id, company.id)}
                          style={[
                            styles.assignChip,
                            {
                              borderColor: selected ? colors.primary : colors.border,
                              backgroundColor: selected ? colors.primary + "15" : colors.backgroundElevated,
                              opacity: isBusy ? 0.7 : 1,
                            },
                          ]}
                          disabled={isBusy}
                        >
                          <Text
                            style={[
                              styles.assignChipText,
                              { color: selected ? colors.primary : colors.textSecondary },
                            ]}
                          >
                            {company.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {isSalesRole(selectedRole) ? (
                    <>
                      <Text style={[styles.assignLabel, { color: colors.textSecondary }]}>
                        Assign channel partner (optional)
                      </Text>
                      {stockistsForRequest.length === 0 ? (
                        <Text style={[styles.requestMeta, { color: colors.textTertiary }]}>
                          No channel partners available. Salesperson will report directly to company.
                        </Text>
                      ) : (
                        <View style={styles.assignChipRow}>
                          <Pressable
                            key={`${request.id}_stockist_direct`}
                            onPress={() => selectStockistForRequest(request.id, "")}
                            style={[
                              styles.assignChip,
                              {
                                borderColor: selectedStockistId === "" ? colors.success : colors.border,
                                backgroundColor:
                                  selectedStockistId === ""
                                    ? colors.success + "16"
                                    : colors.backgroundElevated,
                                opacity: isBusy ? 0.7 : 1,
                              },
                            ]}
                            disabled={isBusy}
                          >
                            <Text
                              style={[
                                styles.assignChipText,
                                { color: selectedStockistId === "" ? colors.success : colors.textSecondary },
                              ]}
                            >
                              Direct (Company)
                            </Text>
                          </Pressable>
                          {stockistsForRequest.map((stockist) => {
                            const selected = stockist.id === selectedStockistId;
                            return (
                              <Pressable
                                key={`${request.id}_stockist_${stockist.id}`}
                                onPress={() => selectStockistForRequest(request.id, stockist.id)}
                                style={[
                                  styles.assignChip,
                                  {
                                    borderColor: selected ? colors.primary : colors.border,
                                    backgroundColor: selected
                                      ? colors.primary + "16"
                                      : colors.backgroundElevated,
                                    opacity: isBusy ? 0.7 : 1,
                                  },
                                ]}
                                disabled={isBusy}
                              >
                                <Text
                                  style={[
                                    styles.assignChipText,
                                    { color: selected ? colors.primary : colors.textSecondary },
                                  ]}
                                >
                                  {stockist.name}
                                  {stockist.location ? ` (${stockist.location})` : ""}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </>
                  ) : (
                    <>
                      <Text style={[styles.assignLabel, { color: colors.textSecondary }]}>
                        Assign reporting manager (optional)
                      </Text>
                      {managersForRequest.length === 0 ? (
                        <Text style={[styles.requestMeta, { color: colors.textTertiary }]}>
                          No manager available for selected company.
                        </Text>
                      ) : (
                        <View style={styles.assignChipRow}>
                          {managersForRequest.map((manager) => {
                            const selected = manager.id === selectedManagerId;
                            return (
                              <Pressable
                                key={`${request.id}_manager_${manager.id}`}
                                onPress={() => selectManagerForRequest(request.id, manager.id)}
                                style={[
                                  styles.assignChip,
                                  {
                                    borderColor: selected ? colors.success : colors.border,
                                    backgroundColor: selected
                                      ? colors.success + "16"
                                      : colors.backgroundElevated,
                                    opacity: isBusy ? 0.7 : 1,
                                  },
                                ]}
                                disabled={isBusy}
                              >
                                <Text
                                  style={[
                                    styles.assignChipText,
                                    { color: selected ? colors.success : colors.textSecondary },
                                  ]}
                                >
                                  {manager.name} ({manager.branch})
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </>
                  )}

                  <View style={styles.requestActionRow}>
                    <Pressable
                      onPress={() => void handleReviewAccessRequest(request, "rejected")}
                      disabled={Boolean(busyAccessRequestId)}
                      style={[
                        styles.secondaryActionButton,
                        { borderColor: colors.danger, opacity: busyAccessRequestId ? 0.6 : 1 },
                      ]}
                    >
                      <Text style={[styles.secondaryActionText, { color: colors.danger }]}>Reject</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void handleReviewAccessRequest(request, "approved")}
                      disabled={Boolean(busyAccessRequestId)}
                      style={[
                        styles.primaryActionButton,
                        { backgroundColor: colors.success, opacity: busyAccessRequestId ? 0.6 : 1 },
                      ]}
                    >
                      {isBusy ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.primaryActionText}>Approve</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(120)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>Broadcast Announcement</Text>
          <TextInput
            value={annTitle}
            onChangeText={setAnnTitle}
            placeholder="Announcement title"
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <TextInput
            multiline
            value={annBody}
            onChangeText={setAnnBody}
            placeholder="Write message for employees..."
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              styles.multilineInput,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <View style={styles.audienceRow}>
            {(["all", "salesperson", "employee", "manager", "hr"] as const).map((role) => (
              <Pressable
                key={role}
                onPress={() => setAudience(role)}
                style={[
                  styles.audienceChip,
                  {
                    borderColor: audience === role ? colors.primary : colors.border,
                    backgroundColor: audience === role ? colors.primary + "15" : colors.background,
                  },
                ]}
              >
                <Text
                  style={{
                    color: audience === role ? colors.primary : colors.textSecondary,
                    fontFamily: "Inter_500Medium",
                    fontSize: 11,
                  }}
                >
                  {role.toUpperCase()}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={() => void handleSendAnnouncement()}
            disabled={busyAnnouncement || !annTitle.trim() || !annBody.trim()}
            style={[
              styles.primaryButton,
              {
                backgroundColor: colors.primary,
                opacity: busyAnnouncement || !annTitle.trim() || !annBody.trim() ? 0.6 : 1,
              },
            ]}
          >
            {busyAnnouncement ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="megaphone-outline" size={16} color="#fff" />
                <Text style={styles.primaryButtonText}>Send Announcement</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(160)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>Runtime Policy</Text>
          <View style={styles.policyRow}>
            <Text style={[styles.policyLabel, { color: colors.textSecondary }]}>Notifications</Text>
            <Switch
              value={notificationsEnabled}
              onValueChange={setNotificationsEnabled}
              trackColor={{ false: colors.border, true: colors.primary + "70" }}
              thumbColor={notificationsEnabled ? colors.primary : "#f4f3f4"}
            />
          </View>
          <View style={styles.policyRow}>
            <Text style={[styles.policyLabel, { color: colors.textSecondary }]}>Location Tracking</Text>
            <Switch
              value={locationTracking}
              onValueChange={setLocationTracking}
              trackColor={{ false: colors.border, true: colors.primary + "70" }}
              thumbColor={locationTracking ? colors.primary : "#f4f3f4"}
            />
          </View>
          <View style={styles.policyRow}>
            <Text style={[styles.policyLabel, { color: colors.textSecondary }]}>Auto Sync</Text>
            <Switch
              value={autoSync}
              onValueChange={setAutoSync}
              trackColor={{ false: colors.border, true: colors.primary + "70" }}
              thumbColor={autoSync ? colors.primary : "#f4f3f4"}
            />
          </View>
          <View style={styles.policyRow}>
            <Text style={[styles.policyLabel, { color: colors.textSecondary }]}>Offline Mode</Text>
            <Switch
              value={offlineMode}
              onValueChange={setOfflineMode}
              trackColor={{ false: colors.border, true: colors.primary + "70" }}
              thumbColor={offlineMode ? colors.primary : "#f4f3f4"}
            />
          </View>
          <Pressable
            onPress={() => void handleSavePolicy()}
            disabled={busySavePolicy}
            style={[
              styles.primaryButton,
              { backgroundColor: colors.success, opacity: busySavePolicy ? 0.65 : 1, marginTop: 10 },
            ]}
          >
            {busySavePolicy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="save-outline" size={16} color="#fff" />
                <Text style={styles.primaryButtonText}>Save Policy</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(200)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>Recent Broadcasts</Text>
          {loading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : recentNotifications.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="newspaper-outline" size={20} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No broadcasts yet.</Text>
            </View>
          ) : (
            recentNotifications.map((item, index) => (
              <View
                key={item.id}
                style={[
                  styles.broadcastRow,
                  index < recentNotifications.length - 1 && {
                    borderBottomWidth: 1,
                    borderBottomColor: colors.borderLight,
                  },
                ]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.broadcastTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                    {item.title}
                  </Text>
                  <Text
                    style={[
                      styles.broadcastBody,
                      { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                    ]}
                  >
                    {item.body}
                  </Text>
                  <Text
                    style={[
                      styles.broadcastMeta,
                      { color: colors.textTertiary, fontFamily: "Inter_400Regular" },
                    ]}
                  >
                    {item.audience.toUpperCase()} - {new Date(item.createdAt).toLocaleString()}
                  </Text>
                </View>
              </View>
            ))
          )}
        </Animated.View>
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  headerWrap: {
    marginBottom: 12,
  },
  title: {
    fontSize: 24,
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 13,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    marginBottom: 8,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    gap: 8,
  },
  countChip: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  countChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  input: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontFamily: "Inter_400Regular",
    marginBottom: 8,
  },
  multilineInput: {
    minHeight: 88,
    textAlignVertical: "top",
    paddingTop: 10,
  },
  audienceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  },
  audienceChip: {
    minHeight: 32,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  primaryButton: {
    minHeight: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
  },
  primaryButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  policyRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(148,163,184,0.18)",
  },
  policyLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  emptyWrap: {
    minHeight: 100,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
  },
  broadcastRow: {
    paddingVertical: 10,
  },
  broadcastTitle: {
    fontSize: 13.5,
  },
  broadcastBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  broadcastMeta: {
    marginTop: 3,
    fontSize: 10.5,
  },
  lockedWrap: {
    flex: 1,
    paddingHorizontal: 20,
  },
  lockedCard: {
    marginTop: 16,
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  lockedTitle: {
    fontSize: 18,
  },
  lockedText: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
  },
  companyListWrap: {
    gap: 8,
  },
  companyRow: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  companyName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13.5,
  },
  companyMeta: {
    marginTop: 2,
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
  },
  companyDeleteButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    marginVertical: 12,
    height: 1,
    backgroundColor: "rgba(148,163,184,0.2)",
  },
  subSectionTitle: {
    marginBottom: 8,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  requestCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
  },
  requestTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13.5,
  },
  requestMeta: {
    marginTop: 2,
    fontFamily: "Inter_400Regular",
    fontSize: 11.5,
  },
  assignLabel: {
    marginTop: 10,
    marginBottom: 6,
    fontFamily: "Inter_500Medium",
    fontSize: 11.5,
  },
  assignChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  assignChip: {
    minHeight: 30,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  assignChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  requestActionRow: {
    marginTop: 10,
    flexDirection: "row",
    gap: 8,
  },
  secondaryActionButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryActionButton: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryActionText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12.5,
  },
  primaryActionText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12.5,
  },
});
