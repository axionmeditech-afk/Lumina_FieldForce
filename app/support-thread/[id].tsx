import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  Alert,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { AppCanvas } from "@/components/AppCanvas";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import type { SupportAttachment, SupportThread } from "@/lib/types";
import {
  addSupportThreadMessage,
  getSupportThreadsForCurrentUser,
  type LocalSupportAttachmentInput,
  markSupportThreadMessagesSeen,
  setSupportThreadStatus,
} from "@/lib/storage";

const SUPPORT_LIVE_POLL_MS = 7000;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;

type QueuedSupportAttachment = LocalSupportAttachmentInput & {
  id: string;
  previewUri: string;
  attachmentType: SupportAttachment["attachmentType"];
};

function resolveThreadId(input: string | string[] | undefined): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input) && typeof input[0] === "string") return input[0];
  return "";
}

function resolveMessageTickState(
  entry: SupportThread["messages"][number]
): "single" | "double_grey" | "double_blue" {
  const delivery = entry.deliveryStatus;
  if (delivery === "seen") return "double_blue";
  if (delivery === "delivered") return "double_grey";
  return "single";
}

function inferAttachmentType(
  mimeType: string | null | undefined,
  fileName: string | null | undefined
): SupportAttachment["attachmentType"] {
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const name = (fileName || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(name)) return "image";
  if (/\.(mp4|mov|m4v|avi|mkv|webm)$/.test(name)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(name)) return "audio";
  if (name) return "document";
  return "other";
}

