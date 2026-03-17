import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown, Layout } from "react-native-reanimated";
import { useFocusEffect } from "expo-router";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { canAccessAdminControls } from "@/lib/role-access";
import {
  addAuditLog,
  addIncentiveGoalPlan,
  addIncentivePayout,
  addIncentiveProductPlan,
  getIncentiveGoalPlans,
  getIncentivePayouts,
  getIncentiveProductPlans,
  removeIncentiveGoalPlan,
  removeIncentiveProductPlan,
  updateIncentiveGoalPlan,
  updateIncentiveProductPlan,
} from "@/lib/storage";
import {
  getDolibarrOrderDetail,
  getDolibarrOrders,
  getDolibarrProducts,
  getDolibarrUsers,
  type DolibarrOrder,
  type DolibarrOrderLine,
  type DolibarrProduct,
  type DolibarrUser,
} from "@/lib/attendance-api";
import type {
  IncentiveGoalPlan,
  IncentivePeriod,
  IncentivePayout,
  IncentiveProductPlan,
} from "@/lib/types";

const RANGE_OPTIONS = [
  { key: "daily", label: "Daily", days: 1 },
  { key: "weekly", label: "Weekly", days: 7 },
  { key: "monthly", label: "Monthly", days: 30 },
] as const;

const ITEMWISE_BATCH = 6;
const PRODUCT_DROPDOWN_PAGE = 12;

type SalespersonIncentiveRow = {
  salespersonId: string;
  salespersonName: string;
  totalOrders: number;
  totalValue: number;
  totalQty: number;
  goalAmount: number;
  productAmount: number;
  totalAmount: number;
};

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

