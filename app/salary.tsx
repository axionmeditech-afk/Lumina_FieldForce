import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import Colors from "@/constants/colors";
import { addAuditLog, getIncentivePayouts } from "@/lib/storage";
import {
  deleteSalaryRecord,
  getBankAccounts,
  getDolibarrEmployees,
  getEmployees,
  getSalaries,
  saveSalaryRecord,
  updateSalaryRecordStatus,
} from "@/lib/employee-data";
import { getDolibarrBankAccounts, type DolibarrBankAccount } from "@/lib/attendance-api";
import type { BankAccount, Employee, IncentivePayout, SalaryRecord } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { CalendarModal } from "@/components/CalendarModal";
import { useAuth } from "@/contexts/AuthContext";
import * as Crypto from "expo-crypto";
import * as Print from "expo-print";

function formatMonthLabel(monthKey: string): string {
  return new Date(`${monthKey}-01`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function formatPeriodLabel(start?: string, end?: string): string | null {
  const cleanStart = (start || "").trim();
  const cleanEnd = (end || "").trim();
  if (!cleanStart && !cleanEnd) return null;
  if (cleanStart && cleanEnd) return `${cleanStart} - ${cleanEnd}`;
  return cleanStart || cleanEnd;
}

function formatCurrency(value: number): string {
  return `INR ${value.toLocaleString()}`;
}

function formatBankAccountOption(account: BankAccount): string {
  return `${account.bankName || "UPI"} - ${account.accountNumber || account.upiId || ""}`;
}

function normalizeBankKey(input: {
  bankName?: string;
  accountNumber?: string;
  upiId?: string;
  holderName?: string;
}): string {
  return [
    (input.bankName || "").trim().toLowerCase(),
    (input.accountNumber || "").trim().toLowerCase(),
    (input.upiId || "").trim().toLowerCase(),
    (input.holderName || "").trim().toLowerCase(),
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

function mapDolibarrBankAccount(entry: DolibarrBankAccount): BankAccount {
  const id = pickFirstText(entry.id, entry.rowid) || `dolibarr_bank_${Crypto.randomUUID()}`;
  const bankName = pickFirstText(entry.bank, entry.banque, entry.label) || "Dolibarr Bank Account";
  const accountNumber = pickFirstText(entry.number, entry.account_number, entry.numcompte, entry.iban);
  const holderName = pickFirstText(entry.proprio, entry.owner_name, entry.owner, entry.account_holder);
  const createdAt = pickFirstText(entry.date_creation, entry.datec, entry.tms) || new Date().toISOString();
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
    status: pickFirstText(entry.clos, entry.close, entry.status) === "1" ? "closed" : "open",
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
  };
}

function mergeAccountSources(appAccounts: BankAccount[], dolibarrAccounts: DolibarrBankAccount[]): BankAccount[] {
  const merged = new Map<string, BankAccount>();
  for (const account of appAccounts) {
    const key = normalizeBankKey(account);
    merged.set(key || `app:${account.id}`, account);
  }
  for (const dolibarrEntry of dolibarrAccounts) {
    const mapped = mapDolibarrBankAccount(dolibarrEntry);
    const key = normalizeBankKey(mapped);
    if (!merged.has(key)) {
      merged.set(key || `dolibarr:${mapped.id}`, mapped);
    }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadDolibarrAccountsForSalaryPicker(): Promise<DolibarrBankAccount[]> {
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildEmployeeBankMatchKeys(input: {
  employeeId?: string;
  employeeName?: string;
  employeeEmail?: string;
}): Set<string> {
  const keys = new Set<string>();
  const add = (value?: string) => {
    const normalized = normalizeKey(value || "");
    if (!normalized) return;
    keys.add(normalized);
    if (normalized.startsWith("dolibarr_")) {
      keys.add(normalized.replace("dolibarr_", ""));
    } else {
      keys.add(`dolibarr_${normalized}`);
    }
  };

  add(input.employeeId);
  add(input.employeeName);
  add(input.employeeEmail);
  return keys;
}

function matchesBankAccountToEmployee(
  account: BankAccount,
  input: {
    employeeId?: string;
    employeeName?: string;
    employeeEmail?: string;
  }
): boolean {
  const employeeKeys = buildEmployeeBankMatchKeys(input);
  if (!employeeKeys.size) return false;

  const accountKeys = buildEmployeeBankMatchKeys({
    employeeId: account.employeeId,
    employeeName: account.employeeName,
    employeeEmail: account.employeeEmail,
  });

  for (const key of accountKeys) {
    if (employeeKeys.has(key)) return true;
  }
  return false;
}

function isDolibarrEmployee(employee: Employee): boolean {
  return employee.id.trim().toLowerCase().startsWith("dolibarr_");
}

function hasSyncableEmployeeEmail(value?: string): boolean {
  const email = (value || "").trim().toLowerCase();
  return Boolean(email) && email.includes("@") && !email.endsWith("@dolibarr.local");
}

function parseDateOnly(value?: string): Date | null {
  const clean = (value || "").trim();
  if (!clean) return null;
  const date = new Date(`${clean}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getMonthRange(monthKey: string): { start: Date; end: Date } {
  const start = new Date(`${monthKey}-01T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    const fallback = new Date();
    fallback.setDate(1);
    fallback.setHours(0, 0, 0, 0);
    const end = new Date(fallback);
    end.setMonth(end.getMonth() + 1);
    end.setDate(0);
    end.setHours(23, 59, 59, 999);
    return { start: fallback, end };
  }
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setDate(0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getSalaryRange(salary: SalaryRecord): { start: Date; end: Date } {
  const monthRange = getMonthRange(salary.month);
  const start = parseDateOnly(salary.periodStart) || monthRange.start;
  const end = parseDateOnly(salary.periodEnd) || monthRange.end;
  if (end < start) return { start: end, end: start };
  return { start, end };
}

function buildMatchKeys(id: string, name: string): Set<string> {
  const keys = new Set<string>();
  const cleanId = id.trim();
  if (cleanId) {
    keys.add(cleanId);
    if (cleanId.startsWith("dolibarr_")) {
      keys.add(cleanId.replace("dolibarr_", ""));
    } else {
      keys.add(`dolibarr_${cleanId}`);
    }
  }
  const nameKey = normalizeKey(name);
  if (nameKey) keys.add(nameKey);
  return keys;
}

type IncentiveSummary = {
  total: number;
  goal: number;
  product: number;
  payouts: IncentivePayout[];
};

function parseAmountInput(value: string): number {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(parsed, 0);
}

function getDefaultMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function getSalarySlipNumber(salary: SalaryRecord): string {
  const monthPart = salary.month.replace("-", "");
  const employeePart = salary.employeeId.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase() || "EMP";
  return `SLIP-${monthPart}-${employeePart}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSalarySlipHtml(input: {
  salary: SalaryRecord;
  incentives?: IncentiveSummary;
  companyName: string;
  generatedBy: string;
  generatedAtISO: string;
}): string {
  const monthLabel = formatMonthLabel(input.salary.month);
  const slipNumber = getSalarySlipNumber(input.salary);
  const incentiveTotal = input.incentives?.total || 0;
  const grossWithIncentives = input.salary.grossPay + incentiveTotal;
  const netWithIncentives = input.salary.netPay + incentiveTotal;
  const row = (label: string, value: number, weight: "normal" | "bold" = "normal") =>
    `<tr><td style="padding:8px 0;color:#475569;font-weight:${weight};">${escapeHtml(label)}</td><td style="padding:8px 0;text-align:right;font-weight:${weight};">${escapeHtml(formatCurrency(value))}</td></tr>`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Salary Slip ${escapeHtml(monthLabel)}</title>
    <style>
      body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 24px; color: #0f172a; }
      .card { border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px 20px; }
      .top { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
      .muted { color: #64748b; font-size: 12px; }
      .title { font-size: 22px; font-weight: 700; margin: 0; }
      .chip { font-size: 12px; display: inline-block; padding: 4px 10px; border-radius: 999px; background: #ecfeff; color: #0f766e; font-weight: 700; text-transform: uppercase; letter-spacing: .3px; }
      table { width: 100%; border-collapse: collapse; }
      .section { margin-top: 18px; }
      .section h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .4px; color: #334155; }
      .net { border-top: 1px solid #e2e8f0; margin-top: 10px; padding-top: 10px; display:flex; justify-content: space-between; font-size: 17px; font-weight: 800; color: #047857; }
      .footer { margin-top: 14px; font-size: 11px; color: #94a3b8; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="top">
        <div>
          <div class="muted">Company</div>
          <h1 class="title">${escapeHtml(input.companyName)}</h1>
          <div style="margin-top:6px;font-size:13px;">Salary Slip - ${escapeHtml(monthLabel)}</div>
        </div>
        <div style="text-align:right;">
          <div class="chip">${escapeHtml(input.salary.status)}</div>
          <div style="margin-top:10px;" class="muted">Slip No: ${escapeHtml(slipNumber)}</div>
          <div class="muted">Employee: ${escapeHtml(input.salary.employeeName)}</div>
          <div class="muted">Generated by: ${escapeHtml(input.generatedBy)}</div>
          <div class="muted">Generated on: ${escapeHtml(new Date(input.generatedAtISO).toLocaleString())}</div>
        </div>
      </div>

      <div class="section">
        <h3>Earnings</h3>
        <table>
          ${row("Basic", input.salary.basic)}
          ${row("HRA", input.salary.hra)}
          ${row("Transport", input.salary.transport)}
          ${row("Medical", input.salary.medical)}
          ${row("Bonus", input.salary.bonus)}
          ${row("Overtime", input.salary.overtime)}
          ${input.incentives?.goal ? row("Incentive - Target", input.incentives.goal) : ""}
          ${input.incentives?.product ? row("Incentive - Product", input.incentives.product) : ""}
          ${incentiveTotal ? row("Incentives Total", incentiveTotal, "bold") : ""}
          ${row(incentiveTotal ? "Gross Pay (incl. incentives)" : "Gross Pay", grossWithIncentives, "bold")}
        </table>
      </div>

      <div class="section">
        <h3>Deductions</h3>
        <table>
          ${row("Income Tax", input.salary.tax)}
          ${row("Provident Fund", input.salary.pf)}
          ${row("Insurance", input.salary.insurance)}
          ${row("Total Deductions", input.salary.totalDeductions, "bold")}
        </table>
      </div>

      <div class="net">
        <span>${incentiveTotal ? "Net Pay (incl. incentives)" : "Net Pay"}</span>
        <span>${escapeHtml(formatCurrency(netWithIncentives))}</span>
      </div>
      <div class="footer">This is a system-generated salary slip.</div>
    </div>
  </body>
</html>`;
}

function SalaryBreakdown({
  salary,
  incentives,
  colors,
  isAdmin,
  onMarkPaid,
  onViewSlip,
  onPrintSlip,
  onDeleteSalary,
  printingSlipId,
}: {
  salary: SalaryRecord;
  incentives?: IncentiveSummary;
  colors: typeof Colors.light;
  isAdmin: boolean;
  onMarkPaid: (salaryId: string) => void;
  onViewSlip: (salary: SalaryRecord) => void;
  onPrintSlip: (salary: SalaryRecord) => void;
  onDeleteSalary: (salary: SalaryRecord) => void;
  printingSlipId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusColor =
    salary.status === "paid" ? colors.success :
    salary.status === "approved" ? colors.primary : colors.warning;
  const isPrinting = printingSlipId === salary.id;
  const label = salary.label?.trim() || formatMonthLabel(salary.month);
  const periodLabel = formatPeriodLabel(salary.periodStart, salary.periodEnd);
  const incentiveTotal = incentives?.total || 0;
  const grossWithIncentives = salary.grossPay + incentiveTotal;
  const netWithIncentives = salary.netPay + incentiveTotal;

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setExpanded(!expanded);
      }}
      style={[styles.salaryCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
    >
      <View style={styles.salaryHeader}>
        <View style={styles.salaryHeaderLeft}>
          <Text style={[styles.salaryName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            {salary.employeeName}
          </Text>
          <Text style={[styles.salaryLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {label}
          </Text>
          {periodLabel ? (
            <Text style={[styles.salaryPeriod, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
              {periodLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.salaryHeaderRight}>
          <Text style={[styles.netPay, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            {formatCurrency(netWithIncentives)}
          </Text>
          {incentiveTotal ? (
            <Text style={[styles.incentiveTag, { color: colors.success, fontFamily: "Inter_500Medium" }]}>
              +{formatCurrency(incentiveTotal)} incentives
            </Text>
          ) : null}
          <View style={[styles.statusChip, { backgroundColor: statusColor + "15" }]}>
            <Text style={[styles.statusText, { color: statusColor, fontFamily: "Inter_500Medium" }]}>
              {salary.status}
            </Text>
          </View>
        </View>
      </View>

      {expanded && (
        <Animated.View entering={FadeInDown.duration(300)} style={styles.breakdown}>
          <View style={[styles.breakdownDivider, { backgroundColor: colors.border }]} />
          <Text style={[styles.breakdownSection, { color: colors.success, fontFamily: "Inter_600SemiBold" }]}>
            Earnings
          </Text>
          <BreakdownRow label="Basic" value={salary.basic} colors={colors} />
          <BreakdownRow label="HRA" value={salary.hra} colors={colors} />
          <BreakdownRow label="Transport" value={salary.transport} colors={colors} />
          <BreakdownRow label="Medical" value={salary.medical} colors={colors} />
          <BreakdownRow label="Bonus" value={salary.bonus} colors={colors} />
          <BreakdownRow label="Overtime" value={salary.overtime} colors={colors} />
          {incentives?.goal ? (
            <BreakdownRow label="Incentive - Target" value={incentives.goal} colors={colors} />
          ) : null}
          {incentives?.product ? (
            <BreakdownRow label="Incentive - Product" value={incentives.product} colors={colors} />
          ) : null}
          {incentiveTotal ? (
            <BreakdownRow label="Incentives Total" value={incentiveTotal} colors={colors} bold />
          ) : null}
          <BreakdownRow
            label={incentiveTotal ? "Gross Pay (incl. incentives)" : "Gross Pay"}
            value={grossWithIncentives}
            colors={colors}
            bold
          />

          <Text style={[styles.breakdownSection, { color: colors.danger, fontFamily: "Inter_600SemiBold", marginTop: 12 }]}>
            Deductions
          </Text>
          <BreakdownRow label="Income Tax" value={salary.tax} colors={colors} />
          <BreakdownRow label="Provident Fund" value={salary.pf} colors={colors} />
          <BreakdownRow label="Insurance" value={salary.insurance} colors={colors} />
          <BreakdownRow label="Total Deductions" value={salary.totalDeductions} colors={colors} bold />

          <View style={[styles.netPayRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.netPayLabel, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              {incentiveTotal ? "Net Pay (incl. incentives)" : "Net Pay"}
            </Text>
            <Text style={[styles.netPayValue, { color: colors.success, fontFamily: "Inter_700Bold" }]}>
              {formatCurrency(netWithIncentives)}
            </Text>
          </View>

          <View style={styles.actionRow}>
            <Pressable
              onPress={() => onViewSlip(salary)}
              style={({ pressed }) => [
                styles.secondaryActionButton,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: pressed ? 0.86 : 1,
                },
              ]}
            >
              <Ionicons name="document-text-outline" size={15} color={colors.textSecondary} />
              <Text style={[styles.secondaryActionButtonText, { color: colors.textSecondary }]}>
                View Slip
              </Text>
            </Pressable>

            <Pressable
              onPress={() => onPrintSlip(salary)}
              disabled={isPrinting}
              style={({ pressed }) => [
                styles.secondaryActionButton,
                {
                  borderColor: colors.primary,
                  backgroundColor: colors.primary + "12",
                  opacity: pressed || isPrinting ? 0.8 : 1,
                },
              ]}
            >
              {isPrinting ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Ionicons name="print-outline" size={15} color={colors.primary} />
              )}
              <Text style={[styles.secondaryActionButtonText, { color: colors.primary }]}>
                {isPrinting ? "Printing..." : "Print Slip"}
              </Text>
            </Pressable>

            {isAdmin ? (
              <Pressable
                onPress={() => onDeleteSalary(salary)}
                style={({ pressed }) => [
                  styles.secondaryActionButton,
                  styles.destructiveActionButton,
                  {
                    borderColor: colors.danger,
                    backgroundColor: colors.danger + "10",
                    opacity: pressed ? 0.82 : 1,
                  },
                ]}
              >
                <Ionicons name="trash-outline" size={15} color={colors.danger} />
                <Text style={[styles.secondaryActionButtonText, { color: colors.danger }]}>
                  Delete
                </Text>
              </Pressable>
            ) : null}
          </View>

          {isAdmin && salary.status !== "paid" ? (
            <Pressable
              onPress={() => onMarkPaid(salary.id)}
              style={({ pressed }) => [
                styles.payButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Ionicons name="cash-outline" size={15} color="#FFFFFF" />
              <Text style={styles.payButtonText}>Mark As Paid</Text>
            </Pressable>
          ) : null}
        </Animated.View>
      )}

      <View style={styles.expandIndicator}>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

function BreakdownRow({
  label,
  value,
  colors,
  bold,
}: {
  label: string;
  value: number;
  colors: typeof Colors.light;
  bold?: boolean;
}) {
  return (
    <View style={styles.breakdownRow}>
      <Text style={[styles.breakdownLabel, { color: colors.textSecondary, fontFamily: bold ? "Inter_600SemiBold" : "Inter_400Regular" }]}>
        {label}
      </Text>
      <Text style={[styles.breakdownValue, { color: colors.text, fontFamily: bold ? "Inter_600SemiBold" : "Inter_400Regular" }]}>
        INR {value.toLocaleString()}
      </Text>
    </View>
  );
}

function SalarySlipModal({
  visible,
  salary,
  incentives,
  colors,
  companyName,
  printing,
  onClose,
  onPrint,
}: {
  visible: boolean;
  salary: SalaryRecord | null;
  incentives?: IncentiveSummary;
  colors: typeof Colors.light;
  companyName: string;
  printing: boolean;
  onClose: () => void;
  onPrint: () => void;
}) {
  if (!salary) return null;
  const insets = useSafeAreaInsets();

  const monthLabel = formatMonthLabel(salary.month);
  const periodLabel = formatPeriodLabel(salary.periodStart, salary.periodEnd);
  const statusColor =
    salary.status === "paid" ? colors.success :
    salary.status === "approved" ? colors.primary : colors.warning;
  const incentiveTotal = incentives?.total || 0;
  const grossWithIncentives = salary.grossPay + incentiveTotal;
  const netWithIncentives = salary.netPay + incentiveTotal;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, { backgroundColor: "rgba(0, 0, 0, 0.45)" }]}>
        <View style={[styles.modalCard, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
              Salary Slip
            </Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.modalContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.slipTopCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
              <View style={styles.slipTopHead}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.slipCompany, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {companyName}
                  </Text>
              <Text style={[styles.slipSubtext, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {monthLabel}
              </Text>
              {salary.label ? (
                <Text style={[styles.slipSubtext, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  {salary.label}
                </Text>
              ) : null}
            </View>
            <View style={[styles.statusChip, { backgroundColor: statusColor + "15" }]}>
              <Text style={[styles.statusText, { color: statusColor, fontFamily: "Inter_500Medium" }]}>
                {salary.status}
              </Text>
                </View>
              </View>
              <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Slip No: {getSalarySlipNumber(salary)}
              </Text>
              <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Employee: {salary.employeeName}
              </Text>
              {periodLabel ? (
                <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Period: {periodLabel}
                </Text>
              ) : null}
              {salary.paymentDate ? (
                <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Payment Date: {salary.paymentDate}
                </Text>
              ) : null}
              {salary.paymentMode ? (
                <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Payment Mode: {salary.paymentMode}
                </Text>
              ) : null}
              <Text style={[styles.slipMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                Generated: {new Date().toLocaleString()}
              </Text>
            </View>

            <View style={[styles.slipSection, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
              <Text style={[styles.slipSectionTitle, { color: colors.success, fontFamily: "Inter_600SemiBold" }]}>
                Earnings
              </Text>
              <BreakdownRow label="Basic" value={salary.basic} colors={colors} />
              <BreakdownRow label="HRA" value={salary.hra} colors={colors} />
              <BreakdownRow label="Transport" value={salary.transport} colors={colors} />
              <BreakdownRow label="Medical" value={salary.medical} colors={colors} />
              <BreakdownRow label="Bonus" value={salary.bonus} colors={colors} />
              <BreakdownRow label="Overtime" value={salary.overtime} colors={colors} />
              {incentives?.goal ? (
                <BreakdownRow label="Incentive - Target" value={incentives.goal} colors={colors} />
              ) : null}
              {incentives?.product ? (
                <BreakdownRow label="Incentive - Product" value={incentives.product} colors={colors} />
              ) : null}
              {incentiveTotal ? (
                <BreakdownRow label="Incentives Total" value={incentiveTotal} colors={colors} bold />
              ) : null}
              <BreakdownRow
                label={incentiveTotal ? "Gross Pay (incl. incentives)" : "Gross Pay"}
                value={grossWithIncentives}
                colors={colors}
                bold
              />
            </View>

            <View style={[styles.slipSection, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
              <Text style={[styles.slipSectionTitle, { color: colors.danger, fontFamily: "Inter_600SemiBold" }]}>
                Deductions
              </Text>
              <BreakdownRow label="Income Tax" value={salary.tax} colors={colors} />
              <BreakdownRow label="Provident Fund" value={salary.pf} colors={colors} />
              <BreakdownRow label="Insurance" value={salary.insurance} colors={colors} />
              <BreakdownRow label="Total Deductions" value={salary.totalDeductions} colors={colors} bold />
            </View>

            <View style={[styles.slipNetCard, { borderColor: colors.success + "45", backgroundColor: colors.success + "10" }]}>
              <Text style={[styles.slipNetLabel, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                {incentiveTotal ? "Net Pay (incl. incentives)" : "Net Pay"}
              </Text>
              <Text style={[styles.slipNetValue, { color: colors.success, fontFamily: "Inter_700Bold" }]}>
                {formatCurrency(netWithIncentives)}
              </Text>
            </View>
          </ScrollView>

          <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.modalFooterButton,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  opacity: pressed ? 0.86 : 1,
                },
              ]}
            >
              <Text style={[styles.modalFooterButtonText, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                Close
              </Text>
            </Pressable>
            <Pressable
              onPress={onPrint}
              disabled={printing}
              style={({ pressed }) => [
                styles.modalFooterButton,
                {
                  borderColor: colors.primary,
                  backgroundColor: colors.primary,
                  opacity: pressed || printing ? 0.85 : 1,
                },
              ]}
            >
              {printing ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="print-outline" size={16} color="#FFFFFF" />
              )}
              <Text style={[styles.modalFooterButtonText, { color: "#FFFFFF", fontFamily: "Inter_600SemiBold" }]}>
                {printing ? "Printing..." : "Print Slip"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AmountField({
  label,
  value,
  onChangeText,
  colors,
  placeholder = "0",
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  colors: typeof Colors.light;
  placeholder?: string;
}) {
  return (
    <View style={styles.formRow}>
      <Text style={[styles.formLabel, { color: colors.textSecondary }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType="numeric"
        placeholderTextColor={colors.textTertiary}
        style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
      />
    </View>
  );
}

function CompactAmountField({
  label,
  value,
  onChangeText,
  colors,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  colors: typeof Colors.light;
}) {
  return (
    <View style={styles.gridField}>
      <AmountField label={label} value={value} onChangeText={onChangeText} colors={colors} />
    </View>
  );
}

function SummaryStat({
  label,
  value,
  accent,
  colors,
}: {
  label: string;
  value: number;
  accent: string;
  colors: typeof Colors.light;
}) {
  return (
    <View style={[styles.summaryStatCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={[styles.summaryStatDot, { backgroundColor: accent }]} />
      <Text style={[styles.summaryStatLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.summaryStatValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
        {formatCurrency(value)}
      </Text>
    </View>
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
  colors: typeof Colors.light;
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
        <Text style={[styles.employeeName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
          {employee.name}
        </Text>
        <Text style={[styles.employeeMeta, { color: colors.textSecondary }]}>
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

export default function SalaryScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();
  const [salaries, setSalaries] = useState<SalaryRecord[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [dolibarrEmployees, setDolibarrEmployees] = useState<Employee[]>([]);
  const [incentivePayouts, setIncentivePayouts] = useState<IncentivePayout[]>([]);
  const [selectedSlip, setSelectedSlip] = useState<SalaryRecord | null>(null);
  const [printingSlipId, setPrintingSlipId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createEmployeeId, setCreateEmployeeId] = useState("");
  const [createEmployeeName, setCreateEmployeeName] = useState("");
  const [createEmployeeEmail, setCreateEmployeeEmail] = useState("");
  const [createSearch, setCreateSearch] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [createPeriodStart, setCreatePeriodStart] = useState("");
  const [createPeriodEnd, setCreatePeriodEnd] = useState("");
  const [createPaymentDate, setCreatePaymentDate] = useState("");
  const [createPaymentMode, setCreatePaymentMode] = useState("");
  const [createBankAccount, setCreateBankAccount] = useState("");
  const [createBasic, setCreateBasic] = useState("");
  const [createHra, setCreateHra] = useState("");
  const [createTransport, setCreateTransport] = useState("");
  const [createMedical, setCreateMedical] = useState("");
  const [createBonus, setCreateBonus] = useState("");
  const [createOvertime, setCreateOvertime] = useState("");
  const [createTax, setCreateTax] = useState("");
  const [createPf, setCreatePf] = useState("");
  const [createInsurance, setCreateInsurance] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [savingSalary, setSavingSalary] = useState(false);
  const [dateTarget, setDateTarget] = useState<"start" | "end" | "pay" | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [showEmployeeDropdown, setShowEmployeeDropdown] = useState(false);
  const [showBankAccountPicker, setShowBankAccountPicker] = useState(false);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [loadingEmployeeBankAccounts, setLoadingEmployeeBankAccounts] = useState(false);
  const [hasLoadedBankAccountsForPicker, setHasLoadedBankAccountsForPicker] = useState(false);
  const isAdmin = user?.role === "admin";
  const hasLoadedDolibarrEmployeesRef = useRef(false);

  const loadDolibarrEmployeeOptions = useCallback(async () => {
    if (!user || !isAdmin || loadingEmployees || hasLoadedDolibarrEmployeesRef.current) return;
    setLoadingEmployees(true);
    try {
      const result = await getDolibarrEmployees();
      const nextEmployees = Array.isArray(result) ? result : [];
      setDolibarrEmployees(nextEmployees);
      hasLoadedDolibarrEmployeesRef.current = true;
    } finally {
      setLoadingEmployees(false);
    }
  }, [isAdmin, loadingEmployees, user]);

  const loadData = useCallback(async () => {
    if (!user) {
      setSalaries([]);
      setEmployees([]);
      setDolibarrEmployees([]);
      setIncentivePayouts([]);
      setBankAccounts([]);
      hasLoadedDolibarrEmployeesRef.current = false;
      return;
    }
    try {
      const [salaryDataResult, employeesResult, payoutsResult] =
        await Promise.allSettled([
          getSalaries(),
          getEmployees(),
          getIncentivePayouts({ refreshRemote: true }),
        ]);
      const salaryData = salaryDataResult.status === "fulfilled" ? salaryDataResult.value : [];
      const employees = employeesResult.status === "fulfilled" ? employeesResult.value : [];
      const payouts = payoutsResult.status === "fulfilled" ? payoutsResult.value : [];
      setEmployees(employees);
      setIncentivePayouts(Array.isArray(payouts) ? payouts : []);
      setSalaries(salaryData);

    } finally {
      if (!user || !isAdmin) {
        hasLoadedDolibarrEmployeesRef.current = false;
      }
    }
  }, [isAdmin, user]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!user || !isAdmin) {
      hasLoadedDolibarrEmployeesRef.current = false;
      setDolibarrEmployees([]);
      return;
    }
    if (hasLoadedDolibarrEmployeesRef.current || loadingEmployees) return;
    void loadDolibarrEmployeeOptions();
  }, [isAdmin, loadDolibarrEmployeeOptions, loadingEmployees, user]);

  const handleMarkPaid = useCallback(
    async (salaryId: string) => {
      if (!isAdmin || !user) return;
      const synced = await updateSalaryRecordStatus(salaryId, "paid");
      const target = salaries.find((entry) => entry.id === salaryId);
      await addAuditLog({
        id: Crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        action: "Salary Paid",
        details: `Marked salary as paid for ${target?.employeeName || "employee"}`,
        timestamp: new Date().toISOString(),
        module: "Salary",
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadData();
    },
    [isAdmin, loadData, salaries, user]
  );

  const handleMarkAllPaid = useCallback(async () => {
    if (!isAdmin || !user) return;
    const pending = salaries.filter((salary) => salary.status !== "paid");
    if (!pending.length) return;
    for (const salary of pending) {
      await updateSalaryRecordStatus(salary.id, "paid");
    }
    await addAuditLog({
      id: Crypto.randomUUID(),
      userId: user.id,
      userName: user.name,
      action: "Bulk Salary Paid",
      details: `Marked ${pending.length} salary records as paid`,
      timestamp: new Date().toISOString(),
      module: "Salary",
    });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await loadData();
  }, [isAdmin, loadData, salaries, user]);

  const resetCreateForm = useCallback(() => {
    setCreateEmployeeId("");
    setCreateEmployeeName("");
    setCreateEmployeeEmail("");
    setCreateSearch("");
    setCreateLabel("");
    setCreatePeriodStart("");
    setCreatePeriodEnd("");
    setCreatePaymentDate("");
    setCreatePaymentMode("");
    setCreateBankAccount("");
    setCreateBasic("");
    setCreateHra("");
    setCreateTransport("");
    setCreateMedical("");
    setCreateBonus("");
    setCreateOvertime("");
    setCreateTax("");
    setCreatePf("");
    setCreateInsurance("");
    setCreateNote("");
    setShowEmployeeDropdown(false);
    setShowBankAccountPicker(false);
    setLoadingEmployeeBankAccounts(false);
    setHasLoadedBankAccountsForPicker(false);
    setBankAccounts([]);
  }, []);

  const handleOpenCreate = useCallback(() => {
    if (!isAdmin) return;
    resetCreateForm();
    setShowCreateModal(true);
  }, [isAdmin, resetCreateForm]);

  const handleCloseCreate = useCallback(() => {
    if (savingSalary) return;
    setShowCreateModal(false);
  }, [savingSalary]);

  const clearSelectedEmployee = useCallback(() => {
    setCreateEmployeeId("");
    setCreateEmployeeName("");
    setCreateEmployeeEmail("");
    setCreateSearch("");
    setCreateBankAccount("");
    setBankAccounts([]);
    setShowBankAccountPicker(false);
    setLoadingEmployeeBankAccounts(false);
    setHasLoadedBankAccountsForPicker(false);
  }, []);

  const dolibarrSelectableEmployees = useMemo(
    () =>
      dolibarrEmployees
        .filter((employee) => employee.role !== "admin")
        .filter((employee) => isDolibarrEmployee(employee))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [dolibarrEmployees]
  );

  const filteredEmployees = useMemo(() => {
    const q = createSearch.trim().toLowerCase();
    if (!q) return dolibarrSelectableEmployees.slice(0, 20);
    return dolibarrSelectableEmployees.filter((employee) => {
      return (
        employee.name.toLowerCase().includes(q) ||
        employee.email.toLowerCase().includes(q) ||
        employee.department.toLowerCase().includes(q) ||
        employee.branch.toLowerCase().includes(q)
      );
    }).slice(0, 20);
  }, [createSearch, dolibarrSelectableEmployees]);

  const selectedEmployee = useMemo(
    () =>
      dolibarrEmployees.find((employee) => employee.id === createEmployeeId) ||
      employees.find((employee) => employee.id === createEmployeeId) ||
      null,
    [createEmployeeId, dolibarrEmployees, employees]
  );

  const employeeBankAccounts = useMemo(
    () => {
      if (!createEmployeeId && !createEmployeeName && !createEmployeeEmail) return [];
      return bankAccounts.filter((account) =>
        matchesBankAccountToEmployee(account, {
          employeeId: createEmployeeId,
          employeeName: createEmployeeName,
          employeeEmail: createEmployeeEmail,
        })
      );
    },
    [bankAccounts, createEmployeeEmail, createEmployeeId, createEmployeeName]
  );

  const bankAccountsForPicker = useMemo(() => {
    if (bankAccounts.length === 0) return [];
    const matchedIds = new Set(employeeBankAccounts.map((account) => account.id));
    const matched = employeeBankAccounts.map((account) => ({ account, matched: true }));
    const unmatched = bankAccounts
      .filter((account) => !matchedIds.has(account.id))
      .map((account) => ({ account, matched: false }));
    return [...matched, ...unmatched];
  }, [bankAccounts, employeeBankAccounts]);

  const refreshEmployeeBankAccounts = useCallback(async (force = false) => {
      if (!force && hasLoadedBankAccountsForPicker && bankAccounts.length > 0) {
        return bankAccounts;
      }
      setLoadingEmployeeBankAccounts(true);
      try {
        const [latestAccounts, latestDolibarrAccounts] = await Promise.all([
          getBankAccounts(),
          loadDolibarrAccountsForSalaryPicker().catch(() => []),
        ]);
        const normalizedAccounts = mergeAccountSources(
          Array.isArray(latestAccounts) ? latestAccounts : [],
          Array.isArray(latestDolibarrAccounts) ? latestDolibarrAccounts : []
        );
        setBankAccounts(normalizedAccounts);
        setHasLoadedBankAccountsForPicker(true);
        return normalizedAccounts;
      } catch {
        setBankAccounts([]);
        setHasLoadedBankAccountsForPicker(true);
        return [] as BankAccount[];
      } finally {
        setLoadingEmployeeBankAccounts(false);
      }
    }, [bankAccounts, hasLoadedBankAccountsForPicker]);

  useEffect(() => {
    if (!showBankAccountPicker) return;
    void refreshEmployeeBankAccounts();
  }, [refreshEmployeeBankAccounts, showBankAccountPicker]);

  const salaryDraft = useMemo(() => {
    const basic = parseAmountInput(createBasic);
    const hra = parseAmountInput(createHra);
    const transport = parseAmountInput(createTransport);
    const medical = parseAmountInput(createMedical);
    const bonus = parseAmountInput(createBonus);
    const overtime = parseAmountInput(createOvertime);
    const tax = parseAmountInput(createTax);
    const pf = parseAmountInput(createPf);
    const insurance = parseAmountInput(createInsurance);
    const grossPay = basic + hra + transport + medical + bonus + overtime;
    const totalDeductions = tax + pf + insurance;
    const netPay = Math.max(grossPay - totalDeductions, 0);
    return {
      basic,
      hra,
      transport,
      medical,
      bonus,
      overtime,
      tax,
      pf,
      insurance,
      grossPay,
      totalDeductions,
      netPay,
    };
  }, [
    createBasic,
    createBonus,
    createHra,
    createInsurance,
    createMedical,
    createOvertime,
    createPf,
    createTax,
    createTransport,
  ]);

  const incentivesBySalaryId = useMemo(() => {
    const map = new Map<string, IncentiveSummary>();
    if (!salaries.length || !incentivePayouts.length) return map;

    const paidPayouts = incentivePayouts.filter((payout) => payout.status === "paid");
    if (!paidPayouts.length) return map;

    for (const salary of salaries) {
      const matchKeys = buildMatchKeys(salary.employeeId, salary.employeeName);
      const { start, end } = getSalaryRange(salary);
      let goal = 0;
      let product = 0;
      const payouts: IncentivePayout[] = [];

      for (const payout of paidPayouts) {
        const payoutKeys = buildMatchKeys(payout.salespersonId, payout.salespersonName);
        let matched = false;
        for (const key of payoutKeys) {
          if (matchKeys.has(key)) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;

        const payoutStart = parseDateOnly(payout.rangeStart);
        const payoutEnd = parseDateOnly(payout.rangeEnd);
        if (!payoutStart || !payoutEnd) continue;
        const payoutEndInclusive = new Date(payoutEnd);
        payoutEndInclusive.setHours(23, 59, 59, 999);
        if (payoutStart > end || payoutEndInclusive < start) continue;

        goal += payout.goalAmount || 0;
        product += payout.productAmount || 0;
        payouts.push(payout);
      }

      const total = goal + product;
      if (total) {
        map.set(salary.id, { total, goal, product, payouts });
      }
    }

    return map;
  }, [incentivePayouts, salaries]);

  const handleCreateSalary = useCallback(async () => {
    if (!isAdmin || !user) return;
    if (!createEmployeeId || !createEmployeeName) {
      Alert.alert("Employee Required", "Select an employee before saving the salary.");
      return;
    }
    if (!createEmployeeId.startsWith("dolibarr_") || !hasSyncableEmployeeEmail(createEmployeeEmail)) {
      Alert.alert(
        "Dolibarr Employee Required",
        "Select an employee from the Dolibarr dropdown with a valid email so salary can save to DB and sync to Dolibarr."
      );
      return;
    }
    const label = createLabel.trim() || "Salary";
    const periodStart = createPeriodStart.trim();
    const periodEnd = createPeriodEnd.trim();
    const paymentDate = createPaymentDate.trim();
    const paymentMode = createPaymentMode.trim();
    const note = createNote.trim();
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (periodStart && !datePattern.test(periodStart)) {
      Alert.alert("Invalid Date", "Period start must be in YYYY-MM-DD format.");
      return;
    }
    if (periodEnd && !datePattern.test(periodEnd)) {
      Alert.alert("Invalid Date", "Period end must be in YYYY-MM-DD format.");
      return;
    }
    if (paymentDate && !datePattern.test(paymentDate)) {
      Alert.alert("Invalid Date", "Payment date must be in YYYY-MM-DD format.");
      return;
    }

    if (!salaryDraft.grossPay || salaryDraft.grossPay <= 0) {
      Alert.alert("Invalid Salary", "Enter at least the basic salary or earnings amount.");
      return;
    }
    const monthSource = periodStart || paymentDate || "";
    const monthKey = /^\d{4}-\d{2}/.test(monthSource) ? monthSource.slice(0, 7) : getDefaultMonthKey();

    setSavingSalary(true);
    try {
      const salaryRecord: SalaryRecord = {
        id: Crypto.randomUUID(),
        employeeId: createEmployeeId,
        employeeName: createEmployeeName,
        employeeEmail: createEmployeeEmail || undefined,
        label,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        paymentDate: paymentDate || undefined,
        paymentMode: paymentMode || undefined,
        bankAccount: createBankAccount.trim() || undefined,
        note: note || undefined,
        month: monthKey,
        basic: salaryDraft.basic,
        hra: salaryDraft.hra,
        transport: salaryDraft.transport,
        medical: salaryDraft.medical,
        bonus: salaryDraft.bonus,
        overtime: salaryDraft.overtime,
        tax: salaryDraft.tax,
        pf: salaryDraft.pf,
        insurance: salaryDraft.insurance,
        grossPay: salaryDraft.grossPay,
        totalDeductions: salaryDraft.totalDeductions,
        netPay: salaryDraft.netPay,
        status: "approved",
      };

      await saveSalaryRecord(salaryRecord);

      await addAuditLog({
        id: Crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        action: "Salary Added",
        details: `Added salary for ${createEmployeeName} (${monthKey})`,
        timestamp: new Date().toISOString(),
        module: "Salary",
      });

      setShowCreateModal(false);
      await loadData();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to save salary record.";
      Alert.alert("Save Failed", message);
    } finally {
      setSavingSalary(false);
    }
  }, [
    addAuditLog,
    createEmployeeEmail,
    createEmployeeId,
    createEmployeeName,
    createLabel,
    createPeriodStart,
    createPeriodEnd,
    createPaymentDate,
    createPaymentMode,
    createBankAccount,
    createBasic,
    createBonus,
    createHra,
    createInsurance,
    createMedical,
    createNote,
    createOvertime,
    isAdmin,
    loadData,
    salaryDraft,
    createPf,
    createTax,
    createTransport,
    user,
  ]);

  const handleDeleteSalary = useCallback(
    (record: SalaryRecord) => {
      Alert.alert(
        "Delete Salary Record",
        `Are you sure you want to delete the salary record for ${record.employeeName} (${record.month})?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await deleteSalaryRecord(record.id);
                await loadData();
                Alert.alert("Deleted", "Salary record deleted successfully.");
              } catch (err) {
                const message = err instanceof Error ? err.message : "Could not delete salary record.";
                Alert.alert("Delete Failed", message);
              }
            },
          },
        ]
      );
    },
    [loadData]
  );

  const handleViewSlip = useCallback((salary: SalaryRecord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedSlip(salary);
  }, []);

  const handleCloseSlip = useCallback(() => {
    setSelectedSlip(null);
  }, []);

  const handlePrintSlip = useCallback(
    async (salary: SalaryRecord) => {
      const companyName = user?.companyName || "Lumina FieldForce";
      setPrintingSlipId(salary.id);
      try {
        const incentives = incentivesBySalaryId.get(salary.id);
        const html = buildSalarySlipHtml({
          salary,
          incentives,
          companyName,
          generatedBy: user?.name || "Payroll Admin",
          generatedAtISO: new Date().toISOString(),
        });
        await Print.printAsync({ html });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to print salary slip.";
        Alert.alert("Print Failed", message);
      } finally {
        setPrintingSlipId((current) => (current === salary.id ? null : current));
      }
    },
    [incentivesBySalaryId, user?.companyName, user?.name]
  );

  return (
    <AppCanvas>
      <FlatList
        data={salaries}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.headerRow}>
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <Ionicons name="arrow-back" size={24} color={colors.text} />
            </Pressable>
            <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Salary</Text>
            {isAdmin ? (
              <View style={styles.headerActions}>
                <Pressable onPress={handleOpenCreate} hitSlop={10}>
                  <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                </Pressable>
                <Pressable onPress={() => void handleMarkAllPaid()} hitSlop={10}>
                  <Ionicons name="cash-outline" size={23} color={colors.primary} />
                </Pressable>
              </View>
            ) : (
              <View style={{ width: 24 }} />
            )}
          </View>
        }
        renderItem={({ item }) => (
          <SalaryBreakdown
            salary={item}
            incentives={incentivesBySalaryId.get(item.id)}
            colors={colors}
            isAdmin={isAdmin}
            onMarkPaid={handleMarkPaid}
            onViewSlip={handleViewSlip}
            onPrintSlip={(salary) => void handlePrintSlip(salary)}
            onDeleteSalary={handleDeleteSalary}
            printingSlipId={printingSlipId}
          />
        )}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="wallet-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {isAdmin ? "No salary records" : "No salary record for your profile"}
            </Text>
          </View>
        }
      />

      <SalarySlipModal
        visible={Boolean(selectedSlip)}
        salary={selectedSlip}
        incentives={selectedSlip ? incentivesBySalaryId.get(selectedSlip.id) : undefined}
        colors={colors}
        companyName={user?.companyName || "Lumina FieldForce"}
        printing={selectedSlip ? printingSlipId === selectedSlip.id : false}
        onClose={handleCloseSlip}
        onPrint={() => {
          if (!selectedSlip) return;
          void handlePrintSlip(selectedSlip);
        }}
      />

      <Modal visible={showCreateModal} transparent animationType="slide" onRequestClose={handleCloseCreate}>
        <View style={styles.modalOverlay}>
          <View style={[styles.createModalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                New Salary Record
              </Text>
              <Pressable onPress={handleCloseCreate} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={styles.modalContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.createHeroCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.createHeroHeader}>
                  <View style={styles.createHeroTitleWrap}>
                    <Text style={[styles.createHeroTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                      Salary Workspace
                    </Text>
                    <Text style={[styles.createHeroSubtitle, { color: colors.textSecondary }]}>
                      Fill earnings, deductions, payment info, and save directly to payroll records.
                    </Text>
                  </View>
                  <View style={[styles.createHeroBadge, { backgroundColor: colors.primary + "14" }]}>
                    <Text style={[styles.createHeroBadgeText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                      {selectedEmployee ? "Employee linked" : "Pick employee"}
                    </Text>
                  </View>
                </View>

                <View style={styles.summaryStatsRow}>
                  <SummaryStat label="Gross" value={salaryDraft.grossPay} accent={colors.primary} colors={colors} />
                  <SummaryStat
                    label="Deductions"
                    value={salaryDraft.totalDeductions}
                    accent={colors.warning}
                    colors={colors}
                  />
                  <SummaryStat label="Net" value={salaryDraft.netPay} accent={colors.success} colors={colors} />
                </View>
              </View>

              <View style={styles.sectionBlock}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Employee</Text>
                  <Pressable
                    onPress={() => {
                      setShowEmployeeDropdown(true);
                      if (!dolibarrSelectableEmployees.length && !loadingEmployees) {
                        void loadDolibarrEmployeeOptions();
                      }
                    }}
                  style={[styles.employeeDropdownField, { borderColor: colors.border, backgroundColor: colors.surface }]}
                >
                  <Ionicons name="people-outline" size={16} color={colors.textSecondary} />
                  <View style={styles.employeePickerValueWrap}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.employeePickerValue,
                        { color: createSearch ? colors.text : colors.textSecondary },
                      ]}
                    >
                      {createSearch || "Search Dolibarr employee..."}
                    </Text>
                    <Text style={[styles.employeePickerHint, { color: colors.textTertiary }]}>
                      Tap to open employee picker
                    </Text>
                  </View>
                  <View style={styles.employeeFieldActions}>
                    {createSearch ? (
                      <Pressable
                        hitSlop={8}
                        onPress={clearSelectedEmployee}
                        style={[styles.clearEmployeeButton, { backgroundColor: colors.danger + "14" }]}
                      >
                        <Ionicons name="close" size={14} color={colors.danger} />
                      </Pressable>
                    ) : null}
                    <Ionicons
                      name="chevron-down"
                      size={18}
                      color={colors.textSecondary}
                    />
                  </View>
                </Pressable>

                  <Text style={[styles.dropdownHint, { color: colors.textTertiary }]}>
                    Dropdown loads direct Dolibarr employees. Salary save will require a valid employee email for Dolibarr sync.
                  </Text>

                {selectedEmployee ? (
                  <View style={[styles.selectedEmployeeCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.selectedEmployeeName, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                        {selectedEmployee.name}
                      </Text>
                      <Text style={[styles.selectedEmployeeMeta, { color: colors.textSecondary }]}>
                        Dolibarr Employee • {selectedEmployee.branch}
                      </Text>
                      <Text style={[styles.selectedEmployeeMeta, { color: colors.textTertiary }]}>
                        {createEmployeeEmail || "No email on profile"}
                      </Text>
                    </View>
                    <View style={styles.selectedEmployeeActions}>
                      <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                      <Pressable
                        hitSlop={8}
                        onPress={clearSelectedEmployee}
                        style={[styles.clearEmployeeButton, { backgroundColor: colors.danger + "14" }]}
                      >
                        <Ionicons name="close" size={14} color={colors.danger} />
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>

              <View style={styles.sectionBlock}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Salary Details</Text>
                <View style={styles.formGrid}>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Label</Text>
                    <TextInput
                      value={createLabel}
                      onChangeText={setCreateLabel}
                      placeholder="Salary Payment"
                      placeholderTextColor={colors.textTertiary}
                      style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                    />
                  </View>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Payment Mode</Text>
                    <TextInput
                      value={createPaymentMode}
                      onChangeText={setCreatePaymentMode}
                      placeholder="Bank Transfer / Cash / Cheque"
                      placeholderTextColor={colors.textTertiary}
                      style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                    />
                  </View>
                </View>

                <View style={styles.formGrid}>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Period Start</Text>
                    <Pressable
                      onPress={() => setDateTarget("start")}
                      style={[styles.formInput, styles.dateInput, { borderColor: colors.border }]}
                    >
                      <Text style={{ color: createPeriodStart ? colors.text : colors.textTertiary }}>
                        {createPeriodStart || "Select Start Date"}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Period End</Text>
                    <Pressable
                      onPress={() => setDateTarget("end")}
                      style={[styles.formInput, styles.dateInput, { borderColor: colors.border }]}
                    >
                      <Text style={{ color: createPeriodEnd ? colors.text : colors.textTertiary }}>
                        {createPeriodEnd || "Select End Date"}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.formGrid}>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Payment Date</Text>
                    <Pressable
                      onPress={() => setDateTarget("pay")}
                      style={[styles.formInput, styles.dateInput, { borderColor: colors.border }]}
                    >
                      <Text style={{ color: createPaymentDate ? colors.text : colors.textTertiary }}>
                        {createPaymentDate || "Select Payment Date"}
                      </Text>
                    </Pressable>
                  </View>
                  <View style={styles.gridField}>
                    <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Bank Account</Text>
                    <Pressable
                      onPress={async () => {
                        if (!createEmployeeId && !createEmployeeName && !createEmployeeEmail) {
                          Alert.alert("Select Employee", "Pehle employee select karo, phir uske saved bank accounts choose kar paoge.");
                          return;
                        }
                        setShowBankAccountPicker(true);
                      }}
                      style={[styles.bankSelector, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}
                    >
                      <View style={styles.bankPickerTrigger}>
                        <View style={styles.bankPickerTriggerTextWrap}>
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.bankPickerValue,
                              { color: createBankAccount ? colors.text : colors.textSecondary },
                            ]}
                          >
                            {createBankAccount || "Select bank account"}
                          </Text>
                          <Text style={[styles.bankPickerHint, { color: colors.textTertiary }]}>
                            {!selectedEmployee
                              ? "Select employee first"
                              : employeeBankAccounts.length > 0
                              ? `${employeeBankAccounts.length} matching account${employeeBankAccounts.length > 1 ? "s" : ""} found`
                              : bankAccounts.length > 0
                              ? `${bankAccounts.length} total account${bankAccounts.length > 1 ? "s" : ""} available`
                              : hasLoadedBankAccountsForPicker
                              ? "No bank account found, add one"
                              : "Tap to load bank accounts"}
                          </Text>
                        </View>
                        <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                      </View>
                    </Pressable>
                  </View>
                </View>
              </View>

              <View style={styles.sectionBlock}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Earnings</Text>
                <View style={styles.formGrid}>
                  <CompactAmountField label="Basic" value={createBasic} onChangeText={setCreateBasic} colors={colors} />
                  <CompactAmountField label="HRA" value={createHra} onChangeText={setCreateHra} colors={colors} />
                  <CompactAmountField label="Transport" value={createTransport} onChangeText={setCreateTransport} colors={colors} />
                  <CompactAmountField label="Medical" value={createMedical} onChangeText={setCreateMedical} colors={colors} />
                  <CompactAmountField label="Bonus" value={createBonus} onChangeText={setCreateBonus} colors={colors} />
                  <CompactAmountField label="Overtime" value={createOvertime} onChangeText={setCreateOvertime} colors={colors} />
                </View>
              </View>

              <View style={styles.sectionBlock}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Deductions</Text>
                <View style={styles.formGrid}>
                  <CompactAmountField label="Income Tax" value={createTax} onChangeText={setCreateTax} colors={colors} />
                  <CompactAmountField label="Provident Fund" value={createPf} onChangeText={setCreatePf} colors={colors} />
                  <CompactAmountField label="Insurance" value={createInsurance} onChangeText={setCreateInsurance} colors={colors} />
                </View>
              </View>

              <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.summaryCardHeader}>
                  <Text style={[styles.summaryCardTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    Payroll Summary
                  </Text>
                  <Text style={[styles.summaryCardSubtitle, { color: colors.textSecondary }]}>
                    Live totals before saving
                  </Text>
                </View>
                <View style={styles.summaryValueRow}>
                  <Text style={[styles.summaryValueLabel, { color: colors.textSecondary }]}>Gross Pay</Text>
                  <Text style={[styles.summaryValueText, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {formatCurrency(salaryDraft.grossPay)}
                  </Text>
                </View>
                <View style={styles.summaryValueRow}>
                  <Text style={[styles.summaryValueLabel, { color: colors.textSecondary }]}>Total Deductions</Text>
                  <Text style={[styles.summaryValueText, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                    {formatCurrency(salaryDraft.totalDeductions)}
                  </Text>
                </View>
                <View style={[styles.summaryValueRow, styles.summaryNetRow, { borderTopColor: colors.border }]}>
                  <Text style={[styles.summaryNetLabel, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Net Pay</Text>
                  <Text style={[styles.summaryNetValue, { color: colors.success, fontFamily: "Inter_700Bold" }]}>
                    {formatCurrency(salaryDraft.netPay)}
                  </Text>
                </View>
              </View>

              <View style={styles.sectionBlock}>
                <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Notes</Text>
                <TextInput
                  value={createNote}
                  onChangeText={setCreateNote}
                  placeholder="Optional payout note, bank transfer reference, or payroll remarks"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, styles.notesInput, { color: colors.text, borderColor: colors.border }]}
                  multiline
                />
              </View>
            </ScrollView>

            <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom, 12) }]}>
              <Pressable
                onPress={handleCloseCreate}
                disabled={savingSalary}
                style={({ pressed }) => [
                  styles.modalFooterButton,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.surface,
                    opacity: pressed || savingSalary ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={[styles.modalFooterButtonText, { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void handleCreateSalary()}
                disabled={savingSalary}
                style={({ pressed }) => [
                  styles.modalFooterButton,
                  {
                    borderColor: colors.primary,
                    backgroundColor: colors.primary,
                    opacity: pressed || savingSalary ? 0.85 : 1,
                  },
                ]}
              >
                {savingSalary ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="save-outline" size={16} color="#FFFFFF" />
                )}
                <Text style={[styles.modalFooterButtonText, { color: "#FFFFFF", fontFamily: "Inter_600SemiBold" }]}>
                  {savingSalary ? "Saving..." : "Save Salary"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <CalendarModal
        visible={Boolean(dateTarget)}
        value={
          dateTarget === "start"
            ? createPeriodStart
            : dateTarget === "end"
            ? createPeriodEnd
            : createPaymentDate
        }
        onClose={() => setDateTarget(null)}
        colors={colors}
        onSelect={(dateStr) => {
          if (dateTarget === "start") setCreatePeriodStart(dateStr);
          else if (dateTarget === "end") setCreatePeriodEnd(dateStr);
          else if (dateTarget === "pay") setCreatePaymentDate(dateStr);
        }}
      />

      <Modal
        visible={showEmployeeDropdown}
        transparent
        animationType="slide"
        onRequestClose={() => setShowEmployeeDropdown(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.pickerSheetCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={[styles.pickerSheetHeader, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.pickerSheetTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  Select Employee
                </Text>
                <Text style={[styles.pickerSheetSubtitle, { color: colors.textSecondary }]}>
                  Direct Dolibarr employee picker
                </Text>
              </View>
              <Pressable onPress={() => setShowEmployeeDropdown(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.pickerSheetBody}>
              <TextInput
                value={createSearch}
                onChangeText={setCreateSearch}
                placeholder="Search employee..."
                placeholderTextColor={colors.textTertiary}
                style={[styles.pickerSearchInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              />

              <ScrollView
                style={styles.pickerListScroll}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.pickerListContent}
              >
                {loadingEmployees ? (
                  <View style={styles.bankPickerEmptyState}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                      Loading Dolibarr employees...
                    </Text>
                  </View>
                ) : dolibarrSelectableEmployees.length === 0 ? (
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                    No Dolibarr employees found.
                  </Text>
                ) : filteredEmployees.length === 0 ? (
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                    No Dolibarr employee matched your search.
                  </Text>
                ) : (
                  filteredEmployees.map((employee) => (
                    <EmployeePickerRow
                      key={employee.id}
                      employee={employee}
                      selected={employee.id === createEmployeeId}
                      colors={colors}
                      onSelect={(selected) => {
                        setCreateEmployeeId(selected.id);
                        setCreateEmployeeName(selected.name);
                        setCreateEmployeeEmail(selected.email);
                        setCreateSearch(selected.name);
                        setShowEmployeeDropdown(false);
                        setBankAccounts([]);
                        setCreateBankAccount("");
                        setHasLoadedBankAccountsForPicker(false);
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
        visible={showBankAccountPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBankAccountPicker(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.pickerSheetCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={[styles.pickerSheetHeader, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.pickerSheetTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  Select Bank Account
                </Text>
                <Text style={[styles.pickerSheetSubtitle, { color: colors.textSecondary }]}>
                  {selectedEmployee
                    ? employeeBankAccounts.length > 0
                      ? `${selectedEmployee.name} ke matching accounts first dikh rahe hain`
                      : "App + Dolibarr bank accounts loaded, choose manually"
                    : "Choose a bank account"}
                </Text>
              </View>
              <Pressable onPress={() => setShowBankAccountPicker(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.pickerSheetContent}
            >
              {loadingEmployeeBankAccounts ? (
                <View style={styles.bankPickerEmptyState}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                    Loading bank accounts...
                  </Text>
                </View>
              ) : bankAccountsForPicker.length === 0 ? (
                <View style={styles.bankPickerEmptyState}>
                  <Ionicons name="card-outline" size={22} color={colors.textTertiary} />
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                    No bank account found.
                  </Text>
                </View>
              ) : (
                bankAccountsForPicker.map(({ account, matched }) => {
                  const bankLabel = formatBankAccountOption(account);
                  const selected = createBankAccount === bankLabel;
                  return (
                    <Pressable
                      key={account.id}
                      onPress={() => {
                        setCreateBankAccount(bankLabel);
                        setShowBankAccountPicker(false);
                      }}
                      style={[
                        styles.bankOptionRow,
                        {
                          borderColor: selected ? colors.primary : colors.border,
                          backgroundColor: selected ? colors.primary + "14" : colors.surface,
                        },
                      ]}
                      >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.bankOptionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          {account.bankName || "UPI"}
                        </Text>
                        <Text style={[styles.bankOptionMeta, { color: colors.textSecondary }]}>
                          {account.accountNumber || account.upiId || "Saved account"}
                        </Text>
                        <Text style={[styles.bankOptionMeta, { color: colors.textTertiary }]}>
                          {account.holderName || account.employeeName || "Account holder"}
                          {account.employeeName ? ` • ${account.employeeName}` : ""}
                          {matched ? " • Suggested" : ""}
                        </Text>
                      </View>
                      <Ionicons
                        name={selected ? "checkmark-circle" : "ellipse-outline"}
                        size={20}
                        color={selected ? colors.primary : colors.textTertiary}
                      />
                    </Pressable>
                  );
                })
              )}

              <Pressable
                onPress={() => {
                  setShowBankAccountPicker(false);
                  router.push("/bank-accounts" as any);
                }}
                style={[styles.pickerAddAction, { borderColor: colors.primary, backgroundColor: colors.primary + "10" }]}
              >
                <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
                <Text style={[styles.pickerAddActionText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                  Add New Bank Account
                </Text>
              </Pressable>
            </ScrollView>
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
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  salaryCard: { 
    borderRadius: 24, 
    padding: 20,
    borderWidth: 1,
    boxShadow: "0px 10px 26px rgba(10, 35, 62, 0.12)",
  },
  salaryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  salaryHeaderLeft: { flex: 1, gap: 2 },
  salaryName: { fontSize: 15 },
  salaryMonth: { fontSize: 12 },
  salaryLabel: { fontSize: 12 },
  salaryPeriod: { fontSize: 11 },
  salaryHeaderRight: { alignItems: "flex-end", gap: 4 },
  netPay: { fontSize: 16 },
  incentiveTag: { fontSize: 10, textTransform: "uppercase" as const, letterSpacing: 0.4 },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: { fontSize: 10, textTransform: "capitalize" as const },
  breakdown: { marginTop: 12 },
  breakdownDivider: { height: 1, marginBottom: 12 },
  breakdownSection: { fontSize: 12, marginBottom: 8, textTransform: "uppercase" as const, letterSpacing: 0.5 },
  breakdownRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  breakdownLabel: { fontSize: 13 },
  breakdownValue: { fontSize: 13 },
  netPayRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  actionRow: {
    marginTop: 12,
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  secondaryActionButton: {
    flexGrow: 1,
    minWidth: 102,
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
  },
  secondaryActionButtonText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  destructiveActionButton: {
    flexGrow: 0,
  },
  payButton: {
    marginTop: 12,
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  payButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  netPayLabel: { fontSize: 15 },
  netPayValue: { fontSize: 15 },
  expandIndicator: { alignItems: "center", marginTop: 8 },
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 20,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(2, 6, 23, 0.55)",
  },
  createModalCard: {
    maxHeight: "92%",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
  },
  createHeroCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 14,
  },
  createHeroHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  createHeroTitleWrap: {
    flex: 1,
    gap: 4,
  },
  createHeroTitle: {
    fontSize: 17,
    letterSpacing: -0.3,
  },
  createHeroSubtitle: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  createHeroBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  createHeroBadgeText: {
    fontSize: 11.5,
  },
  sectionLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  sectionBlock: {
    gap: 10,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  employeeDropdownField: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  employeePickerValueWrap: {
    flex: 1,
    gap: 2,
  },
  employeePickerValue: {
    fontSize: 13.5,
    fontFamily: "Inter_500Medium",
  },
  employeePickerHint: {
    fontSize: 11.5,
  },
  employeeFieldActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  employeeDropdownInput: {
    flex: 1,
    fontSize: 13.5,
    paddingVertical: 0,
  },
  dropdownHint: {
    fontSize: 11.5,
    lineHeight: 17,
  },
  employeeDropdown: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: "hidden",
  },
  employeeDropdownScroll: {
    maxHeight: 220,
  },
  selectedEmployeeCard: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  selectedEmployeeName: {
    fontSize: 14.5,
  },
  selectedEmployeeMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  selectedEmployeeActions: {
    alignItems: "center",
    gap: 10,
  },
  clearEmployeeButton: {
    width: 26,
    height: 26,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  employeeList: {
    gap: 8,
    marginBottom: 6,
  },
  employeeRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  employeeName: {
    fontSize: 13.5,
  },
  employeeMeta: {
    fontSize: 11.5,
    marginTop: 2,
  },
  emptyPickerText: {
    fontSize: 12.5,
    textAlign: "center",
    paddingVertical: 6,
  },
  formRow: {
    gap: 6,
  },
  formGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  gridField: {
    flexGrow: 1,
    flexBasis: 150,
  },
  formLabel: {
    fontSize: 12.5,
  },
  formInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  dateInput: {
    justifyContent: "center",
    minHeight: 46,
  },
  bankSelector: {
    borderWidth: 1,
    borderRadius: 12,
    minHeight: 46,
    justifyContent: "center",
    paddingVertical: 4,
    overflow: "hidden",
  },
  bankPickerTrigger: {
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  bankPickerTriggerTextWrap: {
    flex: 1,
    gap: 2,
  },
  bankPickerValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  bankPickerHint: {
    fontSize: 11.5,
  },
  addBankButton: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
  },
  addBankButtonText: {
    fontSize: 12.5,
  },
  pickerSheetCard: {
    maxHeight: "72%",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    overflow: "hidden",
  },
  pickerSheetHeader: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  pickerSheetTitle: {
    fontSize: 17,
  },
  pickerSheetSubtitle: {
    fontSize: 12.5,
    marginTop: 2,
  },
  pickerSheetContent: {
    padding: 16,
    gap: 10,
    paddingBottom: 4,
  },
  pickerSheetBody: {
    padding: 16,
    gap: 10,
    paddingBottom: 4,
    maxHeight: 380,
  },
  pickerSearchInput: {
    borderWidth: 1,
    borderRadius: 14,
    minHeight: 48,
    paddingHorizontal: 14,
    fontSize: 13.5,
  },
  pickerListScroll: {
    maxHeight: 280,
  },
  pickerListContent: {
    gap: 10,
    paddingBottom: 4,
  },
  bankOptionRow: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bankOptionTitle: {
    fontSize: 14,
    marginBottom: 2,
  },
  bankOptionMeta: {
    fontSize: 12,
    marginTop: 1,
  },
  bankPickerEmptyState: {
    minHeight: 108,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  pickerAddAction: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
  },
  pickerAddActionText: {
    fontSize: 13,
  },
  summaryStatsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  summaryStatCard: {
    flexGrow: 1,
    minWidth: 96,
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    gap: 6,
  },
  summaryStatDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  summaryStatLabel: {
    fontSize: 11.5,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  summaryStatValue: {
    fontSize: 14,
  },
  summaryCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    gap: 12,
  },
  summaryCardHeader: {
    gap: 3,
  },
  summaryCardTitle: {
    fontSize: 15.5,
  },
  summaryCardSubtitle: {
    fontSize: 12,
  },
  summaryValueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  summaryValueLabel: {
    fontSize: 13,
  },
  summaryValueText: {
    fontSize: 14,
  },
  summaryNetRow: {
    borderTopWidth: 1,
    paddingTop: 12,
  },
  summaryNetLabel: {
    fontSize: 15,
  },
  summaryNetValue: {
    fontSize: 16.5,
  },
  notesInput: {
    minHeight: 78,
    textAlignVertical: "top",
  },
  modalCard: {
    maxHeight: "92%",
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(148, 163, 184, 0.45)",
  },
  modalTitle: {
    fontSize: 16,
    letterSpacing: -0.2,
  },
  modalContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 20,
    gap: 10,
  },
  slipTopCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  slipTopHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 2,
  },
  slipCompany: {
    fontSize: 16,
  },
  slipSubtext: {
    fontSize: 12.5,
  },
  slipMeta: {
    fontSize: 12,
  },
  slipSection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  slipSectionTitle: {
    fontSize: 12.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  slipNetCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  slipNetLabel: {
    fontSize: 14.5,
  },
  slipNetValue: {
    fontSize: 16,
  },
  modalFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(148, 163, 184, 0.45)",
    flexDirection: "row",
    padding: 12,
    gap: 8,
  },
  modalFooterButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
  },
  modalFooterButtonText: {
    fontSize: 12.5,
  },
});

