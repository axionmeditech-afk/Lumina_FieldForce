import type { Conversation } from "@/lib/types";

interface AnalyzeWithAIInput {
  apiKey: string;
  model?: string;
  transcript: string;
  customerName: string;
  salespersonName: string;
}

export interface AISalesAnalysisResult {
  interestScore: number;
  pitchScore: number;
  confidenceScore: number;
  talkListenRatio: number;
  sentiment: Conversation["sentiment"];
  buyingIntent: Conversation["buyingIntent"];
  summary: string;
  keyPhrases: string[];
  objections: string[];
  improvements: string[];
}

type AIErrorKind =
  | "invalid_api_key"
  | "quota_exhausted"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "server_error"
  | "model_not_available"
  | "bad_request"
  | "unknown";

class AIRequestError extends Error {
  status: number;
  code: string;
  model: string;
  kind: AIErrorKind;
  retryable: boolean;

  constructor(params: {
    message: string;
    status: number;
    code?: string;
    model: string;
    kind: AIErrorKind;
    retryable?: boolean;
  }) {
    super(params.message);
    this.name = "AIRequestError";
    this.status = params.status;
    this.code = params.code || "unknown_error";
    this.model = params.model;
    this.kind = params.kind;
    this.retryable = Boolean(params.retryable);
  }
}

interface GroqErrorShape {
  code?: string;
  message?: string;
  type?: string;
}

interface GroqChatCompletionPayload {
  error?: GroqErrorShape;
  choices?: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
    };
    finish_reason?: string | null;
  }>;
}

const GROQ_CHAT_API_BASE = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
];
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_ATTEMPTS = 2;
const BASE_RETRY_DELAY_MS = 350;
const MAX_TRANSCRIPT_CHARS = 4_500;