function getUserLabel(user?: DolibarrUser): string {
  if (!user) return "Salesperson";
  const first = user.firstname?.trim() || "";
  const last = user.lastname?.trim() || "";
  const name = `${first} ${last}`.trim();
  return name || user.login?.trim() || user.email?.trim() || "Salesperson";
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseAmountInput(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function parseIntInput(value: string): number {
  const cleaned = value.replace(/[^0-9]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function formatCurrency(value: number): string {
  return `INR ${value.toFixed(2)}`;
}

export default function AdminIncentivesScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const { user, company } = useAuth();
  const canAccess = canAccessAdminControls(user?.role);

  const [orders, setOrders] = useState<DolibarrOrder[]>([]);
  const [users, setUsers] = useState<DolibarrUser[]>([]);
  const [products, setProducts] = useState<DolibarrProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [goalPlans, setGoalPlans] = useState<IncentiveGoalPlan[]>([]);
  const [productPlans, setProductPlans] = useState<IncentiveProductPlan[]>([]);
  const [payouts, setPayouts] = useState<IncentivePayout[]>([]);

  const [rangeKey, setRangeKey] = useState<IncentivePeriod>("monthly");
  const [rangeEnd, setRangeEnd] = useState<Date>(() => new Date());
  const [itemLinesByOrderId, setItemLinesByOrderId] = useState<
    Record<string, DolibarrOrderLine[]>
  >({});
  const [itemLinesLoading, setItemLinesLoading] = useState(false);
  const [itemLinesError, setItemLinesError] = useState<string | null>(null);

  const [goalTitle, setGoalTitle] = useState("");
  const [goalTargetQty, setGoalTargetQty] = useState("");
  const [goalThresholdPercent, setGoalThresholdPercent] = useState("90");
  const [goalPerUnit, setGoalPerUnit] = useState("");
  const [goalPeriod, setGoalPeriod] = useState<IncentivePeriod>("monthly");
  const [creatingGoal, setCreatingGoal] = useState(false);

  const [productQuery, setProductQuery] = useState("");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [productPerUnit, setProductPerUnit] = useState("");
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productLimit, setProductLimit] = useState(PRODUCT_DROPDOWN_PAGE);
  const dropdownCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropdownInteraction = useRef(false);
  const loadMoreBusy = useRef(false);

  const [payingSalespersonId, setPayingSalespersonId] = useState<string | null>(null);

  const ensureProductsLoaded = useCallback(() => {
    if (products.length || loadingProducts) return;
    setLoadingProducts(true);
    getDolibarrProducts({ limit: 400, sortfield: "label", sortorder: "asc" })
      .then((result) => setProducts(Array.isArray(result) ? result : []))
      .catch(() => undefined)
      .finally(() => setLoadingProducts(false));
  }, [loadingProducts, products]);

  const cancelDropdownClose = useCallback(() => {
    if (dropdownCloseTimer.current) {
      clearTimeout(dropdownCloseTimer.current);
      dropdownCloseTimer.current = null;
    }
  }, []);

  const scheduleDropdownClose = useCallback(() => {
    cancelDropdownClose();
    dropdownCloseTimer.current = setTimeout(() => {
      if (!dropdownInteraction.current) {
        setShowProductDropdown(false);
      }
    }, 150);
  }, [cancelDropdownClose]);

  const loadData = useCallback(async () => {
    if (!canAccess) return;
    setLoading(true);
    setError(null);
    setItemLinesError(null);
    try {
      const [
        ordersResult,
        usersResult,
        productResult,
        goalPlanResult,
        productPlanResult,
        payoutResult,
      ] = await Promise.all([
        getDolibarrOrders({ limit: 400, sortfield: "date_commande", sortorder: "desc" }),
        getDolibarrUsers({ limit: 300, sortfield: "lastname", sortorder: "asc" }),
        getDolibarrProducts({ limit: 400, sortfield: "label", sortorder: "asc" }),
        getIncentiveGoalPlans(),
        getIncentiveProductPlans(),
        getIncentivePayouts(),
      ]);

      setOrders(Array.isArray(ordersResult) ? ordersResult : []);
      setUsers(Array.isArray(usersResult) ? usersResult : []);
      setProducts(Array.isArray(productResult) ? productResult : []);
      setGoalPlans(Array.isArray(goalPlanResult) ? goalPlanResult : []);
      setProductPlans(Array.isArray(productPlanResult) ? productPlanResult : []);
      setPayouts(Array.isArray(payoutResult) ? payoutResult : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to load incentive data.";
      setError(message);
    } finally {
      setRangeEnd(new Date());
      setLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    setRangeEnd(new Date());
  }, [rangeKey]);

  useEffect(() => {
    setProductLimit(PRODUCT_DROPDOWN_PAGE);
  }, [productQuery]);

  useEffect(() => {
    return () => {
      if (dropdownCloseTimer.current) clearTimeout(dropdownCloseTimer.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData])
  );

  const rangeStart = useMemo(() => {
    const start = new Date(rangeEnd);
    start.setHours(0, 0, 0, 0);
    if (rangeKey === "daily") return start;
    if (rangeKey === "weekly") {
      start.setDate(start.getDate() - 6);
      return start;
    }
    start.setDate(start.getDate() - 29);
    return start;
  }, [rangeEnd, rangeKey]);

  const rangeStartKey = useMemo(() => toDateKey(rangeStart), [rangeStart]);
  const rangeEndKey = useMemo(() => toDateKey(rangeEnd), [rangeEnd]);

  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      const date = getOrderDate(order);
      if (!date) return true;
      return date >= rangeStart;
    });
  }, [orders, rangeStart]);

  const filteredOrderIds = useMemo(
    () =>
      filteredOrders
        .map((order) => parseNumericId(order.id))
        .filter((id): id is number => Boolean(id)),
    [filteredOrders]
  );

  const usersById = useMemo(() => {
    const map = new Map<number, DolibarrUser>();
    for (const entry of users) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [users]);

  const productsById = useMemo(() => {
    const map = new Map<number, DolibarrProduct>();
    for (const entry of products) {
      const id = parseNumericId(entry.id);
      if (id) map.set(id, entry);
    }
    return map;
  }, [products]);

  const orderSalespersonMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const order of filteredOrders) {
      const orderId = parseNumericId(order.id);
      const salespersonId = getOrderSalespersonId(order);
      if (!orderId || !salespersonId) continue;
      map.set(String(orderId), String(salespersonId));
    }
    return map;
  }, [filteredOrders]);

  useEffect(() => {
    if (!canAccess || filteredOrderIds.length === 0) return;
    let active = true;
    const missing = filteredOrderIds.filter((id) => !itemLinesByOrderId[String(id)]);
    if (!missing.length || itemLinesLoading) return;
    setItemLinesLoading(true);
    setItemLinesError(null);

    const loadLines = async () => {
      const collected: Record<string, DolibarrOrderLine[]> = {};
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
        for (const result of results) {
          collected[result.id] = Array.isArray(result.lines) ? result.lines : [];
          if ("error" in result && result.error) {
            setItemLinesError(result.error);
          }
        }
      }
      if (!active) return;
      setItemLinesByOrderId((current) => ({ ...current, ...collected }));
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
  }, [canAccess, filteredOrderIds, itemLinesByOrderId, itemLinesLoading]);

  const activeGoalPlans = useMemo(
    () => goalPlans.filter((plan) => plan.active && plan.period === rangeKey),
    [goalPlans, rangeKey]
  );

  const productPlansById = useMemo(() => {
    const map = new Map<string, IncentiveProductPlan>();
    for (const plan of productPlans) {
      if (!plan.active) continue;
      if (plan.productId) {
        map.set(String(plan.productId), plan);
      }
    }
    return map;
  }, [productPlans]);

  const productPlansByName = useMemo(() => {
    const map = new Map<string, IncentiveProductPlan>();
    for (const plan of productPlans) {
      if (!plan.active) continue;
      map.set(normalizeKey(plan.productName), plan);
    }
    return map;
  }, [productPlans]);

  const salespersonRows = useMemo<SalespersonIncentiveRow[]>(() => {
    const map = new Map<string, SalespersonIncentiveRow>();

    for (const order of filteredOrders) {
      const salespersonId = getOrderSalespersonId(order);
      if (!salespersonId) continue;
      const key = String(salespersonId);
      const userName = getUserLabel(usersById.get(salespersonId));
      const existing = map.get(key) || {
        salespersonId: key,
        salespersonName: userName,
        totalOrders: 0,
        totalValue: 0,
        totalQty: 0,
        goalAmount: 0,
        productAmount: 0,
        totalAmount: 0,
      };
      existing.totalOrders += 1;
      existing.totalValue += getOrderTotal(order);
      map.set(key, existing);
    }

    for (const orderId of filteredOrderIds) {
      const salespersonId = orderSalespersonMap.get(String(orderId));
      if (!salespersonId) continue;
      const row = map.get(salespersonId);
      if (!row) continue;
      const lines = itemLinesByOrderId[String(orderId)] || [];
      for (const line of lines) {
        const qty = parseNumber(line.qty) ?? 0;
        if (!qty) continue;
        row.totalQty += qty;

        const productId = parseNumericId(line.fk_product);
        let plan: IncentiveProductPlan | undefined;
        if (productId) {
          plan = productPlansById.get(String(productId));
        }
        if (!plan) {
          const label = getLineLabel(line, productsById);
          plan = productPlansByName.get(normalizeKey(label));
        }
        if (plan) {
          row.productAmount += qty * plan.perUnitAmount;
        }
      }
    }

    for (const row of map.values()) {
      let goalAmount = 0;
      for (const plan of activeGoalPlans) {
        if (!plan.targetQty || !plan.perUnitAmount) continue;
        const thresholdQty = plan.targetQty * (plan.thresholdPercent / 100);
        const eligibleQty = row.totalQty - thresholdQty;
        if (eligibleQty > 0) {
          goalAmount += eligibleQty * plan.perUnitAmount;
        }
      }
      row.goalAmount = goalAmount;
      row.totalAmount = row.goalAmount + row.productAmount;
    }

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [
    activeGoalPlans,
    filteredOrderIds,
    filteredOrders,
    itemLinesByOrderId,
    orderSalespersonMap,
    productPlansById,
    productPlansByName,
    productsById,
    usersById,
  ]);

  const totalOrders = filteredOrders.length;
  const totalValue = filteredOrders.reduce((sum, order) => sum + getOrderTotal(order), 0);
  const totalIncentives = salespersonRows.reduce((sum, row) => sum + row.totalAmount, 0);

  const payoutBySalesperson = useMemo(() => {
    const map = new Map<string, IncentivePayout>();
    for (const payout of payouts) {
      if (
        payout.rangeKey === rangeKey &&
        payout.rangeStart === rangeStartKey &&
        payout.rangeEnd === rangeEndKey
      ) {
        map.set(payout.salespersonId, payout);
      }
    }
    return map;
  }, [payouts, rangeEndKey, rangeKey, rangeStartKey]);

  const rangeLabel = useMemo(() => {
    return `${rangeStart.toLocaleDateString()} - ${rangeEnd.toLocaleDateString()}`;
  }, [rangeEnd, rangeStart]);

  const matchingProducts = useMemo(() => {
    const query = normalizeKey(productQuery);
    if (!query) return products;
    return products
      .filter((product) => {
        const label = normalizeKey(product.label || "");
        const ref = normalizeKey(product.ref || "");
        return label.includes(query) || ref.includes(query);
      });
  }, [productQuery, products]);

  const filteredProducts = useMemo(
    () => matchingProducts.slice(0, productLimit),
    [matchingProducts, productLimit]
  );

  const hasMoreProducts = filteredProducts.length < matchingProducts.length;

  const handleCreateGoalPlan = useCallback(async () => {
    if (creatingGoal) return;
    if (!goalTitle.trim()) {
      Alert.alert("Goal Title Required", "Please add a label for this incentive goal.");
      return;
    }
    const targetQty = parseIntInput(goalTargetQty);
    if (!targetQty) {
      Alert.alert("Target Quantity Required", "Please enter the goal quantity.");
      return;
    }
    const thresholdPercent = parseAmountInput(goalThresholdPercent);
    const perUnitAmount = parseAmountInput(goalPerUnit);
    if (!perUnitAmount) {
      Alert.alert("Incentive Amount Required", "Please enter the incentive per unit.");
      return;
    }

    setCreatingGoal(true);
    try {
      const created = await addIncentiveGoalPlan({
        title: goalTitle.trim(),
        period: goalPeriod,
        targetQty,
        thresholdPercent,
        perUnitAmount,
        active: true,
      });
      setGoalPlans((current) => [created, ...current]);
      setGoalTitle("");
      setGoalTargetQty("");
      setGoalThresholdPercent("90");
      setGoalPerUnit("");
      if (user) {
        await addAuditLog({
          id: `audit_goal_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: "Incentive Goal Added",
          details: `${created.title} (${created.period}) target ${created.targetQty}`,
          module: "Admin Incentives",
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      setCreatingGoal(false);
    }
  }, [
    creatingGoal,
    goalPeriod,
    goalPerUnit,
    goalTargetQty,
    goalThresholdPercent,
    goalTitle,
    user,
  ]);

  const handleCreateProductPlan = useCallback(async () => {
    if (creatingProduct) return;
    const productName = productQuery.trim();
    if (!productName) {
      Alert.alert("Product Name Required", "Please choose or type a product name.");
      return;
    }
    const perUnitAmount = parseAmountInput(productPerUnit);
    if (!perUnitAmount) {
      Alert.alert("Incentive Amount Required", "Please enter the incentive per unit.");
      return;
    }

    setCreatingProduct(true);
    try {
      const created = await addIncentiveProductPlan({
        productId: selectedProductId || undefined,
        productName,
        perUnitAmount,
        active: true,
      });
      setProductPlans((current) => [created, ...current]);
      setProductQuery("");
      setSelectedProductId(null);
      setProductPerUnit("");
      if (user) {
        await addAuditLog({
          id: `audit_product_incentive_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: user.id,
          userName: user.name,
          action: "Incentive Product Added",
          details: `${created.productName} @ ${created.perUnitAmount}`,
          module: "Admin Incentives",
          timestamp: new Date().toISOString(),
        });
      }
    } finally {
      setCreatingProduct(false);
    }
  }, [creatingProduct, productPerUnit, productQuery, selectedProductId, user]);

  const handleToggleGoalPlan = useCallback(
    async (plan: IncentiveGoalPlan, nextActive: boolean) => {
      const updated = await updateIncentiveGoalPlan(plan.id, { active: nextActive });
      if (!updated) return;
      setGoalPlans((current) =>
        current.map((entry) => (entry.id === plan.id ? updated : entry))
      );
    },
    []
  );

  const handleToggleProductPlan = useCallback(
    async (plan: IncentiveProductPlan, nextActive: boolean) => {
      const updated = await updateIncentiveProductPlan(plan.id, { active: nextActive });
      if (!updated) return;
      setProductPlans((current) =>
        current.map((entry) => (entry.id === plan.id ? updated : entry))
      );
    },
    []
  );

  const handleRemoveGoalPlan = useCallback((plan: IncentiveGoalPlan) => {
    Alert.alert("Remove Plan?", `Remove "${plan.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const removed = await removeIncentiveGoalPlan(plan.id);
          if (removed) {
            setGoalPlans((current) => current.filter((entry) => entry.id !== plan.id));
          }
        },
      },
    ]);
  }, []);

  const handleRemoveProductPlan = useCallback((plan: IncentiveProductPlan) => {
    Alert.alert("Remove Plan?", `Remove "${plan.productName}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          const removed = await removeIncentiveProductPlan(plan.id);
          if (removed) {
            setProductPlans((current) => current.filter((entry) => entry.id !== plan.id));
          }
        },
      },
    ]);
  }, []);

  const handleRecordPayout = useCallback(
    async (row: SalespersonIncentiveRow) => {
      if (payingSalespersonId) return;
      const totalAmount = row.totalAmount;
      if (!totalAmount) return;

      Alert.alert(
        "Record Incentive Payout",
        `Mark ${row.salespersonName} as paid for ${formatCurrency(totalAmount)}?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Mark Paid",
            onPress: async () => {
              setPayingSalespersonId(row.salespersonId);
              try {
                const now = new Date().toISOString();
                const payout: IncentivePayout = {
                  id: `payout_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                  salespersonId: row.salespersonId,
                  salespersonName: row.salespersonName,
                  rangeKey,
                  rangeStart: rangeStartKey,
                  rangeEnd: rangeEndKey,
                  goalAmount: row.goalAmount,
                  productAmount: row.productAmount,
                  totalAmount,
                  createdAt: now,
                  createdById: user?.id,
                  createdByName: user?.name,
                  status: "paid",
                };
                await addIncentivePayout(payout);
                setPayouts((current) => [payout, ...current]);
                if (user) {
                  await addAuditLog({
                    id: `audit_payout_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                    userId: user.id,
                    userName: user.name,
                    action: "Incentive Paid",
                    details: `${row.salespersonName} - ${formatCurrency(totalAmount)}`,
                    module: "Admin Incentives",
                    timestamp: now,
                  });
                }
              } finally {
                setPayingSalespersonId(null);
              }
            },
          },
        ]
      );
    },
    [payingSalespersonId, rangeEndKey, rangeKey, rangeStartKey, user]
  );

  if (!canAccess) {
    return (
      <AppCanvas>
        <Animated.View layout={Layout.springify()} style={{ flex: 1 }}>
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
              <Text
                style={[
                  styles.lockedText,
                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                ]}
              >
                Only admins can configure incentive plans. Contact your administrator for access.
              </Text>
            </View>
          </View>
        </Animated.View>
      </AppCanvas>
    );
  }

  return (
    <AppCanvas>
      <Animated.View layout={Layout.springify()} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
        >
          <View style={styles.navToggleWrap}>
            <DrawerToggleButton />
          </View>

          <Animated.View entering={FadeInDown.duration(280)} style={styles.headerWrap}>
            <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Admin Incentives
            </Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {company?.name ? `${company.name} - ` : ""}{rangeLabel}
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
                  Incentives
                </Text>
                <Text style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  {formatCurrency(totalIncentives)}
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
                        backgroundColor: active ? `${colors.primary}18` : colors.surface,
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

            {loading ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading incentives...</Text>
              </View>
            ) : null}

            {error ? (
              <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
            ) : null}
            {itemLinesLoading ? (
              <Text style={[styles.helperText, { color: colors.textSecondary }]}>Loading item lines...</Text>
            ) : null}
            {itemLinesError ? (
              <Text style={[styles.errorText, { color: colors.danger }]}>{itemLinesError}</Text>
            ) : null}
          </Animated.View>

          <Animated.View
            entering={FadeInDown.duration(320).delay(80)}
            style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
          >
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Goal Incentives
            </Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Set target-based incentives. Incentives start after the threshold percent is met.
            </Text>

            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Goal title</Text>
            <TextInput
              value={goalTitle}
              onChangeText={setGoalTitle}
              placeholder="Monthly primary goal"
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />

            <View style={styles.inputRow}>
              <View style={styles.inputHalf}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Target qty</Text>
                <TextInput
                  value={goalTargetQty}
                  onChangeText={setGoalTargetQty}
                  keyboardType="numeric"
                  placeholder="100"
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                />
              </View>
              <View style={styles.inputHalf}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Threshold %</Text>
                <TextInput
                  value={goalThresholdPercent}
                  onChangeText={setGoalThresholdPercent}
                  keyboardType="numeric"
                  placeholder="90"
                  placeholderTextColor={colors.textTertiary}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                />
              </View>
            </View>

            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Incentive per unit</Text>
            <TextInput
              value={goalPerUnit}
              onChangeText={setGoalPerUnit}
              keyboardType="numeric"
              placeholder="25"
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />

            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Period</Text>
            <View style={styles.chipRow}>
              {RANGE_OPTIONS.map((option) => {
                const active = option.key === goalPeriod;
                return (
                  <Pressable
                    key={option.key}
                    onPress={() => setGoalPeriod(option.key)}
                    style={({ pressed }) => [
                      styles.rangeChip,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active ? `${colors.primary}18` : colors.surface,
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
            </View>

            <Pressable
              disabled={creatingGoal}
              onPress={() => void handleCreateGoalPlan()}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary, opacity: pressed || creatingGoal ? 0.8 : 1 },
              ]}
            >
              {creatingGoal ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="add-circle-outline" size={16} color="#fff" />
              )}
              <Text style={styles.primaryButtonText}>
                {creatingGoal ? "Saving..." : "Add Goal Plan"}
              </Text>
            </Pressable>
          </Animated.View>

          <View style={styles.listWrap}>
            {goalPlans.length === 0 ? (
              <View style={[styles.emptyState, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
              >
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No goal plans yet.</Text>
              </View>
            ) : (
              goalPlans.map((plan) => (
                <View
                  key={plan.id}
                  style={[styles.planCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
                >
                  <View style={styles.planHeader}>
                    <View style={styles.planHeaderText}>
                      <Text style={[styles.planTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {plan.title}
                      </Text>
                      <Text style={[styles.planMeta, { color: colors.textSecondary }]}
                      >
                        {plan.period} - Target {plan.targetQty} - Threshold {plan.thresholdPercent}%
                      </Text>
                    </View>
                    <Switch
                      value={plan.active}
                      onValueChange={(value) => void handleToggleGoalPlan(plan, value)}
                      trackColor={{ false: colors.border, true: colors.primaryLight }}
                      thumbColor={plan.active ? colors.primary : colors.textTertiary}
                    />
                  </View>
                  <View style={styles.planFooter}>
                    <Text style={[styles.planAmount, { color: colors.textSecondary }]}
                    >
                      {formatCurrency(plan.perUnitAmount)} per unit
                    </Text>
                    <Pressable
                      onPress={() => handleRemoveGoalPlan(plan)}
                      style={({ pressed }) => [
                        styles.inlineButton,
                        { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                      ]}
                    >
                      <Ionicons name="trash-outline" size={14} color={colors.textSecondary} />
                      <Text style={[styles.inlineButtonText, { color: colors.textSecondary }]}
                      >
                        Remove
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>

          <Animated.View
            entering={FadeInDown.duration(320).delay(100)}
            style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
          >
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Product Incentives
            </Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
            >
              Boost sales for specific products and reward top performers.
            </Text>

            <View style={styles.dropdownWrap}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Product name</Text>
              <TextInput
                value={productQuery}
                onChangeText={(value) => {
                  setProductQuery(value);
                  setSelectedProductId(null);
                  if (!showProductDropdown) setShowProductDropdown(true);
                }}
                onFocus={() => {
                  cancelDropdownClose();
                  setShowProductDropdown(true);
                  ensureProductsLoaded();
                }}
                onBlur={() => {
                  scheduleDropdownClose();
                }}
                placeholder="Search product from Dolibarr"
                placeholderTextColor={colors.textTertiary}
                style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
              />
              {showProductDropdown ? (
                <View
                  style={[
                    styles.dropdownList,
                    { backgroundColor: colors.surface, borderColor: colors.border },
                  ]}
                >
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
                      onTouchStart={() => {
                        dropdownInteraction.current = true;
                        cancelDropdownClose();
                      }}
                      onTouchEnd={() => {
                        dropdownInteraction.current = false;
                      }}
                      onTouchCancel={() => {
                        dropdownInteraction.current = false;
                      }}
                    >
                      {filteredProducts.map((product) => {
                        const label =
                          product.label?.toString().trim() ||
                          product.ref?.toString().trim() ||
                          "Item";
                        return (
                          <Pressable
                            key={String(product.id || label)}
                            onPressIn={() => {
                              dropdownInteraction.current = true;
                              cancelDropdownClose();
                            }}
                            onPressOut={() => {
                              dropdownInteraction.current = false;
                            }}
                            onPress={() => {
                              setProductQuery(label);
                              setSelectedProductId(product.id ? String(product.id) : null);
                              setShowProductDropdown(false);
                            }}
                            style={({ pressed }) => [
                              styles.dropdownRow,
                              { backgroundColor: pressed ? colors.backgroundTint : "transparent" },
                            ]}
                          >
                            <Text style={[styles.dropdownText, { color: colors.text }]}>{label}</Text>
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

            <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Incentive per unit</Text>
            <TextInput
              value={productPerUnit}
              onChangeText={setProductPerUnit}
              keyboardType="numeric"
              placeholder="15"
              placeholderTextColor={colors.textTertiary}
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            />

            <Pressable
              disabled={creatingProduct}
              onPress={() => void handleCreateProductPlan()}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary, opacity: pressed || creatingProduct ? 0.8 : 1 },
              ]}
            >
              {creatingProduct ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="add-circle-outline" size={16} color="#fff" />
              )}
              <Text style={styles.primaryButtonText}>
                {creatingProduct ? "Saving..." : "Add Product Plan"}
              </Text>
            </Pressable>
          </Animated.View>

          <View style={styles.listWrap}>
            {productPlans.length === 0 ? (
              <View style={[styles.emptyState, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
              >
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No product plans yet.</Text>
              </View>
            ) : (
              productPlans.map((plan) => (
                <View
                  key={plan.id}
                  style={[styles.planCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
                >
                  <View style={styles.planHeader}>
                    <View style={styles.planHeaderText}>
                      <Text style={[styles.planTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                        {plan.productName}
                      </Text>
                      <Text style={[styles.planMeta, { color: colors.textSecondary }]}>
                        Product incentive
                      </Text>
                    </View>
                    <Switch
                      value={plan.active}
                      onValueChange={(value) => void handleToggleProductPlan(plan, value)}
                      trackColor={{ false: colors.border, true: colors.primaryLight }}
                      thumbColor={plan.active ? colors.primary : colors.textTertiary}
                    />
                  </View>
                  <View style={styles.planFooter}>
                    <Text style={[styles.planAmount, { color: colors.textSecondary }]}
                    >
                      {formatCurrency(plan.perUnitAmount)} per unit
                    </Text>
                    <Pressable
                      onPress={() => handleRemoveProductPlan(plan)}
                      style={({ pressed }) => [
                        styles.inlineButton,
                        { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                      ]}
                    >
                      <Ionicons name="trash-outline" size={14} color={colors.textSecondary} />
                      <Text style={[styles.inlineButtonText, { color: colors.textSecondary }]}
                      >
                        Remove
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>

          <Animated.View
            entering={FadeInDown.duration(320).delay(120)}
            style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
          >
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Salesperson Incentives
            </Text>
            <Text style={[styles.sectionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
            >
              Track incentives by salesperson for the selected date range.
            </Text>

            <View style={styles.listWrap}>
              {salespersonRows.length === 0 ? (
                <View style={[styles.emptyState, { backgroundColor: colors.surfaceSecondary, borderColor: colors.border }]}
                >
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No sales yet for this range.</Text>
                </View>
              ) : (
                salespersonRows.map((row) => {
                  const payout = payoutBySalesperson.get(row.salespersonId);
                  const isPaid = payout?.status === "paid";
                  const isPaying = payingSalespersonId === row.salespersonId;

                  return (
                    <View
                      key={row.salespersonId}
                      style={[styles.incentiveCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
                    >
                      <View style={styles.incentiveHeader}>
                        <View style={styles.incentiveHeaderText}>
                          <Text style={[styles.incentiveTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
                          >
                            {row.salespersonName}
                          </Text>
                          <Text style={[styles.incentiveSubtitle, { color: colors.textSecondary }]}
                          >
                            {row.totalOrders} orders - Qty {row.totalQty.toFixed(0)}
                          </Text>
                        </View>
                        {isPaid ? (
                          <View
                            style={[
                              styles.statusBadge,
                              { borderColor: colors.success, backgroundColor: `${colors.success}1A` },
                            ]}
                          >
                            <Ionicons name="checkmark-circle-outline" size={14} color={colors.success} />
                            <Text style={[styles.statusText, { color: colors.success }]}>Paid</Text>
                          </View>
                        ) : row.totalAmount > 0 ? (
                          <Pressable
                            onPress={() => void handleRecordPayout(row)}
                            style={({ pressed }) => [
                              styles.inlineButton,
                              {
                                borderColor: colors.primary,
                                backgroundColor: `${colors.primary}12`,
                                opacity: pressed || isPaying ? 0.7 : 1,
                              },
                            ]}
                          >
                            {isPaying ? (
                              <ActivityIndicator size="small" color={colors.primary} />
                            ) : (
                              <Ionicons name="card-outline" size={14} color={colors.primary} />
                            )}
                            <Text style={[styles.inlineButtonText, { color: colors.primary }]}
                            >
                              {isPaying ? "Paying" : "Record Payout"}
                            </Text>
                          </Pressable>
                        ) : (
                          <View
                            style={[
                              styles.statusBadge,
                              { borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
                            ]}
                          >
                            <Text style={[styles.statusText, { color: colors.textSecondary }]}>No Incentive</Text>
                          </View>
                        )}
                      </View>

                      <View style={styles.metricGrid}>
                        <View style={styles.metricBlock}>
                          <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>Sales Value</Text>
                          <Text style={[styles.metricValue, { color: colors.text }]}> 
                            {formatCurrency(row.totalValue)}
                          </Text>
                        </View>
                        <View style={styles.metricBlock}>
                          <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>Goal</Text>
                          <Text style={[styles.metricValue, { color: colors.text }]}> 
                            {formatCurrency(row.goalAmount)}
                          </Text>
                        </View>
                        <View style={styles.metricBlock}>
                          <Text style={[styles.metricLabel, { color: colors.textSecondary }]}>Product</Text>
                          <Text style={[styles.metricValue, { color: colors.text }]}> 
                            {formatCurrency(row.productAmount)}
                          </Text>
                        </View>
                      </View>

                      <View style={styles.totalRow}>
                        <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total Incentive</Text>
                        <Text style={[styles.totalValue, { color: colors.primary }]}> 
                          {formatCurrency(row.totalAmount)}
                        </Text>
                      </View>
                      {payout?.createdAt ? (
                        <Text style={[styles.payoutMeta, { color: colors.textTertiary }]}
                        >
                          Paid on {new Date(payout.createdAt).toLocaleDateString()}
                        </Text>
                      ) : null}
                    </View>
                  );
                })
              )}
            </View>
          </Animated.View>
        </ScrollView>
      </Animated.View>
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
    flexWrap: "wrap",
    gap: 8,
  },
  rangeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  refreshChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  refreshText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  loadingText: { fontSize: 12 },
  errorText: { fontSize: 12 },
  helperText: { fontSize: 12 },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 10,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
  },
  sectionSubtitle: {
    fontSize: 12,
    lineHeight: 18,
  },
  fieldLabel: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 6,
    fontFamily: "Inter_500Medium",
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
  inputHalf: {
    flex: 1,
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
  dropdownText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  dropdownMeta: {
    fontSize: 11,
    marginTop: 2,
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
    marginBottom: 12,
  },
  planCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  planHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  planHeaderText: {
    flex: 1,
  },
  planTitle: {
    fontSize: 14,
  },
  planMeta: {
    fontSize: 11,
    marginTop: 4,
  },
  planFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  planAmount: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  inlineButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  inlineButtonText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  emptyState: {
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
  },
  emptyText: { fontSize: 13, textAlign: "center" },
  incentiveCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  incentiveHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  incentiveHeaderText: {
    flex: 1,
  },
  incentiveTitle: {
    fontSize: 14,
  },
  incentiveSubtitle: {
    fontSize: 11,
    marginTop: 4,
  },
  statusBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "space-between",
  },
  metricBlock: {
    flex: 1,
    minWidth: 90,
    gap: 4,
  },
  metricLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  metricValue: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  totalLabel: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  totalValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
  },
  payoutMeta: {
    fontSize: 10,
  },
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
