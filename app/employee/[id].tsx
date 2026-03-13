import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import Animated, { FadeInDown } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import Colors from "@/constants/colors";
import { getAttendance } from "@/lib/storage";
import { getEmployees, getSalaries } from "@/lib/employee-data";
import type { Employee, AttendanceRecord, SalaryRecord } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";

export default function EmployeeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [salary, setSalary] = useState<SalaryRecord | null>(null);

  useEffect(() => {
    (async () => {
      const [emps, att, sal] = await Promise.all([getEmployees(), getAttendance(), getSalaries()]);
      const emp = emps.find((e) => e.id === id);
      setEmployee(emp || null);
      setAttendance(att.filter((a) => a.userId === id));
      setSalary(sal.find((s) => s.employeeId === id) || null);
    })();
  }, [id]);

  if (!employee) {
    return (
      <AppCanvas>
        <View style={[styles.loadingContainer, { justifyContent: "center", alignItems: "center" }]}>
          <Text style={{ color: colors.textSecondary, fontFamily: "Inter_400Regular" }}>Loading...</Text>
        </View>
      </AppCanvas>
    );
  }

  const statusColor =
    employee.status === "active" ? colors.statusActive :
    employee.status === "idle" ? colors.statusIdle : colors.statusOffline;

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>Profile</Text>
          <View style={{ width: 24 }} />
        </View>

        <Animated.View entering={FadeInDown.duration(400)}>
          <LinearGradient
            colors={isDark ? [colors.heroEnd, colors.heroStart] : [colors.heroStart, colors.heroEnd]}
            style={styles.profileCard}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <View style={styles.profileAvatar}>
              <Text style={styles.profileAvatarText}>
                {employee.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
              </Text>
            </View>
            <Text style={styles.profileName}>{employee.name}</Text>
            <Text style={styles.profileDept}>{employee.department}</Text>
            <View style={styles.profileStatusRow}>
              <View style={[styles.profileStatusDot, { backgroundColor: statusColor }]} />
              <Text style={styles.profileStatusText}>{employee.status}</Text>
            </View>
          </LinearGradient>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(400).delay(100)} style={[styles.infoCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          <InfoItem icon="mail-outline" label="Email" value={employee.email} colors={colors} />
          <InfoItem icon="call-outline" label="Phone" value={employee.phone} colors={colors} />
          <InfoItem icon="business-outline" label="Branch" value={employee.branch} colors={colors} />
          <InfoItem icon="shield-outline" label="Role" value={employee.role.toUpperCase()} colors={colors} />
          <InfoItem
            icon="calendar-outline"
            label="Joined"
            value={new Date(employee.joinDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            colors={colors}
            last
          />
        </Animated.View>

        {salary && (
          <Animated.View entering={FadeInDown.duration(400).delay(200)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Latest Salary
            </Text>
            <View style={[styles.salaryCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <View style={styles.salaryRow}>
                <Text style={[styles.salaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Gross Pay
                </Text>
                <Text style={[styles.salaryValue, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  INR {salary.grossPay.toLocaleString()}
                </Text>
              </View>
              <View style={styles.salaryRow}>
                <Text style={[styles.salaryLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  Deductions
                </Text>
                <Text style={[styles.salaryValue, { color: colors.danger, fontFamily: "Inter_600SemiBold" }]}>
                  - INR {salary.totalDeductions.toLocaleString()}
                </Text>
              </View>
              <View style={[styles.salaryRow, { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, marginTop: 4 }]}>
                <Text style={[styles.salaryLabel, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                  Net Pay
                </Text>
                <Text style={[styles.salaryValue, { color: colors.success, fontFamily: "Inter_700Bold" }]}>
                  INR {salary.netPay.toLocaleString()}
                </Text>
              </View>
            </View>
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.duration(400).delay(300)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Recent Attendance
          </Text>
          {attendance.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                No attendance records
              </Text>
            </View>
          ) : (
            <View style={[styles.attendanceCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {attendance.slice(0, 5).map((a, idx) => (
                <View
                  key={a.id}
                  style={[
                    styles.attendanceItem,
                    idx < Math.min(attendance.length, 5) - 1 && { borderBottomWidth: 0.5, borderBottomColor: colors.borderLight },
                  ]}
                >
                  <Ionicons
                    name={a.type === "checkin" ? "log-in-outline" : "log-out-outline"}
                    size={18}
                    color={a.type === "checkin" ? colors.success : colors.danger}
                  />
                  <Text style={[styles.attendanceText, { color: colors.text, fontFamily: "Inter_500Medium" }]}>
                    {a.type === "checkin" ? "Check In" : "Check Out"}
                  </Text>
                  <Text style={[styles.attendanceTime, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
                    {new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Animated.View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

function InfoItem({
  icon,
  label,
  value,
  colors,
  last,
}: {
  icon: string;
  label: string;
  value: string;
  colors: typeof Colors.light;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoItem, !last && { borderBottomWidth: 0.5, borderBottomColor: colors.borderLight }]}>
      <Ionicons name={icon as any} size={18} color={colors.textTertiary} />
      <Text style={[styles.infoLabel, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: colors.text, fontFamily: "Inter_500Medium" }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  profileCard: {
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    marginBottom: 16,
  },
  profileAvatar: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  profileAvatarText: {
    color: "#fff",
    fontSize: 26,
    fontFamily: "Inter_700Bold",
  },
  profileName: {
    color: "#fff",
    fontSize: 22,
    fontFamily: "Inter_700Bold",
  },
  profileDept: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
  },
  profileStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
  },
  profileStatusDot: { width: 8, height: 8, borderRadius: 4 },
  profileStatusText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textTransform: "capitalize" as const,
  },
  infoCard: { borderRadius: 16, overflow: "hidden", marginBottom: 20, borderWidth: 1 },
  infoItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  infoLabel: { fontSize: 13, width: 60 },
  infoValue: { fontSize: 14, flex: 1, textAlign: "right" },
  sectionTitle: { fontSize: 16, marginBottom: 10 },
  salaryCard: { borderRadius: 16, padding: 16, marginBottom: 20, gap: 6, borderWidth: 1 },
  salaryRow: { flexDirection: "row", justifyContent: "space-between" },
  salaryLabel: { fontSize: 13 },
  salaryValue: { fontSize: 14 },
  emptyCard: { borderRadius: 16, padding: 24, alignItems: "center", borderWidth: 1 },
  emptyText: { fontSize: 13 },
  attendanceCard: { borderRadius: 16, overflow: "hidden", borderWidth: 1 },
  attendanceItem: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  attendanceText: { flex: 1, fontSize: 14 },
  attendanceTime: { fontSize: 12 },
});