function normalizeApiSecret(value: string | undefined | null): string {
  if (!value) return "";
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampScore(value: unknown, fallback = 50): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeSentiment(value: unknown): Conversation["sentiment"] {
  if (value === "positive" || value === "neutral" || value === "negative") return value;
  return "neutral";
}

function normalizeBuyingIntent(value: unknown): Conversation["buyingIntent"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (!cleaned.length) return fallback;
  return [...new Set(cleaned)].slice(0, 8);
}

function buildFallbackSummary(transcript: string): string {
  const sentence = transcript.split(/[.!?]\s+/).find((part) => part.trim().length > 0)?.trim();
  if (!sentence) return "Conversation captured and analyzed.";
  return sentence.length > 220 ? `${sentence.slice(0, 220)}...` : sentence;
}

function dedupeModels(models: string[]): string[] {
  const out: string[] = [];
  for (const item of models) {
    const value = item.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function buildGroqModelCandidates(model?: string): string[] {
  const selected = model?.trim() || "";
  const preferred = selected ? [selected] : [];
  return dedupeModels([...preferred, ...GROQ_DEFAULT_MODELS]);
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("AI response did not include valid JSON.");
}

function toLower(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeUnknownError(error: unknown, model: string): AIRequestError {
  if (error instanceof AIRequestError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new AIRequestError({
      message: "AI request timed out.",
      status: 0,
      code: "timeout",
      model,
      kind: "timeout",
      retryable: true,
    });
  }
  if (error instanceof Error) {
    return new AIRequestError({
      message: error.message || "AI network error.",
      status: 0,
      code: "network_error",
      model,
      kind: "network_error",
      retryable: true,
    });
  }
  return new AIRequestError({
    message: "Unknown AI request error.",
    status: 0,
    code: "unknown_error",
    model,
    kind: "unknown",
  });
}

function normalizeGroqError(params: {
  status: number;
  model: string;
  rawMessage?: string;
  error?: GroqErrorShape;
}): AIRequestError {
  const code = String(params.error?.code || "").trim().toLowerCase();
  const type = toLower(params.error?.type);
  const message = (params.error?.message || params.rawMessage || "").trim();
  const messageLower = message.toLowerCase();

  const isModelIssue =
    params.status === 404 ||
    type === "not_found_error" ||
    /model.*(not found|not available|does not exist|unsupported)/i.test(messageLower);
  if (isModelIssue) {
    return new AIRequestError({
      message: `Model "${params.model}" unavailable. Trying fallback model.`,
      status: params.status,
      code: code || "model_not_found",
      model: params.model,
      kind: "model_not_available",
    });
  }

  if (
    params.status === 401 ||
    params.status === 403 ||
    type === "authentication_error" ||
    /invalid api key|unauthorized|authentication/i.test(messageLower)
  ) {
    return new AIRequestError({
      message: "Groq API key invalid or unauthorized.",
      status: params.status,
      code: code || "invalid_api_key",
      model: params.model,
      kind: "invalid_api_key",
    });
  }

  if (params.status === 429 && /quota|billing|credits|exceed|limit/i.test(messageLower)) {
    return new AIRequestError({
      message: "Groq quota exhausted or billing limit reached.",
      status: params.status,
      code: code || "quota_exhausted",
      model: params.model,
      kind: "quota_exhausted",
    });
  }

  if (params.status === 429) {
    return new AIRequestError({
      message: "Groq rate limit hit. Retrying with backoff.",
      status: params.status,
      code: code || "rate_limited",
      model: params.model,
      kind: "rate_limited",
      retryable: true,
    });
  }

  if (params.status >= 500) {
    return new AIRequestError({
      message: `Groq server transient error (${params.status}). Retrying.`,
      status: params.status,
      code: code || "server_error",
      model: params.model,
      kind: "server_error",
      retryable: true,
    });
  }

  if (params.status >= 400 && params.status < 500) {
    return new AIRequestError({
      message: message || `Groq request failed (${params.status}).`,
      status: params.status,
      code: code || "bad_request",
      model: params.model,
      kind: "bad_request",
    });
  }

  return new AIRequestError({
    message: message || "Groq request failed.",
    status: params.status,
    code: code || "unknown_error",
    model: params.model,
    kind: "unknown",
  });
}

function truncateTranscript(transcript: string): string {
  const cleaned = transcript.trim();
  if (cleaned.length <= MAX_TRANSCRIPT_CHARS) return cleaned;

  const headChars = Math.floor(MAX_TRANSCRIPT_CHARS * 0.65);
  const tailChars = Math.floor(MAX_TRANSCRIPT_CHARS * 0.3);
  const omitted = cleaned.length - headChars - tailChars;
  return [
    cleaned.slice(0, headChars),
    `\n[... ${omitted} chars omitted for token optimization ...]\n`,
    cleaned.slice(-tailChars),
  ].join("");
}

function buildResponseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      interestScore: { type: "integer", minimum: 0, maximum: 100 },
      pitchScore: { type: "integer", minimum: 0, maximum: 100 },
      confidenceScore: { type: "integer", minimum: 0, maximum: 100 },
      talkListenRatio: { type: "integer", minimum: 0, maximum: 100 },
      sentiment: {
        type: "string",
        enum: ["positive", "neutral", "negative"],
      },
      buyingIntent: {
        type: "string",
        enum: ["high", "medium", "low"],
      },
      summary: { type: "string" },
      keyPhrases: {
        type: "array",
        items: { type: "string" },
      },
      objections: {
        type: "array",
        items: { type: "string" },
      },
      improvements: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "interestScore",
      "pitchScore",
      "confidenceScore",
      "talkListenRatio",
      "sentiment",
      "buyingIntent",
      "summary",
      "keyPhrases",
      "objections",
      "improvements",
    ],
  };
}

async function requestGroqCompletion(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GROQ_CHAT_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: params.model,
        temperature: 0.1,
        max_completion_tokens: 700,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "sales_conversation_analysis",
            strict: true,
            schema: buildResponseSchema(),
          },
        },
      }),
    });

    const rawText = await response.text();
    let payload: GroqChatCompletionPayload | undefined;
    try {
      payload = rawText ? (JSON.parse(rawText) as GroqChatCompletionPayload) : undefined;
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      throw normalizeGroqError({
        status: response.status,
        model: params.model,
        rawMessage: rawText,
        error: payload?.error,
      });
    }

    const content = payload?.choices?.[0]?.message?.content?.trim() || "";
    if (!content) {
      throw new AIRequestError({
        message: `Groq response was empty for model "${params.model}".`,
        status: response.status,
        code: "empty_response",
        model: params.model,
        kind: "unknown",
      });
    }

    return content;
  } catch (error) {
    throw normalizeUnknownError(error, params.model);
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithRetry(fn: () => Promise<string>, model: string): Promise<string> {
  let lastError: AIRequestError | null = null;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeUnknownError(error, model);
      lastError = normalized;
      if (!normalized.retryable || attempt === MAX_RETRY_ATTEMPTS) {
        throw normalized;
      }
      const jitter = Math.floor(Math.random() * 350);
      const backoff = Math.min(6000, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1)) + jitter;
      await delay(backoff);
    }
  }
  throw (
    lastError ||
    new AIRequestError({
      message: "AI request failed after retries.",
      status: 0,
      model,
      kind: "unknown",
    })
  );
}

