import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  Alert,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown, Layout } from "react-native-reanimated";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { getDolibarrBankAccounts, type DolibarrBankAccount } from "@/lib/attendance-api";
import { getBankAccounts, saveBankAccount, deleteBankAccount, getDolibarrEmployees, getEmployees } from "@/lib/employee-data";
import type { BankAccount, Employee } from "@/lib/types";
import * as Crypto from "expo-crypto";

const DOLIBARR_COUNTRY_CODE_TO_ID: Record<string, number> = {
  IN: 117,
};

const DOLIBARR_TYPE_OPTIONS: Array<{
  value: NonNullable<BankAccount["dolibarrType"]>;
  label: string;
}> = [
  { value: "current", label: "Current" },
  { value: "savings", label: "Savings" },
  { value: "cash", label: "Cash" },
];

const ACCOUNT_TYPE_OPTIONS = [
  { value: "bank" as const, label: "Bank Transfer" },
  { value: "upi" as const, label: "UPI / VPA" },
];

const BANK_STATUS_OPTIONS = [
  { value: "open" as const, label: "Open" },
  { value: "closed" as const, label: "Closed" },
];

type BankAccountListItem = BankAccount & {
  source: "app" | "dolibarr" | "both";
  removable: boolean;
};

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
}

function normalizeEmail(value: string | null | undefined): string {
  return normalizeText(value).toLowerCase();
}

function normalizeBankKey(input: {
  bankName?: string;
  accountNumber?: string;
  upiId?: string;
  holderName?: string;
}): string {
  return [
    normalizeText(input.bankName).toLowerCase(),
    normalizeText(input.accountNumber).toLowerCase(),
    normalizeText(input.upiId).toLowerCase(),
    normalizeText(input.holderName).toLowerCase(),
  ].join("|");
}

function pickFirstText(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function pickPositiveInteger(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    const parsed =
      typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return undefined;
}

function mapDolibarrType(value: unknown): NonNullable<BankAccount["dolibarrType"]> {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (parsed === 0) return "savings";
  if (parsed === 2) return "cash";
  return "current";
}

function mapDolibarrBankAccount(entry: DolibarrBankAccount): BankAccountListItem {
  const id =
    pickFirstText(entry.id, entry.rowid) ||
    `dolibarr_bank_${Crypto.randomUUID()}`;
  const bankName = pickFirstText(entry.bank, entry.banque, entry.label) || "Dolibarr Bank Account";
  const accountNumber = pickFirstText(entry.number, entry.account_number, entry.numcompte, entry.iban);
  const holderName = pickFirstText(entry.proprio, entry.owner_name, entry.owner, entry.account_holder);
  const createdAt =
    pickFirstText(entry.date_creation, entry.datec, entry.tms) || new Date().toISOString();
  const updatedAt = pickFirstText(entry.tms, entry.date_creation, entry.datec) || createdAt;
  return {
    id: `dolibarr_${id}`,
    employeeName: holderName || "Dolibarr Account",
    employeeEmail: "",
    accountType: accountNumber && accountNumber.includes("@") ? "upi" : "bank",
    dolibarrRef: pickFirstText(entry.ref),
    dolibarrLabel: pickFirstText(entry.label) || bankName,
    dolibarrType: mapDolibarrType(entry.type),
    currencyCode: pickFirstText(entry.currency_code) || "INR",
    countryId: pickPositiveInteger(entry.country_id),
    countryCode: pickPositiveInteger(entry.country_id) === 117 ? "IN" : undefined,
    status:
      pickFirstText(entry.clos, entry.close, entry.status) === "1"
        ? "closed"
        : "open",
    bankName,
    bankAddress: pickFirstText(entry.address),
    accountNumber: accountNumber && !accountNumber.includes("@") ? accountNumber : undefined,
    upiId: accountNumber && accountNumber.includes("@") ? accountNumber : undefined,
    ifscCode: pickFirstText(entry.bic),
    holderName,
    website: pickFirstText(entry.url),
    comment: pickFirstText(entry.comment),
    isDefault: false,
    createdAt,
    updatedAt,
    source: "dolibarr",
    removable: false,
  };
}

function mergeAccountSources(appAccounts: BankAccount[], dolibarrAccounts: DolibarrBankAccount[]): BankAccountListItem[] {
  const merged = new Map<string, BankAccountListItem>();

  for (const account of appAccounts) {
    const key = normalizeBankKey(account);
    merged.set(key || `app:${account.id}`, {
      ...account,
      source: "app",
      removable: true,
    });
  }

  for (const dolibarrEntry of dolibarrAccounts) {
    const mapped = mapDolibarrBankAccount(dolibarrEntry);
    const key = normalizeBankKey(mapped);
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        source: "both",
      });
      continue;
    }
    merged.set(key || `dolibarr:${mapped.id}`, mapped);
  }

  return Array.from(merged.values()).sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
    const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return (left.bankName || "").localeCompare(right.bankName || "");
  });
}

