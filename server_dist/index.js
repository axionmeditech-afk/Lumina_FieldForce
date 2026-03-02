var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// server/index.ts
import express2 from "express";

// server/routes.ts
import express from "express";
import { createServer } from "node:http";
import { createHash as createHash2, randomUUID as randomUUID4 } from "crypto";

// lib/demo-route.ts
function makeIso(date, time) {
  return (/* @__PURE__ */ new Date(`${date}T${time}:00`)).toISOString();
}
var AMIT_PATEL_IDS = /* @__PURE__ */ new Set(["e3", "u3"]);
function buildDefaultRoutePoints() {
  return [
    { time: "09:00", latitude: 23.0261, longitude: 72.5722, speed: 0, geofenceName: "Main Office", isInsideGeofence: true, batteryLevel: 88 },
    { time: "09:10", latitude: 23.029, longitude: 72.577, speed: 7.2, geofenceName: null, batteryLevel: 86 },
    { time: "09:20", latitude: 23.0325, longitude: 72.5834, speed: 8.1, geofenceName: null, batteryLevel: 84 },
    { time: "09:30", latitude: 23.0368, longitude: 72.588, speed: 6.8, geofenceName: "Client A - Shreyas Complex", batteryLevel: 82 },
    { time: "09:40", latitude: 23.0368, longitude: 72.588, speed: 0, geofenceName: "Client A - Shreyas Complex", batteryLevel: 80 },
    { time: "09:50", latitude: 23.0369, longitude: 72.5881, speed: 0.1, geofenceName: "Client A - Shreyas Complex", batteryLevel: 79 },
    { time: "10:00", latitude: 23.0369, longitude: 72.5881, speed: 0, geofenceName: "Client A - Shreyas Complex", batteryLevel: 78 },
    { time: "10:10", latitude: 23.0369, longitude: 72.5881, speed: 0, geofenceName: "Client A - Shreyas Complex", batteryLevel: 77 },
    { time: "10:20", latitude: 23.0396, longitude: 72.594, speed: 9.2, geofenceName: null, batteryLevel: 75 },
    { time: "10:30", latitude: 23.0428, longitude: 72.5998, speed: 8.4, geofenceName: null, batteryLevel: 73 },
    { time: "10:40", latitude: 23.0451, longitude: 72.6049, speed: 6.9, geofenceName: "Client B - SG Highway Hub", batteryLevel: 71 },
    { time: "10:50", latitude: 23.0451, longitude: 72.6049, speed: 0, geofenceName: "Client B - SG Highway Hub", batteryLevel: 70 },
    { time: "11:00", latitude: 23.0451, longitude: 72.605, speed: 0, geofenceName: "Client B - SG Highway Hub", batteryLevel: 68 },
    { time: "11:10", latitude: 23.0451, longitude: 72.605, speed: 0.1, geofenceName: "Client B - SG Highway Hub", batteryLevel: 67 },
    { time: "11:20", latitude: 23.0452, longitude: 72.605, speed: 0, geofenceName: "Client B - SG Highway Hub", batteryLevel: 66 },
    { time: "11:30", latitude: 23.0394, longitude: 72.5988, speed: 9.3, geofenceName: null, batteryLevel: 64 },
    { time: "11:40", latitude: 23.0331, longitude: 72.5904, speed: 10.2, geofenceName: null, batteryLevel: 62 },
    { time: "11:50", latitude: 23.0288, longitude: 72.5809, speed: 9.6, geofenceName: null, batteryLevel: 60 },
    { time: "12:00", latitude: 23.0261, longitude: 72.5722, speed: 4.2, geofenceName: "Main Office", isInsideGeofence: true, batteryLevel: 59 }
  ];
}
function buildAmitPatelAhmedabadRoutePoints() {
  return [
    { time: "09:00", latitude: 23.0715, longitude: 72.6706, speed: 0, geofenceName: "Naroda", isInsideGeofence: true, batteryLevel: 93 },
    { time: "09:08", latitude: 23.0648, longitude: 72.6542, speed: 8.5, geofenceName: null, batteryLevel: 91 },
    { time: "09:16", latitude: 23.0568, longitude: 72.636, speed: 9.2, geofenceName: null, batteryLevel: 89 },
    { time: "09:24", latitude: 23.0472, longitude: 72.6178, speed: 8.9, geofenceName: null, batteryLevel: 87 },
    { time: "09:32", latitude: 23.0369, longitude: 72.5974, speed: 7.4, geofenceName: null, batteryLevel: 85 },
    { time: "09:40", latitude: 23.0289, longitude: 72.5831, speed: 6.8, geofenceName: null, batteryLevel: 84 },
    { time: "09:48", latitude: 23.0253, longitude: 72.5716, speed: 2.1, geofenceName: "Mahakant Complex", batteryLevel: 83 },
    { time: "09:55", latitude: 23.0252, longitude: 72.5713, speed: 0, geofenceName: "Mahakant Complex", isInsideGeofence: true, batteryLevel: 82 },
    { time: "10:05", latitude: 23.0252, longitude: 72.5713, speed: 0, geofenceName: "Mahakant Complex", isInsideGeofence: true, batteryLevel: 80 },
    { time: "10:15", latitude: 23.0253, longitude: 72.5713, speed: 0.2, geofenceName: "Mahakant Complex", isInsideGeofence: true, batteryLevel: 79 },
    { time: "10:25", latitude: 23.0252, longitude: 72.5712, speed: 0, geofenceName: "Mahakant Complex", isInsideGeofence: true, batteryLevel: 78 },
    { time: "10:35", latitude: 23.0285, longitude: 72.5678, speed: 6.4, geofenceName: null, batteryLevel: 76 },
    { time: "10:42", latitude: 23.0319, longitude: 72.5632, speed: 7.1, geofenceName: null, batteryLevel: 75 },
    { time: "10:50", latitude: 23.0354, longitude: 72.5598, speed: 5.5, geofenceName: null, batteryLevel: 73 },
    { time: "10:58", latitude: 23.0387, longitude: 72.5574, speed: 2.4, geofenceName: "Navrangpura", batteryLevel: 72 },
    { time: "11:05", latitude: 23.0398, longitude: 72.5568, speed: 0, geofenceName: "Navrangpura", isInsideGeofence: true, batteryLevel: 71 },
    { time: "11:15", latitude: 23.0398, longitude: 72.5568, speed: 0, geofenceName: "Navrangpura", isInsideGeofence: true, batteryLevel: 69 },
    { time: "11:25", latitude: 23.0399, longitude: 72.5569, speed: 0.1, geofenceName: "Navrangpura", isInsideGeofence: true, batteryLevel: 68 },
    { time: "11:35", latitude: 23.0399, longitude: 72.5568, speed: 0, geofenceName: "Navrangpura", isInsideGeofence: true, batteryLevel: 67 }
  ];
}
function buildDemoRoutePoints(userId, date) {
  const points = AMIT_PATEL_IDS.has(userId) ? buildAmitPatelAhmedabadRoutePoints() : buildDefaultRoutePoints();
  return points.map((point, index) => ({
    id: `demo_loc_${userId}_${index}`,
    userId,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: 12,
    speed: point.speed,
    heading: null,
    geofenceId: point.geofenceName ? `demo_zone_${index}` : null,
    geofenceName: point.geofenceName,
    isInsideGeofence: Boolean(point.isInsideGeofence),
    batteryLevel: typeof point.batteryLevel === "number" ? point.batteryLevel : Math.max(22, 86 - Math.round(index * 2.1)),
    capturedAt: makeIso(date, point.time)
  }));
}

// lib/seedData.ts
var DEFAULT_COMPANY_ID = "cmp_trackforce_ai";
var DEFAULT_COMPANY_NAME = "TrackForce AI";
var demoUsers = [
  {
    id: "u1",
    name: "Rajesh Kumar",
    email: "admin@trackforce.ai",
    role: "admin",
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "Management",
    branch: "Mumbai HQ",
    phone: "+91 98765 43210",
    joinDate: "2022-01-15"
  },
  {
    id: "u2",
    name: "Priya Sharma",
    email: "hr@trackforce.ai",
    role: "hr",
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "Human Resources",
    branch: "Mumbai HQ",
    phone: "+91 98765 43211",
    joinDate: "2022-03-20"
  },
  {
    id: "u3",
    name: "Amit Patel",
    email: "manager@trackforce.ai",
    role: "manager",
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "Sales",
    branch: "Delhi Branch",
    phone: "+91 98765 43212",
    joinDate: "2022-06-10"
  },
  {
    id: "u4",
    name: "Sneha Reddy",
    email: "sales@trackforce.ai",
    role: "salesperson",
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "Sales",
    branch: "Bangalore Branch",
    phone: "+91 98765 43213",
    joinDate: "2023-01-05"
  },
  {
    id: "u5",
    name: "Dhruv Shah",
    email: "ahmedabad@trackforce.ai",
    role: "salesperson",
    companyId: DEFAULT_COMPANY_ID,
    companyName: DEFAULT_COMPANY_NAME,
    department: "Sales",
    branch: "Ahmedabad - Mahakant Complex",
    phone: "+91 98765 43220",
    joinDate: "2024-01-12"
  }
];
var demoPasswords = {
  "admin@trackforce.ai": "admin123",
  "hr@trackforce.ai": "hr123",
  "manager@trackforce.ai": "manager123",
  "sales@trackforce.ai": "sales123",
  "ahmedabad@trackforce.ai": "ahmed123"
};
var today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
var seedNow = (/* @__PURE__ */ new Date()).toISOString();
var MAHAKANT_LAT = 23.0252;
var MAHAKANT_LNG = 72.5713;
var MAHAKANT_BRANCH = "Ahmedabad - Mahakant Complex";
var demoAttendance = [
  { id: "a1", userId: "e1", userName: "Rajesh Kumar", type: "checkin", timestamp: `${today}T09:02:00`, location: { lat: 19.076, lng: 72.8777 } },
  { id: "a2", userId: "e2", userName: "Priya Sharma", type: "checkin", timestamp: `${today}T08:55:00`, location: { lat: 19.076, lng: 72.8777 } },
  { id: "a3", userId: "e3", userName: "Amit Patel", type: "checkin", timestamp: `${today}T09:15:00`, location: { lat: 28.6139, lng: 77.209 } },
  { id: "a4", userId: "e4", userName: "Sneha Reddy", type: "checkin", timestamp: `${today}T08:45:00`, location: { lat: 12.9716, lng: 77.5946 } },
  { id: "a5", userId: "e5", userName: "Vikram Singh", type: "checkin", timestamp: `${today}T09:30:00`, location: { lat: 28.6139, lng: 77.209 } },
  { id: "a6", userId: "e7", userName: "Karthik Nair", type: "checkin", timestamp: `${today}T08:50:00`, location: { lat: 12.9716, lng: 77.5946 } },
  { id: "a7", userId: "e8", userName: "Meera Joshi", type: "checkin", timestamp: `${today}T09:05:00`, location: { lat: 28.6139, lng: 77.209 } },
  { id: "a8", userId: "e10", userName: "Deepa Iyer", type: "checkin", timestamp: `${today}T08:58:00`, location: { lat: 12.9716, lng: 77.5946 } },
  { id: "a9", userId: "e11", userName: "Dhruv Shah", type: "checkin", timestamp: `${today}T09:12:00`, location: { lat: MAHAKANT_LAT, lng: MAHAKANT_LNG } }
];
var demoAuditLogs = [
  { id: "al1", userId: "e1", userName: "Rajesh Kumar", action: "User Login", details: "Admin logged in from Mumbai HQ", timestamp: `${today}T09:02:00`, module: "Auth" },
  { id: "al2", userId: "e4", userName: "Sneha Reddy", action: "Check In", details: "Checked in at Bangalore Branch", timestamp: `${today}T08:45:00`, module: "Attendance" },
  { id: "al3", userId: "e1", userName: "Rajesh Kumar", action: "Expense Approved", details: "Approved travel expense for Sneha Reddy - INR 4,500", timestamp: `${today}T10:15:00`, module: "Expenses" },
  { id: "al4", userId: "e3", userName: "Amit Patel", action: "Task Created", details: "Assigned 'Client meeting - Infosys' to Sneha Reddy", timestamp: `${today}T10:30:00`, module: "Tasks" },
  { id: "al5", userId: "e2", userName: "Priya Sharma", action: "Salary Generated", details: "Generated January salary slips for all employees", timestamp: `${today}T11:00:00`, module: "Salary" },
  { id: "al6", userId: "e7", userName: "Karthik Nair", action: "Recording Uploaded", details: "Uploaded conversation recording with TCS", timestamp: `${today}T14:30:00`, module: "Sales AI" },
  { id: "al7", userId: "e1", userName: "Rajesh Kumar", action: "Settings Updated", details: "Updated company branding colors", timestamp: `${today}T15:00:00`, module: "Settings" },
  { id: "al8", userId: "e3", userName: "Amit Patel", action: "Report Exported", details: "Exported weekly attendance report as PDF", timestamp: `${today}T16:00:00`, module: "Reports" },
  { id: "al9", userId: "e11", userName: "Dhruv Shah", action: "Check In", details: "Checked in at Mahakant Complex, Paldi, Ahmedabad", timestamp: `${today}T09:12:00`, module: "Attendance" }
];
var demoGeofences = [
  {
    id: "g1",
    name: "Mumbai HQ Office",
    radiusMeters: 300,
    latitude: 19.076,
    longitude: 72.8777,
    assignedEmployeeIds: ["u1", "u2", "e1", "e2", "e9"],
    isActive: true,
    allowOverride: false,
    workingHoursStart: "08:30",
    workingHoursEnd: "19:30",
    createdAt: seedNow,
    updatedAt: seedNow
  },
  {
    id: "g2",
    name: "Delhi Branch Office",
    radiusMeters: 280,
    latitude: 28.6139,
    longitude: 77.209,
    assignedEmployeeIds: ["u3", "e3", "e5", "e8"],
    isActive: true,
    allowOverride: false,
    workingHoursStart: "08:00",
    workingHoursEnd: "19:00",
    createdAt: seedNow,
    updatedAt: seedNow
  },
  {
    id: "g3",
    name: "Bangalore Branch Office",
    radiusMeters: 320,
    latitude: 12.9716,
    longitude: 77.5946,
    assignedEmployeeIds: ["u4", "e4", "e7", "e10"],
    isActive: true,
    allowOverride: true,
    workingHoursStart: "08:00",
    workingHoursEnd: "20:00",
    createdAt: seedNow,
    updatedAt: seedNow
  },
  {
    id: "g4",
    name: MAHAKANT_BRANCH,
    radiusMeters: 800,
    latitude: MAHAKANT_LAT,
    longitude: MAHAKANT_LNG,
    assignedEmployeeIds: ["u5", "e11"],
    isActive: true,
    allowOverride: false,
    workingHoursStart: "08:30",
    workingHoursEnd: "19:30",
    createdAt: seedNow,
    updatedAt: seedNow
  }
];
var demoNotifications = [
  {
    id: "n1",
    title: "Quarterly Sales Kickoff",
    body: "All sales teams join the kickoff at 10:00 AM in the main conference room.",
    kind: "announcement",
    audience: "salesperson",
    createdById: "e1",
    createdByName: "Rajesh Kumar",
    createdAt: `${today}T08:00:00`,
    readByIds: ["e4"]
  },
  {
    id: "n2",
    title: "Attendance Policy Reminder",
    body: "All employees must complete geo-verified check-in before 10:30 AM.",
    kind: "policy",
    audience: "all",
    createdById: "e2",
    createdByName: "Priya Sharma",
    createdAt: `${today}T08:30:00`,
    readByIds: ["e1", "e2", "e3"]
  },
  {
    id: "n3",
    title: "Server Maintenance Window",
    body: "Backend maintenance is scheduled tonight from 11:30 PM to 12:30 AM.",
    kind: "alert",
    audience: "all",
    createdById: "e1",
    createdByName: "Rajesh Kumar",
    createdAt: `${today}T12:15:00`,
    readByIds: []
  }
];
var demoSupportThreads = [
  {
    id: "s1",
    subject: "Unable to upload expense receipt",
    requestedById: "e4",
    requestedByName: "Sneha Reddy",
    requestedByRole: "salesperson",
    status: "open",
    priority: "normal",
    createdAt: `${today}T10:05:00`,
    updatedAt: `${today}T10:40:00`,
    messages: [
      {
        id: "sm1",
        senderId: "e4",
        senderName: "Sneha Reddy",
        senderRole: "salesperson",
        message: "Expense form saves but receipt upload keeps failing on mobile data.",
        createdAt: `${today}T10:05:00`
      },
      {
        id: "sm2",
        senderId: "e3",
        senderName: "Amit Patel",
        senderRole: "manager",
        message: "Please retry on Wi-Fi once. If it still fails, share screenshot here.",
        createdAt: `${today}T10:40:00`
      }
    ]
  }
];

// lib/geofence.ts
var EARTH_RADIUS_METERS = 6371e3;
var MIN_GEOFENCE_CAPTURE_RADIUS_METERS = 500;
function toRadians(degrees) {
  return degrees * Math.PI / 180;
}
function haversineDistanceMeters(fromLat, fromLng, toLat, toLng) {
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}
function getEffectiveGeofenceRadiusMeters(zone) {
  const configuredRadius = Number.isFinite(zone.radiusMeters) ? zone.radiusMeters : 0;
  return Math.max(configuredRadius, MIN_GEOFENCE_CAPTURE_RADIUS_METERS);
}

