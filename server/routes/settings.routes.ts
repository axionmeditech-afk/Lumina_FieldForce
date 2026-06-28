import type { Express, RequestHandler } from "express";

export type DolibarrSettingsRouteDeps = {
  requireAuth: RequestHandler;
  resolveDolibarrConfigForUser: (
    userId: string,
    overrides?: {
      enabled?: boolean;
      endpoint?: string | null;
      apiKey?: string | null;
    },
  ) => Promise<{
    enabled: boolean;
    endpoint: string | null;
    apiKey: string | null;
    configured: boolean;
    source: string;
  }>;
  setDolibarrConfigForUser: (
    userId: string,
    config: {
      enabled: boolean;
      endpoint?: string | null;
      apiKey?: string | null;
    },
  ) => Promise<{
    enabled: boolean;
    endpoint?: string | null;
    apiKey?: string | null;
  }>;
  maskApiKey: (apiKey: string | null | undefined) => string | null;
  buildDolibarrEndpointCandidates: (endpoint: string | null | undefined) => string[];
  buildDolibarrProxyHeaders: (apiKey: string, includeContentType: boolean) => Record<string, string>;
  parseJsonText: (text: string) => unknown | null;
  getDolibarrProtectionBlockMessage: (text: string, parsedBody: unknown | null) => string | null;
};

export function registerDolibarrSettingsRoutes(app: Express, deps: DolibarrSettingsRouteDeps) {
  app.get("/api/settings/integrations/dolibarr", deps.requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const config = await deps.resolveDolibarrConfigForUser(userId);
    res.json({
      enabled: config.enabled,
      endpoint: config.endpoint,
      apiKeyMasked: deps.maskApiKey(config.apiKey),
      configured: config.configured,
      source: config.source,
    });
  });

  app.put("/api/settings/integrations/dolibarr", deps.requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body as {
      enabled?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
    };
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ message: "enabled must be a boolean." });
      return;
    }

    const updated = await deps.setDolibarrConfigForUser(userId, {
      enabled: body.enabled,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });
    const resolved = await deps.resolveDolibarrConfigForUser(userId, {
      enabled: updated.enabled,
      endpoint: updated.endpoint,
      apiKey: updated.apiKey,
    });
    res.json({
      enabled: resolved.enabled,
      endpoint: resolved.endpoint,
      apiKeyMasked: deps.maskApiKey(resolved.apiKey),
      configured: resolved.configured,
      source: "settings",
    });
  });

  app.post("/api/settings/integrations/dolibarr/test", deps.requireAuth, async (req, res) => {
    const userId = req.auth?.sub;
    if (!userId) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }
    const body = req.body as {
      enabled?: unknown;
      endpoint?: unknown;
      apiKey?: unknown;
    };

    const config = await deps.resolveDolibarrConfigForUser(userId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    });

    const endpointCandidates = deps.buildDolibarrEndpointCandidates(config.endpoint);

    if (!endpointCandidates.length || !config.apiKey) {
      res.json({
        ok: false,
        status: null,
        message: "Dolibarr endpoint and API key are required.",
      });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const failures: string[] = [];
      for (const endpointCandidate of endpointCandidates) {
        const response = await fetch(endpointCandidate, {
          method: "GET",
          headers: deps.buildDolibarrProxyHeaders(config.apiKey, false),
          signal: controller.signal,
        });
        const text = await response.text();
        const contentType = response.headers.get("content-type") || "";
        const parsedBody = deps.parseJsonText(text);
        const protectionBlockMessage = deps.getDolibarrProtectionBlockMessage(text, parsedBody);
        if (protectionBlockMessage) {
          failures.push(`${endpointCandidate} -> blocked by Dolibarr host protection: ${protectionBlockMessage}`);
          continue;
        }
        const looksLikeHtml =
          !parsedBody &&
          (contentType.toLowerCase().includes("text/html") ||
            /^\s*<!doctype html/i.test(text) ||
            /^\s*<html\b/i.test(text));

        if (response.ok && !looksLikeHtml) {
          res.json({
            ok: true,
            status: response.status,
            message: `Dolibarr endpoint reachable: ${endpointCandidate}`,
          });
          return;
        }

        failures.push(
          `${endpointCandidate} -> HTTP ${response.status}${looksLikeHtml ? ": returned HTML" : ""}`,
        );
      }

      res.json({
        ok: false,
        status: null,
        message: `Dolibarr endpoint test failed. Tried: ${failures.join(" | ")}`,
      });
    } catch (error) {
      res.json({
        ok: false,
        status: null,
        message:
          error instanceof Error ? error.message : "Unable to reach Dolibarr endpoint.",
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
