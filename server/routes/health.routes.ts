import type { Express } from "express";

export type HealthRouteDeps = {
  isMySqlStateEnabled: () => boolean;
};

export function registerHealthRoutes(app: Express, deps: HealthRouteDeps) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      edition: "attendance-geofencing",
      commit: process.env.RENDER_GIT_COMMIT || null,
      ts: new Date().toISOString(),
      mysqlStateEnabled: deps.isMySqlStateEnabled(),
    });
  });
}
