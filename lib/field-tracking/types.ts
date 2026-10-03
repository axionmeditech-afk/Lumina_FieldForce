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
  source: 'self-hosted-valhalla' | 'unavailable';
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
  status: 'live' | 'delayed' | 'stale' | 'offline';
  sessionStatus: 'active' | 'completed';
  offRoute: boolean;
};

