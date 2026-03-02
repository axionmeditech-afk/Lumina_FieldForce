import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import Colors from "@/constants/colors";
import { getApiBaseUrlCandidates } from "@/lib/attendance-api";
import {
  addAuditLog,
  addConversation,
  getConversations,
} from "@/lib/storage";
import { buildConversationFromTranscript } from "@/lib/sales-analysis";
import type { Conversation } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";

type SpeechRecognitionEventName =
  | "start"
  | "result"
  | "audioend"
  | "error"
  | "end"
  | "volumechange";
type SpeechRecognitionEventPayload = {
  isFinal?: boolean;
  message?: string;
  uri?: string;
  value?: number;
  results?: { transcript?: string }[];
};
type SpeechRecognitionHook = (
  eventName: SpeechRecognitionEventName,
  handler: (event: SpeechRecognitionEventPayload) => void
) => void;
type RecordingMode = "speech" | "audio-fallback";
const FALLBACK_SEGMENT_MS = 5000;
const FALLBACK_POLL_MS = 250;
const TRANSCRIBE_LOADING_RETRY_DELAY_MS = 800;
const DIRECT_TRANSCRIBE_RETRY_DELAY_MS = 900;
const VOICE_WAVE_BAR_COUNT = 31;
const RECORDING_UNAVAILABLE_MESSAGE = "Recording is not available right now. Please try again.";
const VOICE_PULSE_BASELINE = Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => {
  const center = (VOICE_WAVE_BAR_COUNT - 1) / 2;
  const distance = Math.abs(index - center) / center;
  return Math.max(0.15, 1 - distance);
});

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeSpeechRmsValue(rmsValue: number): number {
  // expo-speech-recognition emits roughly [-2..10] where <=0 is close to silence.
  if (!Number.isFinite(rmsValue)) return 0;
  const normalized = (rmsValue + 2) / 12;
  // Slight curve so speech peaks pop while low noise remains subdued.
  return clamp01(Math.pow(clamp01(normalized), 0.8));
}

function normalizeMeteringDbValue(dbValue: number): number {
  // expo-av metering is usually [-160..0] dBFS.
  if (!Number.isFinite(dbValue)) return 0;
  const normalized = (dbValue + 60) / 60;
  return clamp01(Math.pow(clamp01(normalized), 1.2));
}

function buildVoicePulseBars(frame: number, level: number, peak: number, hasRecentVoice: boolean): number[] {
  const center = (VOICE_WAVE_BAR_COUNT - 1) / 2;
  const floor = hasRecentVoice ? 0.08 : 0.04;
  const dynamicRange = hasRecentVoice ? 0.22 + level * 1.05 : 0.12 + level * 0.5;
  return VOICE_PULSE_BASELINE.map((base, index) => {
    const phase = frame * (hasRecentVoice ? 0.34 : 0.22) + index * 0.52;
    const ripple = (Math.sin(phase) + 1) / 2;
    const envelope = 0.32 + 0.68 * base;
    const centerWeight = 1 - Math.min(1, Math.abs(index - center) / center);
    const peakBoost = peak * (0.3 + 0.7 * centerWeight);
    const value = floor + dynamicRange * envelope * (0.54 + 0.46 * ripple) + peakBoost * 0.36;
    return clamp01(value);
  });
}

const speechPackage: any = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional runtime import avoids route crash when native module is unavailable
    return require("expo-speech-recognition");
  } catch {
    return null;
  }
})();

const ExpoSpeechRecognitionModule: any = speechPackage?.ExpoSpeechRecognitionModule ?? null;
const useSpeechRecognitionEvent: SpeechRecognitionHook =
  speechPackage?.useSpeechRecognitionEvent ?? (() => {});
const DEFAULT_S2T_MODEL =
  (process.env.EXPO_PUBLIC_HF_S2T_MODEL || "facebook/s2t-small-librispeech-asr").trim();
const DEFAULT_S2T_FALLBACK_MODEL =
  (process.env.EXPO_PUBLIC_HF_S2T_FALLBACK_MODEL || "distil-whisper/distil-small.en").trim();
const HF_INFERENCE_BASE_URL = (
  process.env.EXPO_PUBLIC_HF_INFERENCE_BASE_URL ||
  "https://router.huggingface.co/hf-inference/models"
).trim().replace(/\/+$/, "");
const GEMINI_API_BASE_URL = (
  process.env.EXPO_PUBLIC_GEMINI_API_BASE_URL || "https://generativelanguage.googleapis.com"
).trim().replace(/\/+$/, "");
const DEFAULT_GEMINI_STT_MODEL = (
  process.env.EXPO_PUBLIC_GEMINI_STT_MODEL ||
  process.env.EXPO_PUBLIC_GEMINI_MODEL ||
  "gemini-2.5-flash"
).trim();
const ALLOW_HF_STT_FALLBACK =
  String(process.env.EXPO_PUBLIC_ALLOW_HF_STT_FALLBACK || "false").toLowerCase() === "true";
let preferredSpeechApiBase: string | null = null;

function normalizeProviderOrder(input: string): string {
  const chunks = input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const mapped: string[] = [];
  for (const chunk of chunks) {
    if (
      (chunk === "gemini" || chunk === "google" || chunk === "google_gemini") &&
      !mapped.includes("gemini")
    ) {
      mapped.push("gemini");
      continue;
    }
    if (
      (chunk === "local" || chunk === "python" || chunk === "local_python") &&
      !mapped.includes("local_python")
    ) {
      mapped.push("local_python");
      continue;
    }
    if ((chunk === "hf" || chunk === "huggingface") && !mapped.includes("huggingface")) {
      mapped.push("huggingface");
    }
  }
  if (!mapped.length) {
    return "gemini,local_python,huggingface";
  }
  const reordered = mapped.includes("gemini")
    ? ["gemini", ...mapped.filter((provider) => provider !== "gemini")]
    : mapped;
  return reordered.join(",");
}

const DEFAULT_STT_PROVIDER_ORDER = normalizeProviderOrder(
  (process.env.EXPO_PUBLIC_STT_PROVIDER_ORDER || "gemini,local_python,huggingface").trim()
);

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSpeechPayload(body: string): any {
  const value = body?.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { message: value };
  }
}

function isSpeechRecordingStartFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("start encountered an error") ||
    lower.includes("recording not started") ||
    lower.includes("audio recorder") ||
    lower.includes("speech recognition unavailable")
  );
}

function detectAudioMimeType(audioUri: string): string {
  const lower = audioUri.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".3gp")) return "audio/3gpp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".webm")) return "audio/webm";
  return "application/octet-stream";
}

