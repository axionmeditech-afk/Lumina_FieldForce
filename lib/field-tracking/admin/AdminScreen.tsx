import React, { useState } from 'react';
import { StyleSheet, Text, View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RouteMap } from '../components/RouteMap';
import { StatusDot } from '../components/Primitives';
import { BottomSheet } from '../components/BottomSheet';
import { useLiveRoute } from './useLiveRoute';
import { formatDistance, formatDuration } from '../geo';
import type { FieldSessionKpis } from '../types';

export function AdminScreen({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { employee, employees, points, connectionState, error, serverHealth, kpis, kpiState, refresh, selectEmployee } = useLiveRoute();
  const [selectingEmployee, setSelectingEmployee] = useState(true);
  const live = connectionState === 'live';

  if (selectingEmployee) {
    return <EmployeePicker employees={employees} connectionState={connectionState} error={error} onOpenMenu={onOpenMenu} onRefresh={refresh} onSelect={(employeeId) => {
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

          <SectionCard title="Field performance KPIs">
            {kpis ? <FieldPerformanceKpis kpis={kpis} /> : (
              <LiveKpiPreview employee={employee} loading={kpiState === 'loading'} unavailable={kpiState === 'unavailable'} />
            )}
          </SectionCard>
          
          {error ? <Text style={styles.noteText}>Connection note · {error}</Text> : null}

          <SectionCard title="System health">
            <View style={styles.healthRow}>
              <HealthChip label="API" value={serverHealth.apiReachable ? 'Ready' : 'Offline'} ready={serverHealth.apiReachable} />
              <HealthChip label="Live polling" value={connectionState} ready={connectionState === 'live'} warning={connectionState !== 'offline' && connectionState !== 'live'} />
              <HealthChip label="Valhalla" value={serverHealth.routerReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.routerReachable} />
              <HealthChip label="Nominatim" value={serverHealth.geocoderReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.geocoderReachable} />
            </View>
          </SectionCard>
        </BottomSheet>
      </View>
    </SafeAreaView>
  );
}

function EmployeePicker({
  employees,
  connectionState,
  error,
  onOpenMenu,
  onRefresh,
  onSelect,
}: {
  employees: any[];
  connectionState: string;
  error: string | null;
  onOpenMenu: () => void;
  onRefresh: () => void;
  onSelect: (employeeId: string) => void;
}) {
  const loading = connectionState === 'connecting' || connectionState === 'recovering';
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.pickerScreen}>
        <View style={styles.pickerHeader}>
          <View style={styles.pickerIcon}><Text style={styles.pickerIconText}>⌖</Text></View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open navigation menu"
            onPress={onOpenMenu}
            style={({ pressed }) => [styles.pickerMenuButton, pressed && styles.pickerMenuButtonPressed]}
          >
            <Ionicons name="menu" size={25} color="#152238" />
          </Pressable>
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

function FieldPerformanceKpis({ kpis }: { kpis: FieldSessionKpis }) {
  const nextVisit = kpis.nextVisit;
  const statusTitle = nextVisit
    ? nextVisit.status === 'arrived' ? `Arrived at ${nextVisit.name}` : `Heading to ${nextVisit.name}`
    : 'No pending visit assigned';
  const statusDetail = nextVisit
    ? `${nextVisit.address || 'Assigned field visit'} · ${nextVisit.distanceMetres == null ? 'distance unavailable' : `${formatDistance(nextVisit.distanceMetres)} away`}`
    : 'Live GPS, distance and halt metrics remain available for this field shift.';
  const haltValue = kpis.activeHalt ? `${formatDuration(kpis.haltSeconds)} active` : kpis.haltCount ? formatDuration(kpis.haltSeconds) : 'None';

  return (
    <>
      <View style={styles.activityHeader}>
        <Text style={styles.activityHeaderTitle}>{statusTitle}</Text>
        <Text style={styles.activityHeaderDetail}>{statusDetail}</Text>
      </View>
      <Text style={styles.activityTitle}>Recent field activity</Text>
      <View style={styles.activityTimeline}>
        {kpis.activity.length ? kpis.activity.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} />
        )) : <Text style={styles.activityEmpty}>Movement history will appear after verified GPS points are received.</Text>}
      </View>
      <View style={styles.kpiGrid}>
        <KpiCard label="Shift time" value={formatDuration(kpis.shiftSeconds)} />
        <KpiCard label="Moving time" value={formatDuration(kpis.movingSeconds)} />
        <KpiCard label="Travelled" value={formatDistance(kpis.distanceMetres)} />
        <KpiCard label="Avg. speed" value={kpis.averageMovingSpeedKmh == null ? '—' : `${Math.round(kpis.averageMovingSpeedKmh)} km/h`} />
        <KpiCard label="Total halt" value={haltValue} warning={kpis.activeHalt || kpis.haltSeconds >= 30 * 60} />
        <KpiCard label="Halt count" value={`${kpis.haltCount}`} warning={kpis.activeHalt} />
        <KpiCard label="Visits" value={`${kpis.visitCompleted}/${kpis.visitTotal} done`} />
        <KpiCard label="GPS quality" value={kpis.gpsAccuracyMetres == null ? 'Waiting' : `±${Math.round(kpis.gpsAccuracyMetres)} m`} />
      </View>
      <Text style={styles.kpiNote}>Last verified GPS: {formatAge(kpis.lastPointAgeSeconds)} · {kpis.acceptedPoints}/{kpis.totalPoints} points accepted.</Text>
    </>
  );
}

