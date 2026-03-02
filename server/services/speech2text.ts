import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const HF_INFERENCE_BASE_URL = (
  process.env.HF_INFERENCE_BASE_URL?.trim() ||
  "https://router.huggingface.co/hf-inference/models"
).replace(/\/+$/, "");
const GEMINI_API_BASE_URL = (
  process.env.GEMINI_API_BASE_URL?.trim() ||
  process.env.GEMINI_API_BASE?.trim() ||
  "https://generativelanguage.googleapis.com"
).replace(/\/+$/, "");
const DEFAULT_FAIRSEQ_S2T_MODEL =
  process.env.HF_S2T_MODEL?.trim() || "facebook/s2t-small-librispeech-asr";
const DEFAULT_FALLBACK_MODEL =
  process.env.HF_STT_FALLBACK_MODEL?.trim() || "distil-whisper/distil-small.en";
const DEFAULT_GEMINI_STT_MODEL =
  process.env.GEMINI_STT_MODEL?.trim() ||
  process.env.GEMINI_MODEL?.trim() ||
  "gemini-2.5-flash";
const DEFAULT_PROVIDER_ORDER = (
  process.env.SPEECH_TO_TEXT_PROVIDER_ORDER?.trim() || "gemini,local_python,huggingface"
).toLowerCase();
const LOCAL_STT_ENABLED =
  (process.env.LOCAL_STT_ENABLED?.trim() || "true").toLowerCase() !== "false";
const LOCAL_STT_PYTHON_CMD = process.env.LOCAL_STT_PYTHON_CMD?.trim() || "python";
const LOCAL_STT_MODEL = process.env.LOCAL_STT_MODEL?.trim() || "small";
const LOCAL_STT_SCRIPT_PATH =
  process.env.LOCAL_STT_SCRIPT_PATH?.trim() ||
  path.resolve(process.cwd(), "server", "python", "stt_diarize.py");
const DEFAULT_REQUEST_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.HF_S2T_TIMEOUT_MS || 70_000)
);
const LOCAL_STT_TIMEOUT_MS = Math.max(
  20_000,
  Number(process.env.LOCAL_STT_TIMEOUT_MS || 240_000)
);
const TRANSCRIBE_RETRY_DELAY_MS = Math.max(
  200,
  Number(process.env.SPEECH_TRANSCRIBE_RETRY_DELAY_MS || 900)
);

type SpeechProvider = "local_python" | "huggingface" | "gemini";

export interface DiarizedTranscriptEntry {
  transcript: string;
  startTimeSeconds?: number | null;
  endTimeSeconds?: number | null;
  speakerId?: string | null;
}

export interface Speech2TextResult {
  transcript: string;
  provider: SpeechProvider;
  model: string;
  fallbackUsed: boolean;
  warning?: string;
  latencyMs: number;
  diarizedTranscript?: {
    entries: DiarizedTranscriptEntry[];
  };
}

export class Speech2TextError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = "Speech2TextError";
    this.statusCode = statusCode;
  }
}

interface TranscribeRequest {
  audio: Buffer;
  mimeType?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  huggingFaceToken?: string | null;
  geminiApiKey?: string | null;
  provider?: string | null;
  mode?: string | null;
  languageCode?: string | null;
  withDiarization?: boolean | null;
  numSpeakers?: number | null;
  withTimestamps?: boolean | null;
}

function toModelId(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyHuggingFaceModel(value: string | null | undefined): boolean {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return false;
  return candidate.includes("/");
}

function resolveLocalModel(value: string | null | undefined): string {
  const candidate = value?.trim() || "";
  if (!candidate) return LOCAL_STT_MODEL;
  if (candidate.includes("/") || candidate.includes(":")) return LOCAL_STT_MODEL;
  return candidate;
}

function parseProviderOrder(input: string): SpeechProvider[] {
  const chunks = input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const providers: SpeechProvider[] = [];
  for (const chunk of chunks) {
    if (
      (chunk === "gemini" || chunk === "google" || chunk === "google_gemini") &&
      !providers.includes("gemini")
    ) {
      providers.push("gemini");
    }
    if (
      (chunk === "local" || chunk === "python" || chunk === "local_python") &&
      !providers.includes("local_python")
    ) {
      providers.push("local_python");
    }
    if (
      (chunk === "hf" || chunk === "huggingface") &&
      !providers.includes("huggingface")
    ) {
      providers.push("huggingface");
    }
  }
  if (!providers.length) {
    providers.push("gemini", "local_python", "huggingface");
  }
  if (providers.includes("gemini")) {
    return ["gemini", ...providers.filter((provider) => provider !== "gemini")];
  }
  return providers;
}

function guessFileExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("aac")) return ".aac";
  if (lower.includes("3gpp")) return ".3gp";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("ogg")) return ".ogg";
  return ".m4a";
}