async function persistConversationAudioUri(audioUri: string | null): Promise<string | null> {
  if (!audioUri) return null;
  try {
    if (!audioUri.startsWith("file://")) {
      return audioUri;
    }

    const info = await FileSystem.getInfoAsync(audioUri);
    if (!info.exists) return audioUri;

    const baseDir = `${FileSystem.documentDirectory || FileSystem.cacheDirectory}conversation-audio`;
    await FileSystem.makeDirectoryAsync(baseDir, { intermediates: true }).catch(() => {});

    const extMatch = audioUri.match(/\.[a-z0-9]+(?:\?.*)?$/i);
    const ext = extMatch ? extMatch[0].replace(/\?.*$/, "") : ".m4a";
    const targetUri = `${baseDir}/conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    await FileSystem.copyAsync({
      from: audioUri,
      to: targetUri,
    });
    return targetUri;
  } catch {
    return audioUri;
  }
}

async function uploadSpeechAudio(endpoint: string, audioUri: string): Promise<{ status: number; payload: any }> {
  return uploadSpeechAudioWithHeaders(endpoint, audioUri);
}

async function uploadSpeechAudioWithHeaders(
  endpoint: string,
  audioUri: string,
  headers?: Record<string, string>
): Promise<{ status: number; payload: any }> {
  const uploadResult = await FileSystem.uploadAsync(endpoint, audioUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Accept: "application/json",
      "Content-Type": detectAudioMimeType(audioUri),
      ...(headers || {}),
    },
  });
  return {
    status: uploadResult.status,
    payload: parseSpeechPayload(uploadResult.body || ""),
  };
}

async function uploadSpeechAudioMultipart(
  endpoint: string,
  audioUri: string,
  options?: {
    headers?: Record<string, string>;
    parameters?: Record<string, string>;
    fieldName?: string;
  }
): Promise<{ status: number; payload: any }> {
  const uploadResult = await FileSystem.uploadAsync(endpoint, audioUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: options?.fieldName || "file",
    mimeType: detectAudioMimeType(audioUri),
    parameters: options?.parameters || {},
    headers: {
      Accept: "application/json",
      ...(options?.headers || {}),
    },
  });
  return {
    status: uploadResult.status,
    payload: parseSpeechPayload(uploadResult.body || ""),
  };
}

function extractTranscriptFromPayload(payload: any): string {
  if (typeof payload?.transcript === "string" && payload.transcript.trim()) {
    return payload.transcript.trim();
  }
  if (typeof payload?.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  if (Array.isArray(payload) && typeof payload[0]?.generated_text === "string") {
    return String(payload[0].generated_text).trim();
  }
  if (Array.isArray(payload?.candidates)) {
    const combined = payload.candidates
      .map((candidate: any) => {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        return parts
          .map((part: any) => (typeof part?.text === "string" ? part.text.trim() : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (combined) return combined;
  }
  return "";
}

type DiarizedEntry = {
  transcript: string;
  speakerId?: string | null;
  startTimeSeconds?: number | null;
  endTimeSeconds?: number | null;
};

function extractDiarizedEntriesFromPayload(payload: any): DiarizedEntry[] {
  const root = payload?.diarizedTranscript || payload?.diarized_transcript;
  const entries = Array.isArray(root?.entries) ? root.entries : [];
  const out: DiarizedEntry[] = [];
  for (const item of entries) {
    const transcript = typeof item?.transcript === "string" ? item.transcript.trim() : "";
    if (!transcript) continue;
    out.push({
      transcript,
      speakerId:
        typeof item?.speakerId === "string"
          ? item.speakerId.trim()
          : typeof item?.speaker_id === "string"
            ? item.speaker_id.trim()
            : null,
      startTimeSeconds:
        typeof item?.startTimeSeconds === "number"
          ? item.startTimeSeconds
          : typeof item?.start_time_seconds === "number"
            ? item.start_time_seconds
            : null,
      endTimeSeconds:
        typeof item?.endTimeSeconds === "number"
          ? item.endTimeSeconds
          : typeof item?.end_time_seconds === "number"
            ? item.end_time_seconds
            : null,
    });
  }
  return out;
}

function formatDiarizedTranscript(entries: DiarizedEntry[]): string {
  const toTime = (seconds: number | null | undefined): string => {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  return entries
    .map((entry) => {
      const speaker = entry.speakerId?.trim() || "unknown";
      const start = toTime(entry.startTimeSeconds);
      const end = toTime(entry.endTimeSeconds);
      const timeRange = start || end ? ` [${start || "--:--"}-${end || "--:--"}]` : "";
      return `Speaker ${speaker}${timeRange}: ${entry.transcript}`;
    })
    .join("\n");
}

function getHuggingFaceEnvToken(): string {
  return (
    process.env.EXPO_PUBLIC_HUGGINGFACE_API_KEY ||
    process.env.EXPO_PUBLIC_HF_API_KEY ||
    process.env.EXPO_PUBLIC_HF_TOKEN ||
    ""
  ).trim();
}

function getGeminiEnvToken(): string {
  return (
    process.env.EXPO_PUBLIC_GEMINI_API_KEY ||
    process.env.EXPO_PUBLIC_GEMINI_API ||
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_API ||
    ""
  ).trim();
}

function uniqModels(...models: string[]): string[] {
  const items = models.map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(items));
}

async function transcribeAudioWithDirectHuggingFace(audioUri: string, token: string): Promise<string> {
  const models = uniqModels(DEFAULT_S2T_MODEL, DEFAULT_S2T_FALLBACK_MODEL);
  let lastError = "";

  for (const model of models) {
    const endpoint = `${HF_INFERENCE_BASE_URL}/${encodeURIComponent(model)}?wait_for_model=true`;
    try {
      let { status, payload } = await uploadSpeechAudioWithHeaders(endpoint, audioUri, {
        Authorization: `Bearer ${token}`,
      });

      if (
        (status < 200 || status >= 300) &&
        typeof payload?.error === "string" &&
        /loading|currently loading|cold start/i.test(payload.error)
      ) {
        await wait(TRANSCRIBE_LOADING_RETRY_DELAY_MS);
        ({ status, payload } = await uploadSpeechAudioWithHeaders(endpoint, audioUri, {
          Authorization: `Bearer ${token}`,
        }));
      }

      if (status < 200 || status >= 300) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : typeof payload?.message === "string"
              ? payload.message
              : `HuggingFace request failed (${status})`;
        if (status === 401 || status === 403) {
          throw new Error("HuggingFace token invalid or unauthorized.");
        }
        if (status === 429) {
          throw new Error(`HuggingFace rate/quota limit hit: ${message}`);
        }
        throw new Error(message);
      }

      const transcript = extractTranscriptFromPayload(payload);
      if (transcript) return transcript;
      lastError = "HuggingFace direct response returned an empty transcript.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "HuggingFace direct transcription failed.";
    }
  }

  throw new Error(lastError || "HuggingFace direct transcription failed.");
}

async function transcribeAudioWithDirectGemini(audioUri: string, apiKey: string): Promise<string> {
  const models = uniqModels(DEFAULT_GEMINI_STT_MODEL, (process.env.EXPO_PUBLIC_GEMINI_MODEL || "").trim(), "gemini-2.5-flash", "gemini-2.5-flash-lite");
  const mimeType = detectAudioMimeType(audioUri);
  const audioBase64 = await FileSystem.readAsStringAsync(audioUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!audioBase64?.trim()) {
    throw new Error("Gemini direct transcription failed: audio file was empty.");
  }

  const buildRequestBody = (useSnakeCaseInlineData: boolean) => ({
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe this audio accurately. Return only transcript text. " +
              "Do not include markdown or extra explanation.",
          },
          useSnakeCaseInlineData
            ? {
                inline_data: {
                  mime_type: mimeType,
                  data: audioBase64,
                },
              }
            : {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                },
              },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
    },
  });

  let lastError = "";
  for (const model of models) {
    const endpoint =
      `${GEMINI_API_BASE_URL}/v1beta/models/${encodeURIComponent(model)}` +
      `:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (const useSnakeCaseInlineData of [false, true]) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(buildRequestBody(useSnakeCaseInlineData)),
          });

          const rawText = await response.text();
          const payload = parseSpeechPayload(rawText || "");
          if (!response.ok) {
            const errorMessage =
              typeof payload?.error?.message === "string"
                ? payload.error.message
                : typeof payload?.message === "string"
                  ? payload.message
                  : `Gemini request failed (${response.status})`;
            const retryable =
              [408, 425, 429, 500, 502, 503, 504].includes(response.status) ||
              /loading|cold start|try again|timeout|temporarily unavailable/i.test(errorMessage);
            if (attempt === 0 && retryable) {
              await wait(DIRECT_TRANSCRIBE_RETRY_DELAY_MS);
              continue;
            }
            lastError = errorMessage;
            break;
          }

          const transcript = extractTranscriptFromPayload(payload);
          if (transcript) return transcript;
          lastError = "Gemini direct response returned an empty transcript.";
          break;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Gemini direct transcription failed.";
          const retryable = /network request failed|timeout|failed to fetch|econn|enotfound/i.test(
            message.toLowerCase()
          );
          if (attempt === 0 && retryable) {
            await wait(DIRECT_TRANSCRIBE_RETRY_DELAY_MS);
            continue;
          }
          lastError = message;
          break;
        }
      }
    }
  }

  throw new Error(lastError || "Gemini direct transcription failed.");
}

