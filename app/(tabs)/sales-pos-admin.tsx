import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import {
  getDolibarrOrders,
  getDolibarrUsers,
  type DolibarrOrder,
  type DolibarrUser,
} from "@/lib/attendance-api";

type SalespersonSummary = {
  id: string;
  name: string;
  count: number;
  totalValue: number;
  lastOrderAt: Date | null;
};

const RANGE_OPTIONS = [7, 30, 90];

function parseNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getOrderSalespersonId(order: DolibarrOrder): number | null {
  return (
    parseNumericId(order.fk_user_salesman) ??
    parseNumericId(order.user_author_id) ??
    parseNumericId(order.user_author) ??
    parseNumericId(order.fk_user_author) ??
    parseNumericId(order.fk_user) ??
    null
  );
}

function getOrderDate(order: DolibarrOrder): Date | null {
  return (
    parseDateValue(order.date_commande) ??
    parseDateValue(order.date) ??
    parseDateValue(order.date_creation) ??
    parseDateValue(order.tms) ??
    null
  );
}

function getOrderTotal(order: DolibarrOrder): number {
  return (
    parseNumber(order.total_ttc) ??
    parseNumber(order.total_ht) ??
    parseNumber(order.total) ??
    0
  );
}

function getUserLabel(user: DolibarrUser): string {
  const first = user.firstname?.trim() || "";
  const last = user.lastname?.trim() || "";
  const name = `${first} ${last}`.trim();
  return name || user.login?.trim() || user.email?.trim() || "Salesperson";
}

function getOrderCustomerName(order: DolibarrOrder): string {
  return (
    order.socname?.toString().trim() ||
    order.thirdparty_name?.toString().trim() ||
    "Customer"
  );
}