// lib/route-analytics.ts
var DEFAULT_HALT_RADIUS_METERS = 45;
var DEFAULT_HALT_MIN_DURATION_MINUTES = 10;
var DEFAULT_STATIONARY_SPEED_MPS = 1.1;
function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
function toMs(value) {
  return new Date(value).getTime();
}
function normalizeBatteryLevel(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const scaled = value <= 1 ? value * 100 : value;
  return Math.round(Math.max(0, Math.min(100, scaled)));
}
function getAverageBatteryLevel(points) {
  const values = points.map((point) => normalizeBatteryLevel(point.batteryLevel)).filter((value) => typeof value === "number");
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
function computeEffectiveSpeedMps(distanceMeters, durationMs) {
  if (durationMs <= 0) return 0;
  return distanceMeters / (durationMs / 1e3);
}
function mostCommonLabel(points) {
  const bucket = /* @__PURE__ */ new Map();
  for (const point of points) {
    const key = point.geofenceName?.trim() || "Unknown location";
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  let winner = "Unknown location";
  let max = 0;
  for (const [key, count] of bucket) {
    if (count > max) {
      max = count;
      winner = key;
    }
  }
  return winner;
}
function averageLatLng(points) {
  if (!points.length) {
    return { latitude: 0, longitude: 0 };
  }
  let lat = 0;
  let lng = 0;
  for (const point of points) {
    lat += point.latitude;
    lng += point.longitude;
  }
  return {
    latitude: lat / points.length,
    longitude: lng / points.length
  };
}
function detectHalts(points, options) {
  if (points.length < 2) return [];
  const haltRadiusMeters = options?.haltRadiusMeters ?? DEFAULT_HALT_RADIUS_METERS;
  const haltMinDurationMinutes = options?.haltMinDurationMinutes ?? DEFAULT_HALT_MIN_DURATION_MINUTES;
  const stationarySpeedMps = options?.stationarySpeedMps ?? DEFAULT_STATIONARY_SPEED_MPS;
  const minHaltMs = haltMinDurationMinutes * 60 * 1e3;
  const stepDistanceThreshold = Math.max(20, haltRadiusMeters * 0.75);
  const halts = [];
  let runStartIndex = null;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    const durationMs = Math.max(0, toMs(curr.capturedAt) - toMs(prev.capturedAt));
    const distanceMeters = haversineDistanceMeters(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
    const apiSpeed = typeof curr.speed === "number" && Number.isFinite(curr.speed) ? Math.max(0, curr.speed) : null;
    const effectiveSpeed = apiSpeed ?? computeEffectiveSpeedMps(distanceMeters, durationMs);
    const stationary = distanceMeters <= stepDistanceThreshold && effectiveSpeed <= stationarySpeedMps;
    if (stationary) {
      if (runStartIndex === null) {
        runStartIndex = i - 1;
      }
      continue;
    }
    if (runStartIndex !== null) {
      const runEndIndex = i - 1;
      const startAt = toMs(points[runStartIndex].capturedAt);
      const endAt = toMs(points[runEndIndex].capturedAt);
      const durationMsTotal = Math.max(0, endAt - startAt);
      if (durationMsTotal >= minHaltMs) {
        const runPoints = points.slice(runStartIndex, runEndIndex + 1);
        const center = averageLatLng(runPoints);
        const label = mostCommonLabel(runPoints);
        const startBatteryLevel = normalizeBatteryLevel(points[runStartIndex].batteryLevel);
        const endBatteryLevel = normalizeBatteryLevel(points[runEndIndex].batteryLevel);
        const averageBatteryLevel = getAverageBatteryLevel(runPoints);
        halts.push({
          id: `halt_${points[runStartIndex].userId}_${startAt}`,
          userId: points[runStartIndex].userId,
          startAt: points[runStartIndex].capturedAt,
          endAt: points[runEndIndex].capturedAt,
          durationMinutes: Math.max(1, Math.round(durationMsTotal / 6e4)),
          latitude: center.latitude,
          longitude: center.longitude,
          pointCount: runPoints.length,
          label,
          startBatteryLevel,
          endBatteryLevel,
          averageBatteryLevel,
          startPointIndex: runStartIndex,
          endPointIndex: runEndIndex
        });
      }
      runStartIndex = null;
    }
  }
  if (runStartIndex !== null) {
    const runEndIndex = points.length - 1;
    const startAt = toMs(points[runStartIndex].capturedAt);
    const endAt = toMs(points[runEndIndex].capturedAt);
    const durationMsTotal = Math.max(0, endAt - startAt);
    if (durationMsTotal >= minHaltMs) {
      const runPoints = points.slice(runStartIndex, runEndIndex + 1);
      const center = averageLatLng(runPoints);
      const label = mostCommonLabel(runPoints);
      const startBatteryLevel = normalizeBatteryLevel(points[runStartIndex].batteryLevel);
      const endBatteryLevel = normalizeBatteryLevel(points[runEndIndex].batteryLevel);
      const averageBatteryLevel = getAverageBatteryLevel(runPoints);
      halts.push({
        id: `halt_${points[runStartIndex].userId}_${startAt}`,
        userId: points[runStartIndex].userId,
        startAt: points[runStartIndex].capturedAt,
        endAt: points[runEndIndex].capturedAt,
        durationMinutes: Math.max(1, Math.round(durationMsTotal / 6e4)),
        latitude: center.latitude,
        longitude: center.longitude,
        pointCount: runPoints.length,
        label,
        startBatteryLevel,
        endBatteryLevel,
        averageBatteryLevel,
        startPointIndex: runStartIndex,
        endPointIndex: runEndIndex
      });
    }
  }
  return halts;
}
function makeMovingSegment(points, startIndex, endIndex) {
  if (startIndex >= endIndex) return null;
  let distanceMeters = 0;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    distanceMeters += haversineDistanceMeters(
      prev.latitude,
      prev.longitude,
      curr.latitude,
      curr.longitude
    );
  }
  const startAt = points[startIndex].capturedAt;
  const endAt = points[endIndex].capturedAt;
  const durationMs = Math.max(0, toMs(endAt) - toMs(startAt));
  const avgSpeedKph = durationMs > 0 ? round(distanceMeters / 1e3 / (durationMs / (60 * 60 * 1e3)), 2) : null;
  return {
    id: `mv_${points[startIndex].userId}_${toMs(startAt)}`,
    type: "moving",
    startAt,
    endAt,
    durationMinutes: Math.max(1, Math.round(durationMs / 6e4)),
    distanceMeters: Math.round(distanceMeters),
    avgSpeedKph,
    fromLabel: points[startIndex].geofenceName ?? "Route Start",
    toLabel: points[endIndex].geofenceName ?? "Route End"
  };
}
function makeHaltSegment(halt) {
  return {
    id: `seg_${halt.id}`,
    type: "halt",
    startAt: halt.startAt,
    endAt: halt.endAt,
    durationMinutes: halt.durationMinutes,
    distanceMeters: 0,
    avgSpeedKph: 0,
    fromLabel: halt.label,
    toLabel: halt.label,
    haltId: halt.id
  };
}
function dropIndexMetadata(halts) {
  return halts.map(({ startPointIndex: _start, endPointIndex: _end, ...rest }) => rest);
}
function buildRouteTimeline(userId, date, rawPoints, options) {
  const points = [...rawPoints].sort((a, b) => toMs(a.capturedAt) - toMs(b.capturedAt));
  if (!points.length) {
    return {
      userId,
      date,
      points: [],
      halts: [],
      segments: [],
      summary: {
        totalDistanceKm: 0,
        totalMovingMinutes: 0,
        totalHaltMinutes: 0,
        haltCount: 0,
        pointCount: 0
      }
    };
  }
  const haltsWithIndex = detectHalts(points, options);
  const segments = [];
  let cursor = 0;
  for (const halt of haltsWithIndex) {
    if (halt.startPointIndex > cursor) {
      const moving = makeMovingSegment(points, cursor, halt.startPointIndex);
      if (moving) segments.push(moving);
    }
    segments.push(makeHaltSegment(halt));
    cursor = halt.endPointIndex;
  }
  if (cursor < points.length - 1) {
    const moving = makeMovingSegment(points, cursor, points.length - 1);
    if (moving) segments.push(moving);
  }
  const totalDistanceMeters = segments.filter((segment) => segment.type === "moving").reduce((sum, segment) => sum + segment.distanceMeters, 0);
  const totalMovingMinutes = segments.filter((segment) => segment.type === "moving").reduce((sum, segment) => sum + segment.durationMinutes, 0);
  const totalHaltMinutes = segments.filter((segment) => segment.type === "halt").reduce((sum, segment) => sum + segment.durationMinutes, 0);
  return {
    userId,
    date,
    points,
    halts: dropIndexMetadata(haltsWithIndex),
    segments,
    summary: {
      totalDistanceKm: round(totalDistanceMeters / 1e3, 2),
      totalMovingMinutes,
      totalHaltMinutes,
      haltCount: haltsWithIndex.length,
      pointCount: points.length
    }
  };
}

// server/auth.ts
import { createHmac, timingSafeEqual } from "crypto";
function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function base64UrlDecode(input) {
  let payload = input.replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4 !== 0) payload += "=";
  return Buffer.from(payload, "base64");
}
function getJwtSecret() {
  return process.env.JWT_SECRET || "trackforce_dev_secret_change_me";
}
function signJwt(payload, expiresInSec = 60 * 60 * 12) {
  const now = Math.floor(Date.now() / 1e3);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", getJwtSecret()).update(data).digest();
  return `${data}.${base64UrlEncode(signature)}`;
}
function verifyJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac("sha256", getJwtSecret()).update(data).digest();
  const actual = base64UrlDecode(encodedSignature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8"));
    if (payload.exp < Math.floor(Date.now() / 1e3)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
function requireAuth(req, res, next) {
  const authHeader = req.header("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearer) {
    res.status(401).json({ message: "Missing Authorization bearer token" });
    return;
  }
  const payload = verifyJwt(bearer);
  if (!payload) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }
  req.auth = payload;
  next();
}
function requireRoles(...roles) {
  return (req, res, next) => {
    const role = req.auth?.role;
    if (!role || !roles.includes(role)) {
      res.status(403).json({ message: "Insufficient permissions" });
      return;
    }
    next();
  };
}

// server/storage.ts
import { randomUUID } from "crypto";
var MemStorage = class {
  geofences = /* @__PURE__ */ new Map();
  attendance = /* @__PURE__ */ new Map();
  attendancePhotos = [];
  anomalies = [];
  locationLogs = [];
  deviceBindings = /* @__PURE__ */ new Map();
  dolibarrSyncLogs = [];
  dolibarrConfigByUser = /* @__PURE__ */ new Map();
  constructor() {
    for (const zone of demoGeofences) {
      this.geofences.set(zone.id, zone);
    }
  }
  async listGeofences() {
    return Array.from(this.geofences.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async listGeofencesForUser(userId) {
    const all = await this.listGeofences();
    return all.filter((zone) => zone.isActive && zone.assignedEmployeeIds.includes(userId));
  }
  async createGeofence(payload) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const geofence = {
      id: payload.id ?? randomUUID(),
      name: payload.name ?? "Unnamed Zone",
      radiusMeters: payload.radiusMeters ?? 200,
      latitude: payload.latitude ?? 0,
      longitude: payload.longitude ?? 0,
      assignedEmployeeIds: payload.assignedEmployeeIds ?? [],
      isActive: payload.isActive ?? true,
      allowOverride: payload.allowOverride ?? false,
      workingHoursStart: payload.workingHoursStart ?? null,
      workingHoursEnd: payload.workingHoursEnd ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.geofences.set(geofence.id, geofence);
    return geofence;
  }
  async updateGeofence(id, payload) {
    const current = this.geofences.get(id);
    if (!current) return null;
    const updated = {
      ...current,
      ...payload,
      id,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.geofences.set(id, updated);
    return updated;
  }
  async createAttendance(entry) {
    this.attendance.set(entry.id, entry);
    return entry;
  }
  async updateAttendance(id, patch) {
    const current = this.attendance.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.attendance.set(id, updated);
    return updated;
  }
  async findActiveAttendance(userId) {
    const sorted = Array.from(this.attendance.values()).filter((item) => item.userId === userId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latestCheckIn = sorted.find((item) => item.type === "checkin");
    if (!latestCheckIn) return null;
    const hasCheckoutAfter = sorted.some(
      (item) => item.type === "checkout" && item.timestamp >= latestCheckIn.timestamp
    );
    return hasCheckoutAfter ? null : latestCheckIn;
  }
  async getAttendanceById(id) {
    return this.attendance.get(id) ?? null;
  }
  async getAttendanceToday(userId) {
    const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    return Array.from(this.attendance.values()).filter((record) => record.userId === userId && record.timestamp.startsWith(day)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  async getAttendanceHistory(userId) {
    return Array.from(this.attendance.values()).filter((record) => record.userId === userId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  async addAttendancePhoto(photo) {
    this.attendancePhotos.unshift(photo);
    this.attendancePhotos = this.attendancePhotos.slice(0, 5e3);
  }
  async addAnomaly(anomaly) {
    this.anomalies.unshift(anomaly);
    this.anomalies = this.anomalies.slice(0, 5e3);
  }
  async addLocationLog(log2) {
    this.locationLogs.unshift(log2);
    this.locationLogs = this.locationLogs.slice(0, 1e4);
  }
  async getLocationLogsForUserDate(userId, date) {
    return this.locationLogs.filter((log2) => log2.userId === userId && log2.capturedAt.startsWith(date)).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  async getLocationLogsLatest() {
    const latestByUser = /* @__PURE__ */ new Map();
    for (const log2 of this.locationLogs) {
      if (!latestByUser.has(log2.userId)) {
        latestByUser.set(log2.userId, log2);
      }
    }
    return Array.from(latestByUser.values());
  }
  async bindDevice(userId, deviceId) {
    const existing = this.deviceBindings.get(userId);
    if (!existing) {
      this.deviceBindings.set(userId, deviceId);
      return { ok: true, mismatch: false };
    }
    if (existing !== deviceId) {
      return { ok: false, mismatch: true };
    }
    return { ok: true, mismatch: false };
  }
  async addDolibarrSyncLog(log2) {
    this.dolibarrSyncLogs.unshift(log2);
    this.dolibarrSyncLogs = this.dolibarrSyncLogs.slice(0, 5e3);
  }
  async getDolibarrConfigForUser(userId) {
    return this.dolibarrConfigByUser.get(userId) ?? null;
  }
  async getLatestDolibarrConfig() {
    let latest = null;
    for (const config of this.dolibarrConfigByUser.values()) {
      if (!latest || config.updatedAt > latest.updatedAt) {
        latest = config;
      }
    }
    return latest;
  }
  async setDolibarrConfigForUser(userId, payload) {
    const current = this.dolibarrConfigByUser.get(userId);
    const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const next = {
      userId,
      enabled: Boolean(payload.enabled),
      endpoint: endpoint || current?.endpoint || null,
      apiKey: apiKey || current?.apiKey || null,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (typeof payload.endpoint === "string" && !payload.endpoint.trim()) {
      next.endpoint = null;
    }
    if (typeof payload.apiKey === "string" && !payload.apiKey.trim()) {
      next.apiKey = null;
    }
    this.dolibarrConfigByUser.set(userId, next);
    return next;
  }
};
var storage = new MemStorage();

// server/services/attendance-guard.ts
import { randomUUID as randomUUID2 } from "crypto";
function nowISO() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function getConfidenceBufferMeters(accuracyMeters) {
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) {
    return 15;
  }
  return Math.max(10, Math.min(35, Math.round(accuracyMeters * 0.5)));
}
function resolveGeofenceStatus(payload, zones) {
  let bestDistance = Number.POSITIVE_INFINITY;
  let activeZone = null;
  let inside = false;
  let insideConfirmed = false;
  const confidenceBufferMeters = getConfidenceBufferMeters(payload.locationAccuracyMeters);
  let distanceFromBoundaryMeters = Number.NEGATIVE_INFINITY;
  for (const zone of zones) {
    if (!zone.isActive) continue;
    const effectiveRadiusMeters = getEffectiveGeofenceRadiusMeters(zone);
    const distance = haversineDistanceMeters(
      payload.latitude,
      payload.longitude,
      zone.latitude,
      zone.longitude
    );
    const boundaryDistance = effectiveRadiusMeters - distance;
    const confirmed = distance <= effectiveRadiusMeters && (distance + confidenceBufferMeters <= effectiveRadiusMeters || confidenceBufferMeters <= 10);
    if (distance < bestDistance) {
      bestDistance = distance;
      activeZone = zone;
      distanceFromBoundaryMeters = boundaryDistance;
    }
    if (distance <= effectiveRadiusMeters) {
      if (!inside || confirmed && !insideConfirmed || distance < bestDistance) {
        bestDistance = distance;
        activeZone = zone;
        inside = true;
        insideConfirmed = confirmed;
        distanceFromBoundaryMeters = boundaryDistance;
      }
    }
  }
  return {
    inside,
    insideConfirmed,
    activeZone,
    distanceMeters: bestDistance,
    confidenceBufferMeters,
    distanceFromBoundaryMeters
  };
}
async function recordAnomaly(anomaly) {
  await storage.addAnomaly({
    ...anomaly,
    id: randomUUID2(),
    createdAt: nowISO()
  });
}

// server/services/photo-upload.ts
import { createCipheriv, createHash, randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
function getEncryptionKey() {
  const raw = process.env.PHOTO_ENCRYPTION_KEY || "trackforce-photo-default-key";
  return createHash("sha256").update(raw).digest();
}
async function saveEncryptedLocal(fileName, fileBuffer) {
  const uploadsDir = path.resolve(process.cwd(), "server_uploads", "attendance");
  await fs.mkdir(uploadsDir, { recursive: true });
  const iv = randomBytes(12);
  const key = getEncryptionKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]);
  const fullPath = path.join(uploadsDir, `${fileName}.enc`);
  await fs.writeFile(fullPath, payload);
  return fullPath;
}
async function uploadToS3IfConfigured(key, payload, contentType = "application/octet-stream") {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;
  try {
    const { S3Client, PutObjectCommand } = __require("@aws-sdk/client-s3");
    const client = new S3Client({ region });
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: contentType,
        ServerSideEncryption: "AES256"
      })
    );
    return `s3://${bucket}/${key}`;
  } catch {
    return null;
  }
}
async function storeAttendancePhoto(base64, mimeType, userId, photoType) {
  const fileBuffer = Buffer.from(base64, "base64");
  const fileName = `${userId}_${photoType}_${Date.now()}`;
  const s3Key = `attendance/${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}/${fileName}.enc`;
  const localEncryptedPayload = await saveEncryptedLocal(fileName, fileBuffer);
  const localBuffer = await fs.readFile(localEncryptedPayload);
  const s3Location = await uploadToS3IfConfigured(s3Key, localBuffer, mimeType);
  return s3Location ?? localEncryptedPayload;
}

// server/services/dolibarr-sync.ts
import { randomUUID as randomUUID3 } from "crypto";
async function delay(ms) {
  await new Promise((resolve3) => setTimeout(resolve3, ms));
}
function normalizeText(value) {
  return (value || "").trim();
}
function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}
function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function splitDisplayName(name) {
  const cleaned = normalizeText(name).replace(/\s+/g, " ");
  if (!cleaned) {
    return { firstName: "Employee", lastName: "User" };
  }
  const parts = cleaned.split(" ");
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "User" };
  }
  const firstName = parts.shift() || "Employee";
  const lastName = parts.join(" ") || "User";
  return { firstName, lastName };
}
function buildEmployeeLogin(email, name) {
  const fromEmail = email.split("@")[0] || "";
  const fromName = name.toLowerCase().replace(/\s+/g, ".");
  const cleaned = (fromEmail || fromName || "employee").replace(/[^a-z0-9._-]/gi, "").replace(/^[._-]+|[._-]+$/g, "").slice(0, 42).toLowerCase();
  return cleaned || `employee_${Date.now().toString(36).slice(-6)}`;
}
function buildRetryLogin(baseLogin) {
  const suffix = Date.now().toString(36).slice(-4);
  return `${baseLogin.slice(0, 36)}_${suffix}`;
}
function buildJobTitle(input) {
  const parts = [normalizeText(input.role), normalizeText(input.department), normalizeText(input.branch)].filter(Boolean).slice(0, 3);
  if (!parts.length) return void 0;
  return parts.join(" | ").slice(0, 80);
}
function buildDolibarrApiBases(rawEndpoint) {
  const cleaned = normalizeText(rawEndpoint).replace(/\/+$/, "");
  if (!cleaned) return [];
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return [];
  }
  const candidates = /* @__PURE__ */ new Set();
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const addCandidate = (nextPath) => {
    const next = new URL(parsed.toString());
    next.pathname = nextPath || "/";
    next.search = "";
    next.hash = "";
    candidates.add(next.toString().replace(/\/+$/, ""));
  };
  if (/\/api\/index\.php(\/.*)?$/i.test(pathname)) {
    addCandidate(pathname.replace(/(\/api\/index\.php).*/i, "$1"));
  } else if (/\/api$/i.test(pathname)) {
    addCandidate(`${pathname}/index.php`);
    addCandidate(pathname);
  } else if (/\/users$/i.test(pathname)) {
    addCandidate(pathname.replace(/\/users$/i, ""));
  } else {
    if (pathname) {
      addCandidate(`${pathname}/api/index.php`);
      addCandidate(`${pathname}/api`);
    }
    addCandidate("/api/index.php");
    addCandidate("/api");
    if (pathname) {
      addCandidate(pathname);
    }
  }
  return Array.from(candidates);
}
function buildDolibarrHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    DOLAPIKEY: apiKey,
    "X-Dolibarr-API-Key": apiKey
  };
}
async function parseBody(response) {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}
function parseDolibarrUserId(payload) {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return Math.trunc(payload);
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const body = payload;
  const candidates = [body.id, body.rowid, body.user_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate.trim())) {
      return Number(candidate.trim());
    }
  }
  return null;
}
async function lookupDolibarrUserByEmail(apiBase, email, apiKey) {
  const response = await fetch(`${apiBase}/users/email/${encodeURIComponent(email)}`, {
    method: "GET",
    headers: buildDolibarrHeaders(apiKey)
  });
  if (response.status === 404) {
    return { found: false, userId: null };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      found: false,
      userId: null,
      message: `Dolibarr authentication failed with HTTP ${response.status}.`
    };
  }
  if (!response.ok) {
    return { found: false, userId: null };
  }
  const { json } = await parseBody(response);
  const userId = parseDolibarrUserId(json);
  const foundEmail = json && typeof json === "object" && typeof json.email === "string" ? String(json.email).trim().toLowerCase() : "";
  if (!userId && foundEmail && foundEmail !== email) {
    return { found: false, userId: null };
  }
  return { found: true, userId };
}
async function createDolibarrEmployee(apiBase, apiKey, payload) {
  const response = await fetch(`${apiBase}/users`, {
    method: "POST",
    headers: buildDolibarrHeaders(apiKey),
    body: JSON.stringify(payload)
  });
  const { text, json } = await parseBody(response);
  const jsonObject = json && typeof json === "object" ? json : null;
  const errorObject = jsonObject && jsonObject.error && typeof jsonObject.error === "object" ? jsonObject.error : null;
  const messageFromJson = typeof errorObject?.message === "string" ? String(errorObject.message) : typeof jsonObject?.message === "string" ? String(jsonObject.message) : "";
  const message = messageFromJson || text || `Dolibarr responded with HTTP ${response.status}.`;
  if (!response.ok) {
    const conflict = response.status === 409 || /already exists|already used|duplicate|login exists/i.test(message);
    return { ok: false, userId: null, conflict, message };
  }
  return {
    ok: true,
    userId: parseDolibarrUserId(json ?? text),
    conflict: false,
    message: "Employee created in Dolibarr."
  };
}
function buildDolibarrEmployeePayload(input, login) {
  const normalizedEmail = normalizeEmail(input.email);
  const nameParts = splitDisplayName(input.name);
  const payload = {
    login,
    email: normalizedEmail,
    firstname: nameParts.firstName,
    lastname: nameParts.lastName,
    employee: 1
  };
  const cleanedPhone = normalizeText(input.phone);
  if (cleanedPhone) {
    payload.office_phone = cleanedPhone;
    payload.user_mobile = cleanedPhone;
  }
  const job = buildJobTitle(input);
  if (job) {
    payload.job = job;
  }
  return payload;
}
async function syncApprovedUserToDolibarrEmployee(user, config) {
  const enabled = config?.enabled ?? true;
  if (!enabled) {
    return {
      ok: false,
      status: "skipped",
      message: "Dolibarr sync disabled in settings.",
      dolibarrUserId: null,
      endpointUsed: null
    };
  }
  const endpoint = normalizeText(config?.endpoint || process.env.DOLIBARR_ENDPOINT || "");
  const apiKey = normalizeText(config?.apiKey || process.env.DOLIBARR_API_KEY || "");
  if (!endpoint || !apiKey) {
    return {
      ok: false,
      status: "skipped",
      message: "Dolibarr endpoint and API key are required.",
      dolibarrUserId: null,
      endpointUsed: null
    };
  }
  const normalizedEmail = normalizeEmail(user.email);
  if (!isLikelyEmail(normalizedEmail)) {
    return {
      ok: false,
      status: "failed",
      message: "A valid user email is required for Dolibarr employee sync.",
      dolibarrUserId: null,
      endpointUsed: null
    };
  }
  const apiBases = buildDolibarrApiBases(endpoint);
  if (!apiBases.length) {
    return {
      ok: false,
      status: "failed",
      message: "Dolibarr endpoint format is invalid.",
      dolibarrUserId: null,
      endpointUsed: null
    };
  }
  const baseLogin = buildEmployeeLogin(normalizedEmail, user.name);
  let lastFailure = "Unable to sync employee to Dolibarr.";
  for (const apiBase of apiBases) {
    const existing = await lookupDolibarrUserByEmail(apiBase, normalizedEmail, apiKey);
    if (existing.message) {
      lastFailure = existing.message;
      continue;
    }
    if (existing.found) {
      return {
        ok: true,
        status: "exists",
        message: "Employee already exists in Dolibarr.",
        dolibarrUserId: existing.userId,
        endpointUsed: apiBase
      };
    }
    const basePayload = buildDolibarrEmployeePayload(user, baseLogin);
    const created = await createDolibarrEmployee(apiBase, apiKey, basePayload);
    if (created.ok) {
      return {
        ok: true,
        status: "created",
        message: created.message,
        dolibarrUserId: created.userId,
        endpointUsed: apiBase
      };
    }
    if (created.conflict) {
      const retryPayload = buildDolibarrEmployeePayload(user, buildRetryLogin(baseLogin));
      const retried = await createDolibarrEmployee(apiBase, apiKey, retryPayload);
      if (retried.ok) {
        return {
          ok: true,
          status: "created",
          message: retried.message,
          dolibarrUserId: retried.userId,
          endpointUsed: apiBase
        };
      }
      const existingAfterConflict = await lookupDolibarrUserByEmail(apiBase, normalizedEmail, apiKey);
      if (existingAfterConflict.found) {
        return {
          ok: true,
          status: "exists",
          message: "Employee already exists in Dolibarr.",
          dolibarrUserId: existingAfterConflict.userId,
          endpointUsed: apiBase
        };
      }
      lastFailure = retried.message || created.message;
      continue;
    }
    lastFailure = created.message;
  }
  return {
    ok: false,
    status: "failed",
    message: lastFailure,
    dolibarrUserId: null,
    endpointUsed: null
  };
}
async function syncAttendanceWithDolibarr(attendance, config) {
  const enabled = config?.enabled ?? true;
  if (!enabled) {
    await storage.addDolibarrSyncLog({
      id: randomUUID3(),
      attendanceId: attendance.id,
      userId: attendance.userId,
      attempt: 1,
      status: "failed",
      message: "Dolibarr sync disabled in settings",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      syncedAt: null
    });
    return;
  }
  const endpoint = config?.endpoint || process.env.DOLIBARR_ENDPOINT;
  const apiKey = config?.apiKey || process.env.DOLIBARR_API_KEY;
  if (!endpoint || !apiKey) {
    await storage.addDolibarrSyncLog({
      id: randomUUID3(),
      attendanceId: attendance.id,
      userId: attendance.userId,
      attempt: 1,
      status: "failed",
      message: "Dolibarr not configured",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      syncedAt: null
    });
    return;
  }
  const payload = {
    user_id: attendance.userId,
    user_name: attendance.userName,
    check_time: attendance.timestampServer ?? attendance.timestamp,
    geofence_id: attendance.geofenceId ?? null,
    geofence_name: attendance.geofenceName ?? null,
    latitude: attendance.location?.lat ?? null,
    longitude: attendance.location?.lng ?? null,
    action: attendance.type,
    note: attendance.notes ?? "",
    inside_geofence: attendance.isInsideGeofence ?? false
  };
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dolibarr-API-Key": apiKey
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`Dolibarr sync failed with HTTP ${response.status}`);
      }
      await storage.addDolibarrSyncLog({
        id: randomUUID3(),
        attendanceId: attendance.id,
        userId: attendance.userId,
        attempt,
        status: "synced",
        message: "Attendance pushed to Dolibarr",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        syncedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      return;
    } catch (error) {
      const isLast = attempt === maxAttempts;
      await storage.addDolibarrSyncLog({
        id: randomUUID3(),
        attendanceId: attendance.id,
        userId: attendance.userId,
        attempt,
        status: isLast ? "failed" : "pending",
        message: error instanceof Error ? error.message : "Unknown Dolibarr sync error",
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        syncedAt: null
      });
      if (!isLast) {
        await delay(attempt * 800);
      }
    }
  }
}