function toBlobCompatiblePart(buffer: Buffer): ArrayBuffer {
  // Convert Node Buffer into a detached ArrayBuffer for TS BlobPart compatibility.
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy.buffer;
}

function extractTranscript(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") {
    return payload.trim();
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const generated = row.generated_text;
        const text = row.text;
        const transcript = row.transcript;
        if (typeof transcript === "string" && transcript.trim()) return transcript.trim();
        if (typeof text === "string" && text.trim()) return text.trim();
        if (typeof generated === "string" && generated.trim()) return generated.trim();
      }
    }
    return "";
  }

  if (typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    const candidates = Array.isArray(row.candidates) ? row.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const content = (candidate as Record<string, unknown>).content;
      if (!content || typeof content !== "object") continue;
      const parts = Array.isArray((content as Record<string, unknown>).parts)
        ? ((content as Record<string, unknown>).parts as unknown[])
        : [];
      const combined = parts
        .map((part) =>
          part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text).trim()
            : ""
        )
        .filter(Boolean)
        .join("\n")
        .trim();
      if (combined) return combined;
    }

    if (typeof row.transcript === "string" && row.transcript.trim()) {
      return row.transcript.trim();
    }
    if (typeof row.text === "string" && row.text.trim()) return row.text.trim();
    if (typeof row.generated_text === "string" && row.generated_text.trim()) {
      return row.generated_text.trim();
    }
    if (typeof row.transcription === "string" && row.transcription.trim()) {
      return row.transcription.trim();
    }
  }

  return "";
}

function extractDiarizedEntries(payload: unknown): DiarizedTranscriptEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;
  const diarized =
    row.diarized_transcript && typeof row.diarized_transcript === "object"
      ? (row.diarized_transcript as Record<string, unknown>)
      : row.diarizedTranscript && typeof row.diarizedTranscript === "object"
        ? (row.diarizedTranscript as Record<string, unknown>)
        : null;
  if (!diarized) return [];
  const entries = Array.isArray(diarized.entries) ? diarized.entries : [];
  const normalized: DiarizedTranscriptEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const segment = item as Record<string, unknown>;
    const transcript =
      typeof segment.transcript === "string" ? segment.transcript.trim() : "";
    if (!transcript) continue;
    const start =
      typeof segment.start_time_seconds === "number"
        ? segment.start_time_seconds
        : typeof segment.startTimeSeconds === "number"
          ? segment.startTimeSeconds
          : null;
    const end =
      typeof segment.end_time_seconds === "number"
        ? segment.end_time_seconds
        : typeof segment.endTimeSeconds === "number"
          ? segment.endTimeSeconds
          : null;
    const speaker =
      typeof segment.speaker_id === "string"
        ? segment.speaker_id.trim()
        : typeof segment.speakerId === "string"
          ? segment.speakerId.trim()
          : "";

    normalized.push({
      transcript,
      startTimeSeconds: start,
      endTimeSeconds: end,
      speakerId: speaker || null,
    });
  }
  return normalized;
}

function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    if (typeof row.error === "string" && row.error.trim()) {
      return row.error.trim();
    }
    if (
      row.error &&
      typeof row.error === "object" &&
      typeof (row.error as Record<string, unknown>).message === "string"
    ) {
      return String((row.error as Record<string, unknown>).message).trim();
    }
    if (typeof row.message === "string" && row.message.trim()) {
      return row.message.trim();
    }
  }
  return `Speech-to-text request failed with HTTP ${status}`;
}

function shouldRetry(status: number, message: string): boolean {
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return /loading|currently loading|cold start|try again/i.test(message);
}

