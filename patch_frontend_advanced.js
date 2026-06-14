const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Add imports
content = content.replace(
  "saveWeekendConfigRemote,",
  "saveWeekendConfigRemote,\n  getUsersRemote,\n  createCollectiveLeaveRemote,"
);

// 2. Add User state and Advanced Form states
content = content.replace(
  "const [formDate, setFormDate] = useState(\"\");",
  `const [usersList, setUsersList] = useState<any[]>([]);

  // Individual Form
  const [formStartDate, setFormStartDate] = useState("");
  const [formEndDate, setFormEndDate] = useState("");
  const [formStartAmPm, setFormStartAmPm] = useState("morning");
  const [formEndAmPm, setFormEndAmPm] = useState("afternoon");
  const [formApprovedBy, setFormApprovedBy] = useState("");
  
  // Collective Form
  const [showCollectiveModal, setShowCollectiveModal] = useState(false);
  const [collectiveUsers, setCollectiveUsers] = useState<string[]>([]);
  const [collectiveStartDate, setCollectiveStartDate] = useState("");
  const [collectiveEndDate, setCollectiveEndDate] = useState("");
  const [collectiveStartAmPm, setCollectiveStartAmPm] = useState("morning");
  const [collectiveEndAmPm, setCollectiveEndAmPm] = useState("afternoon");
  const [collectiveType, setCollectiveType] = useState("planned");
  const [collectiveApprovedBy, setCollectiveApprovedBy] = useState("");
  const [collectiveNote, setCollectiveNote] = useState("");
  const [collectiveAutoValidate, setCollectiveAutoValidate] = useState(false);
`
);

// 3. Update fetchData to get users
content = content.replace(
  "getWeekendConfigRemote(),",
  "getWeekendConfigRemote(),\n        getUsersRemote(),"
);
content = content.replace(
  "const [leavesData, summaryData, holidaysData, weekendData]",
  "const [leavesData, summaryData, holidaysData, weekendData, usersData]"
);
content = content.replace(
  "if (weekendData.status === \"fulfilled\") setWeekendDays(weekendData.value.weekendDays);",
  "if (weekendData.status === \"fulfilled\") setWeekendDays(weekendData.value.weekendDays);\n      if (usersData.status === \"fulfilled\") setUsersList(usersData.value);"
);