// server/services/mappls-routing.ts
var MAPPLS_ROUTE_BASE_URL = "https://route.mappls.com/route";
var DEFAULT_DIRECTION_RESOURCE = "route_adv";
var DEFAULT_DISTANCE_RESOURCE = "distance_matrix";
var DEFAULT_PROFILE = "driving";
var DEFAULT_OVERVIEW = "full";
var DEFAULT_GEOMETRIES = "polyline6";
var MAX_ROUTE_POSITIONS = 25;
var MAX_DISTANCE_POSITIONS = 10;
var CACHE_TTL_MS = 5 * 60 * 1e3;
var MAX_CACHE_SIZE = 200;
var directionCache = /* @__PURE__ */ new Map();
var matrixCache = /* @__PURE__ */ new Map();
function getMapplsRoutingApiKey() {
  return process.env.MAPPLS_ROUTING_API_KEY?.trim() || process.env.MAPPLS_REST_API_KEY?.trim() || process.env.MAPPLS_ACCESS_TOKEN?.trim() || process.env.EXPO_PUBLIC_MAPPLS_ROUTING_API_KEY?.trim() || "";
}
function toCoordToken(point) {
  return `${point.longitude},${point.latitude}`;
}
function sanitizeProfile(value) {
  const profile = (value || DEFAULT_PROFILE).trim().toLowerCase();
  if (profile === "driving" || profile === "biking" || profile === "walking" || profile === "trucking") {
    return profile;
  }
  return DEFAULT_PROFILE;
}
function sanitizeDirectionResource(value) {
  const resource = (value || DEFAULT_DIRECTION_RESOURCE).trim().toLowerCase();
  if (resource === "route_adv" || resource === "route_eta" || resource === "route_traffic") {
    return resource;
  }
  return DEFAULT_DIRECTION_RESOURCE;
}
function sanitizeDistanceResource(value) {
  const resource = (value || DEFAULT_DISTANCE_RESOURCE).trim().toLowerCase();
  if (resource === "distance_matrix" || resource === "distance_matrix_eta" || resource === "distance_matrix_traffic") {
    return resource;
  }
  return DEFAULT_DISTANCE_RESOURCE;
}
function sanitizeOverview(value) {
  const overview = (value || DEFAULT_OVERVIEW).trim().toLowerCase();
  if (overview === "full" || overview === "simplified" || overview === "false") return overview;
  return DEFAULT_OVERVIEW;
}
function sanitizeGeometries(value) {
  const geometries = (value || DEFAULT_GEOMETRIES).trim().toLowerCase();
  if (geometries === "polyline" || geometries === "polyline6" || geometries === "geojson") {
    return geometries;
  }
  return DEFAULT_GEOMETRIES;
}
function compactSequential(points) {
  if (points.length <= 1) return [...points];
  const out = [];
  let lastKey = "";
  for (const point of points) {
    const key = `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
    if (key === lastKey) continue;
    out.push(point);
    lastKey = key;
  }
  return out;
}
function pickEvenlySpaced(points, maxCount) {
  if (points.length <= maxCount) return [...points];
  if (maxCount < 2) return [points[0]];
  const first = points[0];
  const last = points[points.length - 1];
  const interior = points.slice(1, -1);
  const interiorSlots = Math.max(0, maxCount - 2);
  if (!interior.length || interiorSlots === 0) {
    return [first, last];
  }
  const sampled = [first];
  for (let i = 0; i < interiorSlots; i += 1) {
    const idx = Math.floor(i * interior.length / interiorSlots);
    sampled.push(interior[Math.min(interior.length - 1, idx)]);
  }
  sampled.push(last);
  return compactSequential(sampled);
}
function decodePolyline(encoded, precision = 6) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 10 ** precision;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;
    coordinates.push({
      latitude: lat / factor,
      longitude: lng / factor
    });
  }
  return coordinates;
}
function buildCacheKey(prefix, fields) {
  const base = fields.map((field) => field === void 0 ? "" : String(field)).join("|");
  return `${prefix}:${base}`;
}
function getCached(cache, key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function setCached(cache, key, value) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}
function toRoutePathFromLogs(points) {
  return points.map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude
  }));
}
function parseDirectionsPayload(payload, geometryType) {
  const body = payload ?? {};
  const routes = Array.isArray(body.routes) ? body.routes : [];
  const first = routes[0];
  if (!first) {
    return { path: [], distanceMeters: null, durationSeconds: null, routeId: null };
  }
  const distanceMeters = typeof first.distance === "number" && Number.isFinite(first.distance) ? first.distance : null;
  const durationSeconds = typeof first.duration === "number" && Number.isFinite(first.duration) ? first.duration : null;
  const routeId = typeof first.routeId === "string" ? first.routeId : null;
  if (geometryType === "geojson" && Array.isArray(first.geometry)) {
    const path4 = first.geometry.map((item) => {
      if (!Array.isArray(item) || item.length < 2) return null;
      const longitude = Number(item[0]);
      const latitude = Number(item[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return { latitude, longitude };
    }).filter((item) => Boolean(item));
    return { path: path4, distanceMeters, durationSeconds, routeId };
  }
  if (typeof first.geometry === "string") {
    const precision = geometryType === "polyline" ? 5 : 6;
    try {
      const path4 = decodePolyline(first.geometry, precision);
      return { path: path4, distanceMeters, durationSeconds, routeId };
    } catch {
      return { path: [], distanceMeters, durationSeconds, routeId };
    }
  }
  return { path: [], distanceMeters, durationSeconds, routeId };
}
function buildDirectionError(status, bodyText) {
  const trimmed = bodyText.trim();
  if (!trimmed) return `Mappls routing request failed with HTTP ${status}`;
  return `Mappls routing request failed with HTTP ${status}: ${trimmed.slice(0, 220)}`;
}
function buildMatrixError(status, bodyText) {
  const trimmed = bodyText.trim();
  if (!trimmed) return `Mappls distance matrix request failed with HTTP ${status}`;
  return `Mappls distance matrix request failed with HTTP ${status}: ${trimmed.slice(0, 220)}`;
}
async function getMapplsDirectionsForLogs(rawPoints, options) {
  const apiKey = getMapplsRoutingApiKey();
  if (!apiKey) return null;
  const compacted = compactSequential(rawPoints);
  if (compacted.length < 2) return null;
  const sampled = pickEvenlySpaced(compacted, MAX_ROUTE_POSITIONS);
  const resource = sanitizeDirectionResource(options?.resource ?? process.env.MAPPLS_ROUTING_RESOURCE);
  const profile = sanitizeProfile(options?.profile ?? process.env.MAPPLS_ROUTING_PROFILE);
  const overview = sanitizeOverview(options?.overview ?? process.env.MAPPLS_ROUTING_OVERVIEW);
  const geometries = sanitizeGeometries(options?.geometries ?? process.env.MAPPLS_ROUTING_GEOMETRIES);
  const steps = options?.steps ?? true;
  const alternatives = options?.alternatives ?? false;
  const region = (options?.region ?? process.env.MAPPLS_ROUTING_REGION ?? "").trim().toLowerCase();
  const routeTypeEnv = process.env.MAPPLS_ROUTING_RTYPE;
  const routeTypeRaw = options?.routeType ?? (routeTypeEnv && /^-?\d+$/.test(routeTypeEnv) ? Number(routeTypeEnv) : null);
  const routeType = typeof routeTypeRaw === "number" && Number.isFinite(routeTypeRaw) ? routeTypeRaw : null;
  const cacheKey = buildCacheKey("dir", [
    resource,
    profile,
    overview,
    geometries,
    steps,
    alternatives,
    region,
    routeType,
    sampled.length,
    sampled[0].capturedAt,
    sampled[sampled.length - 1].capturedAt,
    sampled.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(";")
  ]);
  const cached = getCached(directionCache, cacheKey);
  if (cached) return cached;
  const positionToken = sampled.map(toCoordToken).join(";");
  const endpoint = `${MAPPLS_ROUTE_BASE_URL}/direction/${resource}/${profile}/${positionToken}`;
  const url = new URL(endpoint);
  url.searchParams.set("access_token", apiKey);
  url.searchParams.set("steps", steps ? "true" : "false");
  url.searchParams.set("alternatives", alternatives ? "true" : "false");
  url.searchParams.set("overview", overview);
  url.searchParams.set("geometries", geometries);
  if (region) url.searchParams.set("region", region);
  if (routeType !== null) url.searchParams.set("rtype", String(routeType));
  const baseFallbackPath = toRoutePathFromLogs(sampled);
  try {
    const response = await fetch(url.toString());
    const text = await response.text();
    if (!response.ok) {
      const failed = {
        provider: "mappls",
        enabled: true,
        path: baseFallbackPath,
        profile,
        resource,
        geometries,
        distanceMeters: null,
        durationSeconds: null,
        routeId: null,
        sampledPointCount: sampled.length,
        rawPointCount: rawPoints.length,
        error: buildDirectionError(response.status, text)
      };
      setCached(directionCache, cacheKey, failed);
      return failed;
    }
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const parsed = parseDirectionsPayload(payload, geometries);
    const next = {
      provider: "mappls",
      enabled: true,
      path: parsed.path.length >= 2 ? parsed.path : baseFallbackPath,
      profile,
      resource,
      geometries,
      distanceMeters: parsed.distanceMeters,
      durationSeconds: parsed.durationSeconds,
      routeId: parsed.routeId,
      sampledPointCount: sampled.length,
      rawPointCount: rawPoints.length,
      error: null
    };
    setCached(directionCache, cacheKey, next);
    return next;
  } catch (error) {
    const failed = {
      provider: "mappls",
      enabled: true,
      path: baseFallbackPath,
      profile,
      resource,
      geometries,
      distanceMeters: null,
      durationSeconds: null,
      routeId: null,
      sampledPointCount: sampled.length,
      rawPointCount: rawPoints.length,
      error: error instanceof Error ? error.message : "Mappls routing request failed"
    };
    setCached(directionCache, cacheKey, failed);
    return failed;
  }
}
function parseMatrixPayload(payload) {
  const body = payload ?? {};
  const root = body.results ?? body;
  const durationsRaw = Array.isArray(root.durations) ? root.durations : [];
  const distancesRaw = Array.isArray(root.distances) ? root.distances : [];
  const durations = durationsRaw.map(
    (row) => Array.isArray(row) ? row.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0) : []
  );
  const distances = distancesRaw.map(
    (row) => Array.isArray(row) ? row.map((value) => typeof value === "number" && Number.isFinite(value) ? value : 0) : []
  );
  return { durations, distances };
}
async function getMapplsDistanceMatrixForLogs(rawPoints, options) {
  const apiKey = getMapplsRoutingApiKey();
  if (!apiKey) return null;
  const compacted = compactSequential(rawPoints);
  if (compacted.length < 2) return null;
  const sampled = pickEvenlySpaced(compacted, MAX_DISTANCE_POSITIONS);
  const resource = sanitizeDistanceResource(options?.resource ?? process.env.MAPPLS_DISTANCE_RESOURCE);
  const profile = sanitizeProfile(options?.profile ?? process.env.MAPPLS_DISTANCE_PROFILE);
  const region = (options?.region ?? process.env.MAPPLS_DISTANCE_REGION ?? "").trim().toLowerCase();
  const routeTypeEnv = process.env.MAPPLS_DISTANCE_RTYPE;
  const routeTypeRaw = options?.routeType ?? (routeTypeEnv && /^-?\d+$/.test(routeTypeEnv) ? Number(routeTypeEnv) : null);
  const routeType = typeof routeTypeRaw === "number" && Number.isFinite(routeTypeRaw) ? routeTypeRaw : null;
  const cacheKey = buildCacheKey("dm", [
    resource,
    profile,
    region,
    routeType,
    sampled.length,
    sampled[0].capturedAt,
    sampled[sampled.length - 1].capturedAt,
    sampled.map((p) => `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`).join(";")
  ]);
  const cached = getCached(matrixCache, cacheKey);
  if (cached) return cached;
  const coordinateTokens = sampled.map(toCoordToken);
  const endpoint = `${MAPPLS_ROUTE_BASE_URL}/dm/${resource}/${profile}/${coordinateTokens.join(";")}`;
  const url = new URL(endpoint);
  url.searchParams.set("access_token", apiKey);
  if (region) url.searchParams.set("region", region);
  if (routeType !== null) url.searchParams.set("rtype", String(routeType));
  try {
    const response = await fetch(url.toString());
    const text = await response.text();
    if (!response.ok) {
      const failed = {
        provider: "mappls",
        enabled: true,
        profile,
        resource,
        rawPointCount: rawPoints.length,
        sampledPointCount: sampled.length,
        coordinates: coordinateTokens,
        durations: [],
        distances: [],
        error: buildMatrixError(response.status, text)
      };
      setCached(matrixCache, cacheKey, failed);
      return failed;
    }
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const parsed = parseMatrixPayload(payload);
    const next = {
      provider: "mappls",
      enabled: true,
      profile,
      resource,
      rawPointCount: rawPoints.length,
      sampledPointCount: sampled.length,
      coordinates: coordinateTokens,
      durations: parsed.durations,
      distances: parsed.distances,
      error: null
    };
    setCached(matrixCache, cacheKey, next);
    return next;
  } catch (error) {
    const failed = {
      provider: "mappls",
      enabled: true,
      profile,
      resource,
      rawPointCount: rawPoints.length,
      sampledPointCount: sampled.length,
      coordinates: coordinateTokens,
      durations: [],
      distances: [],
      error: error instanceof Error ? error.message : "Mappls distance matrix request failed"
    };
    setCached(matrixCache, cacheKey, failed);
    return failed;
  }
}

// server/services/speech2text.ts
import { promises as fs2 } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path2 from "node:path";
var HF_INFERENCE_BASE_URL = (process.env.HF_INFERENCE_BASE_URL?.trim() || "https://router.huggingface.co/hf-inference/models").replace(/\/+$/, "");
var GEMINI_API_BASE_URL = (process.env.GEMINI_API_BASE_URL?.trim() || process.env.GEMINI_API_BASE?.trim() || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
var DEFAULT_FAIRSEQ_S2T_MODEL = process.env.HF_S2T_MODEL?.trim() || "facebook/s2t-small-librispeech-asr";
var DEFAULT_FALLBACK_MODEL = process.env.HF_STT_FALLBACK_MODEL?.trim() || "distil-whisper/distil-small.en";
var DEFAULT_GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
var DEFAULT_PROVIDER_ORDER = (process.env.SPEECH_TO_TEXT_PROVIDER_ORDER?.trim() || "gemini,local_python,huggingface").toLowerCase();
var LOCAL_STT_ENABLED = (process.env.LOCAL_STT_ENABLED?.trim() || "true").toLowerCase() !== "false";
var LOCAL_STT_PYTHON_CMD = process.env.LOCAL_STT_PYTHON_CMD?.trim() || "python";
var LOCAL_STT_MODEL = process.env.LOCAL_STT_MODEL?.trim() || "small";
var LOCAL_STT_SCRIPT_PATH = process.env.LOCAL_STT_SCRIPT_PATH?.trim() || path2.resolve(process.cwd(), "server", "python", "stt_diarize.py");
var DEFAULT_REQUEST_TIMEOUT_MS = Math.max(
  1e4,
  Number(process.env.HF_S2T_TIMEOUT_MS || 7e4)
);
var LOCAL_STT_TIMEOUT_MS = Math.max(
  2e4,
  Number(process.env.LOCAL_STT_TIMEOUT_MS || 24e4)
);
var TRANSCRIBE_RETRY_DELAY_MS = Math.max(
  200,
  Number(process.env.SPEECH_TRANSCRIBE_RETRY_DELAY_MS || 900)
);
var Speech2TextError = class extends Error {
  statusCode;
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "Speech2TextError";
    this.statusCode = statusCode;
  }
};
function toModelId(value, fallback) {
  const trimmed = value?.trim();
  return trimmed || fallback;
}
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function isLikelyHuggingFaceModel(value) {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return false;
  return candidate.includes("/");
}
function resolveLocalModel(value) {
  const candidate = value?.trim() || "";
  if (!candidate) return LOCAL_STT_MODEL;
  if (candidate.includes("/") || candidate.includes(":")) return LOCAL_STT_MODEL;
  return candidate;
}
function parseProviderOrder(input) {
  const chunks = input.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const providers = [];
  for (const chunk of chunks) {
    if ((chunk === "gemini" || chunk === "google" || chunk === "google_gemini") && !providers.includes("gemini")) {
      providers.push("gemini");
    }
    if ((chunk === "local" || chunk === "python" || chunk === "local_python") && !providers.includes("local_python")) {
      providers.push("local_python");
    }
    if ((chunk === "hf" || chunk === "huggingface") && !providers.includes("huggingface")) {
      providers.push("huggingface");
    }
  }
  if (!providers.length) {
    providers.push("gemini", "local_python", "huggingface");
  }
  if (providers.includes("gemini")) {
    return ["gemini", ...providers.filter((provider) => provider !== "gemini")];
  }
  return providers;
}
function guessFileExtension(mimeType) {
  const lower = mimeType.toLowerCase();
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("aac")) return ".aac";
  if (lower.includes("3gpp")) return ".3gp";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("ogg")) return ".ogg";
  return ".m4a";
}
function toBlobCompatiblePart(buffer) {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy.buffer;
}
function extractTranscript(payload) {
  if (!payload) return "";
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object") {
        const row = item;
        const generated = row.generated_text;
        const text = row.text;
        const transcript = row.transcript;
        if (typeof transcript === "string" && transcript.trim()) return transcript.trim();
        if (typeof text === "string" && text.trim()) return text.trim();
        if (typeof generated === "string" && generated.trim()) return generated.trim();
      }
    }
    return "";
  }
  if (typeof payload === "object") {
    const row = payload;
    const candidates = Array.isArray(row.candidates) ? row.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const content = candidate.content;
      if (!content || typeof content !== "object") continue;
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const combined = parts.map(
        (part) => part && typeof part === "object" && typeof part.text === "string" ? String(part.text).trim() : ""
      ).filter(Boolean).join("\n").trim();
      if (combined) return combined;
    }
    if (typeof row.transcript === "string" && row.transcript.trim()) {
      return row.transcript.trim();
    }
    if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
    if (typeof row.generated_text === "string" && row.generated_text.trim()) {
      return row.generated_text.trim();
    }
    if (typeof row.transcription === "string" && row.transcription.trim()) {
      return row.transcription.trim();
    }
  }
  return "";
}
function extractDiarizedEntries(payload) {
  if (!payload || typeof payload !== "object") return [];
  const row = payload;
  const diarized = row.diarized_transcript && typeof row.diarized_transcript === "object" ? row.diarized_transcript : row.diarizedTranscript && typeof row.diarizedTranscript === "object" ? row.diarizedTranscript : null;
  if (!diarized) return [];
  const entries = Array.isArray(diarized.entries) ? diarized.entries : [];
  const normalized = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const segment = item;
    const transcript = typeof segment.transcript === "string" ? segment.transcript.trim() : "";
    if (!transcript) continue;
    const start = typeof segment.start_time_seconds === "number" ? segment.start_time_seconds : typeof segment.startTimeSeconds === "number" ? segment.startTimeSeconds : null;
    const end = typeof segment.end_time_seconds === "number" ? segment.end_time_seconds : typeof segment.endTimeSeconds === "number" ? segment.endTimeSeconds : null;
    const speaker = typeof segment.speaker_id === "string" ? segment.speaker_id.trim() : typeof segment.speakerId === "string" ? segment.speakerId.trim() : "";
    normalized.push({
      transcript,
      startTimeSeconds: start,
      endTimeSeconds: end,
      speakerId: speaker || null
    });
  }
  return normalized;
}
function parseBody2(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function getErrorMessage(status, payload) {
  if (payload && typeof payload === "object") {
    const row = payload;
    if (typeof row.error === "string" && row.error.trim()) {
      return row.error.trim();
    }
    if (row.error && typeof row.error === "object" && typeof row.error.message === "string") {
      return String(row.error.message).trim();
    }
    if (typeof row.message === "string" && row.message.trim()) {
      return row.message.trim();
    }
  }
  return `Speech-to-text request failed with HTTP ${status}`;
}
function shouldRetry(status, message) {
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return /loading|currently loading|cold start|try again/i.test(message);
}
function combineWarnings(...warnings) {
  const items = warnings.map((value) => (value || "").trim()).filter(Boolean);
  if (!items.length) return void 0;
  return items.join(" | ");
}
function getModelWarning(provider, model) {
  if (provider === "local_python") {
    return "Local Python STT running on-device/server CPU. Accuracy and speed depend on model size and hardware.";
  }
  if (provider === "gemini") {
    return "Gemini multimodal transcription quality depends on model/audio clarity; results may vary on noisy calls.";
  }
  if (provider === "huggingface" && model === "facebook/s2t-small-librispeech-asr") {
    return "HF model is optimized for English ASR; multilingual/Indian speech accuracy may vary.";
  }
  return void 0;
}
function runCommandWithTimeout(params) {
  return new Promise((resolve3, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }, params.timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve3({
        stdout,
        stderr,
        exitCode,
        signal
      });
    });
  });
}
async function callLocalPythonModel(params) {
  if (!LOCAL_STT_ENABLED) {
    throw new Speech2TextError("Local Python STT is disabled by env config.", 503);
  }
  const startedAt = Date.now();
  try {
    await fs2.access(LOCAL_STT_SCRIPT_PATH);
  } catch {
    throw new Speech2TextError(
      `Local STT script missing at: ${LOCAL_STT_SCRIPT_PATH}`,
      500
    );
  }
  const tempDir = await fs2.mkdtemp(path2.join(os.tmpdir(), "trackforce-stt-"));
  const audioPath = path2.join(tempDir, `speech${guessFileExtension(params.mimeType)}`);
  try {
    await fs2.writeFile(audioPath, params.audio);
    const args = [
      LOCAL_STT_SCRIPT_PATH,
      "--audio",
      audioPath,
      "--model",
      params.model || LOCAL_STT_MODEL,
      "--format",
      "json"
    ];
    if (params.languageCode?.trim()) {
      args.push("--language", params.languageCode.trim());
    }
    if (params.withTimestamps ?? true) {
      args.push("--with-timestamps");
    }
    if (params.withDiarization) {
      args.push("--with-diarization");
    }
    if (typeof params.numSpeakers === "number" && Number.isFinite(params.numSpeakers) && params.numSpeakers > 0) {
      args.push("--num-speakers", String(Math.max(1, Math.floor(params.numSpeakers))));
    }
    const result = await runCommandWithTimeout({
      command: LOCAL_STT_PYTHON_CMD,
      args,
      timeoutMs: LOCAL_STT_TIMEOUT_MS
    });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.signal === "SIGKILL") {
      throw new Speech2TextError("Local Python STT timed out.", 504);
    }
    if (result.exitCode !== 0) {
      throw new Speech2TextError(
        stderr || `Local Python STT exited with code ${result.exitCode}.`,
        502
      );
    }
    if (!stdout) {
      throw new Speech2TextError("Local Python STT returned empty response.", 502);
    }
    const payload = parseBody2(stdout);
    const transcript = extractTranscript(payload);
    if (!transcript) {
      throw new Speech2TextError("Local Python STT returned empty transcript.", 422);
    }
    const diarizedEntries = extractDiarizedEntries(payload);
    return {
      transcript,
      latencyMs: Date.now() - startedAt,
      ...diarizedEntries.length ? { diarizedTranscript: { entries: diarizedEntries } } : {}
    };
  } catch (error) {
    if (error instanceof Speech2TextError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Local Python STT request failed.";
    throw new Speech2TextError(message, 502);
  } finally {
    await fs2.rm(tempDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function callHuggingFaceModel({
  model,
  audio,
  mimeType,
  token
}) {
  const url = new URL(`${HF_INFERENCE_BASE_URL}/${encodeURIComponent(model)}`);
  url.searchParams.set("wait_for_model", "true");
  const headers = {
    Accept: "application/json",
    "Content-Type": mimeType
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: new Blob([toBlobCompatiblePart(audio)], { type: mimeType }),
        signal: controller.signal
      });
      const bodyText = await response.text();
      const payload = parseBody2(bodyText);
      if (!response.ok) {
        const message = getErrorMessage(response.status, payload);
        if (attempt === 0 && shouldRetry(response.status, message)) {
          await sleep(TRANSCRIBE_RETRY_DELAY_MS);
          continue;
        }
        throw new Speech2TextError(message, response.status);
      }
      const transcript = extractTranscript(payload);
      if (!transcript) {
        throw new Speech2TextError("HuggingFace STT returned empty transcript", 422);
      }
      return { transcript, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === "AbortError") {
        continue;
      }
      if (error instanceof Speech2TextError) throw error;
      const message = error instanceof Error ? error.message : "HuggingFace speech-to-text request failed";
      throw new Speech2TextError(message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Speech2TextError("HuggingFace speech-to-text request timed out", 504);
}
async function callGeminiModel(params) {
  const startedAt = Date.now();
  const endpoint = `${GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.token)}`;
  const base64Audio = params.audio.toString("base64");
  const promptLines = [
    "Transcribe this audio accurately.",
    "Return only the transcript text.",
    "Do not add commentary, markdown, or extra labels unless speakers are very clearly distinguishable."
  ];
  if (params.languageCode?.trim()) {
    promptLines.push(`Prefer language code/context: ${params.languageCode.trim()}.`);
  }
  if (params.withTimestamps) {
    promptLines.push("Include lightweight timestamps inline when clearly available.");
  }
  if (params.withDiarization) {
    promptLines.push("If speakers are clearly separable, use speaker labels.");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: promptLines.join(" ") },
                {
                  inlineData: {
                    mimeType: params.mimeType,
                    data: base64Audio
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0
          }
        })
      });
      const bodyText = await response.text();
      const payload = parseBody2(bodyText);
      if (!response.ok) {
        const message = getErrorMessage(response.status, payload);
        if (attempt === 0 && shouldRetry(response.status, message)) {
          await sleep(TRANSCRIBE_RETRY_DELAY_MS);
          continue;
        }
        throw new Speech2TextError(message, response.status);
      }
      const transcript = extractTranscript(payload);
      if (!transcript) {
        throw new Speech2TextError("Gemini STT returned empty transcript", 422);
      }
      return {
        transcript,
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === "AbortError") {
        continue;
      }
      if (error instanceof Speech2TextError) throw error;
      const message = error instanceof Error ? error.message : "Gemini speech-to-text request failed";
      throw new Speech2TextError(message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Speech2TextError("Gemini speech-to-text request timed out", 504);
}
async function runHuggingFaceWithFallback(params) {
  try {
    const result = await callHuggingFaceModel({
      model: params.primaryModel,
      audio: params.audio,
      mimeType: params.mimeType,
      token: params.token
    });
    return {
      transcript: result.transcript,
      provider: "huggingface",
      model: params.primaryModel,
      fallbackUsed: false,
      warning: getModelWarning("huggingface", params.primaryModel),
      latencyMs: result.latencyMs
    };
  } catch (primaryError) {
    if (!params.fallbackModel || params.fallbackModel === params.primaryModel) {
      throw primaryError;
    }
    const fallbackResult = await callHuggingFaceModel({
      model: params.fallbackModel,
      audio: params.audio,
      mimeType: params.mimeType,
      token: params.token
    });
    return {
      transcript: fallbackResult.transcript,
      provider: "huggingface",
      model: params.fallbackModel,
      fallbackUsed: true,
      warning: combineWarnings(
        `HF fallback used after primary model "${params.primaryModel}" failed.`,
        getModelWarning("huggingface", params.primaryModel)
      ),
      latencyMs: fallbackResult.latencyMs
    };
  }
}
async function transcribeSpeechWithFairseqS2T(request) {
  if (!request.audio || request.audio.length === 0) {
    throw new Speech2TextError("Audio payload is empty", 400);
  }
  const mimeType = request.mimeType?.trim() || "audio/webm";
  const geminiToken = request.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_API?.trim() || process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim() || process.env.EXPO_PUBLIC_GEMINI_API?.trim() || "";
  const hfToken = request.huggingFaceToken?.trim() || process.env.HUGGINGFACE_API_KEY?.trim() || process.env.HUGGINGFACE_TOKEN?.trim() || "";
  const requestedModel = request.model?.trim() || "";
  const localModel = resolveLocalModel(requestedModel);
  const geminiModel = requestedModel.toLowerCase().startsWith("gemini-") ? requestedModel : DEFAULT_GEMINI_STT_MODEL;
  const hfPrimaryModel = requestedModel && isLikelyHuggingFaceModel(requestedModel) && !requestedModel.toLowerCase().startsWith("gemini-") ? requestedModel : DEFAULT_FAIRSEQ_S2T_MODEL;
  const hfFallbackModel = toModelId(request.fallbackModel, DEFAULT_FALLBACK_MODEL);
  const providerOrder = parseProviderOrder(request.provider?.trim() || DEFAULT_PROVIDER_ORDER);
  let geminiFailure = null;
  let localFailure = null;
  let huggingFaceFailure = null;
  for (const provider of providerOrder) {
    if (provider === "gemini") {
      if (!geminiToken) {
        geminiFailure = "Gemini API key missing.";
        continue;
      }
      try {
        const result = await callGeminiModel({
          model: geminiModel,
          audio: request.audio,
          mimeType,
          token: geminiToken,
          languageCode: request.languageCode?.trim() || "",
          withTimestamps: request.withTimestamps ?? true,
          withDiarization: Boolean(request.withDiarization)
        });
        return {
          transcript: result.transcript,
          provider: "gemini",
          model: geminiModel,
          fallbackUsed: false,
          warning: combineWarnings(
            localFailure,
            huggingFaceFailure,
            getModelWarning("gemini", geminiModel)
          ),
          latencyMs: result.latencyMs
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gemini STT failed unexpectedly.";
        geminiFailure = message;
      }
      continue;
    }
    if (provider === "local_python") {
      try {
        const localResult = await callLocalPythonModel({
          model: localModel,
          audio: request.audio,
          mimeType,
          languageCode: request.languageCode?.trim() || "",
          withDiarization: Boolean(request.withDiarization),
          withTimestamps: request.withTimestamps ?? true,
          numSpeakers: typeof request.numSpeakers === "number" && Number.isFinite(request.numSpeakers) ? request.numSpeakers : void 0
        });
        return {
          transcript: localResult.transcript,
          provider: "local_python",
          model: localModel,
          fallbackUsed: false,
          warning: combineWarnings(geminiFailure, getModelWarning("local_python", localModel)),
          latencyMs: localResult.latencyMs,
          ...localResult.diarizedTranscript ? { diarizedTranscript: localResult.diarizedTranscript } : {}
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Local Python STT failed unexpectedly.";
        localFailure = message;
      }
      continue;
    }
    try {
      const hfResult = await runHuggingFaceWithFallback({
        primaryModel: hfPrimaryModel,
        fallbackModel: hfFallbackModel,
        audio: request.audio,
        mimeType,
        token: hfToken
      });
      return {
        ...hfResult,
        warning: combineWarnings(geminiFailure, localFailure, hfResult.warning)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "HuggingFace STT failed unexpectedly.";
      huggingFaceFailure = message;
    }
  }
  throw new Speech2TextError(
    combineWarnings(geminiFailure, localFailure, huggingFaceFailure) || "All speech-to-text providers failed.",
    502
  );
}

// server/services/mysql-state.ts
import mysql from "mysql2/promise";
var pool = null;
var tableEnsured = false;
var TABLE_NAME = "lff_app_state";
function normalizeBool(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function toNullable(value) {
  const normalized = value?.trim() || "";
  return normalized ? normalized : null;
}
function toPort(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 3306;
  return Math.trunc(parsed);
}
function buildPoolConfig() {
  const host = toNullable(process.env.MYSQL_HOST);
  const user = toNullable(process.env.MYSQL_USER);
  const password = toNullable(process.env.MYSQL_PASSWORD);
  const database = toNullable(process.env.MYSQL_DATABASE) || toNullable(process.env.MYSQL_DB);
  if (!host || !user || !password || !database) {
    return null;
  }
  const sslEnabled = normalizeBool(process.env.MYSQL_SSL);
  const sslRejectUnauthorized = normalizeBool(
    process.env.MYSQL_SSL_REJECT_UNAUTHORIZED ?? "false"
  );
  const config = {
    host,
    user,
    password,
    database,
    port: toPort(process.env.MYSQL_PORT),
    connectionLimit: 12,
    waitForConnections: true,
    queueLimit: 0,
    namedPlaceholders: true,
    charset: "utf8mb4"
  };
  if (sslEnabled) {
    config.ssl = {
      rejectUnauthorized: sslRejectUnauthorized
    };
  }
  return config;
}
function isMySqlStateEnabled() {
  return buildPoolConfig() !== null;
}
async function getPool() {
  if (pool) return pool;
  const config = buildPoolConfig();
  if (!config) {
    throw new Error("MySQL state store is not configured. Set MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE.");
  }
  pool = mysql.createPool(config);
  return pool;
}
async function ensureStateTable() {
  if (tableEnsured) return;
  const conn = await getPool();
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS \`${TABLE_NAME}\` (
      \`state_key\` VARCHAR(191) NOT NULL,
      \`json_value\` LONGTEXT NOT NULL,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`state_key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tableEnsured = true;
}
async function getMySqlStateValue(key) {
  if (!isMySqlStateEnabled()) return null;
  await ensureStateTable();
  const conn = await getPool();
  const [rows] = await conn.execute(
    `SELECT state_key, json_value, updated_at FROM \`${TABLE_NAME}\` WHERE state_key = ? LIMIT 1`,
    [key]
  );
  if (!rows.length) return null;
  return rows[0].json_value;
}
async function setMySqlStateValue(key, jsonValue) {
  if (!isMySqlStateEnabled()) {
    throw new Error("MySQL state store is not configured.");
  }
  await ensureStateTable();
  const conn = await getPool();
  await conn.execute(
    `INSERT INTO \`${TABLE_NAME}\` (state_key, json_value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       json_value = VALUES(json_value),
       updated_at = CURRENT_TIMESTAMP`,
    [key, jsonValue]
  );
}

