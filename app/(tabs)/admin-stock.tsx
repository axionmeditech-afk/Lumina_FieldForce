import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useFocusEffect } from "expo-router";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { canAccessAdminControls } from "@/lib/role-access";
import {
  addAuditLog,
  addStockist,
  addStockTransfer,
  getAllEmployees,
  getStockists,
  getStockTransfers,
} from "@/lib/storage";
import { getEmployees as getMergedEmployees } from "@/lib/employee-data";
import type { Employee, StockistProfile, StockTransfer } from "@/lib/types";
import {
  adjustCompanyProductStock,
  getCompanyProductStocks,
  getDolibarrOrderDetail,
  getDolibarrOrders,
  getDolibarrProducts,
  type DolibarrOrder,
  type DolibarrOrderLine,
  type DolibarrProduct,
} from "@/lib/attendance-api";

const TRANSFER_TYPES = [
  { key: "in", label: "Sent to Channel Partner" },
  { key: "out", label: "Sent to Salesperson" },
] as const;

type TransferType = (typeof TRANSFER_TYPES)[number]["key"];

const ITEMWISE_BATCH = 12;
const DIRECT_AREA_KEY = "__direct__";
const PRODUCT_DROPDOWN_PAGE = 20;
const PREFETCH_PRODUCT_STOCK_COUNT = 60;
const STOCK_DATA_LOAD_TIMEOUT_MS = 4500;

type StockistSummary = {
  stockist: StockistProfile;
  totalIn: number;
  totalOut: number;
  balance: number;
  items: Array<{ name: string; balance: number; unitLabel?: string }>;
  autoOut: number;
  autoItems: Array<{ name: string; qty: number }>;
  lastMovementAt: Date | null;
  recentTransfers: StockTransfer[];
};

function parseNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
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

function getLineLabel(line: DolibarrOrderLine, productsById: Map<number, DolibarrProduct>): string {
  const productId = parseNumericId(line.fk_product);
  if (productId) {
    const product = productsById.get(productId);
    if (product?.label?.trim()) return product.label.trim();
    if (product?.ref?.trim()) return product.ref.trim();
  }
  return line.product_label?.trim() || line.label?.trim() || line.desc?.trim() || "Item";
}

function parseStockNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized =
      trimmed.includes(",") && !trimmed.includes(".")
        ? trimmed.replace(",", ".")
        : trimmed.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resolveStockFromPayload(payload: unknown): number | null {
  if (payload === null || payload === undefined) return null;
  const direct = parseStockNumber(payload);
  if (direct !== null) return direct;
  if (Array.isArray(payload)) {
    let total = 0;
    let found = false;
    for (const entry of payload) {
      const value = resolveStockFromPayload(entry);
      if (value !== null) {
        total += value;
        found = true;
      }
    }
    return found ? total : null;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const keys = ["stock_reel", "stock_real", "stock", "stock_qty", "qty", "real", "reel", "value"];
    for (const key of keys) {
      if (key in record) {
        const parsed = parseStockNumber(record[key]);
        if (parsed !== null) return parsed;
      }
    }
    if ("stocks" in record) {
      const nested = resolveStockFromPayload(record.stocks);
      if (nested !== null) return nested;
    }
    if ("stock" in record && typeof record.stock === "object") {
      const nested = resolveStockFromPayload(record.stock);
      if (nested !== null) return nested;
    }
    if ("stock_warehouse" in record) {
      const nested = resolveStockFromPayload(record.stock_warehouse);
      if (nested !== null) return nested;
    }
    if ("warehouse" in record) {
      const nested = resolveStockFromPayload(record.warehouse);
      if (nested !== null) return nested;
    }
    if ("warehouses" in record) {
      const nested = resolveStockFromPayload(record.warehouses);
      if (nested !== null) return nested;
    }

    let total = 0;
    let found = false;
    const nestedCandidates: unknown[] = [];
    for (const [key, value] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      const keyLooksRelevant =
        lowerKey.includes("stock") ||
        lowerKey.includes("warehouse") ||
        lowerKey.includes("qty") ||
        lowerKey.includes("quantity") ||
        /^\d+$/.test(key);
      if (!keyLooksRelevant) continue;
      const parsed = parseStockNumber(value);
      if (parsed !== null) {
        total += parsed;
        found = true;
        continue;
      }
      if (value && typeof value === "object") {
        nestedCandidates.push(value);
      }
    }

    if (nestedCandidates.length) {
      for (const entry of nestedCandidates) {
        const resolved = resolveStockFromPayload(entry);
        if (resolved !== null) {
          total += resolved;
          found = true;
        }
      }
    }

    if (found) return total;
  }
  return null;
}

function hasStockFields(product: DolibarrProduct): boolean {
  return (
    product.stock_reel !== undefined ||
    product.stock_real !== undefined ||
    product.stock !== undefined ||
    product.stock_qty !== undefined ||
    product.qty !== undefined ||
    product.stock_warehouse !== undefined
  );
}

