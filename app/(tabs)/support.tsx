import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
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
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import type { SupportThread } from "@/lib/types";
import {
  addSupportThreadMessage,
  createSupportThread,
  getSupportThreadsForCurrentUser,
  setSupportThreadStatus,
} from "@/lib/storage";
import { canModerateSupport } from "@/lib/role-access";

export default function SupportScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [replyText, setReplyText] = useState("");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actingThreadId, setActingThreadId] = useState<string | null>(null);

  const isModerator = canModerateSupport(user?.role);

  const loadData = useCallback(async () => {
    const data = await getSupportThreadsForCurrentUser();
    setThreads(data);
    setLoading(false);
    if (!activeThreadId && data.length) {
      setActiveThreadId(data[0].id);
    }
  }, [activeThreadId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) || null,
    [activeThreadId, threads]
  );

  const handleCreate = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await createSupportThread({ subject, message, priority });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSubject("");
      setMessage("");
      setPriority("normal");
      await loadData();
    } finally {
      setSubmitting(false);
    }
  }, [loadData, message, priority, subject, submitting]);

  const handleReply = useCallback(async () => {
    if (!activeThread || !replyText.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addSupportThreadMessage(activeThread.id, replyText);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setReplyText("");
      await loadData();
    } finally {
      setSubmitting(false);
    }
  }, [activeThread, loadData, replyText, submitting]);

  const handleToggleStatus = useCallback(
    async (thread: SupportThread) => {
      const nextStatus = thread.status === "open" ? "closed" : "open";
      setActingThreadId(thread.id);
      try {
        await setSupportThreadStatus(thread.id, nextStatus);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        await loadData();
      } finally {
        setActingThreadId(null);
      }
    },
    [loadData]
  );

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
          <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Support Desk</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {isModerator
              ? "Assist employees, reply to requests, and close resolved threads."
              : "Raise issues, ask help, and track responses from leadership."}
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(70)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            New Request
          </Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Subject (ex: App crash on attendance)"
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <TextInput
            multiline
            value={message}
            onChangeText={setMessage}
            placeholder="Write details so support team can help quickly."
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              styles.multilineInput,
              { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
            ]}
          />
          <View style={styles.priorityRow}>
            <Pressable
              onPress={() => setPriority("normal")}
              style={[
                styles.priorityButton,
                {
                  borderColor: priority === "normal" ? colors.primary : colors.border,
                  backgroundColor: priority === "normal" ? colors.primary + "16" : colors.background,
                },
              ]}
            >
              <Text style={{ color: priority === "normal" ? colors.primary : colors.textSecondary, fontFamily: "Inter_500Medium" }}>
                Normal
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setPriority("high")}
              style={[
                styles.priorityButton,
                {
                  borderColor: priority === "high" ? colors.danger : colors.border,
                  backgroundColor: priority === "high" ? colors.danger + "16" : colors.background,
                },
              ]}
            >
              <Text style={{ color: priority === "high" ? colors.danger : colors.textSecondary, fontFamily: "Inter_500Medium" }}>
                High
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void handleCreate()}
              disabled={submitting || !subject.trim() || !message.trim()}
              style={[
                styles.sendButton,
                {
                  backgroundColor: colors.primary,
                  opacity: submitting || !subject.trim() || !message.trim() ? 0.6 : 1,
                },
              ]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="send" size={14} color="#fff" />
                  <Text style={styles.sendButtonText}>Submit</Text>
                </>
              )}
            </Pressable>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(120)} style={styles.columnsWrap}>
          <View style={[styles.card, styles.leftCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Threads
            </Text>
            {loading ? (
              <View style={styles.emptyWrap}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : threads.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="chatbox-ellipses-outline" size={20} color={colors.textTertiary} />
                <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  No support threads yet.
                </Text>
              </View>
            ) : (
              threads.map((thread, index) => (
                <Pressable
                  key={thread.id}
                  onPress={() => setActiveThreadId(thread.id)}
                  style={({ pressed }) => [
                    styles.threadRow,
                    index < threads.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
                    {
                      opacity: pressed ? 0.85 : 1,
                      backgroundColor: activeThreadId === thread.id ? colors.primary + "10" : "transparent",
                    },
                  ]}
                >
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={[styles.threadTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      {thread.subject}
                    </Text>
                    <Text style={[styles.threadMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      {thread.requestedByName} - {thread.priority.toUpperCase()}
                    </Text>
                    <Text style={[styles.threadMeta, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                      {new Date(thread.updatedAt).toLocaleString()}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusChip,
                      {
                        backgroundColor:
                          thread.status === "open" ? colors.warning + "15" : colors.success + "15",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color: thread.status === "open" ? colors.warning : colors.success,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 10,
                      }}
                    >
                      {thread.status.toUpperCase()}
                    </Text>
                  </View>
                </Pressable>
              ))
            )}
          </View>

          <View style={[styles.card, styles.rightCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.sectionHeaderRow}>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                Conversation
              </Text>
              {activeThread ? (
                <Pressable
                  onPress={() => void handleToggleStatus(activeThread)}
                  disabled={actingThreadId === activeThread.id}
                  style={[
                    styles.statusToggleButton,
                    {
                      borderColor: colors.border,
                      opacity: actingThreadId === activeThread.id ? 0.6 : 1,
                    },
                  ]}
                >
                  {actingThreadId === activeThread.id ? (
                    <ActivityIndicator size="small" color={colors.textSecondary} />
                  ) : (
                    <Text style={{ color: colors.textSecondary, fontFamily: "Inter_500Medium", fontSize: 11 }}>
                      {activeThread.status === "open" ? "Close" : "Reopen"}
                    </Text>
                  )}
                </Pressable>
              ) : null}
            </View>

            {!activeThread ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="arrow-back-outline" size={18} color={colors.textTertiary} />
                <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Select a thread to view messages.
                </Text>
              </View>
            ) : (
              <>
                <ScrollView style={styles.messagesList} showsVerticalScrollIndicator={false}>
                  {activeThread.messages.map((entry) => {
                    const isOwn = entry.senderId === user?.id;
                    return (
                      <View
                        key={entry.id}
                        style={[
                          styles.messageBubble,
                          {
                            alignSelf: isOwn ? "flex-end" : "flex-start",
                            backgroundColor: isOwn ? colors.primary + "15" : colors.background,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <Text style={[styles.messageSender, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          {entry.senderName}
                        </Text>
                        <Text style={[styles.messageText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                          {entry.message}
                        </Text>
                        <Text style={[styles.messageTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                          {new Date(entry.createdAt).toLocaleString()}
                        </Text>
                      </View>
                    );
                  })}
                </ScrollView>
                <View style={styles.replyRow}>
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    placeholder="Write a reply..."
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.replyInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.background,
                      },
                    ]}
                  />
                  <Pressable
                    onPress={() => void handleReply()}
                    disabled={!replyText.trim() || submitting || activeThread.status === "closed"}
                    style={[
                      styles.replyButton,
                      {
                        backgroundColor: colors.primary,
                        opacity: !replyText.trim() || submitting || activeThread.status === "closed" ? 0.6 : 1,
                      },
                    ]}
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Ionicons name="paper-plane" size={14} color="#fff" />
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </View>
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
  },
  sectionTitle: {
    fontSize: 14,
    marginBottom: 8,
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
  priorityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  priorityButton: {
    minWidth: 72,
    minHeight: 34,
    borderWidth: 1,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  sendButton: {
    marginLeft: "auto",
    minWidth: 90,
    minHeight: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
  },
  sendButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  columnsWrap: {
    marginTop: 12,
    gap: 12,
  },
  leftCard: {
    minHeight: 160,
  },
  rightCard: {
    minHeight: 280,
  },
  emptyWrap: {
    minHeight: 100,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: 12.5,
  },
  threadRow: {
    paddingVertical: 10,
    paddingHorizontal: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  threadTitle: {
    fontSize: 13.5,
  },
  threadMeta: {
    fontSize: 11,
  },
  statusChip: {
    minWidth: 72,
    minHeight: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  statusToggleButton: {
    minHeight: 30,
    minWidth: 74,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  messagesList: {
    maxHeight: 280,
    marginTop: 8,
  },
  messageBubble: {
    maxWidth: "94%",
    borderRadius: 10,
    borderWidth: 1,
    padding: 8,
    marginBottom: 8,
    gap: 3,
  },
  messageSender: {
    fontSize: 11.5,
  },
  messageText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  messageTime: {
    fontSize: 10,
  },
  replyRow: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  replyInput: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontFamily: "Inter_400Regular",
  },
  replyButton: {
    width: 42,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
});
