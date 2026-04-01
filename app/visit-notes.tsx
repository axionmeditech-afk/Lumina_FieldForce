import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useNavigation } from "expo-router";
import { AppCanvas } from "@/components/AppCanvas";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { getTasks } from "@/lib/storage";
import { formatMumbaiDateTime, formatMumbaiDateKey } from "@/lib/ist-time";
import type { Task } from "@/lib/types";

function matchesSalesperson(task: Task, userId?: string, userName?: string): boolean {
  if (!userId && !userName) return false;
  return task.assignedTo === userId || (!!userName && task.assignedToName === userName);
}

export default function VisitNotesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const navigation = useNavigation();
  const isAdminViewer = user?.role === "admin";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const loadVisitNotes = useCallback(async () => {
    setLoading(true);
    try {
      const taskData = await getTasks();
      setTasks(taskData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVisitNotes();
  }, [loadVisitNotes]);

  const handleBackPress = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    router.replace("/(tabs)");
  }, [navigation]);

  const visitNotes = useMemo(() => {
    return tasks
      .filter((task) => task.taskType === "field_visit")
      .filter((task) => (isAdminViewer ? true : matchesSalesperson(task, user?.id, user?.name)))
      .filter(
        (task) =>
          task.departureAt ||
          task.meetingNotes?.trim() ||
          task.visitDepartureNotes?.trim()
      )
      .sort((a, b) => {
        const left = new Date(b.visitDepartureNotesUpdatedAt || b.departureAt || b.createdAt).getTime();
        const right = new Date(a.visitDepartureNotesUpdatedAt || a.departureAt || a.createdAt).getTime();
        return left - right;
      });
  }, [isAdminViewer, tasks, user?.id, user?.name]);

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 32 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={handleBackPress} hitSlop={12} style={styles.backButton}>
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.headerTextWrap}>
            <Text style={[styles.eyebrow, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
              Sales Visit Log
            </Text>
            <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Visit Notes
            </Text>
          </View>
        </View>

        <View style={[styles.heroCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          <View style={[styles.heroIcon, { backgroundColor: `${colors.primary}16` }]}>
            <Ionicons name="document-text-outline" size={18} color={colors.primary} />
          </View>
          <View style={styles.heroTextWrap}>
            <Text style={[styles.heroTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              {isAdminViewer ? "Team visit notes in one place" : "Departure notes saved per visit"}
            </Text>
            <Text style={[styles.heroMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {isAdminViewer
                ? "Review salesperson, visit, meeting notes, and departure notes together in a clean table."
                : "Review your remarks, dates, and follow-up context after each field visit."}
            </Text>
          </View>
        </View>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : isAdminViewer && visitNotes.length ? (
          <View style={[styles.adminTableWrap, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.adminTable}>
                <View style={[styles.adminTableHeaderRow, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.adminHeaderCell, styles.adminSalespersonCol, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                    Salesperson
                  </Text>
                  <Text style={[styles.adminHeaderCell, styles.adminVisitCol, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                    Visit
                  </Text>
                  <Text style={[styles.adminHeaderCell, styles.adminDateCol, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                    Date
                  </Text>
                  <Text style={[styles.adminHeaderCell, styles.adminMeetingCol, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                    Meeting Note
                  </Text>
                  <Text style={[styles.adminHeaderCell, styles.adminDepartureCol, { color: colors.textTertiary, fontFamily: "Inter_700Bold" }]}>
                    Departure Note
                  </Text>
                </View>
                {visitNotes.map((task, index) => (
                  <View
                    key={task.id}
                    style={[
                      styles.adminTableRow,
                      index < visitNotes.length - 1 && { borderBottomColor: colors.borderLight, borderBottomWidth: 0.5 },
                    ]}
                  >
                    <Text style={[styles.adminCell, styles.adminSalespersonCol, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      {task.assignedToName || "--"}
                    </Text>
                    <View style={[styles.adminVisitCol, styles.adminCellView]}>
                      <Text style={[styles.adminCell, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {task.visitSequence ? `#${task.visitSequence} ` : ""}
                        {task.visitLocationLabel?.trim() || task.title}
                      </Text>
                      <Text style={[styles.adminCellSubtext, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {(task.visitLocationAddress?.trim() || task.description || "Field visit").trim()}
                      </Text>
                    </View>
                    <Text style={[styles.adminCell, styles.adminDateCol, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      {task.visitPlanDate ? formatMumbaiDateKey(task.visitPlanDate) : formatMumbaiDateTime(task.createdAt)}
                    </Text>
                    <Text style={[styles.adminCell, styles.adminMeetingCol, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      {task.meetingNotes?.trim() || "--"}
                    </Text>
                    <Text style={[styles.adminCell, styles.adminDepartureCol, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      {task.visitDepartureNotes?.trim() || "--"}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          </View>
        ) : visitNotes.length ? (
          visitNotes.map((task) => {
            const meetingNote = task.meetingNotes?.trim() || "";
            const departureNote = task.visitDepartureNotes?.trim() || "";
            const primaryNote = meetingNote || departureNote || "No note added for this visit.";
            return (
              <View
                key={task.id}
                style={[styles.noteCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
              >
                <View style={styles.noteHeaderRow}>
                  <View style={styles.noteHeaderText}>
                    <Text style={[styles.noteTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      {task.visitSequence ? `#${task.visitSequence} ` : ""}
                      {task.visitLocationLabel?.trim() || task.title}
                    </Text>
                    <Text style={[styles.noteSub, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      {(task.visitLocationAddress?.trim() || task.description || "Field visit").trim()}
                    </Text>
                  </View>
                  <View style={[styles.statusPill, { backgroundColor: `${colors.primary}12` }]}>
                    <Text style={[styles.statusPillText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                      {task.status === "completed" ? "Completed" : "Saved"}
                    </Text>
                  </View>
                </View>

                <View style={styles.metaRow}>
                  <View style={styles.metaItem}>
                    <Ionicons name="calendar-outline" size={14} color={colors.textTertiary} />
                    <Text style={[styles.metaText, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
                      {task.visitPlanDate ? formatMumbaiDateKey(task.visitPlanDate) : formatMumbaiDateTime(task.createdAt)}
                    </Text>
                  </View>
                  <View style={styles.metaItem}>
                    <Ionicons name="time-outline" size={14} color={colors.textTertiary} />
                    <Text style={[styles.metaText, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
                      {task.departureAt ? formatMumbaiDateTime(task.departureAt) : "Departure pending"}
                    </Text>
                  </View>
                </View>

                <View style={[styles.noteBody, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
                  {meetingNote ? (
                    <Text style={[styles.noteLabel, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                      Meeting Note
                    </Text>
                  ) : null}
                  <Text style={[styles.noteBodyText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    {primaryNote}
                  </Text>
                  {meetingNote && departureNote ? (
                    <>
                      <Text style={[styles.noteLabel, { color: colors.textTertiary, fontFamily: "Inter_600SemiBold" }]}>
                        Departure Note
                      </Text>
                      <Text style={[styles.noteBodyText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                        {departureNote}
                      </Text>
                    </>
                  ) : null}
                </View>

              </View>
            );
          })
        ) : (
          <View style={[styles.emptyCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="document-text-outline" size={28} color={colors.textTertiary} />
            <Text style={[styles.emptyTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              No visit notes yet
            </Text>
            <Text style={[styles.emptyMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Complete a visit from Sales AI and add departure notes to review them here later.
            </Text>
          </View>
        )}
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
    gap: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextWrap: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 24,
    letterSpacing: -0.6,
  },
  heroCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  heroIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTextWrap: {
    flex: 1,
    gap: 4,
  },
  heroTitle: {
    fontSize: 15,
  },
  heroMeta: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  loadingWrap: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
  },
  adminTableWrap: {
    borderWidth: 1,
    borderRadius: 20,
    overflow: "hidden",
  },
  adminTable: {
    minWidth: 1080,
  },
  adminTableHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  adminTableRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  adminHeaderCell: {
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  adminCell: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  adminCellView: {
    justifyContent: "center",
    gap: 4,
  },
  adminCellSubtext: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  adminSalespersonCol: {
    width: 150,
    paddingRight: 14,
  },
  adminVisitCol: {
    width: 250,
    paddingRight: 14,
  },
  adminDateCol: {
    width: 150,
    paddingRight: 14,
  },
  adminMeetingCol: {
    width: 250,
    paddingRight: 14,
  },
  adminDepartureCol: {
    width: 250,
  },
  noteCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    gap: 12,
  },
  noteHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  noteHeaderText: {
    flex: 1,
    gap: 4,
  },
  noteTitle: {
    fontSize: 15,
    lineHeight: 20,
  },
  noteSub: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusPillText: {
    fontSize: 11.5,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaText: {
    fontSize: 11.5,
  },
  noteBody: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 8,
  },
  noteLabel: {
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  noteBodyText: {
    fontSize: 13,
    lineHeight: 19,
  },
  emptyCard: {
    minHeight: 220,
    borderWidth: 1,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 10,
  },
  emptyTitle: {
    fontSize: 18,
  },
  emptyMeta: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
});