async function transcribeAudioWithSpeechApi(audioUri: string): Promise<string> {
  const query = new URLSearchParams({
    model: DEFAULT_S2T_MODEL,
    provider: DEFAULT_STT_PROVIDER_ORDER,
    with_timestamps: "0",
    mode: "fast",
  });
  if (DEFAULT_S2T_FALLBACK_MODEL) {
    query.set("fallback_model", DEFAULT_S2T_FALLBACK_MODEL);
  }

  const apiBaseCandidates = await getApiBaseUrlCandidates();
  const orderedApiBaseCandidates = preferredSpeechApiBase
    ? [
        preferredSpeechApiBase,
        ...apiBaseCandidates.filter((apiBase) => apiBase !== preferredSpeechApiBase),
      ]
    : apiBaseCandidates;
  let lastNonNetworkError = "";
  const networkErrors: string[] = [];

  for (const apiBase of orderedApiBaseCandidates) {
    const endpoint = `${apiBase}/speech/transcribe?${query.toString()}`;
    try {
      let { status, payload } = await uploadSpeechAudio(endpoint, audioUri);

      if (
        (status < 200 || status >= 300) &&
        typeof payload?.message === "string" &&
        /loading|cold start|timed out/i.test(payload.message)
      ) {
        await wait(TRANSCRIBE_LOADING_RETRY_DELAY_MS);
        ({ status, payload } = await uploadSpeechAudio(endpoint, audioUri));
      }

      if (status < 200 || status >= 300) {
        const apiError =
          typeof payload?.message === "string"
            ? payload.message
            : typeof payload?.error === "string"
              ? payload.error
              : `Speech transcription failed (${status}).`;
        const msg = /quota|credit|billing|limit|rate/i.test(apiError)
          ? `Speech provider usage/quota issue: ${apiError}`
          : `Speech-to-text error: ${apiError}`;
        throw new Error(msg);
      }

      const diarizedEntries = extractDiarizedEntriesFromPayload(payload);
      const transcript = diarizedEntries.length
        ? formatDiarizedTranscript(diarizedEntries)
        : typeof payload?.transcript === "string"
          ? payload.transcript.trim()
          : typeof payload?.text === "string"
            ? payload.text.trim()
            : Array.isArray(payload) && typeof payload[0]?.generated_text === "string"
              ? String(payload[0].generated_text).trim()
            : "";

      if (!transcript) {
        throw new Error("Speech-to-text service returned an empty transcript.");
      }

      preferredSpeechApiBase = apiBase;
      return transcript;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Speech-to-text request failed unexpectedly.";
      if (/network request failed|failed to fetch|econn|enotfound|timed out/i.test(message)) {
        if (preferredSpeechApiBase === apiBase) {
          preferredSpeechApiBase = null;
        }
        networkErrors.push(`${apiBase} -> ${message}`);
        continue;
      }
      lastNonNetworkError = message;
      break;
    }
  }

  if (lastNonNetworkError) {
    const geminiToken = getGeminiEnvToken();
    if (geminiToken) {
      try {
        return await transcribeAudioWithDirectGemini(audioUri, geminiToken);
      } catch (directGeminiError) {
        const message =
          directGeminiError instanceof Error ? directGeminiError.message : "Direct Gemini fallback failed.";
        lastNonNetworkError = `${lastNonNetworkError} | Direct Gemini fallback failed: ${message}`;
      }
    }

    const hfToken = getHuggingFaceEnvToken();
    if (ALLOW_HF_STT_FALLBACK && hfToken) {
      try {
        return await transcribeAudioWithDirectHuggingFace(audioUri, hfToken);
      } catch (directError) {
        const message =
          directError instanceof Error ? directError.message : "Direct fallback failed.";
        throw new Error(`${lastNonNetworkError} | Direct HF fallback failed: ${message}`);
      }
    }
    throw new Error(lastNonNetworkError);
  }
  if (networkErrors.length) {
    const geminiToken = getGeminiEnvToken();
    if (geminiToken) {
      try {
        return await transcribeAudioWithDirectGemini(audioUri, geminiToken);
      } catch (directGeminiError) {
        const message =
          directGeminiError instanceof Error ? directGeminiError.message : "Direct Gemini fallback failed.";
        networkErrors.push(`Direct Gemini fallback failed: ${message}`);
      }
    }

    const hfToken = getHuggingFaceEnvToken();
    if (ALLOW_HF_STT_FALLBACK && hfToken) {
      try {
        return await transcribeAudioWithDirectHuggingFace(audioUri, hfToken);
      } catch (directError) {
        const message =
          directError instanceof Error ? directError.message : "Direct fallback failed.";
        throw new Error(
          `Server is not reachable. Tried: ${networkErrors.join(
            " | "
          )}. Direct HF fallback failed: ${message}`
        );
      }
    }
    throw new Error(
      `Server is not reachable. Check API URL. Tried: ${networkErrors.join(" | ")}`
    );
  }
  throw new Error("Speech-to-text service unavailable.");
}

function ScoreBadge({ score, size = 40 }: { score: number; size?: number }) {
  const color = score >= 80 ? "#22C55E" : score >= 60 ? "#F59E0B" : "#EF4444";
  return (
    <View style={[styles.scoreBadge, { width: size, height: size, borderColor: color + "40" }]}>
      <Text style={[styles.scoreText, { color, fontSize: size * 0.35, fontFamily: "Inter_700Bold" }]}>
        {score}
      </Text>
    </View>
  );
}

