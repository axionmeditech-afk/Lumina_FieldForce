import { router } from "expo-router";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";

export default function NotFoundScreen() {
  const { colors } = useAppTheme();

  return (
    <AppCanvas>
      <View style={[styles.container, { backgroundColor: "transparent" }]}>
        <Ionicons name="warning-outline" size={48} color={colors.textTertiary} />
        <Text style={[styles.title, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
          Page Not Found
        </Text>
        <Pressable
          onPress={() => router.replace("/")}
          style={[styles.button, { backgroundColor: colors.primary }]}
        >
          <Text style={styles.buttonText}>Go Home</Text>
        </Pressable>
      </View>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  title: { fontSize: 18 },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  buttonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
