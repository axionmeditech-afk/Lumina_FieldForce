import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
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
import type { AppNotification, NotificationAudience } from "@/lib/types";
import {
  addAuditLog,
  addNotification,
  getNotificationsForCurrentUser,
  getUnreadNotificationsCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/storage";
import { canBroadcastAnnouncements } from "@/lib/role-access";

function notificationKindColor(kind: AppNotification["kind"]): string {
  if (kind === "alert") return "#EF4444";
  if (kind === "policy") return "#0284C7";
  if (kind === "support") return "#14B8A6";
  return "#4F46E5";
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [composeTitle, setComposeTitle] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeAudience, setComposeAudience] = useState<NotificationAudience>("all");
  const [sending, setSending] = useState(false);
  const canBroadcast = canBroadcastAnnouncements(user?.role);

  const loadData = useCallback(async () => {
    const [items, unread] = await Promise.all([
      getNotificationsForCurrentUser(),
      getUnreadNotificationsCount(),
    ]);
    setNotifications(items);
    setUnreadCount(unread);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        await loadData();
        await markAllNotificationsRead();
        if (active) {
          await loadData();
        }
      })();
      return () => {
        active = false;
      };
    }, [loadData])
  );

  const handleMarkAllRead = useCallback(async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      await markAllNotificationsRead();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await loadData();
    } finally {
      setMarkingAll(false);
    }
  }, [loadData, markingAll]);

  const handleOpenNotification = useCallback(
    async (item: AppNotification) => {
      await markNotificationRead(item.id);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await loadData();
    },
    [loadData]
  );

  const handleSendBroadcast = useCallback(async () => {
    if (!user || sending || !composeTitle.trim() || !composeBody.trim()) return;
    setSending(true);
    try {
      const now = new Date().toISOString();
      await addNotification({
        id: `notif_broadcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: composeTitle.trim(),
        body: composeBody.trim(),
        kind: "announcement",
        audience: composeAudience,
        createdById: user.id,
        createdByName: user.name,
        createdAt: now,
      });
      await addAuditLog({
        id: `audit_broadcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId: user.id,
        userName: user.name,
        action: "Notification Broadcast",
        details: `Audience=${composeAudience}, title=${composeTitle.trim()}`,
        timestamp: now,
        module: "Notifications",
      });
      setComposeTitle("");
      setComposeBody("");
      setComposeAudience("all");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadData();
    } finally {
      setSending(false);
    }
  }, [composeAudience, composeBody, composeTitle, loadData, sending, user]);

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInDown.duration(400)} style={styles.headerRow}>
          <View>
            <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Notifications
            </Text>
            <Text
              style={[
                styles.subtitle,
                { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
              ]}
            >
              Company announcements and important updates.
            </Text>
          </View>
          <View style={[styles.countChip, { backgroundColor: colors.primary + "15" }]}>
            <Text style={[styles.countText, { color: colors.primary, fontFamily: "Inter_700Bold" }]}>
              {unreadCount}
            </Text>
          </View>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(100)}>
          <Pressable
            style={({ pressed }) => [
              styles.markAllButton,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.border,
                opacity: pressed || markingAll ? 0.8 : 1,
              },
            ]}
            disabled={markingAll || unreadCount === 0}
            onPress={handleMarkAllRead}
          >
            {markingAll ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <Ionicons name="checkmark-done-outline" size={16} color={colors.primary} />
                <Text
                  style={[
                    styles.markAllText,
                    { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                  ]}
                >
                  Mark All As Read
                </Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        {canBroadcast ? (
          <Animated.View
            entering={FadeInDown.duration(400).delay(130)}
            style={[
              styles.composeCard,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.composeTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Send Announcement
            </Text>
            <TextInput
              value={composeTitle}
              onChangeText={setComposeTitle}
              placeholder="Title"
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />
            <TextInput
              multiline
              value={composeBody}
              onChangeText={setComposeBody}
              placeholder="Message for employees..."
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.input,
                styles.multilineInput,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />
            <View style={styles.audienceRow}>
              {(["all", "salesperson", "manager", "hr"] as const).map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setComposeAudience(value)}
                  style={[
                    styles.audienceChip,
                    {
                      borderColor: composeAudience === value ? colors.primary : colors.border,
                      backgroundColor: composeAudience === value ? colors.primary + "14" : colors.background,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: composeAudience === value ? colors.primary : colors.textSecondary,
                      fontFamily: "Inter_500Medium",
                      fontSize: 10.5,
                    }}
                  >
                    {value.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={() => void handleSendBroadcast()}
              disabled={sending || !composeTitle.trim() || !composeBody.trim()}
              style={[
                styles.broadcastButton,
                {
                  backgroundColor: colors.primary,
                  opacity: sending || !composeTitle.trim() || !composeBody.trim() ? 0.6 : 1,
                },
              ]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="megaphone-outline" size={14} color="#fff" />
                  <Text style={styles.broadcastButtonText}>Send</Text>
                </>
              )}
            </Pressable>
          </Animated.View>
        ) : null}

        <Animated.View
          entering={FadeInDown.duration(400).delay(150)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          {loading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : notifications.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="notifications-off-outline" size={22} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                No notifications right now.
              </Text>
            </View>
          ) : (
            notifications.map((item, index) => {
              const isUnread = !user?.id || !(item.readByIds || []).includes(user.id);
              const kindColor = notificationKindColor(item.kind);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => void handleOpenNotification(item)}
                  style={({ pressed }) => [
                    styles.itemRow,
                    index < notifications.length - 1 && {
                      borderBottomWidth: 1,
                      borderBottomColor: colors.borderLight,
                    },
                    { opacity: pressed ? 0.86 : 1 },
                  ]}
                >
                  <View style={[styles.itemIconWrap, { backgroundColor: kindColor + "1A" }]}>
                    <Ionicons
                      name={item.kind === "support" ? "chatbubble-ellipses-outline" : "megaphone-outline"}
                      size={16}
                      color={kindColor}
                    />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[styles.itemTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      {item.title}
                    </Text>
                    <Text
                      style={[
                        styles.itemBody,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      {item.body}
                    </Text>
                    <Text
                      style={[
                        styles.itemMeta,
                        { color: colors.textTertiary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                  </View>
                  {isUnread ? <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} /> : null}
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
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
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
  countChip: {
    minWidth: 36,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  countText: {
    fontSize: 13,
  },
  markAllButton: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  markAllText: {
    fontSize: 13,
  },
  composeCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  composeTitle: {
    fontSize: 14,
    marginBottom: 8,
  },
  input: {
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    marginBottom: 8,
    fontFamily: "Inter_400Regular",
  },
  multilineInput: {
    minHeight: 76,
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
    minHeight: 30,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  broadcastButton: {
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
  },
  broadcastButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
  },
  emptyWrap: {
    minHeight: 120,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  emptyText: {
    fontSize: 13,
    textAlign: "center",
  },
  itemRow: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  itemIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  itemTitle: {
    fontSize: 14,
  },
  itemBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  itemMeta: {
    marginTop: 2,
    fontSize: 10.5,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    marginTop: 6,
  },
});
