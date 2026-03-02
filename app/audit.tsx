import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Colors from "@/constants/colors";
import { getAuditLogs } from "@/lib/storage";
import type { AuditLog } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { useAuth } from "@/contexts/AuthContext";

const moduleIcons: Record<string, { icon: string; color: string }> = {
  Auth: { icon: "lock-closed-outline", color: "#6366F1" },
  Attendance: { icon: "time-outline", color: "#22C55E" },
  Expenses: { icon: "receipt-outline", color: "#F59E0B" },
  Tasks: { icon: "clipboard-outline", color: "#3B82F6" },
  Salary: { icon: "wallet-outline", color: "#EC4899" },
  "Sales AI": { icon: "pulse-outline", color: "#8B5CF6" },
  Settings: { icon: "settings-outline", color: "#64748B" },
  Reports: { icon: "document-text-outline", color: "#0EA5E9" },
};

function AuditLogItem({ log, colors }: { log: AuditLog; colors: typeof Colors.light }) {
  const mod = moduleIcons[log.module] || { icon: "information-circle-outline", color: colors.textSecondary };
  const time = new Date(log.timestamp);

  return (
    <View style={[styles.logItem, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={[styles.logIcon, { backgroundColor: mod.color + "15" }]}>
        <Ionicons name={mod.icon as any} size={18} color={mod.color} />
      </View>
      <View style={styles.logContent}>
        <View style={styles.logHeaderRow}>
          <Text style={[styles.logAction, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            {log.action}
          </Text>
          <View style={[styles.moduleChip, { backgroundColor: mod.color + "10" }]}>
            <Text style={[styles.moduleText, { color: mod.color, fontFamily: "Inter_500Medium" }]}>
              {log.module}
            </Text>
          </View>
        </View>
        <Text style={[styles.logDetails, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]} numberOfLines={2}>
          {log.details}
        </Text>
        <View style={styles.logFooter}>
          <Text style={[styles.logUser, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
            {log.userName}
          </Text>
          <Text style={[styles.logTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
            {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function AuditScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const isAdmin = user?.role === "admin";

  const loadData = useCallback(async () => {
    const data = await getAuditLogs();
    if (!user) {
      setLogs([]);
      return;
    }
    if (isAdmin) {
      setLogs(data);
      return;
    }
    setLogs(data.filter((log) => log.userId === user.id || log.userName === user.name));
  }, [isAdmin, user]);

  useEffect(() => { loadData(); }, [loadData]);

  return (
    <AppCanvas>
      <FlatList
        data={logs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerRow}>
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </Pressable>
            <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Audit Logs</Text>
            <View style={{ width: 24 }} />
          </View>
        }
        renderItem={({ item }) => <AuditLogItem log={item} colors={colors} />}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="shield-checkmark-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              No audit logs yet
            </Text>
          </View>
        }
      />
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  logItem: {
    borderRadius: 18,
    padding: 14,
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
  },
  logIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  logContent: { flex: 1, gap: 6 },
  logHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  logAction: { fontSize: 14, flex: 1 },
  moduleChip: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  moduleText: { fontSize: 10 },
  logDetails: { fontSize: 12, lineHeight: 16 },
  logFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  logUser: { fontSize: 11 },
  logTime: { fontSize: 11 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14 },
});
