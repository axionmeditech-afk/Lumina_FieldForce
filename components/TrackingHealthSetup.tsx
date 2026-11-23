import Ionicons from '@expo/vector-icons/Ionicons';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppTheme } from '@/contexts/ThemeContext';
import { fieldTrackingConfig } from '@/lib/field-tracking/config';
import { countPending, getActiveSession, getState } from '@/lib/field-tracking/tracking/database';
import { readFieldPermissions } from '@/lib/field-tracking/tracking/tracker';

type HealthSnapshot = {
  manufacturer: string;
  precise: boolean;
  background: boolean;
  services: boolean;
  nativeTask: boolean;
  activeSession: boolean;
  lastCapturedAt: string | null;
  lastHeartbeatAt: string | null;
  pending: number;
  profile: string;
  error: string | null;
};

const initial: HealthSnapshot = {
  manufacturer: '', precise: false, background: false, services: false, nativeTask: false,
  activeSession: false, lastCapturedAt: null, lastHeartbeatAt: null, pending: 0, profile: 'waiting', error: null,
};

function ageLabel(value: string | null): string {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return 'Not received';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
}

export function TrackingHealthSetup() {
  const { colors } = useAppTheme();
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const permissions = await readFieldPermissions();
      const session = await getActiveSession();
      const [nativeTask, lastCapturedAt, lastHeartbeatAt, pending, profile, error] = await Promise.all([
        permissions.backgroundCapable
          ? Location.hasStartedLocationUpdatesAsync(fieldTrackingConfig.locationTaskName).catch(() => false)
          : Promise.resolve(false),
        getState('last_captured_at'),
        getState('last_heartbeat_sent_at'),
        countPending(),
        getState('tracking_sampling_profile'),
        getState('last_tracker_error'),
      ]);
      const constants = Platform.constants as { Manufacturer?: string; Brand?: string };
      setSnapshot({
        manufacturer: String(constants.Manufacturer || constants.Brand || Platform.OS),
        precise: permissions.precisePermission,
        background: permissions.backgroundPermission,
        services: permissions.locationServicesEnabled,
        nativeTask,
        activeSession: Boolean(session),
        lastCapturedAt,
        lastHeartbeatAt,
        pending,
        profile: profile || 'waiting',
        error: error || null,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = setTimeout(() => void refresh(), 0);
    const interval = setInterval(() => void refresh(), 15_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => { clearTimeout(initialRefresh); clearInterval(interval); subscription.remove(); };
  }, [refresh]);

  const isOppoFamily = /oppo|realme|oneplus/i.test(snapshot.manufacturer);
  const engineHealthy = !snapshot.activeSession || snapshot.nativeTask || fieldTrackingConfig.isExpoGo;
  const setupHealthy = snapshot.precise && snapshot.background && snapshot.services && engineHealthy;
  const title = setupHealthy ? 'Tracking setup ready' : 'Tracking setup needs attention';
  const detail = snapshot.activeSession
    ? `${snapshot.profile.replace(/_/g, ' ')} profile · ${snapshot.pending} queued point${snapshot.pending === 1 ? '' : 's'}`
    : 'Engine starts automatically with an eligible check-in.';
  const checks = useMemo(() => [
    { label: 'Precise location', ready: snapshot.precise },
    { label: 'Allow all the time', ready: snapshot.background },
    { label: 'Device location services', ready: snapshot.services },
    { label: snapshot.activeSession ? 'Native tracking engine' : 'Native engine (starts after check-in)', ready: engineHealthy },
  ], [engineHealthy, snapshot]);

  const openBatterySettings = useCallback(async () => {
    if (Platform.OS !== 'android') return Linking.openSettings();
    try {
      await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    } catch {
      try { await Linking.sendIntent('android.settings.BATTERY_SAVER_SETTINGS'); }
      catch { await Linking.openSettings(); }
    }
  }, []);

  const openOppoStartupSettings = useCallback(async () => {
    if (Platform.OS !== 'android') return Linking.openSettings();
    try { await Linking.sendIntent('oppo.intent.action.OPPO_COMPONENT_SAFE'); }
    catch { await Linking.openSettings(); }
  }, []);

  return (
    <View style={[styles.card, { backgroundColor: colors.backgroundElevated, borderColor: colors.border, shadowColor: colors.cardShadow }]}>
      <View style={styles.header}>
        <View style={[styles.icon, { backgroundColor: `${setupHealthy ? colors.success : colors.warning}16` }]}>
          <Ionicons name={setupHealthy ? 'shield-checkmark-outline' : 'warning-outline'} size={23} color={setupHealthy ? colors.success : colors.warning} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{detail}</Text>
        </View>
        <Pressable disabled={busy} onPress={() => void refresh()} style={[styles.refresh, { backgroundColor: `${colors.primary}12` }]}>
          <Ionicons name="refresh" size={18} color={colors.primary} />
        </Pressable>
      </View>

      <View style={styles.checks}>
        {checks.map((check) => (
          <View key={check.label} style={styles.checkRow}>
            <Ionicons name={check.ready ? 'checkmark-circle' : 'alert-circle'} size={17} color={check.ready ? colors.success : colors.warning} />
            <Text style={[styles.checkLabel, { color: colors.textSecondary }]}>{check.label}</Text>
            <Text style={[styles.checkValue, { color: check.ready ? colors.success : colors.warning }]}>{check.ready ? 'Ready' : 'Fix'}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.telemetry, { backgroundColor: `${colors.primary}08`, borderColor: colors.borderLight }]}>
        <View style={styles.telemetryItem}><Text style={[styles.telemetryLabel, { color: colors.textTertiary }]}>Last GPS</Text><Text style={[styles.telemetryValue, { color: colors.text }]}>{ageLabel(snapshot.lastCapturedAt)}</Text></View>
        <View style={styles.telemetryItem}><Text style={[styles.telemetryLabel, { color: colors.textTertiary }]}>Heartbeat</Text><Text style={[styles.telemetryValue, { color: colors.text }]}>{ageLabel(snapshot.lastHeartbeatAt)}</Text></View>
        <View style={styles.telemetryItem}><Text style={[styles.telemetryLabel, { color: colors.textTertiary }]}>Device</Text><Text numberOfLines={1} style={[styles.telemetryValue, { color: colors.text }]}>{snapshot.manufacturer}</Text></View>
      </View>

      {snapshot.error ? <Text style={[styles.error, { color: colors.danger }]}>Last engine note: {snapshot.error}</Text> : null}
      {isOppoFamily ? (
        <Text style={[styles.oemHint, { color: colors.textSecondary }]}>OPPO/Realme/OnePlus: set battery to Unrestricted and allow Auto launch, Secondary launch and Run in background.</Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable onPress={() => void Linking.openSettings()} style={[styles.button, { borderColor: colors.border, backgroundColor: `${colors.primary}0C` }]}>
          <Ionicons name="settings-outline" size={17} color={colors.primary} /><Text style={[styles.buttonText, { color: colors.primary }]}>App settings</Text>
        </Pressable>
        <Pressable onPress={() => void openBatterySettings()} style={[styles.button, { borderColor: colors.border, backgroundColor: `${colors.primary}0C` }]}>
          <Ionicons name="battery-charging-outline" size={17} color={colors.primary} /><Text style={[styles.buttonText, { color: colors.primary }]}>Battery</Text>
        </Pressable>
        {isOppoFamily ? (
          <Pressable onPress={() => void openOppoStartupSettings()} style={[styles.button, { borderColor: colors.border, backgroundColor: `${colors.primary}0C` }]}>
            <Ionicons name="rocket-outline" size={17} color={colors.primary} /><Text style={[styles.buttonText, { color: colors.primary }]}>Auto launch</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 24, padding: 18, shadowOpacity: 0.08, shadowRadius: 14, elevation: 2, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 12, lineHeight: 18, marginTop: 3 },
  refresh: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  checks: { gap: 9 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkLabel: { flex: 1, fontSize: 12, fontWeight: '600' },
  checkValue: { fontSize: 11, fontWeight: '800' },
  telemetry: { borderWidth: 1, borderRadius: 15, padding: 11, flexDirection: 'row', gap: 8 },
  telemetryItem: { flex: 1, minWidth: 0 },
  telemetryLabel: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase' },
  telemetryValue: { fontSize: 11, fontWeight: '800', marginTop: 3 },
  error: { fontSize: 11, lineHeight: 16, fontWeight: '600' },
  oemHint: { fontSize: 11, lineHeight: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { height: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  buttonText: { fontSize: 11, fontWeight: '800' },
});
