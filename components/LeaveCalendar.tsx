import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export function LeaveCalendar({
  month,
  year,
  leaves,
  holidays,
  weekendDays,
  isPrivileged,
  colors,
  onAddHoliday,
  onDeleteHoliday,
  onConfigureWeekends,
  onMonthYearChange,
}: any) {
  const handlePrevMonth = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (month === 1) {
      onMonthYearChange?.(12, year - 1);
    } else {
      onMonthYearChange?.(month - 1, year);
    }
  };

  const handleNextMonth = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (month === 12) {
      onMonthYearChange?.(1, year + 1);
    } else {
      onMonthYearChange?.(month + 1, year);
    }
  };
  const daysInMonth = getDaysInMonth(year, month - 1);
  const firstDay = getFirstDayOfMonth(year, month - 1);
  const days = Array(firstDay).fill(null).concat(Array.from({ length: daysInMonth }, (_, i) => i + 1));

  const isWeekend = (dayNumber: number | null) => {
    if (!dayNumber) return false;
    const dateObj = new Date(year, month - 1, dayNumber);
    return weekendDays.includes(dateObj.getDay());
  };

  const getDayHoliday = (d: number | null) => {
    if (!d) return null;
    return holidays.find((h: any) => h.day === d && h.month === month && (h.year === year || h.year === 0 || !h.year));
  };

  const getDayLeaves = (d: number | null) => {
    if (!d) return [];
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return leaves.filter((l: any) => l.leaveDate === dateStr && l.status === "approved");
  };

  const handleDayPress = (d: number | null) => {
    if (!d) return;
    const existingHoliday = getDayHoliday(d);
    
    if (existingHoliday) {
      if (isPrivileged) {
        Alert.alert("Manage Holiday", `Remove ${existingHoliday.code || "this holiday"}?`, [
          { text: "Keep", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: () => onDeleteHoliday(existingHoliday.id) }
        ]);
      }
    } else {
      if (isPrivileged) {
        Alert.alert("Manage", `Add a holiday or collective leave for ${d} ${MONTHS[month - 1]}?`, [
          { text: "Collective Leave", onPress: () => onAddHoliday(d, month, year, true) },
          { text: "Public Holiday", onPress: () => onAddHoliday(d, month, year, false) },
          { text: "Cancel", style: "cancel" }
        ]);
      }
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
      <View style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="calendar" size={18} color={colors.primary} />
          <Pressable onPress={handlePrevMonth} style={{ padding: 4 }}>
            <Ionicons name="chevron-back" size={16} color={colors.textSecondary} />
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>{MONTHS[month - 1]} {year}</Text>
          <Pressable onPress={handleNextMonth} style={{ padding: 4 }}>
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
        {isPrivileged && (
          <Pressable onPress={onConfigureWeekends} style={[styles.configBtn, { backgroundColor: colors.primary + "15" }]}>
            <Ionicons name="settings-outline" size={14} color={colors.primary} />
            <Text style={[styles.configTxt, { color: colors.primary }]}>Weekends</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.weekDays}>
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((dayName, i) => (
          <Text key={i} style={[styles.weekDay, { color: weekendDays.includes(i) ? colors.textTertiary : colors.textSecondary }]}>
            {dayName}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {days.map((d, i) => {
          const weekend = isWeekend(d);
          const holiday = getDayHoliday(d);
          const approvedLeaves = getDayLeaves(d);
          const hasLeaves = approvedLeaves.length > 0;

          return (
            <Pressable
              key={i}
              style={[
                styles.dayCell,
                !d && { backgroundColor: "transparent" },
                d && weekend && { backgroundColor: colors.backgroundElevated, opacity: 0.5 },
                holiday && { backgroundColor: "#FFF7ED", borderColor: "#F97316", borderWidth: 1 },
                hasLeaves && !holiday && { backgroundColor: "#DBEAFE" },
              ]}
              onPress={() => {
                void Haptics.selectionAsync().catch(() => {});
                handleDayPress(d);
              }}
            >
              {d && (
                <>
                  <Text style={[
                    styles.dayText, 
                    { color: holiday ? "#EA580C" : hasLeaves ? "#2563EB" : colors.text },
                    (holiday || hasLeaves) && { fontFamily: "Inter_700Bold" }
                  ]}>
                    {d}
                  </Text>
                  <View style={styles.dotRow}>
                    {holiday && <View style={[styles.dot, { backgroundColor: "#EA580C" }]} />}
                    {hasLeaves && <View style={[styles.dot, { backgroundColor: "#2563EB" }]} />}
                  </View>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}><View style={[styles.legendColor, { backgroundColor: "#FFF7ED", borderColor: "#F97316", borderWidth: 1 }]} /><Text style={[styles.legendTxt, { color: colors.textSecondary }]}>Holiday</Text></View>
        <View style={styles.legendItem}><View style={[styles.legendColor, { backgroundColor: "#DBEAFE" }]} /><Text style={[styles.legendTxt, { color: colors.textSecondary }]}>Approved Leaves</Text></View>
        <View style={styles.legendItem}><View style={[styles.legendColor, { backgroundColor: colors.backgroundElevated, opacity: 0.5 }]} /><Text style={[styles.legendTxt, { color: colors.textSecondary }]}>Weekend</Text></View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { fontFamily: "Inter_600SemiBold", fontSize: 16 },
  configBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  configTxt: { fontSize: 12, fontFamily: "Inter_500Medium" },
  weekDays: { flexDirection: "row", marginBottom: 8 },
  weekDay: { flex: 1, textAlign: "center", fontSize: 12, fontFamily: "Inter_600SemiBold" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  dayCell: { width: "14.28%", aspectRatio: 1, justifyContent: "center", alignItems: "center", borderRadius: 8 },
  dayText: { fontSize: 14, fontFamily: "Inter_400Regular" },
  dot: { width: 4, height: 4, borderRadius: 2 },
  dotRow: { flexDirection: "row", gap: 3, marginTop: 2 },
  legend: { flexDirection: "row", marginTop: 12, gap: 12, flexWrap: "wrap" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendColor: { width: 12, height: 12, borderRadius: 3 },
  legendTxt: { fontSize: 11, fontFamily: "Inter_400Regular" },
});
