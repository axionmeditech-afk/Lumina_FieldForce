import axios, { isAxiosError } from "axios";
import fs from "fs-extra";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const HF_INFERENCE_BASE_URL = (
  process.env.HF_INFERENCE_BASE_URL?.trim() ||
  "https://router.huggingface.co/hf-inference/models"
).replace(/\/+$/, "");
const ASSEMBLYAI_API_BASE_URL = (
  process.env.ASSEMBLYAI_API_BASE_URL?.trim() || "https://api.assemblyai.com"
).replace(/\/+$/, "");
const REVUP_API_BASE_URL = (
  process.env.REVUP_API_BASE_URL?.trim() || "https://revapi.reverieinc.com"
).replace(/\/+$/, "");
const GEMINI_API_BASE_URL = (
  process.env.GEMINI_API_BASE_URL?.trim() ||
  process.env.EXPO_PUBLIC_GEMINI_API_BASE_URL?.trim() ||
  "https://generativelanguage.googleapis.com"
).replace(/\/+$/, "");
const REVUP_APP_NAME = process.env.REVUP_APP_NAME?.trim() || "stt_file";
const REVUP_DEFAULT_SOURCE_LANG = process.env.REVUP_SOURCE_LANG?.trim() || "en";
const REVUP_DEFAULT_DOMAIN = process.env.REVUP_DOMAIN?.trim() || "generic";
const DEFAULT_GEMINI_STT_MODEL = (
  process.env.GEMINI_STT_MODEL?.trim() ||
  process.env.GEMINI_MODEL?.trim() ||
  process.env.EXPO_PUBLIC_GEMINI_MODEL?.trim() ||
  "gemini-2.5-flash-lite"
).trim();
const DEFAULT_FAIRSEQ_S2T_MODEL =
  process.env.HF_S2T_MODEL?.trim() || "openai/whisper-large-v3-turbo";
const DEFAULT_FALLBACK_MODEL =
  process.env.HF_STT_FALLBACK_MODEL?.trim() || "openai/whisper-large-v3";
const DEFAULT_ASSEMBLYAI_SPEECH_MODELS = (
  process.env.ASSEMBLYAI_SPEECH_MODELS?.trim() ||
  process.env.ASSEMBLYAI_SPEECH_MODEL?.trim() ||
  "universal-3-pro,universal-2"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const DEFAULT_PROVIDER_ORDER = (
  process.env.SPEECH_TO_TEXT_PROVIDER_ORDER?.trim() ||
  "gemini,revup,assemblyai,local_python,huggingface"
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
const ASSEMBLYAI_POLL_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS || 3_000)
);
const ASSEMBLYAI_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.ASSEMBLYAI_TIMEOUT_MS || 300_000)
);
const REVUP_TIMEOUT_MS = Math.max(
  20_000,
  Number(process.env.REVUP_TIMEOUT_MS || 120_000)
);
const GEMINI_TIMEOUT_MS = Math.max(
  20_000,
  Number(process.env.GEMINI_TIMEOUT_MS || 120_000)
);

type SpeechProvider = "gemini" | "revup" | "assemblyai" | "local_python" | "huggingface";

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
  assemblyAiApiKey?: string | null;
  revupApiKey?: string | null;
  revupAppId?: string | null;
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

function isLikelyGeminiModel(value: string | null | undefined): boolean {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return false;
  return candidate.startsWith("gemini");
}

function appendUniqueKey(target: string[], value: string | null | undefined): void {
  const trimmed = (value || "").trim();
  if (!trimmed) return;
  if (!target.includes(trimmed)) {
    target.push(trimmed);
  }
}

function appendKeyList(target: string[], value: string | null | undefined): void {
  const raw = (value || "").trim();
  if (!raw) return;
  for (const chunk of raw.split(",")) {
    appendUniqueKey(target, chunk);
  }
}

