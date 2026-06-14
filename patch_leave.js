const fs = require('fs');
const path = "app/(tabs)/leave-management.tsx";
let content = fs.readFileSync(path, "utf8");

// 1. Remove the FAB
content = content.replace(
  /\{\/\* ─── FAB ───.*?\/\* ─── Request Modal/s,
  `{/* ─── Request Modal`
);

// 2. Remove Request Leave from EmptyState
content = content.replace(
  /\{tab === "my" && \(\s*<Pressable onPress=\{onRequest\}.*?<\/Pressable>\s*\)\}/s,
  ``
);

// 3. Add Request Leave button to Hero
const heroInsertion = `                  <Text style={styles.heroSub}>
                    {MONTHS[currentMonth - 1]} {currentYear}
                  </Text>
                </View>`;
const heroReplacement = heroInsertion + `
                <Pressable onPress={() => { setShowRequestModal(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }} style={styles.heroBtn}>
                  <Ionicons name="add" size={16} color={"#FFF"} />
                  <Text style={styles.heroBtnTxt}>New</Text>
                </Pressable>`;
content = content.replace(heroInsertion, heroReplacement);

// 4. Make hero sleeker
content = content.replace(
  /colors=\{isDark\s*\?\s*\["#0F2847", "#1A3A6E", "#1E3F76"\]\s*:\s*\["#1D4ED8", "#2563EB", "#3B82F6"\]\}/s,
  `colors={["#0F172A", "#1E293B"]}`
);

// 5. Add styles for heroBtn
const stylesInsertion = `heroSub: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_400Regular", marginTop: 2 },`;
const stylesReplacement = stylesInsertion + `\n  heroBtn: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.15)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, gap: 4 },\n  heroBtnTxt: { color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 13 },`;
content = content.replace(stylesInsertion, stylesReplacement);

fs.writeFileSync(path, content, "utf8");
console.log("Patched leave-management.tsx successfully");
