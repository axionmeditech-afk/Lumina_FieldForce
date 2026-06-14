const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Add imports
content = content.replace(
  "getPublicHolidaysRemote,\n} from \"@/lib/attendance-api\";",
  "getPublicHolidaysRemote,\n  addPublicHolidayRemote,\n  deletePublicHolidayRemote,\n  getWeekendConfigRemote,\n  saveWeekendConfigRemote,\n} from \"@/lib/attendance-api\";\nimport { LeaveCalendar } from \"@/components/LeaveCalendar\";\nimport { Switch } from \"react-native\";"
);

// 2. Add state
content = content.replace(
  "const [activeTab, setActiveTab] = useState<TabKey>(\"my\");",
  "const [activeTab, setActiveTab] = useState<TabKey>(\"my\");\n  const [weekendDays, setWeekendDays] = useState<number[]>([0]);\n  const [showWeekendModal, setShowWeekendModal] = useState(false);\n  const [tempWeekendDays, setTempWeekendDays] = useState<number[]>([]);"
);

// 3. Replace fetchData (using a more robust match)
content = content.replace(
  /const fetchData = useCallback\(async \(\) => \{.*?\n      setLoading\(false\);\n      setRefreshing\(false\);\n    \}\n  \}, \[currentMonth, currentYear\]\);/s,
  `const fetchData = useCallback(async () => {
    try {
      setErrorMsg(null);
      const [leavesData, summaryData, holidaysData, weekendData] = await Promise.allSettled([
        listLeaveRequestsRemote({ year: currentYear }),
        getLeavesSummaryRemote({ month: currentMonth, year: currentYear }),
        getPublicHolidaysRemote(),
        getWeekendConfigRemote(),
      ]);
      if (leavesData.status === "fulfilled") setLeaves(leavesData.value);
      if (summaryData.status === "fulfilled") setSummaries(summaryData.value);
      if (holidaysData.status === "fulfilled") setHolidays(holidaysData.value);
      if (weekendData.status === "fulfilled") setWeekendDays(weekendData.value.weekendDays);
    } catch (err) {
      setErrorMsg("Unable to load leave data. Pull down to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentMonth, currentYear]);`
);

// 4. Add Handlers
const handlers = `
  const handleAddHoliday = async (day: number, month: number, year: number) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await addPublicHolidayRemote({ day, month, year, code: "Collective Leave" });
      setHolidays(prev => [...prev, res]);
    } catch {
      Alert.alert("Error", "Could not add holiday");
    }
  };
  const handleDeleteHoliday = async (id: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await deletePublicHolidayRemote(id);
      setHolidays(prev => prev.filter(h => h.id !== id));
    } catch {
      Alert.alert("Error", "Could not remove holiday");
    }
  };
  const handleSaveWeekends = async () => {
    try {
      await saveWeekendConfigRemote(tempWeekendDays);
      setWeekendDays(tempWeekendDays);
      setShowWeekendModal(false);
    } catch {
      Alert.alert("Error", "Could not save weekends");
    }
  };
`;
content = content.replace(
  "const handleDelete = async (leaveId: string) => {",
  handlers + "\n  const handleDelete = async (leaveId: string) => {"
);

// 5. Inject Calendar UI under Hero
const calendarJSX = `
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
content = content.replace(
  "{/* ─── Stats ─── */}",
  calendarJSX + "\n        {/* ─── Stats ─── */}"
);

// 6. Inject Modal UI at the end
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
content = content.replace(
  "{/* Calendar */}",
  modalJSX + "\n      {/* Calendar */}"
);

fs.writeFileSync(path, content, "utf8");
console.log("Frontend patched successfully");
