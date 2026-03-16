import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown } from "react-native-reanimated";
import * as Print from "expo-print";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { canAccessAdminControls } from "@/lib/role-access";
import {
  getDolibarrOrderDetail,
  getDolibarrOrders,
  getDolibarrProducts,
  getDolibarrThirdParties,
  getDolibarrUsers,
  type DolibarrOrder,
  type DolibarrOrderLine,
  type DolibarrProduct,
  type DolibarrThirdParty,
  type DolibarrUser,
} from "@/lib/attendance-api";

const RANGE_OPTIONS = [
  { key: "daily", label: "Daily", days: 1 },
  { key: "weekly", label: "Weekly", days: 7 },
  { key: "monthly", label: "Monthly", days: 30 },
] as const;

const REPORT_OPTIONS = [
  { key: "salesperson", label: "Salesperson", icon: "people-outline" },
  { key: "area", label: "Area", icon: "map-outline" },
  { key: "client", label: "Client", icon: "briefcase-outline" },
  { key: "dealer", label: "Dealer", icon: "storefront-outline" },
  { key: "item", label: "Item", icon: "cube-outline" },
] as const;

const ITEMWISE_PAGE_SIZE = 80;
const ITEMWISE_BATCH = 6;

type RangeKey = (typeof RANGE_OPTIONS)[number]["key"];
type ReportKey = (typeof REPORT_OPTIONS)[number]["key"];

type ReportRow = {
  id: string;
  title: string;
  subtitle: string;
  metricLabel: string;
  metricValue: string;
  totalValue: number;
  lastOrderAt?: Date | null;
};

function escapeCsv(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(raw)) {
    return `"${raw.replace(/"/g, "\"\"")}"`;
  }
  return raw;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

function getOrderCustomerId(order: DolibarrOrder): number | null {
  return parseNumericId(order.socid) ?? null;
}

function getOrderCustomerName(order: DolibarrOrder): string {
  return (
    order.socname?.toString().trim() ||
    order.thirdparty_name?.toString().trim() ||
    "Customer"
  );
}

function getThirdPartyPincode(party?: DolibarrThirdParty): string {
  if (!party) return "";
  const raw =
    (party.zip as unknown) ??
    (party as Record<string, unknown>).pincode ??
    (party as Record<string, unknown>).zipcode ??
    (party as Record<string, unknown>).zip_code ??
    "";
  return raw ? String(raw).trim().replace(/\s+/g, "") : "";
}

function getUserLabel(user: DolibarrUser): string {
  const first = user.firstname?.trim() || "";
  const last = user.lastname?.trim() || "";
  const name = `${first} ${last}`.trim();
  return name || user.login?.trim() || user.email?.trim() || "Salesperson";
}

function getThirdPartyLabel(party: DolibarrThirdParty | undefined, fallback: string): string {
  if (!party) return fallback || "Customer";
  return party.name?.trim() || party.nom?.trim() || fallback || "Customer";
}

function isThirdPartyClient(party: DolibarrThirdParty | undefined): boolean {
  if (!party) return true;
  const value = parseNumericId(party.client);
  if (value === null) return true;
  return value > 0;
}

function isThirdPartyDealer(party: DolibarrThirdParty | undefined): boolean {
  if (!party) return false;
  const value = parseNumericId(party.client);
  if (value === null) return false;
  return value === 0;
}

function getLineLabel(line: DolibarrOrderLine, productsById: Map<number, DolibarrProduct>): string {
  const productId = parseNumericId(line.fk_product);
  if (productId) {
    const product = productsById.get(productId);
    if (product?.label?.trim()) return product.label.trim();
    if (product?.ref?.trim()) return product.ref.trim();
  }
  return (
    line.product_label?.trim() ||
    line.label?.trim() ||
    line.desc?.trim() ||
    "Item"
  );
}

function getLineTotal(line: DolibarrOrderLine, qty: number): number {
  return (
    parseNumber(line.total_ttc) ??
    parseNumber(line.total_ht) ??
    (parseNumber(line.subprice) ?? 0) * qty
  );
}

