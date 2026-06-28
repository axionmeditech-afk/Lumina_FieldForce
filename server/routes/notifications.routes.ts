import type { Express, RequestHandler } from "express";
import type { AppNotification, NotificationAudience, UserRole } from "@/lib/types";

export type NotificationsRouteDeps = {
  requireAuth: RequestHandler;
  initAuthUsersStore: () => Promise<void>;
  getAuthUserByIdentifier: (identifier: string) => { user: { companyId?: string | null } } | null | undefined;
  isMySqlStateEnabled: () => boolean;
  listNotificationsFromMySql: (
    role: UserRole,
    userId: string,
    companyId: string | null,
  ) => Promise<AppNotification[]>;
  normalizeWhitespace: (value: string) => string;
  isGenericNotificationTitle: (title: string) => boolean;
  normalizeNotificationKind: (kind: unknown) => AppNotification["kind"];
  normalizeNotificationAudience: (audience: unknown) => NotificationAudience;
  parseNotificationUserIds: (value: unknown) => string[];
  randomUUID: () => string;
  insertNotificationInMySql: (notification: AppNotification) => Promise<void>;
  firstString: (value: unknown) => string;
  markNotificationReadInMySql: (notificationId: string, userId: string) => Promise<void>;
  markAllNotificationsReadInMySql: (
    role: UserRole,
    userId: string,
    companyId: string | null,
  ) => Promise<void>;
};

export function registerNotificationRoutes(app: Express, deps: NotificationsRouteDeps) {
  app.get("/api/notifications", deps.requireAuth, async (req, res) => {
    const role = req.auth?.role || "salesperson";
    await deps.initAuthUsersStore();
    const authRecord = req.auth?.email
      ? deps.getAuthUserByIdentifier(req.auth.email)
      : null;
    const companyId = authRecord?.user.companyId ?? null;

    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({
        message: "Notifications storage is unavailable. Configure MySQL for lff_notifications.",
      });
      return;
    }

    try {
      const notifications = await deps.listNotificationsFromMySql(role, req.auth?.sub || "", companyId);
      res.json(notifications);
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to load notifications: ${error.message}`
            : "Unable to load notifications.",
      });
    }
  });

  app.post("/api/notifications", deps.requireAuth, async (req, res) => {
    const { title, body, kind, audience, audienceUserIds } = req.body as {
      title?: string;
      body?: string;
      kind?: AppNotification["kind"];
      audience?: NotificationAudience;
      audienceUserIds?: string[];
    };
    if (!title || !body) {
      res.status(400).json({ message: "Notification title and body are required." });
      return;
    }

    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({
        message: "Notifications storage is unavailable. Configure MySQL for lff_notifications.",
      });
      return;
    }

    await deps.initAuthUsersStore();
    const authRecord = req.auth?.email
      ? deps.getAuthUserByIdentifier(req.auth.email)
      : null;
    const companyId = authRecord?.user.companyId ?? null;
    const createdAt = new Date().toISOString();
    const normalizedTitle = deps.normalizeWhitespace(title);
    const normalizedBody = deps.normalizeWhitespace(body);
    const hasGenericTitle = deps.isGenericNotificationTitle(normalizedTitle);
    const safeTitle =
      hasGenericTitle
        ? normalizedBody.slice(0, 90) || "New update"
        : normalizedTitle;
    const safeBody =
      normalizedBody || (!hasGenericTitle && normalizedTitle ? normalizedTitle : "You have a new notification.");
    const notification: AppNotification = {
      id: `notif_${deps.randomUUID()}`,
      companyId: companyId || undefined,
      title: safeTitle,
      body: safeBody,
      kind: deps.normalizeNotificationKind(kind),
      audience: deps.normalizeNotificationAudience(audience),
      createdById: req.auth?.sub || "system",
      createdByName: req.auth?.email || "System",
      createdAt,
      readByIds: [],
      audienceUserIds: deps.parseNotificationUserIds(audienceUserIds),
    };

    try {
      await deps.insertNotificationInMySql(notification);
      res.status(201).json(notification);
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to save notification: ${error.message}`
            : "Unable to save notification.",
      });
    }
  });

  app.post("/api/notifications/:id/read", deps.requireAuth, async (req, res) => {
    const notificationId = deps.firstString(req.params.id);
    if (!notificationId) {
      res.status(400).json({ message: "Notification id is required." });
      return;
    }
    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({
        message: "Notifications storage is unavailable. Configure MySQL for lff_notifications.",
      });
      return;
    }
    try {
      await deps.markNotificationReadInMySql(notificationId, req.auth?.sub || "");
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to mark notification read: ${error.message}`
            : "Unable to mark notification read.",
      });
    }
  });

  app.post("/api/notifications/read-all", deps.requireAuth, async (req, res) => {
    if (!deps.isMySqlStateEnabled()) {
      res.status(503).json({
        message: "Notifications storage is unavailable. Configure MySQL for lff_notifications.",
      });
      return;
    }
    try {
      const role = req.auth?.role || "salesperson";
      await deps.initAuthUsersStore();
      const authRecord = req.auth?.email
        ? deps.getAuthUserByIdentifier(req.auth.email)
        : null;
      const companyId = authRecord?.user.companyId ?? null;
      await deps.markAllNotificationsReadInMySql(role, req.auth?.sub || "", companyId);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        message:
          error instanceof Error
            ? `Unable to mark notifications read: ${error.message}`
            : "Unable to mark notifications read.",
      });
    }
  });
}
