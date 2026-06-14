const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Add calendarTarget state
content = content.replace(
  "const [showCalendar, setShowCalendar] = useState(false);",
  "const [showCalendar, setShowCalendar] = useState(false);\n  const [calendarTarget, setCalendarTarget] = useState<\"start\" | \"end\" | \"collStart\" | \"collEnd\">(\"start\");"
);

// 2. Replace onPress for Start Date
content = content.replace(
  /<Pressable style=\{styles\.dateBtn\} onPress=\{\(\) => setShowCalendar\(true\)\}>\s*<Ionicons name="calendar-outline".*?>\{formStartDate \? new Date\(formStartDate\)\.toLocaleDateString\(\) : "Select Start Date"\}<\/Text>\s*<\/Pressable>/g,
  `<Pressable style={styles.dateBtn} onPress={() => { setCalendarTarget("start"); setShowCalendar(true); }}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formStartDate ? colors.text : colors.textSecondary }}>{formStartDate ? new Date(formStartDate).toLocaleDateString() : "Select Start Date"}</Text>
            </Pressable>`
);

// 3. Replace onPress for End Date
content = content.replace(
  /<Pressable style=\{styles\.dateBtn\} onPress=\{\(\) => setShowCalendar\(true\)\}>\s*<Ionicons name="calendar-outline".*?>\{formEndDate \? new Date\(formEndDate\)\.toLocaleDateString\(\) : "Same as Start Date"\}<\/Text>\s*<\/Pressable>/g,
  `<Pressable style={styles.dateBtn} onPress={() => { setCalendarTarget("end"); setShowCalendar(true); }}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formEndDate ? colors.text : colors.textSecondary }}>{formEndDate ? new Date(formEndDate).toLocaleDateString() : "Same as Start Date"}</Text>
            </Pressable>`
);

// 4. Update Collective Modal date inputs
content = content.replace(
  /<TextInput style=\{\[styles\.input, \{ borderColor: cardBorder, color: colors\.text, marginBottom: 16 \}\]\} placeholder="YYYY-MM-DD" placeholderTextColor=\{colors\.textTertiary\} value=\{collectiveStartDate\} onChangeText=\{setCollectiveStartDate\} \/>/g,
  `<Pressable style={[styles.input, { borderColor: cardBorder, justifyContent: "center", marginBottom: 16 }]} onPress={() => { setCalendarTarget("collStart"); setShowCalendar(true); }}>
              <Text style={{ color: collectiveStartDate ? colors.text : colors.textTertiary }}>{collectiveStartDate || "YYYY-MM-DD"}</Text>
            </Pressable>`
);

content = content.replace(
  /<TextInput style=\{\[styles\.input, \{ borderColor: cardBorder, color: colors\.text, marginBottom: 16 \}\]\} placeholder="YYYY-MM-DD" placeholderTextColor=\{colors\.textTertiary\} value=\{collectiveEndDate\} onChangeText=\{setCollectiveEndDate\} \/>/g,
  `<Pressable style={[styles.input, { borderColor: cardBorder, justifyContent: "center", marginBottom: 16 }]} onPress={() => { setCalendarTarget("collEnd"); setShowCalendar(true); }}>
              <Text style={{ color: collectiveEndDate ? colors.text : colors.textTertiary }}>{collectiveEndDate || "YYYY-MM-DD"}</Text>
            </Pressable>`
);

// 5. Update the CalendarModal itself
const oldCalendarRegex = /<CalendarModal\s*visible=\{showCalendar\}\s*value=\{formDate\}\s*onClose=\{\(\) => setShowCalendar\(false\)\}\s*onSelect=\{\(dateStr: string\) => setFormDate\(dateStr\)\}\s*colors=\{colors\}\s*\/>/s;

const newCalendar = `<CalendarModal
        visible={showCalendar}
        value={calendarTarget === "start" ? formStartDate : calendarTarget === "end" ? formEndDate : calendarTarget === "collStart" ? collectiveStartDate : collectiveEndDate}
        onClose={() => setShowCalendar(false)}
        onSelect={(dateStr: string) => {
           if (calendarTarget === "start") setFormStartDate(dateStr);
           else if (calendarTarget === "end") setFormEndDate(dateStr);
           else if (calendarTarget === "collStart") setCollectiveStartDate(dateStr);
           else setCollectiveEndDate(dateStr);
           setShowCalendar(false);
        }}
        colors={colors}
      />`;

content = content.replace(oldCalendarRegex, newCalendar);

fs.writeFileSync(path, content, "utf8");
console.log("Calendar logic patched!");