function ConversationCard({
  conversation,
  colors,
}: {
  conversation: Conversation;
  colors: typeof Colors.light;
}) {
  const sentimentColor =
    conversation.sentiment === "positive" ? colors.success :
    conversation.sentiment === "neutral" ? colors.warning : colors.danger;

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        router.push({ pathname: "/conversation/[id]", params: { id: conversation.id } });
      }}
      style={({ pressed }) => [
        styles.convoCard,
        { backgroundColor: colors.backgroundElevated, borderColor: colors.border, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      <View style={styles.convoHeader}>
        <View style={styles.convoHeaderLeft}>
          <Text style={[styles.customerName, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            {conversation.customerName}
          </Text>
          <Text style={[styles.salesperson, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {conversation.salespersonName} - {conversation.duration}
          </Text>
        </View>
        <View style={styles.convoHeaderRight}>
          {conversation.source === "recorded" ? (
            <View style={[styles.sourcePill, { backgroundColor: colors.secondary + "1A" }]}>
              <Text style={[styles.sourcePillText, { color: colors.secondary, fontFamily: "Inter_600SemiBold" }]}>
                REC
              </Text>
            </View>
          ) : null}
          <ScoreBadge score={conversation.interestScore} />
        </View>
      </View>

      <Text
        numberOfLines={2}
        style={[styles.summary, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
      >
        {conversation.summary}
      </Text>

      <View style={styles.convoFooter}>
        <View style={[styles.sentimentChip, { backgroundColor: sentimentColor + "15" }]}>
          <View style={[styles.sentimentDot, { backgroundColor: sentimentColor }]} />
          <Text style={[styles.sentimentText, { color: sentimentColor, fontFamily: "Inter_500Medium" }]}>
            {conversation.sentiment}
          </Text>
        </View>
        <View style={[styles.intentChip, { backgroundColor: colors.primary + "10" }]}>
          <Text style={[styles.intentText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
            {conversation.buyingIntent} intent
          </Text>
        </View>
        <Text style={[styles.dateText, { color: colors.textTertiary, fontFamily: "Inter_400Regular" }]}>
          {new Date(conversation.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </Text>
      </View>
    </Pressable>
  );
}

export default function SalesScreen() {
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const { user, company } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribingFile, setIsTranscribingFile] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recognitionAvailable, setRecognitionAvailable] = useState(true);
  const [requestBusy, setRequestBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [voicePulseBars, setVoicePulseBars] = useState<number[]>(VOICE_PULSE_BASELINE);
  const [voicePulseState, setVoicePulseState] = useState<"idle" | "listening" | "speaking">("idle");

  const finalSegmentsRef = useRef<string[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const sessionModeRef = useRef<"idle" | "recording" | "file" | "audio-fallback">("idle");
  const recordingModeRef = useRef<RecordingMode | null>(null);
  const fallbackRecordingRef = useRef<Audio.Recording | null>(null);
  const fallbackLoopRunningRef = useRef(false);
  const fallbackStopRequestedRef = useRef(false);
  const fallbackChunkIndexRef = useRef(0);
  const fallbackNextChunkToApplyRef = useRef(0);
  const fallbackChunkBufferRef = useRef<Map<number, string>>(new Map());
  const fallbackTranscribeTasksRef = useRef<Set<Promise<void>>>(new Set());
  const startFallbackRecordingRef = useRef<(() => Promise<void>) | null>(null);
  const voiceDetectedUntilRef = useRef(0);
  const voicePulseFrameRef = useRef(0);
  const voiceLevelRef = useRef(0);
  const voicePeakRef = useRef(0);
  const voiceLastInputAtRef = useRef(0);

  const markVoiceDetected = useCallback(() => {
    voiceDetectedUntilRef.current = Date.now() + 1400;
  }, []);

  const updateVoicePulseInput = useCallback(
    (normalizedLevel: number) => {
      const nextInput = clamp01(normalizedLevel);
      const previous = voiceLevelRef.current;
      const smoothing = nextInput > previous ? 0.86 : 0.2;
      const smoothed = previous + (nextInput - previous) * smoothing;
      voiceLevelRef.current = clamp01(smoothed);
      voiceLastInputAtRef.current = Date.now();
      if (voiceLevelRef.current > voicePeakRef.current) {
        voicePeakRef.current = voiceLevelRef.current;
      }
      if (voiceLevelRef.current > 0.08) {
        markVoiceDetected();
      }
    },
    [markVoiceDetected]
  );

  const loadData = useCallback(async () => {
    const convos = await getConversations();
    if (!user) {
      setConversations([]);
      return;
    }
    if (user.role === "admin") {
      setConversations(convos);
      return;
    }
    const visible = convos.filter(
      (conversation) =>
        conversation.salespersonId === user.id || conversation.salespersonName === user.name
    );
    setConversations(visible);
  }, [user]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const available = Boolean(
      ExpoSpeechRecognitionModule?.isRecognitionAvailable &&
        ExpoSpeechRecognitionModule.isRecognitionAvailable()
    );
    setRecognitionAvailable(available);
  }, []);

  useEffect(() => {
    if (!isRecording || startedAtRef.current === null) return;
    const timer = setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording) {
      voicePulseFrameRef.current = 0;
      voiceDetectedUntilRef.current = 0;
      voiceLevelRef.current = 0;
      voicePeakRef.current = 0;
      voiceLastInputAtRef.current = 0;
      setVoicePulseState("idle");
      setVoicePulseBars(VOICE_PULSE_BASELINE);
      return;
    }

    setVoicePulseState("listening");
    const tick = () => {
      voicePulseFrameRef.current += 1;
      const now = Date.now();
      const msSinceInput = now - voiceLastInputAtRef.current;
      if (msSinceInput > 120) {
        const decay = msSinceInput > 600 ? 0.78 : 0.88;
        voiceLevelRef.current *= decay;
      }
      voicePeakRef.current = Math.max(voiceLevelRef.current, voicePeakRef.current * 0.96);
      const hasRecentVoice =
        now <= voiceDetectedUntilRef.current || voicePeakRef.current > 0.1;
      setVoicePulseState(hasRecentVoice ? "speaking" : "listening");
      setVoicePulseBars(
        buildVoicePulseBars(
          voicePulseFrameRef.current,
          voiceLevelRef.current,
          voicePeakRef.current,
          hasRecentVoice
        )
      );
    };

    tick();
    const timer = setInterval(tick, 70);
    return () => clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    return () => {
      fallbackLoopRunningRef.current = false;
      fallbackStopRequestedRef.current = true;
      try {
        ExpoSpeechRecognitionModule?.abort?.();
      } catch {
        // no-op
      }
      if (fallbackRecordingRef.current) {
        void fallbackRecordingRef.current.stopAndUnloadAsync().catch(() => {});
        fallbackRecordingRef.current = null;
      }
    };
  }, []);

  const appendTranscriptSegment = useCallback((segment: string) => {
    const value = segment.trim();
    if (!value) return;
    const previous = finalSegmentsRef.current[finalSegmentsRef.current.length - 1];
    if (value !== previous) {
      finalSegmentsRef.current = [...finalSegmentsRef.current, value];
    }
    setTranscriptDraft(finalSegmentsRef.current.join(" ").trim());
  }, []);

  useSpeechRecognitionEvent("start", () => {
    voicePulseFrameRef.current = 0;
    voiceDetectedUntilRef.current = 0;
    voiceLevelRef.current = 0;
    voicePeakRef.current = 0;
    voiceLastInputAtRef.current = Date.now();
    if (sessionModeRef.current === "file") {
      setIsTranscribingFile(true);
    } else {
      setIsRecording(true);
    }
  });

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results?.[0]?.transcript?.trim() ?? "";
    if (!transcript) return;
    markVoiceDetected();

    if (event.isFinal) {
      appendTranscriptSegment(transcript);
      setInterimTranscript("");
      return;
    }

    setInterimTranscript(transcript);
    const merged = [...finalSegmentsRef.current, transcript].join(" ").trim();
    setTranscriptDraft(merged);
  });

  useSpeechRecognitionEvent("volumechange", (event) => {
    const rawValue = typeof event.value === "number" ? event.value : Number.NaN;
    if (!Number.isFinite(rawValue)) return;
    updateVoicePulseInput(normalizeSpeechRmsValue(rawValue));
  });

  useSpeechRecognitionEvent("audioend", (event) => {
    if (event.uri) {
      setAudioUri(event.uri);
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    const message = event.message || "Transcription failed. Please try again.";
    const shouldAutoFallback =
      recordingModeRef.current === "speech" &&
      sessionModeRef.current === "recording" &&
      isSpeechRecordingStartFailure(message);

    if (shouldAutoFallback) {
      setRecordError("Recording is not available right now. Switching to backup recorder...");
      try {
        ExpoSpeechRecognitionModule?.abort?.();
      } catch {
        // no-op
      }
      recordingModeRef.current = null;
      sessionModeRef.current = "idle";
      setIsRecording(false);
      void (async () => {
        try {
          if (fallbackLoopRunningRef.current) return;
          await (startFallbackRecordingRef.current?.() ?? Promise.resolve());
          setRecordError(null);
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : "Fallback recording could not start.";
          setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
        }
      })();
      return;
    }

    setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
  });

  useSpeechRecognitionEvent("end", () => {
    if (startedAtRef.current !== null) {
      setElapsedMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
    setIsRecording(false);
    setIsTranscribingFile(false);
    sessionModeRef.current = "idle";
    recordingModeRef.current = null;
  });

  const avgInterest = conversations.length > 0
    ? Math.round(conversations.reduce((sum, convo) => sum + convo.interestScore, 0) / conversations.length)
    : 0;
  const avgPitch = conversations.length > 0
    ? Math.round(conversations.reduce((sum, convo) => sum + convo.pitchScore, 0) / conversations.length)
    : 0;

  const liveTranscript = useMemo(() => {
    return transcriptDraft || interimTranscript;
  }, [interimTranscript, transcriptDraft]);

  const transcribeWithFallbackApi = useCallback(
    async (
      uri: string,
      options?: { append?: boolean; silent?: boolean; setBusy?: boolean }
    ): Promise<string | null> => {
      const shouldAppend = Boolean(options?.append);
      const silent = Boolean(options?.silent);
      const setBusy = options?.setBusy ?? true;
      if (setBusy) setIsTranscribingFile(true);
      setRecordError(null);
      try {
        const transcript = await transcribeAudioWithSpeechApi(uri);
        if (shouldAppend) {
          appendTranscriptSegment(transcript);
          setInterimTranscript("Listening...");
        } else {
          finalSegmentsRef.current = transcript ? [transcript] : [];
          setTranscriptDraft(transcript);
          setInterimTranscript("");
        }
        if (!silent) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        return transcript;
      } catch (error) {
        setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
        if (!silent) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
        return null;
      } finally {
        if (setBusy) setIsTranscribingFile(false);
      }
    },
    [appendTranscriptSegment]
  );

  const startFallbackRecording = useCallback(async () => {
    if (fallbackLoopRunningRef.current) return;

    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      if (!permission.canAskAgain) {
        Alert.alert(
          "Microphone Permission Blocked",
          "Please enable microphone permission from settings.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ]
        );
      } else {
        Alert.alert("Permission Required", "Microphone permission is required to record conversation.");
      }
      return;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      staysActiveInBackground: false,
    });
    fallbackLoopRunningRef.current = true;
    fallbackStopRequestedRef.current = false;
    fallbackChunkIndexRef.current = 0;
    fallbackNextChunkToApplyRef.current = 0;
    fallbackChunkBufferRef.current.clear();
    fallbackTranscribeTasksRef.current.clear();
    recordingModeRef.current = "audio-fallback";
    sessionModeRef.current = "audio-fallback";
    voicePulseFrameRef.current = 0;
    voiceDetectedUntilRef.current = 0;
    voiceLevelRef.current = 0;
    voicePeakRef.current = 0;
    voiceLastInputAtRef.current = Date.now();
    setIsRecording(true);
    setIsTranscribingFile(false);
    setInterimTranscript("Listening...");

    const flushFallbackChunks = () => {
      let updated = false;
      while (fallbackChunkBufferRef.current.has(fallbackNextChunkToApplyRef.current)) {
        const chunk = fallbackChunkBufferRef.current.get(fallbackNextChunkToApplyRef.current) ?? "";
        fallbackChunkBufferRef.current.delete(fallbackNextChunkToApplyRef.current);
        fallbackNextChunkToApplyRef.current += 1;
        if (!chunk.trim()) continue;
        const previous = finalSegmentsRef.current[finalSegmentsRef.current.length - 1];
        if (chunk !== previous) {
          finalSegmentsRef.current = [...finalSegmentsRef.current, chunk];
          updated = true;
        }
      }
      if (updated) {
        setTranscriptDraft(finalSegmentsRef.current.join(" ").trim());
      }
      if (fallbackLoopRunningRef.current && !fallbackStopRequestedRef.current) {
        setInterimTranscript("Listening...");
      }
    };

    const queueFallbackTranscription = (uri: string) => {
      const chunkIndex = fallbackChunkIndexRef.current++;
      const task = (async () => {
        try {
          const transcript = await transcribeAudioWithSpeechApi(uri);
          const normalizedTranscript = transcript.trim();
          fallbackChunkBufferRef.current.set(chunkIndex, normalizedTranscript);
          if (normalizedTranscript) {
            markVoiceDetected();
          }
          setRecordError(null);
        } catch (error) {
          setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
          fallbackChunkBufferRef.current.set(chunkIndex, "");
        } finally {
          flushFallbackChunks();
        }
      })();
      fallbackTranscribeTasksRef.current.add(task);
      void task.finally(() => {
        fallbackTranscribeTasksRef.current.delete(task);
      });
    };

    const runFallbackLoop = async () => {
      try {
        while (fallbackLoopRunningRef.current && !fallbackStopRequestedRef.current) {
          const recording = new Audio.Recording();
          recording.setProgressUpdateInterval(60);
          recording.setOnRecordingStatusUpdate((status) => {
            if (!status.isRecording || !("metering" in status)) return;
            const metering =
              typeof status.metering === "number" ? status.metering : Number.NaN;
            if (!Number.isFinite(metering)) return;
            updateVoicePulseInput(normalizeMeteringDbValue(metering));
          });
          await recording.prepareToRecordAsync({
            ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
            isMeteringEnabled: true,
          });
          await recording.startAsync();
          fallbackRecordingRef.current = recording;

          let waited = 0;
          while (
            waited < FALLBACK_SEGMENT_MS &&
            fallbackLoopRunningRef.current &&
            !fallbackStopRequestedRef.current
          ) {
            await wait(FALLBACK_POLL_MS);
            waited += FALLBACK_POLL_MS;
          }

          let uri: string | null = null;
          try {
            await recording.stopAndUnloadAsync();
            uri = recording.getURI();
          } catch {
            uri = recording.getURI();
          } finally {
            recording.setOnRecordingStatusUpdate(null);
            fallbackRecordingRef.current = null;
          }

          if (uri) {
            setAudioUri(uri);
            queueFallbackTranscription(uri);
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Fallback recording loop failed.";
        setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
      } finally {
        const pending = Array.from(fallbackTranscribeTasksRef.current);
        if (pending.length > 0) {
          setIsTranscribingFile(true);
          setInterimTranscript("Finalizing transcript...");
          await Promise.allSettled(pending);
          flushFallbackChunks();
        }
        fallbackLoopRunningRef.current = false;
        fallbackStopRequestedRef.current = false;
        fallbackRecordingRef.current = null;
        fallbackChunkBufferRef.current.clear();
        fallbackTranscribeTasksRef.current.clear();
        recordingModeRef.current = null;
        sessionModeRef.current = "idle";
        setIsRecording(false);
        setIsTranscribingFile(false);
        setInterimTranscript("");
        if (startedAtRef.current !== null) {
          setElapsedMs(Date.now() - startedAtRef.current);
          startedAtRef.current = null;
        }
      }
    };

    void runFallbackLoop();
  }, [markVoiceDetected, updateVoicePulseInput]);

  useEffect(() => {
    startFallbackRecordingRef.current = startFallbackRecording;
  }, [startFallbackRecording]);

  const stopFallbackRecordingAndTranscribe = useCallback(async () => {
    if (recordingModeRef.current !== "audio-fallback") return;
    fallbackStopRequestedRef.current = true;
    fallbackLoopRunningRef.current = false;
    setInterimTranscript("Finalizing transcript...");
    const recording = fallbackRecordingRef.current;
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
    } catch {
      // active loop handles final state
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!customerName.trim()) {
      Alert.alert("Customer Required", "Please enter customer name before recording.");
      return;
    }

    if (!ExpoSpeechRecognitionModule) {
      setRequestBusy(true);
      try {
        finalSegmentsRef.current = [];
        setTranscriptDraft("");
        setInterimTranscript("");
        setRecordError(null);
        setAudioUri(null);
        setElapsedMs(0);
        startedAtRef.current = Date.now();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        await startFallbackRecording();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Fallback recording could not start. Try a manual transcript.";
        setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
      } finally {
        setRequestBusy(false);
      }
      return;
    }

    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setRequestBusy(true);
      try {
        finalSegmentsRef.current = [];
        setTranscriptDraft("");
        setInterimTranscript("");
        setRecordError(null);
        setAudioUri(null);
        setElapsedMs(0);
        startedAtRef.current = Date.now();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        await startFallbackRecording();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Fallback recording could not start. Try a manual transcript.";
        setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
      } finally {
        setRequestBusy(false);
      }
      return;
    }

    setRequestBusy(true);
    try {
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!permission.granted) {
        if (!permission.canAskAgain) {
          Alert.alert(
            "Microphone Permission Blocked",
            "Please enable microphone permission from settings.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: () => void Linking.openSettings() },
            ]
          );
        } else {
          Alert.alert("Permission Required", "Microphone permission is required to record conversation.");
        }
        return;
      }

      finalSegmentsRef.current = [];
      setTranscriptDraft("");
      setInterimTranscript("");
      setRecordError(null);
      setAudioUri(null);
      setElapsedMs(0);
      startedAtRef.current = Date.now();
      sessionModeRef.current = "recording";
      recordingModeRef.current = "speech";

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        maxAlternatives: 1,
        volumeChangeEventOptions: {
          enabled: true,
          intervalMillis: 60,
        },
        recordingOptions: {
          persist: true,
        },
        androidIntentOptions: {
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 10_000,
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 4_000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2_000,
          EXTRA_MASK_OFFENSIVE_WORDS: false,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start speech recognition.";
      setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
      if (isSpeechRecordingStartFailure(message)) {
        try {
          await startFallbackRecording();
          setRecordError(null);
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : "Fallback recording could not start. Try a manual transcript.";
          setRecordError(RECORDING_UNAVAILABLE_MESSAGE);
        }
      }
    } finally {
      setRequestBusy(false);
    }
  }, [customerName, startFallbackRecording]);

  const stopRecording = useCallback(() => {
    if (!isRecording) return;
    if (recordingModeRef.current === "audio-fallback" || sessionModeRef.current === "audio-fallback") {
      void stopFallbackRecordingAndTranscribe();
      return;
    }
    ExpoSpeechRecognitionModule?.stop?.();
  }, [isRecording, stopFallbackRecordingAndTranscribe]);

  const retranscribeAudio = useCallback(() => {
    if (!audioUri) return;
    if (!ExpoSpeechRecognitionModule || !recognitionAvailable) {
      void transcribeWithFallbackApi(audioUri);
      return;
    }
    finalSegmentsRef.current = [];
    setTranscriptDraft("");
    setInterimTranscript("");
    setRecordError(null);
    sessionModeRef.current = "file";
    ExpoSpeechRecognitionModule.start({
      lang: "en-US",
      interimResults: true,
      audioSource: {
        uri: audioUri,
      },
    });
  }, [audioUri, recognitionAvailable, transcribeWithFallbackApi]);

  const saveConversation = useCallback(async () => {
    const transcript = transcriptDraft.trim();
    if (!customerName.trim()) {
      Alert.alert("Customer Required", "Please enter customer name.");
      return;
    }
    if (!transcript || transcript.length < 20) {
      Alert.alert("Transcript Too Short", "Please record a longer conversation before saving.");
      return;
    }

    setSaving(true);
    try {
      const salespersonName = user?.name ?? "Sales Rep";
      const salespersonId = user?.id ?? "sales_unknown";
      const persistedAudioUri = await persistConversationAudioUri(audioUri);
      const conversation = buildConversationFromTranscript({
        salespersonId,
        salespersonName,
        customerName,
        transcript,
        durationMs: elapsedMs,
        audioUri: persistedAudioUri,
      });

      await addConversation(conversation);
      await addAuditLog({
        id: `audit_sales_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        userId: salespersonId,
        userName: salespersonName,
        action: "Conversation Recorded",
        details: `Recorded and transcribed conversation with ${customerName.trim()}`,
        timestamp: new Date().toISOString(),
        module: "Sales AI",
      });
      await loadData();

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTranscriptDraft("");
      setInterimTranscript("");
      setElapsedMs(0);
      setAudioUri(null);
      setRecordError(null);
      finalSegmentsRef.current = [];
      router.push({ pathname: "/conversation/[id]", params: { id: conversation.id } });
    } catch (error) {
      Alert.alert("Save Failed", error instanceof Error ? error.message : "Unable to save conversation.");
    } finally {
      setSaving(false);
    }
  }, [audioUri, customerName, elapsedMs, loadData, transcriptDraft, user?.id, user?.name]);

  const voicePulseColor =
    voicePulseState === "speaking"
      ? colors.success
      : isRecording
        ? colors.primary
        : colors.textTertiary;
  const voicePulseTitle =
    voicePulseState === "speaking"
      ? "Voice detected"
      : isRecording
        ? "Recorder live"
        : "Recorder idle";
  const voicePulseHint = isRecording
    ? voicePulseState === "speaking"
      ? "Audio signal detected. Continue speaking."
      : "Recorder is active. Keep speaking to strengthen the live pulse."
    : "You're ready to record.";

  return (
    <AppCanvas>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={
          <>
            <View style={styles.navToggleWrap}>
              <DrawerToggleButton />
            </View>
            <Animated.View entering={FadeInDown.duration(400)} style={styles.header}>
              <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                Sales Intelligence
              </Text>
              <Text style={[styles.headerSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Record conversations and generate clear transcripts for {company?.name || "your company"}
              </Text>
            </Animated.View>

            <Animated.View entering={FadeInDown.duration(400).delay(80)} style={[styles.recorderCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <View style={styles.recorderTopRow}>
                <View style={styles.recorderTitleWrap}>
                  <MaterialCommunityIcons name="microphone-message" size={20} color={colors.primary} />
                  <Text style={[styles.recorderTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                    New Conversation Capture
                  </Text>
                </View>
                <View style={[styles.timerPill, { backgroundColor: isRecording ? colors.danger + "16" : colors.surfaceSecondary }]}>
                  <Text style={[styles.timerText, { color: isRecording ? colors.danger : colors.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
                    {formatElapsed(elapsedMs)}
                  </Text>
                </View>
              </View>

              <View style={styles.flowRow}>
                <View style={[styles.flowChip, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "35" }]}>
                  <Text style={[styles.flowChipText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                    1. Record
                  </Text>
                </View>
                <View style={[styles.flowChip, { backgroundColor: colors.secondary + "14", borderColor: colors.secondary + "35" }]}>
                  <Text style={[styles.flowChipText, { color: colors.secondary, fontFamily: "Inter_600SemiBold" }]}>
                    2. Transcribe
                  </Text>
                </View>
                <View style={[styles.flowChip, { backgroundColor: colors.success + "12", borderColor: colors.success + "35" }]}>
                  <Text style={[styles.flowChipText, { color: colors.success, fontFamily: "Inter_600SemiBold" }]}>
                    3. Analyze
                  </Text>
                </View>
              </View>

              <View
                style={[
                  styles.aiHintBanner,
                  {
                    backgroundColor: colors.success + "12",
                    borderColor: colors.success + "38",
                  },
                ]}
              >
                <Ionicons
                  name="checkmark-circle-outline"
                  size={16}
                  color={colors.success}
                />
                <Text
                  style={[
                    styles.aiHintText,
                    {
                      color: colors.success,
                      fontFamily: "Inter_500Medium",
                    },
                  ]}
                >
                  {isRecording ? "Recording in progress." : "You're ready to record."}
                </Text>
              </View>

              {recordError ? (
                <View style={[styles.statusBanner, { backgroundColor: colors.danger + "14", borderColor: colors.danger + "45" }]}>
                  <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                  <Text style={[styles.statusText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>
                    {recordError}
                  </Text>
                </View>
              ) : null}

              <TextInput
                style={[styles.customerInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="Customer / Account name"
                placeholderTextColor={colors.textTertiary}
                value={customerName}
                onChangeText={setCustomerName}
              />

              <View style={styles.recordRow}>
                <Pressable
                  onPress={isRecording ? stopRecording : () => void startRecording()}
                  disabled={requestBusy || isTranscribingFile || saving}
                  style={({ pressed }) => [
                    styles.recordButton,
                    {
                      backgroundColor: isRecording ? colors.danger : colors.primary,
                      opacity: pressed || requestBusy ? 0.88 : 1,
                    },
                  ]}
                >
                  {requestBusy ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name={isRecording ? "stop" : "mic"} size={18} color="#FFFFFF" />
                      <Text style={styles.recordButtonText}>
                        {isRecording ? "Stop Recording" : "Start Recording"}
                      </Text>
                    </>
                  )}
                </Pressable>

                <Pressable
                  onPress={retranscribeAudio}
                  disabled={!audioUri || isRecording || isTranscribingFile}
                  style={({ pressed }) => [
                    styles.ghostButton,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                      opacity: pressed || !audioUri || isRecording || isTranscribingFile ? 0.6 : 1,
                    },
                  ]}
                >
                  {isTranscribingFile ? (
                    <ActivityIndicator size="small" color={colors.text} />
                  ) : (
                    <>
                      <Ionicons name="sparkles-outline" size={16} color={colors.textSecondary} />
                      <Text style={[styles.ghostButtonText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                        Re-transcribe
                      </Text>
                    </>
                  )}
                </Pressable>
              </View>

              <View
                style={[
                  styles.voicePulseCard,
                  {
                    borderColor:
                      voicePulseState === "speaking"
                        ? colors.success + "55"
                        : isRecording
                          ? colors.primary + "45"
                          : colors.border,
                    backgroundColor:
                      voicePulseState === "speaking"
                        ? colors.success + "10"
                        : isRecording
                          ? colors.primary + "10"
                          : colors.surface,
                  },
                ]}
              >
                <View style={styles.voicePulseHeaderRow}>
                  <View style={styles.voicePulseTitleWrap}>
                    <Ionicons
                      name={isRecording ? "radio" : "radio-outline"}
                      size={15}
                      color={voicePulseColor}
                    />
                    <Text
                      style={[
                        styles.voicePulseTitle,
                        { color: voicePulseColor, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      {voicePulseTitle}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.voicePulseMode,
                      { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                    ]}
                  >
                    {recordingModeRef.current === "audio-fallback" ? "Fallback mic" : "Speech mic"}
                  </Text>
                </View>
                <View
                  style={[
                    styles.voiceWaveShell,
                    {
                      backgroundColor: colors.surface + "80",
                      borderColor: colors.border + "88",
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.voiceWaveCenterLine,
                      { backgroundColor: voicePulseColor + "4D" },
                    ]}
                  />
                  <View style={styles.voicePulseBarsRow}>
                    {voicePulseBars.map((barHeight, index) => (
                      <View key={`voice-pulse-${index}`} style={styles.voicePulseTrack}>
                        <View
                          style={[
                            styles.voicePulseFill,
                            {
                              height: `${Math.round(10 + barHeight * 90)}%`,
                              backgroundColor: voicePulseColor,
                              opacity: 0.4 + barHeight * 0.6,
                            },
                          ]}
                        />
                      </View>
                    ))}
                  </View>
                </View>
                <Text
                  style={[
                    styles.voicePulseHint,
                    { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                  ]}
                >
                  {voicePulseHint}
                </Text>
              </View>

              <TextInput
                multiline
                style={[styles.transcriptInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
                placeholder="Transcript will appear here while recording. You can edit before saving."
                placeholderTextColor={colors.textTertiary}
                value={liveTranscript}
                onChangeText={(text) => {
                  setTranscriptDraft(text);
                  setInterimTranscript("");
                }}
              />

              <View style={styles.captureFooter}>
                <Text style={[styles.captureHint, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {audioUri ? "Audio captured and ready." : "You're ready to record."}
                </Text>
                <Pressable
                  onPress={() => void saveConversation()}
                  disabled={saving || isRecording || isTranscribingFile || !customerName.trim() || liveTranscript.trim().length < 20}
                  style={({ pressed }) => [
                    styles.saveButton,
                    {
                      backgroundColor: colors.success,
                      opacity: pressed || saving || isRecording || isTranscribingFile || !customerName.trim() || liveTranscript.trim().length < 20 ? 0.7 : 1,
                    },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle-outline" size={16} color="#FFFFFF" />
                      <Text style={styles.saveButtonText}>Save Conversation</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </Animated.View>

            <Animated.View entering={FadeInDown.duration(400).delay(140)}>
              <LinearGradient
                colors={isDark ? [colors.heroEnd, colors.heroStart] : [colors.heroStart, colors.heroEnd]}
                style={styles.aiCard}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <View style={styles.aiCardHeader}>
                  <MaterialCommunityIcons name="brain" size={24} color="rgba(255,255,255,0.9)" />
                  <Text style={styles.aiCardTitle}>AI Analysis Overview</Text>
                </View>
                <View style={styles.aiMetrics}>
                  <View style={styles.aiMetric}>
                    <Text style={styles.aiMetricValue}>{conversations.length}</Text>
                    <Text style={styles.aiMetricLabel}>Analyzed</Text>
                  </View>
                  <View style={styles.aiMetricDivider} />
                  <View style={styles.aiMetric}>
                    <Text style={styles.aiMetricValue}>{avgInterest}%</Text>
                    <Text style={styles.aiMetricLabel}>Avg Interest</Text>
                  </View>
                  <View style={styles.aiMetricDivider} />
                  <View style={styles.aiMetric}>
                    <Text style={styles.aiMetricValue}>{avgPitch}%</Text>
                    <Text style={styles.aiMetricLabel}>Avg Pitch</Text>
                  </View>
                </View>
              </LinearGradient>
            </Animated.View>

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                Recent Conversations
              </Text>
            </View>
          </>
        }
        renderItem={({ item }) => <ConversationCard conversation={item} colors={colors} />}
        ListEmptyComponent={
          <View style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Ionicons name="chatbubbles-outline" size={40} color={colors.textTertiary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              No conversations analyzed yet
            </Text>
          </View>
        }
      />
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 20, paddingBottom: 40 },
  navToggleWrap: {
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  header: { marginBottom: 16 },
  headerTitle: { fontSize: 24, letterSpacing: -0.5 },
  headerSubtitle: { fontSize: 14, marginTop: 4 },
  recorderCard: {
    borderRadius: 20,
    padding: 14,
    borderWidth: 1,
    marginBottom: 18,
    gap: 12,
  },
  recorderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  recorderTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  recorderTitle: {
    fontSize: 15,
  },
  flowRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  flowChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  flowChipText: {
    fontSize: 11,
    letterSpacing: 0.2,
  },
  aiHintBanner: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  aiHintText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  timerPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timerText: {
    fontSize: 12,
    letterSpacing: 0.4,
  },
  statusBanner: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusText: {
    flex: 1,
    fontSize: 12,
  },
  customerInput: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  recordRow: {
    flexDirection: "row",
    gap: 10,
  },
  recordButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  recordButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  ghostButton: {
    minWidth: 118,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
  },
  ghostButtonText: {
    fontSize: 12,
  },
  voicePulseCard: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  voicePulseHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  voicePulseTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  voicePulseTitle: {
    fontSize: 12.5,
    letterSpacing: 0.2,
  },
  voicePulseMode: {
    fontSize: 11,
  },
  voiceWaveShell: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 6,
    position: "relative",
    overflow: "hidden",
  },
  voiceWaveCenterLine: {
    position: "absolute",
    left: 8,
    right: 8,
    top: "50%",
    height: 1,
    marginTop: -0.5,
  },
  voicePulseBarsRow: {
    flexDirection: "row",
    alignItems: "stretch",
    height: 54,
    gap: 2,
  },
  voicePulseTrack: {
    flex: 1,
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  voicePulseFill: {
    width: "72%",
    minHeight: 2,
    borderRadius: 999,
  },
  voicePulseHint: {
    fontSize: 11.5,
  },
  transcriptInput: {
    minHeight: 110,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlignVertical: "top",
  },
  captureFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  captureHint: {
    flex: 1,
    fontSize: 11.5,
  },
  saveButton: {
    minHeight: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
  },
  saveButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  aiCard: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 24,
  },
  aiCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
  },
  aiCardTitle: {
    color: "#fff",
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  aiMetrics: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  aiMetric: { alignItems: "center", gap: 4 },
  aiMetricValue: {
    color: "#fff",
    fontSize: 24,
    fontFamily: "Inter_700Bold",
  },
  aiMetricLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  aiMetricDivider: {
    width: 1,
    height: 30,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  sectionHeader: { marginBottom: 12 },
  sectionTitle: { fontSize: 18, letterSpacing: -0.3 },
  convoCard: {
    borderRadius: 18,
    padding: 18,
    marginBottom: 10,
    gap: 10,
    borderWidth: 1,
  },
  convoHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  convoHeaderLeft: { flex: 1, gap: 2 },
  convoHeaderRight: {
    alignItems: "flex-end",
    gap: 6,
  },
  sourcePill: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  sourcePillText: {
    fontSize: 10,
    letterSpacing: 0.5,
  },
  customerName: { fontSize: 15 },
  salesperson: { fontSize: 12 },
  summary: { fontSize: 13, lineHeight: 18 },
  convoFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sentimentChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    gap: 4,
  },
  sentimentDot: { width: 6, height: 6, borderRadius: 3 },
  sentimentText: { fontSize: 11, textTransform: "capitalize" as const },
  intentChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  intentText: { fontSize: 11, textTransform: "capitalize" as const },
  dateText: { fontSize: 11, marginLeft: "auto" },
  scoreBadge: {
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: "center",
    alignItems: "center",
  },
  scoreText: {},
  emptyState: {
    borderRadius: 16,
    padding: 40,
    alignItems: "center",
    gap: 12,
    marginTop: 20,
    borderWidth: 1,
  },
  emptyText: { fontSize: 14, textAlign: "center" },
});