function getGeminiApiKeyPool(explicitKey?: string | null): string[] {
  const keys: string[] = [];
  appendKeyList(keys, explicitKey);
  appendKeyList(keys, process.env.GEMINI_API_KEYS);
  appendKeyList(keys, process.env.EXPO_PUBLIC_GEMINI_API_KEYS);
  appendUniqueKey(keys, process.env.GEMINI_API_KEY);
  appendUniqueKey(keys, process.env.GEMINI_API_KEY_1);
  appendUniqueKey(keys, process.env.GEMINI_API);
  appendUniqueKey(keys, process.env.GEMINI_API_KEY_2);
  appendUniqueKey(keys, process.env.GEMINI_API_KEY_3);
  appendUniqueKey(keys, process.env.GEMINI_SECONDARY_API_KEY);
  appendUniqueKey(keys, process.env.GEMINI_API_KEY_BACKUP);
  appendUniqueKey(keys, process.env.EXPO_PUBLIC_GEMINI_API_KEY);
  appendUniqueKey(keys, process.env.EXPO_PUBLIC_GEMINI_API_KEY_1);
  appendUniqueKey(keys, process.env.EXPO_PUBLIC_GEMINI_API_KEY_2);
  appendUniqueKey(keys, process.env.EXPO_PUBLIC_GEMINI_API_KEY_3);
  appendUniqueKey(keys, process.env.EXPO_PUBLIC_GEMINI_API);
  return keys;
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
      continue;
    }
    if (
      (chunk === "revup" ||
        chunk === "reverie" ||
        chunk === "reverieinc" ||
        chunk === "revup_asr" ||
        chunk === "reverie_asr") &&
      !providers.includes("revup")
    ) {
      providers.push("revup");
      continue;
    }
    if (
      (chunk === "assemblyai" ||
        chunk === "assembly_ai" ||
        chunk === "assembly") &&
      !providers.includes("assemblyai")
    ) {
      providers.push("assemblyai");
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
    providers.push("gemini", "revup", "assemblyai", "local_python", "huggingface");
  }
  if (providers.includes("gemini")) {
    return ["gemini", ...providers.filter((provider) => provider !== "gemini")];
  }
  if (providers.includes("revup")) {
    return ["revup", ...providers.filter((provider) => provider !== "revup")];
  }
  if (providers.includes("assemblyai")) {
    return ["assemblyai", ...providers.filter((provider) => provider !== "assemblyai")];
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

function toRevupTimeSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value > 1000 ? value / 1000 : value;
}

function extractRevupTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const row = payload as Record<string, unknown>;

  if (typeof row.text === "string" && row.text.trim()) {
    return row.text.trim();
  }
  if (typeof row.display_text === "string" && row.display_text.trim()) {
    return row.display_text.trim();
  }

  const textObjects = Array.isArray(row.text) ? row.text : [];
  if (textObjects.length) {
    const combined = textObjects
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const transcript = (item as Record<string, unknown>).transcript;
        return typeof transcript === "string" ? transcript.trim() : "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
    if (combined) return combined;
  }

  return extractTranscript(payload);
}