export default function SalesPosAdminScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user, company } = useAuth();
  const isAdmin = user?.role === "admin";
  const [orders, setOrders] = useState<DolibarrOrder[]>([]);
  const [users, setUsers] = useState<DolibarrUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [expandedSalesIds, setExpandedSalesIds] = useState<Record<string, boolean>>({});

  const loadData = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const [ordersResult, usersResult] = await Promise.all([
        getDolibarrOrders({ limit: 200, sortfield: "date_commande", sortorder: "desc" }),
        getDolibarrUsers({ limit: 200, sortfield: "lastname", sortorder: "asc" }),
      ]);
      setOrders(Array.isArray(ordersResult) ? ordersResult : []);
      setUsers(Array.isArray(usersResult) ? usersResult : []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load POS orders.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const usersById = useMemo(() => {
    const map = new Map<number, DolibarrUser>();
    for (const entry of users) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [users]);

  const filteredOrders = useMemo(() => {
    if (!rangeDays) return orders;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    return orders.filter((order) => {
      const date = getOrderDate(order);
      if (!date) return true;
      return date >= cutoff;
    });
  }, [orders, rangeDays]);

  const salespersonSummary = useMemo(() => {
    const map = new Map<string, SalespersonSummary>();
    for (const order of filteredOrders) {
      const salespersonId = getOrderSalespersonId(order);
      const key = salespersonId ? String(salespersonId) : "unassigned";
      const userName = salespersonId ? getUserLabel(usersById.get(salespersonId) || {}) : "Unassigned";
      const existing = map.get(key) || {
        id: key,
        name: userName,
        count: 0,
        totalValue: 0,
        lastOrderAt: null,
      };
      const orderTotal = getOrderTotal(order);
      const orderDate = getOrderDate(order);
      const nextLast =
        existing.lastOrderAt && orderDate
          ? orderDate > existing.lastOrderAt
            ? orderDate
            : existing.lastOrderAt
          : orderDate || existing.lastOrderAt;
      map.set(key, {
        ...existing,
        name: userName,
        count: existing.count + 1,
        totalValue: existing.totalValue + orderTotal,
        lastOrderAt: nextLast,
      });
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }, [filteredOrders, usersById]);

  const ordersBySalesperson = useMemo(() => {
    const map = new Map<string, DolibarrOrder[]>();
    for (const order of filteredOrders) {
      const salespersonId = getOrderSalespersonId(order);
      const key = salespersonId ? String(salespersonId) : "unassigned";
      const current = map.get(key) || [];
      current.push(order);
      map.set(key, current);
    }
    for (const [key, list] of map) {
      list.sort((a, b) => {
        const aDate = getOrderDate(a)?.getTime() ?? 0;
        const bDate = getOrderDate(b)?.getTime() ?? 0;
        return bDate - aDate;
      });
      map.set(key, list);
    }
    return map;
  }, [filteredOrders]);

  const totalOrders = salespersonSummary.reduce((sum, entry) => sum + entry.count, 0);
  const totalValue = salespersonSummary.reduce((sum, entry) => sum + entry.totalValue, 0);

  const formatCurrency = useCallback((value: number) => {
    return `INR ${value.toFixed(2)}`;
  }, []);

  const toggleSalespersonOrders = useCallback((id: string) => {
    setExpandedSalesIds((current) => ({
      ...current,
      [id]: !current[id],
    }));
  }, []);

  return (
    <AppCanvas>
      <FlatList
        data={salespersonSummary}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        ListHeaderComponent={
          <>
            <View style={styles.navToggleWrap}>
              <DrawerToggleButton />
            </View>
            <Animated.View entering={FadeInDown.duration(320)} style={styles.header}>
              <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                POS Sales Overview
              </Text>
              <Text style={[styles.headerSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {company?.name ? `${company.name} • ` : ""}Sales orders by salesperson
              </Text>
            </Animated.View>

            {!isAdmin ? (
              <View style={[styles.statusBanner, { backgroundColor: colors.danger + "14", borderColor: colors.danger + "45" }]}>
                <Ionicons name="lock-closed-outline" size={16} color={colors.danger} />
                <Text style={[styles.statusText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>
                  Admin access required.
                </Text>
              </View>
            ) : null}

            {isAdmin ? (
              <Animated.View entering={FadeInDown.duration(360).delay(80)} style={[styles.summaryCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
                <View style={styles.summaryRow}>
                  <View style={styles.summaryBlock}>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Orders
                    </Text>
                    <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                      {totalOrders}
                    </Text>
                  </View>
                  <View style={styles.summaryBlock}>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Total Value
                    </Text>
                    <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                      {formatCurrency(totalValue)}
                    </Text>
                  </View>
                </View>

                <View style={styles.rangeRow}>
                  {RANGE_OPTIONS.map((days) => {
                    const active = days === rangeDays;
                    return (
                      <Pressable
                        key={`range_${days}`}
                        onPress={() => setRangeDays(days)}
                        style={({ pressed }) => [
                          styles.rangeChip,
                          {
                            borderColor: active ? colors.primary : colors.border,
                            backgroundColor: active ? colors.primary + "18" : colors.surface,
                            opacity: pressed ? 0.8 : 1,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.rangeChipText,
                            {
                              color: active ? colors.primary : colors.textSecondary,
                              fontFamily: "Inter_600SemiBold",
                            },
                          ]}
                        >
                          {days} days
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    onPress={() => void loadData()}
                    style={({ pressed }) => [
                      styles.refreshChip,
                      { borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
                    ]}
                  >
                    <Ionicons name="refresh" size={14} color={colors.textSecondary} />
                    <Text style={[styles.refreshText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Refresh
                    </Text>
                  </Pressable>
                </View>

                {loading ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Loading POS orders...
                    </Text>
                  </View>
                ) : null}

                {error ? (
                  <View style={[styles.statusBanner, { backgroundColor: colors.danger + "14", borderColor: colors.danger + "45" }]}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                    <Text style={[styles.statusText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>
                      {error}
                    </Text>
                  </View>
                ) : null}
              </Animated.View>
            ) : null}
          </>
        }
        renderItem={({ item, index }) => (
          <Animated.View
            entering={FadeInDown.duration(300).delay(80 + index * 20)}
            style={[styles.salespersonCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
          >
            <View style={styles.salespersonHeader}>
              <View>
                <Text style={[styles.salespersonName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {item.name}
                </Text>
                <Text style={[styles.salespersonMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {item.id === "unassigned" ? "No salesperson assigned" : `ID ${item.id}`}
                </Text>
              </View>
              <View style={[styles.countBadge, { borderColor: colors.primary + "55", backgroundColor: colors.primary + "12" }]}>
                <Text style={[styles.countBadgeText, { color: colors.primary, fontFamily: "Inter_700Bold" }]}>
                  {item.count}
                </Text>
              </View>
            </View>

            <View style={styles.salespersonFooter}>
              <View>
                <Text style={[styles.salespersonLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  Total Value
                </Text>
                <Text style={[styles.salespersonValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {formatCurrency(item.totalValue)}
                </Text>
              </View>
              <View>
                <Text style={[styles.salespersonLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  Last Order
                </Text>
                <Text style={[styles.salespersonValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {item.lastOrderAt ? item.lastOrderAt.toLocaleDateString() : "—"}
                </Text>
              </View>
            </View>

            <Pressable
              onPress={() => toggleSalespersonOrders(item.id)}
              style={({ pressed }) => [
                styles.expandButton,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Ionicons
                name={expandedSalesIds[item.id] ? "chevron-up" : "chevron-down"}
                size={16}
                color={colors.textSecondary}
              />
              <Text style={[styles.expandText, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                {expandedSalesIds[item.id] ? "Hide orders" : "View orders"}
              </Text>
            </Pressable>

            {expandedSalesIds[item.id] ? (
              <View
                style={[
                  styles.orderList,
                  { borderColor: colors.borderLight, backgroundColor: colors.surface },
                ]}
              >
                <View style={styles.orderListHeader}>
                  <Text style={[styles.orderHeaderText, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                    Recent Orders
                  </Text>
                  <Text style={[styles.orderHeaderText, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                    {ordersBySalesperson.get(item.id)?.length ?? 0}
                  </Text>
                </View>
                <ScrollView
                  style={styles.orderScroll}
                  contentContainerStyle={styles.orderScrollContent}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                >
                  {ordersBySalesperson.get(item.id)?.length ? (
                    ordersBySalesperson.get(item.id)!.map((order) => {
                      const orderDate = getOrderDate(order);
                      const total = getOrderTotal(order);
                      const ref = order.ref || order.id || "Order";
                      return (
                        <View key={`order_${item.id}_${ref}`} style={styles.orderRow}>
                          <View style={styles.orderRowLeft}>
                            <Text style={[styles.orderTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                              {ref}
                            </Text>
                            <Text style={[styles.orderSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                              {getOrderCustomerName(order)}
                            </Text>
                          </View>
                          <View style={styles.orderRowRight}>
                            <Text style={[styles.orderMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                              {orderDate ? orderDate.toLocaleDateString() : "???"}
                            </Text>
                            <Text style={[styles.orderValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                              {formatCurrency(total)}
                            </Text>
                          </View>
                        </View>
                      );
                    })
                  ) : (
                    <Text style={[styles.orderEmptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      No orders available.
                    </Text>
                  )}
                </ScrollView>
              </View>
            ) : null}

          </Animated.View>
        )}
        ListEmptyComponent={
          !loading && isAdmin ? (
            <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <Ionicons name="receipt-outline" size={36} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                No POS orders found for the selected period.
              </Text>
            </View>
          ) : null
        }
      />
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40 },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  header: { marginBottom: 16 },
  headerTitle: { fontSize: 24, letterSpacing: -0.4 },
  headerSubtitle: { fontSize: 13, marginTop: 4 },
  summaryCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 12,
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
  },
  summaryBlock: {
    flex: 1,
    gap: 4,
  },
  summaryLabel: { fontSize: 12 },
  summaryValue: { fontSize: 18 },
  rangeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  rangeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  rangeChipText: { fontSize: 11 },
  refreshChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  refreshText: { fontSize: 11 },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: { fontSize: 12 },
  statusBanner: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusText: { fontSize: 12, flex: 1 },
  salespersonCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    gap: 10,
  },
  salespersonHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  salespersonName: { fontSize: 15 },
  salespersonMeta: { fontSize: 11, marginTop: 2 },
  countBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 44,
    alignItems: "center",
  },
  countBadgeText: { fontSize: 14 },
  salespersonFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  salespersonLabel: { fontSize: 11 },
  salespersonValue: { fontSize: 12 },
  expandButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  expandText: { fontSize: 12 },
  orderList: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 10,
  },
  orderListHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  orderHeaderText: { fontSize: 11 },
  orderScroll: {
    maxHeight: 240,
  },
  orderScrollContent: {
    gap: 8,
    paddingRight: 4,
  },
  orderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    paddingVertical: 6,
  },
  orderRowLeft: { flex: 1, gap: 2 },
  orderRowRight: { alignItems: "flex-end", gap: 2 },
  orderTitle: { fontSize: 12 },
  orderSubtitle: { fontSize: 11 },
  orderMeta: { fontSize: 10 },
  orderValue: { fontSize: 12 },
  orderEmptyText: { fontSize: 12 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    marginTop: 20,
    borderWidth: 1,
  },
  emptyText: { fontSize: 13, textAlign: "center" },
});
