import React, { useState, useEffect, useCallback, useMemo } from "react";
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
import { addAuditLog, getIncentivePayouts, updateSalaryStatus } from "@/lib/storage";
import { getEmployees, getSalaries, saveSalaryRecord } from "@/lib/employee-data";
import type { Employee, IncentivePayout, SalaryRecord } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
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

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
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
  printingSlipId,
}: {
  salary: SalaryRecord;
  incentives?: IncentiveSummary;
  colors: typeof Colors.light;
  isAdmin: boolean;
  onMarkPaid: (salaryId: string) => void;
  onViewSlip: (salary: SalaryRecord) => void;
  onPrintSlip: (salary: SalaryRecord) => void;
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
          {employee.department} • {employee.branch}
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
  const [createAmount, setCreateAmount] = useState("");
  const [createNote, setCreateNote] = useState("");
  const [savingSalary, setSavingSalary] = useState(false);
  const isAdmin = user?.role === "admin";

  const loadData = useCallback(async () => {
    const [salaryData, employees, payouts] = await Promise.all([
      getSalaries(),
      getEmployees(),
      getIncentivePayouts(),
    ]);
    if (!user) {
      setSalaries([]);
      setEmployees([]);
      setIncentivePayouts([]);
      return;
    }
    setEmployees(employees);
    setIncentivePayouts(Array.isArray(payouts) ? payouts : []);
    if (isAdmin) {
      setSalaries(salaryData);
      return;
    }

    const mappedEmployeeIds = new Set(
      employees
        .filter((employee) => employee.email === user.email || employee.name === user.name)
        .map((employee) => employee.id)
    );
    const filtered = salaryData.filter(
      (salary) =>
        salary.employeeId === user.id ||
        salary.employeeName === user.name ||
        mappedEmployeeIds.has(salary.employeeId)
    );
    setSalaries(filtered);
  }, [isAdmin, user]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleMarkPaid = useCallback(
    async (salaryId: string) => {
      if (!isAdmin || !user) return;
      await updateSalaryStatus(salaryId, "paid");
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
      await updateSalaryStatus(salary.id, "paid");
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
    setCreateAmount("");
    setCreateNote("");
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

  const selectableEmployees = useMemo(
    () => employees.filter((employee) => employee.role !== "admin"),
    [employees]
  );

  const filteredEmployees = useMemo(() => {
    const q = createSearch.trim().toLowerCase();
    if (!q) return selectableEmployees;
    return selectableEmployees.filter((employee) => {
      return (
        employee.name.toLowerCase().includes(q) ||
        employee.email.toLowerCase().includes(q) ||
        employee.department.toLowerCase().includes(q) ||
        employee.branch.toLowerCase().includes(q)
      );
    });
  }, [createSearch, selectableEmployees]);

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

    const amount = parseAmountInput(createAmount);
    if (!amount || amount <= 0) {
      Alert.alert("Invalid Amount", "Enter a valid salary amount.");
      return;
    }
    const monthSource = periodStart || paymentDate || "";
    const monthKey = /^\d{4}-\d{2}/.test(monthSource) ? monthSource.slice(0, 7) : getDefaultMonthKey();
    const grossPay = amount;
    const totalDeductions = 0;
    const netPay = amount;

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
        note: note || undefined,
        month: monthKey,
        basic: amount,
        hra: 0,
        transport: 0,
        medical: 0,
        bonus: 0,
        overtime: 0,
        tax: 0,
        pf: 0,
        insurance: 0,
        grossPay,
        totalDeductions,
        netPay,
        status: "approved",
      };

      const result = await saveSalaryRecord(salaryRecord);

      await addAuditLog({
        id: Crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        action: "Salary Added",
        details: `Added salary for ${createEmployeeName} (${monthKey})`,
        timestamp: new Date().toISOString(),
        module: "Salary",
      });

      if (result.dolibarr && !result.dolibarr.ok) {
        Alert.alert(
          "Dolibarr Sync Warning",
          result.dolibarr.message || "Salary saved, but Dolibarr sync failed."
        );
      }

      if (!result.synced) {
        Alert.alert(
          "Offline Salary Saved",
          "Salary saved locally. Connect to the backend to sync company-wide."
        );
      }

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
    createAmount,
    createNote,
    isAdmin,
    loadData,
    user,
  ]);

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
              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Employee</Text>
              <TextInput
                value={createSearch}
                onChangeText={setCreateSearch}
                placeholder="Search employee..."
                placeholderTextColor={colors.textTertiary}
                style={[styles.searchInput, { color: colors.text, borderColor: colors.border }]}
              />
              <View style={styles.employeeList}>
                {filteredEmployees.length === 0 ? (
                  <Text style={[styles.emptyPickerText, { color: colors.textSecondary }]}>
                    No employees found.
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
                      }}
                    />
                  ))
                )}
              </View>

              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Salary Details</Text>
              <View style={styles.formRow}>
                <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Label</Text>
                <TextInput
                  value={createLabel}
                  onChangeText={setCreateLabel}
                  placeholder="Salary Payment"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                />
              </View>
              <View style={styles.formRow}>
                <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Period Start (YYYY-MM-DD)</Text>
                <TextInput
                  value={createPeriodStart}
                  onChangeText={setCreatePeriodStart}
                  placeholder="2026-03-01"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                />
              </View>
              <View style={styles.formRow}>
                <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Period End (YYYY-MM-DD)</Text>
                <TextInput
                  value={createPeriodEnd}
                  onChangeText={setCreatePeriodEnd}
                  placeholder="2026-03-31"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                />
              </View>
              <AmountField label="Amount" value={createAmount} onChangeText={setCreateAmount} colors={colors} />

              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Payment</Text>
              <View style={styles.formRow}>
                <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Payment Date (YYYY-MM-DD)</Text>
                <TextInput
                  value={createPaymentDate}
                  onChangeText={setCreatePaymentDate}
                  placeholder="2026-03-31"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                />
              </View>
              <View style={styles.formRow}>
                <Text style={[styles.formLabel, { color: colors.textSecondary }]}>Payment Mode</Text>
                <TextInput
                  value={createPaymentMode}
                  onChangeText={setCreatePaymentMode}
                  placeholder="Bank Transfer / Cash / Cheque"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.formInput, { color: colors.text, borderColor: colors.border }]}
                />
              </View>

              <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>Notes</Text>
              <TextInput
                value={createNote}
                onChangeText={setCreateNote}
                placeholder="Optional notes for this salary entry"
                placeholderTextColor={colors.textTertiary}
                style={[styles.formInput, { color: colors.text, borderColor: colors.border, minHeight: 70 }]}
                multiline
              />
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
  },
  secondaryActionButton: {
    flex: 1,
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
  sectionLabel: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
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
  formLabel: {
    fontSize: 12.5,
  },
  formInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
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

