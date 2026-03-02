import * as Haptics from "expo-haptics";

type ImpactAsync = typeof Haptics.impactAsync;
type NotificationAsync = typeof Haptics.notificationAsync;
type SelectionAsync = typeof Haptics.selectionAsync;

let initialized = false;
let originalImpactAsync: ImpactAsync | null = null;
let originalNotificationAsync: NotificationAsync | null = null;
let originalSelectionAsync: SelectionAsync | null = null;

const noop = async () => {};

function init(): void {
  if (initialized) return;
  initialized = true;
  originalImpactAsync = Haptics.impactAsync.bind(Haptics);
  originalNotificationAsync = Haptics.notificationAsync.bind(Haptics);
  originalSelectionAsync = Haptics.selectionAsync.bind(Haptics);
}

export function applyHapticsPolicy(enabled: boolean): void {
  init();
  const target = Haptics as unknown as {
    impactAsync: ImpactAsync;
    notificationAsync: NotificationAsync;
    selectionAsync: SelectionAsync;
  };

  if (enabled) {
    if (originalImpactAsync) target.impactAsync = originalImpactAsync;
    if (originalNotificationAsync) target.notificationAsync = originalNotificationAsync;
    if (originalSelectionAsync) target.selectionAsync = originalSelectionAsync;
    return;
  }

  target.impactAsync = noop as ImpactAsync;
  target.notificationAsync = noop as NotificationAsync;
  target.selectionAsync = noop as SelectionAsync;
}
