import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeTrackingDay } from '../server/routes/field-tracking.routes';

type Point = Parameters<typeof summarizeTrackingDay>[0][number];

function point(sessionId: string, sequence: number, iso: string, latitude: number, longitude: number): Point {
  return {
    sessionId,
    sequence,
    latitude,
    longitude,
    accuracy: 8,
    speed: 2,
    capturedAt: Date.parse(iso),
    routeEligible: true,
  };
}

test('daily tracking never carries a long-running session into another calendar day', () => {
  const points = [
    point('same-session', 1, '2026-11-16T03:30:00.000Z', 23.02, 72.56),
    point('same-session', 2, '2026-11-16T04:30:00.000Z', 23.03, 72.57),
    point('same-session', 3, '2026-11-17T03:30:00.000Z', 23.04, 72.58),
    point('same-session', 4, '2026-11-17T05:30:00.000Z', 23.05, 72.59),
  ];
  const firstDay = summarizeTrackingDay(points, '2026-11-16', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  const secondDay = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(firstDay.shiftSeconds, 3600);
  assert.equal(secondDay.shiftSeconds, 7200);
  assert.equal(firstDay.sessionCount, 1);
  assert.equal(secondDay.sessionCount, 1);
});

test('multiple shifts on one day are summed without drawing distance between sessions', () => {
  const points = [
    point('morning', 1, '2026-11-17T03:30:00.000Z', 23.02, 72.56),
    point('morning', 2, '2026-11-17T03:40:00.000Z', 23.021, 72.561),
    point('evening', 1, '2026-11-17T11:30:00.000Z', 24.02, 73.56),
    point('evening', 2, '2026-11-17T11:40:00.000Z', 24.021, 73.561),
  ];
  const summary = summarizeTrackingDay(points, '2026-11-17', 330, Date.parse('2026-11-18T00:00:00.000Z'));
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.shiftSeconds, 1200);
  assert.ok(summary.distanceMetres > 0);
  assert.ok(summary.distanceMetres < 1000, 'session boundary must not create a fictitious inter-city route');
});

test('only a recently reporting current-day session extends its shift to now', () => {
  const now = Date.parse('2026-11-17T06:00:00.000Z');
  const recent = [
    point('live', 1, '2026-11-17T05:00:00.000Z', 23.02, 72.56),
    point('live', 2, '2026-11-17T05:58:00.000Z', 23.021, 72.561),
  ];
  const stale = [
    point('stale', 1, '2026-11-17T03:00:00.000Z', 23.02, 72.56),
    point('stale', 2, '2026-11-17T04:00:00.000Z', 23.021, 72.561),
  ];
  assert.equal(summarizeTrackingDay(recent, '2026-11-17', 0, now).shiftSeconds, 3600);
  assert.equal(summarizeTrackingDay(stale, '2026-11-17', 0, now).shiftSeconds, 3600);
});
