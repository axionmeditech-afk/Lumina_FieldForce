import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import Colors from "@/constants/colors";
import {
  addAuditLog,
  addTask,
  getEmployees,
  getTasks,
  getTeams,
  updateTaskStatus,
} from "@/lib/storage";
import { useAuth } from "@/contexts/AuthContext";
import type { Employee, Task, Team, UserRole } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";

const LEAD_ROLES: UserRole[] = ["admin", "hr", "manager"];

function isLeadRole(role?: UserRole | null): boolean {
  return Boolean(role && LEAD_ROLES.includes(role));
}

function TaskCard({
  task,
  colors,
  onAdvanceStatus,
  canUpdate,
}: {
  task: Task;
  colors: typeof Colors.light;
  onAdvanceStatus: (task: Task) => void;
  canUpdate: boolean;
}) {
  const priorityColor =
    task.priority === "high" ? colors.danger :
    task.priority === "medium" ? colors.warning : colors.success;

  const statusColor =
    task.status === "completed" ? colors.success :
    task.status === "in_progress" ? colors.primary : colors.textTertiary;

  return (
    <Pressable
      onPress={() => {
        if (!canUpdate) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onAdvanceStatus(task);
      }}
      style={[
        styles.taskCard,
        {
          backgroundColor: colors.backgroundElevated,
          borderColor: colors.border,
          opacity: canUpdate ? 1 : 0.88,
        },
      ]}
    >
      <View style={styles.taskHeader}>
        <View style={[styles.priorityDot, { backgroundColor: priorityColor }]} />
        <View style={styles.taskInfo}>
          <Text
            style={[
              styles.taskTitle,
              {
                color: colors.text,
                fontFamily: "Inter_600SemiBold",
                textDecorationLine: task.status === "completed" ? "line-through" : "none",
              },
            ]}
          >
            {task.title}
          </Text>
          <Text style={[styles.taskDesc, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]} numberOfLines={2}>
            {task.description}
          </Text>
        </View>
        <View style={[styles.statusIconWrap, { borderColor: colors.border }]}>
          <Ionicons
            name={
              task.status === "completed" ? "checkmark-circle" :
              task.status === "in_progress" ? "hourglass-outline" : "ellipse-outline"
            }
            size={22}
            color={statusColor}
          />
        </View>
      </View>
      <View style={styles.taskFooter}>
        <View style={styles.taskMeta}>
          <Ionicons name="person-outline" size={12} color={colors.textTertiary} />
          <Text style={[styles.taskMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
            {task.assignedToName}
          </Text>
        </View>
        <View style={styles.taskMeta}>
          <Ionicons name="calendar-outline" size={12} color={colors.textTertiary} />
          <Text style={[styles.taskMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
            {new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </Text>
        </View>
        {task.teamName ? (
          <View style={styles.taskMeta}>
            <Ionicons name="people-outline" size={12} color={colors.textTertiary} />
            <Text style={[styles.taskMetaText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
              {task.teamName}
            </Text>
          </View>
        ) : null}
        <View style={[styles.statusChip, { backgroundColor: statusColor + "15" }]}>
          <Text style={[styles.statusText, { color: statusColor, fontFamily: "Inter_500Medium" }]}>
            {task.status.replace("_", " ")}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function TasksScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDueDays, setNewDueDays] = useState("7");
  const [newPriority, setNewPriority] = useState<Task["priority"]>("medium");
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "in_progress" | "completed">("all");

  const canManage = isLeadRole(user?.role);

  const loadData = useCallback(async () => {
    const [taskData, employeeData, teamData] = await Promise.all([getTasks(), getEmployees(), getTeams()]);
    setTasks(taskData);
    setEmployees(employeeData);
    setTeams(teamData);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const actorIds = useMemo(() => {
    if (!user) return new Set<string>();
    const linkedEmployeeIds = employees
      .filter((employee) => employee.email === user.email || employee.name === user.name)
      .map((employee) => employee.id);
    return new Set<string>([user.id, ...linkedEmployeeIds]);
  }, [employees, user]);

  const assignerId = useMemo(() => {
    const firstEmployeeId = [...actorIds].find((id) => id.startsWith("e"));
    return firstEmployeeId || user?.id || "";
  }, [actorIds, user?.id]);

  const manageableTeams = useMemo(() => {
    if (!canManage) return [];
    return teams;
  }, [canManage, teams]);

  const manageableMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const team of manageableTeams) {
      for (const memberId of team.memberIds) {
        ids.add(memberId);
      }
    }
    return ids;
  }, [manageableTeams]);

  const employeesById = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      map.set(employee.id, employee);
    }
    return map;
  }, [employees]);

  const assigneeOptions = useMemo(() => {
    if (!canManage) return [];
    if (selectedTeamId) {
      const selectedTeam = manageableTeams.find((team) => team.id === selectedTeamId);
      if (!selectedTeam) return [];
      return selectedTeam.memberIds
        .map((memberId) => employeesById.get(memberId))
        .filter((member): member is Employee => Boolean(member));
    }
    return [...manageableMemberIds]
      .map((memberId) => employeesById.get(memberId))
      .filter((member): member is Employee => Boolean(member));
  }, [canManage, employeesById, manageableMemberIds, manageableTeams, selectedTeamId]);

  useEffect(() => {
    if (!canManage) return;
    if (selectedTeamId) {
      const team = manageableTeams.find((item) => item.id === selectedTeamId);
      if (!team) {
        setSelectedAssigneeId(null);
        return;
      }
      if (!selectedAssigneeId || !team.memberIds.includes(selectedAssigneeId)) {
        setSelectedAssigneeId(team.memberIds[0] ?? null);
      }
      return;
    }
    if (!selectedAssigneeId && assigneeOptions.length > 0) {
      setSelectedAssigneeId(assigneeOptions[0].id);
    }
  }, [assigneeOptions, canManage, manageableTeams, selectedAssigneeId, selectedTeamId]);

  const visibleTasks = useMemo(() => {
    const filteredByStatus = tasks.filter((task) => filter === "all" || task.status === filter);
    if (canManage) {
      return filteredByStatus.filter((task) =>
        actorIds.has(task.assignedBy) || manageableMemberIds.has(task.assignedTo)
      );
    }
    return filteredByStatus.filter((task) => actorIds.has(task.assignedTo));
  }, [actorIds, canManage, filter, manageableMemberIds, tasks]);

  const canUpdateTask = useCallback((task: Task) => {
    const isAssignee = actorIds.has(task.assignedTo);
    if (isAssignee) return true;
    if (!canManage) return false;
    return actorIds.has(task.assignedBy) || manageableMemberIds.has(task.assignedTo);
  }, [actorIds, canManage, manageableMemberIds]);

  const handleAdvanceStatus = useCallback(async (task: Task) => {
    if (!canUpdateTask(task)) return;
    const isAssignee = actorIds.has(task.assignedTo);

    let nextStatus: Task["status"] = task.status;
    if (isAssignee) {
      if (task.status === "pending") nextStatus = "in_progress";
      if (task.status === "in_progress") nextStatus = "completed";
      if (task.status === "completed") return;
    } else {
      if (task.status === "pending") nextStatus = "in_progress";
      else if (task.status === "in_progress") nextStatus = "completed";
      else nextStatus = "pending";
    }

    await updateTaskStatus(task.id, nextStatus);
    await loadData();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [actorIds, canUpdateTask, loadData]);

  const handleAddTask = useCallback(async () => {
    if (!user || !canManage) return;
    const title = newTitle.trim();
    if (!title || !selectedAssigneeId) return;

    const member = employeesById.get(selectedAssigneeId);
    if (!member) return;
    const selectedTeam = selectedTeamId ? manageableTeams.find((team) => team.id === selectedTeamId) : null;

    const dueInDays = Math.max(1, Number.parseInt(newDueDays, 10) || 7);
    const dueDate = new Date(Date.now() + dueInDays * 86400000).toISOString().split("T")[0];
    const nowISO = new Date().toISOString();

    const task: Task = {
      id: Crypto.randomUUID(),
      title,
      description: newDesc.trim(),
      assignedTo: member.id,
      assignedToName: member.name,
      assignedBy: assignerId,
      teamId: selectedTeam?.id ?? null,
      teamName: selectedTeam?.name ?? null,
      status: "pending",
      priority: newPriority,
      dueDate,
      createdAt: nowISO.split("T")[0],
    };
    await addTask(task);
    await addAuditLog({
      id: Crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      action: "Task Created",
      details: `Assigned ${task.title} to ${member.name}${selectedTeam ? ` (${selectedTeam.name})` : ""}`,
      timestamp: nowISO,
      module: "Tasks",
    });

    setNewTitle("");
    setNewDesc("");
    setNewDueDays("7");
    setNewPriority("medium");
    setShowAdd(false);
    await loadData();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [
    assignerId,
    canManage,
    employeesById,
    loadData,
    manageableTeams,
    newDesc,
    newDueDays,
    newPriority,
    newTitle,
    selectedAssigneeId,
    selectedTeamId,
    user,
  ]);

  const filters: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "in_progress", label: "In Progress" },
    { key: "completed", label: "Done" },
  ];

  return (
    <AppCanvas>
      <FlatList
        data={visibleTasks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            <View style={styles.headerRow}>
              <DrawerToggleButton />
              <View style={styles.headerCenter}>
                <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Tasks</Text>
                <Text style={[styles.headerSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {canManage ? "Team assignment view" : "Your assigned tasks"}
                </Text>
              </View>
              {canManage ? (
                <Pressable onPress={() => setShowAdd(true)} hitSlop={12}>
                  <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                </Pressable>
              ) : (
                <View style={{ width: 24 }} />
              )}
            </View>
            <View style={styles.filterRow}>
              {filters.map((entry) => (
                <Pressable
                  key={entry.key}
                  onPress={() => setFilter(entry.key)}
                  style={[
                    styles.filterChip,
                    {
                      backgroundColor: filter === entry.key ? colors.primary : colors.surface,
                      borderColor: filter === entry.key ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterText,
                      {
                        color: filter === entry.key ? "#fff" : colors.textSecondary,
                        fontFamily: "Inter_500Medium",
                      },
                    ]}
                  >
                    {entry.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        }
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            colors={colors}
            onAdvanceStatus={handleAdvanceStatus}
            canUpdate={canUpdateTask(item)}
          />
        )}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="clipboard-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {canManage ? "No team tasks found" : "No assigned tasks"}
            </Text>
          </View>
        }
      />

      <Modal visible={showAdd} animationType="slide" transparent onRequestClose={() => setShowAdd(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.backgroundElevated }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>Assign Task</Text>
              <Pressable onPress={() => setShowAdd(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>

            {manageableTeams.length > 0 ? (
              <View style={styles.selectorWrap}>
                <Text style={[styles.selectorLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  Team
                </Text>
                <View style={styles.selectorRow}>
                  {manageableTeams.map((team) => (
                    <Pressable
                      key={team.id}
                      onPress={() => setSelectedTeamId(team.id)}
                      style={[
                        styles.selectorChip,
                        {
                          backgroundColor: selectedTeamId === team.id ? colors.primary : colors.surfaceSecondary,
                          borderColor: selectedTeamId === team.id ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.selectorChipText,
                          {
                            color: selectedTeamId === team.id ? "#FFFFFF" : colors.textSecondary,
                            fontFamily: "Inter_500Medium",
                          },
                        ]}
                      >
                        {team.name}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <Text style={[styles.noTeamText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
                Add members in the Team section first to create a team.
              </Text>
            )}

            <View style={styles.selectorWrap}>
              <Text style={[styles.selectorLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Assign To
              </Text>
              <View style={styles.selectorRow}>
                {assigneeOptions.map((member) => (
                  <Pressable
                    key={member.id}
                    onPress={() => setSelectedAssigneeId(member.id)}
                    style={[
                      styles.selectorChip,
                      {
                        backgroundColor: selectedAssigneeId === member.id ? colors.primary : colors.surfaceSecondary,
                        borderColor: selectedAssigneeId === member.id ? colors.primary : colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.selectorChipText,
                        {
                          color: selectedAssigneeId === member.id ? "#FFFFFF" : colors.textSecondary,
                          fontFamily: "Inter_500Medium",
                        },
                      ]}
                    >
                      {member.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <TextInput
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
              placeholder="Task title"
              placeholderTextColor={colors.textTertiary}
              value={newTitle}
              onChangeText={setNewTitle}
            />
            <TextInput
              style={[styles.modalInput, styles.modalTextarea, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
              placeholder="Description (optional)"
              placeholderTextColor={colors.textTertiary}
              value={newDesc}
              onChangeText={setNewDesc}
              multiline
              numberOfLines={3}
            />

            <View style={styles.priorityRow}>
              {(["low", "medium", "high"] as const).map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setNewPriority(value)}
                  style={[
                    styles.priorityChip,
                    {
                      backgroundColor: newPriority === value ? colors.primary : colors.surfaceSecondary,
                      borderColor: newPriority === value ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.priorityChipText,
                      {
                        color: newPriority === value ? "#FFFFFF" : colors.textSecondary,
                        fontFamily: "Inter_500Medium",
                      },
                    ]}
                  >
                    {value}
                  </Text>
                </Pressable>
              ))}
            </View>

            <TextInput
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
              placeholder="Due in days (default 7)"
              placeholderTextColor={colors.textTertiary}
              value={newDueDays}
              onChangeText={setNewDueDays}
              keyboardType="number-pad"
            />

            <Pressable
              onPress={() => void handleAddTask()}
              disabled={!newTitle.trim() || !selectedAssigneeId}
              style={({ pressed }) => [
                styles.modalButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed || !newTitle.trim() || !selectedAssigneeId ? 0.72 : 1,
                },
              ]}
            >
              <Text style={styles.modalButtonText}>Create Task</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerCenter: {
    alignItems: "center",
    gap: 2,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  headerSubtitle: { fontSize: 11.5 },
  filterRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  filterText: { fontSize: 12 },
  taskCard: {
    borderRadius: 24,
    padding: 20,
    gap: 12,
    borderWidth: 1,
    boxShadow: "0px 10px 26px rgba(10, 35, 62, 0.12)",
  },
  taskHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  taskInfo: { flex: 1, gap: 4 },
  taskTitle: { fontSize: 15 },
  taskDesc: { fontSize: 12, lineHeight: 16 },
  statusIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  taskFooter: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 18, flexWrap: "wrap" },
  taskMeta: { flexDirection: "row", alignItems: "center", gap: 4 },
  taskMetaText: { fontSize: 11 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginLeft: "auto",
  },
  statusText: { fontSize: 10, textTransform: "capitalize" as const },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    gap: 12,
    maxHeight: "90%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: { fontSize: 18 },
  selectorWrap: { gap: 8 },
  selectorLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  selectorRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  selectorChip: {
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  selectorChipText: {
    fontSize: 11.5,
  },
  noTeamText: {
    fontSize: 12,
  },
  modalInput: {
    minHeight: 46,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 15,
    borderWidth: 1,
  },
  modalTextarea: { minHeight: 84, paddingTop: 10, textAlignVertical: "top" },
  priorityRow: {
    flexDirection: "row",
    gap: 8,
  },
  priorityChip: {
    flex: 1,
    minHeight: 34,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  priorityChipText: {
    fontSize: 12,
    textTransform: "capitalize",
  },
  modalButton: {
    height: 48,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  modalButtonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
