import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRouteMetrics, headingDifference, projectOnRoute, remainingRoute } from '../lib/field-tracking/navigation-geometry';

test('projects between shape points and trims the travelled route exactly', () => {
  const route = [
    { latitude: 23, longitude: 72 },
    { latitude: 23, longitude: 72.01 },
    { latitude: 23.01, longitude: 72.01 },
  ];
  const metrics = buildRouteMetrics(route);
  const projection = projectOnRoute({ latitude: 23.0001, longitude: 72.005 }, route, metrics);
  assert.ok(projection);
  assert.equal(projection.segmentIndex, 0);
  assert.ok(projection.fraction > 0.45 && projection.fraction < 0.55);
  const remaining = remainingRoute(route, projection);
  assert.equal(remaining.length, 3);
  assert.ok(Math.abs(remaining[0]!.longitude - 72.005) < 0.0001);
  assert.deepEqual(remaining.at(-1), route.at(-1));
});

test('continuity avoids snapping backwards at an overlapping route section', () => {
  const route = [
    { latitude: 23, longitude: 72 },
    { latitude: 23, longitude: 72.01 },
    { latitude: 23.00005, longitude: 72 },
    { latitude: 23.00005, longitude: 72.01 },
  ];
  const metrics = buildRouteMetrics(route);
  const projection = projectOnRoute(
    { latitude: 23.00005, longitude: 72.005 },
    route,
    metrics,
    metrics.cumulativeMetres[2],
  );
  assert.ok(projection);
  assert.equal(projection.segmentIndex, 2);
});

test('heading difference handles north wraparound and wrong-way headings', () => {
  assert.equal(headingDifference(355, 5), 10);
  assert.equal(headingDifference(5, 355), 10);
  assert.equal(headingDifference(10, 190), 180);
});