function combineWarnings(...warnings: (string | undefined | null)[]): string | undefined {
  const items = warnings.map((value) => (value || "").trim()).filter(Boolean);
  if (!items.length) return undefined;
  return items.join(" | ");
}

function getModelWarning(provider: SpeechProvider, model: string): string | undefined {
  if (provider === "local_python") {
    return "Local Python STT running on-device/server CPU. Accuracy and speed depend on model size and hardware.";
  }
  if (provider === "gemini") {
    return "Gemini multimodal transcription quality depends on model/audio clarity; results may vary on noisy calls.";
  }
  if (provider === "huggingface" && model === "facebook/s2t-small-librispeech-asr") {
    return "HF model is optimized for English ASR; multilingual/Indian speech accuracy may vary.";
  }
  return undefined;
}

function runCommandWithTimeout(params: {
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, params.timeoutMs);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
      });
    });
  });
}

async function callLocalPythonModel(params: {
  model: string;
  audio: Buffer;
  mimeType: string;
  languageCode?: string;
  withDiarization?: boolean;
  withTimestamps?: boolean;
  numSpeakers?: number;
}): Promise<{
  transcript: string;
  latencyMs: number;
  diarizedTranscript?: { entries: DiarizedTranscriptEntry[] };
}> {
  if (!LOCAL_STT_ENABLED) {
    throw new Speech2TextError("Local Python STT is disabled by env config.", 503);
  }

  const startedAt = Date.now();
  try {
    await fs.access(LOCAL_STT_SCRIPT_PATH);
  } catch {
    throw new Speech2TextError(
      `Local STT script missing at: ${LOCAL_STT_SCRIPT_PATH}`,
      500
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trackforce-stt-"));
  const audioPath = path.join(tempDir, `speech${guessFileExtension(params.mimeType)}`);

  try {
    await fs.writeFile(audioPath, params.audio);
    const args = [
      LOCAL_STT_SCRIPT_PATH,
      "--audio",
      audioPath,
      "--model",
      params.model || LOCAL_STT_MODEL,
      "--format",
      "json",
    ];
    if (params.languageCode?.trim()) {
      args.push("--language", params.languageCode.trim());
    }
    if (params.withTimestamps ?? true) {
      args.push("--with-timestamps");
    }
    if (params.withDiarization) {
      args.push("--with-diarization");
    }
    if (
      typeof params.numSpeakers === "number" &&
      Number.isFinite(params.numSpeakers) &&
      params.numSpeakers > 0
    ) {
      args.push("--num-speakers", String(Math.max(1, Math.floor(params.numSpeakers))));
    }

    const result = await runCommandWithTimeout({
      command: LOCAL_STT_PYTHON_CMD,
      args,
      timeoutMs: LOCAL_STT_TIMEOUT_MS,
    });

    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.signal === "SIGKILL") {
      throw new Speech2TextError("Local Python STT timed out.", 504);
    }
    if (result.exitCode !== 0) {
      throw new Speech2TextError(
        stderr || `Local Python STT exited with code ${result.exitCode}.`,
        502
      );
    }
    if (!stdout) {
      throw new Speech2TextError("Local Python STT returned empty response.", 502);
    }

    const payload = parseBody(stdout);
    const transcript = extractTranscript(payload);
    if (!transcript) {
      throw new Speech2TextError("Local Python STT returned empty transcript.", 422);
    }
    const diarizedEntries = extractDiarizedEntries(payload);
    return {
      transcript,
      latencyMs: Date.now() - startedAt,
      ...(diarizedEntries.length ? { diarizedTranscript: { entries: diarizedEntries } } : {}),
    };
  } catch (error) {
    if (error instanceof Speech2TextError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "Local Python STT request failed.";
    throw new Speech2TextError(message, 502);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function callHuggingFaceModel({
  model,
  audio,
  mimeType,
  token,
}: {
  model: string;
  audio: Buffer;
  mimeType: string;
  token?: string | null;
}): Promise<{ transcript: string; latencyMs: number }> {
  const url = new URL(`${HF_INFERENCE_BASE_URL}/${encodeURIComponent(model)}`);
  url.searchParams.set("wait_for_model", "true");

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": mimeType,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const startedAt = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: new Blob([toBlobCompatiblePart(audio)], { type: mimeType }),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      const payload = parseBody(bodyText);

      if (!response.ok) {
        const message = getErrorMessage(response.status, payload);
        if (attempt === 0 && shouldRetry(response.status, message)) {
          await sleep(TRANSCRIBE_RETRY_DELAY_MS);
          continue;
        }
        throw new Speech2TextError(message, response.status);
      }

      const transcript = extractTranscript(payload);
      if (!transcript) {
        throw new Speech2TextError("HuggingFace STT returned empty transcript", 422);
      }

      return { transcript, latencyMs: Date.now() - startedAt };
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === "AbortError") {
        continue;
      }
      if (error instanceof Speech2TextError) throw error;
      const message =
        error instanceof Error ? error.message : "HuggingFace speech-to-text request failed";
      throw new Speech2TextError(message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Speech2TextError("HuggingFace speech-to-text request timed out", 504);
}

async function callGeminiModel(params: {
  model: string;
  audio: Buffer;
  mimeType: string;
  token: string;
  languageCode?: string;
  withTimestamps?: boolean;
  withDiarization?: boolean;
}): Promise<{ transcript: string; latencyMs: number }> {
  const startedAt = Date.now();
  const endpoint =
    `${GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(params.model)}` +
    `:generateContent?key=${encodeURIComponent(params.token)}`;
  const base64Audio = params.audio.toString("base64");
  const promptLines = [
    "Transcribe this audio accurately.",
    "Return only the transcript text.",
    "Do not add commentary, markdown, or extra labels unless speakers are very clearly distinguishable.",
  ];
  if (params.languageCode?.trim()) {
    promptLines.push(`Prefer language code/context: ${params.languageCode.trim()}.`);
  }
  if (params.withTimestamps) {
    promptLines.push("Include lightweight timestamps inline when clearly available.");
  }
  if (params.withDiarization) {
    promptLines.push("If speakers are clearly separable, use speaker labels.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: promptLines.join(" ") },
                {
                  inlineData: {
                    mimeType: params.mimeType,
                    data: base64Audio,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
          },
        }),
      });

      const bodyText = await response.text();
      const payload = parseBody(bodyText);
      if (!response.ok) {
        const message = getErrorMessage(response.status, payload);
        if (attempt === 0 && shouldRetry(response.status, message)) {
          await sleep(TRANSCRIBE_RETRY_DELAY_MS);
          continue;
        }
        throw new Speech2TextError(message, response.status);
      }

      const transcript = extractTranscript(payload);
      if (!transcript) {
        throw new Speech2TextError("Gemini STT returned empty transcript", 422);
      }
      return {
        transcript,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (attempt === 0 && error instanceof DOMException && error.name === "AbortError") {
        continue;
      }
      if (error instanceof Speech2TextError) throw error;
      const message =
        error instanceof Error ? error.message : "Gemini speech-to-text request failed";
      throw new Speech2TextError(message, 502);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Speech2TextError("Gemini speech-to-text request timed out", 504);
}

async function runHuggingFaceWithFallback(params: {
  primaryModel: string;
  fallbackModel: string;
  audio: Buffer;
  mimeType: string;
  token?: string | null;
}): Promise<Speech2TextResult> {
  try {
    const result = await callHuggingFaceModel({
      model: params.primaryModel,
      audio: params.audio,
      mimeType: params.mimeType,
      token: params.token,
    });
    return {
      transcript: result.transcript,
      provider: "huggingface",
      model: params.primaryModel,
      fallbackUsed: false,
      warning: getModelWarning("huggingface", params.primaryModel),
      latencyMs: result.latencyMs,
    };
  } catch (primaryError) {
    if (!params.fallbackModel || params.fallbackModel === params.primaryModel) {
      throw primaryError;
    }
    const fallbackResult = await callHuggingFaceModel({
      model: params.fallbackModel,
      audio: params.audio,
      mimeType: params.mimeType,
      token: params.token,
    });
    return {
      transcript: fallbackResult.transcript,
      provider: "huggingface",
      model: params.fallbackModel,
      fallbackUsed: true,
      warning: combineWarnings(
        `HF fallback used after primary model "${params.primaryModel}" failed.`,
        getModelWarning("huggingface", params.primaryModel)
      ),
      latencyMs: fallbackResult.latencyMs,
    };
  }
}

export async function transcribeSpeechWithFairseqS2T(
  request: TranscribeRequest
): Promise<Speech2TextResult> {
  if (!request.audio || request.audio.length === 0) {
    throw new Speech2TextError("Audio payload is empty", 400);
  }

  const mimeType = request.mimeType?.trim() || "audio/webm";
  const geminiToken =
    request.geminiApiKey?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GEMINI_API?.trim() ||
    process.env.EXPO_PUBLIC_GEMINI_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_GEMINI_API?.trim() ||
    "";
  const hfToken =
    request.huggingFaceToken?.trim() ||
    process.env.HUGGINGFACE_API_KEY?.trim() ||
    process.env.HUGGINGFACE_TOKEN?.trim() ||
    "";

  const requestedModel = request.model?.trim() || "";
  const localModel = resolveLocalModel(requestedModel);
  const geminiModel = requestedModel.toLowerCase().startsWith("gemini-")
    ? requestedModel
    : DEFAULT_GEMINI_STT_MODEL;
  const hfPrimaryModel =
    requestedModel &&
    isLikelyHuggingFaceModel(requestedModel) &&
    !requestedModel.toLowerCase().startsWith("gemini-")
      ? requestedModel
      : DEFAULT_FAIRSEQ_S2T_MODEL;
  const hfFallbackModel = toModelId(request.fallbackModel, DEFAULT_FALLBACK_MODEL);
  const providerOrder = parseProviderOrder(request.provider?.trim() || DEFAULT_PROVIDER_ORDER);

  let geminiFailure: string | null = null;
  let localFailure: string | null = null;
  let huggingFaceFailure: string | null = null;

  for (const provider of providerOrder) {
    if (provider === "gemini") {
      if (!geminiToken) {
        geminiFailure = "Gemini API key missing.";
        continue;
      }
      try {
        const result = await callGeminiModel({
          model: geminiModel,
          audio: request.audio,
          mimeType,
          token: geminiToken,
          languageCode: request.languageCode?.trim() || "",
          withTimestamps: request.withTimestamps ?? true,
          withDiarization: Boolean(request.withDiarization),
        });
        return {
          transcript: result.transcript,
          provider: "gemini",
          model: geminiModel,
          fallbackUsed: false,
          warning: combineWarnings(
            localFailure,
            huggingFaceFailure,
            getModelWarning("gemini", geminiModel)
          ),
          latencyMs: result.latencyMs,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gemini STT failed unexpectedly.";
        geminiFailure = message;
      }
      continue;
    }

    if (provider === "local_python") {
      try {
        const localResult = await callLocalPythonModel({
          model: localModel,
          audio: request.audio,
          mimeType,
          languageCode: request.languageCode?.trim() || "",
          withDiarization: Boolean(request.withDiarization),
          withTimestamps: request.withTimestamps ?? true,
          numSpeakers:
            typeof request.numSpeakers === "number" && Number.isFinite(request.numSpeakers)
              ? request.numSpeakers
              : undefined,
        });
        return {
          transcript: localResult.transcript,
          provider: "local_python",
          model: localModel,
          fallbackUsed: false,
          warning: combineWarnings(geminiFailure, getModelWarning("local_python", localModel)),
          latencyMs: localResult.latencyMs,
          ...(localResult.diarizedTranscript
            ? { diarizedTranscript: localResult.diarizedTranscript }
            : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Local Python STT failed unexpectedly.";
        localFailure = message;
      }
      continue;
    }

    try {
      const hfResult = await runHuggingFaceWithFallback({
        primaryModel: hfPrimaryModel,
        fallbackModel: hfFallbackModel,
        audio: request.audio,
        mimeType,
        token: hfToken,
      });
      return {
        ...hfResult,
        warning: combineWarnings(geminiFailure, localFailure, hfResult.warning),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "HuggingFace STT failed unexpectedly.";
      huggingFaceFailure = message;
    }
  }

  throw new Speech2TextError(
    combineWarnings(geminiFailure, localFailure, huggingFaceFailure) ||
      "All speech-to-text providers failed.",
    502
  );
}
