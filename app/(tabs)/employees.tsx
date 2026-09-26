import React, { useCallback, useEffect, useState } from "react";
import { Alert, Button, ScrollView, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTheme } from "@/contexts/ThemeContext";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import { getAdminAccessRequests, reviewAdminAccessRequest } from "@/lib/attendance-api";
import type { UserAccessRequest } from "@/lib/types";

export default function EmployeeAccess() {
  const { user, company } = useAuth();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [requests, setRequests] = useState<UserAccessRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (user?.role !== "admin") return;
    setBusy(true); setError("");
    try { setRequests(await getAdminAccessRequests("pending")); }
    catch (e) { setError(e instanceof Error ? e.message : "Unable to load requests."); }
    finally { setBusy(false); }
  }, [user?.role]);
  useEffect(() => { void load(); }, [load]);
  if (user?.role !== "admin") return <Redirect href="/(tabs)/attendance" />;
  const review = async (requestId: string, action: "approved" | "rejected") => {
    if (!company?.id) { Alert.alert("Company required", "Select an active company before reviewing access."); return; }
    setBusy(true);
    try {
      await reviewAdminAccessRequest({ requestId, action, role: "employee", companyIds: [company.id],
        companyProfiles: [{ id: company.id, name: company.name }] });
      await load();
    } catch (e) { Alert.alert("Review failed", e instanceof Error ? e.message : "Please retry."); }
    finally { setBusy(false); }
  };
  return <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, paddingTop: insets.top + 20, gap: 18 }}>
    <DrawerToggleButton />
    <Text style={{ fontSize: 28, color: colors.text }}>Employee Access</Text>
    <Text style={{ color: colors.textSecondary }}>Approve employees for attendance at {company?.name}.</Text>
    <Button title={busy ? "Loading…" : "Refresh"} disabled={busy} onPress={() => void load()} />
    {!!error && <Text style={{ color: colors.danger }}>{error}</Text>}
    {!busy && !error && !requests.length && <Text style={{ color: colors.textSecondary }}>No pending access requests.</Text>}
    {requests.map(request => <View key={request.id} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 18, gap: 12 }}>
      <Text style={{ color: colors.text, fontSize: 18 }}>{request.name}</Text>
      <Text style={{ color: colors.textSecondary }}>{request.email}</Text>
      <Button title="Approve as employee" disabled={busy} onPress={() => void review(request.id, "approved")} />
      <Button title="Reject" disabled={busy} color={colors.danger} onPress={() => void review(request.id, "rejected")} />
    </View>)}
  </ScrollView>;
}
