/** Platform-neutral thresholds shared by the native engine and Node tests. */
export const fieldTrackingSamplingPolicy = {
  routeAccuracyLimitM: 80,
  stationaryAnchorIntervalMs: 120_000,
  degradedAnchorIntervalMs: 60_000,
} as const;
