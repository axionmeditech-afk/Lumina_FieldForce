import type { LocationLog } from "@/lib/types";

interface RoutePointInput {
  time: string;
  latitude: number;
  longitude: number;
  speed: number;
  geofenceName: string | null;
  isInsideGeofence?: boolean;
  batteryLevel?: number | null;
}

function makeIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

const AMIT_PATEL_IDS = new Set(["e3", "u3"]);

function buildDefaultRoutePoints(): RoutePointInput[] {
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
    { time: "12:00", latitude: 23.0261, longitude: 72.5722, speed: 4.2, geofenceName: "Main Office", isInsideGeofence: true, batteryLevel: 59 },
  ];
}

function buildAmitPatelAhmedabadRoutePoints(): RoutePointInput[] {
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
    { time: "11:35", latitude: 23.0399, longitude: 72.5568, speed: 0, geofenceName: "Navrangpura", isInsideGeofence: true, batteryLevel: 67 },
  ];
}

export function buildDemoRoutePoints(userId: string, date: string): LocationLog[] {
  const points = AMIT_PATEL_IDS.has(userId)
    ? buildAmitPatelAhmedabadRoutePoints()
    : buildDefaultRoutePoints();

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
    batteryLevel:
      typeof point.batteryLevel === "number"
        ? point.batteryLevel
        : Math.max(22, 86 - Math.round(index * 2.1)),
    capturedAt: makeIso(date, point.time),
  }));
}
