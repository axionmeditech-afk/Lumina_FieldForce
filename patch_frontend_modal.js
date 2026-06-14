const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Solid Professional Weekends Modal
const oldModalRegex = /<Modal visible=\{showWeekendModal\} transparent animationType="fade">[\s\S]*?<\/Modal>/s;
const newModal = `      <Modal visible={showWeekendModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowWeekendModal(false)}>
        <View style={{ flex: 1, backgroundColor: isDark ? P.slate900 : "#F8FAFC" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1, borderColor: cardBorder }}>
            <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: colors.text }}>Configure Weekends</Text>
            <Pressable onPress={() => setShowWeekendModal(false)}><Ionicons name="close" size={24} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={{ padding: 20 }} contentContainerStyle={{ gap: 8 }}>
            <Text style={{ fontSize: 14, color: colors.textSecondary, marginBottom: 16 }}>Select your company's designated off days.</Text>
            {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((dayName, i) => {
              const isActive = tempWeekendDays.includes(i);
              return (
                <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, borderBottomWidth: 1, borderColor: cardBorder }}>
                  <Text style={{ color: isActive ? P.blue : colors.text, fontSize: 16, fontFamily: "Inter_500Medium" }}>{dayName}</Text>
                  <Switch
                    value={isActive}
                    onValueChange={(val) => setTempWeekendDays(prev => val ? [...prev, i] : prev.filter(d => d !== i))}
                    trackColor={{ false: isDark ? "#334155" : "#E2E8F0", true: P.blue }}
                  />
                </View>
              );
            })}
            <Pressable onPress={handleSaveWeekends} disabled={submitting} style={[styles.submitBtn, { backgroundColor: P.blue, marginTop: 32, opacity: submitting ? 0.5 : 1 }]}>
              {submitting ? <ActivityIndicator color="#FFF" /> : <Text style={styles.submitTxt}>Save Weekend Settings</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>`;

content = content.replace(oldModalRegex, newModal);
fs.writeFileSync(path, content, "utf8");
console.log("Frontend modal patched.");
