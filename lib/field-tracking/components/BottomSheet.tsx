import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type PanResponderGestureState
} from 'react-native';
import { palette, shadow } from '../theme';

export function BottomSheet({
  collapsedHeight = 190,
  expandedRatio = 0.78,
  title,
  subtitle,
  rightLabel,
  children,
  actions,
  initiallyExpanded = false
}: {
  collapsedHeight?: number;
  expandedRatio?: number;
  title: string;
  subtitle?: string;
  rightLabel?: string;
  children: ReactNode;
  actions?: ReactNode;
  initiallyExpanded?: boolean;
}) {
  const { height } = useWindowDimensions();
  const expandedHeight = Math.max(collapsedHeight + 180, Math.round(height * expandedRatio));
  const collapsedOffset = Math.max(0, expandedHeight - collapsedHeight);
  const translateY = useRef(new Animated.Value(initiallyExpanded ? 0 : collapsedOffset)).current;
  const dragStart = useRef(0);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [actionsHeight, setActionsHeight] = useState(0);

  const snapTo = (nextExpanded: boolean) => {
    setExpanded(nextExpanded);
    Animated.spring(translateY, {
      toValue: nextExpanded ? 0 : collapsedOffset,
      useNativeDriver: true,
      damping: 24,
      stiffness: 220,
      mass: 0.9
    }).start();
  };

  const settle = (gesture: PanResponderGestureState, current: number) => {
    if (gesture.vy < -0.55) return snapTo(true);
    if (gesture.vy > 0.55) return snapTo(false);
    snapTo(current < collapsedOffset * 0.48);
  };

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 4,
    onPanResponderGrant: () => {
      translateY.stopAnimation((value) => {
        dragStart.current = typeof value === 'number' ? value : 0;
      });
    },
    onPanResponderMove: (_, gesture) => {
      translateY.setValue(Math.max(0, Math.min(collapsedOffset, dragStart.current + gesture.dy)));
    },
    onPanResponderRelease: (_, gesture) => {
      const current = Math.max(0, Math.min(collapsedOffset, dragStart.current + gesture.dy));
      settle(gesture, current);
    },
    onPanResponderTerminate: (_, gesture) => {
      const current = Math.max(0, Math.min(collapsedOffset, dragStart.current + gesture.dy));
      settle(gesture, current);
    }
  }), [collapsedOffset, translateY]);

  const onHeaderLayout = (event: LayoutChangeEvent) => setHeaderHeight(event.nativeEvent.layout.height);
  const onActionsLayout = (event: LayoutChangeEvent) => setActionsHeight(event.nativeEvent.layout.height);
  const contentMaxHeight = Math.max(100, expandedHeight - headerHeight - actionsHeight - 38);

  return (
    <Animated.View style={[styles.sheet, { height: expandedHeight, transform: [{ translateY }] }]}> 
      <Pressable accessibilityRole="button" accessibilityLabel={expanded ? 'Collapse details' : 'Expand details'} onPress={() => snapTo(!expanded)} style={styles.handleWrap} {...panResponder.panHandlers}>
        <View style={styles.handle} />
      </Pressable>
      <View style={styles.header} onLayout={onHeaderLayout} {...panResponder.panHandlers}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
        </View>
        {rightLabel ? <View style={styles.statusPill}><Text style={styles.rightLabel}>{rightLabel}</Text></View> : null}
      </View>
      {actions ? <View style={styles.actions} onLayout={onActionsLayout}>{actions}</View> : null}
      <View style={styles.divider} />
      <Animated.ScrollView
        style={{ maxHeight: contentMaxHeight }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </Animated.ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: palette.surface,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    borderWidth: 1,
    borderColor: palette.line,
    overflow: 'hidden',
    shadowColor: '#172033',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 12
  },
  handleWrap: { alignItems: 'center', justifyContent: 'center', paddingTop: 9, paddingBottom: 4 },
  handle: { width: 40, height: 5, borderRadius: 999, backgroundColor: '#C7D0DD' },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 12 },
  title: { color: palette.text, fontSize: 20, lineHeight: 25, fontWeight: '900', letterSpacing: -0.3 },
  subtitle: { color: palette.textMuted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  statusPill: { minHeight: 28, borderRadius: 14, backgroundColor: '#EAF1FF', paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  rightLabel: { color: '#285EB6', fontSize: 10, fontWeight: '900', letterSpacing: 0.7, textTransform: 'uppercase' },
  actions: { paddingHorizontal: 18, paddingBottom: 10, gap: 10 },
  divider: { height: 1, backgroundColor: '#EEF1F5' },
  content: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 34, gap: 12 }
});
