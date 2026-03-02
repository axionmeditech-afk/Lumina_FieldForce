import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const geofences = pgTable(
  "geofences",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    radiusMeters: integer("radius_meters").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    assignedEmployeeIds: text("assigned_employee_ids").notNull(),
    workingHoursStart: text("working_hours_start"),
    workingHoursEnd: text("working_hours_end"),
    allowOverride: boolean("allow_override").default(false).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    geofenceActiveIdx: index("geofences_is_active_idx").on(table.isActive),
  })
);

export const attendance = pgTable(
  "attendance",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull(),
    userName: text("user_name").notNull(),
    checkInTime: timestamp("check_in_time"),
    checkOutTime: timestamp("check_out_time"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    geofenceId: varchar("geofence_id"),
    geofenceName: text("geofence_name"),
    photoUrl: text("photo_url"),
    deviceId: text("device_id").notNull(),
    timestampServer: timestamp("timestamp_server").defaultNow().notNull(),
    isInsideGeofence: boolean("is_inside_geofence").notNull(),
    notes: text("notes"),
    status: text("status").default("checked_in").notNull(),
  },
  (table) => ({
    attendanceUserIdx: index("attendance_user_id_idx").on(table.userId),
    attendanceTimestampIdx: index("attendance_timestamp_server_idx").on(table.timestampServer),
    attendanceGeofenceIdx: index("attendance_geofence_id_idx").on(table.geofenceId),
  })
);

export const attendancePhotos = pgTable(
  "attendance_photos",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    attendanceId: varchar("attendance_id").notNull(),
    userId: varchar("user_id").notNull(),
    photoUrl: text("photo_url").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    geofenceId: varchar("geofence_id"),
    metadataOverlay: text("metadata_overlay"),
    photoType: text("photo_type").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    attendancePhotosUserIdx: index("attendance_photos_user_id_idx").on(table.userId),
    attendancePhotosAttendanceIdx: index("attendance_photos_attendance_id_idx").on(table.attendanceId),
  })
);

export const attendanceAnomalies = pgTable(
  "attendance_anomalies",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    attendanceId: varchar("attendance_id"),
    userId: varchar("user_id").notNull(),
    anomalyType: text("anomaly_type").notNull(),
    severity: text("severity").notNull(),
    details: text("details").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    anomaliesUserIdx: index("attendance_anomalies_user_id_idx").on(table.userId),
    anomaliesCreatedIdx: index("attendance_anomalies_created_at_idx").on(table.createdAt),
  })
);

export const locationLogs = pgTable(
  "location_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracy: doublePrecision("accuracy"),
    speed: doublePrecision("speed"),
    heading: doublePrecision("heading"),
    geofenceId: varchar("geofence_id"),
    geofenceName: text("geofence_name"),
    isInsideGeofence: boolean("is_inside_geofence").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (table) => ({
    locationUserIdx: index("location_logs_user_id_idx").on(table.userId),
    locationCapturedIdx: index("location_logs_captured_at_idx").on(table.capturedAt),
  })
);

export const routeHalts = pgTable(
  "route_halts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: varchar("user_id").notNull(),
    routeDate: text("route_date").notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    routeHaltsUserDateIdx: index("route_halts_user_date_idx").on(table.userId, table.routeDate),
    routeHaltsStartIdx: index("route_halts_started_at_idx").on(table.startedAt),
  })
);

export const dolibarrSyncLogs = pgTable(
  "dolibarr_sync_logs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    attendanceId: varchar("attendance_id").notNull(),
    userId: varchar("user_id").notNull(),
    attempt: integer("attempt").default(1).notNull(),
    status: text("status").default("pending").notNull(),
    message: text("message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    syncedAt: timestamp("synced_at"),
  },
  (table) => ({
    syncAttendanceIdx: index("dolibarr_sync_attendance_id_idx").on(table.attendanceId),
    syncStatusIdx: index("dolibarr_sync_status_idx").on(table.status),
  })
);

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertGeofenceSchema = createInsertSchema(geofences).omit({
  createdAt: true,
  updatedAt: true,
});

export const insertAttendanceSchema = createInsertSchema(attendance).omit({
  id: true,
  timestampServer: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type GeofenceRow = typeof geofences.$inferSelect;
export type AttendanceRow = typeof attendance.$inferSelect;