function resolveAttachmentUrl(url: string): string {
  const normalized = (url || "").trim();
  if (!normalized) return "";
  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (normalized.startsWith("/")) {
    const base = (process.env.EXPO_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
    if (base) return `${base}${normalized}`;
  }
  return normalized;
}

export default function SupportThreadDetailScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const threadId = resolveThreadId(params.id);

  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<QueuedSupportAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [actingThreadId, setActingThreadId] = useState<string | null>(null);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === threadId) || null,
    [threadId, threads]
  );

  const loadData = useCallback(async () => {
    const data = await getSupportThreadsForCurrentUser();
    setThreads(data);
    setLoading(false);
  }, []);

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

  const handleReply = useCallback(async () => {
    if (
      !threadId ||
      submitting ||
      activeThread?.status === "closed" ||
      (!replyText.trim() && pendingAttachments.length === 0)
    ) {
      return;
    }
    setSubmitting(true);
    try {
      await addSupportThreadMessage(threadId, replyText, {
        attachments: pendingAttachments.map((entry) => ({
          uri: entry.uri,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          attachmentType: entry.attachmentType,
        })),
      });
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setReplyText("");
      setPendingAttachments([]);
      await loadData();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to send support message right now.";
      Alert.alert("Send Failed", message);
    } finally {
      setSubmitting(false);
    }
  }, [activeThread?.status, loadData, pendingAttachments, replyText, submitting, threadId]);

  const handleToggleStatus = useCallback(async () => {
    if (!activeThread) return;
    const nextStatus = activeThread.status === "open" ? "closed" : "open";
    setActingThreadId(activeThread.id);
    try {
      await setSupportThreadStatus(activeThread.id, nextStatus);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await loadData();
    } finally {
      setActingThreadId(null);
    }
  }, [activeThread, loadData]);

  const handlePickAttachments = useCallback(async () => {
    if (submitting || activeThread?.status === "closed") return;
    if (pendingAttachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      Alert.alert(
        "Attachment Limit",
        `You can upload up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments in one message.`
      );
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission Required", "Allow media library access to attach files.");
      return;
    }

    const remaining = MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, remaining),
      quality: 0.85,
    });
    if (result.canceled) return;

    const nextItems: QueuedSupportAttachment[] = [];
    for (const asset of result.assets || []) {
      if (!asset?.uri) continue;
      const name = (asset.fileName || asset.uri.split("/").pop() || "").trim() || "attachment";
      const mimeType = (asset.mimeType || "").trim() || undefined;
      const attachmentType = inferAttachmentType(mimeType, name);
      nextItems.push({
        id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        uri: asset.uri,
        previewUri: asset.uri,
        name,
        mimeType,
        sizeBytes: typeof asset.fileSize === "number" ? asset.fileSize : null,
        attachmentType,
      });
    }
    if (!nextItems.length) return;
    setPendingAttachments((previous) =>
      [...previous, ...nextItems].slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    );
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [activeThread?.status, pendingAttachments.length, submitting]);

  const handleRemovePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((previous) => previous.filter((entry) => entry.id !== attachmentId));
  }, []);

  const handleOpenAttachment = useCallback(async (rawUrl: string) => {
    const url = resolveAttachmentUrl(rawUrl);
    if (!url) return;
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert("Open Failed", "This attachment URL is not accessible on your device.");
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert("Open Failed", "Unable to open this attachment right now.");
    }
  }, []);

  useEffect(() => {
    if (!activeThread || !threadId) return;
    const currentUserId = (user?.id || "").trim();
    if (!currentUserId) return;
    const hasUnreadIncoming = activeThread.messages.some((message) => {
      if ((message.senderId || "").trim() === currentUserId) return false;
      if (message.deliveryStatus === "seen") return false;
      const seenByIds = Array.isArray(message.seenByIds)
        ? message.seenByIds
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter(Boolean)
        : [];
      return !seenByIds.includes(currentUserId);
    });
    if (!hasUnreadIncoming) return;
    void (async () => {
      const changed = await markSupportThreadMessagesSeen(threadId);
      if (changed) {
        await loadData();
      }
    })();
  }, [activeThread, loadData, threadId, user?.id]);

  return (
    <AppCanvas>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.container,
            {
              paddingTop: insets.top + 12,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <Animated.View entering={FadeInDown.duration(300)} style={styles.topBar}>
            <Pressable
              onPress={() => router.back()}
              style={[
                styles.backButton,
                { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
              ]}
            >
              <Ionicons name="chevron-back" size={17} color={colors.text} />
              <Text style={{ color: colors.text, fontFamily: "Inter_500Medium", fontSize: 12.5 }}>
                Back
              </Text>
            </Pressable>

            {activeThread ? (
              <View
                style={[
                  styles.statusChip,
                  {
                    backgroundColor:
                      activeThread.status === "open" ? `${colors.warning}18` : `${colors.success}18`,
                  },
                ]}
              >
                <Text
                  style={{
                    color: activeThread.status === "open" ? colors.warning : colors.success,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 11,
                  }}
                >
                  {activeThread.status.toUpperCase()}
                </Text>
              </View>
            ) : null}
          </Animated.View>

          {loading && !activeThread ? (
            <View style={styles.centerContent}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : !activeThread ? (
            <View style={styles.centerContent}>
              <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.textTertiary} />
              <Text
                style={[
                  styles.emptyText,
                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                ]}
              >
                Thread not found or no longer visible.
              </Text>
              <Pressable
                onPress={() => router.replace("/(tabs)/support")}
                style={[
                  styles.goBackButton,
                  { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                ]}
              >
                <Text style={{ color: colors.text, fontFamily: "Inter_500Medium", fontSize: 12 }}>
                  Go to Support Desk
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Animated.View
                entering={FadeInDown.duration(360).delay(30)}
                style={[styles.threadHeader, { borderBottomColor: colors.borderLight }]}
              >
                <Text style={[styles.subject, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  {activeThread.subject}
                </Text>
                <Text
                  style={[
                    styles.metaText,
                    { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                  ]}
                >
                  {activeThread.requestedByName} - {activeThread.priority.toUpperCase()}
                </Text>
              </Animated.View>

              <ScrollView
                style={styles.messagesList}
                contentContainerStyle={styles.messagesContent}
                showsVerticalScrollIndicator={false}
              >
                {activeThread.messages.map((entry) => {
                  const isOwn = entry.senderId === user?.id;
                  const tickState = resolveMessageTickState(entry);
                  const tickColor =
                    tickState === "double_blue"
                      ? "#38BDF8"
                      : colors.textTertiary;
                  const tickIcon =
                    tickState === "single" ? "checkmark" : "checkmark-done";
                  const attachments = Array.isArray(entry.attachments) ? entry.attachments : [];
                  return (
                    <View
                      key={entry.id}
                      style={[
                        styles.messageBubble,
                        {
                          alignSelf: isOwn ? "flex-end" : "flex-start",
                          backgroundColor: isOwn ? `${colors.primary}15` : colors.backgroundElevated,
                          borderColor: colors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.messageSender, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {entry.senderName}
                      </Text>
                      {entry.message ? (
                        <Text
                          style={[
                            styles.messageText,
                            { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                          ]}
                        >
                          {entry.message}
                        </Text>
                      ) : null}
                      {attachments.length > 0 ? (
                        <View style={styles.attachmentsWrap}>
                          {attachments.map((attachment) => {
                            const resolvedUrl = resolveAttachmentUrl(attachment.url);
                            const label = attachment.name || attachment.attachmentType.toUpperCase();
                            const isImage = attachment.attachmentType === "image";
                            return (
                              <Pressable
                                key={attachment.id}
                                onPress={() => void handleOpenAttachment(resolvedUrl)}
                                style={[
                                  styles.attachmentCard,
                                  {
                                    borderColor: colors.borderLight,
                                    backgroundColor: isOwn ? `${colors.primary}10` : colors.background,
                                  },
                                ]}
                              >
                                {isImage ? (
                                  <Image
                                    source={{ uri: resolvedUrl }}
                                    style={styles.attachmentImage}
                                    resizeMode="cover"
                                  />
                                ) : (
                                  <View style={styles.attachmentIconWrap}>
                                    <Ionicons
                                      name="document-attach-outline"
                                      size={16}
                                      color={colors.textSecondary}
                                    />
                                  </View>
                                )}
                                <View style={styles.attachmentTextWrap}>
                                  <Text
                                    numberOfLines={1}
                                    style={[
                                      styles.attachmentName,
                                      { color: colors.text, fontFamily: "Inter_500Medium" },
                                    ]}
                                  >
                                    {label}
                                  </Text>
                                  <Text
                                    numberOfLines={1}
                                    style={[
                                      styles.attachmentMeta,
                                      { color: colors.textTertiary, fontFamily: "Inter_400Regular" },
                                    ]}
                                  >
                                    {attachment.attachmentType.toUpperCase()}
                                  </Text>
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : null}
                      <View style={styles.messageMetaRow}>
                        <Text
                          style={[styles.messageTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}
                        >
                          {new Date(entry.createdAt).toLocaleString()}
                        </Text>
                        {isOwn ? (
                          <Ionicons
                            name={tickIcon}
                            size={13}
                            color={tickColor}
                            style={styles.messageTick}
                          />
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>

              <View
                style={[
                  styles.composerWrap,
                  {
                    borderTopColor: colors.borderLight,
                  },
                ]}
              >
                <View style={styles.statusActionRow}>
                  <Pressable
                    onPress={() => void handleToggleStatus()}
                    disabled={actingThreadId === activeThread.id}
                    style={[
                      styles.statusToggleButton,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.backgroundElevated,
                        opacity: actingThreadId === activeThread.id ? 0.6 : 1,
                      },
                    ]}
                  >
                    {actingThreadId === activeThread.id ? (
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                    ) : (
                      <Text
                        style={{
                          color: colors.textSecondary,
                          fontFamily: "Inter_500Medium",
                          fontSize: 11.5,
                        }}
                      >
                        {activeThread.status === "open" ? "Close Thread" : "Reopen Thread"}
                      </Text>
                    )}
                  </Pressable>
                </View>
                {pendingAttachments.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.pendingAttachmentsRow}
                  >
                    {pendingAttachments.map((attachment) => (
                      <View
                        key={attachment.id}
                        style={[
                          styles.pendingAttachmentChip,
                          {
                            borderColor: colors.border,
                            backgroundColor: colors.backgroundElevated,
                          },
                        ]}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.pendingAttachmentText,
                            { color: colors.text, fontFamily: "Inter_500Medium" },
                          ]}
                        >
                          {attachment.name || "Attachment"}
                        </Text>
                        <Pressable onPress={() => handleRemovePendingAttachment(attachment.id)}>
                          <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                ) : null}
                <View style={styles.replyRow}>
                  <Pressable
                    onPress={() => void handlePickAttachments()}
                    disabled={activeThread.status === "closed" || submitting}
                    style={[
                      styles.attachButton,
                      {
                        borderColor: colors.border,
                        backgroundColor: colors.backgroundElevated,
                        opacity: activeThread.status === "closed" || submitting ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Ionicons name="attach" size={18} color={colors.textSecondary} />
                  </Pressable>
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    placeholder={
                      activeThread.status === "closed"
                        ? "Thread is closed. Reopen to reply."
                        : "Type your message..."
                    }
                    placeholderTextColor={colors.textTertiary}
                    editable={activeThread.status !== "closed"}
                    style={[
                      styles.replyInput,
                      {
                        color: colors.text,
                        borderColor: colors.border,
                        backgroundColor: colors.backgroundElevated,
                        opacity: activeThread.status === "closed" ? 0.7 : 1,
                      },
                    ]}
                  />
                  <Pressable
                    onPress={() => void handleReply()}
                    disabled={
                      (!replyText.trim() && pendingAttachments.length === 0) ||
                      submitting ||
                      activeThread.status === "closed"
                    }
                    style={[
                      styles.replyButton,
                      {
                        backgroundColor: colors.primary,
                        opacity:
                          (!replyText.trim() && pendingAttachments.length === 0) ||
                          submitting ||
                          activeThread.status === "closed"
                            ? 0.6
                            : 1,
                      },
                    ]}
                  >
                    {submitting ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Ionicons name="paper-plane" size={15} color="#fff" />
                    )}
                  </Pressable>
                </View>
              </View>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    gap: 8,
  },
  topBar: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  backButton: {
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  statusChip: {
    minWidth: 74,
    minHeight: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  threadHeader: {
    borderBottomWidth: 1,
    paddingBottom: 8,
    gap: 2,
  },
  subject: {
    fontSize: 18,
    letterSpacing: -0.2,
  },
  metaText: {
    fontSize: 12,
  },
  messagesList: {
    flex: 1,
  },
  messagesContent: {
    paddingTop: 8,
    paddingBottom: 8,
    gap: 8,
  },
  messageBubble: {
    maxWidth: "92%",
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 3,
  },
  messageSender: {
    fontSize: 11.5,
  },
  messageText: {
    fontSize: 13,
    lineHeight: 19,
  },
  messageTime: {
    fontSize: 10,
  },
  messageMetaRow: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 3,
  },
  messageTick: {
    marginTop: 0.5,
  },
  attachmentsWrap: {
    marginTop: 4,
    gap: 6,
  },
  attachmentCard: {
    minHeight: 52,
    borderRadius: 10,
    borderWidth: 1,
    padding: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  attachmentImage: {
    width: 46,
    height: 46,
    borderRadius: 8,
    backgroundColor: "#E5E7EB",
  },
  attachmentIconWrap: {
    width: 46,
    height: 46,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(148, 163, 184, 0.2)",
  },
  attachmentTextWrap: {
    flex: 1,
    gap: 1,
  },
  attachmentName: {
    fontSize: 12,
  },
  attachmentMeta: {
    fontSize: 10.5,
  },
  composerWrap: {
    borderTopWidth: 1,
    paddingTop: 10,
    gap: 8,
  },
  statusActionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  statusToggleButton: {
    minHeight: 32,
    minWidth: 108,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  replyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pendingAttachmentsRow: {
    paddingVertical: 2,
    gap: 8,
  },
  pendingAttachmentChip: {
    maxWidth: 220,
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pendingAttachmentText: {
    maxWidth: 170,
    fontSize: 11.5,
  },
  attachButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  replyInput: {
    flex: 1,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: "Inter_400Regular",
  },
  replyButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  emptyText: {
    fontSize: 12.5,
  },
  goBackButton: {
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