function extractRevupDiarizedEntries(payload: unknown): DiarizedTranscriptEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;
  const textObjects = Array.isArray(row.text) ? row.text : [];
  const entries: DiarizedTranscriptEntry[] = [];

  for (const item of textObjects) {
    if (!item || typeof item !== "object") continue;
    const segment = item as Record<string, unknown>;
    const transcript =
      typeof segment.transcript === "string" ? segment.transcript.trim() : "";
    if (!transcript) continue;

    const speakerRaw =
      typeof segment.channel_number === "number"
        ? String(segment.channel_number)
        : typeof segment.channel_number === "string"
          ? segment.channel_number.trim()
          : typeof segment.speaker === "string"
            ? segment.speaker.trim()
            : "";

    const words = Array.isArray(segment.words) ? segment.words : [];
    const firstWord =
      words.length && words[0] && typeof words[0] === "object"
        ? (words[0] as Record<string, unknown>)
        : null;
    const lastWord =
      words.length && words[words.length - 1] && typeof words[words.length - 1] === "object"
        ? (words[words.length - 1] as Record<string, unknown>)
        : null;

    const startTimeSeconds =
      toRevupTimeSeconds(segment.start_time) ??
      toRevupTimeSeconds(firstWord?.start_time);
    const endTimeSeconds =
      toRevupTimeSeconds(segment.end_time) ??
      toRevupTimeSeconds(lastWord?.end_time);

    entries.push({
      transcript,
      speakerId: speakerRaw || null,
      startTimeSeconds,
      endTimeSeconds,
    });
  }

  return entries;
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
  if (provider === "gemini") {
    return "Gemini STT quality varies with accent/noise and may not always include speaker separation.";
  }
  if (provider === "revup") {
    return "Revup STT response quality depends on selected source language and uploaded audio quality.";
  }
  if (provider === "local_python") {
    return "Local Python STT running on-device/server CPU. Accuracy and speed depend on model size and hardware.";
  }
  if (provider === "assemblyai") {
    return "AssemblyAI diarization labels depend on speaker separation quality and can vary for overlapping speech.";
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

async function callRevupModel(params: {
  audio: Buffer;
  mimeType: string;
  apiKey: string;
  appId: string;
  languageCode?: string;
  withDiarization?: boolean;
}): Promise<{
  transcript: string;
  latencyMs: number;
  diarizedTranscript?: { entries: DiarizedTranscriptEntry[] };
}> {
  const startedAt = Date.now();
  const endpoint = `${REVUP_API_BASE_URL}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVUP_TIMEOUT_MS);

  try {
    const form = new FormData();
    const audioExt = guessFileExtension(params.mimeType);
    form.append(
      "audio_file",
      new Blob([toBlobCompatiblePart(params.audio)], {
        type: params.mimeType || "application/octet-stream",
      }),
      `speech${audioExt}`
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "REV-API-KEY": params.apiKey,
        "REV-APP-ID": params.appId,
        "REV-APPNAME": REVUP_APP_NAME,
        src_lang: params.languageCode?.trim() || REVUP_DEFAULT_SOURCE_LANG,
        domain: REVUP_DEFAULT_DOMAIN,
      },
      body: form,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const payload = parseBody(bodyText);

    if (!response.ok) {
      throw new Speech2TextError(
        getErrorMessage(response.status, payload) || "Revup STT request failed.",
        response.status
      );
    }

    const successFlag =
      typeof (payload as Record<string, unknown> | null)?.success === "boolean"
        ? Boolean((payload as Record<string, unknown>).success)
        : true;
    if (!successFlag) {
      throw new Speech2TextError(getErrorMessage(502, payload) || "Revup STT request failed.", 502);
    }

    const transcript = extractRevupTranscript(payload);
    if (!transcript) {
      throw new Speech2TextError("Revup STT returned empty transcript.", 422);
    }

    const diarizedEntries = params.withDiarization
      ? extractRevupDiarizedEntries(payload)
      : [];
    const normalizedEntries =
      diarizedEntries.length > 0
        ? diarizedEntries
        : params.withDiarization
          ? [{ transcript, speakerId: null, startTimeSeconds: null, endTimeSeconds: null }]
          : [];

    return {
      transcript,
      latencyMs: Date.now() - startedAt,
      ...(normalizedEntries.length
        ? { diarizedTranscript: { entries: normalizedEntries } }
        : {}),
    };
  } catch (error) {
    if (error instanceof Speech2TextError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Speech2TextError("Revup STT request timed out.", 504);
    }
    const message =
      error instanceof Error ? error.message : "Revup STT failed unexpectedly.";
    throw new Speech2TextError(message, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function getAssemblySpeechModels(): string[] {
  const values = Array.from(new Set(DEFAULT_ASSEMBLYAI_SPEECH_MODELS));
  if (values.length) return values;
  return ["universal-2"];
}

function extractAssemblyDiarizedEntries(payload: unknown): DiarizedTranscriptEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;
  const utterances = Array.isArray(row.utterances) ? row.utterances : [];
  const entries: DiarizedTranscriptEntry[] = [];
  for (const item of utterances) {
    if (!item || typeof item !== "object") continue;
    const utterance = item as Record<string, unknown>;
    const transcript = typeof utterance.text === "string" ? utterance.text.trim() : "";
    if (!transcript) continue;
    const speakerId =
      typeof utterance.speaker === "string"
        ? utterance.speaker.trim()
        : typeof utterance.speaker === "number"
          ? String(utterance.speaker)
          : null;
    const startTimeSeconds =
      typeof utterance.start === "number"
        ? Math.max(0, utterance.start / 1000)
        : typeof utterance.start_time === "number"
          ? Math.max(0, utterance.start_time / 1000)
          : null;
    const endTimeSeconds =
      typeof utterance.end === "number"
        ? Math.max(0, utterance.end / 1000)
        : typeof utterance.end_time === "number"
          ? Math.max(0, utterance.end_time / 1000)
          : null;
    entries.push({
      transcript,
      speakerId,
      startTimeSeconds,
      endTimeSeconds,
    });
  }
  return entries;
}

function getAssemblyErrorMessage(error: unknown, fallback: string): {
  message: string;
  statusCode: number;
} {
  if (isAxiosError(error)) {
    const statusCode = Number(error.response?.status) || 502;
    const payload = error.response?.data;
    if (typeof payload !== "undefined") {
      return {
        message: getErrorMessage(statusCode, payload),
        statusCode,
      };
    }
    if (typeof error.message === "string" && error.message.trim()) {
      return {
        message: error.message.trim(),
        statusCode,
      };
    }
  }
  if (error instanceof Speech2TextError) {
    return {
      message: error.message,
      statusCode: error.statusCode,
    };
  }
  if (error instanceof Error && error.message.trim()) {
    return {
      message: error.message.trim(),
      statusCode: 502,
    };
  }
  return {
    message: fallback,
    statusCode: 502,
  };
}

async function callAssemblyAiModel(params: {
  audio: Buffer;
  mimeType: string;
  token: string;
  languageCode?: string;
  withDiarization?: boolean;
  numSpeakers?: number;
}): Promise<{
  transcript: string;
  latencyMs: number;
  diarizedTranscript?: { entries: DiarizedTranscriptEntry[] };
}> {
  const startedAt = Date.now();
  const authHeaders = {
    authorization: params.token,
  };

  let uploadUrl = "";
  try {
    const uploadResponse = await axios.post(
      `${ASSEMBLYAI_API_BASE_URL}/v2/upload`,
      params.audio,
      {
        headers: {
          ...authHeaders,
          "content-type": params.mimeType || "application/octet-stream",
        },
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );
    uploadUrl =
      typeof uploadResponse.data?.upload_url === "string"
        ? uploadResponse.data.upload_url.trim()
        : "";
  } catch (error) {
    const parsed = getAssemblyErrorMessage(error, "AssemblyAI upload failed.");
    throw new Speech2TextError(parsed.message, parsed.statusCode);
  }

  if (!uploadUrl) {
    throw new Speech2TextError("AssemblyAI upload failed: missing upload URL.", 502);
  }

  const transcriptPayload: Record<string, unknown> = {
    audio_url: uploadUrl,
    language_detection: !params.languageCode?.trim(),
    speech_models: getAssemblySpeechModels(),
    speaker_labels: Boolean(params.withDiarization),
  };
  if (params.languageCode?.trim()) {
    transcriptPayload.language_code = params.languageCode.trim().toLowerCase();
  }
  if (
    params.withDiarization &&
    typeof params.numSpeakers === "number" &&
    Number.isFinite(params.numSpeakers) &&
    params.numSpeakers > 0
  ) {
    transcriptPayload.speakers_expected = Math.max(1, Math.floor(params.numSpeakers));
  }

  let transcriptId = "";
  try {
    const response = await axios.post(
      `${ASSEMBLYAI_API_BASE_URL}/v2/transcript`,
      transcriptPayload,
      {
        headers: {
          ...authHeaders,
          "content-type": "application/json",
        },
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      }
    );
    transcriptId = typeof response.data?.id === "string" ? response.data.id.trim() : "";
  } catch (error) {
    const parsed = getAssemblyErrorMessage(error, "AssemblyAI transcript request failed.");
    throw new Speech2TextError(parsed.message, parsed.statusCode);
  }

  if (!transcriptId) {
    throw new Speech2TextError("AssemblyAI transcript request failed: missing transcript id.", 502);
  }

  const pollDeadline = Date.now() + ASSEMBLYAI_TIMEOUT_MS;

  while (Date.now() < pollDeadline) {
    try {
      const pollingResponse = await axios.get(
        `${ASSEMBLYAI_API_BASE_URL}/v2/transcript/${encodeURIComponent(transcriptId)}`,
        {
          headers: authHeaders,
          timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        }
      );
      const payload = pollingResponse.data;
      const status = typeof payload?.status === "string" ? payload.status.trim() : "";
      if (status === "completed") {
        const transcript =
          typeof payload?.text === "string" ? payload.text.trim() : extractTranscript(payload);
        if (!transcript) {
          throw new Speech2TextError("AssemblyAI STT returned empty transcript.", 422);
        }

        const diarizedEntries = params.withDiarization
          ? extractAssemblyDiarizedEntries(payload)
          : [];
        const normalizedDiarizedEntries = diarizedEntries.length
          ? diarizedEntries
          : params.withDiarization
            ? extractDiarizedEntries(payload)
            : [];

        return {
          transcript,
          latencyMs: Date.now() - startedAt,
          ...(normalizedDiarizedEntries.length
            ? { diarizedTranscript: { entries: normalizedDiarizedEntries } }
            : {}),
        };
      }
      if (status === "error") {
        const errorMessage =
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "AssemblyAI transcript job failed.";
        throw new Speech2TextError(errorMessage, 502);
      }
    } catch (error) {
      if (error instanceof Speech2TextError) {
        throw error;
      }
      const parsed = getAssemblyErrorMessage(error, "AssemblyAI transcript polling failed.");
      throw new Speech2TextError(parsed.message, parsed.statusCode);
    }
    await sleep(ASSEMBLYAI_POLL_INTERVAL_MS);
  }

  throw new Speech2TextError("AssemblyAI transcription timed out while polling.", 504);
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

async function callGeminiModel(params: {
  model: string;
  audio: Buffer;
  mimeType: string;
  apiKey: string;
  languageCode?: string;
  withDiarization?: boolean;
  withTimestamps?: boolean;
}): Promise<{
  transcript: string;
  latencyMs: number;
  diarizedTranscript?: { entries: DiarizedTranscriptEntry[] };
}> {
  const startedAt = Date.now();
  const endpoint =
    `${GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(params.model)}` +
    `:generateContent?key=${encodeURIComponent(params.apiKey)}`;
  const base64Audio = params.audio.toString("base64");
  const promptLines = [
    "Transcribe this audio accurately.",
    "Return only transcript text.",
    "Do not include markdown or explanations.",
  ];
  if (params.languageCode?.trim()) {
    promptLines.push(`Preferred language: ${params.languageCode.trim()}.`);
  }
  if (params.withTimestamps) {
    promptLines.push("If reliable, include lightweight timestamps inline.");
  }
  if (params.withDiarization) {
    promptLines.push("If speakers are clearly separable, include speaker labels.");
  }

  const bodyWithInlineData = (snakeCase = false) => ({
    contents: [
      {
        role: "user",
        parts: [
          { text: promptLines.join(" ") },
          snakeCase
            ? {
                inline_data: {
                  mime_type: params.mimeType,
                  data: base64Audio,
                },
              }
            : {
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
  });

  for (const useSnakeCase of [false, true]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bodyWithInlineData(useSnakeCase)),
          signal: controller.signal,
        });
        const text = await response.text();
        const payload = parseBody(text);

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
          throw new Speech2TextError("Gemini STT returned empty transcript.", 422);
        }

        const extractedDiarization = params.withDiarization
          ? extractDiarizedEntries(payload)
          : [];
        const normalizedDiarization =
          extractedDiarization.length > 0
            ? extractedDiarization
            : params.withDiarization
              ? [{ transcript, speakerId: null, startTimeSeconds: null, endTimeSeconds: null }]
              : [];
        return {
          transcript,
          latencyMs: Date.now() - startedAt,
          ...(normalizedDiarization.length
            ? { diarizedTranscript: { entries: normalizedDiarization } }
            : {}),
        };
      } catch (error) {
        if (attempt === 0 && error instanceof DOMException && error.name === "AbortError") {
          continue;
        }
        if (error instanceof Speech2TextError) throw error;
        const message =
          error instanceof Error ? error.message : "Gemini STT request failed.";
        throw new Speech2TextError(message, 502);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  throw new Speech2TextError("Gemini speech-to-text request timed out.", 504);
}

function shouldRotateGeminiKey(error: unknown): boolean {
  if (!(error instanceof Speech2TextError)) return false;
  const message = error.message.toLowerCase();
  if ([401, 403, 429].includes(error.statusCode)) return true;
  if (/\bquota\b|\brate\b|resource.*exhausted|billing|api key|permission|unauthorized/.test(message)) {
    return true;
  }
  return false;
}

async function runGeminiWithKeyRotation(params: {
  model: string;
  audio: Buffer;
  mimeType: string;
  apiKeys: string[];
  languageCode?: string;
  withDiarization?: boolean;
  withTimestamps?: boolean;
}): Promise<{
  transcript: string;
  model: string;
  fallbackUsed: boolean;
  latencyMs: number;
  warning?: string;
  diarizedTranscript?: { entries: DiarizedTranscriptEntry[] };
}> {
  const failures: string[] = [];
  for (let index = 0; index < params.apiKeys.length; index += 1) {
    const key = params.apiKeys[index];
    try {
      const result = await callGeminiModel({
        model: params.model,
        audio: params.audio,
        mimeType: params.mimeType,
        apiKey: key,
        languageCode: params.languageCode,
        withDiarization: params.withDiarization,
        withTimestamps: params.withTimestamps,
      });
      return {
        transcript: result.transcript,
        model: params.model,
        fallbackUsed: index > 0,
        latencyMs: result.latencyMs,
        warning:
          index > 0
            ? `Gemini backup key #${index + 1} activated after primary key failure.`
            : undefined,
        ...(result.diarizedTranscript ? { diarizedTranscript: result.diarizedTranscript } : {}),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Gemini STT failed unexpectedly.";
      failures.push(`key#${index + 1}: ${message}`);
      if (index < params.apiKeys.length - 1 && shouldRotateGeminiKey(error)) {
        continue;
      }
      if (index < params.apiKeys.length - 1 && !shouldRotateGeminiKey(error)) {
        continue;
      }
    }
  }

  throw new Speech2TextError(
    failures.join(" | ") || "Gemini STT failed for all configured API keys.",
    502
  );
}