// lib/ai-sales-analysis.ts
var AIRequestError = class extends Error {
  status;
  code;
  model;
  kind;
  retryable;
  constructor(params) {
    super(params.message);
    this.name = "AIRequestError";
    this.status = params.status;
    this.code = params.code || "unknown_error";
    this.model = params.model;
    this.kind = params.kind;
    this.retryable = Boolean(params.retryable);
  }
};
var GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
var GEMINI_DEFAULT_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash"
];
var REQUEST_TIMEOUT_MS = 25e3;
var MAX_RETRY_ATTEMPTS = 4;
var BASE_RETRY_DELAY_MS = 800;
var MAX_TRANSCRIPT_CHARS = 8e3;
function normalizeApiSecret(value) {
  if (!value) return "";
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}
function delay2(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function clampScore(value, fallback = 50) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}
function normalizeSentiment(value) {
  if (value === "positive" || value === "neutral" || value === "negative") return value;
  return "neutral";
}
function normalizeBuyingIntent(value) {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}
function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0);
  if (!cleaned.length) return fallback;
  return [...new Set(cleaned)].slice(0, 8);
}
function buildFallbackSummary(transcript) {
  const sentence = transcript.split(/[.!?]\s+/).find((part) => part.trim().length > 0)?.trim();
  if (!sentence) return "Conversation captured and analyzed.";
  return sentence.length > 220 ? `${sentence.slice(0, 220)}...` : sentence;
}
function dedupeModels(models) {
  const out = [];
  for (const item of models) {
    const value = item.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}
function buildGeminiModelCandidates(model) {
  const selected = model?.trim() || "";
  const preferred = selected.toLowerCase().startsWith("gemini-") ? [selected] : [];
  return dedupeModels([...preferred, ...GEMINI_DEFAULT_MODELS]);
}
function extractJson(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("AI response did not include valid JSON.");
}
function toLower(value) {
  return (value || "").trim().toLowerCase();
}
function normalizeUnknownError(error, model) {
  if (error instanceof AIRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new AIRequestError({
      message: "AI request timed out.",
      status: 0,
      code: "timeout",
      model,
      kind: "timeout",
      retryable: true
    });
  }
  if (error instanceof Error) {
    return new AIRequestError({
      message: error.message || "AI network error.",
      status: 0,
      code: "network_error",
      model,
      kind: "network_error",
      retryable: true
    });
  }
  return new AIRequestError({
    message: "Unknown AI request error.",
    status: 0,
    code: "unknown_error",
    model,
    kind: "unknown"
  });
}
function normalizeGeminiError(params) {
  const code = String(params.error?.code || "").trim().toLowerCase();
  const statusText = toLower(params.error?.status);
  const message = (params.error?.message || params.rawMessage || "").trim();
  const messageLower = message.toLowerCase();
  const isModelIssue = params.status === 404 || statusText === "not_found" || messageLower.includes("model") && messageLower.includes("not found") || messageLower.includes("not supported for generatecontent");
  if (isModelIssue) {
    return new AIRequestError({
      message: `Model "${params.model}" unavailable. Trying fallback model.`,
      status: params.status,
      code: code || "model_not_found",
      model: params.model,
      kind: "model_not_available"
    });
  }
  const looksLikeInvalidKey = params.status === 400 && (messageLower.includes("api key not valid") || messageLower.includes("api_key_invalid") || messageLower.includes("please pass a valid api key"));
  if (looksLikeInvalidKey || params.status === 401 || params.status === 403 || statusText === "permission_denied") {
    return new AIRequestError({
      message: "AI key invalid or unauthorized for this project.",
      status: params.status,
      code: code || "invalid_api_key",
      model: params.model,
      kind: "invalid_api_key"
    });
  }
  const isQuota = params.status === 429 && /quota|billing|limit|exceed|resource exhausted/i.test(messageLower);
  if (isQuota) {
    return new AIRequestError({
      message: "AI quota exhausted / billing limit reached.",
      status: params.status,
      code: code || "quota_exhausted",
      model: params.model,
      kind: "quota_exhausted"
    });
  }
  if (params.status === 429 || statusText === "resource_exhausted") {
    return new AIRequestError({
      message: "AI rate limit hit. Retrying with backoff.",
      status: params.status,
      code: code || "rate_limited",
      model: params.model,
      kind: "rate_limited",
      retryable: true
    });
  }
  if (params.status >= 500 || statusText === "unavailable") {
    return new AIRequestError({
      message: `AI server transient error (${params.status}). Retrying.`,
      status: params.status,
      code: code || "server_error",
      model: params.model,
      kind: "server_error",
      retryable: true
    });
  }
  if (params.status >= 400 && params.status < 500) {
    return new AIRequestError({
      message: message || `AI request failed (${params.status}).`,
      status: params.status,
      code: code || "bad_request",
      model: params.model,
      kind: "bad_request"
    });
  }
  return new AIRequestError({
    message: message || "AI request failed.",
    status: params.status,
    code: code || "unknown_error",
    model: params.model,
    kind: "unknown"
  });
}
function truncateTranscript(transcript) {
  const cleaned = transcript.trim();
  if (cleaned.length <= MAX_TRANSCRIPT_CHARS) return cleaned;
  const headChars = Math.floor(MAX_TRANSCRIPT_CHARS * 0.65);
  const tailChars = Math.floor(MAX_TRANSCRIPT_CHARS * 0.3);
  const omitted = cleaned.length - headChars - tailChars;
  return [
    cleaned.slice(0, headChars),
    `
[... ${omitted} chars omitted for token optimization ...]
`,
    cleaned.slice(-tailChars)
  ].join("");
}
async function requestGeminiCompletion(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const versions = ["v1beta", "v1"];
  let lastError = null;
  try {
    for (const version of versions) {
      const endpoint = `${GEMINI_API_BASE}/${version}/models/${encodeURIComponent(params.model)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
      try {
        const mergedPrompt = [
          "System instructions:",
          params.systemPrompt,
          "",
          "User request:",
          params.userPrompt
        ].join("\n");
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: mergedPrompt }]
              }
            ],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 1600,
              ...params.model.toLowerCase().includes("gemini-2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {},
              ...params.useJsonMode ? { responseMimeType: "application/json" } : {}
            }
          })
        });
        const rawText = await response.text();
        let payload;
        try {
          payload = rawText ? JSON.parse(rawText) : void 0;
        } catch {
          payload = void 0;
        }
        if (!response.ok) {
          throw normalizeGeminiError({
            status: response.status,
            model: params.model,
            rawMessage: rawText,
            error: payload?.error
          });
        }
        if (payload?.promptFeedback?.blockReason) {
          throw new AIRequestError({
            message: `AI blocked response: ${payload.promptFeedback.blockReason}`,
            status: response.status,
            code: "blocked",
            model: params.model,
            kind: "bad_request"
          });
        }
        const content = payload?.candidates?.[0]?.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("\n").trim();
        if (!content) {
          throw new AIRequestError({
            message: `AI response was empty for model "${params.model}".`,
            status: response.status,
            code: "empty_response",
            model: params.model,
            kind: "unknown"
          });
        }
        return content;
      } catch (error) {
        const normalized = normalizeUnknownError(error, params.model);
        lastError = normalized;
        const looksLikeVersionIssue = normalized.kind === "model_not_available" || normalized.kind === "bad_request" || /not found|unsupported/i.test(normalized.message.toLowerCase());
        if (looksLikeVersionIssue) {
          continue;
        }
        throw normalized;
      }
    }
    throw lastError || new AIRequestError({
      message: "AI request failed.",
      status: 0,
      code: "unknown_error",
      model: params.model,
      kind: "unknown"
    });
  } catch (error) {
    throw normalizeUnknownError(error, params.model);
  } finally {
    clearTimeout(timer);
  }
}
async function requestWithRetry(fn, model) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeUnknownError(error, model);
      lastError = normalized;
      if (!normalized.retryable || attempt === MAX_RETRY_ATTEMPTS) {
        throw normalized;
      }
      const jitter = Math.floor(Math.random() * 350);
      const backoff = Math.min(6e3, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)) + jitter;
      await delay2(backoff);
    }
  }
  throw lastError || new AIRequestError({
    message: "AI request failed after retries.",
    status: 0,
    model,
    kind: "unknown"
  });
}
async function analyzeConversationWithAI(input) {
  const apiKey = normalizeApiSecret(input.apiKey);
  if (!apiKey) {
    throw new Error("AI key is missing.");
  }
  const transcript = truncateTranscript(input.transcript);
  if (!transcript || transcript.length < 20) {
    throw new Error("Transcript is too short for AI analysis.");
  }
  const modelCandidates = buildGeminiModelCandidates(input.model);
  const systemPrompt = "You are a strict enterprise sales call analyst for Indian multilingual calls (Hindi/English/Gujarati mix). Return strict JSON only. All scores must be integers 0-100. sentiment: positive|neutral|negative. buyingIntent: high|medium|low. Do not hallucinate facts not present in transcript.";
  const userPrompt = [
    "Return JSON with exactly these keys:",
    "interestScore, pitchScore, confidenceScore, talkListenRatio, sentiment, buyingIntent, summary, keyPhrases, objections, improvements.",
    "Rules:",
    "- summary max 2 short sentences.",
    "- keyPhrases 3 to 8 short phrases.",
    "- objections real objections only, empty array if none.",
    "- improvements 2 to 6 concrete coaching tips.",
    "- If transcript contains speaker tags, use them to estimate talkListenRatio realistically.",
    "- Preserve customer intent from mixed-language context; do not over-penalize code-switching.",
    `Customer: ${input.customerName}`,
    `Salesperson: ${input.salespersonName}`,
    "Transcript:",
    transcript
  ].join("\n");
  let lastError = null;
  for (const model of modelCandidates) {
    try {
      let rawContent;
      try {
        rawContent = await requestWithRetry(
          () => requestGeminiCompletion({
            apiKey,
            model,
            systemPrompt,
            userPrompt,
            useJsonMode: true
          }),
          model
        );
      } catch (error) {
        const normalized = normalizeUnknownError(error, model);
        if (normalized.kind !== "bad_request") {
          throw normalized;
        }
        rawContent = await requestWithRetry(
          () => requestGeminiCompletion({
            apiKey,
            model,
            systemPrompt,
            userPrompt,
            useJsonMode: false
          }),
          model
        );
      }
      const parsed = JSON.parse(extractJson(rawContent));
      const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0 ? parsed.summary.trim() : buildFallbackSummary(transcript);
      return {
        interestScore: clampScore(parsed.interestScore),
        pitchScore: clampScore(parsed.pitchScore),
        confidenceScore: clampScore(parsed.confidenceScore),
        talkListenRatio: clampScore(parsed.talkListenRatio),
        sentiment: normalizeSentiment(parsed.sentiment),
        buyingIntent: normalizeBuyingIntent(parsed.buyingIntent),
        summary,
        keyPhrases: normalizeStringList(parsed.keyPhrases, [
          "Sales Discussion",
          "Customer Requirement",
          "Follow-up"
        ]),
        objections: normalizeStringList(parsed.objections, []),
        improvements: normalizeStringList(parsed.improvements, [
          "Add more discovery questions and confirm next steps clearly."
        ])
      };
    } catch (error) {
      const normalized = normalizeUnknownError(error, model);
      lastError = normalized;
      if (normalized.kind === "model_not_available" || normalized.kind === "rate_limited" || normalized.kind === "quota_exhausted" || /valid json/i.test(normalized.message)) {
        continue;
      }
      throw normalized;
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("No compatible AI model available.");
}

// server/routes.ts
var MAX_LOCATION_ACCURACY_METERS = 120;
var MAX_EVIDENCE_AGE_MS = 2 * 60 * 1e3;
var MAX_CAPTURE_DRIFT_MS = 2 * 60 * 1e3;
var MIN_LOCATION_SAMPLE_COUNT = 2;
var MAX_TRANSCRIBE_AUDIO_BYTES = 12 * 1024 * 1024;
var DEFAULT_AI_MODEL = (process.env.GEMINI_MODEL || process.env.EXPO_PUBLIC_GEMINI_MODEL || "gemini-2.5-flash").trim();
var DOLIBARR_ENV_ENDPOINT = (process.env.DOLIBARR_ENDPOINT || "").trim();
var DOLIBARR_ENV_API_KEY = (process.env.DOLIBARR_API_KEY || "").trim();
var REMOTE_STATE_ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "@trackforce_companies",
  "@trackforce_employees",
  "@trackforce_attendance",
  "@trackforce_salaries",
  "@trackforce_tasks",
  "@trackforce_expenses",
  "@trackforce_conversations",
  "@trackforce_audit_logs",
  "@trackforce_settings",
  "@trackforce_geofences",
  "@trackforce_teams",
  "@trackforce_attendance_photos",
  "@trackforce_attendance_anomalies",
  "@trackforce_location_logs",
  "@trackforce_dolibarr_sync_logs",
  "@trackforce_notifications",
  "@trackforce_support_threads"
]);
function firstString(value) {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : "";
  }
  return typeof value === "string" ? value : "";
}
function normalizeApiSecret2(value) {
  if (!value) return "";
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}
function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function isFreshDate(date, maxAgeMs) {
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= maxAgeMs;
}
function parseFiniteNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return null;
  }
  return value;
}
function normalizeBatteryLevel2(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  const scaled = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}
function parseOptionalInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!/^-?\d+$/.test(cleaned)) return null;
  return Number(cleaned);
}
function parseOptionalBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return void 0;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "true" || cleaned === "yes" || cleaned === "on") {
    return true;
  }
  if (cleaned === "0" || cleaned === "false" || cleaned === "no" || cleaned === "off") {
    return false;
  }
  return void 0;
}
function parseBooleanQuery(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "1" || cleaned === "true" || cleaned === "yes") return true;
  if (cleaned === "0" || cleaned === "false" || cleaned === "no") return false;
  return fallback;
}
function isIsoDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function maskApiKey(value) {
  if (!value) return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (cleaned.length <= 6) {
    return `${cleaned.slice(0, 1)}***${cleaned.slice(-1)}`;
  }
  return `${cleaned.slice(0, 4)}***${cleaned.slice(-3)}`;
}
async function resolveDolibarrConfigForUser(userId, overrides) {
  const stored = await storage.getDolibarrConfigForUser(userId);
  const latestStored = stored ? null : await storage.getLatestDolibarrConfig();
  const endpointValue = (overrides?.endpoint ?? stored?.endpoint ?? latestStored?.endpoint ?? DOLIBARR_ENV_ENDPOINT ?? "").trim();
  const apiKeyValue = (overrides?.apiKey ?? stored?.apiKey ?? latestStored?.apiKey ?? DOLIBARR_ENV_API_KEY ?? "").trim();
  const endpoint = endpointValue || null;
  const apiKey = apiKeyValue || null;
  const configured = Boolean(endpoint && apiKey);
  const enabled = overrides?.enabled ?? stored?.enabled ?? latestStored?.enabled ?? configured;
  return {
    enabled,
    endpoint,
    apiKey,
    configured,
    source: stored || latestStored ? "settings" : "env"
  };
}
function parseLocationSample(value) {
  if (!value || typeof value !== "object") return null;
  const body = value;
  const userId = firstString(body.userId);
  const latitude = parseFiniteNumber(body.latitude);
  const longitude = parseFiniteNumber(body.longitude);
  if (!userId || latitude === null || longitude === null) return null;
  const capturedAt = typeof body.capturedAt === "string" && parseIsoDate(body.capturedAt) ? body.capturedAt : null;
  return {
    userId,
    latitude,
    longitude,
    accuracy: parseFiniteNumber(body.accuracy),
    speed: parseFiniteNumber(body.speed),
    heading: parseFiniteNumber(body.heading),
    batteryLevel: normalizeBatteryLevel2(
      parseFiniteNumber(body.batteryLevel ?? body.batteryPercent ?? body.battery_percentage)
    ),
    capturedAt
  };
}
function parseCheckPayload(req) {
  const body = req.body;
  if (!body || !body.userId || !body.userName) return null;
  if (typeof body.latitude !== "number" || typeof body.longitude !== "number") return null;
  if (!body.deviceId || body.photoType !== "checkin" && body.photoType !== "checkout") return null;
  const locationAccuracyMeters = parseFiniteNumber(body.locationAccuracyMeters);
  const geofenceDistanceMeters = parseFiniteNumber(body.geofenceDistanceMeters);
  const faceCount = parseFiniteNumber(body.faceCount);
  const locationSampleCount = parseFiniteNumber(body.locationSampleCount);
  const locationSampleWindowMs = parseFiniteNumber(body.locationSampleWindowMs);
  const biometricRequired = Boolean(body.biometricRequired);
  const biometricVerified = Boolean(body.biometricVerified);
  const biometricType = typeof body.biometricType === "string" ? body.biometricType : null;
  const biometricFailureReason = typeof body.biometricFailureReason === "string" ? body.biometricFailureReason : null;
  return {
    userId: body.userId,
    userName: body.userName,
    latitude: body.latitude,
    longitude: body.longitude,
    geofenceId: body.geofenceId ?? null,
    geofenceName: body.geofenceName ?? null,
    photoBase64: body.photoBase64 ?? null,
    photoMimeType: body.photoMimeType ?? "image/jpeg",
    photoType: body.photoType,
    deviceId: body.deviceId,
    isInsideGeofence: Boolean(body.isInsideGeofence),
    notes: body.notes,
    mockLocationDetected: Boolean(body.mockLocationDetected),
    locationAccuracyMeters,
    capturedAtClient: typeof body.capturedAtClient === "string" ? body.capturedAtClient : void 0,
    photoCapturedAt: typeof body.photoCapturedAt === "string" ? body.photoCapturedAt : null,
    geofenceDistanceMeters,
    faceDetected: Boolean(body.faceDetected),
    faceCount,
    faceDetector: typeof body.faceDetector === "string" ? body.faceDetector : null,
    locationSampleCount,
    locationSampleWindowMs,
    biometricRequired,
    biometricVerified,
    biometricType,
    biometricFailureReason
  };
}
function ensureUserMatch(req, userId) {
  if (!req.auth) return false;
  return req.auth.sub === userId || ["admin", "hr", "manager"].includes(req.auth.role);
}
var authUsersByEmail = /* @__PURE__ */ new Map();
var accessRequestsById = /* @__PURE__ */ new Map();
var inMemoryStateStore = /* @__PURE__ */ new Map();
function normalizeEmail2(value) {
  return value.trim().toLowerCase();
}
function normalizeWhitespace(value) {
  return value.trim().replace(/\s+/g, " ");
}
function normalizeEmailKey(value) {
  return (value || "").trim().toLowerCase();
}
function hashPassword(password) {
  return createHash2("sha256").update(`trackforce::${password}`).digest("hex");
}
function normalizeRole(role) {
  if (role === "admin" || role === "hr" || role === "manager" || role === "salesperson") {
    return role;
  }
  return "salesperson";
}
function parseRequestStatus(value) {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }
  return null;
}
function normalizeCompanyIds(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  for (const entry of value) {
    const normalized = normalizeWhitespace(typeof entry === "string" ? entry : "");
    if (normalized) output.push(normalized);
  }
  return Array.from(new Set(output));
}
function resolveApprovalStatus(record) {
  if (record.approvalStatus === "pending" || record.approvalStatus === "approved" || record.approvalStatus === "rejected") {
    return record.approvalStatus;
  }
  if (record.user.approvalStatus === "pending" || record.user.approvalStatus === "approved" || record.user.approvalStatus === "rejected") {
    return record.user.approvalStatus;
  }
  return "approved";
}
function getLatestPendingAccessRequestByEmail(email) {
  const normalized = normalizeEmailKey(email);
  let latest = null;
  for (const request of accessRequestsById.values()) {
    if (request.status !== "pending") continue;
    if (normalizeEmailKey(request.email) !== normalized) continue;
    if (!latest || request.requestedAt > latest.requestedAt) {
      latest = request;
    }
  }
  return latest;
}
function isRemoteStateKeyAllowed(key) {
  return REMOTE_STATE_ALLOWED_KEYS.has(key);
}
async function readRemoteState(key) {
  if (isMySqlStateEnabled()) {
    try {
      return await getMySqlStateValue(key);
    } catch {
    }
  }
  return inMemoryStateStore.get(key) ?? null;
}
async function writeRemoteState(key, jsonValue) {
  if (isMySqlStateEnabled()) {
    await setMySqlStateValue(key, jsonValue);
  } else {
    inMemoryStateStore.set(key, jsonValue);
  }
}
function roleToDepartment(role) {
  if (role === "admin") return "Management";
  if (role === "hr") return "Human Resources";
  if (role === "manager") return "Operations";
  return "Sales";
}
function normalizeCompanyName(value) {
  const cleaned = normalizeWhitespace(value);
  return cleaned || DEFAULT_COMPANY_NAME;
}
function getCompanyIdFromName(companyName) {
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 42);
  return slug ? `cmp_${slug}` : DEFAULT_COMPANY_ID;
}
function initAuthUsersStore() {
  if (authUsersByEmail.size > 0) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const user of demoUsers) {
    const normalizedUser = {
      ...user,
      companyId: user.companyId || DEFAULT_COMPANY_ID,
      companyName: user.companyName || DEFAULT_COMPANY_NAME,
      email: normalizeEmail2(user.email),
      name: normalizeWhitespace(user.name),
      department: normalizeWhitespace(user.department),
      branch: normalizeWhitespace(user.branch)
    };
    const password = demoPasswords[normalizedUser.email] ?? "demo123";
    authUsersByEmail.set(normalizedUser.email, {
      user: normalizedUser,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved"
    });
  }
}
function createAuthToken(user) {
  return signJwt({
    sub: user.id,
    role: user.role,
    email: user.email
  });
}
function authenticateCredentials(email, password) {
  initAuthUsersStore();
  const record = authUsersByEmail.get(normalizeEmail2(email));
  if (!record) return null;
  if (record.passwordHash !== hashPassword(password)) return null;
  if (resolveApprovalStatus(record) !== "approved") return null;
  return {
    ...record.user,
    approvalStatus: "approved"
  };
}
function buildUserFromRegistration(payload) {
  const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const normalizedCompanyName = normalizeCompanyName(payload.companyName);
  return {
    id: randomUUID4(),
    name: normalizeWhitespace(payload.name),
    email: normalizeEmail2(payload.email),
    role: payload.role,
    companyId: getCompanyIdFromName(normalizedCompanyName),
    companyName: normalizedCompanyName,
    department: normalizeWhitespace(payload.department || roleToDepartment(payload.role)),
    branch: normalizeWhitespace(payload.branch || "Main Branch"),
    phone: normalizeWhitespace(payload.phone || "+91 00000 00000"),
    joinDate: now,
    approvalStatus: "approved"
  };
}
async function registerRoutes(app2) {
  initAuthUsersStore();
  app2.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      mysqlStateEnabled: isMySqlStateEnabled()
    });
  });
  app2.post("/api/ai/analyze", async (req, res) => {
    const body = req.body;
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const customerName = typeof body?.customerName === "string" ? body.customerName.trim() : "Customer";
    const salespersonName = typeof body?.salespersonName === "string" ? body.salespersonName.trim() : "Sales Rep";
    const requestedModel = typeof body?.model === "string" ? body.model.trim() : "";
    const model = requestedModel || DEFAULT_AI_MODEL;
    if (!transcript || transcript.length < 20) {
      res.status(400).json({ message: "Transcript is too short for AI analysis." });
      return;
    }
    const apiKey = normalizeApiSecret2(
      process.env.GEMINI_API_KEY || process.env.EXPO_PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API || process.env.EXPO_PUBLIC_GEMINI_API || process.env.gemini_API || process.env.gemini_APi
    );
    if (!apiKey) {
      res.status(500).json({ message: "AI key not configured on server." });
      return;
    }
    try {
      const result = await analyzeConversationWithAI({
        apiKey,
        model,
        transcript,
        customerName,
        salespersonName
      });
      res.json({
        provider: "ai",
        model,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI analysis failed.";
      const kind = typeof error?.kind === "string" ? String(error.kind) : "";
      const statusFromError = typeof error?.status === "number" ? Number(error.status) : 0;
      const status = statusFromError >= 400 ? statusFromError : kind === "invalid_api_key" ? 401 : kind === "quota_exhausted" || kind === "rate_limited" ? 429 : kind === "model_not_available" ? 404 : 500;
      res.status(status).json({
        message,
        kind: kind || "unknown"
      });
    }
  });
  app2.get("/api/settings/integrations/dolibarr", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const config = await resolveDolibarrConfigForUser(userId);
    res.json({
      enabled: config.enabled,
      endpoint: config.endpoint,
      apiKeyMasked: maskApiKey(config.apiKey),
      configured: config.configured,
      source: config.source
    });
  });
  app2.put("/api/settings/integrations/dolibarr", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body;
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ message: "enabled must be a boolean." });
      return;
    }
    const updated = await storage.setDolibarrConfigForUser(userId, {
      enabled: body.enabled,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : void 0,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : void 0
    });
    const resolved = await resolveDolibarrConfigForUser(userId, {
      enabled: updated.enabled,
      endpoint: updated.endpoint,
      apiKey: updated.apiKey
    });
    res.json({
      enabled: resolved.enabled,
      endpoint: resolved.endpoint,
      apiKeyMasked: maskApiKey(resolved.apiKey),
      configured: resolved.configured,
      source: "settings"
    });
  });
  app2.post("/api/settings/integrations/dolibarr/test", requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body;
    const config = await resolveDolibarrConfigForUser(userId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : void 0,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : void 0,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : void 0
    });
    if (!config.enabled) {
      res.json({
        ok: false,
        status: null,
        message: "Dolibarr sync is disabled in settings."
      });
      return;
    }
    if (!config.endpoint || !config.apiKey) {
      res.json({
        ok: false,
        status: null,
        message: "Dolibarr endpoint and API key are required."
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1e4);
    try {
      const response = await fetch(config.endpoint, {
        method: "GET",
        headers: {
          "X-Dolibarr-API-Key": config.apiKey
        },
        signal: controller.signal
      });
      if (response.ok) {
        res.json({
          ok: true,
          status: response.status,
          message: "Dolibarr endpoint reachable."
        });
        return;
      }
      res.json({
        ok: false,
        status: response.status,
        message: `Dolibarr endpoint responded with HTTP ${response.status}. Verify endpoint and API key.`
      });
    } catch (error) {
      res.json({
        ok: false,
        status: null,
        message: error instanceof Error ? error.message : "Unable to reach Dolibarr endpoint."
      });
    } finally {
      clearTimeout(timer);
    }
  });
  app2.post(
    "/api/integrations/dolibarr/hrm/sync-employee",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const requesterId = req.auth?.sub;
      if (!requesterId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }
      const body = req.body;
      const name = firstString(body.name);
      const email = firstString(body.email).toLowerCase();
      if (!name || !email) {
        res.status(400).json({ message: "name and email are required." });
        return;
      }
      const endpointOverride = typeof body.endpoint === "string" ? body.endpoint : body.endpoint === null ? null : void 0;
      const apiKeyOverride = typeof body.apiKey === "string" ? body.apiKey : body.apiKey === null ? null : void 0;
      const config = await resolveDolibarrConfigForUser(requesterId, {
        enabled: parseOptionalBoolean(body.enabled),
        endpoint: endpointOverride,
        apiKey: apiKeyOverride
      });
      try {
        const result = await syncApprovedUserToDolibarrEmployee(
          {
            name,
            email,
            role: firstString(body.role) || null,
            department: firstString(body.department) || null,
            branch: firstString(body.branch) || null,
            phone: firstString(body.phone) || null
          },
          {
            enabled: config.enabled,
            endpoint: config.endpoint,
            apiKey: config.apiKey
          }
        );
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected failure while syncing employee to Dolibarr.";
        res.json({
          ok: false,
          status: "failed",
          message,
          dolibarrUserId: null,
          endpointUsed: null
        });
      }
    }
  );
  app2.post(
    "/api/speech/transcribe",
    express.raw({ type: "*/*", limit: `${MAX_TRANSCRIBE_AUDIO_BYTES}b` }),
    async (req, res) => {
      const rawBody = req.body;
      const audioBuffer = Buffer.isBuffer(rawBody) ? rawBody : null;
      if (!audioBuffer || audioBuffer.length === 0) {
        res.status(400).json({ message: "Audio payload is required." });
        return;
      }
      if (audioBuffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
        res.status(413).json({ message: "Audio payload too large." });
        return;
      }
      const mimeTypeHeader = firstString(req.header("content-type"));
      const mimeType = mimeTypeHeader.split(";")[0]?.trim() || "audio/webm";
      const model = firstString(req.query.model) || null;
      const fallbackModel = firstString(req.query.fallback_model) || null;
      const provider = firstString(req.query.provider) || null;
      const mode = firstString(req.query.mode) || null;
      const languageCode = firstString(req.query.language_code) || null;
      const withDiarizationRaw = firstString(req.query.with_diarization) || null;
      const withTimestampsRaw = firstString(req.query.with_timestamps) || null;
      const numSpeakersRaw = firstString(req.query.num_speakers) || null;
      const withDiarization = withDiarizationRaw === null ? null : /^(1|true|yes|on)$/i.test(withDiarizationRaw.trim());
      const withTimestamps = withTimestampsRaw === null ? null : /^(1|true|yes|on)$/i.test(withTimestampsRaw.trim());
      const parsedNumSpeakers = numSpeakersRaw ? Number(numSpeakersRaw) : Number.NaN;
      const numSpeakers = Number.isFinite(parsedNumSpeakers) ? Math.max(1, Math.floor(parsedNumSpeakers)) : null;
      try {
        const result = await transcribeSpeechWithFairseqS2T({
          audio: audioBuffer,
          mimeType,
          model,
          fallbackModel,
          provider,
          mode,
          languageCode,
          withDiarization,
          withTimestamps,
          numSpeakers
        });
        res.json(result);
      } catch (error) {
        if (error instanceof Speech2TextError) {
          res.status(error.statusCode).json({ message: error.message });
          return;
        }
        const message = error instanceof Error ? error.message : "Speech transcription failed unexpectedly.";
        res.status(500).json({ message });
      }
    }
  );
  app2.post("/api/auth/register", (req, res) => {
    const {
      name,
      email,
      password,
      companyName,
      role,
      department,
      branch,
      phone
    } = req.body;
    if (!name || !email || !password || !companyName) {
      res.status(400).json({ message: "Name, email, password and company name are required" });
      return;
    }
    const normalizedEmail = normalizeEmail2(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ message: "Invalid email format" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }
    if (authUsersByEmail.has(normalizedEmail)) {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }
    if (normalizeRole(role) === "admin") {
      res.status(403).json({ message: "Admin signup is disabled. Contact an existing admin." });
      return;
    }
    const user = buildUserFromRegistration({
      name,
      email: normalizedEmail,
      companyName,
      role: normalizeRole(role),
      department,
      branch,
      phone
    });
    const now = (/* @__PURE__ */ new Date()).toISOString();
    authUsersByEmail.set(user.email, {
      user,
      passwordHash: hashPassword(password),
      createdAt: now,
      updatedAt: now,
      approvalStatus: "approved"
    });
    const token = createAuthToken(user);
    res.status(201).json({ token, user });
  });
  app2.post("/api/auth/access-request", (req, res) => {
    const {
      name,
      email,
      password,
      companyName,
      role,
      department,
      branch,
      phone
    } = req.body;
    if (!name || !email || !password || !companyName) {
      res.status(400).json({ message: "Name, email, password and company name are required" });
      return;
    }
    const normalizedEmail = normalizeEmail2(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      res.status(400).json({ message: "Invalid email format" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters" });
      return;
    }
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === "admin") {
      res.status(403).json({ message: "Admin signup is disabled. Contact an existing admin." });
      return;
    }
    const existingRecord = authUsersByEmail.get(normalizedEmail);
    const existingStatus = existingRecord ? resolveApprovalStatus(existingRecord) : null;
    if (existingRecord && existingStatus === "approved") {
      res.status(409).json({ message: "User already exists for this email" });
      return;
    }
    const existingPendingRequest = getLatestPendingAccessRequestByEmail(normalizedEmail);
    if (existingPendingRequest) {
      res.status(200).json({
        ok: true,
        alreadyPending: true,
        message: "Access request already pending admin approval.",
        request: existingPendingRequest
      });
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const pendingUser = {
      ...buildUserFromRegistration({
        name,
        email: normalizedEmail,
        companyName,
        role: normalizedRole,
        department,
        branch,
        phone
      }),
      approvalStatus: "pending"
    };
    authUsersByEmail.set(normalizedEmail, {
      user: pendingUser,
      passwordHash: hashPassword(password),
      createdAt: existingRecord?.createdAt || now,
      updatedAt: now,
      approvalStatus: "pending"
    });
    const pendingRequest = {
      id: randomUUID4(),
      name: pendingUser.name,
      email: pendingUser.email,
      requestedRole: pendingUser.role,
      approvedRole: null,
      requestedDepartment: pendingUser.department,
      requestedBranch: pendingUser.branch,
      requestedCompanyName: normalizeCompanyName(companyName),
      status: "pending",
      requestedAt: now,
      reviewedAt: null,
      reviewedById: null,
      reviewedByName: null,
      reviewComment: null,
      assignedCompanyIds: [],
      assignedManagerId: null,
      assignedManagerName: null
    };
    accessRequestsById.set(pendingRequest.id, pendingRequest);
    res.status(202).json({
      ok: true,
      message: "Signup request submitted. Wait for admin approval before signing in.",
      request: pendingRequest
    });
  });
  app2.get(
    "/api/admin/access-requests",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    (req, res) => {
      const parsedStatus = parseRequestStatus(firstString(req.query.status));
      if (firstString(req.query.status) && !parsedStatus) {
        res.status(400).json({ message: "Invalid access request status filter." });
        return;
      }
      const requests = Array.from(accessRequestsById.values()).filter((entry) => !parsedStatus || entry.status === parsedStatus).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
      res.json(requests);
    }
  );
  app2.post(
    "/api/admin/access-requests/:id/review",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    (req, res) => {
      const requestId = firstString(req.params.id);
      if (!requestId) {
        res.status(400).json({ message: "Access request id is required." });
        return;
      }
      const body = req.body;
      const action = body?.action;
      if (action !== "approved" && action !== "rejected") {
        res.status(400).json({ message: "Review action must be approved or rejected." });
        return;
      }
      const currentRequest = accessRequestsById.get(requestId);
      if (!currentRequest) {
        res.status(404).json({ message: "Access request not found." });
        return;
      }
      if (currentRequest.status !== "pending") {
        res.json(currentRequest);
        return;
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const approvedRole = action === "approved" ? normalizeRole(body?.role || currentRequest.requestedRole) : null;
      const finalRole = approvedRole || currentRequest.requestedRole;
      const assignedCompanyIds = action === "approved" ? normalizeCompanyIds(body?.companyIds) : [];
      const assignedManagerId = action === "approved" ? normalizeWhitespace(typeof body?.managerId === "string" ? body.managerId : "") || null : null;
      const assignedManagerName = action === "approved" ? normalizeWhitespace(typeof body?.managerName === "string" ? body.managerName : "") || null : null;
      const reviewComment = normalizeWhitespace(
        typeof body?.comment === "string" ? body.comment : ""
      );
      const normalizedEmail = normalizeEmail2(currentRequest.email);
      const authRecord = authUsersByEmail.get(normalizedEmail);
      if (!authRecord) {
        res.status(404).json({ message: "User account request is missing. Ask the user to sign up again." });
        return;
      }
      if (action === "approved") {
        const effectiveCompanyName = normalizeCompanyName(
          currentRequest.requestedCompanyName || authRecord.user.companyName || DEFAULT_COMPANY_NAME
        );
        const effectiveCompanyId = assignedCompanyIds[0] || authRecord.user.companyId || getCompanyIdFromName(effectiveCompanyName);
        const reviewedUser = {
          ...authRecord.user,
          role: finalRole,
          department: normalizeWhitespace(currentRequest.requestedDepartment) || roleToDepartment(finalRole),
          branch: normalizeWhitespace(currentRequest.requestedBranch) || authRecord.user.branch,
          companyId: effectiveCompanyId,
          companyName: effectiveCompanyName,
          companyIds: assignedCompanyIds.length ? assignedCompanyIds : [effectiveCompanyId],
          managerId: assignedManagerId || void 0,
          managerName: assignedManagerName || void 0,
          approvalStatus: "approved"
        };
        authUsersByEmail.set(normalizedEmail, {
          ...authRecord,
          user: reviewedUser,
          updatedAt: now,
          approvalStatus: "approved"
        });
      } else {
        authUsersByEmail.set(normalizedEmail, {
          ...authRecord,
          user: {
            ...authRecord.user,
            approvalStatus: "rejected"
          },
          updatedAt: now,
          approvalStatus: "rejected"
        });
      }
      const reviewedRequest = {
        ...currentRequest,
        approvedRole,
        status: action,
        reviewedAt: now,
        reviewedById: req.auth?.sub || null,
        reviewedByName: req.auth?.email || null,
        reviewComment: reviewComment || null,
        assignedCompanyIds,
        assignedManagerId,
        assignedManagerName
      };
      accessRequestsById.set(requestId, reviewedRequest);
      res.json(reviewedRequest);
    }
  );
  app2.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }
    const normalizedEmail = normalizeEmail2(email);
    const authRecord = authUsersByEmail.get(normalizedEmail);
    if (authRecord && authRecord.passwordHash === hashPassword(password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    }
    const user = authenticateCredentials(normalizedEmail, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    const token = createAuthToken(user);
    res.json({ token, user });
  });
  app2.post("/api/auth/token", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }
    const normalizedEmail = normalizeEmail2(email);
    const authRecord = authUsersByEmail.get(normalizedEmail);
    if (authRecord && authRecord.passwordHash === hashPassword(password)) {
      const status = resolveApprovalStatus(authRecord);
      if (status === "pending") {
        res.status(403).json({ message: "Your access request is pending admin approval." });
        return;
      }
      if (status === "rejected") {
        res.status(403).json({ message: "Your access request was rejected by admin." });
        return;
      }
    }
    const user = authenticateCredentials(normalizedEmail, password);
    if (!user) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }
    const token = createAuthToken(user);
    res.json({ token });
  });
  app2.get("/api/auth/me", requireAuth, (req, res) => {
    const email = req.auth?.email;
    if (!email) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const record = authUsersByEmail.get(normalizeEmail2(email));
    if (!record) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json({ user: record.user });
  });
  app2.get("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }
    try {
      const rawValue = await readRemoteState(key);
      if (!rawValue) {
        res.json({
          key,
          value: null,
          updatedAt: null,
          source: isMySqlStateEnabled() ? "mysql" : "memory"
        });
        return;
      }
      let parsedValue = null;
      try {
        parsedValue = JSON.parse(rawValue);
      } catch {
        parsedValue = null;
      }
      res.json({
        key,
        value: parsedValue,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read remote state value.";
      res.status(500).json({ message });
    }
  });
  app2.put("/api/state/:key", requireAuth, async (req, res) => {
    const key = decodeURIComponent(firstString(req.params.key) || "").trim();
    if (!key) {
      res.status(400).json({ message: "State key is required." });
      return;
    }
    if (!isRemoteStateKeyAllowed(key)) {
      res.status(403).json({ message: "State key is not allowed for remote sync." });
      return;
    }
    const body = req.body;
    if (!("value" in (body || {}))) {
      res.status(400).json({ message: "State value is required." });
      return;
    }
    try {
      const serialized = JSON.stringify(body.value ?? null);
      await writeRemoteState(key, serialized);
      res.json({
        ok: true,
        key,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        source: isMySqlStateEnabled() ? "mysql" : "memory"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to persist remote state value.";
      res.status(500).json({ message });
    }
  });
  app2.get("/api/geofences/user/:id", requireAuth, async (req, res) => {
    const userId = firstString(req.params.id);
    if (!userId) {
      res.status(400).json({ message: "User id is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user geofence data" });
      return;
    }
    const geofences = await storage.listGeofencesForUser(userId);
    res.json(geofences);
  });
  app2.post("/api/geofences", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const payload = req.body;
    if (!payload.name || typeof payload.latitude !== "number" || typeof payload.longitude !== "number") {
      res.status(400).json({ message: "Missing mandatory geofence fields" });
      return;
    }
    const created = await storage.createGeofence(payload);
    res.status(201).json(created);
  });
  app2.put("/api/geofences/:id", requireAuth, requireRoles("admin", "hr", "manager"), async (req, res) => {
    const geofenceId = firstString(req.params.id);
    if (!geofenceId) {
      res.status(400).json({ message: "Geofence id is required" });
      return;
    }
    const updated = await storage.updateGeofence(geofenceId, req.body);
    if (!updated) {
      res.status(404).json({ message: "Geofence not found" });
      return;
    }
    res.json(updated);
  });
  app2.post("/api/location/log", requireAuth, async (req, res) => {
    const sample = parseLocationSample(req.body);
    if (!sample) {
      res.status(400).json({ message: "Invalid location payload" });
      return;
    }
    if (!ensureUserMatch(req, sample.userId)) {
      res.status(403).json({ message: "Not authorized to post location" });
      return;
    }
    const zones = await storage.listGeofencesForUser(sample.userId);
    const status = resolveGeofenceStatus(
      {
        userId: sample.userId,
        userName: "",
        latitude: sample.latitude,
        longitude: sample.longitude,
        deviceId: "",
        photoType: "checkin",
        isInsideGeofence: false
      },
      zones
    );
    await storage.addLocationLog({
      id: randomUUID4(),
      userId: sample.userId,
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracy: sample.accuracy,
      speed: sample.speed,
      heading: sample.heading,
      batteryLevel: sample.batteryLevel ?? null,
      geofenceId: status.activeZone?.id ?? null,
      geofenceName: status.activeZone?.name ?? null,
      isInsideGeofence: status.inside,
      capturedAt: sample.capturedAt ?? (/* @__PURE__ */ new Date()).toISOString()
    });
    res.status(201).json({ ok: true, inside: status.inside, zone: status.activeZone?.name ?? null });
  });
  app2.post("/api/location/batch", requireAuth, async (req, res) => {
    const body = req.body;
    const candidateEntries = Array.isArray(body) ? body : Array.isArray(body.entries) ? body.entries : Array.isArray(body.points) ? body.points : Array.isArray(body.samples) ? body.samples : [];
    if (!candidateEntries.length) {
      res.status(400).json({ message: "Location batch payload is empty." });
      return;
    }
    const parsedEntries = candidateEntries.map((entry) => parseLocationSample(entry));
    const invalidCount = parsedEntries.filter((entry) => !entry).length;
    const validEntries = parsedEntries.filter(
      (entry) => Boolean(entry)
    );
    if (!validEntries.length) {
      res.status(400).json({ message: "No valid location points found in payload." });
      return;
    }
    const zoneCache = /* @__PURE__ */ new Map();
    let accepted = 0;
    for (const entry of validEntries) {
      if (!ensureUserMatch(req, entry.userId)) {
        res.status(403).json({ message: `Not authorized to post location for user ${entry.userId}` });
        return;
      }
      let zones = zoneCache.get(entry.userId);
      if (!zones) {
        zones = await storage.listGeofencesForUser(entry.userId);
        zoneCache.set(entry.userId, zones);
      }
      const status = resolveGeofenceStatus(
        {
          userId: entry.userId,
          userName: "",
          latitude: entry.latitude,
          longitude: entry.longitude,
          deviceId: "",
          photoType: "checkin",
          isInsideGeofence: false
        },
        zones
      );
      await storage.addLocationLog({
        id: randomUUID4(),
        userId: entry.userId,
        latitude: entry.latitude,
        longitude: entry.longitude,
        accuracy: entry.accuracy,
        speed: entry.speed,
        heading: entry.heading,
        batteryLevel: entry.batteryLevel ?? null,
        geofenceId: status.activeZone?.id ?? null,
        geofenceName: status.activeZone?.name ?? null,
        isInsideGeofence: status.inside,
        capturedAt: entry.capturedAt ?? (/* @__PURE__ */ new Date()).toISOString()
      });
      accepted += 1;
    }
    res.status(201).json({
      ok: true,
      accepted,
      rejected: invalidCount
    });
  });
  app2.get("/api/admin/live-map", requireAuth, requireRoles("admin", "hr", "manager"), async (_req, res) => {
    const latest = await storage.getLocationLogsLatest();
    res.json(latest);
  });
  app2.get(
    "/api/admin/route/:id/demo",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const userId = firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      const requestedDate = firstString(req.query.date) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const points = buildDemoRoutePoints(userId, requestedDate);
      const timeline = buildRouteTimeline(userId, requestedDate, points);
      const pointByTime = new Map(points.map((point) => [point.capturedAt, point]));
      const haltById = new Map(timeline.halts.map((halt) => [halt.id, halt]));
      const directions = await getMapplsDirectionsForLogs(points, {
        resource: firstString(req.query.routing_resource) || null,
        profile: firstString(req.query.routing_profile) || null,
        overview: firstString(req.query.routing_overview) || null,
        geometries: firstString(req.query.routing_geometries) || null,
        alternatives: parseBooleanQuery(req.query.routing_alternatives, false),
        steps: parseBooleanQuery(req.query.routing_steps, true),
        region: firstString(req.query.routing_region) || null,
        routeType: parseOptionalInteger(req.query.routing_rtype)
      });
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      const attendanceEvents = [
        {
          id: `demo_checkin_${userId}_${requestedDate}`,
          type: "checkin",
          at: firstPoint?.capturedAt ?? (/* @__PURE__ */ new Date(`${requestedDate}T09:00:00`)).toISOString(),
          geofenceName: firstPoint?.geofenceName ?? "Route Start",
          latitude: firstPoint?.latitude ?? null,
          longitude: firstPoint?.longitude ?? null
        },
        {
          id: `demo_checkout_${userId}_${requestedDate}`,
          type: "checkout",
          at: lastPoint?.capturedAt ?? (/* @__PURE__ */ new Date(`${requestedDate}T12:05:00`)).toISOString(),
          geofenceName: lastPoint?.geofenceName ?? "Route End",
          latitude: lastPoint?.latitude ?? null,
          longitude: lastPoint?.longitude ?? null
        }
      ];
      const demoTimelinePreview = timeline.segments.map((segment) => {
        if (segment.type === "halt") {
          const halt = segment.haltId ? haltById.get(segment.haltId) : null;
          return {
            id: segment.id,
            type: segment.type,
            startAt: segment.startAt,
            endAt: segment.endAt,
            durationMinutes: segment.durationMinutes,
            label: segment.fromLabel,
            battery: {
              start: halt?.startBatteryLevel ?? null,
              end: halt?.endBatteryLevel ?? null,
              average: halt?.averageBatteryLevel ?? null
            }
          };
        }
        const startPoint = pointByTime.get(segment.startAt);
        const endPoint = pointByTime.get(segment.endAt);
        return {
          id: segment.id,
          type: segment.type,
          startAt: segment.startAt,
          endAt: segment.endAt,
          durationMinutes: segment.durationMinutes,
          label: `${segment.fromLabel} -> ${segment.toLabel}`,
          battery: {
            start: startPoint?.batteryLevel ?? null,
            end: endPoint?.batteryLevel ?? null,
            average: null
          }
        };
      });
      const demoRoutePoints = points.map((point) => ({
        id: point.id,
        at: point.capturedAt,
        latitude: point.latitude,
        longitude: point.longitude,
        speed: point.speed ?? null,
        geofenceName: point.geofenceName ?? null,
        batteryLevel: point.batteryLevel ?? null
      }));
      res.json({
        ...timeline,
        directions,
        attendanceEvents,
        demoData: {
          routePoints: demoRoutePoints,
          timeline: demoTimelinePreview
        }
      });
    }
  );
  app2.get(
    "/api/admin/route/:id",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const userId = firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      const requestedDate = firstString(req.query.date) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const points = await storage.getLocationLogsForUserDate(userId, requestedDate);
      const timeline = buildRouteTimeline(userId, requestedDate, points);
      const directions = await getMapplsDirectionsForLogs(points, {
        resource: firstString(req.query.routing_resource) || null,
        profile: firstString(req.query.routing_profile) || null,
        overview: firstString(req.query.routing_overview) || null,
        geometries: firstString(req.query.routing_geometries) || null,
        alternatives: parseBooleanQuery(req.query.routing_alternatives, false),
        steps: parseBooleanQuery(req.query.routing_steps, true),
        region: firstString(req.query.routing_region) || null,
        routeType: parseOptionalInteger(req.query.routing_rtype)
      });
      const attendance = await storage.getAttendanceHistory(userId);
      const attendanceEvents = attendance.filter((record) => record.timestamp.startsWith(requestedDate)).map((record) => ({
        id: record.id,
        type: record.type,
        at: record.timestamp,
        geofenceName: record.geofenceName ?? null,
        latitude: record.location?.lat ?? null,
        longitude: record.location?.lng ?? null
      })).sort((a, b) => a.at.localeCompare(b.at));
      res.json({
        ...timeline,
        directions,
        attendanceEvents
      });
    }
  );
  app2.get(
    "/api/admin/route/:id/matrix",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      const userId = firstString(req.params.id);
      if (!userId) {
        res.status(400).json({ message: "User id is required" });
        return;
      }
      const requestedDate = firstString(req.query.date) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
      if (!isIsoDateString(requestedDate)) {
        res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
        return;
      }
      const useDemoData = parseBooleanQuery(req.query.demo, false);
      const points = useDemoData ? buildDemoRoutePoints(userId, requestedDate) : await storage.getLocationLogsForUserDate(userId, requestedDate);
      if (points.length < 2) {
        res.status(400).json({ message: "At least 2 route points are required for matrix" });
        return;
      }
      const matrix = await getMapplsDistanceMatrixForLogs(points, {
        resource: firstString(req.query.distance_resource) || null,
        profile: firstString(req.query.distance_profile) || null,
        region: firstString(req.query.distance_region) || null,
        routeType: parseOptionalInteger(req.query.distance_rtype)
      });
      if (!matrix) {
        res.status(400).json({
          message: "Mappls routing API key missing. Configure MAPPLS_ROUTING_API_KEY in server env."
        });
        return;
      }
      res.json({
        userId,
        date: requestedDate,
        matrix
      });
    }
  );
  app2.post("/api/attendance/checkin", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }
    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on check-in (${payload.biometricFailureReason ?? "unknown"})`
      });
      res.status(400).json({
        message: "Biometric verification is required for check-in."
      });
      return;
    }
    if (typeof payload.locationAccuracyMeters !== "number" || payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: typeof payload.locationAccuracyMeters === "number" ? `Weak GPS accuracy on check-in: +/-${Math.round(payload.locationAccuracyMeters)}m` : "Missing GPS accuracy evidence on check-in"
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }
    if (typeof payload.locationSampleCount !== "number" || payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on check-in (${payload.locationSampleCount ?? 0})`
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }
    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }
    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client"
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }
    const bindResult = await storage.bindDevice(payload.userId, payload.deviceId);
    if (!bindResult.ok) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "device_mismatch",
        severity: "high",
        details: "Device binding mismatch detected on check-in"
      });
      res.status(403).json({ message: "Device mismatch detected" });
      return;
    }
    const existing = await storage.findActiveAttendance(payload.userId);
    if (existing) {
      await recordAnomaly({
        attendanceId: existing.id,
        userId: payload.userId,
        type: "duplicate_checkin",
        severity: "medium",
        details: "Attempted duplicate check-in while already checked in"
      });
      res.status(409).json({ message: "User already checked in" });
      return;
    }
    const userZones = await storage.listGeofencesForUser(payload.userId);
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    const allowOverride = zoneStatus.activeZone?.allowOverride ?? false;
    const insideZone = zoneStatus.insideConfirmed;
    if (zoneStatus.inside && !zoneStatus.insideConfirmed && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "uncertain_geofence",
        severity: "medium",
        details: `Geofence boundary uncertainty on check-in. Distance ${Math.round(zoneStatus.distanceMeters)}m, buffer ${zoneStatus.confidenceBufferMeters}m`
      });
    }
    if (!insideZone && !allowOverride) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "outside_geofence",
        severity: "high",
        details: `Check-in attempted outside strict geofence. Distance: ${Math.round(zoneStatus.distanceMeters)}m, buffer: ${zoneStatus.confidenceBufferMeters}m`
      });
      res.status(400).json({ message: "Outside geofence. Check-in denied." });
      return;
    }
    const photoUrl = payload.photoBase64 ? await storeAttendancePhoto(
      payload.photoBase64,
      payload.photoMimeType ?? "image/jpeg",
      payload.userId,
      "checkin"
    ) : null;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const attendanceRecord = {
      id: randomUUID4(),
      userId: payload.userId,
      userName: payload.userName,
      type: "checkin",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: insideZone,
      notes: payload.notes,
      source: "mobile"
    };
    await storage.createAttendance(attendanceRecord);
    await storage.addLocationLog({
      id: randomUUID4(),
      userId: payload.userId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      accuracy: null,
      speed: null,
      heading: null,
      geofenceId: attendanceRecord.geofenceId ?? null,
      geofenceName: attendanceRecord.geofenceName ?? null,
      isInsideGeofence: attendanceRecord.isInsideGeofence ?? false,
      capturedAt: now
    });
    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID4(),
        attendanceId: attendanceRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: attendanceRecord.geofenceId ?? null,
        geofenceName: attendanceRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkin"
      });
    }
    const checkInDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(attendanceRecord, checkInDolibarrConfig);
    res.status(201).json(attendanceRecord);
  });
  app2.post("/api/attendance/checkout", requireAuth, async (req, res) => {
    const payload = parseCheckPayload(req);
    if (!payload) {
      res.status(400).json({ message: "Invalid attendance payload" });
      return;
    }
    if (!ensureUserMatch(req, payload.userId)) {
      res.status(403).json({ message: "Token user mismatch" });
      return;
    }
    if (payload.biometricRequired && !payload.biometricVerified) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "biometric_failed",
        severity: "high",
        details: `Biometric verification failed on checkout (${payload.biometricFailureReason ?? "unknown"})`
      });
      res.status(400).json({
        message: "Biometric verification is required for checkout."
      });
      return;
    }
    if (typeof payload.locationAccuracyMeters !== "number" || payload.locationAccuracyMeters > MAX_LOCATION_ACCURACY_METERS) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: typeof payload.locationAccuracyMeters === "number" ? `Weak GPS accuracy on checkout: +/-${Math.round(payload.locationAccuracyMeters)}m` : "Missing GPS accuracy evidence on checkout"
      });
      res.status(400).json({ message: "Location accuracy is weak. Move near open sky and try again." });
      return;
    }
    if (typeof payload.locationSampleCount !== "number" || payload.locationSampleCount < MIN_LOCATION_SAMPLE_COUNT) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "gps_weak",
        severity: "medium",
        details: `Insufficient stable location samples on checkout (${payload.locationSampleCount ?? 0})`
      });
      res.status(400).json({ message: "Stable GPS verification failed. Wait for lock and retry." });
      return;
    }
    const capturedAt = parseIsoDate(payload.capturedAtClient ?? null);
    if (!capturedAt) {
      res.status(400).json({ message: "Missing attendance evidence timestamp" });
      return;
    }
    if (!isFreshDate(capturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale attendance evidence. Please retry." });
      return;
    }
    const photoCapturedAt = parseIsoDate(payload.photoCapturedAt ?? null);
    if (photoCapturedAt && !isFreshDate(photoCapturedAt, MAX_EVIDENCE_AGE_MS)) {
      res.status(400).json({ message: "Stale photo evidence. Please recapture and retry." });
      return;
    }
    if (photoCapturedAt && Math.abs(photoCapturedAt.getTime() - capturedAt.getTime()) > MAX_CAPTURE_DRIFT_MS) {
      res.status(400).json({ message: "Location and photo timestamps are too far apart." });
      return;
    }
    if (payload.mockLocationDetected) {
      await recordAnomaly({
        attendanceId: null,
        userId: payload.userId,
        type: "mock_location",
        severity: "high",
        details: "Mock location flag raised from mobile client on checkout"
      });
      res.status(400).json({ message: "Mock location detected. Disable fake GPS and retry." });
      return;
    }
    const active = await storage.findActiveAttendance(payload.userId);
    if (!active) {
      res.status(400).json({ message: "No active check-in found for checkout" });
      return;
    }
    const userZones = await storage.listGeofencesForUser(payload.userId);
    const zoneStatus = resolveGeofenceStatus(payload, userZones);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (!zoneStatus.inside) {
      await recordAnomaly({
        attendanceId: active.id,
        userId: payload.userId,
        type: "checkout_outside_zone",
        severity: "medium",
        details: `Checkout performed outside zone at distance ${Math.round(zoneStatus.distanceMeters)}m`
      });
    }
    const photoUrl = payload.photoBase64 ? await storeAttendancePhoto(
      payload.photoBase64,
      payload.photoMimeType ?? "image/jpeg",
      payload.userId,
      "checkout"
    ) : null;
    const checkoutRecord = {
      id: randomUUID4(),
      userId: payload.userId,
      userName: payload.userName,
      type: "checkout",
      timestamp: now,
      timestampServer: now,
      location: { lat: payload.latitude, lng: payload.longitude },
      geofenceId: zoneStatus.activeZone?.id ?? payload.geofenceId ?? null,
      geofenceName: zoneStatus.activeZone?.name ?? payload.geofenceName ?? null,
      photoUrl,
      deviceId: payload.deviceId,
      isInsideGeofence: zoneStatus.inside,
      notes: payload.notes,
      source: "mobile"
    };
    await storage.createAttendance(checkoutRecord);
    if (photoUrl) {
      await storage.addAttendancePhoto({
        id: randomUUID4(),
        attendanceId: checkoutRecord.id,
        userId: payload.userId,
        photoUrl,
        capturedAt: now,
        latitude: payload.latitude,
        longitude: payload.longitude,
        geofenceId: checkoutRecord.geofenceId ?? null,
        geofenceName: checkoutRecord.geofenceName ?? null,
        metadataOverlay: payload.notes ?? "",
        photoType: "checkout"
      });
    }
    const checkOutDolibarrConfig = await resolveDolibarrConfigForUser(payload.userId);
    void syncAttendanceWithDolibarr(checkoutRecord, checkOutDolibarrConfig);
    res.status(201).json(checkoutRecord);
  });
  app2.get("/api/attendance/today", requireAuth, async (req, res) => {
    const userId = firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const records = await storage.getAttendanceToday(userId);
    res.json(records);
  });
  app2.get("/api/attendance/history", requireAuth, async (req, res) => {
    const userId = firstString(req.query.user_id);
    if (!userId) {
      res.status(400).json({ message: "user_id query is required" });
      return;
    }
    if (!ensureUserMatch(req, userId)) {
      res.status(403).json({ message: "Not authorized for this user records" });
      return;
    }
    const records = await storage.getAttendanceHistory(userId);
    res.json(records);
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/index.ts
import * as fs3 from "fs";
import * as path3 from "path";
var app = express2();
var log = console.log;
function setupCors(app2) {
  app2.use((req, res, next) => {
    const origins = /* @__PURE__ */ new Set();
    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }
    const origin = req.header("origin");
    const isLocalhost = origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:");
    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}
function setupBodyParsing(app2) {
  app2.use(
    express2.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express2.urlencoded({ extended: false }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path4 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path4.startsWith("/api")) return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path4} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path3.resolve(process.cwd(), "app.json");
    const appJsonContent = fs3.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, res) {
  const manifestPath = path3.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs3.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  const manifest = fs3.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}
function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);
  const html = landingPageTemplate.replace(/BASE_URL_PLACEHOLDER/g, baseUrl).replace(/EXPS_URL_PLACEHOLDER/g, expsUrl).replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
function configureExpoAndLanding(app2) {
  const templatePath = path3.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs3.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }
    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
    }
    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName
      });
    }
    next();
  });
  app2.use("/assets", express2.static(path3.resolve(process.cwd(), "assets")));
  app2.use(express2.static(path3.resolve(process.cwd(), "static-build/web")));
  app2.use(express2.static(path3.resolve(process.cwd(), "static-build")));
  app2.get(/^(?!\/api|\/assets).*/, (req, res, next) => {
    const webIndex = path3.resolve(process.cwd(), "static-build/web/index.html");
    if (fs3.existsSync(webIndex)) {
      return res.sendFile(webIndex);
    }
    next();
  });
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });
}
(async () => {
  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  configureExpoAndLanding(app);
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  const port = parseInt(process.env.PORT || "5000", 10);
  const hostCandidates = process.platform === "win32" ? ["0.0.0.0", "127.0.0.1"] : ["0.0.0.0"];
  const listenWithFallback = (hostIndex) => {
    const host = hostCandidates[hostIndex] || hostCandidates[0];
    const listenOptions = process.platform === "win32" ? {
      port,
      host
    } : {
      port,
      host,
      reusePort: true
    };
    const onError = (error) => {
      const canFallback = (error?.code === "ENOTSUP" || error?.code === "EADDRNOTAVAIL") && hostIndex < hostCandidates.length - 1;
      if (canFallback) {
        console.warn(
          `[server] listen failed on ${host}:${port} (${error.code}). Trying ${hostCandidates[hostIndex + 1]}...`
        );
        listenWithFallback(hostIndex + 1);
        return;
      }
      console.error(`[server] failed to listen on ${host}:${port}`, error);
      process.exit(1);
    };
    server.once("error", onError);
    server.listen(listenOptions, () => {
      server.off("error", onError);
      log(`express server serving on ${host}:${port}`);
    });
  };
  listenWithFallback(0);
})();
