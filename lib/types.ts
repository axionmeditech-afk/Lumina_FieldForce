export type UserRole = "admin" | "hr" | "manager" | "salesperson" | "employee";
export type EmployeeCategory = "on_field" | "fixed_location";

export interface AppUser {
  id: string;
  name: string;
  email: string;
  login?: string;
  role: UserRole;
  companyId: string;
  companyName: string;
  companyIds?: string[];
  department: string;
  branch: string;
  phone: string;
  pincode?: string;
  joinDate: string;
  avatar?: string;
  managerId?: string;
  managerName?: string;
  stockistId?: string;
  stockistName?: string;
  approvalStatus?: "pending" | "approved" | "rejected";
}

export interface UserAccessRequest {
  id: string;
  name: string;
  email: string;
  requestedRole: UserRole;
  approvedRole?: UserRole | null;
  requestedDepartment: string;
  requestedBranch: string;
  requestedPincode?: string;
  requestedCompanyName?: string;
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  reviewedAt?: string | null;
  reviewedById?: string | null;
  reviewedByName?: string | null;
  reviewComment?: string | null;
  assignedCompanyIds?: string[];
  assignedManagerId?: string | null;
  assignedManagerName?: string | null;
  assignedStockistId?: string | null;
  assignedStockistName?: string | null;
}

export interface CompanyProfile {
  id: string;
  name: string;
  legalName: string;
  industry: string;
  headquarters: string;
  primaryBranch: string;
  supportEmail: string;
  supportPhone: string;
  attendanceZoneLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  companyId?: string;
  type: "checkin" | "checkout";
  timestamp: string;
  location?: { lat: number; lng: number };
  geofenceId?: string | null;
  geofenceName?: string | null;
  photoUrl?: string | null;
  deviceId?: string | null;
  timestampServer?: string | null;
  isInsideGeofence?: boolean;
  source?: "mobile" | "manual" | "synced";
  notes?: string;
  photo?: string;
  approvalStatus?: "pending" | "approved" | "rejected";
  approvalReviewedById?: string | null;
  approvalReviewedByName?: string | null;
  approvalReviewedAt?: string | null;
  approvalComment?: string | null;
}

export interface Employee {
  id: string;
  companyId: string;
  name: string;
  role: UserRole;
  employeeCategory?: EmployeeCategory;
  department: string;
  status: "active" | "idle" | "offline";
  email: string;
  phone: string;
  branch: string;
  pincode?: string;
  joinDate: string;
  avatar?: string;
  managerId?: string;
  managerName?: string;
  stockistId?: string;
  stockistName?: string;
}

export interface Team {
  id: string;
  companyId?: string;
  name: string;
  ownerId: string;
  ownerName: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  companyId?: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
  timestamp: string;
  module: string;
}

export type NotificationAudience = "all" | UserRole;

export interface AppNotification {
  id: string;
  companyId?: string;
  title: string;
  body: string;
  kind: "announcement" | "policy" | "alert" | "support";
  audience: NotificationAudience;
  createdById: string;
  createdByName: string;
  createdAt: string;
  readByIds?: string[];
  audienceUserIds?: string[];
}

export interface Geofence {
  id: string;
  companyId?: string;
  name: string;
  locationLabel?: string | null;
  locationAddress?: string | null;
  radiusMeters: number;
  latitude: number;
  longitude: number;
  assignedEmployeeIds: string[];
  isActive: boolean;
  allowOverride: boolean;
  workingHoursStart?: string | null;
  workingHoursEnd?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeofenceEvaluation {
  inside: boolean;
  insideConfirmed?: boolean;
  activeZone: Geofence | null;
  nearestDistanceMeters: number;
  confidenceBufferMeters?: number;
  distanceFromBoundaryMeters?: number;
  signalWeak: boolean;
  warning?: string;
}

export interface AttendancePhoto {
  id: string;
  companyId?: string;
  attendanceId: string;
  userId: string;
  photoUrl: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  geofenceId?: string | null;
  geofenceName?: string | null;
  metadataOverlay: string;
  photoType: "checkin" | "checkout";
}

export interface AttendanceAnomaly {
  id: string;
  companyId?: string;
  userId: string;
  attendanceId?: string | null;
  type:
    | "outside_geofence"
    | "uncertain_geofence"
    | "mock_location"
    | "device_mismatch"
    | "duplicate_checkin"
    | "gps_weak"
    | "gps_disabled"
    | "gps_restored"
    | "face_validation_failed"
    | "biometric_failed"
    | "checkout_outside_zone"
    | "camera_missing"
    | "offline_backfill";
  severity: "low" | "medium" | "high";
  details: string;
  createdAt: string;
}


export interface DolibarrSyncLog {
  id: string;
  companyId?: string;
  attendanceId: string;
  userId: string;
  attempt: number;
  status: "pending" | "synced" | "failed";
  message: string;
  createdAt: string;
  syncedAt?: string | null;
}

export interface AttendanceCheckPayload {
  requestId?: string;
  actionSource?: "manual" | "geofence_exit";
  activeAttendanceId?: string;
  userId: string;
  userName: string;
  latitude: number;
  longitude: number;
  geofenceId?: string | null;
  geofenceName?: string | null;
  photoBase64?: string | null;
  photoMimeType?: string | null;
  photoType: "checkin" | "checkout";
  deviceId: string;
  isInsideGeofence: boolean;
  notes?: string;
  mockLocationDetected?: boolean;
  locationAccuracyMeters?: number | null;
  capturedAtClient?: string;
  photoCapturedAt?: string | null;
  geofenceDistanceMeters?: number | null;
  faceDetected?: boolean;
  faceCount?: number | null;
  faceDetector?: string | null;
  locationSampleCount?: number | null;
  locationSampleWindowMs?: number | null;
  biometricRequired?: boolean;
  biometricVerified?: boolean;
  biometricType?: string | null;
  biometricFailureReason?: string | null;
}