export async function transcribeSpeechWithFairseqS2T(
  request: TranscribeRequest
): Promise<Speech2TextResult> {
  if (!request.audio || request.audio.length === 0) {
    throw new Speech2TextError("Audio payload is empty", 400);
  }

  const rawMimeType = request.mimeType?.trim().toLowerCase() || "audio/webm";
  const mimeType = rawMimeType === "audio/mp4" ? "audio/m4a" : rawMimeType;
  const geminiApiKeys = getGeminiApiKeyPool(request.geminiApiKey);
  const revupApiKey =
    request.revupApiKey?.trim() ||
    process.env.REVUP_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_REVUP_API_KEY?.trim() ||
    "";
  const revupAppId =
    request.revupAppId?.trim() ||
    process.env.REVUP_APP_ID?.trim() ||
    process.env.EXPO_PUBLIC_REVUP_APP_ID?.trim() ||
    "";
  const assemblyAiToken =
    request.assemblyAiApiKey?.trim() ||
    process.env.ASSEMBLYAI_API_KEY?.trim() ||
    process.env.EXPO_PUBLIC_ASSEMBLYAI_API_KEY?.trim() ||
    "";
  const hfToken =
    request.huggingFaceToken?.trim() ||
    process.env.HUGGINGFACE_API_KEY?.trim() ||
    process.env.HUGGINGFACE_TOKEN?.trim() ||
    "";

  const requestedModel = request.model?.trim() || "";
  const geminiModel = isLikelyGeminiModel(requestedModel)
    ? requestedModel
    : DEFAULT_GEMINI_STT_MODEL;
  const localModel = resolveLocalModel(requestedModel);
  const hfPrimaryModel =
    requestedModel && isLikelyHuggingFaceModel(requestedModel)
      ? requestedModel
      : DEFAULT_FAIRSEQ_S2T_MODEL;
  const hfFallbackModel = toModelId(request.fallbackModel, DEFAULT_FALLBACK_MODEL);
  const providerOrder = parseProviderOrder(request.provider?.trim() || DEFAULT_PROVIDER_ORDER);

  let geminiFailure: string | null = null;
  let revupFailure: string | null = null;
  let assemblyFailure: string | null = null;
  let localFailure: string | null = null;
  let huggingFaceFailure: string | null = null;

  for (const provider of providerOrder) {
    if (provider === "gemini") {
      if (!geminiApiKeys.length) {
        geminiFailure = "Gemini API key missing.";
        continue;
      }
      try {
        const result = await runGeminiWithKeyRotation({
          model: geminiModel,
          audio: request.audio,
          mimeType,
          apiKeys: geminiApiKeys,
          languageCode: request.languageCode?.trim() || "",
          withDiarization: Boolean(request.withDiarization),
          withTimestamps: request.withTimestamps ?? true,
        });
        return {
          transcript: result.transcript,
          provider: "gemini",
          model: result.model,
          fallbackUsed: result.fallbackUsed,
          warning: combineWarnings(
            revupFailure,
            assemblyFailure,
            localFailure,
            huggingFaceFailure,
            result.warning,
            getModelWarning("gemini", result.model)
          ),
          latencyMs: result.latencyMs,
          ...(result.diarizedTranscript ? { diarizedTranscript: result.diarizedTranscript } : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Gemini STT failed unexpectedly.";
        geminiFailure = message;
      }
      continue;
    }

    if (provider === "revup") {
      if (!revupApiKey || !revupAppId) {
        revupFailure = "Revup API key or app id missing.";
        continue;
      }
      try {
        const result = await callRevupModel({
          audio: request.audio,
          mimeType,
          apiKey: revupApiKey,
          appId: revupAppId,
          languageCode: request.languageCode?.trim() || "",
          withDiarization: Boolean(request.withDiarization),
        });
        return {
          transcript: result.transcript,
          provider: "revup",
          model: REVUP_APP_NAME,
          fallbackUsed: false,
          warning: combineWarnings(
            geminiFailure,
            assemblyFailure,
            localFailure,
            huggingFaceFailure,
            getModelWarning("revup", REVUP_APP_NAME)
          ),
          latencyMs: result.latencyMs,
          ...(result.diarizedTranscript ? { diarizedTranscript: result.diarizedTranscript } : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Revup STT failed unexpectedly.";
        revupFailure = message;
      }
      continue;
    }

    if (provider === "assemblyai") {
      if (!assemblyAiToken) {
        assemblyFailure = "AssemblyAI API key missing.";
        continue;
      }
      try {
        const result = await callAssemblyAiModel({
          audio: request.audio,
          mimeType,
          token: assemblyAiToken,
          languageCode: request.languageCode?.trim() || "",
          withDiarization: Boolean(request.withDiarization),
          numSpeakers:
            typeof request.numSpeakers === "number" && Number.isFinite(request.numSpeakers)
              ? request.numSpeakers
              : undefined,
        });
        return {
          transcript: result.transcript,
          provider: "assemblyai",
          model: getAssemblySpeechModels().join(","),
          fallbackUsed: false,
          warning: combineWarnings(
            geminiFailure,
            revupFailure,
            localFailure,
            huggingFaceFailure,
            getModelWarning("assemblyai", getAssemblySpeechModels().join(","))
          ),
          latencyMs: result.latencyMs,
          ...(result.diarizedTranscript ? { diarizedTranscript: result.diarizedTranscript } : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AssemblyAI STT failed unexpectedly.";
        assemblyFailure = message;
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
          warning: combineWarnings(
            geminiFailure,
            revupFailure,
            assemblyFailure,
            getModelWarning("local_python", localModel)
          ),
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
        warning: combineWarnings(
          geminiFailure,
          revupFailure,
          assemblyFailure,
          localFailure,
          hfResult.warning
        ),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "HuggingFace STT failed unexpectedly.";
      huggingFaceFailure = message;
    }
  }

  throw new Speech2TextError(
    combineWarnings(geminiFailure, revupFailure, assemblyFailure, localFailure, huggingFaceFailure) ||
      "All speech-to-text providers failed.",
    502
  );
}
