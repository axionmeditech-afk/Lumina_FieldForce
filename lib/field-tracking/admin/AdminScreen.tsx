import React, { useState } from 'react';
import { StyleSheet, Text, View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RouteMap } from '../components/RouteMap';
import { StatusDot } from '../components/Primitives';
import { BottomSheet } from '../components/BottomSheet';
import { useLiveRoute } from './useLiveRoute';

export function AdminScreen() {
  const { employee, employees, points, connectionState, error, serverHealth, refresh, selectEmployee } = useLiveRoute();
  const [selectingEmployee, setSelectingEmployee] = useState(true);
  const live = connectionState === 'live';

  if (selectingEmployee) {
    return <EmployeePicker employees={employees} connectionState={connectionState} error={error} onRefresh={refresh} onSelect={(employeeId) => {
      selectEmployee(employeeId);
      setSelectingEmployee(false);
    }} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.screen}>
        <RouteMap
          points={points}
          matchedRoute={[]}
          matchedRouteSource="raw"
          compact
          plannedRoute={[]}
          destination={null}
          waypoints={[]}
          progressPercent={0}
          halts={[]}
        />

        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.mapPill}>
            <View style={styles.brandDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.mapPillTitle}>{employee?.name ?? 'Operations map'}</Text>
              <Text style={styles.mapPillSubtitle}>Live field tracking</Text>
            </View>
            <Pressable onPress={() => setSelectingEmployee(true)} style={styles.changeButton}>
              <Text style={styles.changeButtonText}>Change</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.mapInfoRow} pointerEvents="box-none">
          <View style={styles.infoPill}>
            <StatusDot tone={live ? 'live' : connectionState === 'offline' ? 'danger' : 'warning'} />
            <Text style={styles.infoPillText}>{connectionState}</Text>
          </View>
          <Pressable onPress={() => void refresh()} style={({ pressed }) => [styles.infoPill, pressed && { opacity: 0.82 }]}>
            <Text style={styles.infoPillMuted}>Refresh</Text>
          </Pressable>
        </View>

        <BottomSheet
          title={employee?.name ?? 'No active employee'}
          subtitle={employee ? 'Live tracking' : 'Waiting for a field session.'}
          rightLabel={live ? 'Live' : connectionState}
          collapsedHeight={220}
          expandedRatio={0.84}
        >
          <SectionCard title={`Live field team · ${employees.length}`}>
            {employees.length ? (
              <View style={styles.rosterRows}>
                {employees.map((item) => (
                  <EmployeeRosterCard
                    key={`${item.employeeId}:${item.sessionId}`}
                    employee={item}
                    selected={item.employeeId === employee?.employeeId && item.sessionId === employee?.sessionId}
                    onPress={() => selectEmployee(item.employeeId)}
                  />
                ))}
              </View>
            ) : (
              <View style={styles.rosterEmpty}>
                <Text style={styles.rosterEmptyTitle}>No field devices are sharing a location</Text>
                <Text style={styles.rosterEmptyBody}>When a field shift sends its first committed GPS point, it will appear here automatically.</Text>
              </View>
            )}
          </SectionCard>

          <SectionCard title="System health">
            <View style={styles.healthRow}>
              <HealthChip label="API" value={serverHealth.apiReachable ? 'Ready' : 'Offline'} ready={serverHealth.apiReachable} />
              <HealthChip label="Live polling" value={connectionState} ready={connectionState === 'live'} warning={connectionState !== 'offline' && connectionState !== 'live'} />
              <HealthChip label="Valhalla" value={serverHealth.routerReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.routerReachable} />
              <HealthChip label="Nominatim" value={serverHealth.geocoderReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.geocoderReachable} />
            </View>
          </SectionCard>
          
          {error ? <Text style={styles.noteText}>Connection note · {error}</Text> : null}
        </BottomSheet>
      </View>
    </SafeAreaView>
  );
}

