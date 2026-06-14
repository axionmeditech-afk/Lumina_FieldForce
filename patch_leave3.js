const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

const calendarJSX = `
        {/* --- Company Calendar --- */}
        <Animated.View entering={FadeInDown.duration(450).delay(150)}>
          <LeaveCalendar
            month={currentMonth}
            year={currentYear}
            leaves={leaves}
            holidays={holidays}
            weekendDays={weekendDays}
            isPrivileged={isPrivileged}
            colors={colors}
            onAddHoliday={handleAddHoliday}
            onDeleteHoliday={handleDeleteHoliday}
            onConfigureWeekends={() => { setTempWeekendDays(weekendDays); setShowWeekendModal(true); }}
          />
        </Animated.View>
`;

if (!content.includes("LeaveCalendar month={currentMonth}")) {
  content = content.replace(
    "{/* ─── Stats ───────────────────────────────────── */}",
    calendarJSX + "\n        {/* ─── Stats ───────────────────────────────────── */}"
  );
}

const modalJSX = `
      <Modal visible={showWeekendModal} transparent animationType="fade">
        <View style={styles.modalOuter}>
          <Pressable style={styles.modalBg} onPress={() => setShowWeekendModal(false)} />
          <View style={[styles.modalSheet, { backgroundColor: isDark ? P.slate900 : P.white }]}>
            <Text style={[styles.modalTitle, { color: colors.text, marginBottom: 16 }]}>Configure Weekends</Text>
            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((dayName, i) => (
              <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderColor: cardBorder }}>
                <Text style={{ color: colors.text, fontSize: 16 }}>{dayName}</Text>
                <Switch
                  value={tempWeekendDays.includes(i)}
                  onValueChange={(val) => setTempWeekendDays(prev => val ? [...prev, i] : prev.filter(d => d !== i))}
                />
              </View>
            ))}
            <Pressable onPress={handleSaveWeekends} style={[styles.submitBtn, { marginTop: 24, backgroundColor: P.blue }]}>
              <Text style={styles.submitTxt}>Save Weekends</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
`;

if (!content.includes("visible={showWeekendModal}")) {
  content = content.replace(
    "{/* Calendar */}",
    modalJSX + "\n      {/* Calendar */}"
  );
}

fs.writeFileSync(path, content, "utf8");
console.log("Injected JSX cleanly");
