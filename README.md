# Attendance & Geofencing

This copy of Lumina FieldForce has three signed-in pages: Dashboard, Attendance & Geofencing, and Account & Access. Employee signup approval is part of Account & Access. Removed features are absent from the route tree, rather than hidden in the sidebar. Lenis, decorative entrance animations and the timed splash delay are removed.

Admins configure their office location from the attendance screen. Employees need a verified location inside the assigned office's 500 m geofence to check in. Device identity verification remains enabled. Location previews refresh only while the attendance screen and app are active. With native background permission enabled, OS geofences monitor the active office for automatic checkout. No route history or battery tracking is collected. Failed server requests are shown as failures rather than successful local attendance.

Sales, AI/transcription, visits, tasks, route tracking, payroll, expenses, leave, stock, incentives, banking, support, and notification screens and their feature APIs have been removed. Shared company/account infrastructure and the existing employee/attendance integration remain for compatibility.

## Run

This project uses Expo SDK 57. Use Node 22.13 or newer in the Node 22 line (`.nvmrc` selects Node 22). Install with `npm install`, then configure `.env` using `.env.example` and your attendance backend/database settings.

```text
npm run server:dev
npm run start:expo
```

Run those commands in separate terminals. A physical device needs an API address it can reach. Existing `.env` connection values are preserved; copying or editing this project does not create a new database or deploy the backend.

## Render deployment

Connect the existing service to this repository's `main` branch. Use `npm ci && npm run build` as the build command and `npm start` as the start command, with Node 22. Keep database credentials and `JWT_SECRET` in the Render environment settings; `.env` is intentionally excluded from Git. No database reset is needed for this update.

After deploying, `/api/health` reports `edition: "attendance-geofencing"` and the deployed Render commit. The phone app's `EXPO_PUBLIC_API_URL` must point to the service's HTTPS URL. Pushing backend changes does not replace an APK already installed on a phone.

## Verify

```text
npm run typecheck
npm run test:attendance
npm run server:build
```

Tests use an in-memory backend and cover geofence enforcement, GPS/identity evidence, duplicate check-ins, checkout, and removal of feature endpoints.

SDK and native permission changes require a new Android/iOS build. Verify GPS, biometric prompts, and the office map on a device before distributing a new APK.

## Attendance reliability and background operation

Attendance success is returned after the database write succeeds. Requests for one employee are serialized across server instances using a MySQL connection-scoped lock, and a repeated request ID returns its saved record. The UI reads confirmed server status and preserves the last confirmed view with an error when refresh fails. Admin updates use WebSocket events plus a 30-second fallback while visible. Roster reads are cached for two minutes; monthly attendance is fetched in one date-range query. Successful actions do not upload the full attendance history.

GPS evidence requires fresh, distinct samples, positive accuracy, no mock-location flag and stable positions. Check-in requires the accuracy circle to fit inside the office radius; an uncertain boundary is not treated as definitely inside. Checkout timestamps remain actual server timestamps across overnight shifts.

For locked-phone auto-checkout, install a new native development/release build, check in, then use **Account & Access ? Enable background auto-checkout** and grant Always / Allow all the time location. Expo Go is not supported. Only the active office is registered. An OS exit event triggers fresh GPS verification; the server checks the active session, device and distance beyond the office boundary. A pending exit can be retried on the next event or app resume. Network loss, disabled GPS, permission denial, Android force-stop and OS/vendor background restrictions can delay or prevent automatic checkout. It is not an exact-time guarantee, and no successful offline checkout is fabricated.

Before production distribution, verify on real Android/iOS devices: locked-screen exits, battery restrictions, permission denial/revocation, weak GPS near the boundary, interrupted network, midnight shifts and employee-to-admin updates. Automated tests do not emulate OS geofence delivery or production database concurrency.