function LiveKpiPreview({ employee, loading, unavailable }: { employee: any; loading: boolean; unavailable: boolean }) {
  const speed = employee?.speed == null || employee.speed < 0 ? '—' : `${Math.round(employee.speed * 3.6)} km/h`;
  const accuracy = employee?.accuracy == null ? 'Waiting' : `±${Math.round(employee.accuracy)} m`;
  return (
    <>
      <View style={styles.previewSyncRow}>
        {loading ? <ActivityIndicator color="#1769D2" size="small" /> : null}
        <Text style={styles.previewSyncText}>{unavailable ? 'Activity details will retry automatically.' : loading ? 'Loading field activity details...' : 'Select an employee to load field activity.'}</Text>
      </View>
      <View style={styles.kpiGrid}>
        <KpiCard label="Live speed" value={speed} />
        <KpiCard label="GPS quality" value={accuracy} />
        <KpiCard label="Last GPS" value={employee ? 'Live' : 'Waiting'} />
        <KpiCard label="Field state" value={employee ? 'Active' : '—'} />
      </View>
    </>
  );
}

function ActivityRow({ activity }: { activity: FieldSessionKpis['activity'][number] }) {
  const isHalt = activity.type === 'halt';
  const durationSeconds = activity.endedAt == null
    ? Math.max(0, (Date.now() - new Date(activity.startedAt).getTime()) / 1000)
    : Math.max(0, (new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 1000);
  return (
    <View style={styles.activityRow}>
      <View style={[styles.activityMarker, isHalt ? styles.activityMarkerHalt : styles.activityMarkerMove]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.activityRowTitle}>{isHalt ? `${activity.active ? 'Current halt' : 'Halt'} · ${formatDuration(durationSeconds)}` : `Moved ${formatDistance(activity.distanceMetres)}`}</Text>
        <Text style={styles.activityRoute}>{isHalt ? `At ${formatCoordinate(activity.start)}` : `${formatCoordinate(activity.start)} → ${formatCoordinate(activity.end)}`}</Text>
        <Text style={styles.activityTime}>{formatActivityTime(activity.startedAt)} · {activity.endedAt ? formatActivityTime(activity.endedAt) : 'Now'}</Text>
      </View>
    </View>
  );
}

function KpiCard({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <View style={[styles.kpiCard, warning && styles.kpiCardWarning]}><Text style={styles.kpiLabel}>{label}</Text><Text style={[styles.kpiValue, warning && styles.kpiValueWarning]} numberOfLines={1}>{value}</Text></View>;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return 'waiting';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function formatCoordinate(point: { latitude: number; longitude: number }): string {
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

function formatActivityTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  activityHeader: { borderLeftWidth: 3, borderLeftColor: '#1769D2', paddingLeft: 11, marginBottom: 14 },
  activityHeaderTitle: { color: '#111827', fontSize: 13, fontWeight: '900' },
  activityHeaderDetail: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 3 },
  activityTitle: { color: '#475569', fontSize: 10, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.55, marginBottom: 8 },
  activityTimeline: { borderRadius: 14, borderWidth: 1, borderColor: '#DCE3EC', backgroundColor: '#F8FAFD', paddingHorizontal: 12, paddingVertical: 4 },
  activityEmpty: { color: '#64748B', fontSize: 10, lineHeight: 15, paddingVertical: 12 },
  activityRow: { minHeight: 66, flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#E7ECF3' },
  activityMarker: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  activityMarkerMove: { backgroundColor: '#1769D2' },
  activityMarkerHalt: { backgroundColor: '#C47A00' },
  activityRowTitle: { color: '#111827', fontSize: 11, fontWeight: '900' },
  activityRoute: { color: '#475569', fontSize: 10, lineHeight: 14, marginTop: 3 },
  activityTime: { color: '#94A3B8', fontSize: 9, marginTop: 3, fontWeight: '700' },
  previewSyncRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  previewSyncText: { flex: 1, color: '#64748B', fontSize: 10, lineHeight: 15 },
  kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  kpiCard: { width: '48%', minHeight: 68, borderRadius: 14, backgroundColor: '#F8FAFD', borderWidth: 1, borderColor: '#DCE3EC', paddingHorizontal: 11, paddingVertical: 10, justifyContent: 'center' },
  kpiCardWarning: { backgroundColor: '#FFF8E8', borderColor: '#F2D79C' },
  kpiLabel: { color: '#64748B', fontSize: 9, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.55 },
  kpiValue: { color: '#111827', fontSize: 15, fontWeight: '900', marginTop: 5 },
  kpiValueWarning: { color: '#9A6200' },
  kpiNote: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 10 },
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
  pickerHeader: { paddingTop: 88, paddingBottom: 20, position: 'relative' },
  pickerMenuButton: { position: 'absolute', top: 28, left: 0, width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DCE3EC', elevation: 3 },
  pickerMenuButtonPressed: { opacity: 0.82 },
  pickerIcon: { display: 'none' },
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
