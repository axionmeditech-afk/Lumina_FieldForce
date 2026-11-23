import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveLiveTrackingStatus } from '../lib/field-tracking/live-health';

const now = Date.parse('2026-11-23T06:00:00.000Z');

test('a fresh engine heartbeat keeps a stationary employee live when the route point is old', () => {
  assert.equal(deriveLiveTrackingStatus({
    attendanceActive: true,
    trackingActive: true,
    heartbeatAt: '2026-11-23T05:59:30.000Z',
    capturedAt: '2026-11-23T05:40:00.000Z',
    now,
  }), 'live');
});

test('heartbeat age distinguishes delayed and stale tracking engines', () => {
  assert.equal(deriveLiveTrackingStatus({
    attendanceActive: true,
    trackingActive: true,
    heartbeatAt: '2026-11-23T05:57:30.000Z',
    capturedAt: '2026-11-23T05:57:00.000Z',
    now,
  }), 'delayed');
  assert.equal(deriveLiveTrackingStatus({
    attendanceActive: true,
    trackingActive: true,
    heartbeatAt: '2026-11-23T05:50:00.000Z',
    capturedAt: '2026-11-23T05:50:00.000Z',
    now,
  }), 'stale');
});

test('attendance and session ownership remain the source of truth', () => {
  assert.equal(deriveLiveTrackingStatus({
    attendanceActive: true,
    trackingActive: false,
    heartbeatAt: null,
    capturedAt: '2026-11-23T05:59:59.000Z',
    now,
  }), 'waiting');
  assert.equal(deriveLiveTrackingStatus({
    attendanceActive: false,
    trackingActive: true,
    heartbeatAt: '2026-11-23T05:59:59.000Z',
    capturedAt: '2026-11-23T05:59:59.000Z',
    now,
  }), 'offline');
});
