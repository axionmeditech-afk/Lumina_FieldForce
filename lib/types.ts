export type UserRole = "admin" | "hr" | "manager" | "salesperson" | "employee";

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

export interface SalaryRecord {
  id: string;
  companyId?: string;
  employeeId: string;
  employeeName: string;
  employeeEmail?: string;
  label?: string;
  periodStart?: string;
  periodEnd?: string;
  paymentDate?: string;
  paymentMode?: string;
  bankAccount?: string;
  note?: string;
  month: string;
  basic: number;
  hra: number;
  transport: number;
  medical: number;
  bonus: number;
  overtime: number;
  tax: number;
  pf: number;
  insurance: number;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  status: "pending" | "approved" | "paid";
}

export interface Task {
  id: string;
  companyId?: string;
  title: string;
  description: string;
  taskType?: "general" | "field_visit";
  assignedTo: string;
  assignedToName: string;
  assignedBy: string;
  teamId?: string | null;
  teamName?: string | null;
  status: "pending" | "in_progress" | "completed";
  priority: "low" | "medium" | "high";
  dueDate: string;
  createdAt: string;
  visitPlanDate?: string | null;
  visitSequence?: number | null;
  visitLatitude?: number | null;
  visitLongitude?: number | null;
  visitLocationLabel?: string | null;
  visitLocationAddress?: string | null;
  arrivalAt?: string | null;
  meetingNotes?: string | null;
  meetingNotesUpdatedAt?: string | null;
  departureAt?: string | null;
  visitDepartureNotes?: string | null;
  visitDepartureNotesUpdatedAt?: string | null;
  autoCaptureRecordingActive?: boolean;
  autoCaptureRecordingStartedAt?: string | null;
  autoCaptureRecordingStoppedAt?: string | null;
  autoCaptureConversationId?: string | null;
}

