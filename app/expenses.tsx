import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import Colors from "@/constants/colors";
import { getExpenses, addExpense, updateExpenseStatus, addAuditLog } from "@/lib/storage";
import { useAuth } from "@/contexts/AuthContext";
import type { Expense } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";

const CATEGORIES = ["Travel", "Meals", "Accommodation", "Office Supplies", "Communication", "Other"];

function ExpenseCard({
  expense,
  colors,
  isAdmin,
  onApprove,
  onReject,
}: {
  expense: Expense;
  colors: typeof Colors.light;
  isAdmin: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const statusColor =
    expense.status === "approved" ? colors.success :
    expense.status === "rejected" ? colors.danger : colors.warning;

  const categoryIcon: Record<string, string> = {
    Travel: "airplane-outline",
    Meals: "restaurant-outline",
    Accommodation: "bed-outline",
    "Office Supplies": "document-outline",
    Communication: "call-outline",
    Other: "ellipsis-horizontal-outline",
  };

  return (
    <View style={[styles.expenseCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={styles.expenseHeader}>
        <View style={[styles.categoryIcon, { backgroundColor: colors.primary + "15" }]}>
          <Ionicons name={(categoryIcon[expense.category] || "receipt-outline") as any} size={18} color={colors.primary} />
        </View>
        <View style={styles.expenseInfo}>
          <Text style={[styles.expenseDesc, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
            {expense.description}
          </Text>
          <Text style={[styles.expenseMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {expense.userName} - {expense.category}
          </Text>
        </View>
        <View style={styles.expenseRight}>
          <Text style={[styles.expenseAmount, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            INR {expense.amount.toLocaleString()}
          </Text>
          <View style={[styles.statusChip, { backgroundColor: statusColor + "15" }]}>
            <Text style={[styles.statusText, { color: statusColor, fontFamily: "Inter_500Medium" }]}>
              {expense.status}
            </Text>
          </View>
        </View>
      </View>

      {isAdmin && expense.status === "pending" && (
        <View style={styles.actionRow}>
          <Pressable
            onPress={() => onApprove(expense.id)}
            style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.success + "15", opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="checkmark" size={16} color={colors.success} />
            <Text style={[styles.actionText, { color: colors.success, fontFamily: "Inter_500Medium" }]}>Approve</Text>
          </Pressable>
          <Pressable
            onPress={() => onReject(expense.id)}
            style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.danger + "15", opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="close" size={16} color={colors.danger} />
            <Text style={[styles.actionText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>Reject</Text>
          </Pressable>
        </View>
      )}

      <Text style={[styles.expenseDate, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
        {new Date(expense.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
      </Text>
    </View>
  );
}

export default function ExpensesScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newCategory, setNewCategory] = useState("Travel");

  const isAdmin = user?.role === "admin";

  const loadData = useCallback(async () => {
    const data = await getExpenses();
    if (!user) {
      setExpenses([]);
      return;
    }
    if (isAdmin) {
      setExpenses(data);
      return;
    }
    setExpenses(
      data.filter(
        (expense) => expense.userId === user.id || expense.userName === user.name
      )
    );
  }, [isAdmin, user]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleApprove = async (id: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await updateExpenseStatus(id, "approved");
    const exp = expenses.find((e) => e.id === id);
    await addAuditLog({
      id: Crypto.randomUUID(),
      userId: user?.id || "",
      userName: user?.name || "",
      action: "Expense Approved",
      details: `Approved expense: ${exp?.description} - INR ${exp?.amount}`,
      timestamp: new Date().toISOString(),
      module: "Expenses",
    });
    await loadData();
  };

  const handleReject = async (id: string) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    await updateExpenseStatus(id, "rejected");
    await loadData();
  };

  const handleAddExpense = async () => {
    if (!newDesc.trim() || !newAmount.trim()) return;
    const expense: Expense = {
      id: Crypto.randomUUID(),
      userId: user?.id || "",
      userName: user?.name || "",
      category: newCategory,
      amount: parseFloat(newAmount) || 0,
      description: newDesc.trim(),
      status: "pending",
      date: new Date().toISOString().split("T")[0],
    };
    await addExpense(expense);
    setNewDesc("");
    setNewAmount("");
    setShowAdd(false);
    await loadData();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const totalPending = expenses.filter((e) => e.status === "pending").reduce((s, e) => s + e.amount, 0);
  const totalApproved = expenses.filter((e) => e.status === "approved").reduce((s, e) => s + e.amount, 0);

  return (
    <AppCanvas>
      <FlatList
        data={expenses}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <>
            <View style={styles.headerRow}>
              <Pressable onPress={() => router.back()} hitSlop={12}>
                <Ionicons name="arrow-back" size={24} color={colors.text} />
              </Pressable>
              <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Expenses</Text>
              <Pressable onPress={() => setShowAdd(true)} hitSlop={12}>
                <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
              </Pressable>
            </View>
            <View style={styles.summaryRow}>
              <View style={[styles.summaryCard, { backgroundColor: colors.warning + "15" }]}>
                <Text style={[styles.summaryLabel, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>Pending</Text>
                <Text style={[styles.summaryValue, { color: colors.warning, fontFamily: "Inter_700Bold" }]}>
                  INR {totalPending.toLocaleString()}
                </Text>
              </View>
              <View style={[styles.summaryCard, { backgroundColor: colors.success + "15" }]}>
                <Text style={[styles.summaryLabel, { color: colors.success, fontFamily: "Inter_500Medium" }]}>Approved</Text>
                <Text style={[styles.summaryValue, { color: colors.success, fontFamily: "Inter_700Bold" }]}>
                  INR {totalApproved.toLocaleString()}
                </Text>
              </View>
            </View>
          </>
        }
        renderItem={({ item }) => (
          <ExpenseCard
            expense={item}
            colors={colors}
            isAdmin={!!isAdmin}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="receipt-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>No expenses</Text>
          </View>
        }
      />

      <Modal visible={showAdd} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.backgroundElevated }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>New Expense</Text>
              <Pressable onPress={() => setShowAdd(false)} hitSlop={8}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>
            <TextInput
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
              placeholder="Description"
              placeholderTextColor={colors.textTertiary}
              value={newDesc}
              onChangeText={setNewDesc}
            />
            <TextInput
              style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
              placeholder="Amount (INR)"
              placeholderTextColor={colors.textTertiary}
              value={newAmount}
              onChangeText={setNewAmount}
              keyboardType="numeric"
            />
            <View style={styles.categoryRow}>
              {CATEGORIES.map((cat) => (
                <Pressable
                  key={cat}
                  onPress={() => setNewCategory(cat)}
                  style={[
                    styles.catChip,
                    {
                      backgroundColor: newCategory === cat ? colors.primary : colors.surfaceSecondary,
                      borderColor: newCategory === cat ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.catText, { color: newCategory === cat ? "#fff" : colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                    {cat}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={handleAddExpense}
              style={({ pressed }) => [styles.modalButton, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={styles.modalButtonText}>Submit Expense</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  summaryRow: { flexDirection: "row", gap: 12, marginBottom: 16 },
  summaryCard: { flex: 1, borderRadius: 14, padding: 14, gap: 4 },
  summaryLabel: { fontSize: 12 },
  summaryValue: { fontSize: 18 },
  expenseCard: { 
    borderRadius: 24,
    padding: 20, 
    gap: 12,
    borderWidth: 1,
    boxShadow: "0px 10px 26px rgba(10, 35, 62, 0.12)",
  },
  expenseHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  categoryIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  expenseInfo: { flex: 1, gap: 2 },
  expenseDesc: { fontSize: 14 },
  expenseMeta: { fontSize: 12 },
  expenseRight: { alignItems: "flex-end", gap: 4 },
  expenseAmount: { fontSize: 14 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: { fontSize: 10, textTransform: "capitalize" as const },
  actionRow: { flexDirection: "row", gap: 10 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    gap: 6,
  },
  actionText: { fontSize: 12 },
  expenseDate: { fontSize: 11 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 16 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18 },
  modalInput: { height: 48, borderRadius: 12, paddingHorizontal: 16, fontSize: 15, borderWidth: 1 },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  catChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  catText: { fontSize: 12 },
  modalButton: { height: 48, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  modalButtonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
