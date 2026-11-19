import type { Express, Request } from "express";
import type { Pool } from "mysql2/promise";
import { randomUUID } from "crypto";
import { z } from "zod";
import type { AppNotification } from "@/lib/types";
import {
  isExpoPushToken,
  registerPushDevice,
  sendPushToCompany,
  sendPushToUsers,
  unregisterPushDevice,
} from "@/server/services/push-notifications";

type Deps = {
  requireAuth: (req: any, res: any, next: any) => void;
  getMySqlPool: () => Promise<Pool>;
  isMySqlStateEnabled: () => boolean;
  resolveRequestCompanyId: (req: Request) => Promise<string | null>;
  insertNotificationInMySql: (notification: AppNotification) => Promise<void>;
};

const deviceSchema = z.object({
  token: z.string().trim().min(1).max(255),
  deviceId: z.string().trim().min(1).max(191),
  platform: z.enum(["android", "ios"]),
});

const unregisterSchema = z.object({
  token: z.string().trim().max(255).optional(),
  deviceId: z.string().trim().max(191).optional(),
}).refine((value) => Boolean(value.token || value.deviceId), "Token or device is required.");

const alertSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  userIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
  data: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export function registerPushNotificationRoutes(app: Express, deps: Deps) {
  const requireStore = (_req: Request, res: any, next: any) => {
    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({ message: "Notification storage is not configured." });
      return;
    }
    next();
  };

  app.post("/api/notifications/devices", deps.requireAuth, requireStore, async (req, res) => {
    const parsed = deviceSchema.safeParse(req.body);
    if (!parsed.success || !isExpoPushToken(parsed.data.token)) {
      res.status(400).json({ message: "A valid Expo push token is required." });
      return;
    }
    const userId = String(req.auth?.sub || "").trim();
    const companyId = await deps.resolveRequestCompanyId(req);
    try {
      await registerPushDevice(await deps.getMySqlPool(), { ...parsed.data, userId, companyId });
      res.json({ ok: true });
    } catch (error) {
      console.error("[push] device registration failed", error);
      res.status(503).json({ message: "Could not register this device for alerts." });
    }
  });

  app.delete("/api/notifications/devices", deps.requireAuth, requireStore, async (req, res) => {
    const parsed = unregisterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Token or device is required." });
      return;
    }
    try {
      await unregisterPushDevice(await deps.getMySqlPool(), {
        userId: String(req.auth?.sub || ""),
        token: parsed.data.token,
        deviceId: parsed.data.deviceId,
      });
      res.json({ ok: true });
    } catch (error) {
      console.warn("[push] device unregister failed", error);
      res.status(503).json({ message: "Could not unregister this device." });
    }
  });

  app.post("/api/notifications/alerts", deps.requireAuth, requireStore, async (req, res) => {
    if (!["admin", "hr", "manager"].includes(req.auth?.role || "")) {
      res.status(403).json({ message: "Supervisor access is required to send alerts." });
      return;
    }
    const parsed = alertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Invalid employee alert.", issues: parsed.error.issues });
      return;
    }
    const companyId = await deps.resolveRequestCompanyId(req);
    if (!companyId) {
      res.status(403).json({ message: "Select an authorised workspace first." });
      return;
    }
    const userIds = [...new Set(parsed.data.userIds || [])];
    const notification: AppNotification = {
      id: randomUUID(),
      companyId,
      title: parsed.data.title,
      body: parsed.data.body,
      kind: "alert",
      audience: "employee",
      audienceUserIds: userIds,
      createdById: String(req.auth?.sub || ""),
      createdByName: "FieldForce supervisor",
      createdAt: new Date().toISOString(),
      readByIds: [],
    };
    try {
      await deps.insertNotificationInMySql(notification);
      const pool = await deps.getMySqlPool();
      const result = userIds.length
        ? await sendPushToUsers(pool, { userIds, companyId, payload: { title: parsed.data.title, body: parsed.data.body, data: { ...(parsed.data.data || {}), screen: "notifications", kind: "employee_alert" } } })
        : await sendPushToCompany(pool, { companyId, payload: { title: parsed.data.title, body: parsed.data.body, data: { ...(parsed.data.data || {}), screen: "notifications", kind: "employee_alert" } } });
      res.status(201).json({ notification, push: result });
    } catch (error) {
      console.error("[push] employee alert failed", error);
      res.status(503).json({ message: "Could not send the employee alert." });
    }
  });
}
