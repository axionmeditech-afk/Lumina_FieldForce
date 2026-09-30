import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import {
  deleteUserRemote,
  getAdminAccessRequests,
  getCompanyProfilesRemote,
  getUsersRemote,
  reviewAdminAccessRequest,
  type DolibarrUser,
} from "@/lib/attendance-api";
import type { CompanyProfile, UserAccessRequest, UserRole } from "@/lib/types";

const ASSIGNABLE_ROLES: UserRole[] = ["employee", "salesperson", "manager", "hr"];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function getRequestLabel(request: UserAccessRequest): string {
  return request.requestedCompanyName?.trim() || request.requestedBranch?.trim() || "New registration";
}

function getEmployeeId(employee: DolibarrUser): string {
  return String(employee.id || employee.rowid || employee.user_id || employee.email || employee.login || "").trim();
}

function getEmployeeName(employee: DolibarrUser): string {
  return (
    employee.name?.trim() ||
    `${employee.firstname || ""} ${employee.lastname || ""}`.trim() ||
    employee.email?.trim() ||
    employee.login?.trim() ||
    "Employee"
  );
}

function getEmployeeEmail(employee: DolibarrUser): string {
  return String(employee.email || "").trim().toLowerCase();
}

function getEmployeeRole(employee: DolibarrUser): UserRole {
  const role = employee.role;
  if (role === "admin" || role === "hr" || role === "manager" || role === "salesperson" || role === "employee") {
    return role;
  }
  return employee.admin === true || employee.admin === 1 || employee.admin === "1" ? "admin" : "employee";
}

