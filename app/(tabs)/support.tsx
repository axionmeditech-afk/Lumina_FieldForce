import React, { useCallback, useEffect, useState } from "react";
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
import { router, useFocusEffect } from "expo-router";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import type { SupportThread } from "@/lib/types";
import {
  createSupportThread,
  getSupportThreadsForCurrentUser,
  markSupportThreadMessagesSeen,
} from "@/lib/storage";
import { canModerateSupport } from "@/lib/role-access";

const SUPPORT_LIVE_POLL_MS = 7000;

export default function SupportScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [submitting, setSubmitting] = useState(false);

  const isModerator = canModerateSupport(user?.role);

  const loadData = useCallback(async () => {
    const data = await getSupportThreadsForCurrentUser();
    setThreads(data);
    setLoading(false);
  }, []);

  const markThreadMessagesSeenLocally = useCallback(
    (threadId: string) => {
      const currentUserId = (user?.id || "").trim();
      if (!currentUserId) return;
      const now = new Date().toISOString();
      setThreads((previous) =>
        previous.map((thread) => {
          if (thread.id !== threadId) return thread;
          const nextMessages = (thread.messages || []).map((entry) => {
            const senderId = (entry.senderId || "").trim();
            if (!senderId || senderId === currentUserId) return entry;
            const seenByIds = Array.isArray(entry.seenByIds)
              ? entry.seenByIds
                  .filter((id): id is string => typeof id === "string")
                  .map((id) => id.trim())
                  .filter(Boolean)
              : [];
            if (seenByIds.includes(currentUserId)) return entry;
            return {
              ...entry,
              deliveryStatus: "seen" as const,
              deliveredAt: entry.deliveredAt || entry.createdAt,
              seenAt: entry.seenAt || now,
              seenByIds: Array.from(new Set([...seenByIds, currentUserId])),
            };
          });
          return { ...thread, messages: nextMessages };
        })
      );
    },
    [user?.id]
  );

  const handleOpenThread = useCallback(
    (threadId: string) => {
      markThreadMessagesSeenLocally(threadId);
      void (async () => {
        try {
          await markSupportThreadMessagesSeen(threadId);
          await loadData();
        } finally {
          router.push({
            pathname: "/support-thread/[id]",
            params: { id: threadId },
          });
        }
      })();
    },
    [loadData, markThreadMessagesSeenLocally]
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      const pollId = setInterval(() => {
        void loadData();
      }, SUPPORT_LIVE_POLL_MS);
      void loadData();
      return () => {
        clearInterval(pollId);
      };
    }, [loadData])
  );

  const handleCreate = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await createSupportThread({ subject, message, priority });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSubject("");
      setMessage("");
      setPriority("normal");
      await loadData();
    } finally {
      setSubmitting(false);
    }
  }, [loadData, message, priority, subject, submitting]);

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
            Support Desk
          </Text>
          <Text
            style={[
              styles.subtitle,
              { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
            ]}
          >
            {isModerator
              ? "Assist employees and track every live issue in one queue."
              : "Raise issues and chat with support in dedicated threads."}
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(400).delay(70)}
          style={[
            styles.card,
            { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
          ]}
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
                  backgroundColor: priority === "normal" ? `${colors.primary}16` : colors.background,
                },
              ]}
            >
              <Text
                style={{
                  color: priority === "normal" ? colors.primary : colors.textSecondary,
                  fontFamily: "Inter_500Medium",
                }}
              >
                Normal
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setPriority("high")}
              style={[
                styles.priorityButton,
                {
                  borderColor: priority === "high" ? colors.danger : colors.border,
                  backgroundColor: priority === "high" ? `${colors.danger}16` : colors.background,
                },
              ]}
            >
              <Text
                style={{
                  color: priority === "high" ? colors.danger : colors.textSecondary,
                  fontFamily: "Inter_500Medium",
                }}
              >
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

        <Animated.View
          entering={FadeInDown.duration(400).delay(120)}
          style={[
            styles.card,
            styles.threadCard,
            { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
          ]}
        >
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
              <Text
                style={[
                  styles.emptyText,
                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                ]}
              >
                No support threads yet.
              </Text>
            </View>
          ) : (
            threads.map((thread, index) => {
              const currentUserId = (user?.id || "").trim();
              const messages = Array.isArray(thread.messages) ? thread.messages : [];
              const lastEntry = messages[messages.length - 1];
              const lastMessage = lastEntry?.message?.trim() || "";
              const lastAttachmentCount = Array.isArray(lastEntry?.attachments)
                ? lastEntry.attachments.length
                : 0;
              const lastSummary =
                lastMessage ||
                (lastAttachmentCount === 1
                  ? "sent an attachment"
                  : lastAttachmentCount > 1
                    ? `sent ${lastAttachmentCount} attachments`
                    : "");
              const unreadCount = messages.reduce((count, entry) => {
                const senderId = (entry.senderId || "").trim();
                if (!currentUserId || senderId === currentUserId) return count;
                if (entry.deliveryStatus === "seen") return count;
                const seenByIds = Array.isArray(entry.seenByIds)
                  ? entry.seenByIds
                      .filter((id): id is string => typeof id === "string")
                      .map((id) => id.trim())
                      .filter(Boolean)
                  : [];
                return seenByIds.includes(currentUserId) ? count : count + 1;
              }, 0);
              const previewText = lastEntry
                ? lastSummary
                  ? `${(lastEntry.senderId || "").trim() === currentUserId ? "You" : lastEntry.senderName}: ${lastSummary}`
                  : "Open this thread to chat."
                : "Open this thread to chat.";
              return (
                <Pressable
                  key={thread.id}
                  onPress={() => handleOpenThread(thread.id)}
                  style={({ pressed }) => [
                    styles.threadRow,
                    index < threads.length - 1 && {
                      borderBottomWidth: 1,
                      borderBottomColor: colors.borderLight,
                    },
                    {
                      opacity: pressed ? 0.86 : 1,
                    },
                  ]}
                >
                  <View style={styles.threadIconWrap}>
                    <Ionicons name="chatbubble-ellipses-outline" size={17} color={colors.primary} />
                  </View>
                  <View style={styles.threadBody}>
                    <View style={styles.threadTopLine}>
                      <Text
                        numberOfLines={1}
                        style={[styles.threadTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
                      >
                        {thread.subject}
                      </Text>
                      <View style={styles.threadHeaderRight}>
                        {unreadCount > 0 ? (
                          <View style={styles.unreadBadge}>
                            <Text style={styles.unreadBadgeText}>
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </Text>
                          </View>
                        ) : null}
                        <View
                          style={[
                            styles.statusChip,
                            {
                              backgroundColor:
                                thread.status === "open"
                                  ? `${colors.warning}15`
                                  : `${colors.success}15`,
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
                      </View>
                    </View>
                    <Text
                      style={[styles.threadMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
                      numberOfLines={1}
                    >
                      {thread.requestedByName} - {thread.priority.toUpperCase()}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.threadPreview,
                        {
                          color: unreadCount > 0 ? colors.text : colors.textTertiary,
                          fontFamily: unreadCount > 0 ? "Inter_500Medium" : "Inter_400Regular",
                        },
                      ]}
                    >
                      {previewText}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
                </Pressable>
              );
            })
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
  threadCard: {
    marginTop: 12,
    minHeight: 240,
  },
  emptyWrap: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyText: {
    fontSize: 12.5,
  },
  threadRow: {
    minHeight: 74,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  threadIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(20, 184, 166, 0.12)",
  },
  threadBody: {
    flex: 1,
    gap: 2,
  },
  threadTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  threadHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  threadTitle: {
    flex: 1,
    fontSize: 13.5,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadgeText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 10,
  },
  statusChip: {
    minWidth: 66,
    minHeight: 22,
    paddingHorizontal: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  threadMeta: {
    fontSize: 11,
  },
  threadPreview: {
    fontSize: 11.5,
  },
});
