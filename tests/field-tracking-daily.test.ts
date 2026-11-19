import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTrackingDay } from '../server/routes/field-tracking.routes';

type Point = Parameters<typeof summarizeTrackingDay>[0][number];

function point(
  sessionId: string,
  sequence: number,
  iso: string,
  latitude: number,
  longitude: number,
  routeEligible = true,
  rejectionReason: string | null = null,
): Point {
  return {
    sessionId,
    sequence,
    latitude,
    longitude,
    accuracy: 8,
    speed: 2,
    capturedAt: Date.parse(iso),
    routeEligible,
    rejectionReason,
  };
}

test('daily tracking never carries a long-running session into another calendar day', () => {
  const points = [
    point('same-session', 1, '2026-11-16T03:30:00.000Z', 23.02, 72.56),
    point('same-session', 2, '2026-11-16T03:32:00.000Z', 23.0205, 72.5605),
    point('same-session', 3, '2026-11-17T03:30:00.000Z', 23.04, 72.58),
    point('same-session', 4, '2026-11-17T03:32:00.000Z', 23.0405, 72.5805),
  ];
  const firstDay = summarizeTrackingDay(points, '2026-11-16', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  const secondDay = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(firstDay.shiftSeconds, 120);
  assert.equal(secondDay.shiftSeconds, 120);
  assert.equal(firstDay.sessionCount, 1);
  assert.equal(secondDay.sessionCount, 1);
});

test('multiple shifts on one day are summed without drawing distance between sessions', () => {
  const points = [
    point('morning', 1, '2026-11-17T03:30:00.000Z', 23.02, 72.56),
    point('morning', 2, '2026-11-17T03:32:00.000Z', 23.021, 72.561),
    point('evening', 1, '2026-11-17T11:30:00.000Z', 24.02, 73.56),
    point('evening', 2, '2026-11-17T11:32:00.000Z', 24.021, 73.561),
  ];
  const summary = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.shiftSeconds, 240);
  assert.ok(summary.distanceMetres > 0);
  assert.ok(summary.distanceMetres < 1000, 'session boundary must not create a fictitious inter-city route');
});

test('only a recently reporting current-day session extends its shift to now', () => {
  const now = Date.parse('2026-11-17T06:00:00.000Z');
  const recent = [
    point('live', 1, '2026-11-17T05:56:00.000Z', 23.02, 72.56),
    point('live', 2, '2026-11-17T05:59:00.000Z', 23.021, 72.561),
  ];
  const stale = [
    point('stale', 1, '2026-11-17T03:00:00.000Z', 23.02, 72.56),
    point('stale', 2, '2026-11-17T03:03:00.000Z', 23.021, 72.561),
  ];
  assert.equal(summarizeTrackingDay(recent, '2026-11-17', 0, now).shiftSeconds, 240);
  assert.equal(summarizeTrackingDay(stale, '2026-11-17', 0, now).shiftSeconds, 180);
});

test('offline GPS gaps are never reported as tracked or moving time', () => {
  const points = [
    point('shift', 1, '2026-11-17T03:30:00.000Z', 23.02, 72.56),
    point('shift', 2, '2026-11-17T03:31:00.000Z', 23.021, 72.561),
    point('shift', 3, '2026-11-17T11:30:00.000Z', 23.03, 72.57),
    point('shift', 4, '2026-11-17T11:31:00.000Z', 23.031, 72.571),
  ];
  const summary = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(summary.shiftSeconds, 120);
  assert.equal(summary.movingSeconds, 120);
  assert.ok(summary.distanceMetres < 1000, 'offline gap must not create fictitious distance');
});

test('stationary evidence produces a verified halt without adding GPS jitter distance', () => {
  const base = Date.parse('2026-11-17T03:30:00.000Z');
  const points = Array.from({ length: 9 }, (_, index) => point(
    'halt',
    index + 1,
    new Date(base + index * 30_000).toISOString(),
    23.02 + (index % 2) * 0.00001,
    72.56 + (index % 3) * 0.00001,
    index === 0,
    index === 0 ? null : 'stationary_noise',
  ));
  const summary = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(summary.shiftSeconds, 240);
  assert.equal(summary.haltSeconds, 240);
  assert.equal(summary.haltCount, 1);
  assert.equal(summary.movingSeconds, 0);
  assert.equal(summary.distanceMetres, 0);
});
