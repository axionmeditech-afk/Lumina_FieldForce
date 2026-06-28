import type { Express } from "express";

export type HealthRouteDeps = {
  isMySqlStateEnabled: () => boolean;
};

export function registerHealthRoutes(app: Express, deps: HealthRouteDeps) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      mysqlStateEnabled: deps.isMySqlStateEnabled(),
    });
  });
}