function getSourceLabel(source: BankAccountListItem["source"]): string {
  if (source === "both") return "App + Dolibarr";
  if (source === "dolibarr") return "Dolibarr";
  return "App";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function loadDolibarrAccountsForBankPage(): Promise<DolibarrBankAccount[]> {
  try {
    return await withTimeout(
      getDolibarrBankAccounts({ limit: 100, sortfield: "tms", sortorder: "desc" }),
      18_000,
      "Dolibarr bank accounts"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!/timed out|timeout|aborted/.test(message)) {
      throw error;
    }
  }

  return withTimeout(
    getDolibarrBankAccounts({ limit: 50 }),
    28_000,
    "Dolibarr bank accounts"
  );
}

function EmployeePickerRow({
  employee,
  selected,
  colors,
  onSelect,
}: {
  employee: Employee;
  selected: boolean;
  colors: ReturnType<typeof useAppTheme>["colors"];
  onSelect: (employee: Employee) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(employee)}
      style={({ pressed }) => [
        styles.employeeRow,
        {
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? colors.primary + "18" : colors.surface,
          opacity: pressed ? 0.86 : 1,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.employeeRowName, { color: colors.text }]}>{employee.name}</Text>
        <Text style={[styles.employeeRowMeta, { color: colors.textSecondary }]}>
          {employee.email || "Email missing"} • {employee.branch}
        </Text>
      </View>
      <Ionicons
        name={selected ? "checkmark-circle" : "ellipse-outline"}
        size={20}
        color={selected ? colors.primary : colors.textTertiary}
      />
    </Pressable>
  );
}

function PickerOptionRow({
  label,
  subtitle,
  selected,
  colors,
  onPress,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  colors: ReturnType<typeof useAppTheme>["colors"];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pickerOptionRow,
        {
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? colors.primary + "16" : colors.surface,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.pickerOptionLabel, { color: colors.text }]}>{label}</Text>
        {subtitle ? (
          <Text style={[styles.pickerOptionSubtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
        ) : null}
      </View>
      <Ionicons
        name={selected ? "checkmark-circle" : "ellipse-outline"}
        size={20}
        color={selected ? colors.primary : colors.textTertiary}
      />
    </Pressable>
  );
}

export default function BankAccountsScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  
  const [bankAccounts, setBankAccounts] = useState<BankAccountListItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [dolibarrEmployees, setDolibarrEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dolibarrFetchNote, setDolibarrFetchNote] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editingAccountCreatedAt, setEditingAccountCreatedAt] = useState<string | null>(null);
  const [editingAccountSource, setEditingAccountSource] = useState<BankAccountListItem["source"] | null>(null);

  // Form State
  const [accountType, setAccountType] = useState<"bank" | "upi">("bank");
  const [dolibarrRef, setDolibarrRef] = useState("");
  const [dolibarrLabel, setDolibarrLabel] = useState("");
  const [dolibarrType, setDolibarrType] = useState<NonNullable<BankAccount["dolibarrType"]>>("current");
  const [currencyCode, setCurrencyCode] = useState("INR");
  const [countryCode, setCountryCode] = useState("IN");
  const [bankStatus, setBankStatus] = useState<NonNullable<BankAccount["status"]>>("open");
  const [bankName, setBankName] = useState("");
  const [bankAddress, setBankAddress] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifscCode, setIfscCode] = useState("");
  const [upiId, setUpiId] = useState("");
  const [holderName, setHolderName] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [activePicker, setActivePicker] = useState<"employee" | "dolibarrType" | null>(null);

  const canManageAllAccounts = ["admin", "hr", "manager"].includes(user?.role || "");
  const isEditing = Boolean(editingAccountId);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [accountsResult, employeesResult, dolibarrEmployeesResult, dolibarrAccountsResult] = await Promise.allSettled([
        withTimeout(getBankAccounts(), 12000, "Bank accounts"),
        withTimeout(getEmployees(), 12000, "Employees"),
        canManageAllAccounts
          ? withTimeout(getDolibarrEmployees(), 12000, "Dolibarr employees")
          : Promise.resolve([]),
        canManageAllAccounts
          ? loadDolibarrAccountsForBankPage()
          : Promise.resolve([]),
      ]);

      const accounts =
        accountsResult.status === "fulfilled" && Array.isArray(accountsResult.value)
          ? accountsResult.value
          : [];
      const emps =
        employeesResult.status === "fulfilled" && Array.isArray(employeesResult.value)
          ? employeesResult.value
          : [];
      const dolibarrEmployeesList =
        dolibarrEmployeesResult.status === "fulfilled" && Array.isArray(dolibarrEmployeesResult.value)
          ? dolibarrEmployeesResult.value
          : [];
      const finalDolibarrAccounts =
        dolibarrAccountsResult.status === "fulfilled" && Array.isArray(dolibarrAccountsResult.value)
          ? dolibarrAccountsResult.value
          : [];

      const appAccounts = canManageAllAccounts
        ? accounts
        : accounts.filter((acc) => {
            const userEmail = normalizeEmail(user?.email);
            const accountEmail = normalizeEmail(acc.employeeEmail);
            const userId = normalizeText(user?.id).toLowerCase();
            const accountId = normalizeText(acc.employeeId).toLowerCase();
            const userName = normalizeText(user?.name).toLowerCase();
            const accountName = normalizeText(acc.employeeName).toLowerCase();
            return Boolean(
              (userEmail && accountEmail === userEmail) ||
              (userId && accountId === userId) ||
              (userName && accountName === userName)
            );
          });
      setBankAccounts(mergeAccountSources(appAccounts, finalDolibarrAccounts));
      setEmployees(emps);
      setDolibarrEmployees(dolibarrEmployeesList);

      const warnings: string[] = [];
      if (accountsResult.status === "rejected") {
        warnings.push(
          accountsResult.reason instanceof Error
            ? accountsResult.reason.message
            : "Could not fetch saved bank accounts."
        );
      }
      if (employeesResult.status === "rejected") {
        warnings.push(
          employeesResult.reason instanceof Error
            ? employeesResult.reason.message
            : "Could not fetch employees."
        );
      }
      if (canManageAllAccounts && dolibarrEmployeesResult.status === "rejected") {
        warnings.push(
          dolibarrEmployeesResult.reason instanceof Error
            ? dolibarrEmployeesResult.reason.message
            : "Could not fetch Dolibarr employees."
        );
      }
      if (canManageAllAccounts && dolibarrAccountsResult.status === "rejected") {
        warnings.push(
          dolibarrAccountsResult.reason instanceof Error
            ? dolibarrAccountsResult.reason.message
            : "Could not fetch Dolibarr bank accounts."
        );
      }
      setDolibarrFetchNote(warnings.length > 0 ? warnings.join(" ") : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load bank accounts";
      setBankAccounts([]);
      setEmployees([]);
      setDolibarrEmployees([]);
      setDolibarrFetchNote(message);
      Alert.alert("Error", message);
    } finally {
      setLoading(false);
    }
  }, [canManageAllAccounts, user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const closeModal = () => {
    setShowAddModal(false);
    resetForm();
  };

  const handleAddAccount = async () => {
    if (accountType === "bank" && (!bankName || !accountNumber || !ifscCode)) {
      Alert.alert("Error", "Please fill all bank details");
      return;
    }
    if (accountType === "upi" && !upiId) {
      Alert.alert("Error", "Please enter UPI ID");
      return;
    }
    if (canManageAllAccounts && !selectedEmployeeId) {
      Alert.alert("Error", "Please select an employee");
      return;
    }
    if (!dolibarrLabel.trim()) {
      Alert.alert("Error", "Please enter the Dolibarr bank label.");
      return;
    }
    const normalizedCurrencyCode = currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalizedCurrencyCode)) {
      Alert.alert("Error", "Currency code should be 3 letters, like INR.");
      return;
    }
    const normalizedCountryCode = countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(normalizedCountryCode)) {
      Alert.alert("Error", "Country code should be 2 or 3 letters, like IN.");
      return;
    }

    setSaving(true);
    try {
      const selectedEmployee = canManageAllAccounts
        ? dolibarrEmployees.find((e) => e.id === selectedEmployeeId) ||
          employees.find((e) => e.id === selectedEmployeeId) ||
          null
        : null;
      const linkedAppEmployee = canManageAllAccounts
        ? employees.find((employee) => {
            const selectedEmail = normalizeEmail(selectedEmployee?.email);
            const employeeEmail = normalizeEmail(employee.email);
            if (selectedEmail && employeeEmail && selectedEmail === employeeEmail) {
              return true;
            }
            return normalizeText(employee.name).toLowerCase() === normalizeText(selectedEmployee?.name).toLowerCase();
          }) || null
        : null;
      const employeeEmail = canManageAllAccounts
        ? (selectedEmployee?.email || linkedAppEmployee?.email || "")
        : (user?.email || "");
      const employeeIdToSave = canManageAllAccounts
        ? (linkedAppEmployee?.id || selectedEmployeeId)
        : user?.id;
      const employeeNameToSave = canManageAllAccounts
        ? (linkedAppEmployee?.name || selectedEmployee?.name || "Unknown")
        : (user?.name || "Me");
      const shouldSyncToDolibarr = !isEditing && Boolean(employeeEmail.trim());

      const newAccount: BankAccount = {
        id: editingAccountId || Crypto.randomUUID(),
        employeeId: employeeIdToSave,
        employeeName: employeeNameToSave,
        employeeEmail,
        accountType,
        dolibarrRef: dolibarrRef.trim() || undefined,
        dolibarrLabel: dolibarrLabel.trim(),
        dolibarrType,
        currencyCode: normalizedCurrencyCode,
        countryCode: normalizedCountryCode,
        countryId: DOLIBARR_COUNTRY_CODE_TO_ID[normalizedCountryCode],
        status: bankStatus,
        bankName: accountType === "bank" ? bankName : "UPI",
        bankAddress: bankAddress.trim() || undefined,
        accountNumber: accountType === "bank" ? accountNumber : undefined,
        ifscCode: accountType === "bank" ? ifscCode : undefined,
        upiId: accountType === "upi" ? upiId : undefined,
        holderName: holderName || employeeNameToSave || "",
        isDefault: isEditing
          ? bankAccounts.find((entry) => entry.id === editingAccountId)?.isDefault ?? false
          : !bankAccounts.some((entry) => entry.source === "app" || entry.source === "both"),
        createdAt: editingAccountCreatedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      let result;
      try {
        result = await saveBankAccount(newAccount, { syncToDolibarr: shouldSyncToDolibarr });
      } catch (syncError) {
        if (isEditing) {
          throw syncError;
        }
        result = await saveBankAccount(newAccount, { syncToDolibarr: false });
        const syncMessage =
          syncError instanceof Error ? syncError.message : "Dolibarr sync failed.";
        Alert.alert(
          "Saved With Warning",
          `Bank detail app me save ho gaya hai, lekin Dolibarr sync nahi hua. ${syncMessage}`
        );
      }

      await loadData();
      closeModal();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (!shouldSyncToDolibarr) {
        Alert.alert(
          "Saved",
          "Bank detail save ho gaya hai. Selected employee ka valid email na hone ki wajah se Dolibarr sync skip kiya gaya."
        );
      } else if (result?.dolibarr && !result.dolibarr.ok) {
        Alert.alert(
          "Dolibarr Sync Warning",
          result.dolibarr.message || "Account saved locally, but failed to sync to Dolibarr."
        );
      } else if (isEditing && editingAccountSource && editingAccountSource !== "app") {
        Alert.alert(
          "Updated",
          "Bank details updated in the app. Dolibarr bank page entry was left unchanged to avoid duplicate bank records."
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save bank account";
      Alert.alert("Error", message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccount = (id: string) => {
    Alert.alert(
      "Delete Account",
      "Are you sure you want to remove this bank account?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive",
          onPress: async () => {
            try {
              await deleteBankAccount(id);
              await loadData();
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (err) {
              Alert.alert("Error", "Could not delete account");
            }
          }
        }
      ]
    );
  };

  const resetForm = () => {
    setEditingAccountId(null);
    setEditingAccountCreatedAt(null);
    setEditingAccountSource(null);
    setAccountType("bank");
    setDolibarrRef("");
    setDolibarrLabel("");
    setDolibarrType("current");
    setCurrencyCode("INR");
    setCountryCode("IN");
    setBankStatus("open");
    setBankName("");
    setBankAddress("");
    setAccountNumber("");
    setIfscCode("");
    setUpiId("");
    setHolderName("");
    setSelectedEmployeeId("");
    setEmployeeSearch("");
    setActivePicker(null);
  };

  const openAddModal = () => {
    resetForm();
    setShowAddModal(true);
  };

  const openEditModal = (account: BankAccountListItem) => {
    const employeeSource = canManageAllAccounts && dolibarrEmployees.length > 0 ? dolibarrEmployees : employees;
    const matchedEmployee =
      employeeSource.find((employee) => employee.id === account.employeeId) ||
      employeeSource.find((employee) => employee.email === account.employeeEmail) ||
      employeeSource.find((employee) => employee.name === account.employeeName) ||
      null;

    setEditingAccountId(account.id);
    setEditingAccountCreatedAt(account.createdAt);
    setEditingAccountSource(account.source);
    setAccountType(account.accountType);
    setDolibarrRef(account.dolibarrRef || "");
    setDolibarrLabel(account.dolibarrLabel || "");
    setDolibarrType(account.dolibarrType || "current");
    setCurrencyCode(account.currencyCode || "INR");
    setCountryCode(account.countryCode || "IN");
    setBankStatus(account.status || "open");
    setBankName(account.bankName || "");
    setBankAddress(account.bankAddress || "");
    setAccountNumber(account.accountNumber || "");
    setIfscCode(account.ifscCode || "");
    setUpiId(account.upiId || "");
    setHolderName(account.holderName || account.employeeName || "");
    setSelectedEmployeeId(canManageAllAccounts ? (matchedEmployee?.id || account.employeeId || "") : "");
    setEmployeeSearch(canManageAllAccounts ? (matchedEmployee?.name || account.employeeName || "") : "");
    setActivePicker(null);
    setShowAddModal(true);
  };

  const employeePickerSource = canManageAllAccounts && dolibarrEmployees.length > 0 ? dolibarrEmployees : employees;

  const filteredEmployees = employeePickerSource.filter(e => 
    e.name.toLowerCase().includes(employeeSearch.toLowerCase()) ||
    e.email.toLowerCase().includes(employeeSearch.toLowerCase())
  ).slice(0, 8);
  const selectedEmployee =
    canManageAllAccounts && selectedEmployeeId
      ? employeePickerSource.find((employee) => employee.id === selectedEmployeeId) ||
        employees.find((employee) => employee.id === selectedEmployeeId) ||
        null
      : null;
  const clearSelectedEmployee = () => {
    setSelectedEmployeeId("");
    setEmployeeSearch("");
  };

  const renderAccount = ({ item }: { item: BankAccountListItem }) => (
    <Animated.View 
      entering={FadeInDown.duration(400)}
      layout={Layout.springify()}
      style={[styles.accountCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
    >
      <View style={styles.accountHeader}>
        <View style={styles.accountBadgeRow}>
          <View style={[styles.typeBadge, { backgroundColor: item.accountType === "bank" ? colors.primary + "15" : colors.success + "15" }]}>
            <Ionicons 
              name={item.accountType === "bank" ? "business-outline" : "qr-code-outline"} 
              size={14} 
              color={item.accountType === "bank" ? colors.primary : colors.success} 
            />
            <Text style={[styles.typeText, { color: item.accountType === "bank" ? colors.primary : colors.success }]}>
              {item.accountType.toUpperCase()}
            </Text>
          </View>
          <View style={[styles.sourceBadge, { backgroundColor: colors.warning + "18" }]}>
            <Text style={[styles.sourceBadgeText, { color: colors.warning }]}>
              {getSourceLabel(item.source)}
            </Text>
          </View>
        </View>
        <View style={[styles.accountStatusPill, { backgroundColor: item.removable ? colors.danger + "12" : colors.surface }]}>
          <Ionicons
            name={item.removable ? "trash-outline" : "lock-closed-outline"}
            size={14}
            color={item.removable ? colors.danger : colors.textTertiary}
          />
          <Text style={[styles.accountStatusPillText, { color: item.removable ? colors.danger : colors.textTertiary }]}>
            {item.removable ? "Can Delete" : "Dolibarr Only"}
          </Text>
        </View>
      </View>

      <Text style={[styles.accountTitle, { color: colors.text }]}>{item.bankName}</Text>
      {(item.dolibarrLabel || item.dolibarrRef || item.currencyCode) ? (
        <View style={styles.metaWrap}>
          {item.dolibarrLabel ? (
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              Label: {item.dolibarrLabel}
            </Text>
          ) : null}
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>
            Ref: {item.dolibarrRef || "Auto"}
          </Text>
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>
            {(item.currencyCode || "INR").toUpperCase()} / {(item.countryCode || "IN").toUpperCase()} / {(item.status || "open").toUpperCase()}
          </Text>
        </View>
      ) : null}
      
      {item.accountType === "bank" ? (
        <View style={styles.detailsRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>Account Number</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>{item.accountNumber}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>IFSC</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>{item.ifscCode}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.detailsRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>UPI ID</Text>
            <Text style={[styles.detailValue, { color: colors.text }]}>{item.upiId}</Text>
          </View>
        </View>
      )}

      <View style={styles.footerRow}>
        <View>
          <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>Holder Name</Text>
          <Text style={[styles.detailValue, { color: colors.text }]}>{item.holderName || item.employeeName || "N/A"}</Text>
        </View>
        {canManageAllAccounts ? (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
              {item.source === "dolibarr" ? "Source" : "Employee"}
            </Text>
            <Text style={[styles.detailValue, { color: colors.primary, fontSize: 12 }]}>
              {item.source === "dolibarr" ? "Dolibarr Bank Page" : item.employeeName}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.accountActionRow} pointerEvents="box-none">
        {item.removable ? (
          <>
            <TouchableOpacity
              onPress={() => openEditModal(item)}
              activeOpacity={0.8}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[styles.editAccountButton, { borderColor: colors.primary, backgroundColor: colors.primary + "10" }]}
            >
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <Text style={[styles.editAccountButtonText, { color: colors.primary }]}>Edit Account</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleDeleteAccount(item.id)}
              activeOpacity={0.8}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={[styles.deleteAccountButton, { borderColor: colors.danger, backgroundColor: colors.danger + "10" }]}
            >
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
              <Text style={[styles.deleteAccountButtonText, { color: colors.danger }]}>Delete Account</Text>
            </TouchableOpacity>
          </>
        ) : (
          <View style={[styles.readOnlyAccountNote, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Ionicons name="information-circle-outline" size={15} color={colors.textTertiary} />
            <Text style={[styles.readOnlyAccountNoteText, { color: colors.textSecondary }]}>
              Delete app-created accounts only
            </Text>
          </View>
        )}
      </View>
    </Animated.View>
  );

  return (
    <AppCanvas>
      <View style={[styles.header, { marginTop: insets.top + 10 }]}>
        <View style={styles.navToggleWrap}>
          <DrawerToggleButton />
        </View>
        <View style={styles.headerTop}>
          <View>
            <Text style={[styles.title, { color: colors.text }]}>
              {canManageAllAccounts ? "Bank Accounts" : "Bank Details"}
            </Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {canManageAllAccounts ? "Manage employee payment methods" : "View and update your payment details"}
            </Text>
            <Text style={[styles.syncSubtitle, { color: colors.textTertiary }]}>
              {canManageAllAccounts ? "App accounts plus Dolibarr bank page accounts" : "Only your own saved bank details are shown here"}
            </Text>
          </View>
          <Pressable 
            onPress={openAddModal}
            style={({ pressed }) => [
              styles.addButton, 
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 }
            ]}
          >
            <Ionicons name="add" size={24} color="#FFF" />
          </Pressable>
        </View>
      </View>

      <FlatList
        data={bankAccounts}
        keyExtractor={item => item.id}
        renderItem={renderAccount}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="card-outline" size={60} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No bank accounts added yet.</Text>
            </View>
          )
        }
      />

      {canManageAllAccounts && dolibarrFetchNote ? (
        <View style={[styles.fetchNoteCard, { backgroundColor: colors.warning + "10", borderColor: colors.warning + "30" }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warning} />
          <Text style={[styles.fetchNoteText, { color: colors.warning }]}>
            Dolibarr fetch warning: {dolibarrFetchNote}
          </Text>
        </View>
      ) : null}

      {/* Add Modal */}
      <Modal visible={showAddModal} animationType="slide" transparent onRequestClose={closeModal}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                {isEditing ? "Edit Bank Details" : canManageAllAccounts ? "Add Bank Account" : "Add Bank Details"}
              </Text>
              <Pressable onPress={closeModal}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll}>
              {canManageAllAccounts && (
                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Select Employee</Text>
                  <Pressable
                    onPress={() => setActivePicker("employee")}
                    style={[styles.pickerTriggerField, { borderColor: colors.border, backgroundColor: colors.surface }]}
                  >
                    <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
                    <View style={styles.pickerTriggerTextWrap}>
                      <Text
                        numberOfLines={1}
                        style={[styles.pickerTriggerValue, { color: employeeSearch ? colors.text : colors.textSecondary }]}
                      >
                        {employeeSearch || "Select employee"}
                      </Text>
                      <Text style={[styles.pickerTriggerHint, { color: colors.textTertiary }]}>Tap to choose employee</Text>
                    </View>
                    <View style={styles.pickerTriggerActions}>
                      {employeeSearch ? (
                        <Pressable
                          hitSlop={8}
                          onPress={clearSelectedEmployee}
                          style={[styles.clearIconButton, { backgroundColor: colors.danger + "14" }]}
                        >
                          <Ionicons name="close" size={14} color={colors.danger} />
                        </Pressable>
                      ) : null}
                      <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                    </View>
                  </Pressable>

                  {selectedEmployee ? (
                    <View style={[styles.selectedEmployeeCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.selectedEmployeeName, { color: colors.text }]}>
                          {selectedEmployee.name}
                        </Text>
                        <Text style={[styles.selectedEmployeeMeta, { color: colors.textSecondary }]}>
                          {selectedEmployee.branch}
                        </Text>
                        <Text style={[styles.selectedEmployeeMeta, { color: colors.textTertiary }]}>
                          {selectedEmployee.email || "No email on profile"}
                        </Text>
                      </View>
                      <View style={styles.selectedEmployeeActions}>
                        <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                        <Pressable
                          hitSlop={8}
                          onPress={clearSelectedEmployee}
                          style={[styles.clearIconButton, { backgroundColor: colors.danger + "14" }]}
                        >
                          <Ionicons name="close" size={14} color={colors.danger} />
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              )}

              <View style={[styles.formSection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Dolibarr Required Details</Text>
                <Text style={[styles.helperText, { color: colors.textSecondary }]}>
                  Ref auto-generate ho jayega agar blank chhodo, baaki fields Dolibarr bank create ke liye required hain.
                </Text>

                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Reference</Text>
                  <TextInput
                    style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                    placeholder="e.g. HDFCMAIN01"
                    placeholderTextColor={colors.textTertiary}
                    value={dolibarrRef}
                    onChangeText={setDolibarrRef}
                    autoCapitalize="characters"
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Bank or Cash Label</Text>
                  <TextInput
                    style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                    placeholder="e.g. Salary Payout Account"
                    placeholderTextColor={colors.textTertiary}
                    value={dolibarrLabel}
                    onChangeText={setDolibarrLabel}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Dolibarr Account Type</Text>
                  <Pressable
                    onPress={() => setActivePicker("dolibarrType")}
                    style={[styles.pickerTriggerField, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
                  >
                    <Ionicons name="swap-vertical-outline" size={16} color={colors.textSecondary} />
                    <View style={styles.pickerTriggerTextWrap}>
                      <Text style={[styles.pickerTriggerValue, { color: colors.text }]}>
                        {DOLIBARR_TYPE_OPTIONS.find((option) => option.value === dolibarrType)?.label || "Current"}
                      </Text>
                      <Text style={[styles.pickerTriggerHint, { color: colors.textTertiary }]}>Tap to choose account type</Text>
                    </View>
                    <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                  </Pressable>
                </View>

                <View style={styles.twoColumnRow}>
                  <View style={[styles.formGroup, styles.fieldHalf]}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>Currency</Text>
                    <TextInput
                      style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                      placeholder="INR"
                      placeholderTextColor={colors.textTertiary}
                      value={currencyCode}
                      onChangeText={(value) => setCurrencyCode(value.toUpperCase())}
                      autoCapitalize="characters"
                      maxLength={3}
                    />
                  </View>
                  <View style={[styles.formGroup, styles.fieldHalf]}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>Account Country</Text>
                    <TextInput
                      style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                      placeholder="IN"
                      placeholderTextColor={colors.textTertiary}
                      value={countryCode}
                      onChangeText={(value) => setCountryCode(value.toUpperCase())}
                      autoCapitalize="characters"
                      maxLength={3}
                    />
                  </View>
                </View>

                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Status</Text>
                  <View style={styles.tabRow}>
                    {BANK_STATUS_OPTIONS.map((option) => (
                      <Pressable
                        key={option.value}
                        onPress={() => setBankStatus(option.value)}
                        style={[styles.tab, bankStatus === option.value && { backgroundColor: colors.primary }]}
                      >
                        <Text style={[styles.tabText, bankStatus === option.value && { color: "#FFF" }]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>

              <View style={[styles.formSection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Payment Details</Text>

              <View style={styles.formGroup}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Account Type</Text>
                <View style={styles.tabRow}>
                  {ACCOUNT_TYPE_OPTIONS.map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() => setAccountType(option.value)}
                      style={[styles.tab, accountType === option.value && { backgroundColor: colors.primary }]}
                    >
                      <Text style={[styles.tabText, accountType === option.value && { color: "#FFF" }]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {accountType === "bank" ? (
                <>
                  <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>Bank Name</Text>
                    <TextInput
                      style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                      placeholder="e.g. HDFC Bank"
                      placeholderTextColor={colors.textTertiary}
                      value={bankName}
                      onChangeText={setBankName}
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>Account Number</Text>
                    <TextInput
                      style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                      placeholder="Enter account number"
                      placeholderTextColor={colors.textTertiary}
                      value={accountNumber}
                      onChangeText={setAccountNumber}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>IFSC Code</Text>
                    <TextInput
                      style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                      placeholder="e.g. HDFC0001234"
                      placeholderTextColor={colors.textTertiary}
                      value={ifscCode}
                      onChangeText={setIfscCode}
                      autoCapitalize="characters"
                    />
                  </View>
                  <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: colors.textSecondary }]}>Bank Address</Text>
                    <TextInput
                      style={[styles.input, styles.textArea, { borderColor: colors.border, color: colors.text }]}
                      placeholder="Branch address for Dolibarr bank record"
                      placeholderTextColor={colors.textTertiary}
                      value={bankAddress}
                      onChangeText={setBankAddress}
                      multiline
                      textAlignVertical="top"
                    />
                  </View>
                </>
              ) : (
                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>UPI ID (VPA)</Text>
                  <TextInput
                    style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                    placeholder="e.g. user@okaxis"
                    placeholderTextColor={colors.textTertiary}
                    value={upiId}
                    onChangeText={setUpiId}
                    autoCapitalize="none"
                  />
                </View>
              )}

              <View style={styles.formGroup}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Account Holder Name</Text>
                <TextInput
                  style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                  placeholder="Name as per bank records"
                  placeholderTextColor={colors.textTertiary}
                  value={holderName}
                  onChangeText={setHolderName}
                />
              </View>
              </View>
            </ScrollView>

            <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom - 6, 0) }]}>
              <Pressable 
                onPress={handleAddAccount}
                disabled={saving}
                style={[styles.saveButton, { backgroundColor: colors.primary, opacity: saving ? 0.7 : 1 }]}
              >
                {saving ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Text style={styles.saveButtonText}>
                    {isEditing ? "Save Changes" : canManageAllAccounts ? "Add Bank Account" : "Save Bank Details"}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={activePicker === "employee"}
        transparent
        animationType="slide"
        onRequestClose={() => setActivePicker(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.pickerSheetCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={[styles.pickerSheetHandle, { backgroundColor: colors.border }]} />
            <View style={[styles.pickerSheetHeader, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.pickerSheetTitle, { color: colors.text }]}>Select Employee</Text>
                <Text style={[styles.pickerSheetSubtitle, { color: colors.textSecondary }]}>Choose an employee from your list</Text>
              </View>
              <Pressable onPress={() => setActivePicker(null)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.pickerSheetBody}>
              <TextInput
                style={[styles.pickerSearchInput, { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface }]}
                placeholder="Search employee..."
                placeholderTextColor={colors.textTertiary}
                value={employeeSearch}
                onChangeText={setEmployeeSearch}
              />
              <ScrollView style={styles.pickerListScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.pickerListContent}>
                {employeePickerSource.length === 0 ? (
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>No employees found.</Text>
                ) : filteredEmployees.length === 0 ? (
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>No employee matched your search.</Text>
                ) : (
                  filteredEmployees.map((emp) => (
                    <EmployeePickerRow
                      key={emp.id}
                      employee={emp}
                      selected={selectedEmployeeId === emp.id}
                      colors={colors}
                      onSelect={(selected) => {
                        setSelectedEmployeeId(selected.id);
                        setEmployeeSearch(selected.name);
                        setActivePicker(null);
                        if (!holderName.trim()) {
                          setHolderName(selected.name);
                        }
                        if (!dolibarrLabel.trim()) {
                          setDolibarrLabel(`${selected.name} Account`);
                        }
                      }}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={activePicker === "dolibarrType"}
        transparent
        animationType="slide"
        onRequestClose={() => setActivePicker(null)}
      >
        <View style={styles.modalOverlay}>
          <View
            style={[
              styles.optionSheetCard,
              {
                backgroundColor: colors.backgroundElevated,
                borderColor: colors.border,
                paddingBottom: Math.max(insets.bottom - 6, 0),
              },
            ]}
          >
            <View style={[styles.pickerSheetHandle, { backgroundColor: colors.border }]} />
            <View style={[styles.pickerSheetHeader, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.pickerSheetTitle, { color: colors.text }]}>Select Dolibarr Type</Text>
                <Text style={[styles.pickerSheetSubtitle, { color: colors.textSecondary }]}>Choose how this account should be created</Text>
              </View>
              <Pressable onPress={() => setActivePicker(null)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            <ScrollView
              style={styles.optionSheetScroll}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pickerSheetContent}
            >
              {DOLIBARR_TYPE_OPTIONS.map((option) => (
                <PickerOptionRow
                  key={option.value}
                  label={option.label}
                  selected={dolibarrType === option.value}
                  colors={colors}
                  onPress={() => {
                    setDolibarrType(option.value);
                    setActivePicker(null);
                  }}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 8,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  syncSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 16,
  },
  accountCard: {
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  accountHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  accountBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  typeBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 6,
  },
  typeText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  sourceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
  },
  sourceBadgeText: {
    fontSize: 10.5,
    fontFamily: "Inter_700Bold",
  },
  accountStatusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  accountStatusPillText: {
    fontSize: 10.5,
    fontFamily: "Inter_700Bold",
  },
  accountTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 10,
  },
  metaWrap: {
    gap: 4,
    marginBottom: 16,
  },
  metaText: {
    fontSize: 11.5,
    fontFamily: "Inter_400Regular",
  },
  detailsRow: {
    flexDirection: "row",
    marginBottom: 16,
    gap: 20,
  },
  detailLabel: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.05)",
  },
  accountActionRow: {
    marginTop: 12,
    flexDirection: "row",
    gap: 10,
  },
  editAccountButton: {
    minHeight: 42,
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  editAccountButtonText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  deleteAccountButton: {
    minHeight: 42,
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  deleteAccountButtonText: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
  },
  readOnlyAccountNote: {
    minHeight: 42,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 14,
  },
  readOnlyAccountNoteText: {
    fontSize: 12.5,
    fontFamily: "Inter_500Medium",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 80,
    gap: 16,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  fetchNoteCard: {
    marginHorizontal: 20,
    marginTop: 12,
    marginBottom: 4,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  fetchNoteText: {
    flex: 1,
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalCard: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    height: "85%",
    paddingTop: 12,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  modalScroll: {
    paddingHorizontal: 20,
    paddingBottom: 0,
  },
  formSection: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    marginBottom: 6,
  },
  helperText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
    marginBottom: 14,
  },
  formGroup: {
    marginBottom: 18,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  textArea: {
    minHeight: 88,
  },
  twoColumnRow: {
    flexDirection: "row",
    gap: 12,
  },
  fieldHalf: {
    flex: 1,
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.05)",
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 8,
  },
  tabText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#666",
  },
  modalFooter: {
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  saveButton: {
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  saveButtonText: {
    color: "#FFF",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  pickerTriggerField: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerTriggerTextWrap: {
    flex: 1,
  },
  pickerTriggerValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  pickerTriggerHint: {
    fontSize: 11.5,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  pickerTriggerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  clearIconButton: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyPickerText: {
    paddingHorizontal: 14,
    paddingVertical: 16,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.06)",
  },
  employeeRowName: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 2,
  },
  employeeRowMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  selectedEmployeeCard: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  selectedEmployeeName: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    marginBottom: 4,
  },
  selectedEmployeeMeta: {
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  selectedEmployeeActions: {
    alignItems: "center",
    gap: 10,
  },
  pickerSheetCard: {
    maxHeight: "72%",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    overflow: "hidden",
  },
  optionSheetCard: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    overflow: "hidden",
    maxHeight: "38%",
  },
  pickerSheetHandle: {
    width: 42,
    height: 5,
    borderRadius: 999,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 4,
    opacity: 0.7,
  },
  pickerSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerSheetTitle: {
    fontSize: 19,
    fontFamily: "Inter_700Bold",
  },
  pickerSheetSubtitle: {
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  pickerSheetBody: {
    padding: 16,
    gap: 12,
    maxHeight: 380,
  },
  pickerSearchInput: {
    borderWidth: 1,
    borderRadius: 16,
    minHeight: 50,
    paddingHorizontal: 14,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  pickerListScroll: {
    maxHeight: 280,
  },
  pickerListContent: {
    gap: 10,
    paddingBottom: 4,
  },
  optionSheetScroll: {
    maxHeight: 320,
  },
  pickerSheetContent: {
    padding: 16,
    gap: 10,
    paddingBottom: 4,
  },
  pickerOptionRow: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  pickerOptionLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  pickerOptionSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