// 4. Update handleSubmitLeave
const submitRegex = /const handleSubmitLeave = async \(\) => \{[\s\S]*?\} catch \(err\) \{/s;
const newSubmit = `const handleSubmitLeave = async () => {
    if (!formStartDate) {
      Alert.alert("Date Required", "Please select a start date.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const newLeave = await createLeaveRequestRemote({
        leaveDate: formStartDate,
        leaveEndDate: formEndDate || formStartDate,
        startAmPm: formStartAmPm,
        endAmPm: formEndAmPm,
        leaveType: formLeaveType,
        approvedBy: formApprovedBy,
        note: formNote || undefined,
        userId: user?.id,
        userName: user?.name,
        userEmail: user?.email,
        companyId: company?.id,
      });
      setLeaves((prev) => [newLeave, ...prev]);
      setShowRequestModal(false);
      resetForm();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Request Submitted", "Your leave request has been submitted successfully.");
    } catch (err) {`;

content = content.replace(submitRegex, newSubmit);

// 5. Update resetForm
content = content.replace(
  "setFormDate(\"\");",
  "setFormStartDate(\"\");\n    setFormEndDate(\"\");\n    setFormStartAmPm(\"morning\");\n    setFormEndAmPm(\"afternoon\");\n    setFormApprovedBy(\"\");"
);

// 6. Add Collective Submit handler
const handleCollectiveSubmit = `
  const handleCollectiveSubmit = async () => {
    if (collectiveUsers.length === 0 || !collectiveStartDate) {
      Alert.alert("Required", "Please select users and a start date.");
      return;
    }
    setSubmitting(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await createCollectiveLeaveRemote({
        userIds: collectiveUsers,
        startDate: collectiveStartDate,
        endDate: collectiveEndDate || collectiveStartDate,
        startAmPm: collectiveStartAmPm,
        endAmPm: collectiveEndAmPm,
        leaveType: collectiveType,
        approvedBy: collectiveApprovedBy,
        autoValidate: collectiveAutoValidate,
        note: collectiveNote
      });
      setShowCollectiveModal(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Success", "Collective leaves created!");
      fetchData(); // Refresh UI
    } catch {
      Alert.alert("Error", "Failed to create collective leaves.");
    } finally {
      setSubmitting(false);
    }
  };
`;
content = content.replace(
  "const handleApprove = async",
  handleCollectiveSubmit + "\n  const handleApprove = async"
);

// 7. Replace Request Leave Modal UI
const modalStartRegex = /<Modal\s+visible=\{showRequestModal\}[\s\S]*?<\/Modal>/s;
// We will replace the entire old Modal with a new, advanced Request Modal
const newRequestModal = `
      {/* ─── NEW LEAVE REQUEST MODAL ─── */}
      <Modal visible={showRequestModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowRequestModal(false)}>
        <View style={{ flex: 1, backgroundColor: isDark ? P.slate900 : "#F8FAFC" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>New Leave Request</Text>
            <Pressable onPress={() => setShowRequestModal(false)}><Ionicons name="close" size={24} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }}>
            <Text style={styles.fldLabel}>Start Date</Text>
            <Pressable style={styles.dateBtn} onPress={() => setShowCalendar(true)}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formStartDate ? colors.text : colors.textSecondary }}>{formStartDate ? new Date(formStartDate).toLocaleDateString() : "Select Start Date"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formStartAmPm === "morning" ? P.blue : cardBorder, backgroundColor: formStartAmPm === "morning" ? P.blue + "15" : "transparent" }]} onPress={() => setFormStartAmPm("morning")}>
                <Text style={{ color: formStartAmPm === "morning" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Morning</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formStartAmPm === "afternoon" ? P.blue : cardBorder, backgroundColor: formStartAmPm === "afternoon" ? P.blue + "15" : "transparent" }]} onPress={() => setFormStartAmPm("afternoon")}>
                <Text style={{ color: formStartAmPm === "afternoon" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>End Date (Optional)</Text>
            <Pressable style={styles.dateBtn} onPress={() => setShowCalendar(true)}>
              <Ionicons name="calendar-outline" size={18} color={colors.textSecondary} />
              <Text style={{ flex: 1, color: formEndDate ? colors.text : colors.textSecondary }}>{formEndDate ? new Date(formEndDate).toLocaleDateString() : "Same as Start Date"}</Text>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formEndAmPm === "morning" ? P.blue : cardBorder, backgroundColor: formEndAmPm === "morning" ? P.blue + "15" : "transparent" }]} onPress={() => setFormEndAmPm("morning")}>
                <Text style={{ color: formEndAmPm === "morning" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Morning</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formEndAmPm === "afternoon" ? P.blue : cardBorder, backgroundColor: formEndAmPm === "afternoon" ? P.blue + "15" : "transparent" }]} onPress={() => setFormEndAmPm("afternoon")}>
                <Text style={{ color: formEndAmPm === "afternoon" ? P.blue : colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>Leave Type</Text>
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formLeaveType === "planned" ? P.blue : cardBorder }]} onPress={() => setFormLeaveType("planned")}>
                <Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Planned</Text>
              </Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: formLeaveType === "unplanned" ? P.orange : cardBorder }]} onPress={() => setFormLeaveType("unplanned")}>
                <Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Unplanned</Text>
              </Pressable>
            </View>

            <Text style={styles.fldLabel}>Approved By (Optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
              {usersList.map(u => (
                <Pressable key={u.id} style={[{ padding: 10, borderWidth: 1, borderColor: formApprovedBy === u.id ? P.blue : cardBorder, borderRadius: 10, marginRight: 8, backgroundColor: formApprovedBy === u.id ? P.blue+"15" : "transparent" }]} onPress={() => setFormApprovedBy(u.id)}>
                  <Text style={{ color: formApprovedBy === u.id ? P.blue : colors.text }}>{u.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <Text style={styles.fldLabel}>Description</Text>
            <TextInput
              style={[styles.input, { borderColor: cardBorder, color: colors.text, minHeight: 80, textAlignVertical: "top" }]}
              placeholder="Why are you taking leave?"
              placeholderTextColor={colors.textTertiary}
              value={formNote}
              onChangeText={setFormNote}
              multiline
            />

            <Pressable onPress={handleSubmitLeave} disabled={!formStartDate || submitting} style={[styles.submitBtn, { backgroundColor: P.blue, marginTop: 20, marginBottom: 50, opacity: (!formStartDate || submitting) ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Submit Request</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* ─── COLLECTIVE LEAVE MODAL ─── */}
      <Modal visible={showCollectiveModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowCollectiveModal(false)}>
        <View style={{ flex: 1, backgroundColor: isDark ? P.slate900 : "#F8FAFC" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>Collective Leave</Text>
            <Pressable onPress={() => setShowCollectiveModal(false)}><Ionicons name="close" size={24} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }}>
            <Text style={styles.fldLabel}>Select Users</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {usersList.map(u => (
                <Pressable key={u.id} style={[{ padding: 8, borderWidth: 1, borderColor: collectiveUsers.includes(u.id) ? P.blue : cardBorder, borderRadius: 10, backgroundColor: collectiveUsers.includes(u.id) ? P.blue+"15" : "transparent" }]} onPress={() => setCollectiveUsers(prev => prev.includes(u.id) ? prev.filter(id => id !== u.id) : [...prev, u.id])}>
                  <Text style={{ color: collectiveUsers.includes(u.id) ? P.blue : colors.text, fontSize: 12 }}>{u.name}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.fldLabel}>Start Date</Text>
            <TextInput style={[styles.input, { borderColor: cardBorder, color: colors.text, marginBottom: 16 }]} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textTertiary} value={collectiveStartDate} onChangeText={setCollectiveStartDate} />

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveStartAmPm === "morning" ? P.blue : cardBorder }]} onPress={() => setCollectiveStartAmPm("morning")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Morning</Text></Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveStartAmPm === "afternoon" ? P.blue : cardBorder }]} onPress={() => setCollectiveStartAmPm("afternoon")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text></Pressable>
            </View>

            <Text style={styles.fldLabel}>End Date (Optional)</Text>
            <TextInput style={[styles.input, { borderColor: cardBorder, color: colors.text, marginBottom: 16 }]} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textTertiary} value={collectiveEndDate} onChangeText={setCollectiveEndDate} />

            <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveEndAmPm === "morning" ? P.blue : cardBorder }]} onPress={() => setCollectiveEndAmPm("morning")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Morning</Text></Pressable>
              <Pressable style={[styles.dateBtn, { flex: 1, marginBottom: 0, borderColor: collectiveEndAmPm === "afternoon" ? P.blue : cardBorder }]} onPress={() => setCollectiveEndAmPm("afternoon")}><Text style={{ color: colors.text, textAlign: "center", flex: 1 }}>Afternoon</Text></Pressable>
            </View>

            <Text style={styles.fldLabel}>Auto Validate?</Text>
            <Switch value={collectiveAutoValidate} onValueChange={setCollectiveAutoValidate} style={{ alignSelf: "flex-start", marginBottom: 16 }} />

            <Pressable onPress={handleCollectiveSubmit} disabled={submitting} style={[styles.submitBtn, { backgroundColor: P.orange, marginTop: 20, marginBottom: 50, opacity: submitting ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Create Collective Leaves</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
`;

content = content.replace(modalStartRegex, newRequestModal);

// 8. Update Admin Calendar button to open Collective Leave Modal instead of directly Adding Holiday
content = content.replace(
  "Alert.alert(\"Add Holiday\", `Mark ${d} ${MONTHS[month - 1]} as a Collective Leave/Holiday?`, [",
  `Alert.alert("Manage", \`Add a holiday or collective leave for \${d} \${MONTHS[month - 1]}?\`, [
          { text: "Collective Leave", onPress: () => { setCollectiveStartDate(\`\${year}-\${String(month).padStart(2, "0")}-\${String(d).padStart(2, "0")}\`); setShowCollectiveModal(true); } },
          { text: "Public Holiday", onPress: () => onAddHoliday(d, month, year) },
          { text: "Cancel", style: "cancel" }
        ]);
        // Avoid executing the old code by commenting it out temporarily via regex replacement
        /*`
);
content = content.replace(
  "{ text: \"Add Holiday\", onPress: () => onAddHoliday(d, month, year) }\n        ]);\n      }",
  `*/
      }`
);

fs.writeFileSync(path, content, "utf8");
console.log("Frontend Patched for Advanced Leaves");
