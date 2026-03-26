import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
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
import { getBankAccounts, saveBankAccount, deleteBankAccount, getEmployees } from "@/lib/employee-data";
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

type BankAccountListItem = BankAccount & {
  source: "app" | "dolibarr" | "both";
  removable: boolean;
};

function normalizeText(value: string | null | undefined): string {
  return (value || "").trim();
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

export default function BankAccountsScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  
  const [bankAccounts, setBankAccounts] = useState<BankAccountListItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dolibarrFetchNote, setDolibarrFetchNote] = useState<string | null>(null);

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

  const isAdmin = user?.role === "admin";

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [accounts, emps, dolibarrAccounts] = await Promise.all([
        getBankAccounts(),
        getEmployees(),
        getDolibarrBankAccounts({ limit: 200, sortfield: "tms", sortorder: "desc" }).catch((error) => {
          setDolibarrFetchNote(error instanceof Error ? error.message : "Could not fetch Dolibarr bank accounts.");
          return [];
        }),
      ]);

      const appAccounts = isAdmin
        ? accounts
        : accounts.filter((acc) => acc.employeeEmail === user?.email);
      const mergedAccounts = mergeAccountSources(appAccounts, Array.isArray(dolibarrAccounts) ? dolibarrAccounts : []);

      setBankAccounts(mergedAccounts);
      setEmployees(emps);
      if (Array.isArray(dolibarrAccounts)) {
        setDolibarrFetchNote(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not load bank accounts";
      Alert.alert("Error", message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAddAccount = async () => {
    if (accountType === "bank" && (!bankName || !accountNumber || !ifscCode)) {
      Alert.alert("Error", "Please fill all bank details");
      return;
    }
    if (accountType === "upi" && !upiId) {
      Alert.alert("Error", "Please enter UPI ID");
      return;
    }
    if (isAdmin && !selectedEmployeeId) {
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
      const selectedEmployee = isAdmin 
        ? employees.find(e => e.id === selectedEmployeeId)
        : null;
      const employeeEmail = isAdmin ? (selectedEmployee?.email || "") : (user?.email || "");
      if (!employeeEmail.trim()) {
        Alert.alert("Error", "Selected employee must have an email for Dolibarr sync.");
        return;
      }

      const newAccount: BankAccount = {
        id: Crypto.randomUUID(),
        employeeId: isAdmin ? selectedEmployeeId : user?.id,
        employeeName: isAdmin ? (selectedEmployee?.name || "Unknown") : (user?.name || "Me"),
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
        holderName: holderName || (isAdmin ? selectedEmployee?.name : user?.name) || "",
        isDefault: !bankAccounts.some((entry) => entry.source === "app" || entry.source === "both"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await saveBankAccount(newAccount);
      await loadData();
      setShowAddModal(false);
      resetForm();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (result.dolibarr && !result.dolibarr.ok) {
        Alert.alert(
          "Dolibarr Sync Warning",
          result.dolibarr.message || "Account saved locally, but failed to sync to Dolibarr."
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
  };

  const filteredEmployees = employees.filter(e => 
    e.name.toLowerCase().includes(employeeSearch.toLowerCase()) ||
    e.email.toLowerCase().includes(employeeSearch.toLowerCase())
  ).slice(0, 5);

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
        {item.removable ? (
          <Pressable onPress={() => handleDeleteAccount(item.id)} hitSlop={10}>
            <Ionicons name="trash-outline" size={18} color={colors.danger} />
          </Pressable>
        ) : (
          <Ionicons name="lock-closed-outline" size={16} color={colors.textTertiary} />
        )}
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
        {isAdmin && (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
              {item.source === "dolibarr" ? "Source" : "Employee"}
            </Text>
            <Text style={[styles.detailValue, { color: colors.primary, fontSize: 12 }]}>
              {item.source === "dolibarr" ? "Dolibarr Bank Page" : item.employeeName}
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
            <Text style={[styles.title, { color: colors.text }]}>Bank Accounts</Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Manage your payment methods</Text>
            <Text style={[styles.syncSubtitle, { color: colors.textTertiary }]}>
              App accounts plus Dolibarr bank page accounts
            </Text>
          </View>
          <Pressable 
            onPress={() => setShowAddModal(true)}
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

      {dolibarrFetchNote ? (
        <View style={[styles.fetchNoteCard, { backgroundColor: colors.warning + "10", borderColor: colors.warning + "30" }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warning} />
          <Text style={[styles.fetchNoteText, { color: colors.warning }]}>
            Dolibarr fetch warning: {dolibarrFetchNote}
          </Text>
        </View>
      ) : null}

      {/* Add Modal */}
      <Modal visible={showAddModal} animationType="slide" transparent onRequestClose={() => setShowAddModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Add Bank Account</Text>
              <Pressable onPress={() => setShowAddModal(false)}>
                <Ionicons name="close" size={24} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.modalScroll}>
              {isAdmin && (
                <View style={styles.formGroup}>
                  <Text style={[styles.label, { color: colors.textSecondary }]}>Select Employee</Text>
                  <TextInput
                    style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                    placeholder="Search employee..."
                    placeholderTextColor={colors.textTertiary}
                    value={employeeSearch}
                    onChangeText={setEmployeeSearch}
                  />
                  <View style={styles.employeeChips}>
                    {filteredEmployees.map(emp => (
                      <Pressable 
                        key={emp.id}
                        onPress={() => {
                          setSelectedEmployeeId(emp.id);
                          if (!holderName.trim()) {
                            setHolderName(emp.name);
                          }
                          if (!dolibarrLabel.trim()) {
                            setDolibarrLabel(`${emp.name} Account`);
                          }
                        }}
                        style={[
                          styles.employeeChip, 
                          { 
                            backgroundColor: selectedEmployeeId === emp.id ? colors.primary : colors.surface,
                            borderColor: selectedEmployeeId === emp.id ? colors.primary : colors.border
                          }
                        ]}
                      >
                        <Text style={{ color: selectedEmployeeId === emp.id ? "#FFF" : colors.text, fontSize: 12 }}>{emp.name}</Text>
                      </Pressable>
                    ))}
                  </View>
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
                  <View style={styles.tabRow}>
                    {DOLIBARR_TYPE_OPTIONS.map((option) => (
                      <Pressable
                        key={option.value}
                        onPress={() => setDolibarrType(option.value)}
                        style={[
                          styles.tab,
                          dolibarrType === option.value && { backgroundColor: colors.primary },
                        ]}
                      >
                        <Text style={[styles.tabText, dolibarrType === option.value && { color: "#FFF" }]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
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
                    {(["open", "closed"] as const).map((value) => (
                      <Pressable
                        key={value}
                        onPress={() => setBankStatus(value)}
                        style={[styles.tab, bankStatus === value && { backgroundColor: colors.primary }]}
                      >
                        <Text style={[styles.tabText, bankStatus === value && { color: "#FFF" }]}>
                          {value === "open" ? "Open" : "Closed"}
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
                  <Pressable 
                    onPress={() => setAccountType("bank")}
                    style={[styles.tab, accountType === "bank" && { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.tabText, accountType === "bank" && { color: "#FFF" }]}>Bank Transfer</Text>
                  </Pressable>
                  <Pressable 
                    onPress={() => setAccountType("upi")}
                    style={[styles.tab, accountType === "upi" && { backgroundColor: colors.primary }]}
                  >
                    <Text style={[styles.tabText, accountType === "upi" && { color: "#FFF" }]}>UPI / VPA</Text>
                  </Pressable>
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

            <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom, 20) }]}>
              <Pressable 
                onPress={handleAddAccount}
                disabled={saving}
                style={[styles.saveButton, { backgroundColor: colors.primary }]}
              >
                {saving ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Text style={styles.saveButtonText}>Add Bank Account</Text>
                )}
              </Pressable>
            </View>
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
    paddingTop: 20,
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
    paddingBottom: 20,
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
    paddingTop: 10,
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
  employeeChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  employeeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
});