export interface VisitHistoryRecord {
  id: string;
  companyId?: string | null;
  taskId: string;
  salespersonId: string;
  salespersonName: string;
  visitLabel: string;
  visitLocationAddress?: string | null;
  visitLatitude: number;
  visitLongitude: number;
  arrivalAt?: string | null;
  departureAt?: string | null;
  meetingNotes?: string | null;
  visitDepartureNotes?: string | null;
  autoCaptureConversationId?: string | null;
  status?: "pending" | "in_progress" | "completed" | null;
  updatedAt: string;
  distanceMeters?: number | null;
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

export interface Expense {
  id: string;
  companyId?: string;
  userId: string;
  userName: string;
  category: string;
  amount: number;
  description: string;
  status: "pending" | "approved" | "rejected";
  date: string;
  receipt?: string;
}

export interface StockistProfile {
  id: string;
  companyId?: string;
  name: string;
  phone?: string;
  location?: string;
  pincode?: string;
  notes?: string;
  assignedSalespersonIds?: string[];
  stockIn?: number;
  stockOut?: number;
  stockBalance?: number;
  lastStockUpdate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StockTransfer {
  id: string;
  companyId?: string;
  stockistId: string;
  stockistName: string;
  type: "in" | "out";
  itemName: string;
  itemId?: string;
  quantity: number;
  unitLabel?: string;
  salespersonId?: string;
  salespersonName?: string;
  note?: string;
  createdAt: string;
}

export type IncentivePeriod = "daily" | "weekly" | "monthly";

export interface IncentiveGoalPlan {
  id: string;
  companyId?: string;
  title: string;
  period: IncentivePeriod;
  targetQty: number;
  thresholdPercent: number;
  perUnitAmount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IncentiveProductPlan {
  id: string;
  companyId?: string;
  productId?: string;
  productName: string;
  perUnitAmount: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IncentivePayout {
  id: string;
  companyId?: string;
  salespersonId: string;
  salespersonName: string;
  rangeKey: IncentivePeriod;
  rangeStart: string;
  rangeEnd: string;
  goalAmount: number;
  productAmount: number;
  totalAmount: number;
  createdAt: string;
  createdById?: string;
  createdByName?: string;
  status: "pending" | "paid";
  note?: string;
}

export interface Conversation {
  id: string;
  companyId?: string;
  salespersonId: string;
  salespersonName: string;
  customerName: string;
  date: string;
  duration: string;
  transcript?: string;
  transcriptStatus?: "pending" | "completed" | "failed";
  audioUri?: string | null;
  transcriptionError?: string | null;
  source?: "seed" | "recorded" | "imported";
  analysisProvider?: "seed" | "rules" | "ai";
  interestScore: number;
  pitchScore: number;
  confidenceScore: number;
  talkListenRatio: number;
  sentiment: "positive" | "neutral" | "negative";
  buyingIntent: "high" | "medium" | "low";
  objections: string[];
  improvements: string[];
  summary: string;
  notes?: string;
  keyPhrases: string[];
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
}

export interface SupportMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: UserRole;
  message: string;
  createdAt: string;
}

export interface SupportThread {
  id: string;
  companyId?: string;
  subject: string;
  requestedById: string;
  requestedByName: string;
  requestedByRole: UserRole;
  status: "open" | "closed";
  priority: "normal" | "high";
  createdAt: string;
  updatedAt: string;
  messages: SupportMessage[];
}

export interface BranchInfo {
  id: string;
  name: string;
  address: string;
  employeeCount: number;
}

export interface Geofence {
  id: string;
  companyId?: string;
  name: string;
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
    | "face_validation_failed"
    | "biometric_failed"
    | "checkout_outside_zone"
    | "camera_missing"
    | "offline_backfill";
  severity: "low" | "medium" | "high";
  details: string;
  createdAt: string;
}

export interface LocationLog {
  id: string;
  companyId?: string;
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  batteryLevel?: number | null;
  geofenceId?: string | null;
  geofenceName?: string | null;
  isInsideGeofence: boolean;
  capturedAt: string;
}

export interface QuickSaleLocationLog {
  id: string;
  companyId?: string;
  salespersonId: string;
  salespersonName: string;
  visitTaskId?: string | null;
  visitLabel?: string | null;
  visitDepartureNotes?: string | null;
  visitDepartedAt?: string | null;
  customerId: string;
  customerName: string;
  customerEmail?: string | null;
  customerAddress?: string | null;
  orderId: string;
  itemCount: number;
  totalAmount: number;
  latitude: number;
  longitude: number;
  capturedAt: string;
}

export interface RouteHalt {
  id: string;
  userId: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  latitude: number;
  longitude: number;
  pointCount: number;
  label: string;
  startBatteryLevel?: number | null;
  endBatteryLevel?: number | null;
  averageBatteryLevel?: number | null;
}

export interface RouteSegment {
  id: string;
  type: "moving" | "halt";
  startAt: string;
  endAt: string;
  durationMinutes: number;
  distanceMeters: number;
  avgSpeedKph: number | null;
  fromLabel: string;
  toLabel: string;
  haltId?: string;
}

export interface RouteTimelineSummary {
  totalDistanceKm: number;
  totalMovingMinutes: number;
  totalHaltMinutes: number;
  haltCount: number;
  pointCount: number;
}

export interface RoutePathPoint {
  latitude: number;
  longitude: number;
}

export interface RouteDirections {
  provider: "mappls";
  enabled: boolean;
  path: RoutePathPoint[];
  profile: string;
  resource: string;
  geometries: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  routeId: string | null;
  sampledPointCount: number;
  rawPointCount: number;
  error: string | null;
}

export interface RouteDistanceMatrix {
  provider: "mappls";
  enabled: boolean;
  profile: string;
  resource: string;
  rawPointCount: number;
  sampledPointCount: number;
  coordinates: string[];
  durations: number[][];
  distances: number[][];
  error: string | null;
}

export interface RouteTimeline {
  userId: string;
  date: string;
  points: LocationLog[];
  halts: RouteHalt[];
  segments: RouteSegment[];
  summary: RouteTimelineSummary;
  directions?: RouteDirections | null;
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

export interface DashboardStats {
  totalEmployees: number;
  presentToday: number;
  lateToday: number;
  onLeave: number;
  activeNow: number;
  idleNow: number;
  offlineNow: number;
  pendingTasks: number;
  pendingExpenses: number;
  totalConversations: number;
  avgInterestScore: number;
}

export interface BankAccount {
  id: string;
  employeeId?: string;
  employeeName: string;
  employeeEmail: string;
  accountType: "bank" | "upi";
  dolibarrRef?: string;
  dolibarrLabel?: string;
  dolibarrType?: "savings" | "current" | "cash";
  currencyCode?: string;
  countryCode?: string;
  countryId?: number;
  status?: "open" | "closed";
  bankName?: string;
  bankAddress?: string;
  accountNumber?: string;
  ifscCode?: string;
  upiId?: string;
  holderName?: string;
  website?: string;
  comment?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
