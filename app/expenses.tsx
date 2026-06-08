import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import Colors from "@/constants/colors";
import {
  getExpenses,
  addExpense,
  updateExpenseStatus,
  addAuditLog,
  uploadSupportAttachments,
  type LocalSupportAttachmentInput,
} from "@/lib/storage";
import { useAuth } from "@/contexts/AuthContext";
import type { AppUser, Expense, SupportAttachment, SupportAttachmentType } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";

const CATEGORIES = ["Travel", "Meals", "Accommodation", "Office Supplies", "Communication", "Other"];

function todayDateKey(): string {
  return new Date().toISOString().split("T")[0];
}

function parseDecimalInput(value: string): number {
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferProofAttachmentType(mimeType?: string, name?: string): SupportAttachmentType {
  const mime = (mimeType || "").toLowerCase();
  const fileName = (name || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic)$/i.test(fileName)) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || /\.(pdf|docx?|xlsx?|txt)$/i.test(fileName)) return "document";
  return "other";
}

function normalizeMatchKey(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function addExpenseIdentityVariants(target: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeMatchKey(value);
  if (!normalized) return;
  target.add(normalized);
  if (normalized.startsWith("dolibarr_")) {
    target.add(normalized.replace(/^dolibarr_/, ""));
  } else {
    target.add(`dolibarr_${normalized}`);
  }
  const localPart = normalized.includes("@") ? normalized.split("@")[0] : "";
  if (localPart) {
    target.add(localPart);
    target.add(`dolibarr_${localPart}`);
  }
}

function buildUserExpenseKeys(user: AppUser): Set<string> {
  const keys = new Set<string>();
  for (const value of [user.id, user.email, user.login, user.name]) {
    addExpenseIdentityVariants(keys, value);
  }
  return keys;
}

function isExpenseForUser(expense: Expense, user: AppUser): boolean {
  const keys = buildUserExpenseKeys(user);
  return (
    keys.has(normalizeMatchKey(expense.userId)) ||
    keys.has(normalizeMatchKey(expense.userName))
  );
}

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
      {expense.proofUrl || expense.receipt ? (
        <Pressable
          onPress={() => {
            const url = expense.proofUrl || expense.receipt || "";
            if (/^https?:\/\//i.test(url)) Linking.openURL(url).catch(() => undefined);
          }}
          style={styles.proofLink}
        >
          <Ionicons name="document-attach-outline" size={14} color={colors.primary} />
          <Text style={[styles.proofLinkText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
            {expense.proofName || expense.documentName || "Proof attached"}
          </Text>
        </Pressable>
      ) : null}
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
  const [periodStart, setPeriodStart] = useState(todayDateKey());
  const [periodEnd, setPeriodEnd] = useState(todayDateKey());
  const [notePublic, setNotePublic] = useState("");
  const [notePrivate, setNotePrivate] = useState("");
  const [lineDate, setLineDate] = useState(todayDateKey());
  const [projectName, setProjectName] = useState("");
  const [salesTaxRate, setSalesTaxRate] = useState("0");
  const [unitPriceNet, setUnitPriceNet] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [documentName, setDocumentName] = useState("");
  const [proofFile, setProofFile] = useState<LocalSupportAttachmentInput | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

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
        (expense) => isExpenseForUser(expense, user)
      )
    );
  }, [isAdmin, user]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleChooseProof = useCallback(async () => {
    if (isSubmitting) return;
    setSubmitError("");
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets?.[0];
    if (!asset?.uri) return;
    const name = (asset.name || asset.uri.split("/").pop() || "").trim() || "expense-proof";
    const mimeType = (asset.mimeType || "").trim() || undefined;
    setProofFile({
      uri: asset.uri,
      name,
      mimeType,
      sizeBytes: typeof asset.size === "number" ? asset.size : null,
      attachmentType: inferProofAttachmentType(mimeType, name),
    });
    setDocumentName(name);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [isSubmitting]);

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
    if (isSubmitting) return;
    setSubmitError("");
    const unitInclTax = parseDecimalInput(newAmount);
    const qty = parseDecimalInput(quantity) || 1;
    const taxRate = parseDecimalInput(salesTaxRate);
    const netInput = parseDecimalInput(unitPriceNet);
    const resolvedNet = netInput > 0 ? netInput : taxRate > 0 ? unitInclTax / (1 + taxRate / 100) : unitInclTax;
    const totalAmount = unitInclTax * qty;
    if (!newDesc.trim() || unitInclTax <= 0 || qty <= 0) {
      setSubmitError("Description, U.P. (inc. tax), and Qty are required.");
      return;
    }

    setIsSubmitting(true);
    try {
      let uploadedProof: SupportAttachment | null = null;
      if (proofFile) {
        const uploaded = await uploadSupportAttachments([proofFile]);
        uploadedProof = uploaded[0] || null;
      }
      const expense: Expense = {
        id: Crypto.randomUUID(),
        userId: user?.id || "",
        userName: user?.name || "",
        category: newCategory,
        amount: totalAmount,
        description: newDesc.trim(),
        status: "pending",
        date: lineDate || todayDateKey(),
        periodStart: periodStart || lineDate || todayDateKey(),
        periodEnd: periodEnd || periodStart || lineDate || todayDateKey(),
        approverName: "SuperAdmin",
        notePublic: notePublic.trim() || undefined,
        notePrivate: notePrivate.trim() || undefined,
        lineDate: lineDate || todayDateKey(),
        projectName: projectName.trim() || undefined,
        salesTaxRate: taxRate,
        unitPriceNet: resolvedNet,
        unitPriceInclTax: unitInclTax,
        quantity: qty,
        documentName: uploadedProof?.name || documentName.trim() || undefined,
        receipt: uploadedProof?.url || documentName.trim() || undefined,
        proofUrl: uploadedProof?.url,
        proofName: uploadedProof?.name || proofFile?.name,
        proofMimeType: uploadedProof?.mimeType || proofFile?.mimeType,
        proofSizeBytes: uploadedProof?.sizeBytes ?? proofFile?.sizeBytes ?? null,
      };
      await addExpense(expense);
      setNewDesc("");
      setNewAmount("");
      setNewCategory("Travel");
      const today = todayDateKey();
      setPeriodStart(today);
      setPeriodEnd(today);
      setNotePublic("");
      setNotePrivate("");
      setLineDate(today);
      setProjectName("");
      setSalesTaxRate("0");
      setUnitPriceNet("");
      setQuantity("1");
      setDocumentName("");
      setProofFile(null);
      setShowAdd(false);
      await loadData();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to submit expense.";
      setSubmitError(message);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setIsSubmitting(false);
    }
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
            <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalForm} showsVerticalScrollIndicator={false}>
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>User</Text>
                <TextInput
                  style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={user?.name || ""}
                  editable={false}
                />
              </View>
              <View style={styles.twoColumnRow}>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Start date</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textTertiary}
                    value={periodStart}
                    onChangeText={setPeriodStart}
                  />
                </View>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>End date</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textTertiary}
                    value={periodEnd}
                    onChangeText={setPeriodEnd}
                  />
                </View>
              </View>
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Will be approved by</Text>
                <TextInput
                  style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value="SuperAdmin"
                  editable={false}
                />
              </View>
              <View style={styles.twoColumnRow}>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Note (public)</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    value={notePublic}
                    onChangeText={setNotePublic}
                  />
                </View>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Note (private)</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    value={notePrivate}
                    onChangeText={setNotePrivate}
                  />
                </View>
              </View>
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Upload a new document now</Text>
                <View style={styles.proofRow}>
                  <Pressable
                    onPress={handleChooseProof}
                    style={({ pressed }) => [
                      styles.chooseFileButton,
                      { backgroundColor: colors.surfaceSecondary, borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
                    ]}
                  >
                    <Ionicons name="attach-outline" size={18} color={colors.primary} />
                    <Text style={[styles.chooseFileText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>Choose a file</Text>
                  </Pressable>
                  {proofFile ? (
                    <Pressable onPress={() => { setProofFile(null); setDocumentName(""); }} hitSlop={8}>
                      <Ionicons name="close-circle" size={22} color={colors.textTertiary} />
                    </Pressable>
                  ) : null}
                </View>
                <TextInput
                  style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  placeholder="Proof file name"
                  placeholderTextColor={colors.textTertiary}
                  value={documentName}
                  onChangeText={setDocumentName}
                />
              </View>
              <View style={styles.divider} />
              <View style={styles.twoColumnRow}>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Date</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textTertiary}
                    value={lineDate}
                    onChangeText={setLineDate}
                  />
                </View>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Project</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    value={projectName}
                    onChangeText={setProjectName}
                  />
                </View>
              </View>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Type</Text>
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
              <View style={styles.fieldGroup}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Description</Text>
                <TextInput
                  style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                  value={newDesc}
                  onChangeText={setNewDesc}
                />
              </View>
              <View style={styles.twoColumnRow}>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Sales tax</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                    value={salesTaxRate}
                    onChangeText={setSalesTaxRate}
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>Qty</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="1"
                    placeholderTextColor={colors.textTertiary}
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="numeric"
                  />
                </View>
              </View>
              <View style={styles.twoColumnRow}>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>U.P. (net)</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="0"
                    placeholderTextColor={colors.textTertiary}
                    value={unitPriceNet}
                    onChangeText={setUnitPriceNet}
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.flexField}>
                  <Text style={[styles.fieldLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>U.P. (inc. tax)</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: colors.surfaceSecondary, borderColor: colors.border, fontFamily: "Inter_400Regular" }]}
                    placeholder="Amount"
                    placeholderTextColor={colors.textTertiary}
                    value={newAmount}
                    onChangeText={setNewAmount}
                    keyboardType="numeric"
                  />
                </View>
              </View>
              {submitError ? (
                <Text style={[styles.errorText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>{submitError}</Text>
              ) : null}
            </ScrollView>
            <Pressable
              onPress={handleAddExpense}
              disabled={isSubmitting}
              style={({ pressed }) => [styles.modalButton, { backgroundColor: colors.primary, opacity: pressed || isSubmitting ? 0.75 : 1 }]}
            >
              <Text style={styles.modalButtonText}>{isSubmitting ? "Submitting..." : "Submit Expense"}</Text>
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
  proofLink: { flexDirection: "row", alignItems: "center", gap: 6 },
  proofLinkText: { fontSize: 12 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent: { maxHeight: "92%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 16 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalTitle: { fontSize: 18 },
  modalScroll: { maxHeight: 560 },
  modalForm: { gap: 12, paddingBottom: 4 },
  fieldGroup: { gap: 6 },
  fieldLabel: { fontSize: 12 },
  twoColumnRow: { flexDirection: "row", gap: 10 },
  flexField: { flex: 1, gap: 6 },
  modalInput: { height: 48, borderRadius: 12, paddingHorizontal: 16, fontSize: 15, borderWidth: 1 },
  proofRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  chooseFileButton: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  chooseFileText: { fontSize: 13 },
  divider: { height: 1, backgroundColor: "rgba(148,163,184,0.25)", marginVertical: 2 },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  catChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  catText: { fontSize: 12 },
  errorText: { fontSize: 12 },
  modalButton: { height: 48, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  modalButtonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
