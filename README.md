# Attendance & Geofencing

This copy of Lumina FieldForce contains attendance check-in/check-out, office geofencing, attendance history, company attendance views, employee access approval, and account sign-in/sign-out.

Admins configure their office location from the attendance screen. Employees need a verified location inside the assigned office's 500 m geofence to check in. Device identity verification remains enabled. Location previews refresh only while the attendance screen and app are active; no route history or battery tracking is collected. Failed server requests are shown as failures rather than successful local attendance.

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
