import type { Express } from "express";

export type AiAnalysisRouteDeps = {
  defaultGroqApiKey: string;
  defaultAiModel: string;
  normalizeApiSecret: (value: string | undefined | null) => string;
  analyzeConversationWithAI: (input: {
    apiKey: string;
    model: string;
    transcript: string;
    customerName: string;
    salespersonName: string;
  }) => Promise<unknown>;
};

export function registerAiAnalysisRoutes(app: Express, deps: AiAnalysisRouteDeps) {
  app.post("/api/ai/analyze", async (req, res) => {
    const body = req.body as {
      transcript?: unknown;
      customerName?: unknown;
      salespersonName?: unknown;
      model?: unknown;
    };
    const transcript =
      typeof body?.transcript === "string" ? body.transcript.trim() : "";
    const customerName =
      typeof body?.customerName === "string" ? body.customerName.trim() : "Customer";
    const salespersonName =
      typeof body?.salespersonName === "string" ? body.salespersonName.trim() : "Sales Rep";
    const requestedModel =
      typeof body?.model === "string" ? body.model.trim() : "";
    const model = requestedModel || deps.defaultAiModel;

    if (!transcript || transcript.length < 20) {
      res.status(400).json({ message: "Transcript is too short for AI analysis." });
      return;
    }

    const apiKey = deps.normalizeApiSecret(deps.defaultGroqApiKey);
    if (!apiKey) {
      res.status(500).json({ message: "AI key not configured on server." });
      return;
    }

    try {
      const result = await deps.analyzeConversationWithAI({
        apiKey,
        model,
        transcript,
        customerName,
        salespersonName,
      });
      res.json({
        provider: "groq",
        model,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI analysis failed.";
      const kind = typeof (error as any)?.kind === "string" ? String((error as any).kind) : "";
      const statusFromError =
        typeof (error as any)?.status === "number" ? Number((error as any).status) : 0;
      const status =
        statusFromError >= 400
          ? statusFromError
          : kind === "invalid_api_key"
            ? 401
            : kind === "quota_exhausted" || kind === "rate_limited"
              ? 429
              : kind === "model_not_available"
                ? 404
                : 500;
      res.status(status).json({
        message,
        kind: kind || "unknown",
      });
    }
  });
}
