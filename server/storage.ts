import { randomUUID } from "crypto";
import type {
  AttendanceAnomaly,
  AttendanceRecord,
  AttendancePhoto,
  DolibarrSyncLog,
  Geofence,
  LocationLog,
} from "@/lib/types";
import { isMumbaiDateKey, toMumbaiDateKey } from "@/lib/ist-time";
import { demoGeofences } from "@/lib/seedData";

export interface EmployeeSession {
  userId: string;
  userName: string;
  activeAttendanceId: string | null;
  deviceId?: string;
}

export interface DolibarrIntegrationConfig {
  userId: string;
  enabled: boolean;
  endpoint: string | null;
  apiKey: string | null;
  updatedAt: string;
}

export interface IStorage {
  listGeofences(): Promise<Geofence[]>;
  listGeofencesForUser(userId: string): Promise<Geofence[]>;
  createGeofence(payload: Partial<Geofence>): Promise<Geofence>;
  updateGeofence(id: string, payload: Partial<Geofence>): Promise<Geofence | null>;
  createAttendance(entry: AttendanceRecord): Promise<AttendanceRecord>;
  updateAttendance(id: string, patch: Partial<AttendanceRecord>): Promise<AttendanceRecord | null>;
  findActiveAttendance(userId: string): Promise<AttendanceRecord | null>;
  getAttendanceById(id: string): Promise<AttendanceRecord | null>;
  getAttendanceToday(userId: string): Promise<AttendanceRecord[]>;
  getAttendanceHistory(userId: string): Promise<AttendanceRecord[]>;
  addAttendancePhoto(photo: AttendancePhoto): Promise<void>;
  addAnomaly(anomaly: AttendanceAnomaly): Promise<void>;
  addLocationLog(log: LocationLog): Promise<void>;
  getLocationLogsForUserDate(userId: string, date: string): Promise<LocationLog[]>;
  getLocationLogsForDate(date: string): Promise<LocationLog[]>;
  getLocationLogsLatest(): Promise<LocationLog[]>;
  bindDevice(userId: string, deviceId: string): Promise<{ ok: boolean; mismatch: boolean }>;
  addDolibarrSyncLog(log: DolibarrSyncLog): Promise<void>;
  getDolibarrConfigForUser(userId: string): Promise<DolibarrIntegrationConfig | null>;
  getLatestDolibarrConfig(): Promise<DolibarrIntegrationConfig | null>;
  setDolibarrConfigForUser(
    userId: string,
    payload: {
      enabled: boolean;
      endpoint?: string | null;
      apiKey?: string | null;
    }
  ): Promise<DolibarrIntegrationConfig>;
}

class MemStorage implements IStorage {
  private geofences = new Map<string, Geofence>();
  private attendance = new Map<string, AttendanceRecord>();
  private attendancePhotos: AttendancePhoto[] = [];
  private anomalies: AttendanceAnomaly[] = [];
  private locationLogs: LocationLog[] = [];
  private deviceBindings = new Map<string, string>();
  private dolibarrSyncLogs: DolibarrSyncLog[] = [];
  private dolibarrConfigByUser = new Map<string, DolibarrIntegrationConfig>();

  constructor() {
    for (const zone of demoGeofences) {
      this.geofences.set(zone.id, zone);
    }
  }

