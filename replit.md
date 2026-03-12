# Lumina FieldForce

## Overview
Enterprise employee tracking + AI sales intelligence platform. Built with Expo React Native (frontend) and Express (backend).

## Recent Changes
- **2026-02-19**: Initial build - Complete app with authentication, dashboard, attendance, team management, salary module, sales AI intelligence, task management, expense tracking, audit logs, and settings.

## Architecture
- **Frontend**: Expo React Native with file-based routing (expo-router)
- **Backend**: Express.js on port 5000
- **Data**: AsyncStorage with seeded demo data
- **Auth**: Role-based (admin, hr, manager, salesperson)
- **State**: React Context (AuthContext) + useState
- **Styling**: Inter font family, custom color system with light/dark mode

## Key Files
- `app/_layout.tsx` - Root layout with providers
- `app/login.tsx` - Authentication screen
- `app/(tabs)/` - Main tab navigation (Dashboard, Attendance, Team, Sales AI, More)
- `app/salary.tsx` - Salary breakdown
- `app/tasks.tsx` - Task management
- `app/expenses.tsx` - Expense tracking
- `app/audit.tsx` - Audit logs
- `app/settings.tsx` - App settings
- `app/employee/[id].tsx` - Employee detail
- `app/conversation/[id].tsx` - AI conversation analysis
- `contexts/AuthContext.tsx` - Auth state management
- `lib/storage.ts` - AsyncStorage helpers
- `lib/seedData.ts` - Demo data
- `lib/types.ts` - TypeScript interfaces
- `constants/colors.ts` - Theme colors

## Demo Accounts
- admin@trackforce.ai / admin123 (Admin)
- hr@trackforce.ai / hr123 (HR)
- manager@trackforce.ai / manager123 (Manager)
- sales@trackforce.ai / sales123 (Salesperson)
