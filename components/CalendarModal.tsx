import React, { useState } from "react";
import { Modal, View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}

export function CalendarModal({
  visible,
  value,
  onClose,
  onSelect,
  colors,
}: {
  visible: boolean;
  value: string;
  onClose: () => void;
  onSelect: (dateStr: string) => void;
  colors: any;
}) {
  const initDate = value ? new Date(value) : new Date();
  if (isNaN(initDate.getTime())) {
    initDate.setTime(Date.now());
  }
  const [currentDate, setCurrentDate] = useState(initDate);
  const [viewMode, setViewMode] = useState<"days" | "months" | "years">("days");

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };
  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const setYear = (y: number) => {
    setCurrentDate(new Date(y, month, 1));
    setViewMode("days");
  };

  const setMonth = (m: number) => {
    setCurrentDate(new Date(year, m, 1));
    setViewMode("days");
  };

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const days = [];
  for (let i = 0; i < firstDay; i++) {
    days.push(null);
  }
  for (let i = 1; i <= daysInMonth; i++) {
    days.push(i);
  }

  const isToday = (d: number | null) => {
    if (!d) return false;
    const today = new Date();
    return (
      today.getDate() === d &&
      today.getMonth() === month &&
      today.getFullYear() === year
    );
  };

  const isSelected = (d: number | null) => {
    if (!d || !value) return false;
    const pDate = new Date(value);
    if (isNaN(pDate.getTime())) return false;
    return (
      pDate.getDate() === d &&
      pDate.getMonth() === month &&
      pDate.getFullYear() === year
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: "rgba(0,0,0,0.55)" }]}>
        <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
          {viewMode === "days" && (
            <>
              <View style={styles.header}>
                <Pressable onPress={handlePrevMonth} hitSlop={10}>
                  <Ionicons name="chevron-back" size={24} color={colors.text} />
                </Pressable>
                <Pressable onPress={() => setViewMode("years")} hitSlop={10}>
                  <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                    {MONTHS[month]} {year}
                  </Text>
                </Pressable>
                <Pressable onPress={handleNextMonth} hitSlop={10}>
                  <Ionicons name="chevron-forward" size={24} color={colors.text} />
                </Pressable>
              </View>

              <View style={styles.weekDays}>
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day, i) => (
                  <Text key={i} style={[styles.weekDay, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
                    {day}
                  </Text>
                ))}
              </View>

              <View style={styles.grid}>
                {days.map((d, i) => (
                  <Pressable
                    key={i}
                    style={[
                      styles.dayCell,
                      isSelected(d) && { backgroundColor: colors.primary },
                      !d && { backgroundColor: "transparent" },
                    ]}
                    onPress={() => {
                      if (d) {
                        const str = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                        onSelect(str);
                        onClose();
                      }
                    }}
                  >
                    {d ? (
                      <Text
                        style={[
                          styles.dayText,
                          { color: colors.text, fontFamily: "Inter_400Regular" },
                          isToday(d) && { color: colors.primary, fontFamily: "Inter_700Bold" },
                          isSelected(d) && { color: "#FFF", fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        {d}
                      </Text>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {viewMode === "years" && (
            <ScrollView style={{ maxHeight: 300 }}>
              <View style={styles.grid}>
                {Array.from({ length: 40 }, (_, i) => year - 20 + i).map((y) => (
                  <Pressable
                    key={y}
                    onPress={() => setYear(y)}
                    style={[styles.yearCell, y === year && { backgroundColor: colors.primary + "20" }]}
                  >
                    <Text
                      style={{
                        color: y === year ? colors.primary : colors.text,
                        fontFamily: y === year ? "Inter_700Bold" : "Inter_500Medium",
                      }}
                    >
                      {y}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}

          {viewMode === "months" && (
            <ScrollView style={{ maxHeight: 300 }}>
              <View style={styles.grid}>
                {MONTHS.map((mName, i) => (
                  <Pressable
                    key={i}
                    onPress={() => setMonth(i)}
                    style={[styles.yearCell, i === month && { backgroundColor: colors.primary + "20" }]}
                  >
                    <Text
                      style={{
                        color: i === month ? colors.primary : colors.text,
                        fontFamily: i === month ? "Inter_700Bold" : "Inter_500Medium",
                      }}
                    >
                      {mName.slice(0, 3)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}

          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={10}>
            <Text style={{ color: colors.textSecondary, fontFamily: "Inter_600SemiBold" }}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 340,
    padding: 20,
    borderRadius: 24,
    borderWidth: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 16,
  },
  weekDays: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginBottom: 10,
  },
  weekDay: {
    width: "14%",
    textAlign: "center",
    fontSize: 13,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  dayCell: {
    width: "14%",
    aspectRatio: 1,
    justifyContent: "center",
    alignItems: "center",
    borderRadius: 20,
    marginVertical: 2,
  },
  dayText: {
    fontSize: 14,
  },
  yearCell: {
    width: "30%",
    paddingVertical: 12,
    alignItems: "center",
    margin: "1.5%",
    borderRadius: 12,
  },
  closeBtn: {
    marginTop: 20,
    alignItems: "center",
    paddingVertical: 12,
  },
});
