import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useIsFocused } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { getAttendanceStatus, getCompanyAttendanceToday } from "@/lib/attendance-api";
import type { AttendanceRecord } from "@/lib/types";
import { toMumbaiDateKey, formatMumbaiDateKey } from "@/lib/ist-time";

export default function Dashboard() {
  const { user, company } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<{ records: AttendanceRecord[]; active: AttendanceRecord | null; companyRecords: AttendanceRecord[]; at: string } | null>(null);
  const supervisor = ["admin", "hr", "manager"].includes(user?.role || "");
  const refresh = useCallback(async () => {
    if (!user || busyRef.current || AppState.currentState !== "active") return;
    busyRef.current = true; setBusy(true);
    try {
      const [status, companyRecords] = await Promise.all([getAttendanceStatus(), supervisor ? getCompanyAttendanceToday(company?.id) : Promise.resolve([])]);
      setSnapshot({ ...status, companyRecords, at: new Date().toLocaleTimeString() }); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to refresh attendance"); }
    finally { busyRef.current = false; setBusy(false); }
  }, [user?.id, supervisor, company?.id]);
  useEffect(() => {
    if (!focused) return;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30000);
    const sub = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [focused, refresh]);
  const latest = new Map<string, AttendanceRecord>();
  for (const row of [...(snapshot?.companyRecords || [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) latest.set(row.userId, row);
  const card = { padding: 20, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.backgroundElevated, gap: 10 };
  return <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24, gap: 20 }} refreshControl={<RefreshControl refreshing={busy} onRefresh={() => void refresh()} />}>
    <DrawerToggleButton />
    <Text style={{ color: colors.text, fontSize: 30, fontWeight: "700" }}>Dashboard</Text>
    <Text style={{ color: colors.textSecondary }}>{company?.name} ? {formatMumbaiDateKey(toMumbaiDateKey(new Date()))}</Text>
    <Text style={{ color: colors.text, fontSize: 20 }}>Hello, {user?.name}</Text>
    {error ? <Pressable onPress={() => void refresh()}><Text style={{ color: colors.danger }}>Refresh failed. {snapshot ? "Showing last confirmed data. " : ""}Tap to retry.</Text></Pressable> : null}
    <View style={card}>
      <Text style={{ color: colors.textSecondary }}>Your attendance</Text>
      <Text style={{ color: colors.text, fontSize: 26, fontWeight: "700" }}>{snapshot ? snapshot.active ? "Checked in" : "Checked out" : "Loading..."}</Text>
      <Text style={{ color: colors.textSecondary }}>{snapshot?.active?.geofenceName || "Open attendance to verify your office location."}</Text>
    </View>
    {supervisor && <View style={card}>
      <Text style={{ color: colors.text, fontSize: 20 }}>Company attendance today</Text>
      <Text style={{ color: colors.textSecondary }}>Checked in: {snapshot ? [...latest.values()].filter(row => row.type === "checkin").length : "?"}</Text>
      <Text style={{ color: colors.textSecondary }}>Checked out: {snapshot ? [...latest.values()].filter(row => row.type === "checkout").length : "?"}</Text>
    </View>}
    <Pressable accessibilityRole="button" style={[card, { backgroundColor: colors.primary }]} onPress={() => router.push("/(tabs)/attendance")}><Text style={{ color: "white", fontSize: 18, fontWeight: "600" }}>Open attendance & geofencing</Text></Pressable>
    <Pressable accessibilityRole="button" style={card} onPress={() => router.push("/(tabs)/account")}><Text style={{ color: colors.text }}>Account{user?.role === "admin" ? " & employee access approvals" : ""}</Text></Pressable>
    {snapshot && <Text style={{ color: colors.textSecondary }}>Last synced {snapshot.at}</Text>}
  </ScrollView>;
}