  async listGeofences(): Promise<Geofence[]> {
    return Array.from(this.geofences.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listGeofencesForUser(userId: string): Promise<Geofence[]> {
    const all = await this.listGeofences();
    return all.filter((zone) => zone.isActive && zone.assignedEmployeeIds.includes(userId));
  }

  async createGeofence(payload: Partial<Geofence>): Promise<Geofence> {
    const now = new Date().toISOString();
    const geofence: Geofence = {
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
      updatedAt: now,
    };
    this.geofences.set(geofence.id, geofence);
    return geofence;
  }

  async updateGeofence(id: string, payload: Partial<Geofence>): Promise<Geofence | null> {
    const current = this.geofences.get(id);
    if (!current) return null;
    const updated: Geofence = {
      ...current,
      ...payload,
      id,
      updatedAt: new Date().toISOString(),
    };
    this.geofences.set(id, updated);
    return updated;
  }

  async createAttendance(entry: AttendanceRecord): Promise<AttendanceRecord> {
    this.attendance.set(entry.id, entry);
    return entry;
  }

  async updateAttendance(id: string, patch: Partial<AttendanceRecord>): Promise<AttendanceRecord | null> {
    const current = this.attendance.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.attendance.set(id, updated);
    return updated;
  }

  async findActiveAttendance(userId: string): Promise<AttendanceRecord | null> {
    const sorted = Array.from(this.attendance.values())
      .filter((item) => item.userId === userId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latestCheckIn = sorted.find((item) => item.type === "checkin");
    if (!latestCheckIn) return null;
    const hasCheckoutAfter = sorted.some(
      (item) => item.type === "checkout" && item.timestamp >= latestCheckIn.timestamp
    );
    return hasCheckoutAfter ? null : latestCheckIn;
  }

  async getAttendanceById(id: string): Promise<AttendanceRecord | null> {
    return this.attendance.get(id) ?? null;
  }

  async getAttendanceToday(userId: string): Promise<AttendanceRecord[]> {
    const day = toMumbaiDateKey(new Date());
    return Array.from(this.attendance.values())
      .filter((record) => record.userId === userId && isMumbaiDateKey(record.timestamp, day))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async getAttendanceHistory(userId: string): Promise<AttendanceRecord[]> {
    return Array.from(this.attendance.values())
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async addAttendancePhoto(photo: AttendancePhoto): Promise<void> {
    this.attendancePhotos.unshift(photo);
    this.attendancePhotos = this.attendancePhotos.slice(0, 5000);
  }

  async addAnomaly(anomaly: AttendanceAnomaly): Promise<void> {
    this.anomalies.unshift(anomaly);
    this.anomalies = this.anomalies.slice(0, 5000);
  }

  private hasDuplicateLocationLog(next: LocationLog): boolean {
    return this.locationLogs.some((existing) => {
      if (existing.userId !== next.userId) return false;
      if (existing.capturedAt !== next.capturedAt) return false;
      const latDelta = Math.abs(existing.latitude - next.latitude);
      const lngDelta = Math.abs(existing.longitude - next.longitude);
      return latDelta <= 0.000001 && lngDelta <= 0.000001;
    });
  }

  async addLocationLog(log: LocationLog): Promise<void> {
    if (this.hasDuplicateLocationLog(log)) return;
    this.locationLogs.unshift(log);
    this.locationLogs = this.locationLogs.slice(0, 10000);
  }

  async getLocationLogsForUserDate(userId: string, date: string): Promise<LocationLog[]> {
    return this.locationLogs
      .filter((log) => log.userId === userId && isMumbaiDateKey(log.capturedAt, date))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async getLocationLogsForDate(date: string): Promise<LocationLog[]> {
    return this.locationLogs
      .filter((log) => isMumbaiDateKey(log.capturedAt, date))
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  async getLocationLogsLatest(): Promise<LocationLog[]> {
    const latestByUser = new Map<string, LocationLog>();
    for (const log of this.locationLogs) {
      if (!latestByUser.has(log.userId)) {
        latestByUser.set(log.userId, log);
      }
    }
    return Array.from(latestByUser.values());
  }

  async bindDevice(userId: string, deviceId: string): Promise<{ ok: boolean; mismatch: boolean }> {
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

  async addDolibarrSyncLog(log: DolibarrSyncLog): Promise<void> {
    this.dolibarrSyncLogs.unshift(log);
    this.dolibarrSyncLogs = this.dolibarrSyncLogs.slice(0, 5000);
  }

  async getDolibarrConfigForUser(userId: string): Promise<DolibarrIntegrationConfig | null> {
    return this.dolibarrConfigByUser.get(userId) ?? null;
  }

  async getLatestDolibarrConfig(): Promise<DolibarrIntegrationConfig | null> {
    let latest: DolibarrIntegrationConfig | null = null;
    for (const config of this.dolibarrConfigByUser.values()) {
      if (!latest || config.updatedAt > latest.updatedAt) {
        latest = config;
      }
    }
    return latest;
  }

  async setDolibarrConfigForUser(
    userId: string,
    payload: {
      enabled: boolean;
      endpoint?: string | null;
      apiKey?: string | null;
    }
  ): Promise<DolibarrIntegrationConfig> {
    const current = this.dolibarrConfigByUser.get(userId);
    const endpoint = typeof payload.endpoint === "string" ? payload.endpoint.trim() : "";
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";

    const next: DolibarrIntegrationConfig = {
      userId,
      enabled: Boolean(payload.enabled),
      endpoint: endpoint || current?.endpoint || null,
      apiKey: apiKey || current?.apiKey || null,
      updatedAt: new Date().toISOString(),
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
}

export const storage: IStorage = new MemStorage();
