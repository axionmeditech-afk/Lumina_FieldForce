import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { registerFieldTrackingRoutes } from '../server/routes/field-tracking.routes';
import type { AttendanceRecord } from '../lib/types';

test('employee routing is rejected without check-in and without an assigned visit', async () => {
  const app = express();
  app.use(express.json());
  let active: AttendanceRecord | null = null;
  const pool = {
    execute: async () => [[], []],
  } as any;

  registerFieldTrackingRoutes(app, {
    requireAuth: (req: any, _res: any, next: any) => {
      req.auth = { sub: 'employee-1', role: 'employee' };
      next();
    },
    getMySqlPool: async () => pool,
    isMySqlStateEnabled: () => true,
    resolveRequestCompanyId: async () => 'company-1',
    getRequestUser: () => ({ companyId: 'company-1', companyIds: ['company-1'] }),
    findActiveAttendance: async () => active,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const postRoute = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/api/field-tracking/route`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      origin: { latitude: 23.02, longitude: 72.57 },
      destination: { latitude: 23.03, longitude: 72.58, name: 'Assigned place' },
      travelMode: 'auto',
      ...body,
    }),
  });

  try {
    const checkedOut = await postRoute({ assignmentId: '6b681a22-c011-4fe5-8203-708c563c0a9c' });
    assert.equal(checkedOut.status, 403);
    assert.equal((await checkedOut.json() as any).code, 'CHECK_IN_REQUIRED');

    active = {
      id: 'attendance-1', userId: 'employee-1', userName: 'Employee', companyId: 'company-1',
      type: 'checkin', timestamp: new Date().toISOString(),
    };
    const noAssignment = await postRoute({});
    assert.equal(noAssignment.status, 400);
    assert.equal((await noAssignment.json() as any).code, 'ASSIGNMENT_REQUIRED');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('checkout lifecycle immediately notifies active visit navigation', async () => {
  const { notifyVisitNavigationCheckout, subscribeToVisitNavigationCheckout } = await import('../lib/field-tracking/visit-navigation-lifecycle');
  let notifications = 0;
  const unsubscribe = subscribeToVisitNavigationCheckout(() => { notifications += 1; });
  notifyVisitNavigationCheckout();
  await Promise.resolve();
  assert.equal(notifications, 1);
  unsubscribe();
  notifyVisitNavigationCheckout();
  await Promise.resolve();
  assert.equal(notifications, 1);
});