function EmployeePicker({
  employees,
  connectionState,
  error,
  onRefresh,
  onSelect,
}: {
  employees: any[];
  connectionState: string;
  error: string | null;
  onRefresh: () => void;
  onSelect: (employeeId: string) => void;
}) {
  const loading = connectionState === 'connecting' || connectionState === 'recovering';
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.pickerScreen}>
        <View style={styles.pickerHeader}>
          <View style={styles.pickerIcon}><Text style={styles.pickerIconText}>⌖</Text></View>
          <Text style={styles.pickerTitle}>Choose live employee</Text>
          <Text style={styles.pickerSubtitle}>Select whose current route you want to view.</Text>
        </View>
        <View style={styles.pickerStatusRow}>
          <StatusDot tone={connectionState === 'live' ? 'live' : connectionState === 'offline' ? 'danger' : 'warning'} />
          <Text style={styles.pickerStatusText}>{connectionState === 'live' ? `${employees.length} employee${employees.length === 1 ? '' : 's'} sharing location` : connectionState}</Text>
          <Pressable onPress={onRefresh} style={styles.pickerRefresh}><Text style={styles.pickerRefreshText}>Refresh</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pickerList} showsVerticalScrollIndicator={false}>
          {loading && !employees.length ? <ActivityIndicator color="#1769D2" style={styles.loader} /> : null}
          {employees.map((item) => (
            <EmployeeRosterCard
              key={`${item.employeeId}:${item.sessionId}`}
              employee={item}
              selected={false}
              onPress={() => onSelect(item.employeeId)}
            />
          ))}
          {!loading && !employees.length ? (
            <View style={styles.rosterEmpty}>
              <Text style={styles.rosterEmptyTitle}>No active tracking yet</Text>
              <Text style={styles.rosterEmptyBody}>An employee appears here after check-in and the first GPS location sync.</Text>
            </View>
          ) : null}
          {error ? <Text style={styles.noteText}>Connection note · {error}</Text> : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function EmployeeRosterCard({ employee, selected, onPress }: { employee: any; selected: boolean; onPress: () => void }) {
  const speed = employee.speed == null || employee.speed < 0 ? '—' : `${Math.round(employee.speed * 3.6)} km/h`;
  const accuracy = employee.accuracy == null ? 'GPS —' : `GPS ±${Math.round(employee.accuracy)} m`;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.rosterCard, selected && styles.rosterCardSelected, pressed && styles.rosterCardPressed]}>
      <View style={styles.rosterAvatar}><Text style={styles.rosterAvatarText}>{employee.initials}</Text></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rosterNameRow}>
          <Text style={styles.rosterName} numberOfLines={1}>{employee.name}</Text>
          <View style={[styles.rosterState, styles.rosterStateLive]}><Text style={[styles.rosterStateText, styles.rosterStateTextLive]}>LIVE</Text></View>
        </View>
        <Text style={styles.rosterMeta} numberOfLines={1}>{accuracy} · {speed} · {employee.battery == null ? 'Battery —' : `${employee.battery}% battery`}</Text>
        <Text style={styles.rosterMeta}>Tap to focus map</Text>
      </View>
    </Pressable>
  );
}