export default function AdminReportsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user, company } = useAuth();
  const canAccess = canAccessAdminControls(user?.role);
  const [orders, setOrders] = useState<DolibarrOrder[]>([]);
  const [users, setUsers] = useState<DolibarrUser[]>([]);
  const [thirdParties, setThirdParties] = useState<DolibarrThirdParty[]>([]);
  const [products, setProducts] = useState<DolibarrProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeKey, setRangeKey] = useState<RangeKey>("monthly");
  const [reportKey, setReportKey] = useState<ReportKey>("salesperson");
  const [itemLinesByOrderId, setItemLinesByOrderId] = useState<Record<string, DolibarrOrderLine[]>>({});
  const [itemLinesLoading, setItemLinesLoading] = useState(false);
  const [itemLinesError, setItemLinesError] = useState<string | null>(null);
  const [itemOrderLimit, setItemOrderLimit] = useState(ITEMWISE_PAGE_SIZE);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

  const loadData = useCallback(async () => {
    if (!canAccess) return;
    setLoading(true);
    setError(null);
    try {
      const [ordersResult, usersResult, thirdPartyResult, productResult] = await Promise.all([
        getDolibarrOrders({ limit: 400, sortfield: "date_commande", sortorder: "desc" }),
        getDolibarrUsers({ limit: 300, sortfield: "lastname", sortorder: "asc" }),
        getDolibarrThirdParties({ limit: 400, sortfield: "nom", sortorder: "asc" }),
        getDolibarrProducts({ limit: 400, sortfield: "label", sortorder: "asc" }),
      ]);
      setOrders(Array.isArray(ordersResult) ? ordersResult : []);
      setUsers(Array.isArray(usersResult) ? usersResult : []);
      setThirdParties(Array.isArray(thirdPartyResult) ? thirdPartyResult : []);
      setProducts(Array.isArray(productResult) ? productResult : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load sales reports.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (reportKey !== "item") return;
    setItemOrderLimit(ITEMWISE_PAGE_SIZE);
    setItemLinesLoading(false);
    setItemLinesError(null);
  }, [reportKey, rangeKey]);

  const rangeStart = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (rangeKey === "daily") return start;
    if (rangeKey === "weekly") {
      start.setDate(start.getDate() - 6);
      return start;
    }
    start.setDate(start.getDate() - 29);
    return start;
  }, [rangeKey]);

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const date = getOrderDate(order);
      if (!date) return true;
      return date >= rangeStart;
    });
  }, [orders, rangeStart]);

  const usersById = useMemo(() => {
    const map = new Map<number, DolibarrUser>();
    for (const entry of users) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [users]);

  const thirdPartiesById = useMemo(() => {
    const map = new Map<number, DolibarrThirdParty>();
    for (const entry of thirdParties) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [thirdParties]);

  const productsById = useMemo(() => {
    const map = new Map<number, DolibarrProduct>();
    for (const entry of products) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [products]);

  const filteredOrderIds = useMemo(
    () =>
      filteredOrders
        .map((order) => parseNumericId(order.id))
        .filter((id): id is number => Boolean(id)),
    [filteredOrders]
  );

  const limitedOrderIds = useMemo(
    () => filteredOrderIds.slice(0, itemOrderLimit),
    [filteredOrderIds, itemOrderLimit]
  );

  useEffect(() => {
    if (!canAccess || reportKey !== "item" || limitedOrderIds.length === 0) return;
    let active = true;
    const missing = limitedOrderIds.filter((id) => !itemLinesByOrderId[String(id)]);
    if (!missing.length) {
      if (itemLinesLoading) {
        setItemLinesLoading(false);
      }
      return;
    }
    if (itemLinesLoading) return;
    setItemLinesLoading(true);
    setItemLinesError(null);

    const loadLines = async () => {
      for (let i = 0; i < missing.length; i += ITEMWISE_BATCH) {
        const chunk = missing.slice(i, i + ITEMWISE_BATCH);
        const results = await Promise.all(
          chunk.map(async (orderId) => {
            try {
              const detail = await getDolibarrOrderDetail(orderId);
              return { id: String(orderId), lines: detail.lines || [] };
            } catch (err) {
              const message = err instanceof Error ? err.message : "Unable to load order details.";
              return { id: String(orderId), lines: [], error: message };
            }
          })
        );
        if (!active) return;
        const batch: Record<string, DolibarrOrderLine[]> = {};
        for (const result of results) {
          batch[result.id] = Array.isArray(result.lines) ? result.lines : [];
          if ("error" in result && result.error) {
            setItemLinesError(result.error);
          }
        }
        setItemLinesByOrderId((current) => ({ ...current, ...batch }));
      }
      if (!active) return;
      setItemLinesLoading(false);
    };

    void loadLines().catch((err) => {
      if (!active) return;
      const message = err instanceof Error ? err.message : "Unable to load item lines.";
      setItemLinesError(message);
      setItemLinesLoading(false);
    });

    return () => {
      active = false;
    };
  }, [canAccess, itemLinesByOrderId, itemLinesLoading, limitedOrderIds, reportKey]);

  const reportRows: ReportRow[] = useMemo(() => {
    if (reportKey === "salesperson") {
      const map = new Map<string, ReportRow>();
      for (const order of filteredOrders) {
        const salespersonId = getOrderSalespersonId(order);
        const key = salespersonId ? String(salespersonId) : "unassigned";
        const userName = salespersonId
          ? getUserLabel(usersById.get(salespersonId) || {})
          : "Unassigned";
        const existing = map.get(key) || {
          id: key,
          title: userName,
          subtitle: key === "unassigned" ? "No salesperson assigned" : `ID ${key}`,
          metricLabel: "Orders",
          metricValue: "0",
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
        const count = Number(existing.metricValue) + 1;
        map.set(key, {
          ...existing,
          title: userName,
          metricValue: String(count),
          totalValue: existing.totalValue + orderTotal,
          lastOrderAt: nextLast,
        });
      }
      return Array.from(map.values()).sort((a, b) => b.totalValue - a.totalValue);
    }

    if (reportKey === "area") {
      const map = new Map<string, ReportRow>();
      for (const order of filteredOrders) {
        const customerId = getOrderCustomerId(order);
        const party = customerId ? thirdPartiesById.get(customerId) : undefined;
        const pincode = getThirdPartyPincode(party);
        const key = pincode || "unknown";
        const title = pincode ? `Pincode ${pincode}` : "Pincode Unspecified";
        const existing = map.get(key) || {
          id: key,
          title,
          subtitle: pincode ? "Customer area" : "No pincode on customer",
          metricLabel: "Orders",
          metricValue: "0",
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
        const count = Number(existing.metricValue) + 1;
        map.set(key, {
          ...existing,
          title,
          metricValue: String(count),
          totalValue: existing.totalValue + orderTotal,
          lastOrderAt: nextLast,
        });
      }
      return Array.from(map.values()).sort((a, b) => b.totalValue - a.totalValue);
    }

    if (reportKey === "client" || reportKey === "dealer") {
      const map = new Map<string, ReportRow>();
      for (const order of filteredOrders) {
        const customerId = getOrderCustomerId(order);
        const party = customerId ? thirdPartiesById.get(customerId) : undefined;
        if (reportKey === "dealer" && !isThirdPartyDealer(party)) {
          continue;
        }
        if (reportKey === "client" && !isThirdPartyClient(party)) {
          continue;
        }
        const label = getThirdPartyLabel(party, getOrderCustomerName(order));
        const key = customerId ? String(customerId) : label.toLowerCase();
        const pincode = getThirdPartyPincode(party);
        const subtitleBase = customerId ? `ID ${customerId}` : "Customer";
        const subtitle = pincode ? `${subtitleBase} • PIN ${pincode}` : subtitleBase;
        const existing = map.get(key) || {
          id: key,
          title: label,
          subtitle,
          metricLabel: "Orders",
          metricValue: "0",
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
        const count = Number(existing.metricValue) + 1;
        map.set(key, {
          ...existing,
          metricValue: String(count),
          totalValue: existing.totalValue + orderTotal,
          lastOrderAt: nextLast,
        });
      }
      return Array.from(map.values()).sort((a, b) => b.totalValue - a.totalValue);
    }

    const map = new Map<string, { row: ReportRow; totalQty: number; orderIds: Set<string> }>();
    for (const orderId of limitedOrderIds) {
      const lines = itemLinesByOrderId[String(orderId)] || [];
      for (const line of lines) {
        const qty = parseNumber(line.qty) ?? 0;
        if (!qty) continue;
        const label = getLineLabel(line, productsById);
        const productId = parseNumericId(line.fk_product);
        const key = productId ? `product_${productId}` : `label_${label.toLowerCase()}`;
        const existing = map.get(key) || {
          row: {
            id: key,
            title: label,
            subtitle: productId ? `ID ${productId}` : "Item",
            metricLabel: "Qty",
            metricValue: "0",
            totalValue: 0,
          },
          totalQty: 0,
          orderIds: new Set<string>(),
        };
        const lineTotal = getLineTotal(line, qty);
        existing.totalQty += qty;
        existing.row.totalValue += lineTotal;
        existing.orderIds.add(String(orderId));
        existing.row.metricValue = existing.totalQty.toFixed(0);
        map.set(key, existing);
      }
    }
    return Array.from(map.values())
      .map((entry) => ({
        ...entry.row,
        subtitle: entry.row.subtitle,
        metricLabel: "Qty",
        metricValue: entry.totalQty.toFixed(0),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [filteredOrders, itemLinesByOrderId, limitedOrderIds, productsById, reportKey, thirdPartiesById, usersById]);

  const totalOrders = useMemo(() => filteredOrders.length, [filteredOrders]);

  const totalValue = useMemo(
    () => filteredOrders.reduce((sum, order) => sum + getOrderTotal(order), 0),
    [filteredOrders]
  );

  const reportLabel = useMemo(
    () => REPORT_OPTIONS.find((option) => option.key === reportKey)?.label || "Report",
    [reportKey]
  );

  const formatCurrency = useCallback((value: number) => `INR ${value.toFixed(2)}`, []);

  const averageOrderValue = totalOrders ? totalValue / totalOrders : 0;

  const rangeLabel = useMemo(() => {
    const end = new Date();
    const start = rangeStart;
    return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
  }, [rangeStart]);

  const loadedItemOrders = limitedOrderIds.filter((id) => itemLinesByOrderId[String(id)]).length;

  const handleExportCsv = useCallback(async () => {
    if (exportingCsv) return;
    if (!reportRows.length) {
      Alert.alert("No Data", "There is no report data to export.");
      return;
    }
    setExportingCsv(true);
    try {
      const lines: string[] = [];
      lines.push(`Report,${escapeCsv(reportLabel)}`);
      lines.push(`Company,${escapeCsv(company?.name || "Company")}`);
      lines.push(`Range,${escapeCsv(rangeLabel)}`);
      lines.push(`Orders,${escapeCsv(totalOrders)}`);
      lines.push(`Total Value,${escapeCsv(formatCurrency(totalValue))}`);
      lines.push(`Average Order,${escapeCsv(formatCurrency(averageOrderValue))}`);
      lines.push("");
      lines.push(
        [
          "Title",
          "Subtitle",
          "Metric Label",
          "Metric Value",
          "Total Value",
          "Last Order",
        ]
          .map(escapeCsv)
          .join(",")
      );
      for (const row of reportRows) {
        lines.push(
          [
            row.title,
            row.subtitle,
            row.metricLabel,
            row.metricValue,
            formatCurrency(row.totalValue),
            row.lastOrderAt ? row.lastOrderAt.toLocaleDateString() : "",
          ]
            .map(escapeCsv)
            .join(",")
        );
      }

      await Share.share({
        title: `${reportLabel} Export`,
        message: lines.join("\n"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to export CSV.";
      Alert.alert("Export Failed", message);
    } finally {
      setExportingCsv(false);
    }
  }, [
    averageOrderValue,
    company?.name,
    exportingCsv,
    formatCurrency,
    rangeLabel,
    reportLabel,
    reportRows,
    totalOrders,
    totalValue,
  ]);

  const handleExportPdf = useCallback(async () => {
    if (exportingPdf) return;
    if (!reportRows.length) {
      Alert.alert("No Data", "There is no report data to export.");
      return;
    }
    setExportingPdf(true);
    try {
      const headerCells =
        "<tr><th>Title</th><th>Subtitle</th><th>Metric</th><th>Total Value</th><th>Last Order</th></tr>";
      const rows = reportRows
        .map((row) => {
          const metric = `${row.metricValue} ${row.metricLabel}`;
          const lastOrder = row.lastOrderAt ? row.lastOrderAt.toLocaleDateString() : "-";
          return `<tr><td>${escapeHtml(row.title)}</td><td>${escapeHtml(row.subtitle)}</td><td>${escapeHtml(metric)}</td><td>${escapeHtml(formatCurrency(row.totalValue))}</td><td>${escapeHtml(lastOrder)}</td></tr>`;
        })
        .join("");

      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(reportLabel)} Export</title>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; color: #0f172a; }
      h1 { font-size: 22px; margin: 0 0 6px; }
      .meta { color: #64748b; font-size: 12px; margin-bottom: 16px; }
      .summary { display:flex; gap:16px; margin: 14px 0 18px; }
      .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 12px; min-width: 140px; }
      .label { font-size: 11px; color: #64748b; }
      .value { font-size: 16px; font-weight: 700; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; }
      th { background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #475569; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(reportLabel)} Report</h1>
    <div class="meta">${escapeHtml(company?.name || "Company")} • ${escapeHtml(rangeLabel)}</div>
    <div class="summary">
      <div class="card"><div class="label">Orders</div><div class="value">${escapeHtml(String(totalOrders))}</div></div>
      <div class="card"><div class="label">Total Value</div><div class="value">${escapeHtml(formatCurrency(totalValue))}</div></div>
      <div class="card"><div class="label">Avg. Order</div><div class="value">${escapeHtml(formatCurrency(averageOrderValue))}</div></div>
    </div>
    <table>
      ${headerCells}
      ${rows}
    </table>
  </body>
</html>`;

      await Print.printAsync({ html });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to export PDF.";
      Alert.alert("Export Failed", message);
    } finally {
      setExportingPdf(false);
    }
  }, [
    averageOrderValue,
    company?.name,
    exportingPdf,
    formatCurrency,
    rangeLabel,
    reportLabel,
    reportRows,
    totalOrders,
    totalValue,
  ]);

  if (!canAccess) {
    return (
      <AppCanvas>
        <View style={[styles.lockedWrap, { paddingTop: insets.top + 16 }]}> 
          <View style={styles.navToggleWrap}>
            <DrawerToggleButton />
          </View>
          <View
            style={[
              styles.lockedCard,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
            ]}
          >
            <Ionicons name="lock-closed-outline" size={42} color={colors.warning} />
            <Text style={[styles.lockedTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
              Admin Access Required
            </Text>
            <Text style={[styles.lockedText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
              Only admins can access sales reports. Contact your administrator for access.
            </Text>
          </View>
        </View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInDown.duration(280)} style={styles.headerWrap}>
          <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
            Admin Sales Reports
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            {company?.name ? `${company.name} • ` : ""}{rangeLabel}
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(320).delay(40)}
          style={[styles.summaryCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
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
            <View style={styles.summaryBlock}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Avg. Order
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
                {formatCurrency(averageOrderValue)}
              </Text>
            </View>
          </View>

          <View style={styles.chipRow}>
            {RANGE_OPTIONS.map((option) => {
              const active = option.key === rangeKey;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => setRangeKey(option.key)}
                  style={({ pressed }) => [
                    styles.rangeChip,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.primary + "18" : colors.surface,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}> 
                    {option.label}
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
              <Text style={[styles.refreshText, { color: colors.textSecondary }]}>Refresh</Text>
            </Pressable>
          </View>

          <View style={styles.chipRow}>
            <Pressable
              onPress={() => void handleExportCsv()}
              disabled={exportingCsv}
              style={({ pressed }) => [
                styles.exportChip,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: pressed || exportingCsv ? 0.75 : 1,
                },
              ]}
            >
              <Ionicons name="download-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.exportText, { color: colors.textSecondary }]}>
                {exportingCsv ? "Exporting CSV..." : "Export CSV"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => void handleExportPdf()}
              disabled={exportingPdf}
              style={({ pressed }) => [
                styles.exportChip,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: pressed || exportingPdf ? 0.75 : 1,
                },
              ]}
            >
              <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.exportText, { color: colors.textSecondary }]}>
                {exportingPdf ? "Exporting PDF..." : "Export PDF"}
              </Text>
            </Pressable>
          </View>

          <View style={styles.chipRow}>
            {REPORT_OPTIONS.map((option) => {
              const active = option.key === reportKey;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => setReportKey(option.key)}
                  style={({ pressed }) => [
                    styles.reportChip,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.primary + "14" : colors.surface,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <Ionicons name={option.icon} size={14} color={active ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}> 
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Loading sales data...
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

          {reportKey === "dealer" ? (
            <Text style={[styles.helperText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}> 
              Dealer grouping uses Dolibarr client flag (client=0). Update customer type in Dolibarr if needed.
            </Text>
          ) : null}

          {reportKey === "item" ? (
            <View style={styles.itemInfoRow}>
              <Text style={[styles.helperText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}> 
                Itemwise totals use order line items for {loadedItemOrders}/{limitedOrderIds.length} orders.
              </Text>
              {limitedOrderIds.length < filteredOrderIds.length ? (
                <Pressable
                  onPress={() =>
                    setItemOrderLimit((current) =>
                      Math.min(current + ITEMWISE_PAGE_SIZE, filteredOrderIds.length)
                    )
                  }
                  style={({ pressed }) => [
                    styles.loadMoreChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <Ionicons name="add" size={14} color={colors.textSecondary} />
                  <Text style={[styles.loadMoreText, { color: colors.textSecondary }]}>Load more</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {reportKey === "item" && itemLinesLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Loading item lines...
              </Text>
            </View>
          ) : null}

          {reportKey === "item" && itemLinesError ? (
            <View style={[styles.statusBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "40" }]}> 
              <Ionicons name="warning-outline" size={16} color={colors.warning} />
              <Text style={[styles.statusText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}> 
                {itemLinesError}
              </Text>
            </View>
          ) : null}
        </Animated.View>

        <View style={styles.listWrap}>
          {reportRows.length === 0 ? (
            <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}> 
              <Ionicons name="analytics-outline" size={36} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
                No report data found for the selected range.
              </Text>
            </View>
          ) : (
            reportRows.map((row, index) => (
              <Animated.View
                key={row.id}
                entering={FadeInDown.duration(260).delay(80 + index * 14)}
                style={[
                  styles.reportCard,
                  { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                ]}
              >
                <View style={styles.reportHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.reportTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
                      {row.title}
                    </Text>
                    <Text style={[styles.reportSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
                      {row.subtitle}
                    </Text>
                  </View>
                  <View style={[styles.countBadge, { borderColor: colors.primary + "55", backgroundColor: colors.primary + "12" }]}> 
                    <Text style={[styles.countBadgeText, { color: colors.primary, fontFamily: "Inter_700Bold" }]}> 
                      {row.metricValue}
                    </Text>
                    <Text style={[styles.countBadgeLabel, { color: colors.primary, fontFamily: "Inter_500Medium" }]}> 
                      {row.metricLabel}
                    </Text>
                  </View>
                </View>

                <View style={styles.reportFooter}>
                  <View>
                    <Text style={[styles.reportMetaLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                      Total Value
                    </Text>
                    <Text style={[styles.reportMetaValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
                      {formatCurrency(row.totalValue)}
                    </Text>
                  </View>
                  {row.lastOrderAt ? (
                    <View>
                      <Text style={[styles.reportMetaLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                        Last Order
                      </Text>
                      <Text style={[styles.reportMetaValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
                        {row.lastOrderAt.toLocaleDateString()}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </Animated.View>
            ))
          )}
        </View>
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
    gap: 12,
  },
  summaryBlock: {
    flex: 1,
    gap: 4,
  },
  summaryLabel: { fontSize: 12 },
  summaryValue: { fontSize: 17 },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  rangeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  reportChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  chipText: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
  refreshChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  refreshText: { fontSize: 11, fontFamily: "Inter_500Medium" },
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
  helperText: { fontSize: 11 },
  itemInfoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  loadMoreChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  loadMoreText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  exportChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  exportText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  listWrap: {
    gap: 12,
  },
  reportCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  reportHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  reportTitle: { fontSize: 14 },
  reportSubtitle: { fontSize: 11, marginTop: 2 },
  countBadge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 62,
    alignItems: "center",
  },
  countBadgeText: { fontSize: 14 },
  countBadgeLabel: { fontSize: 9.5 },
  reportFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  reportMetaLabel: { fontSize: 11 },
  reportMetaValue: { fontSize: 12 },
  emptyState: {
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 13, textAlign: "center" },
  lockedWrap: {
    flex: 1,
    paddingHorizontal: 20,
  },
  lockedCard: {
    marginTop: 16,
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    alignItems: "center",
    gap: 8,
  },
  lockedTitle: {
    fontSize: 18,
  },
  lockedText: {
    textAlign: "center",
    fontSize: 13,
    lineHeight: 19,
  },
});
