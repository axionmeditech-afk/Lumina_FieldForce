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
import { getBankAccounts, saveBankAccount, deleteBankAccount, getEmployees } from "@/lib/employee-data";
import type { BankAccount, Employee } from "@/lib/types";
import * as Crypto from "expo-crypto";

export default function BankAccountsScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form State
  const [accountType, setAccountType] = useState<"bank" | "upi">("bank");
  const [bankName, setBankName] = useState("");
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
      const [accounts, emps] = await Promise.all([
        getBankAccounts(),
        getEmployees(),
      ]);
      
      if (isAdmin) {
        setBankAccounts(accounts);
      } else {
        setBankAccounts(accounts.filter(acc => acc.employeeEmail === user?.email));
      }
      setEmployees(emps);
    } catch (err) {
      Alert.alert("Error", "Could not load bank accounts");
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

    setSaving(true);
    try {
      const selectedEmployee = isAdmin 
        ? employees.find(e => e.id === selectedEmployeeId)
        : null;

      const newAccount: BankAccount = {
        id: Crypto.randomUUID(),
        employeeId: isAdmin ? selectedEmployeeId : user?.id,
        employeeName: isAdmin ? (selectedEmployee?.name || "Unknown") : (user?.name || "Me"),
        employeeEmail: isAdmin ? (selectedEmployee?.email || "") : (user?.email || ""),
        accountType,
        bankName: accountType === "bank" ? bankName : "UPI",
        accountNumber: accountType === "bank" ? accountNumber : undefined,
        ifscCode: accountType === "bank" ? ifscCode : undefined,
        upiId: accountType === "upi" ? upiId : undefined,
        holderName: holderName || (isAdmin ? selectedEmployee?.name : user?.name) || "",
        isDefault: bankAccounts.length === 0,
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
      Alert.alert("Error", "Could not save bank account");
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
    setBankName("");
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

  const renderAccount = ({ item }: { item: BankAccount }) => (
    <Animated.View 
      entering={FadeInDown.duration(400)}
      layout={Layout.springify()}
      style={[styles.accountCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
    >
      <View style={styles.accountHeader}>
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
        <Pressable onPress={() => handleDeleteAccount(item.id)} hitSlop={10}>
          <Ionicons name="trash-outline" size={18} color={colors.danger} />
        </Pressable>
      </View>

      <Text style={[styles.accountTitle, { color: colors.text }]}>{item.bankName}</Text>
      
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
          <Text style={[styles.detailValue, { color: colors.text }]}>{item.holderName}</Text>
        </View>
        {isAdmin && (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>Employee</Text>
            <Text style={[styles.detailValue, { color: colors.primary, fontSize: 12 }]}>{item.employeeName}</Text>
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
                        onPress={() => setSelectedEmployeeId(emp.id)}
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
  accountTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 16,
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