function HealthChip({ label, value, ready = false, warning = false }: { label: string; value: string; ready?: boolean; warning?: boolean }) {
  const tone = ready ? styles.healthChipReady : warning ? styles.healthChipWarning : styles.healthChipDanger;
  const textTone = ready ? styles.healthValueReady : warning ? styles.healthValueWarning : styles.healthValueDanger;
  return <View style={[styles.healthChip, tone]}><Text style={styles.healthLabel}>{label}</Text><Text style={[styles.healthValue, textTone]}>{value}</Text></View>;
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.sectionCard}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#E9EEF5' },
  screen: { flex: 1, backgroundColor: '#E9EEF5' },
  topBar: { position: 'absolute', top: 12, left: 14, right: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  mapPill: { flex: 1, minHeight: 58, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.97)', borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, elevation: 5 },
  changeButton: { minHeight: 32, borderRadius: 12, paddingHorizontal: 10, justifyContent: 'center', backgroundColor: '#EAF1FF' },
  changeButtonText: { color: '#1769D2', fontSize: 11, fontWeight: '800' },
  brandDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: '#4285F4' },
  mapPillTitle: { color: '#111827', fontSize: 15, fontWeight: '900' },
  mapPillSubtitle: { color: '#64748B', fontSize: 11, marginTop: 2 },
  mapInfoRow: { position: 'absolute', top: 84, left: 14, right: 14, flexDirection: 'row', gap: 8 },
  infoPill: { minHeight: 36, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.97)', borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8, elevation: 4 },
  infoPillText: { color: '#111827', fontSize: 11, fontWeight: '700' },
  infoPillMuted: { color: '#64748B', fontSize: 11, fontWeight: '700' },
  sectionCard: { borderRadius: 18, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', padding: 16, marginBottom: 12 },
  sectionTitle: { color: '#111827', fontSize: 13, fontWeight: '900', marginBottom: 12 },
  rosterRows: { gap: 8 },
  rosterCard: { minHeight: 68, borderRadius: 14, borderWidth: 1, borderColor: '#DCE3EC', backgroundColor: '#F8FAFD', padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rosterCardSelected: { backgroundColor: '#EAF1FF', borderColor: '#9CBDF8' },
  rosterCardPressed: { opacity: 0.82 },
  rosterAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#DCE9FF', alignItems: 'center', justifyContent: 'center' },
  rosterAvatarText: { color: '#285EB6', fontSize: 12, fontWeight: '900' },
  rosterNameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rosterName: { flex: 1, color: '#111827', fontSize: 12, fontWeight: '900' },
  rosterState: { minHeight: 20, borderRadius: 10, paddingHorizontal: 7, alignItems: 'center', justifyContent: 'center' },
  rosterStateLive: { backgroundColor: '#E6F7EF' },
  rosterStateText: { fontSize: 9, fontWeight: '900' },
  rosterStateTextLive: { color: '#16794D' },
  rosterMeta: { color: '#64748B', fontSize: 10, lineHeight: 14, marginTop: 1 },
  rosterEmpty: { borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: '#DCE3EC', backgroundColor: '#F8FAFD', padding: 14 },
  rosterEmptyTitle: { color: '#111827', fontSize: 12, fontWeight: '800' },
  rosterEmptyBody: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 4 },
  healthRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  healthChip: { minWidth: '29%', flexGrow: 1, minHeight: 52, borderRadius: 13, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'center' },
  healthChipReady: { backgroundColor: '#ECF9F1', borderColor: '#B9E7CC' },
  healthChipWarning: { backgroundColor: '#FFF8E8', borderColor: '#F2D79C' },
  healthChipDanger: { backgroundColor: '#FFF1F0', borderColor: '#F3C6C3' },
  healthLabel: { color: '#64748B', fontSize: 9, fontWeight: '800' },
  healthValue: { fontSize: 11, fontWeight: '900', marginTop: 3 },
  healthValueReady: { color: '#16794D' },
  healthValueWarning: { color: '#9A6200' },
  healthValueDanger: { color: '#B42318' },
  noteText: { color: '#64748B', fontSize: 11, lineHeight: 17, marginHorizontal: 16 },
  pickerScreen: { flex: 1, backgroundColor: '#F5F8FC', paddingHorizontal: 18 },
  pickerHeader: { paddingTop: 28, paddingBottom: 20 },
  pickerIcon: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1769D2', marginBottom: 14 },
  pickerIconText: { color: '#FFFFFF', fontSize: 23, fontWeight: '900' },
  pickerTitle: { color: '#10233F', fontSize: 24, fontWeight: '900' },
  pickerSubtitle: { color: '#64748B', fontSize: 13, lineHeight: 19, marginTop: 6 },
  pickerStatusRow: { minHeight: 46, borderRadius: 14, borderWidth: 1, borderColor: '#DCE3EC', backgroundColor: '#FFFFFF', paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerStatusText: { flex: 1, color: '#475569', fontSize: 11, fontWeight: '700' },
  pickerRefresh: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 9 },
  pickerRefreshText: { color: '#1769D2', fontSize: 11, fontWeight: '800' },
  pickerList: { paddingTop: 14, paddingBottom: 32, gap: 8 },
  loader: { marginTop: 32 }
});
