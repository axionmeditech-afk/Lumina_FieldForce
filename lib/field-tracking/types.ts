export type Coordinate = { latitude: number; longitude: number };

export type RoutePoint = {
  pointId: string;
  sessionId: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
  mocked: boolean;
  capturedAt: string;
  syncedAt: string | null;
  routeEligible: boolean;
  rejectionReason: string | null;
};

export type TrackingSession = {
  id: string;
  employeeId: string;
  companyId: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'completed';
};

export type TrackerState = 'stopped' | 'starting' | 'tracking' | 'offline' | 'degraded' | 'stopping';

export type TrackerSnapshot = {
  state: TrackerState;
  session: TrackingSession | null;
  points: RoutePoint[];
  pendingCount: number;
  distanceMetres: number;
  lastCapturedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  precisePermission: boolean;
  backgroundPermission: boolean;
  locationServicesEnabled: boolean;
  backgroundCapable: boolean;
  networkConnected: boolean;
  serverReachable: boolean;
  routerReachable: boolean;
  geocoderReachable: boolean;
};

export type PlaceSearchResult = Coordinate & {
  placeId: string;
  name: string;
  address: string;
  primaryType: string | null;
};

export type NavigationManeuver = {
  type: number;
  instruction: string;
  verbalInstruction: string | null;
  streetNames: string[];
  distanceMeters: number;
  durationSeconds: number;
  beginShapeIndex: number;
  endShapeIndex: number;
};

export type RoutePlan = {
  source: 'stadia-valhalla' | 'self-hosted-valhalla' | 'unavailable';
  distanceMetres: number | null;
  durationSeconds: number | null;
  coordinates: Coordinate[];
  maneuvers: NavigationManeuver[];
};

export type HaltRecord = {
  id: string;
  latitude: number;
  longitude: number;
  status: 'ongoing' | 'completed';
  startedAt?: string;
  endedAt?: string | null;
  durationSeconds?: number;
  label?: string | null;
};

export type LiveConnectionState = 'connecting' | 'waiting' | 'live' | 'recovering' | 'offline';

export type LiveEmployee = {
  employeeId: string;
  sessionId: string;
  name: string;
  initials: string;
  roleLabel: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
  capturedAt: string;
  status: 'live' | 'delayed' | 'stale' | 'waiting' | 'offline';
  sessionStatus: 'active' | 'waiting' | 'completed';
  attendanceActive: boolean;
  trackingActive: boolean;
  offRoute: boolean;
};

export type FieldSessionKpis = {
  sessionId: string;
  employeeId: string;
  sessionStartedAt: string;
  shiftSeconds: number;
  movingSeconds: number;
  haltSeconds: number;
  haltCount: number;
  activeHalt: boolean;
  distanceMetres: number;
  averageMovingSpeedKmh: number | null;
  totalPoints: number;
  acceptedPoints: number;
  gpsAccuracyMetres: number | null;
  lastCapturedAt: string | null;
  lastPointAgeSeconds: number | null;
  visitTotal: number;
  visitCompleted: number;
  nextVisit: {
    name: string;
    address: string;
    distanceMetres: number | null;
    status: 'en_route' | 'arrived';
  } | null;
  activity: {
    id: string;
    type: 'movement' | 'halt';
    startedAt: string;
    endedAt: string | null;
    distanceMetres: number;
    start: Coordinate;
    end: Coordinate;
    active: boolean;
  }[];
};

export type FieldTrackingDaySummary = {
  date: string;
  sessionCount: number;
  shiftSeconds: number;
  movingSeconds: number;
  haltSeconds: number;
  haltCount: number;
  distanceMetres: number;
  visitTotal: number;
  visitCompleted: number;
  acceptedPoints: number;
  lastCapturedAt: string | null;
};

export type FieldTrackingCalendar = {
  employeeId: string;
  month: string;
  timezoneOffsetMinutes: number;
  days: FieldTrackingDaySummary[];
};

export type FieldTrackingDaily = {
  date: string;
  points: RoutePoint[];
  kpis: FieldSessionKpis;
};

