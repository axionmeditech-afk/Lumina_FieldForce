import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import Colors from "@/constants/colors";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import {
  addAuditLog,
  addTask,
  getTeams,
  upsertTeam,
} from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
import type { Employee, Task, Team, UserRole } from "@/lib/types";

const LEAD_ROLES: UserRole[] = ["admin", "hr", "manager"];

function isLeadRole(role?: UserRole | null): boolean {
  return Boolean(role && LEAD_ROLES.includes(role));
}

function TeamCard({
  team,
  members,
  colors,
  canAssignTask,
  onAssignTask,
}: {
  team: Team;
  members: Employee[];
  colors: typeof Colors.light;
  canAssignTask: boolean;
  onAssignTask: (team: Team) => void;
}) {
  return (
    <View style={[styles.teamCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={styles.teamHeaderTop}>
        <Text
          numberOfLines={2}
          ellipsizeMode="tail"
          style={[styles.teamName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
        >
          {team.name}
        </Text>
        {canAssignTask ? (
          <Pressable
            onPress={() => onAssignTask(team)}
            style={({ pressed }) => [
              styles.assignButton,
              {
                backgroundColor: colors.primary,
                opacity: pressed ? 0.86 : 1,
              },
            ]}
          >
            <Ionicons name="clipboard-outline" size={14} color="#FFFFFF" />
            <Text style={styles.assignButtonText}>Assign</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={[styles.teamMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
        Lead: {team.ownerName} | {members.length} members
      </Text>

      <View style={styles.memberRow}>
        {members.length > 0 ? (
          members.map((member) => (
            <View key={member.id} style={[styles.memberChip, { backgroundColor: colors.surfaceSecondary }]}>
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.memberChipText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}
              >
                {member.name}
              </Text>
            </View>
          ))
        ) : (
          <Text style={[styles.teamMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            No members selected.
          </Text>
        )}
      </View>
    </View>
  );
}

function MemberPickerRow({
  employee,
  selected,
  colors,
  onToggle,
}: {
  employee: Employee;
  selected: boolean;
  colors: typeof Colors.light;
  onToggle: (employeeId: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onToggle(employee.id)}
      style={({ pressed }) => [
        styles.memberPickerRow,
        {
          backgroundColor: selected ? colors.primary + "14" : colors.surface,
          borderColor: selected ? colors.primary : colors.border,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
    >
      <View style={styles.memberPickerTextWrap}>
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.memberPickerName, { color: colors.text, fontFamily: "Inter_500Medium" }]}
        >
          {employee.name}
        </Text>
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.memberPickerMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
        >
          {employee.department} | {employee.branch}
        </Text>
      </View>
      <Ionicons
        name={selected ? "checkmark-circle" : "ellipse-outline"}
        size={20}
        color={selected ? colors.primary : colors.textTertiary}
      />
    </Pressable>
  );
}

export default function TeamScreen() {
  const { user, company } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskPriority, setTaskPriority] = useState<Task["priority"]>("medium");
  const [taskDueDays, setTaskDueDays] = useState("7");
  const [taskMemberIds, setTaskMemberIds] = useState<string[]>([]);
  const [activeTeam, setActiveTeam] = useState<Team | null>(null);

  const canManageTeams = isLeadRole(user?.role);

  const loadData = useCallback(async () => {
    const [allEmployees, allTeams] = await Promise.all([getEmployees(), getTeams()]);
    setEmployees(allEmployees);
    setTeams(allTeams);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const salespersonPool = useMemo(() => {
    return employees.filter((employee) => employee.role === "salesperson");
  }, [employees]);

  const linkedEmployeeIds = useMemo(() => {
    if (!user) return [];
    return employees
      .filter((employee) => employee.email === user.email || employee.name === user.name)
      .map((employee) => employee.id);
  }, [employees, user]);

  const assignerId = linkedEmployeeIds[0] ?? user?.id ?? "";

  const visibleTeams = useMemo(() => {
    if (!user) return [];
    if (canManageTeams) return teams;

    const actorIds = new Set<string>([user.id, ...linkedEmployeeIds]);
    return teams.filter((team) => team.memberIds.some((memberId) => actorIds.has(memberId)));
  }, [canManageTeams, linkedEmployeeIds, teams, user]);

  const headerTitle = canManageTeams ? "Team Management" : "My Team";
  const headerSubtitle = canManageTeams
    ? `Build teams for ${company?.name || "Company"}, select members, and assign tasks directly.`
    : "You can view only the team where you are assigned. Contact admin/manager for changes.";
  const sectionTitle = canManageTeams ? "All Teams" : "Assigned Teams";
  const emptyText = canManageTeams ? "No teams created yet" : "No team assigned yet";

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return salespersonPool;
    return salespersonPool.filter((employee) =>
      employee.name.toLowerCase().includes(q) ||
      employee.department.toLowerCase().includes(q) ||
      employee.branch.toLowerCase().includes(q)
    );
  }, [salespersonPool, search]);

  const employeesById = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      map.set(employee.id, employee);
    }
    return map;
  }, [employees]);

  const toggleCreateMember = useCallback((employeeId: string) => {
    setSelectedMemberIds((current) =>
      current.includes(employeeId)
        ? current.filter((id) => id !== employeeId)
        : [...current, employeeId]
    );
  }, []);

  const createTeam = useCallback(async () => {
    if (!user || !canManageTeams) return;
    const name = newTeamName.trim();
    if (!name || selectedMemberIds.length === 0) return;

    const now = new Date().toISOString();
    const team: Team = {
      id: Crypto.randomUUID(),
      name,
      ownerId: user.id,
      ownerName: user.name,
      memberIds: selectedMemberIds,
      createdAt: now,
      updatedAt: now,
    };

    await upsertTeam(team);
    await addAuditLog({
      id: Crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      action: "Team Created",
      details: `${name} created with ${selectedMemberIds.length} members`,
      timestamp: now,
      module: "Team",
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setNewTeamName("");
    setSelectedMemberIds([]);
    setSearch("");
    await loadData();
  }, [canManageTeams, loadData, newTeamName, selectedMemberIds, user]);

  const openAssignTaskModal = useCallback((team: Team) => {
    setActiveTeam(team);
    setTaskTitle("");
    setTaskDescription("");
    setTaskPriority("medium");
    setTaskDueDays("7");
    setTaskMemberIds(team.memberIds);
    setShowTaskModal(true);
  }, []);

  const toggleTaskMember = useCallback((memberId: string) => {
    setTaskMemberIds((current) =>
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId]
    );
  }, []);

  const assignTaskToTeam = useCallback(async () => {
    if (!activeTeam || !user || !canManageTeams) return;
    const title = taskTitle.trim();
    if (!title || taskMemberIds.length === 0) return;

    const dueInDays = Math.max(1, Number.parseInt(taskDueDays, 10) || 7);
    const dueDate = new Date(Date.now() + dueInDays * 86400000).toISOString().split("T")[0];
    const nowISO = new Date().toISOString();
    const createdDate = nowISO.split("T")[0];
    const description = taskDescription.trim();

    const selectedMembers = taskMemberIds
      .map((id) => employeesById.get(id))
      .filter((member): member is Employee => Boolean(member));

    for (const member of selectedMembers) {
      const task: Task = {
        id: Crypto.randomUUID(),
        title,
        description,
        assignedTo: member.id,
        assignedToName: member.name,
        assignedBy: assignerId,
        teamId: activeTeam.id,
        teamName: activeTeam.name,
        status: "pending",
        priority: taskPriority,
        dueDate,
        createdAt: createdDate,
      };
      await addTask(task);
    }

    await addAuditLog({
      id: Crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      action: "Task Assigned",
      details: `${title} assigned to ${selectedMembers.length} member(s) in ${activeTeam.name}`,
      timestamp: nowISO,
      module: "Tasks",
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setShowTaskModal(false);
    setActiveTeam(null);
    setTaskTitle("");
    setTaskDescription("");
    setTaskMemberIds([]);
    setTaskDueDays("7");
  }, [
    activeTeam,
    assignerId,
    canManageTeams,
    employeesById,
    taskDescription,
    taskDueDays,
    taskMemberIds,
    taskPriority,
    taskTitle,
    user,
  ]);

  return (
    <AppCanvas>
      <FlatList
        data={visibleTeams}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerArea}>
            <View style={styles.navToggleWrap}>
              <DrawerToggleButton />
            </View>
            <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {headerTitle}
            </Text>
            <Text style={[styles.headerSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {headerSubtitle}
            </Text>

            {canManageTeams ? (
              <View style={[styles.createCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
                <Text style={[styles.createTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  Create New Team
                </Text>
                <TextInput
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder="Team name (e.g. Ahmedabad Sales Pod)"
                  placeholderTextColor={colors.textTertiary}
                  value={newTeamName}
                  onChangeText={setNewTeamName}
                />

                <TextInput
                  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                  placeholder="Search sales employees..."
                  placeholderTextColor={colors.textTertiary}
                  value={search}
                  onChangeText={setSearch}
                />

                <ScrollView
                  style={[
                    styles.memberPickerList,
                    { borderColor: colors.border, backgroundColor: colors.surfaceSecondary + "55" },
                  ]}
                  contentContainerStyle={styles.memberPickerListContent}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {filteredEmployees.length > 0 ? (
                    filteredEmployees.map((employee) => (
                      <MemberPickerRow
                        key={employee.id}
                        employee={employee}
                        selected={selectedMemberIds.includes(employee.id)}
                        colors={colors}
                        onToggle={toggleCreateMember}
                      />
                    ))
                  ) : (
                    <Text style={[styles.emptyPickerText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      No sales employees found.
                    </Text>
                  )}
                </ScrollView>

                <Pressable
                  onPress={() => void createTeam()}
                  disabled={!newTeamName.trim() || selectedMemberIds.length === 0}
                  style={({ pressed }) => [
                    styles.createButton,
                    {
                      backgroundColor: colors.primary,
                      opacity: pressed || !newTeamName.trim() || selectedMemberIds.length === 0 ? 0.72 : 1,
                    },
                  ]}
                >
                  <Ionicons name="people-outline" size={16} color="#FFFFFF" />
                  <Text style={styles.createButtonText}>Create Team</Text>
                </Pressable>
              </View>
            ) : null}

            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              {sectionTitle}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <TeamCard
            team={item}
            members={item.memberIds.map((id) => employeesById.get(id)).filter((m): m is Employee => Boolean(m))}
            colors={colors}
            canAssignTask={canManageTeams}
            onAssignTask={openAssignTaskModal}
          />
        )}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="people-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {emptyText}
            </Text>
          </View>
        }
      />

      <Modal visible={showTaskModal} animationType="slide" transparent onRequestClose={() => setShowTaskModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.backgroundElevated }]}>
            <View style={styles.modalHeader}>
              <View style={styles.modalTitleWrap}>
                <Text style={[styles.modalTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  Assign Task
                </Text>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={[styles.modalTeamName, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}
                >
                  {activeTeam?.name || "No team selected"}
                </Text>
              </View>
              <Pressable onPress={() => setShowTaskModal(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>

            <TextInput
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
              placeholder="Task title"
              placeholderTextColor={colors.textTertiary}
              value={taskTitle}
              onChangeText={setTaskTitle}
            />
            <TextInput
              style={[styles.modalInput, styles.modalTextarea, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
              placeholder="Task description"
              placeholderTextColor={colors.textTertiary}
              value={taskDescription}
              onChangeText={setTaskDescription}
              multiline
              numberOfLines={3}
            />

            <View style={styles.priorityRow}>
              {(["low", "medium", "high"] as const).map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setTaskPriority(value)}
                  style={[
                    styles.priorityChip,
                    {
                      backgroundColor: taskPriority === value ? colors.primary : colors.surfaceSecondary,
                      borderColor: taskPriority === value ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.priorityChipText,
                      {
                        color: taskPriority === value ? "#FFFFFF" : colors.textSecondary,
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
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
              placeholder="Due in days (e.g. 7)"
              placeholderTextColor={colors.textTertiary}
              value={taskDueDays}
              onChangeText={setTaskDueDays}
              keyboardType="number-pad"
            />

            <Text style={[styles.modalSubHeading, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
              Assign to members
            </Text>
            <ScrollView
              style={[styles.assignList, { borderColor: colors.border, backgroundColor: colors.surfaceSecondary + "35" }]}
              contentContainerStyle={styles.assignListContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {(activeTeam?.memberIds || []).map((memberId) => {
                const member = employeesById.get(memberId);
                if (!member) return null;
                const selected = taskMemberIds.includes(memberId);
                return (
                  <MemberPickerRow
                    key={memberId}
                    employee={member}
                    selected={selected}
                    colors={colors}
                    onToggle={toggleTaskMember}
                  />
                );
              })}
            </ScrollView>

            <Pressable
              onPress={() => void assignTaskToTeam()}
              disabled={!taskTitle.trim() || taskMemberIds.length === 0}
              style={({ pressed }) => [
                styles.modalButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed || !taskTitle.trim() || taskMemberIds.length === 0 ? 0.72 : 1,
                },
              ]}
            >
              <Text style={styles.modalButtonText}>Assign Task</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  headerArea: { gap: 12 },
  navToggleWrap: {
    alignSelf: "flex-start",
  },
  headerTitle: { fontSize: 24, letterSpacing: -0.5 },
  headerSubtitle: { fontSize: 13, lineHeight: 18 },
  createCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  createTitle: { fontSize: 15 },
  input: {
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13.5,
  },
  memberPickerList: {
    maxHeight: 220,
    borderRadius: 12,
    borderWidth: 1,
    padding: 8,
  },
  memberPickerListContent: {
    gap: 8,
  },
  memberPickerRow: {
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  memberPickerTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  memberPickerName: { fontSize: 13.5 },
  memberPickerMeta: { fontSize: 11.5, marginTop: 1 },
  emptyPickerText: { fontSize: 12.5, textAlign: "center", paddingVertical: 10 },
  createButton: {
    minHeight: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  createButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  sectionTitle: { fontSize: 18, marginTop: 4 },
  teamCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  teamHeaderTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  teamName: { fontSize: 15, flex: 1, minWidth: 0 },
  teamMeta: { fontSize: 12 },
  assignButton: {
    minHeight: 34,
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  assignButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  memberRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  memberChip: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: "48%",
  },
  memberChipText: { fontSize: 11.5 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14 },
  lockedWrap: {
    flex: 1,
    paddingHorizontal: 20,
  },
  lockedCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 10,
    marginTop: 18,
  },
  lockedTitle: { fontSize: 19 },
  lockedText: { fontSize: 13, textAlign: "center", lineHeight: 19 },
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
    maxHeight: "88%",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  modalTitleWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  modalTitle: { fontSize: 16 },
  modalTeamName: { fontSize: 12.5 },
  modalInput: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 13.5,
  },
  modalTextarea: {
    minHeight: 82,
    paddingTop: 10,
    textAlignVertical: "top",
  },
  priorityRow: { flexDirection: "row", gap: 8 },
  priorityChip: {
    flex: 1,
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  priorityChipText: {
    fontSize: 12,
    textTransform: "capitalize",
  },
  modalSubHeading: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  assignList: {
    maxHeight: 190,
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
  },
  assignListContent: {
    gap: 8,
    paddingBottom: 2,
  },
  modalButton: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});

