import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAdaptiveSamplingDecision } from '../lib/field-tracking/tracking/adaptive-sampling';
import type { RoutePoint } from '../lib/field-tracking/types';

const basePoint: RoutePoint = {
  pointId: 'p1', sessionId: 's1', sequence: 1, latitude: 23.02, longitude: 72.57,
  accuracy: 10, speed: 0, heading: 0, battery: null, mocked: false,
  capturedAt: '2026-11-23T06:00:00.000Z', syncedAt: null, routeEligible: true, rejectionReason: null,
};

function location(timestamp: string, latitude: number, speed: number, accuracy = 10): any {
  return { timestamp: Date.parse(timestamp), mocked: false, coords: { latitude, longitude: 72.57, accuracy, speed, heading: 0, altitude: null, altitudeAccuracy: null } };
}

test('adaptive sampling preserves movement and coalesces stationary GPS noise', () => {
  const moving = deriveAdaptiveSamplingDecision(location('2026-11-23T06:00:05.000Z', 23.0201, 2), basePoint);
  assert.equal(moving.profile, 'moving');
  assert.equal(moving.retain, true);

  const stationary = deriveAdaptiveSamplingDecision(location('2026-11-23T06:00:20.000Z', 23.020001, 0), basePoint);
  assert.equal(stationary.profile, 'stationary');
  assert.equal(stationary.retain, false);

  const anchor = deriveAdaptiveSamplingDecision(location('2026-11-23T06:02:01.000Z', 23.020001, 0), basePoint);
  assert.equal(anchor.reason, 'stationary_anchor');
  assert.equal(anchor.retain, true);
});

test('weak fixes are retained as sparse diagnostics, never high-frequency route noise', () => {
  const noisy = deriveAdaptiveSamplingDecision(location('2026-11-23T06:00:10.000Z', 23.021, 0, 140), basePoint);
  assert.equal(noisy.profile, 'degraded');
  assert.equal(noisy.retain, false);
  const diagnostic = deriveAdaptiveSamplingDecision(location('2026-11-23T06:01:01.000Z', 23.021, 0, 140), basePoint);
  assert.equal(diagnostic.retain, true);
  assert.equal(diagnostic.reason, 'degraded_anchor');
});

test('twelve-hour stationary soak remains auditable without flooding the outbox', () => {
  let last = basePoint;
  let retained = 0;
  const start = Date.parse(basePoint.capturedAt);
  for (let elapsed = 5_000; elapsed <= 12 * 60 * 60_000; elapsed += 5_000) {
    const next = location(new Date(start + elapsed).toISOString(), 23.020001, 0);
    const decision = deriveAdaptiveSamplingDecision(next, last);
    if (!decision.retain) continue;
    retained += 1;
    last = { ...last, sequence: last.sequence + 1, capturedAt: new Date(start + elapsed).toISOString() };
  }
  assert.ok(retained >= 350 && retained <= 365, `expected roughly one stationary anchor every two minutes, got ${retained}`);
});