export async function analyzeConversationWithAI(
  input: AnalyzeWithAIInput
): Promise<AISalesAnalysisResult> {
  const apiKey = normalizeApiSecret(input.apiKey);
  if (!apiKey) {
    throw new Error("AI key is missing.");
  }

  const transcript = truncateTranscript(input.transcript);
  if (!transcript || transcript.length < 20) {
    throw new Error("Transcript is too short for AI analysis.");
  }

  const modelCandidates = buildGroqModelCandidates(input.model);
  const systemPrompt =
    "You are a strict enterprise sales call analyst for Indian multilingual calls (Hindi/English/Gujarati mix). " +
    "Return only JSON that matches the provided schema. All scores must be integers from 0 to 100. " +
    "Do not hallucinate facts that are not present in the transcript.";
  const userPrompt = [
    "Analyze this sales conversation.",
    "Rules:",
    "- summary max 2 short sentences.",
    "- keyPhrases 3 to 6 short phrases.",
    "- objections real objections only, empty array if none.",
    "- improvements 2 to 4 concrete coaching tips.",
    "- If transcript contains speaker tags, use them to estimate talkListenRatio realistically.",
    "- Preserve customer intent from mixed-language context; do not over-penalize code-switching.",
    `Customer: ${input.customerName}`,
    `Salesperson: ${input.salespersonName}`,
    "Transcript:",
    transcript,
  ].join("\n");

  let lastError: AIRequestError | null = null;

  for (const model of modelCandidates) {
    try {
      const rawContent = await requestWithRetry(
        () =>
          requestGroqCompletion({
            apiKey,
            model,
            systemPrompt,
            userPrompt,
          }),
        model
      );

      const parsed = JSON.parse(extractJson(rawContent)) as Record<string, unknown>;
      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim().length > 0
          ? parsed.summary.trim()
          : buildFallbackSummary(transcript);

      return {
        interestScore: clampScore(parsed.interestScore),
        pitchScore: clampScore(parsed.pitchScore),
        confidenceScore: clampScore(parsed.confidenceScore),
        talkListenRatio: clampScore(parsed.talkListenRatio),
        sentiment: normalizeSentiment(parsed.sentiment),
        buyingIntent: normalizeBuyingIntent(parsed.buyingIntent),
        summary,
        keyPhrases: normalizeStringList(parsed.keyPhrases, [
          "Sales Discussion",
          "Customer Requirement",
          "Follow-up",
        ]),
        objections: normalizeStringList(parsed.objections, []),
        improvements: normalizeStringList(parsed.improvements, [
          "Add more discovery questions and confirm next steps clearly.",
        ]),
      };
    } catch (error) {
      const normalized = normalizeUnknownError(error, model);
      lastError = normalized;
      if (
        normalized.kind === "model_not_available" ||
        normalized.kind === "rate_limited" ||
        normalized.kind === "quota_exhausted" ||
        /valid json/i.test(normalized.message)
      ) {
        continue;
      }
      throw normalized;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("No compatible AI model available.");
}
