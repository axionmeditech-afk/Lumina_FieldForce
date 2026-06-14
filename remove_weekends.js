const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Remove imports
content = content.replace("  getWeekendConfigRemote,\n", "");
content = content.replace("  saveWeekendConfigRemote,\n", "");

// 2. Remove state
content = content.replace("  const [weekendDays, setWeekendDays] = useState<number[]>([0]);\n", "");
content = content.replace("  const [showWeekendModal, setShowWeekendModal] = useState(false);\n", "");
content = content.replace("  const [tempWeekendDays, setTempWeekendDays] = useState<number[]>([]);\n", "");

// 3. Remove from fetchData
content = content.replace("        getWeekendConfigRemote(),\n", "");
content = content.replace("const [leavesData, summaryData, holidaysData, weekendData, usersData]", "const [leavesData, summaryData, holidaysData, usersData]");
content = content.replace("if (weekendData.status === \"fulfilled\") setWeekendDays(weekendData.value.weekendDays);\n      ", "");

// 4. Remove handleSaveWeekends
const handleSaveWeekendsRegex = /  const handleSaveWeekends = async \(\) => \{[\s\S]*?\};\n/;
content = content.replace(handleSaveWeekendsRegex, "");

// 5. Remove LeaveCalendar props
content = content.replace("            weekendDays={weekendDays}\n", "            weekendDays={[0]}\n");
content = content.replace(/            onConfigureWeekends=\{.*?\n/s, "");

// 6. Remove Modal
const modalRegex = /<Modal visible=\{showWeekendModal\} transparent animationType="fade">[\s\S]*?<\/Modal>/s;
content = content.replace(modalRegex, "");

fs.writeFileSync(path, content, "utf8");
console.log("Weekends removed from leave-management.tsx");