function getProductStock(product: DolibarrProduct): number {
  const candidates = [
    product.stock_reel,
    product.stock_real,
    product.stock,
    product.stock_qty,
    product.qty,
  ];
  for (const candidate of candidates) {
    const parsed = parseStockNumber(candidate);
    if (parsed !== null) return parsed;
  }
  const warehouseStock = resolveStockFromPayload(product.stock_warehouse);
  if (warehouseStock !== null) return warehouseStock;
  return 0;
}

function formatQty(value: number, unitLabel?: string): string {
  const base = value.toFixed(0);
  return unitLabel ? `${base} ${unitLabel}` : base;
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function AdminStockScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user } = useAuth();
  const canAccess = canAccessAdminControls(user?.role);

  const [stockists, setStockists] = useState<StockistProfile[]>([]);
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<DolibarrProduct[]>([]);
  const [productStockById, setProductStockById] = useState<Record<string, number | null>>({});
  const [companyStockError, setCompanyStockError] = useState<string | null>(null);
  const loadingStockIds = useRef<Set<string>>(new Set());
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [orders, setOrders] = useState<DolibarrOrder[]>([]);
  const [orderLinesById, setOrderLinesById] = useState<Record<string, DolibarrOrderLine[]>>({});
  const [orderLinesLoading, setOrderLinesLoading] = useState(false);
  const [orderLinesError, setOrderLinesError] = useState<string | null>(null);

  const [newStockistName, setNewStockistName] = useState("");
  const [newStockistPhone, setNewStockistPhone] = useState("");
  const [newStockistLocation, setNewStockistLocation] = useState("");
  const [newStockistPincode, setNewStockistPincode] = useState("");
  const [newStockistNotes, setNewStockistNotes] = useState("");
  const [creatingStockist, setCreatingStockist] = useState(false);

  const [selectedStockistId, setSelectedStockistId] = useState("");
  const [transferType, setTransferType] = useState<TransferType>("in");
  const [itemName, setItemName] = useState("");
  const [itemProductId, setItemProductId] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [productLimit, setProductLimit] = useState(PRODUCT_DROPDOWN_PAGE);
  const loadMoreBusy = useRef(false);
  const [quantity, setQuantity] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [creatingTransfer, setCreatingTransfer] = useState(false);
  const [expandedStockists, setExpandedStockists] = useState<Record<string, boolean>>({});

  const loadEmployees = useCallback(async () => {
    try {
      const merged = await getMergedEmployees();
      if (Array.isArray(merged) && merged.length) return merged;
    } catch {
      // fallback below
    }
    return getAllEmployees();
  }, []);

  const loadData = useCallback(async () => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [stockistResult, transferResult, employeeResult] = await Promise.all([
        withTimeout(
          getStockists({ scope: "accessible", refreshRemote: true }),
          STOCK_DATA_LOAD_TIMEOUT_MS,
          [] as StockistProfile[]
        ),
        withTimeout(
          getStockTransfers({ scope: "accessible" }),
          STOCK_DATA_LOAD_TIMEOUT_MS,
          [] as StockTransfer[]
        ),
        withTimeout(loadEmployees(), STOCK_DATA_LOAD_TIMEOUT_MS, [] as Employee[]),
      ]);
      setStockists(stockistResult);
      setTransfers(transferResult);
      setEmployees(employeeResult.filter((entry) => entry.role === "salesperson"));
    } finally {
      setLoading(false);
    }

    void (async () => {
      const [productResult, ordersResult] = await Promise.all([
        getDolibarrProducts({
          limit: 400,
          sortfield: "label",
          sortorder: "asc",
          includestockdata: 1,
        }).catch(() => []),
        getDolibarrOrders({ limit: 400, sortfield: "date_commande", sortorder: "desc" }).catch(
          () => []
        ),
      ]);
      setProducts(Array.isArray(productResult) ? productResult : []);
      setOrders(Array.isArray(ordersResult) ? ordersResult : []);
    })();
  }, [canAccess, loadEmployees]);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const selectedStockist = useMemo(
    () => stockists.find((entry) => entry.id === selectedStockistId),
    [stockists, selectedStockistId]
  );

  const selectedSalesperson = useMemo(
    () => employees.find((entry) => entry.id === selectedSalespersonId),
    [employees, selectedSalespersonId]
  );

  const matchingProducts = useMemo(() => {
    const query = itemSearch.trim().toLowerCase();
    if (!query) return products;
    return products.filter((product) => {
      const label = product.label?.toString().toLowerCase() || "";
      const ref = product.ref?.toString().toLowerCase() || "";
      const desc = product.description?.toString().toLowerCase() || "";
      return label.includes(query) || ref.includes(query) || desc.includes(query);
    });
  }, [itemSearch, products]);

  const filteredProducts = useMemo(
    () => matchingProducts.slice(0, productLimit),
    [matchingProducts, productLimit]
  );
  const hasMoreProducts = filteredProducts.length < matchingProducts.length;

  useEffect(() => {
    const targetIds = new Set<string>();
    if (showItemDropdown) {
      for (const product of filteredProducts) {
        if (product.id === undefined || product.id === null) continue;
        targetIds.add(String(product.id));
      }
    }
    if (itemProductId) {
      targetIds.add(itemProductId);
    }
    if (!showItemDropdown && !itemProductId && Object.keys(productStockById).length === 0) {
      for (const product of products.slice(0, PREFETCH_PRODUCT_STOCK_COUNT)) {
        if (product.id === undefined || product.id === null) continue;
        targetIds.add(String(product.id));
      }
    }
    if (targetIds.size === 0) return;
    const pendingIds: string[] = [];
    for (const id of targetIds) {
      if (Object.prototype.hasOwnProperty.call(productStockById, id)) continue;
      if (loadingStockIds.current.has(id)) continue;
      pendingIds.push(id);
    }
    if (!pendingIds.length) return;
    pendingIds.forEach((id) => loadingStockIds.current.add(id));
    let active = true;
    const loadStock = async () => {
      try {
        const stockMap = await getCompanyProductStocks(pendingIds);
        if (!active) return;
        setCompanyStockError(null);
        setProductStockById((current) => {
          const next = { ...current };
          for (const id of pendingIds) {
            const parsed = parseStockNumber(stockMap[id]);
            next[id] = parsed !== null ? parsed : 0;
          }
          return next;
        });
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Unable to load company stock.";
        setCompanyStockError(message);
        setProductStockById((current) => {
          const next = { ...current };
          for (const id of pendingIds) {
            if (!Object.prototype.hasOwnProperty.call(next, id)) {
              next[id] = null;
            }
          }
          return next;
        });
      } finally {
        for (const id of pendingIds) {
          loadingStockIds.current.delete(id);
        }
      }
    };
    void loadStock();
    return () => {
      active = false;
    };
  }, [filteredProducts, itemProductId, productStockById, products, showItemDropdown]);

  const selectedProductStock = useMemo(() => {
    if (!itemProductId) return undefined;
    if (Object.prototype.hasOwnProperty.call(productStockById, itemProductId)) {
      return productStockById[itemProductId];
    }
    return undefined;
  }, [itemProductId, productStockById]);


  const stockistAreaMap = useMemo(() => {
    const map = new Map<string, string>();
    const duplicates = new Set<string>();
    for (const stockist of stockists) {
      const area = normalizeKey(stockist.pincode || "") || normalizeKey(stockist.location || "");
      if (!area) continue;
      if (map.has(area) && map.get(area) !== stockist.id) {
        duplicates.add(area);
        continue;
      }
      map.set(area, stockist.id);
    }
    return { map, duplicates };
  }, [stockists]);

  const stockistSummaries = useMemo<StockistSummary[]>(() => {
    return stockists.map((stockist) => {
      const relevantTransfers = transfers.filter((entry) => entry.stockistId === stockist.id);
      let totalIn = 0;
      let totalOut = 0;
      const itemMap = new Map<string, { name: string; balance: number; unitLabel?: string }>();
      let lastMovementAt: Date | null = null;

      for (const entry of relevantTransfers) {
        const qty = Number.isFinite(entry.quantity) ? entry.quantity : 0;
        if (entry.type === "in") {
          totalIn += qty;
        } else {
          totalOut += qty;
        }

        const name = entry.itemName || "Item";
        const key = name.toLowerCase();
        const current = itemMap.get(key) || { name, balance: 0, unitLabel: entry.unitLabel };
        const nextBalance = entry.type === "in" ? current.balance + qty : current.balance - qty;
        itemMap.set(key, {
          name: current.name,
          balance: nextBalance,
          unitLabel: current.unitLabel || entry.unitLabel,
        });

        if (entry.createdAt) {
          const date = new Date(entry.createdAt);
          if (!Number.isNaN(date.getTime())) {
            if (!lastMovementAt || date > lastMovementAt) {
              lastMovementAt = date;
            }
          }
        }
      }

      const autoItemMap = new Map<string, { name: string; qty: number }>();
      let autoOut = 0;
      for (const entry of relevantTransfers) {
        if (entry.type !== "out") continue;
        if (!(entry.note || "").match(/pos order/i)) continue;
        const qty = Number.isFinite(entry.quantity) ? entry.quantity : 0;
        if (!qty) continue;
        autoOut += qty;
        const name = entry.itemName || "Item";
        const key = name.toLowerCase();
        const current = autoItemMap.get(key) || { name, qty: 0 };
        current.qty += qty;
        autoItemMap.set(key, current);
      }

      const items = Array.from(itemMap.values()).sort((a, b) => a.name.localeCompare(b.name));
      const autoItems = Array.from(autoItemMap.values()).sort((a, b) => b.qty - a.qty);
      const recentTransfers = [...relevantTransfers].sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      });

      return {
        stockist,
        totalIn,
        totalOut,
        balance: totalIn - totalOut,
        items,
        autoOut,
        autoItems,
        lastMovementAt,
        recentTransfers: recentTransfers.slice(0, 4),
      };
    });
  }, [stockists, transfers]);

  const totalStock = stockistSummaries.reduce((sum, entry) => sum + entry.balance, 0);
  const totalTransfers = transfers.length;
  const totalCompanyStock = useMemo(
    () => Object.values(productStockById).reduce<number>((sum, value) => sum + (value ?? 0), 0),
    [productStockById]
  );
  const companyStockCount = useMemo(
    () => Object.values(productStockById).filter((value) => typeof value === "number").length,
    [productStockById]
  );

  const directSalesSummary = useMemo(
    () => ({ totalQty: 0, items: [] as Array<{ name: string; qty: number }> }),
    []
  );
  const handleAddStockist = useCallback(async () => {
    if (!newStockistName.trim() || creatingStockist) {
      Alert.alert("Channel Partner Name Required", "Please enter a channel partner name.");
      return;
    }
    setCreatingStockist(true);
    try {
      const created = await addStockist({
        name: newStockistName.trim(),
        phone: newStockistPhone.trim() || undefined,
        location: newStockistLocation.trim() || undefined,
        pincode: newStockistPincode.trim() || undefined,
        notes: newStockistNotes.trim() || undefined,
      });
      setStockists((current) => [created, ...current]);
      setNewStockistName("");
      setNewStockistPhone("");
      setNewStockistLocation("");
      setNewStockistPincode("");
      setNewStockistNotes("");
      setSelectedStockistId(created.id);
      if (user) {
        await addAuditLog({
          id: `audit_stockist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: "Channel Partner Added",
          details: created.name,
          timestamp: new Date().toISOString(),
          module: "Stock",
        });
      }
    } finally {
      setCreatingStockist(false);
    }
  }, [
    creatingStockist,
    newStockistLocation,
    newStockistName,
    newStockistNotes,
    newStockistPhone,
    newStockistPincode,
    user,
  ]);

  const handleAddTransfer = useCallback(async () => {
    if (!selectedStockist) {
      Alert.alert("Select Channel Partner", "Choose a channel partner before recording stock.");
      return;
    }
    const trimmedItem = itemName.trim();
    if (!trimmedItem) {
      Alert.alert("Item Required", "Please enter an item name.");
      return;
    }
    const qtyValue = parseNumber(quantity);
    if (qtyValue <= 0) {
      Alert.alert("Quantity Required", "Enter a valid quantity.");
      return;
    }
    if (transferType === "out" && !selectedSalesperson) {
      Alert.alert("Select Salesperson", "Choose who received the stock.");
      return;
    }
    if (creatingTransfer) return;

    setCreatingTransfer(true);
    try {
      let updatedCompanyStock: { productId: string; stock: number } | null = null;
      if (transferType === "in" && itemProductId) {
        try {
          updatedCompanyStock = await adjustCompanyProductStock({
            productId: itemProductId,
            delta: -qtyValue,
            reason: `Stock sent to channel partner ${selectedStockist.name}`,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to update company stock.";
          Alert.alert("Stock Update Failed", message);
          return;
        }
      }

      const now = new Date().toISOString();
      const payload: StockTransfer = {
        id: `stock_transfer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        stockistId: selectedStockist.id,
        stockistName: selectedStockist.name,
        type: transferType,
        itemName: trimmedItem,
        itemId: itemProductId || undefined,
        quantity: qtyValue,
        unitLabel: unitLabel.trim() || undefined,
        salespersonId: transferType === "out" ? selectedSalesperson?.id : undefined,
        salespersonName: transferType === "out" ? selectedSalesperson?.name : undefined,
        note: transferNote.trim() || undefined,
        createdAt: now,
      };
      await addStockTransfer(payload);
      setTransfers((current) => [payload, ...current]);
      if (updatedCompanyStock) {
        setProductStockById((current) => ({
          ...current,
          [updatedCompanyStock.productId]: updatedCompanyStock.stock,
        }));
      }
      setItemName("");
      setItemProductId(null);
      setItemSearch("");
      setQuantity("");
      setUnitLabel("");
      setSelectedSalespersonId("");
      setTransferNote("");
      if (user) {
        const direction = transferType === "in" ? "Sent to channel partner" : "Sent to salesperson";
        await addAuditLog({
          id: `audit_stock_transfer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: "Stock Transfer",
          details: `${direction}: ${trimmedItem} x${qtyValue} (${selectedStockist.name})`,
          timestamp: now,
          module: "Stock",
        });
      }
    } finally {
      setCreatingTransfer(false);
    }
  }, [
    creatingTransfer,
    itemName,
    quantity,
    selectedSalesperson,
    selectedStockist,
    transferNote,
    transferType,
    unitLabel,
    user,
  ]);

  const toggleStockist = useCallback((stockistId: string) => {
    setExpandedStockists((current) => ({
      ...current,
      [stockistId]: !current[stockistId],
    }));
  }, []);

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
              Stock movement tracking is only available to admins.
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
        keyboardShouldPersistTaps="always"
      >
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>

        <Animated.View entering={FadeInDown.duration(240)} style={styles.headerWrap}>
          <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
            Channel Partner Tracking
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            Monitor stock sent to channel partners and forwarded to sales team.
          </Text>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(280).delay(60)}
          style={[styles.summaryCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <View style={styles.summaryRow}>
            <View style={styles.summaryBlock}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Channel Partners
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
                {stockists.length}
              </Text>
            </View>
            <View style={styles.summaryBlock}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Channel Partner Stock
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
                {formatQty(totalStock)}
              </Text>
            </View>
            <View style={styles.summaryBlock}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Transfers
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}> 
                {totalTransfers}
              </Text>
            </View>
          </View>

          {companyStockCount > 0 ? (
            <Text
              style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
            >
              Company stock loaded: {companyStockCount} items - Total {formatQty(totalCompanyStock)}
            </Text>
          ) : null}

          {companyStockError ? (
            <Text style={[styles.helperText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
              {companyStockError}
            </Text>
          ) : null}

          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Loading stock data...
              </Text>
            </View>
          ) : null}

          {orderLinesLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}> 
                Calculating sales deductions...
              </Text>
            </View>
          ) : null}

          {orderLinesError ? (
            <Text style={[styles.helperText, { color: colors.warning, fontFamily: "Inter_500Medium" }]}> 
              {orderLinesError}
            </Text>
          ) : null}

          {directSalesSummary.totalQty > 0 ? (
            <View style={[styles.directSummaryRow, { backgroundColor: colors.warning + "12", borderColor: colors.warning + "45" }]}> 
              <Text style={[styles.directSummaryLabel, { color: colors.warning }]}> 
                Direct sales (no channel partner)
              </Text>
              <Text style={[styles.directSummaryValue, { color: colors.warning }]}> 
                {formatQty(directSalesSummary.totalQty)}
              </Text>
            </View>
          ) : null}

          {stockistAreaMap.duplicates.size > 0 ? (
            <Text style={[styles.helperText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}> 
              Multiple partners share the same pincode. Auto-deduction uses the first match only.
            </Text>
          ) : null}
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(300).delay(100)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
            Add Channel Partner
          </Text>
          <TextInput
            value={newStockistName}
            onChangeText={setNewStockistName}
            placeholder="Channel partner name"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <TextInput
            value={newStockistPhone}
            onChangeText={setNewStockistPhone}
            placeholder="Phone (optional)"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <TextInput
            value={newStockistLocation}
            onChangeText={setNewStockistLocation}
            placeholder="Area / Location (match salesperson location)"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <TextInput
            value={newStockistPincode}
            onChangeText={setNewStockistPincode}
            placeholder="Pincode (match salesperson pincode)"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            Auto deduction matches salesperson pincode first, then location if pincode is missing.
          </Text>
          <TextInput
            value={newStockistNotes}
            onChangeText={setNewStockistNotes}
            placeholder="Notes (optional)"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />
          <Pressable
            onPress={() => void handleAddStockist()}
            disabled={creatingStockist}
            style={[
              styles.primaryButton,
              { backgroundColor: colors.primary, opacity: creatingStockist ? 0.7 : 1 },
            ]}
          >
            {creatingStockist ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="add-circle-outline" size={16} color="#fff" />
                <Text style={styles.primaryButtonText}>Add Channel Partner</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <Animated.View
          entering={FadeInDown.duration(320).delay(140)}
          style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
        >
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
            Record Stock Movement
          </Text>

          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Choose channel partner</Text>
          <View style={styles.chipRow}>
            {stockists.map((stockist) => {
              const active = stockist.id === selectedStockistId;
              return (
                <Pressable
                  key={stockist.id}
                  onPress={() => setSelectedStockistId(stockist.id)}
                  style={[
                    styles.chip,
                    {
                      borderColor: active ? colors.primary : colors.border,
                      backgroundColor: active ? colors.primary + "15" : colors.surface,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}> 
                    {stockist.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Transfer type</Text>
          <View style={styles.chipRow}>
            {TRANSFER_TYPES.map((option) => {
              const active = option.key === transferType;
              return (
                <Pressable
                  key={option.key}
                  onPress={() => setTransferType(option.key)}
                  style={[
                    styles.chip,
                    {
                      borderColor: active ? colors.success : colors.border,
                      backgroundColor: active ? colors.success + "15" : colors.surface,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: active ? colors.success : colors.textSecondary }]}> 
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
            Sales are auto-deducted by pincode. Use "Sent to Salesperson" only for manual adjustments.
          </Text>

          <View style={styles.dropdownWrap}>
            <TextInput
              value={itemSearch}
              onChangeText={(value) => {
                setItemSearch(value);
                setItemName(value);
                setItemProductId(null);
                setProductLimit(PRODUCT_DROPDOWN_PAGE);
                if (!showItemDropdown) setShowItemDropdown(true);
              }}
              onFocus={() => {
                setShowItemDropdown(true);
                if (!products.length && !loadingProducts) {
                  setLoadingProducts(true);
                  getDolibarrProducts({ limit: 400, sortfield: "label", sortorder: "asc", includestockdata: 1 })
                    .then((result) => {
                      setProducts(Array.isArray(result) ? result : []);
                    })
                    .finally(() => setLoadingProducts(false));
                }
              }}
              onBlur={() => {
                setTimeout(() => setShowItemDropdown(false), 150);
              }}
              placeholder="Search item (Dolibarr)"
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />
              {showItemDropdown ? (
                <View style={[styles.dropdownList, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  {loadingProducts ? (
                    <View style={styles.dropdownRow}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={[styles.dropdownText, { color: colors.textSecondary }]}>Loading items...</Text>
                    </View>
                  ) : matchingProducts.length === 0 ? (
                    <View style={styles.dropdownRow}>
                      <Text style={[styles.dropdownText, { color: colors.textSecondary }]}>No matching items</Text>
                    </View>
                  ) : (
                    <ScrollView
                      style={styles.dropdownScroll}
                      contentContainerStyle={styles.dropdownContent}
                      nestedScrollEnabled
                      keyboardShouldPersistTaps="always"
                      scrollEventThrottle={16}
                      onScroll={({ nativeEvent }) => {
                        if (!hasMoreProducts || loadMoreBusy.current) return;
                        const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
                        const paddingToBottom = 24;
                        if (layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom) {
                          loadMoreBusy.current = true;
                          setProductLimit((current) =>
                            Math.min(current + PRODUCT_DROPDOWN_PAGE, matchingProducts.length)
                          );
                          setTimeout(() => {
                            loadMoreBusy.current = false;
                          }, 150);
                        }
                      }}
                    >
                      {filteredProducts.map((product) => {
                        const label =
                          product.label?.toString().trim() || product.ref?.toString().trim() || "Item";
                        const productId = product.id ? String(product.id) : "";
                        const hasCachedStock =
                          productId &&
                          Object.prototype.hasOwnProperty.call(productStockById, productId);
                        const stockQty = hasCachedStock ? productStockById[productId] : null;
                        return (
                          <Pressable
                            key={String(product.id || label)}
                            onPress={() => {
                              setItemName(label);
                              setItemSearch(label);
                              setItemProductId(product.id ? String(product.id) : null);
                              setShowItemDropdown(false);
                            }}
                            style={({ pressed }) => [
                              styles.dropdownRow,
                              { backgroundColor: pressed ? colors.primary + "10" : "transparent" },
                            ]}
                          >
                            <View style={styles.dropdownRowHeader}>
                              <Text style={[styles.dropdownText, { color: colors.text }]}>{label}</Text>
                              {stockQty !== null ? (
                                <Text style={[styles.dropdownStockText, { color: colors.textSecondary }]}>
                                  Stock: {formatQty(stockQty)}
                                </Text>
                              ) : null}
                            </View>
                            {product.ref ? (
                              <Text style={[styles.dropdownMeta, { color: colors.textSecondary }]}>
                                {product.ref}
                              </Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  )}
                </View>
              ) : null}
          </View>
          {itemProductId ? (
            <Text style={[styles.helperText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Company stock available: {selectedProductStock !== null && selectedProductStock !== undefined ? formatQty(selectedProductStock) : "Loading..."}
            </Text>
          ) : null}
          <View style={styles.inputRow}>
            <TextInput
              value={quantity}
              onChangeText={setQuantity}
              placeholder="Qty"
              placeholderTextColor={colors.textTertiary}
              keyboardType="numeric"
              style={[
                styles.input,
                styles.inputHalf,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />
            <TextInput
              value={unitLabel}
              onChangeText={setUnitLabel}
              placeholder="Unit (pcs, boxes)"
              placeholderTextColor={colors.textTertiary}
              style={[
                styles.input,
                styles.inputHalf,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />
          </View>

          {transferType === "out" ? (
            <>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Select salesperson</Text>
              <View style={styles.chipRow}>
                {employees.map((salesperson) => {
                  const active = salesperson.id === selectedSalespersonId;
                  return (
                    <Pressable
                      key={salesperson.id}
                      onPress={() => setSelectedSalespersonId(salesperson.id)}
                      style={[
                        styles.chip,
                        {
                          borderColor: active ? colors.warning : colors.border,
                          backgroundColor: active ? colors.warning + "18" : colors.surface,
                        },
                      ]}
                    >
                      <Text style={[styles.chipText, { color: active ? colors.warning : colors.textSecondary }]}> 
                        {salesperson.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          <TextInput
            value={transferNote}
            onChangeText={setTransferNote}
            placeholder="Notes (optional)"
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
          />

          <Pressable
            onPress={() => void handleAddTransfer()}
            disabled={creatingTransfer}
            style={[
              styles.primaryButton,
              { backgroundColor: colors.success, opacity: creatingTransfer ? 0.7 : 1 },
            ]}
          >
            {creatingTransfer ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="cube-outline" size={16} color="#fff" />
                <Text style={styles.primaryButtonText}>Save Stock Movement</Text>
              </>
            )}
          </Pressable>
        </Animated.View>

        <View style={styles.listWrap}>
          {stockistSummaries.length === 0 && !loading ? (
            <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}> 
              <Ionicons name="cube-outline" size={36} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}> 
                No channel partners or transfers yet.
              </Text>
            </View>
          ) : (
            stockistSummaries.map((summary, index) => {
              const expanded = expandedStockists[summary.stockist.id];
              const stockistLocation = summary.stockist.location;
              const stockistPincode = summary.stockist.pincode;
              const stockistPhone = summary.stockist.phone;
              const stockistMeta = [stockistLocation, stockistPincode, stockistPhone]
                .filter(Boolean)
                .join(" � ");
              return (
                <Animated.View
                  key={summary.stockist.id}
                  entering={FadeInDown.duration(260).delay(160 + index * 20)}
                  style={[styles.stockCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
                >
                  <View style={styles.stockHeader}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.stockTitleRow}>
                        <Text style={[styles.stockName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}> 
                          {summary.stockist.name}
                        </Text>
                        {summary.autoOut > 0 ? (
                          <View
                            style={[
                              styles.autoChip,
                              { borderColor: colors.warning + "55", backgroundColor: colors.warning + "12" },
                            ]}
                          >
                            <Text style={[styles.autoChipText, { color: colors.warning }]}> 
                              Auto -{formatQty(summary.autoOut)}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={styles.metaRow}>
                        {stockistLocation ? (
                          <View style={[styles.metaChip, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                            <Text style={[styles.metaChipText, { color: colors.textSecondary }]}> 
                              {stockistLocation}
                            </Text>
                          </View>
                        ) : null}
                        {stockistPincode ? (
                          <View style={[styles.metaChip, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                            <Text style={[styles.metaChipText, { color: colors.textSecondary }]}> 
                              {stockistPincode}
                            </Text>
                          </View>
                        ) : null}
                        {stockistPhone ? (
                          <View style={[styles.metaChip, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                            <Text style={[styles.metaChipText, { color: colors.textSecondary }]}> 
                              {stockistPhone}
                            </Text>
                          </View>
                        ) : null}
                        {!stockistMeta ? (
                          <View style={[styles.metaChip, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                            <Text style={[styles.metaChipText, { color: colors.textSecondary }]}>Channel Partner</Text>
                          </View>
                        ) : null}
                      </View>

                      <Text style={[styles.stockMeta, { color: colors.textTertiary }]}> 
                        Last movement: {summary.lastMovementAt ? summary.lastMovementAt.toLocaleDateString() : "�"}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.balanceBadge,
                        { borderColor: colors.primary + "55", backgroundColor: colors.primary + "12" },
                      ]}
                    >
                      <Text style={[styles.balanceValue, { color: colors.primary }]}> 
                        {formatQty(summary.balance)}
                      </Text>
                      <Text style={[styles.balanceLabel, { color: colors.primary }]}>In Stock</Text>
                    </View>
                  </View>

                  <View style={styles.summaryMiniRow}>
                    <View style={[styles.summaryMiniCard, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                      <Text style={[styles.summaryMiniLabel, { color: colors.textSecondary }]}>IN</Text>
                      <Text style={[styles.summaryMiniValue, { color: colors.success }]}> 
                        {formatQty(summary.totalIn)}
                      </Text>
                    </View>
                    <View style={[styles.summaryMiniCard, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                      <Text style={[styles.summaryMiniLabel, { color: colors.textSecondary }]}>OUT</Text>
                      <Text style={[styles.summaryMiniValue, { color: colors.warning }]}> 
                        {formatQty(summary.totalOut)}
                      </Text>
                    </View>
                    <View style={[styles.summaryMiniCard, { borderColor: colors.border, backgroundColor: colors.surface }]}> 
                      <Text style={[styles.summaryMiniLabel, { color: colors.textSecondary }]}>ITEMS</Text>
                      <Text style={[styles.summaryMiniValue, { color: colors.text }]}> 
                        {summary.items.length}
                      </Text>
                    </View>
                  </View>

                  <Pressable
                    onPress={() => toggleStockist(summary.stockist.id)}
                    style={[styles.expandButton, { borderColor: colors.border, backgroundColor: colors.surface }]}
                  >
                    <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.textSecondary} />
                    <Text style={[styles.expandText, { color: colors.textSecondary }]}> 
                      {expanded ? "Hide details" : "View details"}
                    </Text>
                  </Pressable>

                  {expanded ? (
                    <View style={[styles.detailCard, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}> 
                      <Text style={[styles.detailTitle, { color: colors.textSecondary }]}>Item balances</Text>
                      {summary.items.length === 0 ? (
                        <Text style={[styles.detailEmpty, { color: colors.textTertiary }]}>No item balances yet.</Text>
                      ) : (
                        summary.items.map((item) => (
                          <View key={`${summary.stockist.id}_${item.name}`} style={styles.detailRow}>
                            <Text style={[styles.detailLabel, { color: colors.text }]}>{item.name}</Text>
                            <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
                              {formatQty(item.balance, item.unitLabel)}
                            </Text>
                          </View>
                        ))
                      )}

                      {summary.autoItems.length > 0 ? (
                        <>
                          <Text style={[styles.detailTitle, { color: colors.textSecondary }]}>Sales deductions</Text>
                          {summary.autoItems.map((item) => (
                            <View key={`${summary.stockist.id}_auto_${item.name}`} style={styles.detailRow}>
                              <Text style={[styles.detailLabel, { color: colors.text }]}>{item.name}</Text>
                              <Text style={[styles.detailValue, { color: colors.warning }]}>
                                -{formatQty(item.qty)}
                              </Text>
                            </View>
                          ))}
                        </>
                      ) : null}

                      <Text style={[styles.detailTitle, { color: colors.textSecondary }]}>Recent movements</Text>
                      {summary.recentTransfers.length === 0 ? (
                        <Text style={[styles.detailEmpty, { color: colors.textTertiary }]}>No transfers yet.</Text>
                      ) : (
                        summary.recentTransfers.map((entry) => (
                          <View key={entry.id} style={styles.detailRow}>
                            <Text style={[styles.detailLabel, { color: colors.text }]}> 
                              {entry.type === "in" ? "IN" : "OUT"} � {entry.itemName}
                            </Text>
                            <Text style={[styles.detailValue, { color: colors.textSecondary }]}> 
                              {formatQty(entry.quantity, entry.unitLabel)}
                            </Text>
                          </View>
                        ))
                      )}
                    </View>
                  ) : null}
                </Animated.View>
              );
            })
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
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: { fontSize: 12 },
  helperText: { fontSize: 11, marginTop: 4 },
  directSummaryRow: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  directSummaryLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  directSummaryValue: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 12,
    marginBottom: 6,
    fontFamily: "Inter_500Medium",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 10,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontFamily: "Inter_400Regular",
    marginBottom: 8,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
  },
  dropdownWrap: {
    position: "relative",
    zIndex: 2,
  },
  dropdownList: {
    borderWidth: 1,
    borderRadius: 12,
    marginTop: 6,
    maxHeight: 220,
    overflow: "hidden",
  },
  dropdownScroll: {
    maxHeight: 220,
  },
  dropdownContent: {
    paddingVertical: 2,
  },
  dropdownRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(148, 163, 184, 0.35)",
    },
  dropdownRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  dropdownStockText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  dropdownText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  dropdownMeta: {
    fontSize: 11,
    marginTop: 2,
  },
  inputHalf: {
    flex: 1,
  },
  primaryButton: {
    minHeight: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 7,
    marginTop: 6,
  },
  primaryButtonText: {
    color: "#fff",
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  listWrap: {
    gap: 12,
  },
  stockCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  stockHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  stockTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  stockName: { fontSize: 15 },
  stockMeta: { fontSize: 11, marginTop: 6, fontFamily: "Inter_400Regular" },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  metaChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  metaChipText: { fontSize: 10, fontFamily: "Inter_500Medium" },
  autoChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  autoChipText: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  balanceBadge: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 84,
    alignItems: "center",
  },
  balanceValue: { fontSize: 16, fontFamily: "Inter_700Bold" },
  balanceLabel: { fontSize: 10, fontFamily: "Inter_600SemiBold" },
  summaryMiniRow: {
    flexDirection: "row",
    gap: 8,
  },
  summaryMiniCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  summaryMiniLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summaryMiniValue: { fontSize: 14, fontFamily: "Inter_700Bold", marginTop: 2 },
  summaryRowSmall: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryLabelSmall: { fontSize: 11, fontFamily: "Inter_500Medium" },
  summaryValueSmall: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  expandButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  expandText: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  detailCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  detailTitle: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detailLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
  detailValue: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  detailEmpty: { fontSize: 12, fontFamily: "Inter_400Regular" },
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