export function EmployeeAccessPanel() {
  const { user, company, refreshSession } = useAuth();
  const { colors } = useAppTheme();
  const [requests, setRequests] = useState<UserAccessRequest[]>([]);
  const [employees, setEmployees] = useState<DolibarrUser[]>([]);
  const [companies, setCompanies] = useState<CompanyProfile[]>([]);
  const [selectedRoleByRequest, setSelectedRoleByRequest] = useState<Record<string, UserRole>>({});
  const [selectedCompanyIdsByRequest, setSelectedCompanyIdsByRequest] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setBusy(true);
    setError("");
    try {
      const [pending, companyList, employeeList] = await Promise.all([
        getAdminAccessRequests("pending"),
        getCompanyProfilesRemote().catch(() => [] as CompanyProfile[]),
        getUsersRemote({ companyId: company?.id }).catch(() => [] as DolibarrUser[]),
      ]);
      setRequests(pending);
      setCompanies(companyList);
      setEmployees(employeeList);
      setSelectedRoleByRequest((current) => {
        const next = { ...current };
        for (const request of pending) {
          if (!next[request.id]) next[request.id] = request.approvedRole || request.requestedRole || "employee";
        }
        for (const requestId of Object.keys(next)) {
          if (!pending.some((request) => request.id === requestId)) delete next[requestId];
        }
        return next;
      });
      setSelectedCompanyIdsByRequest((current) => {
        const next = { ...current };
        for (const request of pending) {
          if (next[request.id]?.length) continue;
          const requestedCompany = request.requestedCompanyName
            ? companyList.find((item) => normalize(item.name) === normalize(request.requestedCompanyName || ""))
            : null;
          next[request.id] = requestedCompany?.id
            ? [requestedCompany.id]
            : company?.id
              ? [company.id]
              : companyList[0]?.id
                ? [companyList[0].id]
                : [];
        }
        for (const requestId of Object.keys(next)) {
          if (!pending.some((request) => request.id === requestId)) delete next[requestId];
        }
        return next;
      });
    } catch (event) {
      setError(event instanceof Error ? event.message : "Unable to load pending registrations.");
    } finally {
      setBusy(false);
    }
  }, [company?.id, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const companyById = useMemo(
    () => new Map(companies.map((item) => [item.id, item])),
    [companies],
  );
  const deletableEmployees = useMemo(
    () =>
      employees.filter((employee) => {
        const id = getEmployeeId(employee);
        const email = getEmployeeEmail(employee);
        const role = getEmployeeRole(employee);
        if (!id && !email) return false;
        if (role === "admin") return false;
        if (user?.id && id === user.id) return false;
        if (user?.email && email && email === normalize(user.email)) return false;
        return true;
      }),
    [employees, user?.email, user?.id],
  );

  if (!isAdmin) return null;

  const toggleCompany = (requestId: string, companyId: string) => {
    setSelectedCompanyIdsByRequest((current) => {
      const selected = current[requestId] || [];
      const next = selected.includes(companyId)
        ? selected.filter((id) => id !== companyId)
        : [...selected, companyId];
      return { ...current, [requestId]: next };
    });
  };

  const review = async (request: UserAccessRequest, action: "approved" | "rejected") => {
    if (reviewingId) return;
    const selectedCompanyIds = selectedCompanyIdsByRequest[request.id] || [];
    if (action === "approved" && selectedCompanyIds.length === 0) {
      Alert.alert("Company required", "Select at least one company before approving this registration.");
      return;
    }
    setReviewingId(request.id);
    try {
      const selectedCompanies = selectedCompanyIds
        .map((companyId) => companyById.get(companyId))
        .filter((item): item is CompanyProfile => Boolean(item));
      await reviewAdminAccessRequest({
        requestId: request.id,
        action,
        role: selectedRoleByRequest[request.id] || request.requestedRole || "employee",
        companyIds: selectedCompanyIds,
        companyProfiles: selectedCompanies.map((item) => ({
          id: item.id,
          name: item.name,
          primaryBranch: item.primaryBranch,
        })),
      });
      await Promise.all([load(), refreshSession()]);
    } catch (event) {
      Alert.alert("Review failed", event instanceof Error ? event.message : "Please retry.");
    } finally {
      setReviewingId(null);
    }
  };

  const confirmDeleteEmployee = (employee: DolibarrUser) => {
    const id = getEmployeeId(employee);
    const name = getEmployeeName(employee);
    const email = getEmployeeEmail(employee);
    if (!id && !email) {
      Alert.alert("Cannot delete", "This employee record is missing both id and email.");
      return;
    }
    Alert.alert(
      "Delete employee?",
      `Remove ${name} from app access and office geofence assignments? Previous attendance logs will stay in reports.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const deleteKey = id || email;
            if (deletingId) return;
            setDeletingId(deleteKey);
            try {
              await deleteUserRemote(id || email, {
                email,
                login: employee.login ? String(employee.login) : null,
                companyId: employee.companyId || company?.id || null,
                name,
              });
              await Promise.all([load(), refreshSession()]);
            } catch (event) {
              Alert.alert("Delete failed", event instanceof Error ? event.message : "Please retry.");
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerIcon}>
          <Ionicons name="people-outline" size={20} color={colors.primary} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={[styles.title, { color: colors.text }]}>Employee Registrations</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Approve sign-ups, assign role, and attach company access.
          </Text>
        </View>
      </View>

      <Pressable
        disabled={busy}
        onPress={() => void load()}
        style={({ pressed }) => [
          styles.refreshButton,
          { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed || busy ? 0.75 : 1 },
        ]}
      >
        {busy ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="refresh" size={17} color={colors.primary} />}
        <Text style={[styles.refreshText, { color: colors.text }]}>{busy ? "Loading registrations" : "Refresh registrations"}</Text>
      </Pressable>

      {!!error && (
        <Text style={[styles.errorText, { color: colors.danger }]}>
          {error}
        </Text>
      )}

      {!busy && !error && !requests.length ? (
        <View style={[styles.emptyBox, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
          <Ionicons name="checkmark-circle-outline" size={22} color={colors.success} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No pending registrations.</Text>
        </View>
      ) : null}

      {requests.map((request) => {
        const selectedRole = selectedRoleByRequest[request.id] || request.requestedRole || "employee";
        const selectedCompanies = selectedCompanyIdsByRequest[request.id] || [];
        const isReviewing = reviewingId === request.id;
        return (
          <View key={request.id} style={[styles.requestCard, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
            <View style={styles.requestTopRow}>
              <View style={styles.requestCopy}>
                <Text style={[styles.requestName, { color: colors.text }]}>{request.name}</Text>
                <Text style={[styles.requestMeta, { color: colors.textSecondary }]}>{request.email}</Text>
                <Text style={[styles.requestMeta, { color: colors.textSecondary }]}>
                  {getRequestLabel(request)} - requested {request.requestedRole}
                </Text>
              </View>
              {isReviewing ? <ActivityIndicator color={colors.primary} /> : null}
            </View>

            <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Role</Text>
            <View style={styles.chipRow}>
              {ASSIGNABLE_ROLES.map((role) => {
                const active = selectedRole === role;
                return (
                  <Pressable
                    key={role}
                    onPress={() => setSelectedRoleByRequest((current) => ({ ...current, [request.id]: role }))}
                    style={[
                      styles.chip,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active ? `${colors.primary}16` : colors.backgroundElevated,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}>
                      {role}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>Companies</Text>
            <View style={styles.chipRow}>
              {companies.map((item) => {
                const active = selectedCompanies.includes(item.id);
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => toggleCompany(request.id, item.id)}
                    style={[
                      styles.chip,
                      {
                        borderColor: active ? colors.success : colors.border,
                        backgroundColor: active ? `${colors.success}16` : colors.backgroundElevated,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.success : colors.textSecondary }]}>
                      {item.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.actionRow}>
              <Pressable
                disabled={Boolean(reviewingId)}
                onPress={() => void review(request, "approved")}
                style={({ pressed }) => [
                  styles.actionButton,
                  { backgroundColor: colors.success, opacity: reviewingId || pressed ? 0.75 : 1 },
                ]}
              >
                <Text style={styles.actionButtonText}>Approve</Text>
              </Pressable>
              <Pressable
                disabled={Boolean(reviewingId)}
                onPress={() => void review(request, "rejected")}
                style={({ pressed }) => [
                  styles.actionButton,
                  { backgroundColor: colors.danger, opacity: reviewingId || pressed ? 0.75 : 1 },
                ]}
              >
                <Text style={styles.actionButtonText}>Reject</Text>
              </Pressable>
            </View>
          </View>
        );
      })}

      <View style={[styles.sectionDivider, { backgroundColor: colors.borderLight }]} />

      <View style={styles.subHeaderRow}>
        <View style={styles.headerCopy}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Current Employees</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            Remove app access for employees who should no longer use attendance.
          </Text>
        </View>
        <Text style={[styles.countBadge, { color: colors.primary, backgroundColor: `${colors.primary}12` }]}>
          {deletableEmployees.length}
        </Text>
      </View>

      {!busy && !error && !deletableEmployees.length ? (
        <View style={[styles.emptyBox, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
          <Ionicons name="people-outline" size={22} color={colors.textTertiary} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No deletable employees found.</Text>
        </View>
      ) : null}

      {deletableEmployees.map((employee) => {
        const id = getEmployeeId(employee);
        const email = getEmployeeEmail(employee);
        const name = getEmployeeName(employee);
        const role = getEmployeeRole(employee);
        const deleteKey = id || email;
        const isDeleting = deletingId === deleteKey;
        return (
          <View key={`${employee.companyId || company?.id || "company"}:${deleteKey}`} style={[styles.employeeCard, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
            <View style={styles.employeeAvatar}>
              <Text style={[styles.employeeAvatarText, { color: colors.primary }]}>
                {name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "E"}
              </Text>
            </View>
            <View style={styles.employeeCopy}>
              <Text style={[styles.requestName, { color: colors.text }]} numberOfLines={1}>{name}</Text>
              <Text style={[styles.requestMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                {email || employee.login || "No email"} - {role}
              </Text>
              <Text style={[styles.requestMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                {employee.companyName || company?.name || "Company"}{employee.branch ? ` - ${employee.branch}` : ""}
              </Text>
            </View>
            <Pressable
              disabled={Boolean(deletingId)}
              onPress={() => confirmDeleteEmployee(employee)}
              style={({ pressed }) => [
                styles.deleteButton,
                {
                  borderColor: `${colors.danger}44`,
                  backgroundColor: `${colors.danger}10`,
                  opacity: deletingId || pressed ? 0.72 : 1,
                },
              ]}
            >
              {isDeleting ? (
                <ActivityIndicator color={colors.danger} size="small" />
              ) : (
                <Ionicons name="trash-outline" size={17} color={colors.danger} />
              )}
              <Text style={[styles.deleteText, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(14,95,216,0.12)",
  },
  headerCopy: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  subtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 18,
  },
  refreshButton: {
    minHeight: 46,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  refreshText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  errorText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    lineHeight: 18,
  },
  emptyBox: {
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  emptyText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  requestCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  requestTopRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  requestCopy: {
    flex: 1,
    gap: 3,
  },
  requestName: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  requestMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12.5,
    lineHeight: 17,
  },
  groupLabel: {
    marginTop: 2,
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    textTransform: "uppercase",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    minHeight: 34,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 2,
  },
  actionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonText: {
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  sectionDivider: {
    height: 1,
    borderRadius: 999,
    marginVertical: 2,
  },
  subHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
  },
  countBadge: {
    minWidth: 34,
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    textAlign: "center",
    textAlignVertical: "center",
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
  employeeCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  employeeAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(14,95,216,0.12)",
  },
  employeeAvatarText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
  },
  employeeCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  deleteButton: {
    minHeight: 38,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deleteText: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
  },
});
