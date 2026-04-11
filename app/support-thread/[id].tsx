import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
  Alert,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { WebView } from "react-native-webview";
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

type AttachmentPreviewState = {
  url: string;
  name: string;
  attachmentType: SupportAttachment["attachmentType"];
};

type ImageGalleryState = {
  items: SupportAttachment[];
  index: number;
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
  const [activeAttachmentPreview, setActiveAttachmentPreview] = useState<AttachmentPreviewState | null>(
    null
  );
  const [activeImageGallery, setActiveImageGallery] = useState<ImageGalleryState | null>(null);
  const [imageGalleryWidth, setImageGalleryWidth] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [actingThreadId, setActingThreadId] = useState<string | null>(null);
  const imageGalleryRef = useRef<ScrollView | null>(null);

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

  const handleOpenAttachment = useCallback((attachment: SupportAttachment) => {
    const url = resolveAttachmentUrl(attachment.url);
    if (!url) {
      Alert.alert("Preview Unavailable", "Attachment URL is missing.");
      return;
    }
    setActiveImageGallery(null);
    setActiveAttachmentPreview({
      url,
      name: attachment.name || "Attachment",
      attachmentType: attachment.attachmentType,
    });
  }, []);

  const handleOpenImageGallery = useCallback(
    (images: SupportAttachment[], index: number) => {
      const validItems = images.filter((item) => Boolean(resolveAttachmentUrl(item.url)));
      if (!validItems.length) {
        Alert.alert("Preview Unavailable", "Image URL is missing.");
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, validItems.length - 1));
      setActiveAttachmentPreview(null);
      setActiveImageGallery({
        items: validItems,
        index: safeIndex,
      });
    },
    []
  );

  const handleImageGalleryScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!activeImageGallery || imageGalleryWidth <= 0) return;
      const nextIndex = Math.round(event.nativeEvent.contentOffset.x / imageGalleryWidth);
      const boundedIndex = Math.max(0, Math.min(nextIndex, activeImageGallery.items.length - 1));
      if (boundedIndex === activeImageGallery.index) return;
      setActiveImageGallery((current) =>
        current
          ? {
              ...current,
              index: boundedIndex,
            }
          : current
      );
    },
    [activeImageGallery, imageGalleryWidth]
  );

  const scrollGalleryToIndex = useCallback(
    (nextIndex: number, animated: boolean) => {
      if (!activeImageGallery || imageGalleryWidth <= 0) return;
      const boundedIndex = Math.max(0, Math.min(nextIndex, activeImageGallery.items.length - 1));
      imageGalleryRef.current?.scrollTo({
        x: boundedIndex * imageGalleryWidth,
        y: 0,
        animated,
      });
      setActiveImageGallery((current) =>
        current
          ? {
              ...current,
              index: boundedIndex,
            }
          : current
      );
    },
    [activeImageGallery, imageGalleryWidth]
  );

  const handlePrevImage = useCallback(() => {
    if (!activeImageGallery) return;
    scrollGalleryToIndex(activeImageGallery.index - 1, true);
  }, [activeImageGallery, scrollGalleryToIndex]);

  const handleNextImage = useCallback(() => {
    if (!activeImageGallery) return;
    scrollGalleryToIndex(activeImageGallery.index + 1, true);
  }, [activeImageGallery, scrollGalleryToIndex]);

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

  useEffect(() => {
    if (!activeImageGallery || imageGalleryWidth <= 0) return;
    const timer = setTimeout(() => {
      imageGalleryRef.current?.scrollTo({
        x: activeImageGallery.index * imageGalleryWidth,
        y: 0,
        animated: false,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [activeImageGallery, imageGalleryWidth]);

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
                  const imageAttachments = attachments.filter(
                    (attachment) => attachment.attachmentType === "image"
                  );
                  const otherAttachments = attachments.filter(
                    (attachment) => attachment.attachmentType !== "image"
                  );
                  const visibleImageAttachments = imageAttachments.slice(0, 4);
                  const imageOverflowCount = Math.max(0, imageAttachments.length - 4);
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
                      {imageAttachments.length === 1 ? (
                        <Pressable
                          onPress={() => handleOpenImageGallery(imageAttachments, 0)}
                          style={[
                            styles.singleImageWrap,
                            {
                              borderColor: colors.borderLight,
                              backgroundColor: isOwn ? `${colors.primary}10` : colors.background,
                            },
                          ]}
                        >
                          <Image
                            source={{ uri: resolveAttachmentUrl(imageAttachments[0].url) }}
                            style={styles.singleImage}
                            resizeMode="cover"
                          />
                        </Pressable>
                      ) : null}
                      {imageAttachments.length > 1 ? (
                        <View style={styles.imageGridWrap}>
                          {visibleImageAttachments.map((attachment, index) => {
                            const resolvedUrl = resolveAttachmentUrl(attachment.url);
                            const showOverflowOverlay =
                              index === 3 && imageOverflowCount > 0;
                            return (
                              <Pressable
                                key={attachment.id}
                                onPress={() => handleOpenImageGallery(imageAttachments, index)}
                                style={[
                                  styles.imageGridTile,
                                  {
                                    borderColor: colors.borderLight,
                                    backgroundColor: isOwn ? `${colors.primary}10` : colors.background,
                                  },
                                ]}
                              >
                                <Image
                                  source={{ uri: resolvedUrl }}
                                  style={styles.imageGridImage}
                                  resizeMode="cover"
                                />
                                {showOverflowOverlay ? (
                                  <View style={styles.imageOverflowOverlay}>
                                    <Text style={styles.imageOverflowText}>{`+${imageOverflowCount}`}</Text>
                                  </View>
                                ) : null}
                              </Pressable>
                            );
                          })}
                        </View>
                      ) : null}
                      {otherAttachments.length > 0 ? (
                        <View style={styles.attachmentsWrap}>
                          {otherAttachments.map((attachment) => {
                            const label = attachment.name || attachment.attachmentType.toUpperCase();
                            return (
                              <Pressable
                                key={attachment.id}
                                onPress={() => handleOpenAttachment(attachment)}
                                style={[
                                  styles.attachmentCard,
                                  {
                                    borderColor: colors.borderLight,
                                    backgroundColor: isOwn ? `${colors.primary}10` : colors.background,
                                  },
                                ]}
                              >
                                <View style={styles.attachmentIconWrap}>
                                  <Ionicons
                                    name="document-attach-outline"
                                    size={16}
                                    color={colors.textSecondary}
                                  />
                                </View>
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
      <Modal
        visible={Boolean(activeImageGallery)}
        transparent
        animationType="fade"
        onRequestClose={() => setActiveImageGallery(null)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            style={styles.previewBackdropPressable}
            onPress={() => setActiveImageGallery(null)}
          />
          <View
            style={[
              styles.previewCard,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.previewHeader}>
              <Text
                numberOfLines={1}
                style={[styles.previewTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
              >
                {activeImageGallery
                  ? `${activeImageGallery.index + 1}/${activeImageGallery.items.length} ${activeImageGallery.items[activeImageGallery.index]?.name || "Image"}`
                  : "Image"}
              </Text>
              <Pressable onPress={() => setActiveImageGallery(null)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View
              style={styles.previewCarouselWrap}
              onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                if (!width || width === imageGalleryWidth) return;
                setImageGalleryWidth(width);
              }}
            >
              <ScrollView
                ref={imageGalleryRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={handleImageGalleryScrollEnd}
                scrollEventThrottle={16}
              >
                {(activeImageGallery?.items || []).map((item) => (
                  <View
                    key={item.id}
                    style={[styles.previewSlide, { width: imageGalleryWidth || 320 }]}
                  >
                    <Image
                      source={{ uri: resolveAttachmentUrl(item.url) }}
                      style={styles.previewImage}
                      resizeMode="contain"
                    />
                  </View>
                ))}
              </ScrollView>
              {activeImageGallery && activeImageGallery.items.length > 1 ? (
                <>
                  <Pressable
                    onPress={handlePrevImage}
                    disabled={activeImageGallery.index <= 0}
                    style={[
                      styles.carouselNavButton,
                      styles.carouselNavLeft,
                      { opacity: activeImageGallery.index <= 0 ? 0.35 : 0.95 },
                    ]}
                  >
                    <Ionicons name="chevron-back" size={20} color="#fff" />
                  </Pressable>
                  <Pressable
                    onPress={handleNextImage}
                    disabled={activeImageGallery.index >= activeImageGallery.items.length - 1}
                    style={[
                      styles.carouselNavButton,
                      styles.carouselNavRight,
                      {
                        opacity:
                          activeImageGallery.index >= activeImageGallery.items.length - 1
                            ? 0.35
                            : 0.95,
                      },
                    ]}
                  >
                    <Ionicons name="chevron-forward" size={20} color="#fff" />
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={Boolean(activeAttachmentPreview)}
        transparent
        animationType="fade"
        onRequestClose={() => setActiveAttachmentPreview(null)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable
            style={styles.previewBackdropPressable}
            onPress={() => setActiveAttachmentPreview(null)}
          />
          <View
            style={[
              styles.previewCard,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.previewHeader}>
              <Text
                numberOfLines={1}
                style={[styles.previewTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
              >
                {activeAttachmentPreview?.name || "Attachment"}
              </Text>
              <Pressable onPress={() => setActiveAttachmentPreview(null)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.previewWebWrap}>
              <WebView
                source={{ uri: activeAttachmentPreview?.url || "" }}
                startInLoadingState
                style={styles.previewWebView}
              />
            </View>
          </View>
        </View>
      </Modal>
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
  singleImageWrap: {
    marginTop: 4,
    width: 188,
    height: 188,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
  },
  singleImage: {
    width: "100%",
    height: "100%",
  },
  imageGridWrap: {
    marginTop: 4,
    width: 188,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  imageGridTile: {
    width: 92,
    height: 92,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
  },
  imageGridImage: {
    width: "100%",
    height: "100%",
  },
  imageOverflowOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageOverflowText: {
    color: "#fff",
    fontFamily: "Inter_700Bold",
    fontSize: 22,
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
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(2, 6, 23, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  previewBackdropPressable: {
    ...StyleSheet.absoluteFillObject,
  },
  previewCard: {
    width: "100%",
    maxWidth: 560,
    minHeight: 340,
    height: "90%",
    maxHeight: "92%",
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  previewHeader: {
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(148, 163, 184, 0.35)",
  },
  previewTitle: {
    flex: 1,
    marginRight: 10,
    fontSize: 12.5,
  },
  previewCarouselWrap: {
    flex: 1,
    minHeight: 440,
    backgroundColor: "rgba(15, 23, 42, 0.08)",
  },
  previewSlide: {
    minHeight: 440,
    alignItems: "center",
    justifyContent: "center",
  },
  previewImage: {
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(15, 23, 42, 0.06)",
  },
  carouselNavButton: {
    position: "absolute",
    top: "50%",
    marginTop: -20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(15, 23, 42, 0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  carouselNavLeft: {
    left: 10,
  },
  carouselNavRight: {
    right: 10,
  },
  previewWebWrap: {
    flex: 1,
    minHeight: 320,
  },
  previewWebView: {
    flex: 1,
    backgroundColor: "transparent",
  },
});
