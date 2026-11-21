import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RouteMap } from '../components/RouteMap';
import { StatusDot } from '../components/Primitives';
import { BottomSheet } from '../components/BottomSheet';
import { useLiveRoute } from './useLiveRoute';
import { formatDistance, formatDuration } from '../geo';
import type { FieldSessionKpis, FieldTrackingDaySummary, HaltRecord } from '../types';
import { useAuth } from '@/contexts/AuthContext';

export function AdminScreen({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { company, user } = useAuth();
  const {
    employee, employees, points, connectionState, error, serverHealth, kpis, kpiState,
    refresh, selectEmployee, selectedDate, selectDate, calendarMonth, selectMonth,
    calendarDays, calendarState, viewingLive,
  } = useLiveRoute(company?.id ?? user?.companyId ?? null, user?.role === 'admin');
  const [selectingEmployee, setSelectingEmployee] = useState(true);
  const live = connectionState === 'live' && viewingLive;
  const selectedDateLabel = formatSelectedDate(selectedDate);
  const routeHalts = useMemo<HaltRecord[]>(() => (kpis?.activity ?? [])
    .filter((activity) => activity.type === 'halt')
    .map((activity) => ({
      id: activity.id,
      latitude: activity.start.latitude,
      longitude: activity.start.longitude,
      status: activity.active ? 'ongoing' : 'completed',
      startedAt: activity.startedAt,
      endedAt: activity.endedAt,
      durationSeconds: activity.endedAt
        ? Math.max(0, (new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 1000)
        : Math.max(0, (Date.now() - new Date(activity.startedAt).getTime()) / 1000),
      label: `${activity.start.latitude.toFixed(5)}, ${activity.start.longitude.toFixed(5)}`,
    })), [kpis?.activity]);

  if (selectingEmployee) {
    return <EmployeePicker employees={employees} connectionState={connectionState} error={error} onOpenMenu={onOpenMenu} onRefresh={refresh} onSelect={(employeeId, companyId) => {
      selectEmployee(employeeId, companyId);
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
          plannedRoute={points.map(({ latitude, longitude }) => ({ latitude, longitude }))}
          destination={null}
          waypoints={[]}
          progressPercent={0}
          halts={routeHalts}
          interactiveHalts
          follow={viewingLive}
          previewRoute={!viewingLive && points.length > 1}
        />

        <View style={styles.topBar} pointerEvents="box-none">
          <View style={styles.mapPill}>
            <View style={styles.brandDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.mapPillTitle}>{employee?.name ?? 'Operations map'}</Text>
              <Text style={styles.mapPillSubtitle}>{viewingLive ? 'Live field tracking' : `Route history · ${selectedDateLabel}`}</Text>
            </View>
            <Pressable onPress={() => setSelectingEmployee(true)} style={styles.changeButton}>
              <Text style={styles.changeButtonText}>Change</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.mapInfoRow} pointerEvents="box-none">
          <View style={styles.infoPill}>
            <StatusDot tone={live ? 'live' : connectionState === 'offline' ? 'danger' : 'warning'} />
            <Text style={styles.infoPillText}>{viewingLive ? 'live' : connectionState === 'offline' ? 'offline' : 'history'}</Text>
          </View>
          <Pressable onPress={() => void refresh()} style={({ pressed }) => [styles.infoPill, pressed && { opacity: 0.82 }]}>
            <Text style={styles.infoPillMuted}>Refresh</Text>
          </Pressable>
        </View>

        <BottomSheet
          title={employee?.name ?? 'No active employee'}
          subtitle={employee ? (viewingLive ? 'Live tracking' : selectedDateLabel) : 'Waiting for field history.'}
          rightLabel={live ? 'Live' : viewingLive ? connectionState : 'History'}
          collapsedHeight={220}
          expandedRatio={0.84}
        >
          <SectionCard title={`Field team · ${employees.length}`}>
            {employees.length ? (
              <View style={styles.rosterRows}>
                {employees.map((item) => (
                  <EmployeeRosterCard
                    key={`${item.companyId}:${item.employeeId}:${item.sessionId}`}
                    employee={item}
                    selected={item.companyId === employee?.companyId && item.employeeId === employee?.employeeId && item.sessionId === employee?.sessionId}
                    onPress={() => selectEmployee(item.employeeId, item.companyId)}
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

          <SectionCard title="Daily route calendar">
            <DailyCalendar
              month={calendarMonth}
              selectedDate={selectedDate}
              days={calendarDays}
              loading={calendarState === 'loading'}
              onSelectDate={selectDate}
              onChangeMonth={selectMonth}
            />
          </SectionCard>

          <SectionCard title={`Field performance · ${selectedDateLabel}`}>
            {kpis ? <FieldPerformanceKpis kpis={kpis} dateLabel={selectedDateLabel} /> : (
              <LiveKpiPreview employee={employee} loading={kpiState === 'loading'} unavailable={kpiState === 'unavailable'} />
            )}
          </SectionCard>
          
          {error ? <Text style={styles.noteText}>Connection note · {error}</Text> : null}

          <SectionCard title="System health">
            <View style={styles.healthRow}>
              <HealthChip label="API" value={serverHealth.apiReachable ? 'Ready' : 'Offline'} ready={serverHealth.apiReachable} />
              <HealthChip label="Live polling" value={connectionState} ready={connectionState === 'live'} warning={connectionState !== 'offline' && connectionState !== 'live'} />
              <HealthChip label="Routing API" value={serverHealth.routerReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.routerReachable} />
              <HealthChip label="Geocoding API" value={serverHealth.geocoderReachable ? 'Ready' : 'Unavailable'} ready={serverHealth.geocoderReachable} />
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
  onSelect: (employeeId: string, companyId: string) => void;
}) {
  const loading = connectionState === 'connecting' || connectionState === 'recovering';
  const checkedIn = employees.filter((item) => item.attendanceActive).length;
  const activelyTracking = employees.filter((item) => item.trackingActive).length;
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
          <Text style={styles.pickerTitle}>Choose employee</Text>
          <Text style={styles.pickerSubtitle}>Open live tracking or review any previous work day.</Text>
        </View>
        <View style={styles.pickerStatusRow}>
          <StatusDot tone={connectionState === 'live' ? 'live' : connectionState === 'offline' ? 'danger' : 'warning'} />
          <Text style={styles.pickerStatusText}>{connectionState === 'live' ? `${checkedIn} checked in · ${activelyTracking} tracking now · ${employees.length} total` : connectionState}</Text>
          <Pressable onPress={onRefresh} style={styles.pickerRefresh}><Text style={styles.pickerRefreshText}>Refresh</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pickerList} showsVerticalScrollIndicator={false}>
          {loading && !employees.length ? <ActivityIndicator color="#1769D2" style={styles.loader} /> : null}
          {employees.map((item) => (
            <EmployeeRosterCard
              key={`${item.companyId}:${item.employeeId}:${item.sessionId}`}
              employee={item}
              selected={false}
              onPress={() => onSelect(item.employeeId, item.companyId)}
            />
          ))}
          {!loading && !employees.length ? (
            <View style={styles.rosterEmpty}>
              <Text style={styles.rosterEmptyTitle}>No tracking history yet</Text>
              <Text style={styles.rosterEmptyBody}>An employee appears here after the first verified GPS location sync.</Text>
            </View>
          ) : null}
          {error ? <Text style={styles.noteText}>Connection note · {error}</Text> : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

function EmployeeRosterCard({ employee, selected, onPress }: { employee: any; selected: boolean; onPress: () => void }) {
  const isLive = employee.status === 'live';
  const isCurrentlyTracking = employee.trackingActive;
  const stateLabel = isLive ? 'LIVE' : employee.status === 'waiting' ? 'CHECKED IN' : employee.status === 'delayed' ? 'DELAYED' : employee.status === 'stale' ? 'STALE' : 'HISTORY';
  const speed = employee.speed == null || employee.speed < 0 ? '—' : `${Math.round(employee.speed * 3.6)} km/h`;
  const accuracy = employee.accuracy == null ? 'GPS —' : `GPS ±${Math.round(employee.accuracy)} m`;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.rosterCard, selected && styles.rosterCardSelected, pressed && styles.rosterCardPressed]}>
      <View style={styles.rosterAvatar}><Text style={styles.rosterAvatarText}>{employee.initials}</Text></View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.rosterNameRow}>
          <Text style={styles.rosterName} numberOfLines={1}>{employee.name}</Text>
          <View style={[styles.rosterState, isLive ? styles.rosterStateLive : styles.rosterStateHistory]}><Text style={[styles.rosterStateText, isLive ? styles.rosterStateTextLive : styles.rosterStateTextHistory]}>{stateLabel}</Text></View>
        </View>
        <Text style={styles.rosterMeta} numberOfLines={1}>{accuracy} · {speed} · {employee.battery == null ? 'Battery —' : `${employee.battery}% battery`}</Text>
        <Text style={styles.rosterMeta}>{isLive ? 'Live now · tap to open' : employee.status === 'waiting' ? 'Checked in · waiting for first GPS sync' : isCurrentlyTracking ? 'Tracking sync delayed · tap to inspect' : 'History available · tap to review'}</Text>
      </View>
    </Pressable>
  );
}

function DailyCalendar({
  month,
  selectedDate,
  days,
  loading,
  onSelectDate,
  onChangeMonth,
}: {
  month: string;
  selectedDate: string;
  days: FieldTrackingDaySummary[];
  loading: boolean;
  onSelectDate: (date: string) => void;
  onChangeMonth: (month: string) => void;
}) {
  const [year, monthNumber] = month.split('-').map(Number);
  const monthIndex = Math.max(0, Math.min(11, (monthNumber || 1) - 1));
  const firstWeekday = new Date(year || 1970, monthIndex, 1).getDay();
  const daysInMonth = new Date(year || 1970, monthIndex + 1, 0).getDate();
  const byDate = new Map(days.map((day) => [day.date, day]));
  const selectedSummary = byDate.get(selectedDate) ?? null;
  const cells: ({ date: string; dayNumber: number } | null)[] = Array.from({ length: firstWeekday }, () => null);
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
    cells.push({ date: `${month}-${String(dayNumber).padStart(2, '0')}`, dayNumber });
  }
  while (cells.length % 7) cells.push(null);
  const moveMonth = (delta: number) => {
    const next = new Date(year || 1970, monthIndex + delta, 1);
    onChangeMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  };
  const monthLabel = new Date(year || 1970, monthIndex, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });

  return (
    <>
      <View style={styles.calendarHeader}>
        <Pressable accessibilityLabel="Previous month" onPress={() => moveMonth(-1)} style={styles.calendarArrow}><Ionicons name="chevron-back" size={18} color="#285EB6" /></Pressable>
        <View style={styles.calendarHeadingWrap}>
          <Text style={styles.calendarHeading}>{monthLabel}</Text>
          <Text style={styles.calendarSubheading}>{loading ? 'Loading work days…' : `${days.length} tracked day${days.length === 1 ? '' : 's'}`}</Text>
        </View>
        <Pressable accessibilityLabel="Next month" onPress={() => moveMonth(1)} style={styles.calendarArrow}><Ionicons name="chevron-forward" size={18} color="#285EB6" /></Pressable>
      </View>
      <View style={styles.weekdayRow}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => <Text key={`${label}-${index}`} style={styles.weekdayLabel}>{label}</Text>)}
      </View>
      <View style={styles.calendarGrid}>
        {cells.map((cell, index) => {
          if (!cell) return <View key={`blank-${index}`} style={styles.calendarDay} />;
          const summary = byDate.get(cell.date);
          const selected = cell.date === selectedDate;
          return (
            <Pressable
              key={cell.date}
              accessibilityRole="button"
              accessibilityLabel={`${formatSelectedDate(cell.date)}${summary ? `, ${formatDistance(summary.distanceMetres)} travelled` : ', no route data'}`}
              onPress={() => onSelectDate(cell.date)}
              style={({ pressed }) => [styles.calendarDay, selected && styles.calendarDaySelected, pressed && styles.calendarDayPressed]}
            >
              <Text style={[styles.calendarDayNumber, selected && styles.calendarDayNumberSelected, !summary && styles.calendarDayNumberEmpty]}>{cell.dayNumber}</Text>
              {summary ? <View style={[styles.calendarDot, selected && styles.calendarDotSelected]} /> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.calendarLegend}>
        <View style={styles.calendarLegendDot} />
        <Text style={styles.calendarLegendText}>Dot means verified route data is available. Tap a date to preview its route and KPIs.</Text>
      </View>
      {selectedSummary ? (
        <View style={styles.selectedDaySummary}>
          <View><Text style={styles.selectedDayLabel}>Travelled</Text><Text style={styles.selectedDayValue}>{formatDistance(selectedSummary.distanceMetres)}</Text></View>
          <View><Text style={styles.selectedDayLabel}>Tracked</Text><Text style={styles.selectedDayValue}>{formatDuration(selectedSummary.shiftSeconds)}</Text></View>
          <View><Text style={styles.selectedDayLabel}>Shifts</Text><Text style={styles.selectedDayValue}>{selectedSummary.sessionCount}</Text></View>
          <View><Text style={styles.selectedDayLabel}>Visits</Text><Text style={styles.selectedDayValue}>{selectedSummary.visitCompleted}/{selectedSummary.visitTotal}</Text></View>
        </View>
      ) : <Text style={styles.calendarEmptyText}>No verified route was recorded on the selected date.</Text>}
    </>
  );
}

function FieldPerformanceKpis({ kpis, dateLabel }: { kpis: FieldSessionKpis; dateLabel: string }) {
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
      <View style={styles.dayScopeBanner}>
        <View style={styles.dayScopeDot} />
        <View style={{ flex: 1 }}>
          <Text style={styles.dayScopeTitle}>{dateLabel} only</Text>
          <Text style={styles.dayScopeDetail}>Offline GPS gaps and rejected jumps are excluded from every metric.</Text>
        </View>
      </View>
      <Text style={styles.activityTitle}>Verified day timeline</Text>
      <View style={styles.activityTimeline}>
        {kpis.activity.length ? kpis.activity.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} />
        )) : <Text style={styles.activityEmpty}>Movement history will appear after verified GPS points are received.</Text>}
      </View>
      <View style={styles.kpiGrid}>
        <KpiCard label="Tracked time" value={formatDuration(kpis.shiftSeconds)} />
        <KpiCard label="Moving time" value={formatDuration(kpis.movingSeconds)} />
        <KpiCard label="Travelled" value={formatDistance(kpis.distanceMetres)} />
        <KpiCard label="Avg. speed" value={kpis.averageMovingSpeedKmh == null ? '—' : `${Math.round(kpis.averageMovingSpeedKmh)} km/h`} />
        <KpiCard label="Stopped time" value={haltValue} warning={kpis.activeHalt || kpis.haltSeconds >= 30 * 60} />
        <KpiCard label="Verified halts" value={`${kpis.haltCount}`} warning={kpis.activeHalt} />
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
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  React.useEffect(() => {
    if (activity.endedAt != null) return;
    const timer = setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [activity.endedAt]);
  const durationSeconds = activity.endedAt == null
    ? Math.max(0, (currentTime - new Date(activity.startedAt).getTime()) / 1000)
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
  return <View style={[styles.kpiCard, warning && styles.kpiCardWarning]}><Text style={styles.kpiLabel}>{label}</Text><Text style={[styles.kpiValue, warning && styles.kpiValueWarning]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78}>{value}</Text></View>;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return 'waiting';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function formatSelectedDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return parsed.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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
  rosterStateHistory: { backgroundColor: '#EEF2F7' },
  rosterStateText: { fontSize: 9, fontWeight: '900' },
  rosterStateTextLive: { color: '#16794D' },
  rosterStateTextHistory: { color: '#526176' },
  rosterMeta: { color: '#64748B', fontSize: 10, lineHeight: 14, marginTop: 1 },
  rosterEmpty: { borderRadius: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: '#DCE3EC', backgroundColor: '#F8FAFD', padding: 14 },
  rosterEmptyTitle: { color: '#111827', fontSize: 12, fontWeight: '800' },
  rosterEmptyBody: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 4 },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  calendarArrow: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF4FF', borderWidth: 1, borderColor: '#D6E4FF' },
  calendarHeadingWrap: { flex: 1, alignItems: 'center' },
  calendarHeading: { color: '#111827', fontSize: 14, fontWeight: '900' },
  calendarSubheading: { color: '#64748B', fontSize: 9, marginTop: 2 },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekdayLabel: { width: '14.285%', textAlign: 'center', color: '#94A3B8', fontSize: 9, fontWeight: '900' },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDay: { width: '14.285%', height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  calendarDaySelected: { backgroundColor: '#1769D2' },
  calendarDayPressed: { opacity: 0.72 },
  calendarDayNumber: { color: '#24344D', fontSize: 11, fontWeight: '800' },
  calendarDayNumberSelected: { color: '#FFFFFF' },
  calendarDayNumberEmpty: { color: '#AAB4C2', fontWeight: '600' },
  calendarDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#1C9A69', marginTop: 3 },
  calendarDotSelected: { backgroundColor: '#CFF8E7' },
  calendarLegend: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 10 },
  calendarLegendDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#1C9A69', marginTop: 4 },
  calendarLegendText: { flex: 1, color: '#64748B', fontSize: 9, lineHeight: 14 },
  selectedDaySummary: { flexDirection: 'row', justifyContent: 'space-between', borderRadius: 13, backgroundColor: '#F3F7FD', borderWidth: 1, borderColor: '#DCE5F1', paddingHorizontal: 12, paddingVertical: 10, marginTop: 11 },
  selectedDayLabel: { color: '#64748B', fontSize: 8, fontWeight: '800', textTransform: 'uppercase' },
  selectedDayValue: { color: '#152238', fontSize: 11, fontWeight: '900', marginTop: 3 },
  calendarEmptyText: { color: '#64748B', fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 12, paddingVertical: 8 },
  activityHeader: { borderLeftWidth: 3, borderLeftColor: '#1769D2', paddingLeft: 11, marginBottom: 14 },
  activityHeaderTitle: { color: '#111827', fontSize: 13, fontWeight: '900' },
  activityHeaderDetail: { color: '#64748B', fontSize: 10, lineHeight: 15, marginTop: 3 },
  dayScopeBanner: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, borderWidth: 1, borderColor: '#CFE2FF', backgroundColor: '#F2F7FF', paddingHorizontal: 11, paddingVertical: 9, marginBottom: 14 },
  dayScopeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1769D2', marginTop: 3 },
  dayScopeTitle: { color: '#173A70', fontSize: 10, fontWeight: '900' },
  dayScopeDetail: { color: '#60728D', fontSize: 9, lineHeight: 13, marginTop: 2 },
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
