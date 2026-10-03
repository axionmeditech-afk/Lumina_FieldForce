import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { palette, radii, shadow, spacing } from '../theme';

export function Brand() {
  return (
    <View>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}><View style={styles.brandMarkCore} /></View>
        <Text style={styles.brand}>TRACECORE</Text>
      </View>
      <Text style={styles.kicker}>FIELD OPERATIONS</Text>
    </View>
  );
}

export function StatusDot({ tone = 'live' }: { tone?: 'live' | 'warning' | 'danger' | 'muted' }) {
  const backgroundColor = tone === 'live' ? palette.success : tone === 'warning' ? palette.warning : tone === 'danger' ? palette.danger : palette.textSubtle;
  return <View style={[styles.dot, { backgroundColor }]} />;
}

export function Chip({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: 'neutral' | 'live' | 'warning' | 'danger' }>) {
  const colors = tone === 'live'
    ? { border: '#B9E4D2', background: palette.successSoft }
    : tone === 'warning'
      ? { border: '#F0D29D', background: palette.warningSoft }
      : tone === 'danger'
        ? { border: '#F2BDC1', background: palette.dangerSoft }
        : { border: palette.line, background: palette.surface };
  return <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.background }]}>{typeof children === 'string' || typeof children === 'number' ? <Text style={styles.chipText}>{children}</Text> : children}</View>;
}

export function Metric({ label, value, meta }: { label: string; value: string; meta?: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      {meta ? <Text style={styles.metricMeta} numberOfLines={2}>{meta}</Text> : null}
    </View>
  );
}

export function Panel({ children, style }: PropsWithChildren<{ style?: ViewStyle | ViewStyle[] }>) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export function PrimaryButton({ label, onPress, busy, danger = false, disabled = false }: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        danger && styles.dangerButton,
        (disabled || busy) && styles.disabledButton,
        pressed && !disabled && !busy && styles.pressedButton
      ]}
    >
      {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryLabel}>{label}</Text>}
    </Pressable>
  );
}

export function SectionTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 23, height: 23, borderRadius: 7, backgroundColor: palette.primarySoft, alignItems: 'center', justifyContent: 'center' },
  brandMarkCore: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.primary },
  brand: { color: palette.text, fontSize: 17, fontWeight: '900', letterSpacing: 1.1 },
  kicker: { color: palette.textMuted, fontSize: 8, fontWeight: '800', letterSpacing: 2, marginTop: 4, marginLeft: 32 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chip: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: palette.text, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  metric: { flex: 1, minHeight: 92, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: radii.md, padding: 13, ...shadow.card },
  metricLabel: { color: palette.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  metricValue: { color: palette.text, fontSize: 22, fontWeight: '900', marginTop: 9, fontVariant: ['tabular-nums'] },
  metricMeta: { color: palette.textMuted, fontSize: 9, lineHeight: 13, marginTop: 4 },
  panel: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: radii.lg, padding: spacing.md, ...shadow.card },
  primaryButton: { minHeight: 58, borderRadius: radii.md, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, ...shadow.card },
  dangerButton: { backgroundColor: palette.danger },
  disabledButton: { opacity: 0.55 },
  pressedButton: { transform: [{ scale: 0.99 }], backgroundColor: palette.primaryDark },
  primaryLabel: { color: '#FFFFFF', fontSize: 12, fontWeight: '900', letterSpacing: 0.9, textTransform: 'uppercase' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  eyebrow: { color: palette.primary, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: palette.text, fontSize: 25, lineHeight: 30, fontWeight: '900', marginTop: 4, letterSpacing: -0.35 }
});
