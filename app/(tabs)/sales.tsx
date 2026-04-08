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
  ScrollView,
  Modal,
  AppState,
  BackHandler,
  Keyboard,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useNavigation } from "expo-router";
import * as Haptics from "expo-haptics";
import Animated, { FadeInDown } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { Audio } from "expo-av";
import * as Crypto from "expo-crypto";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import Colors from "@/constants/colors";
import {
  getApiBaseUrlCandidates,
  getAdminLiveMapRoutes,
  getAdminRouteTimeline,
  getDolibarrOrderDetail,
  getDolibarrOrders,
  getDolibarrProducts,
  getDolibarrThirdParties,
  getNearbyVisitHistory,
  getRemoteState,
  createDolibarrCustomer,
  createDolibarrSalesOrder,
  adjustCompanyProductStock,
  validateDolibarrSalesOrder,
  getMapplsRoutePreview,
  searchMapplsAutosuggest,
  searchMapplsTextSearch,
  type DolibarrProduct,
  type DolibarrOrder,
  type DolibarrOrderLine,
  type DolibarrThirdParty,
  type DolibarrOrderLineInput,
  type MapplsPlaceSuggestion,
  type MapplsRoutePreviewResponse,
  type AdminRouteTimelineResponse,
} from "@/lib/attendance-api";
import {
  addTask,
  addAuditLog,
  addConversation,
  addQuickSaleLocationLog,
  addStockTransfer,
  getAttendance,
  getConversations,
  getLocationLogs,
  getQuickSaleLocationLogs,
  getTasks,
  resolveAssignedStockistForUser,
  removeTask,
  STORAGE_KEYS,
  subscribeStorageUpdates,
  syncVisitNoteTaskRemote,
  updateConversation,
  updateTask,
} from "@/lib/storage";
import { getEmployees } from "@/lib/employee-data";
import { buildConversationFromTranscript } from "@/lib/sales-analysis";
import { buildRouteTimeline } from "@/lib/route-analytics";
import { formatMumbaiDateTime, formatMumbaiTime, isMumbaiDateKey, toMumbaiDateKey } from "@/lib/ist-time";
import { maybeSendLocationReminder, syncLocationReminderCatalog } from "@/lib/location-reminders";
import { getLastKnownLocationSafe } from "@/lib/location-service";
import { isSalesRole } from "@/lib/role-access";
import { haversineDistanceMeters } from "@/lib/geofence";
import type {
  AttendanceRecord,
  Conversation,
  Employee,
  LocationLog,
  QuickSaleLocationLog,
  Task,
  VisitHistoryRecord,
} from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { AppCanvas } from "@/components/AppCanvas";
import { DrawerToggleButton } from "@/components/DrawerToggleButton";
import {
  RouteMapNative,
  type PlannedStopPoint,
  type QuickSalePoint,
} from "@/components/RouteMapNative";

type SpeechRecognitionEventName =
  | "start"
  | "result"
  | "audioend"
  | "error"
  | "end"
  | "volumechange";
type SpeechRecognitionEventPayload = {
  isFinal?: boolean;
  error?: string;
  code?: number;
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
type SalesTrendTagTone = "hot" | "seasonal" | "consistent" | "emerging";
type SalesTrendTag = {
  label: string;
  tone: SalesTrendTagTone;
  reason: string;
};
type SalesTrendRecommendation = {
  id: string;
  label: string;
  ref: string | null;
  unitsSold: number;
  orderCount: number;
  revenue: number;
  activeMonths: number;
  bestMonthLabel: string | null;
  recentUnitsSold: number;
  recentOrderCount: number;
  tags: SalesTrendTag[];
  reason: string;
};
type MeetingConversationProductRecommendation = {
  id: string;
  label: string;
  ref: string | null;
  matchedKeyPhrases: string[];
  matchedSpecifications: string[];
  reason: string;
};
type IndexedConversationRecommendationProduct = {
  id: string;
  label: string;
  ref: string | null;
  searchable: string;
  specificationSearchable: string;
  compactSpecificationSearchable: string;
  keywordSet: Set<string>;
  specificationTokenSet: Set<string>;
};
type TranscriptDrivenProductSignals = {
  phrases: string[];
  specifications: string[];
};
type MeetingAiAnalysisResult = Pick<
  Conversation,
  | "interestScore"
  | "pitchScore"
  | "confidenceScore"
  | "talkListenRatio"
  | "sentiment"
  | "buyingIntent"
  | "objections"
  | "improvements"
  | "summary"
  | "keyPhrases"
> & {
  notes?: string;
};
type RoutePlannerStop = {
  id: string;
  label: string;
  address: string | null;
  latitude: number;
  longitude: number;
  source?: "location" | "customer";
  customerId?: string | null;
};
const FALLBACK_SEGMENT_MS = 2500;
const FALLBACK_POLL_MS = 100;
const LIVE_HINT_RESTART_DELAY_MS = 180;
const TRANSCRIBE_LOADING_RETRY_DELAY_MS = 800;
const VOICE_WAVE_BAR_COUNT = 31;
const RECORDING_START_FAILED_MESSAGE = "Recording could not start. Please try again.";
const TRANSCRIPTION_FAILED_MESSAGE = "Transcription failed. Please try again.";
const ROUTE_SEARCH_RESULTS_LIMIT = 20;
const ROUTE_NAV_WAYPOINT_LIMIT = 6;
const POS_PAGE_SIZE = 100;
const SALES_TREND_ORDER_LIMIT = 60;
const SALES_TREND_LOOKBACK_DAYS = 365;
const SALES_TREND_BATCH_SIZE = 6;
const CONVERSATION_RECOMMENDATION_PRODUCT_LIMIT = 8;
const VISIT_NEARBY_RADIUS_METERS = 250;
const VISIT_RECENT_ORDER_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
const CONVERSATION_RECOMMENDATION_STOP_WORDS = new Set([
  "product",
  "products",
  "customer",
  "client",
  "sales",
  "company",
  "service",
  "solution",
  "discussion",
  "meeting",
  "details",
  "need",
  "needs",
  "requirement",
  "requirements",
  "pricing",
  "hai",
  "hain",
  "tha",
  "thi",
  "the",
  "aur",
  "kar",
  "kr",
  "liye",
  "wala",
  "wali",
  "wale",
]);
const CONVERSATION_SPEC_UNIT_PATTERN =
  /\b\d+(?:\.\d+)?\s?(?:mm|cm|ml|l|ltr|micron|microns|g|kg|gsm|inch|inches|in|hp|w|kw|v|volt|volts|amp|amps|a|bar|psi|rpm|cc|mtr|meter|meters|m)\b/gi;
const CONVERSATION_SPEC_DIMENSION_PATTERN =
  /\b\d+(?:\.\d+)?\s?[x*]\s?\d+(?:\.\d+)?(?:\s?[x*]\s?\d+(?:\.\d+)?)?\b/gi;
const SPOKEN_SPEC_NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
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

function isIsoDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function formatSearchAddress(value: string | null | undefined): string {
  const cleaned = (value || "").trim();
  return cleaned || "Address unavailable";
}


function buildRoutePlannerAddress(
  address: Partial<Location.LocationGeocodedAddress> | null | undefined
): string {
  if (!address) return "";
  const line1 = [address.name, address.street].filter(Boolean).join(", ");
  const line2 = [
    address.city,
    address.district,
    address.subregion,
    address.region,
    address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
  return [line1, line2].filter(Boolean).join(" | ").trim();
}

function toRoutePlannerStopFromTask(task: Task): RoutePlannerStop | null {
  if (typeof task.visitLatitude !== "number" || typeof task.visitLongitude !== "number") {
    return null;
  }
  return {
    id: task.id,
    label: getVisitLabel(task),
    address: task.visitLocationAddress?.trim() || null,
    latitude: task.visitLatitude,
    longitude: task.visitLongitude,
  };
}

function toRoutePlannerStopFromMapplsSuggestion(
  suggestion: MapplsPlaceSuggestion,
  index: number
): RoutePlannerStop | null {
  if (
    typeof suggestion.latitude !== "number" ||
    !Number.isFinite(suggestion.latitude) ||
    typeof suggestion.longitude !== "number" ||
    !Number.isFinite(suggestion.longitude)
  ) {
    return null;
  }
  const label = suggestion.label?.trim() || suggestion.address?.trim() || `Place ${index + 1}`;
  return {
    id: createLocalId(`route_search_mappls_${index}`),
    label,
    address: suggestion.address?.trim() || null,
    latitude: suggestion.latitude,
    longitude: suggestion.longitude,
    source: "location",
    customerId: null,
  };
}

function createLocalId(prefix: string): string {
  try {
    return `${prefix}_${Crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function dedupeRouteStops(stops: RoutePlannerStop[]): RoutePlannerStop[] {
  const seen = new Set<string>();
  const out: RoutePlannerStop[] = [];
  for (const stop of stops) {
    const key = `${stop.latitude.toFixed(6)}_${stop.longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stop);
  }
  return out;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeConversationRecommendationText(value: string | undefined | null): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeConversationTranscript(value: string): string {
  let cleaned = value
    .replace(/Speaker\s+[A-Za-z0-9_-]+(?:\s*\[[^\]]+\])?:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const repeatedLeadingNoiseMatch = cleaned.match(
    /^((?:\S+\s+){0,3}\S+)(?:\s+\1){4,}\s*/u
  );
  if (
    repeatedLeadingNoiseMatch &&
    repeatedLeadingNoiseMatch[0] &&
    (repeatedLeadingNoiseMatch[0].length >= 48 || /[^\x00-\x7F]/.test(repeatedLeadingNoiseMatch[0]))
  ) {
    cleaned = cleaned.slice(repeatedLeadingNoiseMatch[0].length).trim();
  }

  cleaned = cleaned.replace(
    /\b((?:[a-z\u00C0-\u024F]+\s+){1,4}[a-z\u00C0-\u024F]+)\b(?:\s+\1){4,}/giu,
    "$1"
  );

  return cleaned.replace(/\s+/g, " ").trim();
}

function toConversationRecommendationTitle(value: string): string {
  return value.replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function normalizeConversationRecommendationKeyword(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.endsWith("ies") && normalized.length > 4) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (
    normalized.endsWith("es") &&
    normalized.length > 4 &&
    /(ches|shes|xes|zes|ses)$/i.test(normalized)
  ) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("s") && normalized.length > 4 && !normalized.endsWith("ss")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function normalizeSpokenConversationSpecifications(value: string): string {
  return value.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine)\s+point\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, whole: string, fraction: string) =>
      `${SPOKEN_SPEC_NUMBER_WORDS[whole.toLowerCase()]}.${SPOKEN_SPEC_NUMBER_WORDS[fraction.toLowerCase()]}`
  );
}

function normalizeConversationSpecificationSearchText(value: string | undefined | null): string {
  return normalizeSpokenConversationSpecifications((value || "").toLowerCase())
    .replace(/(\d)([a-z])/gi, "$1 $2")
    .replace(/([a-z])(\d)/gi, "$1 $2")
    .replace(/(\d)\s*[x*]\s*(\d)/gi, "$1x$2")
    .replace(/[^a-z0-9.+x*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractConversationRecommendationSpecifications(transcript: string): string[] {
  const normalizedTranscript = normalizeSpokenConversationSpecifications(transcript.toLowerCase());
  const specs = new Set<string>();
  const specMatches = normalizedTranscript.match(CONVERSATION_SPEC_UNIT_PATTERN) || [];
  const dimensionMatches = normalizedTranscript.match(CONVERSATION_SPEC_DIMENSION_PATTERN) || [];
  for (const raw of [...specMatches, ...dimensionMatches]) {
    const cleaned = normalizeConversationSpecificationSearchText(raw);
    if (cleaned.length >= 2) {
      specs.add(cleaned);
    }
  }
  const looseNumberMatches =
    normalizedTranscript.match(/\b\d+(?:\.\d+)?\b/g)?.filter((entry) => entry.includes(".")) || [];
  for (const entry of looseNumberMatches) {
    if (entry.length >= 3) {
      specs.add(normalizeConversationSpecificationSearchText(entry));
    }
  }
  return Array.from(specs).slice(0, 12);
}

function extractConversationRecommendationSpecVariants(specification: string): string[] {
  const normalized = normalizeConversationSpecificationSearchText(specification);
  if (!normalized) return [];
  const variants = new Set<string>([normalized, normalized.replace(/\s+/g, "")]);
  const numericFragments = normalized.match(/\b\d+(?:\.\d+)?\b/g) || [];
  for (const fragment of numericFragments) {
    if (fragment.length >= 2) {
      variants.add(fragment);
      variants.add(fragment.replace(/\./g, ""));
    }
  }
  return Array.from(variants).filter(Boolean);
}

function extractConversationRecommendationKeywords(phrases: string[]): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const phrase of phrases) {
    const tokens = normalizeConversationRecommendationText(phrase)
      .split(" ")
      .map((entry) => normalizeConversationRecommendationKeyword(entry))
      .filter(
        (entry) =>
          entry.length >= 3 &&
          !CONVERSATION_RECOMMENDATION_STOP_WORDS.has(entry) &&
          !/^\d+(?:\.\d+)?$/.test(entry)
      );
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      keywords.push(token);
      if (keywords.length >= 24) return keywords;
    }
  }
  return keywords;
}

function buildConversationRecommendationProductIndex(
  products: DolibarrProduct[]
): IndexedConversationRecommendationProduct[] {
  return products
    .map((product) => {
      const label = getDolibarrProductLabel(product);
      const ref = product.ref?.trim() || null;
      const searchable = normalizeConversationRecommendationText(
        [product.label, product.ref, product.description].filter(Boolean).join(" ")
      );
      const specificationSearchable = normalizeConversationSpecificationSearchText(
        [product.label, product.ref, product.description].filter(Boolean).join(" ")
      );
      if (!searchable && !specificationSearchable) return null;
      return {
        id: String(getDolibarrProductId(product) ?? `${label}_${ref || "product"}`),
        label,
        ref,
        searchable,
        specificationSearchable,
        compactSpecificationSearchable: specificationSearchable.replace(/\s+/g, ""),
        keywordSet: new Set(
          searchable
            .split(" ")
            .map((entry) => normalizeConversationRecommendationKeyword(entry))
            .filter(Boolean)
        ),
        specificationTokenSet: new Set(
          specificationSearchable
            .split(" ")
            .map((entry) => entry.trim())
            .filter(Boolean)
        ),
      } satisfies IndexedConversationRecommendationProduct;
    })
    .filter((item): item is IndexedConversationRecommendationProduct => Boolean(item));
}

function buildMeetingConversationProductRecommendationsFromSignals(
  signals: TranscriptDrivenProductSignals,
  indexedProducts: IndexedConversationRecommendationProduct[],
  buyingIntent?: Conversation["buyingIntent"]
): MeetingConversationProductRecommendation[] {
  const phraseCandidates = signals.phrases;
  const specificationTokens = signals.specifications;
  const keywordCandidates = extractConversationRecommendationKeywords(phraseCandidates);
  if (!phraseCandidates.length && !specificationTokens.length) return [];
  if (!indexedProducts.length) return [];

  return indexedProducts
    .map((product) => {
      const matchedKeyPhrases = phraseCandidates
        .filter((phrase) => {
          if (
            phrase.includes(" ")
              ? product.searchable.includes(phrase)
              : ` ${product.searchable} `.includes(` ${phrase} `)
          ) {
            return true;
          }
          const phraseKeywords = normalizeConversationRecommendationText(phrase)
            .split(" ")
            .map((entry) => normalizeConversationRecommendationKeyword(entry))
            .filter(
              (entry) =>
                entry.length >= 3 &&
                !CONVERSATION_RECOMMENDATION_STOP_WORDS.has(entry) &&
                !/^\d+(?:\.\d+)?$/.test(entry)
            );
          if (!phraseKeywords.length) return false;
          const overlapCount = phraseKeywords.filter((entry) => product.keywordSet.has(entry)).length;
          const requiredOverlap = phraseKeywords.length >= 2 ? 2 : 1;
          return overlapCount >= requiredOverlap;
        })
        .slice(0, 3)
        .map((phrase) => toConversationRecommendationTitle(phrase));
      const matchedKeywordSignals = keywordCandidates
        .filter((entry) => product.keywordSet.has(entry))
        .slice(0, 4)
        .map((entry) => toConversationRecommendationTitle(entry));
      const matchedSpecifications = specificationTokens
        .filter((token) => {
          const variants = extractConversationRecommendationSpecVariants(token);
          return variants.some(
            (variant) =>
              product.specificationSearchable.includes(variant) ||
              product.compactSpecificationSearchable.includes(variant.replace(/\s+/g, "")) ||
              product.specificationTokenSet.has(variant)
          );
        })
        .slice(0, 3)
        .map((token) => toConversationRecommendationTitle(token));
      if (!matchedKeyPhrases.length && !matchedSpecifications.length && !matchedKeywordSignals.length) {
        return null;
      }

      const specReason =
        matchedSpecifications.length > 0
          ? `${product.label} matches the requested spec ${matchedSpecifications.slice(0, 2).join(" and ")}.`
          : "";
      const phraseReason =
        matchedKeyPhrases.length > 0
          ? `${product.label} fits because the customer mentioned ${matchedKeyPhrases.slice(0, 2).join(" and ")}.`
          : matchedKeywordSignals.length > 0
            ? `${product.label} connects with keywords like ${matchedKeywordSignals.slice(0, 2).join(" and ")}.`
            : `${product.label} aligns with the conversation requirements.`;
      const score =
        matchedSpecifications.length * 6 +
        matchedKeyPhrases.length * 4 +
        matchedKeywordSignals.length * 2 +
        (buyingIntent === "high" ? 2 : buyingIntent === "medium" ? 1 : 0);

      return {
        id: product.id,
        label: product.label,
        ref: product.ref,
        matchedKeyPhrases,
        matchedSpecifications,
        reason: [specReason, phraseReason].filter(Boolean).join(" "),
        score,
      };
    })
    .filter(
      (
        item
      ): item is MeetingConversationProductRecommendation & {
        score: number;
      } => Boolean(item)
    )
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, CONVERSATION_RECOMMENDATION_PRODUCT_LIMIT)
    .map(({ score: _score, ...item }) => item);
}

function buildTranscriptDrivenProductSignalsFromIndex(
  transcript: string,
  indexedProducts: IndexedConversationRecommendationProduct[]
): TranscriptDrivenProductSignals {
  const normalizedTranscript = normalizeConversationRecommendationText(transcript);
  const specificationTranscript = normalizeConversationSpecificationSearchText(transcript);
  const tokens = normalizedTranscript.match(/[a-z0-9.+-]{2,}/g) || [];
  const specifications = extractConversationRecommendationSpecifications(transcript);
  if (!indexedProducts.length || (!tokens.length && !specifications.length)) {
    return {
      phrases: [],
      specifications,
    };
  }

  const candidateScores = new Map<string, number>();
  for (let size = 1; size <= 4; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const window = tokens.slice(index, index + size);
      const phrase = window.join(" ").trim();
      const nonStopCount = window.filter((token) => !CONVERSATION_RECOMMENDATION_STOP_WORDS.has(token)).length;
      if (
        !phrase ||
        phrase.length < 3 ||
        phrase.length > 42 ||
        nonStopCount === 0 ||
        (size === 1 && (CONVERSATION_RECOMMENDATION_STOP_WORDS.has(window[0]) || /^\d+$/.test(window[0])))
      ) {
        continue;
      }

      let matchCount = 0;
      const normalizedWindowKeywords = window
        .map((entry) => normalizeConversationRecommendationKeyword(entry))
        .filter(
          (entry) =>
            entry.length >= 3 &&
            !CONVERSATION_RECOMMENDATION_STOP_WORDS.has(entry) &&
            !/^\d+(?:\.\d+)?$/.test(entry)
        );
      for (const product of indexedProducts) {
        if (!product.searchable && !product.specificationSearchable) continue;
        if (
          (phrase.includes(" ")
            ? product.searchable.includes(phrase)
            : ` ${product.searchable} `.includes(` ${phrase} `)) ||
          specificationTranscript.includes(phrase) ||
          product.specificationSearchable.includes(phrase) ||
          normalizedWindowKeywords.some((entry) => product.keywordSet.has(entry))
        ) {
          matchCount += 1;
        }
      }

      if (!matchCount) continue;
      const current = candidateScores.get(phrase) || 0;
      const score =
        current + matchCount * 2 + (/\d/.test(phrase) ? 4 : 0) + (size >= 2 ? size : 0);
      candidateScores.set(phrase, score);
    }
  }

  const phrases: string[] = [];
  for (const [phrase] of [...candidateScores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const alreadyCovered = phrases.some((picked) => picked.includes(phrase) || phrase.includes(picked));
    if (alreadyCovered) continue;
    phrases.push(phrase);
    if (phrases.length >= 12) break;
  }

  return {
    phrases,
    specifications,
  };
}

function buildTranscriptDrivenProductSignals(
  transcript: string,
  products: DolibarrProduct[]
): TranscriptDrivenProductSignals {
  return buildTranscriptDrivenProductSignalsFromIndex(
    transcript,
    buildConversationRecommendationProductIndex(products)
  );
}

function buildMeetingConversationProductRecommendations(
  conversation: Conversation,
  products: DolibarrProduct[]
): MeetingConversationProductRecommendation[] {
  const transcriptSource = [
    conversation.transcript || "",
    conversation.summary || "",
    ...(conversation.objections || []),
    ...(conversation.keyPhrases || []),
  ]
    .filter(Boolean)
    .join(" ");
  const signals = buildTranscriptDrivenProductSignals(transcriptSource, products);
  return buildMeetingConversationProductRecommendationsFromSignals(
    signals,
    buildConversationRecommendationProductIndex(products),
    conversation.buyingIntent
  );
}

function parseNumericId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function getDolibarrProductId(product: DolibarrProduct): number | null {
  return parseNumericId(product.id);
}

function getDolibarrThirdPartyId(party: DolibarrThirdParty): number | null {
  return parseNumericId(party.id);
}

function getDolibarrProductLabel(product: DolibarrProduct): string {
  return product.label?.trim() || product.ref?.trim() || "Product";
}

function getDolibarrThirdPartyLabel(party: DolibarrThirdParty): string {
  return party.name?.trim() || party.nom?.trim() || "Customer";
}

function getDolibarrThirdPartyAddress(party: DolibarrThirdParty): string {
  const line1 = (party.address || "").trim();
  const line2 = [party.town?.trim(), party.zip?.trim()].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(" | ").trim();
}

async function resolveRoutePlannerCustomerStop(party: DolibarrThirdParty): Promise<RoutePlannerStop> {
  const label = getDolibarrThirdPartyLabel(party);
  const customerId = getDolibarrThirdPartyId(party);
  const address = getDolibarrThirdPartyAddress(party);
  const queries = [address, `${label} ${address}`.trim(), label].filter((value, index, array) => {
    const cleaned = value.trim();
    return Boolean(cleaned) && array.findIndex((entry) => entry.trim() === cleaned) === index;
  });

  for (const query of queries) {
    try {
      const textSearch = await searchMapplsTextSearch(query, {
        region: "ind",
        limit: 1,
      });
      const match = (textSearch.suggestions || [])
        .map((suggestion, index) => toRoutePlannerStopFromMapplsSuggestion(suggestion, index))
        .find((item): item is RoutePlannerStop => Boolean(item));
      if (match) {
        return {
          ...match,
          id: createLocalId("route_customer_stop"),
          label,
          address: address || match.address,
          source: "customer",
          customerId: customerId ? String(customerId) : null,
        };
      }
    } catch {
      // fall through to next resolver
    }
  }

  for (const query of queries) {
    try {
      const geocoded = await Location.geocodeAsync(query);
      const first = geocoded[0];
      if (
        first &&
        typeof first.latitude === "number" &&
        Number.isFinite(first.latitude) &&
        typeof first.longitude === "number" &&
        Number.isFinite(first.longitude)
      ) {
        return {
          id: createLocalId("route_customer_stop"),
          label,
          address: address || query,
          latitude: first.latitude,
          longitude: first.longitude,
          source: "customer",
          customerId: customerId ? String(customerId) : null,
        };
      }
    } catch {
      // try next query
    }
  }

  throw new Error(`Could not resolve map location for ${label}. Add a manual location for this stop.`);
}

function getDolibarrProductPrice(product: DolibarrProduct): number {
  const candidates = [product.price, product.price_ttc];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function getDolibarrOrderDate(order: DolibarrOrder): Date | null {
  const raw = order.date_commande ?? order.date_creation ?? order.date ?? order.tms;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(raw > 1_000_000_000_000 ? raw : raw * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "string" && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function getDolibarrOrderLineQty(line: DolibarrOrderLine): number {
  if (typeof line.qty === "number" && Number.isFinite(line.qty)) return Math.max(0, line.qty);
  if (typeof line.qty === "string" && line.qty.trim()) {
    const parsed = Number(line.qty);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

function getDolibarrOrderLineRevenue(line: DolibarrOrderLine, qty: number): number {
  const candidates = [line.total_ttc, line.total_ht];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof line.subprice === "number" && Number.isFinite(line.subprice)) return line.subprice * qty;
  if (typeof line.subprice === "string" && line.subprice.trim()) {
    const parsed = Number(line.subprice);
    if (Number.isFinite(parsed)) return parsed * qty;
  }
  return 0;
}

function formatSalesTrendMonthLabel(value: string | null): string {
  if (!value) return "a peak month";
  const parsed = new Date(`${value}-01T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function isReliableTrendProduct(label: string, ref: string | null): boolean {
  const normalizedLabel = normalizeSearchText(label);
  const normalizedRef = normalizeSearchText(ref || "");
  if (!normalizedLabel || normalizedLabel === "product") return false;
  if (normalizedRef === "na" || normalizedRef === "dummy") return false;
  return true;
}

function classifySalesTrendTags(input: {
  unitsSold: number;
  orderCount: number;
  activeMonths: number;
  recentUnitsSold: number;
  recentOrderCount: number;
  bestMonthUnits: number;
  avgMonthlyUnits: number;
  bestMonthLabel: string | null;
}): SalesTrendTag[] {
  const tags: SalesTrendTag[] = [];
  const avg = Math.max(0.1, input.avgMonthlyUnits);
  const bestMonthName = formatSalesTrendMonthLabel(input.bestMonthLabel);

  if (input.recentOrderCount >= 3 || input.recentUnitsSold >= Math.max(6, avg * 1.15)) {
    tags.push({
      label: "Hot Pick",
      tone: "hot",
      reason: `${input.recentUnitsSold} recent units across ${input.recentOrderCount} recent orders.`,
    });
  }

  if (input.activeMonths >= 3 && input.bestMonthUnits >= Math.max(5, avg * 1.8)) {
    tags.push({
      label: "Seasonal",
      tone: "seasonal",
      reason: `Clear spike seen in ${bestMonthName} versus its normal monthly average.`,
    });
  }

  if (
    input.activeMonths >= 3 &&
    input.orderCount >= 4 &&
    input.bestMonthUnits <= Math.max(8, avg * 1.45)
  ) {
    tags.push({
      label: "Consistent",
      tone: "consistent",
      reason: `Selling across ${input.activeMonths} active months, not just one short spike.`,
    });
  }

  if (input.activeMonths <= 2 && input.recentOrderCount >= 2) {
    tags.push({
      label: "Emerging",
      tone: "emerging",
      reason: `Recent demand is picking up, but history is still limited.`,
    });
  }

  if (!tags.length) {
    tags.push({
      label: "Watched Trend",
      tone: "consistent",
      reason: `Useful signal, but more sales history is needed for a stronger pattern.`,
    });
  }

  return tags.slice(0, 3);
}

function resolveTrendTagColors(colors: typeof Colors.light, tone: SalesTrendTagTone): {
  backgroundColor: string;
  textColor: string;
} {
  if (tone === "hot") {
    return { backgroundColor: colors.success + "14", textColor: colors.success };
  }
  if (tone === "seasonal") {
    return { backgroundColor: colors.warning + "14", textColor: colors.warning };
  }
  if (tone === "emerging") {
    return { backgroundColor: colors.secondary + "14", textColor: colors.secondary };
  }
  return { backgroundColor: colors.primary + "12", textColor: colors.primary };
}

function getDolibarrProductTaxRate(product: DolibarrProduct): number {
  const candidate = product.tva_tx;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function mergeUniqueProducts(
  current: DolibarrProduct[],
  incoming: DolibarrProduct[]
): DolibarrProduct[] {
  const seen = new Set<string>();
  const all = [...current];
  for (const product of current) {
    const id = getDolibarrProductId(product);
    const key = id ? `id:${id}` : `ref:${product.ref || ""}|label:${product.label || ""}`;
    seen.add(key);
  }
  for (const product of incoming) {
    const id = getDolibarrProductId(product);
    const key = id ? `id:${id}` : `ref:${product.ref || ""}|label:${product.label || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(product);
  }
  return all;
}

function mergeUniqueCustomers(
  current: DolibarrThirdParty[],
  incoming: DolibarrThirdParty[]
): DolibarrThirdParty[] {
  const seen = new Set<string>();
  const all = [...current];
  for (const customer of current) {
    const id = getDolibarrThirdPartyId(customer);
    const key = id
      ? `id:${id}`
      : `name:${getDolibarrThirdPartyLabel(customer)}|email:${customer.email || ""}`;
    seen.add(key);
  }
  for (const customer of incoming) {
    const id = getDolibarrThirdPartyId(customer);
    const key = id
      ? `id:${id}`
      : `name:${getDolibarrThirdPartyLabel(customer)}|email:${customer.email || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(customer);
  }
  return all;
}

function mergeConversationsById(
  current: Conversation[],
  incoming: Conversation[]
): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const entry of current) {
    if (entry?.id) {
      byId.set(entry.id, entry);
    }
  }
  for (const entry of incoming) {
    if (entry?.id) {
      byId.set(entry.id, {
        ...byId.get(entry.id),
        ...entry,
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.date.localeCompare(a.date));
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
  (
    process.env.EXPO_PUBLIC_GEMINI_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite"
  ).trim();
let preferredSpeechApiBase: string | null = null;
const DEFAULT_STT_PROVIDER_ORDER = "gemini";
const FORCE_SERVER_TRANSCRIPTION = true;
const SPEECH_API_HEALTH_TIMEOUT_MS = 1600;
const SPEECH_API_HEALTH_CACHE_TTL_MS = 45_000;
const speechApiHealthCache = new Map<string, { ok: boolean; checkedAt: number }>();

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
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
    lower.includes("recording is not available") ||
    lower.includes("recording unavailable") ||
    lower.includes("audio recorder") ||
    lower.includes("audio-capture") ||
    lower.includes("speech recognition unavailable") ||
    lower.includes("service-not-allowed")
  );
}

function shouldFallbackFromSpeechError(message: string, errorCode?: string): boolean {
  const normalizedCode = (errorCode || "").trim().toLowerCase();
  if (
    normalizedCode === "audio-capture" ||
    normalizedCode === "service-not-allowed" ||
    normalizedCode === "busy" ||
    normalizedCode === "client"
  ) {
    return true;
  }
  return isSpeechRecordingStartFailure(message);
}

function isSpeechRecognitionAvailable(): boolean {
  if (!ExpoSpeechRecognitionModule?.isRecognitionAvailable) return false;
  try {
    return Boolean(ExpoSpeechRecognitionModule.isRecognitionAvailable());
  } catch {
    return false;
  }
}

function supportsSpeechPersistedRecording(): boolean {
  if (!ExpoSpeechRecognitionModule?.supportsRecording) return false;
  try {
    return Boolean(ExpoSpeechRecognitionModule.supportsRecording());
  } catch {
    return false;
  }
}

function detectAudioMimeType(audioUri: string): string {
  const lower = audioUri.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/m4a";
  if (lower.endsWith(".mp4")) return "audio/m4a";
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

function getClientSpeechCredentialHeaders(): Record<string, string> {
  return {};
}

async function isSpeechApiBaseReachable(apiBase: string): Promise<boolean> {
  const cached = speechApiHealthCache.get(apiBase);
  const now = Date.now();
  if (cached && now - cached.checkedAt < SPEECH_API_HEALTH_CACHE_TTL_MS) {
    return cached.ok;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_API_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    const ok = response.ok;
    speechApiHealthCache.set(apiBase, { ok, checkedAt: now });
    return ok;
  } catch {
    speechApiHealthCache.set(apiBase, { ok: false, checkedAt: now });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeAudioWithSpeechApi(audioUri: string): Promise<string> {
  const query = new URLSearchParams({
    model: DEFAULT_S2T_MODEL,
    provider: DEFAULT_STT_PROVIDER_ORDER,
    with_diarization: "1",
    with_timestamps: "0",
    mode: "fast",
  });

  const apiBaseCandidates = await getApiBaseUrlCandidates();
  const orderedApiBaseCandidates = preferredSpeechApiBase
    ? [
        preferredSpeechApiBase,
        ...apiBaseCandidates.filter((apiBase) => apiBase !== preferredSpeechApiBase),
      ]
    : apiBaseCandidates;
  let lastNonNetworkError = "";
  const networkErrors: string[] = [];
  const credentialHeaders = getClientSpeechCredentialHeaders();

  for (const apiBase of orderedApiBaseCandidates) {
    const reachable = await isSpeechApiBaseReachable(apiBase);
    if (!reachable) {
      if (preferredSpeechApiBase === apiBase) {
        preferredSpeechApiBase = null;
      }
      networkErrors.push(`${apiBase} -> health check failed`);
      continue;
    }

    const endpoint = `${apiBase}/speech/transcribe?${query.toString()}`;
    try {
      let { status, payload } = await uploadSpeechAudioWithHeaders(
        endpoint,
        audioUri,
        credentialHeaders
      );

      if (
        (status < 200 || status >= 300) &&
        typeof payload?.message === "string" &&
        /loading|cold start|timed out/i.test(payload.message)
      ) {
        await wait(TRANSCRIBE_LOADING_RETRY_DELAY_MS);
        ({ status, payload } = await uploadSpeechAudioWithHeaders(
          endpoint,
          audioUri,
          credentialHeaders
        ));
      }

      if (status < 200 || status >= 300) {
        const apiError =
          typeof payload?.message === "string"
            ? payload.message
            : typeof payload?.error === "string"
              ? payload.error
              : `Speech transcription failed (${status}).`;
        const shouldTryNextApiBase = [404, 408, 425, 429, 500, 502, 503, 504].includes(status);
        if (shouldTryNextApiBase) {
          networkErrors.push(`${apiBase} -> HTTP ${status}: ${apiError}`);
          continue;
        }
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
    throw new Error(lastNonNetworkError);
  }
  if (networkErrors.length) {
    throw new Error(
      `Server is not reachable. Check API URL. Tried: ${networkErrors.join(" | ")}`
    );
  }
  throw new Error("Speech-to-text service unavailable.");
}

async function analyzeConversationWithBackendAIForMeeting(input: {
  transcript: string;
  customerName: string;
  salespersonName: string;
  model?: string;
}): Promise<MeetingAiAnalysisResult> {
  const apiBases = await getApiBaseUrlCandidates();
  const networkErrors: string[] = [];
  let lastNonNetworkError = "";

  for (const apiBase of apiBases) {
    const endpoint = `${apiBase}/ai/analyze`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...input,
          model:
            input.model ||
            process.env.EXPO_PUBLIC_GROQ_MODEL ||
            process.env.GROQ_MODEL ||
            "openai/gpt-oss-20b",
        }),
      });

      const raw = await response.text();
      let payload: any = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : `AI backend failed (${response.status}).`;
        throw new Error(message);
      }

      if (payload?.result && typeof payload.result === "object") {
        return payload.result as MeetingAiAnalysisResult;
      }
      if (payload && typeof payload === "object") {
        return payload as MeetingAiAnalysisResult;
      }
      throw new Error("AI backend returned invalid response payload.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI backend call failed.";
      if (/network request failed|failed to fetch|econn|enotfound|timed out/i.test(message.toLowerCase())) {
        networkErrors.push(`${apiBase} -> ${message}`);
        continue;
      }
      lastNonNetworkError = message;
      break;
    }
  }

  if (lastNonNetworkError) {
    throw new Error(lastNonNetworkError);
  }
  if (networkErrors.length > 0) {
    throw new Error(`AI backend is unreachable. Tried: ${networkErrors.join(" | ")}`);
  }
  throw new Error("AI backend call failed.");
}

const ROUTE_POINT_INTERVAL_MINUTES = 1;
const LIVE_ROUTE_REFRESH_MS = 15 * 1000;

function toMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function normalizeIdentity(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function addTrackedUserIdAliases(bucket: Set<string>, value: string | null | undefined): void {
  const normalized = (value || "").trim();
  if (!normalized) return;
  bucket.add(normalized);
  if (/^\d+$/.test(normalized)) {
    bucket.add(`dolibarr_${normalized}`);
  }
  const dolibarrMatch = normalized.match(/^dolibarr_(.+)$/i);
  const rawDolibarrId = dolibarrMatch?.[1]?.trim() || "";
  if (rawDolibarrId) {
    bucket.add(rawDolibarrId);
  }
}

function dedupeById<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const entry of entries) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function filterCompanyScoped<T extends { companyId?: string | null }>(
  entries: T[],
  companyId: string | null | undefined
): T[] {
  if (!companyId) return entries;
  return entries.filter((entry) => !entry.companyId || entry.companyId === companyId);
}

function buildUserIdCandidates(...values: (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    addTrackedUserIdAliases(ids, value);
  }
  return Array.from(ids);
}

function buildSelectedUserAliases(
  selectedEmployee: Employee | null,
  currentUser: { id: string; name: string; email: string } | null,
  attendance: AttendanceRecord[],
  selectedUserId: string
): Set<string> {
  const aliases = new Set<string>();
  const selectedIdAliases = new Set<string>();
  addTrackedUserIdAliases(selectedIdAliases, selectedUserId);
  addTrackedUserIdAliases(selectedIdAliases, selectedEmployee?.id);
  for (const alias of selectedIdAliases) {
    aliases.add(alias);
  }
  const employeeName = normalizeIdentity(selectedEmployee?.name);
  const employeeEmail = normalizeIdentity(selectedEmployee?.email);

  for (const entry of attendance) {
    if (!entry?.userId) continue;
    if (selectedIdAliases.has(entry.userId)) {
      addTrackedUserIdAliases(aliases, entry.userId);
      continue;
    }
    if (employeeName && normalizeIdentity(entry.userName) === employeeName) {
      addTrackedUserIdAliases(aliases, entry.userId);
    }
  }

  if (currentUser) {
    const userMatchesEmployee =
      (employeeEmail && normalizeIdentity(currentUser.email) === employeeEmail) ||
      (employeeName && normalizeIdentity(currentUser.name) === employeeName) ||
      selectedIdAliases.has(currentUser.id);
    if (userMatchesEmployee) {
      addTrackedUserIdAliases(aliases, currentUser.id);
    }
  }

  return aliases;
}

interface RouteSessionWindow {
  startAt: string | null;
  endAt: string | null;
}

function resolveRouteSessionWindow(attendanceEvents: AttendanceRecord[]): RouteSessionWindow {
  const ordered = [...attendanceEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let activeStartAt: string | null = null;
  let lastCompletedWindow: RouteSessionWindow = { startAt: null, endAt: null };

  for (const entry of ordered) {
    if (entry.type === "checkin") {
      activeStartAt = entry.timestamp;
      continue;
    }
    if (entry.type === "checkout" && activeStartAt) {
      lastCompletedWindow = {
        startAt: activeStartAt,
        endAt: entry.timestamp,
      };
      activeStartAt = null;
    }
  }

  if (activeStartAt) {
    return { startAt: activeStartAt, endAt: null };
  }
  return lastCompletedWindow;
}

function resolveCarryoverAttendanceRecord(
  records: AttendanceRecord[],
  selectedDateKey: string
): AttendanceRecord | null {
  const ordered = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let activeCheckIn: AttendanceRecord | null = null;

  for (const entry of ordered) {
    const entryDateKey = toMumbaiDateKey(new Date(entry.timestamp));
    if (entryDateKey >= selectedDateKey) {
      break;
    }

    if (entry.type === "checkin") {
      activeCheckIn = entry;
      continue;
    }

    if (entry.type === "checkout" && activeCheckIn) {
      activeCheckIn = null;
    }
  }

  return activeCheckIn;
}

function filterPointsToSessionWindow(
  points: LocationLog[],
  sessionWindow: RouteSessionWindow
): LocationLog[] {
  if (!sessionWindow.startAt && !sessionWindow.endAt) return points;
  return points.filter((point) => {
    if (sessionWindow.startAt && point.capturedAt < sessionWindow.startAt) return false;
    if (sessionWindow.endAt && point.capturedAt > sessionWindow.endAt) return false;
    return true;
  });
}

function downsamplePointsByInterval(points: LocationLog[], intervalMinutes: number): LocationLog[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const sampled: LocationLog[] = [];
  let lastIncludedMs = Number.NaN;

  for (const point of sorted) {
    const pointMs = toMs(point.capturedAt);
    if (!Number.isFinite(pointMs)) continue;
    if (!sampled.length) {
      sampled.push(point);
      lastIncludedMs = pointMs;
      continue;
    }
    if (pointMs - lastIncludedMs >= intervalMs) {
      sampled.push(point);
      lastIncludedMs = pointMs;
    }
  }
  return sampled;
}

function normalizePointsForInterval(points: LocationLog[], intervalMinutes: number): LocationLog[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const deduped: LocationLog[] = [];
  const seen = new Set<string>();

  for (const point of sorted) {
    const ms = toMs(point.capturedAt);
    if (!Number.isFinite(ms)) continue;
    const key = `${Math.round(ms / 1000)}_${point.latitude.toFixed(6)}_${point.longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(point);
  }

  return downsamplePointsByInterval(deduped, intervalMinutes);
}

function getTimelineLatestActivityAt(timeline: AdminRouteTimelineResponse | null | undefined): string {
  if (!timeline) return "";
  const latestPointAt = [...(timeline.points || [])]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .at(-1)?.capturedAt;
  const latestAttendanceAt = [...(timeline.attendanceEvents || [])]
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1)?.at;
  return [latestPointAt, latestAttendanceAt]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b))
    .at(-1) || "";
}

function getLatestAttendanceStatus(
  localAttendance: AttendanceRecord[],
  remoteAttendanceEvents: { type: "checkin" | "checkout"; at: string }[]
): { type: "checkin" | "checkout"; timestamp: string } | null {
  const combined = [
    ...localAttendance.map((entry) => ({ type: entry.type, timestamp: entry.timestamp })),
    ...remoteAttendanceEvents.map((entry) => ({ type: entry.type, timestamp: entry.at })),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return combined.at(-1) ?? null;
}

function getVisitStatus(task: Task): "pending" | "in_progress" | "completed" {
  if (task.departureAt || task.status === "completed") return "completed";
  if (task.arrivalAt || task.status === "in_progress") return "in_progress";
  return "pending";
}

function getVisitLabel(task: Task): string {
  return task.visitLocationLabel?.trim() || task.title.trim() || "Field Visit";
}

function normalizeVisitReminderMatchText(value: string | null | undefined): string {
  return (value || "")
    .toLowerCase()
    .replace(/^#\d+\s*/g, "")
    .replace(/^visit\s*\d+\s*[:\-]?\s*/g, "")
    .replace(/^dr\.?\s+/g, "")
    .replace(/^doctor\s+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getVisitReminderOrderCustomerLabel(order: DolibarrOrder): string {
  return order.thirdparty_name?.toString().trim() || order.socname?.trim() || order.label?.trim() || "";
}

function parseVisitReminderOrderDate(order: DolibarrOrder): string | null {
  const raw = order.date_commande ?? order.date_creation ?? order.date;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function parseVisitReminderOrderTotal(order: DolibarrOrder): number | null {
  const raw = order.total_ttc ?? order.total_ht ?? order.total;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatVisitReminderDate(value: string | null): string {
  if (!value) return "recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "recently";
  return parsed.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function formatVisitReminderCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function truncateVisitReminderText(value: string | null | undefined, maxLength = 86): string {
  const cleaned = (value || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}...`;
}

function buildVisitReminderSummary(task: Task, recentOrders: DolibarrOrder[]): {
  customerName: string;
  summary: string;
  detail: string | null;
} {
  const customerName = getVisitLabel(task);
  const normalizedTaskLabel = normalizeVisitReminderMatchText(customerName);
  const recentCutoff = Date.now() - VISIT_RECENT_ORDER_WINDOW_MS;
  const matchedOrders = recentOrders
    .map((order) => ({
      customerLabel: getVisitReminderOrderCustomerLabel(order),
      date: parseVisitReminderOrderDate(order),
      total: parseVisitReminderOrderTotal(order),
    }))
    .filter((entry) => {
      if (!entry.customerLabel) return false;
      const normalizedCustomerLabel = normalizeVisitReminderMatchText(entry.customerLabel);
      if (!normalizedCustomerLabel || !normalizedTaskLabel) return false;
      const labelMatches =
        normalizedTaskLabel.includes(normalizedCustomerLabel) ||
        normalizedCustomerLabel.includes(normalizedTaskLabel);
      if (!labelMatches) return false;
      if (!entry.date) return true;
      return new Date(entry.date).getTime() >= recentCutoff;
    })
    .sort((left, right) => {
      const leftTime = left.date ? new Date(left.date).getTime() : 0;
      const rightTime = right.date ? new Date(right.date).getTime() : 0;
      return rightTime - leftTime;
    });

  const latestOrder = matchedOrders[0] || null;
  const noteSnippet = truncateVisitReminderText(task.visitDepartureNotes || "");
  const addressSnippet = truncateVisitReminderText(task.visitLocationAddress || "", 74);

  if (latestOrder) {
    const amountLabel = formatVisitReminderCurrency(latestOrder.total);
    const countLabel =
      matchedOrders.length > 1 ? `${matchedOrders.length} recent orders` : "Recent order";
    return {
      customerName,
      summary: `${countLabel} · ${formatVisitReminderDate(latestOrder.date)}${
        amountLabel ? ` · ${amountLabel}` : ""
      }`,
      detail: noteSnippet || addressSnippet || "Open Sales AI to decide the next stop.",
    };
  }

  if (noteSnippet) {
    return {
      customerName,
      summary: "Saved departure note available",
      detail: noteSnippet,
    };
  }

  return {
    customerName,
    summary: addressSnippet || "Planned field visit nearby",
    detail: addressSnippet && addressSnippet !== "Planned field visit nearby"
      ? "Open Sales AI to review the stop."
      : null,
  };
}

function getVisitSubtitle(task: Task): string {
  const parts: string[] = [];
  if (task.visitLocationAddress?.trim()) parts.push(task.visitLocationAddress.trim());
  if (typeof task.visitLatitude === "number" && typeof task.visitLongitude === "number") {
    parts.push(`${task.visitLatitude.toFixed(5)}, ${task.visitLongitude.toFixed(5)}`);
  }
  return parts.join(" | ");
}

function getVisitStatusColor(
  status: "pending" | "in_progress" | "completed",
  colors: typeof Colors.light
): string {
  if (status === "completed") return colors.success;
  if (status === "in_progress") return colors.warning;
  return colors.textTertiary;
}

function formatBatteryPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(Math.max(0, Math.min(100, normalized)))}%`;
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
  const meetingNote = conversation.notes?.trim() || "";
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

      {meetingNote ? (
        <View
          style={[
            styles.notePreviewCard,
            {
              backgroundColor: colors.surface,
              borderColor: colors.borderLight,
            },
          ]}
        >
          <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
          <Text
            numberOfLines={2}
            style={[
              styles.notePreviewText,
              { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
            ]}
          >
            {meetingNote}
          </Text>
        </View>
      ) : null}

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
  const navigation = useNavigation();
  const { colors, isDark } = useAppTheme();
  const { user, company } = useAuth();
  const isAdminViewer = user?.role === "admin";
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [locationLogs, setLocationLogs] = useState<LocationLog[]>([]);
  const [quickSaleLocationLogs, setQuickSaleLocationLogs] = useState<QuickSaleLocationLog[]>([]);
  const [nearbyVisitHistory, setNearbyVisitHistory] = useState<VisitHistoryRecord[]>([]);
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [transcriptDraft, setTranscriptDraft] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribingFile, setIsTranscribingFile] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [departureNotesTask, setDepartureNotesTask] = useState<Task | null>(null);
  const [departureNotesDraft, setDepartureNotesDraft] = useState("");
  const [departureNotesModalVisible, setDepartureNotesModalVisible] = useState(false);
  const [departureCreateCustomerEnabled, setDepartureCreateCustomerEnabled] = useState(false);
  const [departureCustomerName, setDepartureCustomerName] = useState("");
  const [departureCustomerEmail, setDepartureCustomerEmail] = useState("");
  const [departureCustomerPhone, setDepartureCustomerPhone] = useState("");
  const [departureCustomerAddress, setDepartureCustomerAddress] = useState("");
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recognitionAvailable, setRecognitionAvailable] = useState(true);
  const [requestBusy, setRequestBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visitActionTaskId, setVisitActionTaskId] = useState<string | null>(null);
  const [activeVisitTaskId, setActiveVisitTaskId] = useState<string | null>(null);
  const [localMeetingCaptureTaskId, setLocalMeetingCaptureTaskId] = useState<string | null>(null);
  const persistedMeetingCaptureTaskId = useMemo(() => {
    if (isAdminViewer || !user) return null;
    const normalizedUserName = normalizeIdentity(user.name);
    return (
      tasks.find((task) => {
        if (task.taskType !== "field_visit") return false;
        if ((task.visitPlanDate || task.dueDate) !== todayDateKey) return false;
        if (getVisitStatus(task) !== "in_progress") return false;
        if (!task.autoCaptureRecordingActive) return false;
        if (task.autoCaptureRecordingStoppedAt) return false;
        const assignedName = normalizeIdentity(task.assignedToName);
        return task.assignedTo === user.id || (assignedName.length > 0 && assignedName === normalizedUserName);
      })?.id ?? null
    );
  }, [isAdminViewer, tasks, todayDateKey, user]);
  const meetingCaptureTaskId = localMeetingCaptureTaskId || persistedMeetingCaptureTaskId;
  const meetingFocusMode = !isAdminViewer && Boolean(meetingCaptureTaskId);
  const [mumbaiNowLabel, setMumbaiNowLabel] = useState(() =>
    formatMumbaiDateTime(new Date(), { withSeconds: true })
  );
  const todayDateKey = useMemo(() => toMumbaiDateKey(new Date()), [mumbaiNowLabel]);
  const [routePlanDate, setRoutePlanDate] = useState(() => toMumbaiDateKey(new Date()));
  const [routeStopInputMode, setRouteStopInputMode] = useState<"location" | "customer">("location");
  const [routeSearchQuery, setRouteSearchQuery] = useState("");
  const [routeSearchBusy, setRouteSearchBusy] = useState(false);
  const [routeSearchResults, setRouteSearchResults] = useState<RoutePlannerStop[]>([]);
  const [routePlannerCustomers, setRoutePlannerCustomers] = useState<DolibarrThirdParty[]>([]);
  const [routePlannerCustomersLoading, setRoutePlannerCustomersLoading] = useState(false);
  const [routeCustomerAddBusyId, setRouteCustomerAddBusyId] = useState<string | null>(null);
  const [routePlanStops, setRoutePlanStops] = useState<RoutePlannerStop[]>([]);
  const [routePlanDirty, setRoutePlanDirty] = useState(false);
  const [routePlanSaving, setRoutePlanSaving] = useState(false);
  const [routePreviewBusy, setRoutePreviewBusy] = useState(false);
  const [routePreviewError, setRoutePreviewError] = useState<string | null>(null);
  const [routePreview, setRoutePreview] = useState<MapplsRoutePreviewResponse | null>(null);
  const [adminRouteTimeline, setAdminRouteTimeline] = useState<AdminRouteTimelineResponse | null>(null);
  const [voicePulseBars, setVoicePulseBars] = useState<number[]>(VOICE_PULSE_BASELINE);
  const [voicePulseState, setVoicePulseState] = useState<"idle" | "listening" | "speaking">("idle");
  const [posProducts, setPosProducts] = useState<DolibarrProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<DolibarrOrder[]>([]);
  const [salesTrendRecommendations, setSalesTrendRecommendations] = useState<SalesTrendRecommendation[]>([]);
  const [salesTrendLoading, setSalesTrendLoading] = useState(false);
  const [meetingRecommendationVisible, setMeetingRecommendationVisible] = useState(false);
  const [meetingRecommendationConversation, setMeetingRecommendationConversation] = useState<Conversation | null>(null);
  const [meetingRecommendationItems, setMeetingRecommendationItems] = useState<
    MeetingConversationProductRecommendation[]
  >([]);
  const [isConversationReloading, setIsConversationReloading] = useState(false);
  const [posCustomers, setPosCustomers] = useState<DolibarrThirdParty[]>([]);
  const [posProductQuery, setPosProductQuery] = useState("");
  const [posCustomerQuery, setPosCustomerQuery] = useState("");
  const [posSelectedCustomerId, setPosSelectedCustomerId] = useState<string | null>(null);
  const [posCart, setPosCart] = useState<
    Record<string, { product: DolibarrProduct; qty: number; discountPercent: number }>
  >({});
  const [posQtyDrafts, setPosQtyDrafts] = useState<Record<string, string>>({});
  const [posLoading, setPosLoading] = useState(false);
  const [posSubmitting, setPosSubmitting] = useState(false);
  const [posError, setPosError] = useState<string | null>(null);
  const [posSuccess, setPosSuccess] = useState<string | null>(null);
  const [posProductsPage, setPosProductsPage] = useState(0);
  const [posProductsHasMore, setPosProductsHasMore] = useState(false);
  const [posProductsLoadingMore, setPosProductsLoadingMore] = useState(false);
  const [posLinkedVisitTaskId, setPosLinkedVisitTaskId] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const showMeetingExitBlockedAlert = useCallback(() => {
    Alert.alert(
      "End Meeting First",
      "Please tap Meeting End before leaving Sales Intelligence, switching sections, or sending the app to the background."
    );
  }, []);

  const finalSegmentsRef = useRef<string[]>([]);
  const rootListRef = useRef<FlatList<Conversation> | null>(null);
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
  const liveHintSpeechActiveRef = useRef(false);
  const liveHintSpeechRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceDetectedUntilRef = useRef(0);
  const voicePulseFrameRef = useRef(0);
  const voiceLevelRef = useRef(0);
  const voicePeakRef = useRef(0);
  const voiceLastInputAtRef = useRef(0);
  const isRecordingStateRef = useRef(false);
  const latestRoutePointRef = useRef<LocationLog | null>(null);
  const isTranscribingStateRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const meetingWasBackgroundedRef = useRef(false);
  const meetingResumeAlertShownRef = useRef(false);

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

  const loadConversations = useCallback(async (options?: { preserveExistingOnEmpty?: boolean; showBusy?: boolean }) => {
    const preserveExistingOnEmpty = options?.preserveExistingOnEmpty ?? true;
    const showBusy = options?.showBusy ?? false;
    if (!user) {
      setConversations([]);
      if (showBusy) {
        setIsConversationReloading(false);
      }
      return;
    }
    if (showBusy) {
      setIsConversationReloading(true);
    }
    try {
      const convos = await getConversations();
      setConversations((current) => {
        if (preserveExistingOnEmpty && convos.length === 0 && current.length > 0) {
          return current;
        }
        return convos;
      });
    } catch {
      // Keep the current list on transient failures so the admin feed stays visually stable.
    } finally {
      if (showBusy) {
        setIsConversationReloading(false);
      }
    }
  }, [user]);

  const loadData = useCallback(async () => {
    const [
      taskData,
      employeeData,
      logs,
      quickSaleLogs,
      attendance,
      remoteLogsState,
      remoteAttendanceState,
    ] = await Promise.all([
      getTasks(),
      getEmployees(),
      getLocationLogs(),
      getQuickSaleLocationLogs(),
      getAttendance(),
      isAdminViewer
        ? getRemoteState<LocationLog[]>("@trackforce_location_logs").catch(() => ({ value: null }))
        : Promise.resolve({ value: null }),
      isAdminViewer
        ? getRemoteState<AttendanceRecord[]>("@trackforce_attendance").catch(() => ({ value: null }))
        : Promise.resolve({ value: null }),
    ]);
    if (!user) {
      setTasks([]);
      setEmployees([]);
      setLocationLogs([]);
      setQuickSaleLocationLogs([]);
      setAttendanceRecords([]);
      setSelectedSalespersonId("");
      return;
    }

    setTasks(taskData);
    setEmployees(employeeData);
    const remoteLogs = Array.isArray(remoteLogsState.value)
      ? filterCompanyScoped(remoteLogsState.value, user.companyId)
      : [];
    const remoteAttendance = Array.isArray(remoteAttendanceState.value)
      ? filterCompanyScoped(remoteAttendanceState.value, user.companyId)
      : [];
    setLocationLogs(dedupeById([...remoteLogs, ...logs]));
    setQuickSaleLocationLogs(quickSaleLogs);
    setAttendanceRecords(dedupeById([...remoteAttendance, ...attendance]));

    const salesEmployees = employeeData.filter((entry) => isSalesRole(entry.role));
    if (isAdminViewer) {
      setSelectedSalespersonId((current) =>
        salesEmployees.some((entry) => entry.id === current) ? current : salesEmployees[0]?.id ?? ""
      );
      return;
    }

    const selfEmployee =
      employeeData.find((entry) => entry.id === user.id) ||
      employeeData.find((entry) => normalizeIdentity(entry.email) === normalizeIdentity(user.email)) ||
      employeeData.find((entry) => normalizeIdentity(entry.name) === normalizeIdentity(user.name));
    setSelectedSalespersonId(selfEmployee?.id || user.id);
  }, [isAdminViewer, user]);

  const loadPosData = useCallback(async (options?: { preferredCustomerId?: string | null; preserveSuccess?: boolean }) => {
    if (isAdminViewer) return;
    setPosLoading(true);
    setPosError(null);
    if (!options?.preserveSuccess) {
      setPosSuccess(null);
    }
    try {
      const [productsResult, customersResult, ordersResult] = await Promise.allSettled([
        getDolibarrProducts({
          limit: POS_PAGE_SIZE,
          sortfield: "label",
          sortorder: "asc",
          manufacturedOnly: true,
          sellableOnly: true,
        }),
        getDolibarrThirdParties({ limit: 200, sortfield: "nom", sortorder: "asc" }),
        getDolibarrOrders({ limit: 200, sortfield: "date_commande", sortorder: "desc" }),
      ]);
      const productList =
        productsResult.status === "fulfilled" && Array.isArray(productsResult.value)
          ? productsResult.value
          : [];
      const customerList =
        customersResult.status === "fulfilled" && Array.isArray(customersResult.value)
          ? customersResult.value
          : [];
      const ordersList =
        ordersResult.status === "fulfilled" && Array.isArray(ordersResult.value)
          ? ordersResult.value
          : [];

      setPosProducts(productList);
      setRecentOrders(ordersList);
      setPosProductsPage(0);
      setPosProductsHasMore(productList.length >= POS_PAGE_SIZE);
      setPosCustomers(customerList);
      const preferredCustomerId = options?.preferredCustomerId || posSelectedCustomerId;
      if (preferredCustomerId) {
        const matchedCustomer = customerList.find(
          (entry) => String(getDolibarrThirdPartyId(entry) ?? "") === String(preferredCustomerId)
        );
        if (matchedCustomer) {
          setPosSelectedCustomerId(String(preferredCustomerId));
        }
      } else {
        const firstCustomerId = customerList.length ? getDolibarrThirdPartyId(customerList[0]) : null;
        if (firstCustomerId) {
          setPosSelectedCustomerId(String(firstCustomerId));
        }
      }
      const hardFailures = [productsResult, customersResult].filter(
        (entry) => entry.status === "rejected"
      ) as PromiseRejectedResult[];
      if (hardFailures.length > 0) {
        const message = hardFailures
          .map((entry) => (entry.reason instanceof Error ? entry.reason.message : "Unable to load POS data."))
          .join(" | ");
        setPosError(message);
      } else if (ordersResult.status === "rejected") {
        setPosError(null);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load POS data from Dolibarr.";
      setPosError(message);
      setRecentOrders([]);
    } finally {
      setPosLoading(false);
    }
  }, [isAdminViewer, posSelectedCustomerId]);

  const ensureConversationRecommendationProducts = useCallback(async (): Promise<DolibarrProduct[]> => {
    if (posProducts.length) {
      return posProducts;
    }
    const products = await getDolibarrProducts({
      limit: 240,
      sortfield: "label",
      sortorder: "asc",
      manufacturedOnly: true,
      sellableOnly: true,
    });
    const productList = Array.isArray(products) ? products : [];
    if (productList.length) {
      setPosProducts((current) => mergeUniqueProducts(current, productList));
    }
    return productList;
  }, [posProducts]);

  useEffect(() => {
    void loadConversations();
    void loadData();
  }, [loadConversations, loadData]);

  useEffect(() => {
    return subscribeStorageUpdates((event) => {
      if (event.key !== STORAGE_KEYS.CONVERSATIONS) return;
      void loadConversations();
    });
  }, [loadConversations]);

  useEffect(() => {
    void loadPosData();
  }, [loadPosData]);

  const loadSalesTrendRecommendations = useCallback(async () => {
    if (!user) {
      setSalesTrendRecommendations([]);
      return;
    }
    setSalesTrendLoading(true);
    try {
      const [products, orders] = await Promise.all([
        getDolibarrProducts({
          limit: 240,
          sortfield: "label",
          sortorder: "asc",
          manufacturedOnly: true,
          sellableOnly: true,
        }).catch(() => [] as DolibarrProduct[]),
        getDolibarrOrders({
          limit: SALES_TREND_ORDER_LIMIT,
          sortfield: "date_commande",
          sortorder: "desc",
        }).catch(() => [] as DolibarrOrder[]),
      ]);

      const recentCutoff = Date.now() - SALES_TREND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const recentHotCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const scopedOrders = (Array.isArray(orders) ? orders : [])
        .filter((order) => {
          const date = getDolibarrOrderDate(order);
          return !date || date.getTime() >= recentCutoff;
        })
        .slice(0, SALES_TREND_ORDER_LIMIT);

      if (!scopedOrders.length) {
        setSalesTrendRecommendations([]);
        return;
      }

      const productsById = new Map<number, DolibarrProduct>();
      for (const product of Array.isArray(products) ? products : []) {
        const productId = getDolibarrProductId(product);
        if (productId) {
          productsById.set(productId, product);
        }
      }

      const aggregate = new Map<
        string,
        {
          id: string;
          label: string;
          ref: string | null;
          unitsSold: number;
          orderCount: number;
          revenue: number;
          recentUnitsSold: number;
          recentOrderIds: Set<string>;
          monthUnits: Map<string, number>;
          orderIds: Set<string>;
        }
      >();

      for (let index = 0; index < scopedOrders.length; index += SALES_TREND_BATCH_SIZE) {
        const chunk = scopedOrders.slice(index, index + SALES_TREND_BATCH_SIZE);
        const details = await Promise.all(
          chunk.map(async (order) => {
            if (!order.id) return null;
            try {
              return await getDolibarrOrderDetail(order.id);
            } catch {
              return null;
            }
          })
        );

        for (const detail of details) {
          const orderId = detail?.id ? String(detail.id) : null;
          const sourceOrder = detail?.id
            ? scopedOrders.find((entry) => String(entry.id) === String(detail.id)) || null
            : null;
          const orderDate = sourceOrder ? getDolibarrOrderDate(sourceOrder) : null;
          const orderMonth = orderDate ? orderDate.toISOString().slice(0, 7) : null;
          const lines = Array.isArray(detail?.lines) ? detail.lines : [];
          if (!orderId || !lines.length) continue;
          for (const line of lines) {
            const productId = parseNumericId(line.fk_product);
            const linkedProduct = productId ? productsById.get(productId) : null;
            const label =
              linkedProduct ? getDolibarrProductLabel(linkedProduct) : line.product_label?.trim() || line.label?.trim() || "Product";
            const ref = linkedProduct?.ref?.trim() || null;
            const key =
              productId !== null
                ? `id:${productId}`
                : ref
                  ? `ref:${normalizeSearchText(ref)}`
                  : `label:${normalizeSearchText(label)}`;
            const qty = getDolibarrOrderLineQty(line);
            const revenue = getDolibarrOrderLineRevenue(line, qty);
            const current = aggregate.get(key) || {
              id: productId !== null ? String(productId) : key,
              label,
              ref,
              unitsSold: 0,
              orderCount: 0,
              revenue: 0,
              recentUnitsSold: 0,
              recentOrderIds: new Set<string>(),
              monthUnits: new Map<string, number>(),
              orderIds: new Set<string>(),
            };
            current.unitsSold += qty;
            current.revenue += revenue;
            current.orderIds.add(orderId);
            current.orderCount = current.orderIds.size;
            if (orderDate && orderDate.getTime() >= recentHotCutoff) {
              current.recentUnitsSold += qty;
              current.recentOrderIds.add(orderId);
            }
            if (orderMonth) {
              current.monthUnits.set(orderMonth, (current.monthUnits.get(orderMonth) || 0) + qty);
            }
            aggregate.set(key, current);
          }
        }
      }

      const ranked = Array.from(aggregate.values())
        .filter((item) => isReliableTrendProduct(item.label, item.ref))
        .map(({ orderIds: _orderIds, recentOrderIds, monthUnits, ...item }) => {
          const monthlySeries = Array.from(monthUnits.entries()).sort((a, b) => a[0].localeCompare(b[0]));
          const activeMonths = monthlySeries.length;
          const bestMonth = monthlySeries.reduce<[string, number] | null>(
            (best, entry) => (!best || entry[1] > best[1] ? entry : best),
            null
          );
          const bestMonthLabel = bestMonth?.[0] || null;
          const bestMonthUnits = bestMonth?.[1] || 0;
          const avgMonthlyUnits =
            activeMonths > 0 ? monthlySeries.reduce((sum, entry) => sum + entry[1], 0) / activeMonths : 0;
          const tags = classifySalesTrendTags({
            unitsSold: item.unitsSold,
            orderCount: item.orderCount,
            activeMonths,
            recentUnitsSold: item.recentUnitsSold,
            recentOrderCount: recentOrderIds.size,
            bestMonthUnits,
            avgMonthlyUnits,
            bestMonthLabel,
          });
          const reliabilityBoost =
            activeMonths >= 3 ? 6 : activeMonths === 2 ? 3 : 0;
          const score =
            item.orderCount * 5 +
            Math.min(18, item.unitsSold) +
            item.recentUnitsSold * 2 +
            reliabilityBoost;
          return {
            ...item,
            activeMonths,
            bestMonthLabel,
            recentOrderCount: recentOrderIds.size,
            tags,
            reason: tags[0]?.reason || `${item.unitsSold} units sold across ${item.orderCount} recent orders.`,
            score,
          };
        })
        .filter(
          (item) =>
            item.orderCount >= 2 &&
            (item.activeMonths >= 2 || item.recentOrderCount >= 2 || item.unitsSold >= 8)
        )
        .sort((a, b) => b.score - a.score || b.revenue - a.revenue)
        .slice(0, 5)
        .map(({ score: _score, ...item }) => item);

      setSalesTrendRecommendations(ranked);
    } catch {
      setSalesTrendRecommendations([]);
    } finally {
      setSalesTrendLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (meetingFocusMode) return;
    void loadSalesTrendRecommendations();
  }, [loadSalesTrendRecommendations, meetingFocusMode]);

  useEffect(() => {
    if (isAdminViewer || !persistedMeetingCaptureTaskId) return;
    setLocalMeetingCaptureTaskId((current) =>
      current === persistedMeetingCaptureTaskId ? current : persistedMeetingCaptureTaskId
    );
  }, [isAdminViewer, persistedMeetingCaptureTaskId]);

  useEffect(() => {
    if (!localMeetingCaptureTaskId) return;
    if (visitActionTaskId === localMeetingCaptureTaskId) return;
    const hasActiveMeetingTask = tasks.some((task) => {
      if (task.id !== localMeetingCaptureTaskId) return false;
      if (task.taskType !== "field_visit") return false;
      if ((task.visitPlanDate || task.dueDate) !== todayDateKey) return false;
      if (getVisitStatus(task) !== "in_progress") return false;
      if (!task.autoCaptureRecordingActive) return false;
      if (task.autoCaptureRecordingStoppedAt) return false;
      return true;
    });
    if (!hasActiveMeetingTask) {
      setLocalMeetingCaptureTaskId(null);
    }
  }, [localMeetingCaptureTaskId, tasks, todayDateKey, visitActionTaskId]);

  const resolveVisitArrivalSnapshot = useCallback(async () => {
    const lastKnownLocation = await getLastKnownLocationSafe({
      requiredAccuracy: 180,
      maxAgeMs: 10 * 60 * 1000,
    }).catch(() => null);

    if (
      typeof lastKnownLocation?.coords.latitude === "number" &&
      Number.isFinite(lastKnownLocation.coords.latitude) &&
      typeof lastKnownLocation?.coords.longitude === "number" &&
      Number.isFinite(lastKnownLocation.coords.longitude)
    ) {
      return {
        latitude: lastKnownLocation.coords.latitude,
        longitude: lastKnownLocation.coords.longitude,
        capturedAt: lastKnownLocation.timestamp
          ? new Date(lastKnownLocation.timestamp).toISOString()
          : new Date().toISOString(),
      };
    }
    const fallbackRoutePoint = latestRoutePointRef.current;
    if (
      typeof fallbackRoutePoint?.latitude === "number" &&
      Number.isFinite(fallbackRoutePoint.latitude) &&
      typeof fallbackRoutePoint?.longitude === "number" &&
      Number.isFinite(fallbackRoutePoint.longitude)
    ) {
      return {
        latitude: fallbackRoutePoint.latitude,
        longitude: fallbackRoutePoint.longitude,
        capturedAt: fallbackRoutePoint.capturedAt,
      };
    }
    return null;
  }, []);

  useEffect(() => {
    if (meetingFocusMode) return;
    const timer = setInterval(() => {
      void loadData();
    }, LIVE_ROUTE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadData, meetingFocusMode]);

  useEffect(() => {
    const timer = setInterval(() => {
      setMumbaiNowLabel(formatMumbaiDateTime(new Date(), { withSeconds: true }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSubscription = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height || 0);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    isRecordingStateRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isTranscribingStateRef.current = isTranscribingFile;
  }, [isTranscribingFile]);

  useEffect(() => {
    if (!meetingFocusMode) return;
    const unsubscribe = navigation.addListener("beforeRemove", (event) => {
      event.preventDefault();
      showMeetingExitBlockedAlert();
    });
    return unsubscribe;
  }, [meetingFocusMode, navigation, showMeetingExitBlockedAlert]);

  useEffect(() => {
    if (!meetingFocusMode) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      showMeetingExitBlockedAlert();
      return true;
    });
    return () => subscription.remove();
  }, [meetingFocusMode, showMeetingExitBlockedAlert]);

  useEffect(() => {
    if (meetingFocusMode) return;
    meetingWasBackgroundedRef.current = false;
    meetingResumeAlertShownRef.current = false;
  }, [meetingFocusMode]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (!meetingFocusMode) {
        meetingWasBackgroundedRef.current = false;
        meetingResumeAlertShownRef.current = false;
        return;
      }

      if (nextState === "inactive" || nextState === "background") {
        meetingWasBackgroundedRef.current = true;
        meetingResumeAlertShownRef.current = false;
        return;
      }

      if (nextState === "active" && previousState !== "active" && meetingWasBackgroundedRef.current) {
        meetingWasBackgroundedRef.current = false;
        router.replace("/(tabs)/sales");
        if (!meetingResumeAlertShownRef.current) {
          meetingResumeAlertShownRef.current = true;
          Alert.alert(
            "Meeting Still Running",
            "Meeting start ho chuki hai. Ab isi screen par raho aur bahar nikalne se pehle Meeting End tap karo."
          );
        }
      }
    });
    return () => subscription.remove();
  }, [meetingFocusMode]);

  useEffect(() => {
    const available = isSpeechRecognitionAvailable();
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
      liveHintSpeechActiveRef.current = false;
      if (liveHintSpeechRestartTimerRef.current) {
        clearTimeout(liveHintSpeechRestartTimerRef.current);
        liveHintSpeechRestartTimerRef.current = null;
      }
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
    const value = sanitizeConversationTranscript(segment.trim());
    if (!value) return;
    const previous = finalSegmentsRef.current[finalSegmentsRef.current.length - 1];
    if (value !== previous) {
      finalSegmentsRef.current = [...finalSegmentsRef.current, value];
    }
    setTranscriptDraft(finalSegmentsRef.current.join(" ").trim());
  }, []);

  const startLiveHintSpeechRecognition = useCallback(() => {
    if (!ExpoSpeechRecognitionModule) return;
    if (!recognitionAvailable) return;
    if (liveHintSpeechActiveRef.current) return;
    if (!fallbackLoopRunningRef.current || fallbackStopRequestedRef.current) return;
    if (liveHintSpeechRestartTimerRef.current) {
      clearTimeout(liveHintSpeechRestartTimerRef.current);
      liveHintSpeechRestartTimerRef.current = null;
    }

    liveHintSpeechActiveRef.current = true;
    try {
      ExpoSpeechRecognitionModule.start({
        interimResults: true,
        continuous: true,
        addsPunctuation: false,
        maxAlternatives: 1,
        volumeChangeEventOptions: {
          enabled: true,
          intervalMillis: 45,
        },
        androidIntentOptions: {
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 60_000,
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 12_000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 8_000,
          EXTRA_MASK_OFFENSIVE_WORDS: false,
        },
      });
    } catch {
      liveHintSpeechActiveRef.current = false;
    }
  }, [recognitionAvailable]);

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
    const transcript = sanitizeConversationTranscript(event.results?.[0]?.transcript?.trim() ?? "");
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
    const message = event.message || TRANSCRIPTION_FAILED_MESSAGE;
    if (sessionModeRef.current === "audio-fallback") {
      liveHintSpeechActiveRef.current = false;
      if (
        fallbackLoopRunningRef.current &&
        !fallbackStopRequestedRef.current &&
        !liveHintSpeechRestartTimerRef.current
      ) {
        liveHintSpeechRestartTimerRef.current = setTimeout(() => {
          liveHintSpeechRestartTimerRef.current = null;
          startLiveHintSpeechRecognition();
        }, LIVE_HINT_RESTART_DELAY_MS);
      }
      return;
    }
    const shouldAutoFallback =
      recordingModeRef.current === "speech" &&
      sessionModeRef.current === "recording" &&
      shouldFallbackFromSpeechError(message, event.error);

    if (shouldAutoFallback) {
      setRecordError("Speech recorder unavailable. Switching to backup recorder...");
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
          setRecordError(
            getErrorMessage(
              fallbackError,
              "Backup recorder could not start. Check microphone permission and try again."
            )
          );
        }
      })();
      return;
    }

    setRecordError(message);
  });

  useSpeechRecognitionEvent("end", () => {
    if (sessionModeRef.current === "audio-fallback") {
      liveHintSpeechActiveRef.current = false;
      if (
        fallbackLoopRunningRef.current &&
        !fallbackStopRequestedRef.current &&
        !liveHintSpeechRestartTimerRef.current
      ) {
        liveHintSpeechRestartTimerRef.current = setTimeout(() => {
          liveHintSpeechRestartTimerRef.current = null;
          startLiveHintSpeechRecognition();
        }, LIVE_HINT_RESTART_DELAY_MS);
      }
      return;
    }
    if (startedAtRef.current !== null) {
      setElapsedMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
    setIsRecording(false);
    setIsTranscribingFile(false);
    sessionModeRef.current = "idle";
    recordingModeRef.current = null;
  });

  const selectableSalespeople = useMemo(() => {
    if (!user) return [] as Employee[];
    if (isAdminViewer) {
      return employees.filter((entry) => isSalesRole(entry.role));
    }
    const selfEmployee =
      employees.find((entry) => entry.id === selectedSalespersonId) ||
      employees.find((entry) => normalizeIdentity(entry.email) === normalizeIdentity(user.email)) ||
      employees.find((entry) => normalizeIdentity(entry.name) === normalizeIdentity(user.name));
    if (selfEmployee) return [selfEmployee];
    return [];
  }, [employees, isAdminViewer, selectedSalespersonId, user]);

  const selectedSalesperson = useMemo(
    () => selectableSalespeople.find((entry) => entry.id === selectedSalespersonId) ?? null,
    [selectableSalespeople, selectedSalespersonId]
  );

  const selectedSalespersonTaskAliases = useMemo(() => {
    const aliases = new Set<string>();
    if (selectedSalespersonId) aliases.add(selectedSalespersonId);
    if (selectedSalesperson?.id) aliases.add(selectedSalesperson.id);
    if (user?.id) aliases.add(user.id);
    if (user) {
      const userEmail = normalizeIdentity(user.email);
      const userName = normalizeIdentity(user.name);
      for (const employee of employees) {
        if (
          normalizeIdentity(employee.email) === userEmail ||
          normalizeIdentity(employee.name) === userName
        ) {
          aliases.add(employee.id);
        }
      }
    }
    return aliases;
  }, [employees, selectedSalesperson, selectedSalespersonId, user]);

  const todaysVisitTasks = useMemo(() => {
    if (!selectedSalespersonId) return [] as Task[];
    return tasks
      .filter((task) => task.taskType === "field_visit")
      .filter((task) => {
        if (isAdminViewer) return task.assignedTo === selectedSalespersonId;
        const matchesAlias = selectedSalespersonTaskAliases.has(task.assignedTo);
        const assignedName = normalizeIdentity(task.assignedToName);
        const userName = normalizeIdentity(user?.name);
        const selectedName = normalizeIdentity(selectedSalesperson?.name);
        return (
          matchesAlias ||
          (assignedName && assignedName === userName) ||
          (assignedName && assignedName === selectedName)
        );
      })
      .filter((task) => (task.visitPlanDate || task.dueDate) === todayDateKey)
      .sort((a, b) => {
        const seqA = typeof a.visitSequence === "number" ? a.visitSequence : Number.POSITIVE_INFINITY;
        const seqB = typeof b.visitSequence === "number" ? b.visitSequence : Number.POSITIVE_INFINITY;
        if (seqA !== seqB) return seqA - seqB;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }, [
    isAdminViewer,
    selectedSalesperson?.name,
    selectedSalespersonId,
    selectedSalespersonTaskAliases,
    tasks,
    todayDateKey,
    user?.name,
  ]);
  const activeVisitTask = useMemo(
    () => todaysVisitTasks.find((task) => getVisitStatus(task) === "in_progress") ?? null,
    [todaysVisitTasks]
  );
  const selectedDateVisitTasks = useMemo(() => {
    if (!selectedSalespersonId) return [] as Task[];
    return tasks
      .filter((task) => task.taskType === "field_visit")
      .filter((task) => {
        if (isAdminViewer) return task.assignedTo === selectedSalespersonId;
        const matchesAlias = selectedSalespersonTaskAliases.has(task.assignedTo);
        const assignedName = normalizeIdentity(task.assignedToName);
        const userName = normalizeIdentity(user?.name);
        const selectedName = normalizeIdentity(selectedSalesperson?.name);
        return (
          matchesAlias ||
          (assignedName && assignedName === userName) ||
          (assignedName && assignedName === selectedName)
        );
      })
      .filter((task) => (task.visitPlanDate || task.dueDate) === routePlanDate)
      .sort((a, b) => {
        const seqA = typeof a.visitSequence === "number" ? a.visitSequence : Number.POSITIVE_INFINITY;
        const seqB = typeof b.visitSequence === "number" ? b.visitSequence : Number.POSITIVE_INFINITY;
        if (seqA !== seqB) return seqA - seqB;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }, [
    isAdminViewer,
    routePlanDate,
    selectedSalesperson?.name,
    selectedSalespersonId,
    selectedSalespersonTaskAliases,
    tasks,
    user?.name,
  ]);

  const salespersonVisitTasks = useMemo(() => {
    if (!selectedSalespersonId) return [] as Task[];
    return tasks
      .filter((task) => task.taskType === "field_visit")
      .filter((task) => {
        if (isAdminViewer) return task.assignedTo === selectedSalespersonId;
        const matchesAlias = selectedSalespersonTaskAliases.has(task.assignedTo);
        const assignedName = normalizeIdentity(task.assignedToName);
        const userName = normalizeIdentity(user?.name);
        const selectedName = normalizeIdentity(selectedSalesperson?.name);
        return (
          matchesAlias ||
          (assignedName && assignedName === userName) ||
          (assignedName && assignedName === selectedName)
        );
      })
      .sort((a, b) => {
        const timeA = a.departureAt || a.arrivalAt || a.createdAt;
        const timeB = b.departureAt || b.arrivalAt || b.createdAt;
        return timeB.localeCompare(timeA);
      });
  }, [
    isAdminViewer,
    selectedSalesperson?.name,
    selectedSalespersonId,
    selectedSalespersonTaskAliases,
    tasks,
    user?.name,
  ]);

  useEffect(() => {
    if (isAdminViewer || !user?.id || meetingFocusMode) return;
    void syncLocationReminderCatalog({
      salespersonId: user.id,
      companyId: user.companyId ?? null,
      tasks: salespersonVisitTasks,
      recentOrders,
      quickSales: quickSaleLocationLogs,
    }).catch(() => {
      // Non-blocking: reminder catalog should never interrupt sales workflow.
    });
  }, [
    isAdminViewer,
    meetingFocusMode,
    quickSaleLocationLogs,
    recentOrders,
    salespersonVisitTasks,
    user?.companyId,
    user?.id,
  ]);

  const selectedDatePlannedStops = useMemo(
    () =>
      selectedDateVisitTasks
        .filter((task) => task.status === "pending" && !task.arrivalAt && !task.departureAt)
        .map((task) => toRoutePlannerStopFromTask(task))
        .filter((stop): stop is RoutePlannerStop => Boolean(stop)),
    [selectedDateVisitTasks]
  );

  const plannedStops = useMemo<PlannedStopPoint[]>(
    () =>
      todaysVisitTasks
        .filter(
          (task) => typeof task.visitLatitude === "number" && typeof task.visitLongitude === "number"
        )
        .map((task) => {
          const reminderSummary = buildVisitReminderSummary(task, recentOrders);
          return {
            id: task.id,
            label:
              typeof task.visitSequence === "number"
                ? `#${task.visitSequence} ${reminderSummary.customerName}`
                : reminderSummary.customerName,
            customerName: reminderSummary.customerName,
            latitude: task.visitLatitude as number,
            longitude: task.visitLongitude as number,
            status: getVisitStatus(task),
            summary: reminderSummary.summary,
            detail: reminderSummary.detail,
          };
        }),
    [recentOrders, todaysVisitTasks]
  );

  const plannerPreviewStops = useMemo<PlannedStopPoint[]>(
    () =>
      routePlanStops.map((stop, index) => ({
        id: `${stop.id}_preview_${index + 1}`,
        label: `#${index + 1} ${stop.label}`,
        latitude: stop.latitude,
        longitude: stop.longitude,
        status: "pending",
      })),
    [routePlanStops]
  );

  const selectedSalespersonAliases = useMemo(() => {
    if (!user || !selectedSalespersonId) return new Set<string>();
    return buildSelectedUserAliases(
      selectedSalesperson,
      { id: user.id, name: user.name, email: user.email },
      attendanceRecords,
      selectedSalespersonId
    );
  }, [attendanceRecords, selectedSalesperson, selectedSalespersonId, user]);

  const selectedSalespersonAttendance = useMemo(
    () => {
      const allAttendance = attendanceRecords
        .filter((entry) => selectedSalespersonAliases.has(entry.userId))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const carryoverAttendance = resolveCarryoverAttendanceRecord(allAttendance, todayDateKey);
      return dedupeById(
        [
          ...(carryoverAttendance ? [carryoverAttendance] : []),
          ...allAttendance.filter((entry) => isMumbaiDateKey(entry.timestamp, todayDateKey)),
        ].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      );
    },
    [attendanceRecords, selectedSalespersonAliases, todayDateKey]
  );

  const latestSelectedSalespersonStatus = useMemo(
    () =>
      getLatestAttendanceStatus(
        selectedSalespersonAttendance,
        adminRouteTimeline?.attendanceEvents || []
      ),
    [adminRouteTimeline?.attendanceEvents, selectedSalespersonAttendance]
  );

  const isSelectedSalespersonTrackingActive = latestSelectedSalespersonStatus?.type === "checkin";
  const isSelectedSalespersonCheckedOut = latestSelectedSalespersonStatus?.type === "checkout";
  const selectedSalespersonTrackingTitle = isSelectedSalespersonCheckedOut ? "Checked Out" : "Not Checked In";
  const selectedSalespersonTrackingMessage = isSelectedSalespersonCheckedOut
    ? `${selectedSalesperson?.name || "This salesperson"} checked out${
        latestSelectedSalespersonStatus?.timestamp
          ? ` at ${formatMumbaiTime(latestSelectedSalespersonStatus.timestamp)}`
          : ""
      }. Map is hidden until next check-in.`
    : `${selectedSalesperson?.name || "This salesperson"} has not checked in yet for today.`;

  const localRouteTimeline = useMemo(() => {
    if (!user || !selectedSalespersonId) {
      return buildRouteTimeline("", todayDateKey, []);
    }
    if (!isSelectedSalespersonTrackingActive) {
      return buildRouteTimeline(selectedSalespersonId, todayDateKey, []);
    }
    const sessionWindow = resolveRouteSessionWindow(selectedSalespersonAttendance);
    const selectedDayPoints = locationLogs
      .filter((entry) => selectedSalespersonAliases.has(entry.userId))
      .filter((entry) => isMumbaiDateKey(entry.capturedAt, todayDateKey));
    const normalizedPoints = normalizePointsForInterval(
      filterPointsToSessionWindow(selectedDayPoints, sessionWindow),
      ROUTE_POINT_INTERVAL_MINUTES
    );
    return buildRouteTimeline(selectedSalespersonId, todayDateKey, normalizedPoints);
  }, [
    isSelectedSalespersonTrackingActive,
    locationLogs,
    selectedSalespersonAliases,
    selectedSalespersonAttendance,
    selectedSalespersonId,
    todayDateKey,
    user,
  ]);

  useEffect(() => {
    setAdminRouteTimeline(null);
    if (!isAdminViewer || !selectedSalespersonId) {
      return;
    }

    let cancelled = false;
    const candidateIds = buildUserIdCandidates(
      selectedSalespersonId,
      selectedSalesperson?.id,
      ...Array.from(selectedSalespersonAliases)
    );

    void (async () => {
      let resolvedTimeline: AdminRouteTimelineResponse | null = null;

      for (const candidateId of candidateIds) {
        try {
          const currentTimeline = await getAdminRouteTimeline(
            candidateId,
            todayDateKey,
            ROUTE_POINT_INTERVAL_MINUTES
          );
          const currentLatestActivity = getTimelineLatestActivityAt(currentTimeline);
          const resolvedLatestActivity = getTimelineLatestActivityAt(resolvedTimeline);
          const currentPointCount = currentTimeline.points?.length ?? 0;
          const resolvedPointCount = resolvedTimeline?.points?.length ?? 0;
          if (
            !resolvedTimeline ||
            currentLatestActivity.localeCompare(resolvedLatestActivity) > 0 ||
            (currentLatestActivity === resolvedLatestActivity && currentPointCount > resolvedPointCount)
          ) {
            resolvedTimeline = currentTimeline;
          }
        } catch {
          // try next candidate
        }
      }

      if ((!resolvedTimeline || (resolvedTimeline.points?.length ?? 0) === 0) && candidateIds.length) {
        try {
          const liveRoutes = await getAdminLiveMapRoutes(todayDateKey, ROUTE_POINT_INTERVAL_MINUTES);
          const matchingRoute = (liveRoutes.routes || [])
            .filter((route) => candidateIds.includes(route.userId) && (route.points?.length ?? 0) > 0)
            .sort((a, b) => {
              const aTime = a.latestPoint?.capturedAt || "";
              const bTime = b.latestPoint?.capturedAt || "";
              return bTime.localeCompare(aTime);
            })[0];
          if (matchingRoute) {
            resolvedTimeline = {
              ...buildRouteTimeline(selectedSalespersonId, todayDateKey, matchingRoute.points),
              attendanceEvents: resolvedTimeline?.attendanceEvents || [],
            };
          }
        } catch {
          // keep best-effort local/admin timeline fallback
        }
      }

      if (!cancelled) {
        setAdminRouteTimeline(resolvedTimeline);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    attendanceRecords,
    isAdminViewer,
    locationLogs,
    selectedSalesperson?.id,
    selectedSalespersonAliases,
    selectedSalespersonId,
    todayDateKey,
  ]);

  const routeTimeline = useMemo(() => {
    if (!isSelectedSalespersonTrackingActive) {
      return buildRouteTimeline(selectedSalespersonId || "", todayDateKey, []);
    }
    if (isAdminViewer) {
      return adminRouteTimeline && (adminRouteTimeline.points?.length ?? 0) > 0
        ? adminRouteTimeline
        : localRouteTimeline;
    }
    return localRouteTimeline;
  }, [
    adminRouteTimeline,
    isAdminViewer,
    isSelectedSalespersonTrackingActive,
    localRouteTimeline,
    selectedSalespersonId,
    todayDateKey,
  ]);

  const latestRoutePoint = useMemo(() => {
    if (!routeTimeline.points.length) return null;
    return [...routeTimeline.points].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  }, [routeTimeline.points]);

  useEffect(() => {
    latestRoutePointRef.current = latestRoutePoint;
  }, [latestRoutePoint]);

  useEffect(() => {
    if (!user || !latestRoutePoint || !selectedSalespersonId) {
      setNearbyVisitHistory([]);
      return;
    }

    const salespersonId = isAdminViewer ? selectedSalespersonId : user.id;
    if (!salespersonId) {
      setNearbyVisitHistory([]);
      return;
    }

    let cancelled = false;
    void getNearbyVisitHistory({
      latitude: latestRoutePoint.latitude,
      longitude: latestRoutePoint.longitude,
      radiusMeters: VISIT_NEARBY_RADIUS_METERS,
      salespersonId,
      limit: 12,
    })
      .then((items) => {
        if (!cancelled) {
          setNearbyVisitHistory(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNearbyVisitHistory([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    isAdminViewer,
    latestRoutePoint?.capturedAt,
    latestRoutePoint?.latitude,
    latestRoutePoint?.longitude,
    selectedSalespersonId,
    user?.id,
  ]);

  const nearbyAwarePlannedStops = useMemo<PlannedStopPoint[]>(
    () =>
      plannedStops.map((stop) => {
        if (!latestRoutePoint) {
          return {
            ...stop,
            isNearby: false,
            distanceMeters: null,
          };
        }
        const distanceMeters = haversineDistanceMeters(
          latestRoutePoint.latitude,
          latestRoutePoint.longitude,
          stop.latitude,
          stop.longitude
        );
        const isNearby =
          Number.isFinite(distanceMeters) &&
          distanceMeters <= VISIT_NEARBY_RADIUS_METERS &&
          stop.status !== "completed";
        return {
          ...stop,
          isNearby,
          distanceMeters: Math.round(distanceMeters),
        };
      }),
    [latestRoutePoint, plannedStops]
  );

  const nearbyHistoricalVisitStops = useMemo<PlannedStopPoint[]>(
    () =>
      nearbyVisitHistory
        .filter(
          (entry) =>
            typeof entry.visitLatitude === "number" &&
            Number.isFinite(entry.visitLatitude) &&
            typeof entry.visitLongitude === "number" &&
            Number.isFinite(entry.visitLongitude)
        )
        .map((entry) => ({
          id: `history_${entry.taskId}`,
          label: entry.visitLabel,
          customerName: entry.visitLabel,
          latitude: entry.visitLatitude,
          longitude: entry.visitLongitude,
          status: "completed",
          markerKind: "visit_history",
          summary: entry.visitDepartureNotes?.trim()
            ? `Last note: ${entry.visitDepartureNotes.trim()}`
            : entry.meetingNotes?.trim()
              ? `Meeting note: ${entry.meetingNotes.trim()}`
              : "Past visit completed here.",
          detail: entry.departureAt
            ? `Departed ${formatMumbaiTime(entry.departureAt)}${entry.visitLocationAddress ? ` • ${entry.visitLocationAddress}` : ""}`
            : entry.visitLocationAddress || "Past visit location",
          isNearby: true,
          distanceMeters:
            typeof entry.distanceMeters === "number" && Number.isFinite(entry.distanceMeters)
              ? Math.round(entry.distanceMeters)
              : null,
        } satisfies PlannedStopPoint)),
    [nearbyVisitHistory]
  );

  const nearbyQuickSalePoints = useMemo<QuickSalePoint[]>(
    () =>
      quickSaleLocationLogs
        .filter((entry) => {
          if (isAdminViewer) {
            return selectedSalespersonId ? entry.salespersonId === selectedSalespersonId : true;
          }
          return entry.salespersonId === user?.id;
        })
        .map((entry) => {
          const distanceMeters = latestRoutePoint
            ? haversineDistanceMeters(
                latestRoutePoint.latitude,
                latestRoutePoint.longitude,
                entry.latitude,
                entry.longitude
              )
            : null;
          const isNearby =
            typeof distanceMeters === "number" &&
            Number.isFinite(distanceMeters) &&
            distanceMeters <= VISIT_NEARBY_RADIUS_METERS;
          return {
            id: entry.id,
            customerName: entry.customerName,
            latitude: entry.latitude,
            longitude: entry.longitude,
            orderId: entry.orderId,
            itemCount: entry.itemCount,
            totalAmount: entry.totalAmount,
            soldAt: entry.capturedAt,
            customerAddress: entry.customerAddress ?? null,
            customerEmail: entry.customerEmail ?? null,
            visitLabel: entry.visitLabel ?? null,
            visitDepartureNotes: entry.visitDepartureNotes ?? null,
            visitDepartedAt: entry.visitDepartedAt ?? null,
            isNearby,
            distanceMeters:
              typeof distanceMeters === "number" && Number.isFinite(distanceMeters)
                ? Math.round(distanceMeters)
                : null,
          } satisfies QuickSalePoint;
        }),
    [isAdminViewer, latestRoutePoint, quickSaleLocationLogs, selectedSalespersonId, user?.id]
  );

  const visiblePlannedStops = useMemo<PlannedStopPoint[]>(
    () =>
      isAdminViewer && routePlanDate === todayDateKey
        ? routePlanDirty
          ? plannerPreviewStops
          : nearbyAwarePlannedStops
        : nearbyAwarePlannedStops,
    [
      isAdminViewer,
      nearbyAwarePlannedStops,
      plannerPreviewStops,
      routePlanDate,
      routePlanDirty,
      todayDateKey,
    ]
  );

  const mapPlannedStops = useMemo<PlannedStopPoint[]>(
    () => [
      ...visiblePlannedStops,
      ...nearbyHistoricalVisitStops.filter((stop) => stop.markerKind === "visit_history" && stop.isNearby),
    ],
    [nearbyHistoricalVisitStops, visiblePlannedStops]
  );

  const currentLocationMeta = latestRoutePoint
    ? `${formatMumbaiTime(latestRoutePoint.capturedAt)} | ${formatBatteryPercent(
        latestRoutePoint.batteryLevel
      )}`
    : isSelectedSalespersonTrackingActive
      ? "Waiting for live GPS point..."
      : selectedSalespersonTrackingMessage;

  const navigationStops = useMemo<RoutePlannerStop[]>(() => {
    const taskBackedStops = todaysVisitTasks
      .filter(
        (task) =>
          typeof task.visitLatitude === "number" &&
          typeof task.visitLongitude === "number" &&
          getVisitStatus(task) !== "completed"
      )
      .map((task) => toRoutePlannerStopFromTask(task))
      .filter((stop): stop is RoutePlannerStop => Boolean(stop));
    if (taskBackedStops.length) {
      const activeTaskStop = todaysVisitTasks
        .filter((task) => getVisitStatus(task) === "in_progress")
        .map((task) => toRoutePlannerStopFromTask(task))
        .find((stop): stop is RoutePlannerStop => Boolean(stop));
      if (activeTaskStop) {
        const remaining = taskBackedStops.filter(
          (stop) =>
            Math.abs(stop.latitude - activeTaskStop.latitude) >= 0.00001 ||
            Math.abs(stop.longitude - activeTaskStop.longitude) >= 0.00001
        );
        return dedupeRouteStops([activeTaskStop, ...remaining]);
      }
      return dedupeRouteStops(taskBackedStops);
    }
    return dedupeRouteStops(
      visiblePlannedStops.map((stop, index) => ({
        id: `${stop.id}_nav_${index + 1}`,
        label: stop.label,
        address: null,
        latitude: stop.latitude,
        longitude: stop.longitude,
      }))
    );
  }, [todaysVisitTasks, visiblePlannedStops]);

  const nextNavigationStop = navigationStops[0] ?? null;
  const latestRouteLatitude = latestRoutePoint?.latitude ?? null;
  const latestRouteLongitude = latestRoutePoint?.longitude ?? null;
  const latestRouteOrigin = useMemo(
    () =>
      typeof latestRouteLatitude === "number" &&
      Number.isFinite(latestRouteLatitude) &&
      typeof latestRouteLongitude === "number" &&
      Number.isFinite(latestRouteLongitude)
        ? {
            latitude: latestRouteLatitude,
            longitude: latestRouteLongitude,
          }
        : null,
    [latestRouteLatitude, latestRouteLongitude]
  );

  useEffect(() => {
    if (isAdminViewer || !user?.id || !latestRoutePoint || meetingFocusMode) return;
    void maybeSendLocationReminder({
      latitude: latestRoutePoint.latitude,
      longitude: latestRoutePoint.longitude,
      userId: user.id,
      companyId: user.companyId ?? null,
    }).catch(() => {
      // Keep live route UI stable if reminder evaluation fails.
    });
  }, [
    isAdminViewer,
    latestRoutePoint,
    meetingFocusMode,
    user?.companyId,
    user?.id,
  ]);

  useEffect(() => {
    if (meetingFocusMode || !latestRouteOrigin || !nextNavigationStop) {
      setRoutePreview(null);
      setRoutePreviewError(null);
      setRoutePreviewBusy(false);
      return;
    }

    const destination = {
      latitude: nextNavigationStop.latitude,
      longitude: nextNavigationStop.longitude,
    };
    const waypoints = navigationStops
      .slice(1, ROUTE_NAV_WAYPOINT_LIMIT + 1)
      .map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude }));

    let cancelled = false;
    setRoutePreviewBusy(true);
    setRoutePreviewError(null);

    void getMapplsRoutePreview({
      origin: latestRouteOrigin,
      destination,
      waypoints,
      resource: "route_eta",
      profile: "driving",
      geometries: "polyline6",
      steps: true,
      alternatives: false,
      region: "ind",
    })
      .then((response) => {
        if (cancelled) return;
        setRoutePreview(response);
        setRoutePreviewError(response.directions?.error || null);
      })
      .catch((error) => {
        if (cancelled) return;
        setRoutePreview(null);
        setRoutePreviewError(error instanceof Error ? error.message : "Route preview unavailable.");
      })
      .finally(() => {
        if (!cancelled) {
          setRoutePreviewBusy(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    latestRouteOrigin,
    meetingFocusMode,
    navigationStops,
    nextNavigationStop,
  ]);

  const routePreviewPath = useMemo(
    () => (routePreview?.directions?.path?.length ? routePreview.directions.path : undefined),
    [routePreview]
  );
  const routePreviewSummary = useMemo(() => {
    if (!nextNavigationStop) return "No pending destination for today.";
    if (routePreviewBusy) return "Calculating destination route...";
    if (routePreview?.directions) {
      const distanceKm =
        typeof routePreview.directions.distanceMeters === "number"
          ? (routePreview.directions.distanceMeters / 1000).toFixed(2)
          : null;
      const etaMins =
        typeof routePreview.directions.durationSeconds === "number"
          ? Math.max(1, Math.round(routePreview.directions.durationSeconds / 60))
          : null;
      const parts = [`Next: ${nextNavigationStop.label}`];
      if (distanceKm) parts.push(`${distanceKm} km`);
      if (etaMins) parts.push(`${etaMins} mins ETA`);
      if (routePreview.directions.error) parts.push("fallback to sampled points");
      return parts.join(" | ");
    }
    if (routePreviewError) {
      return `Route preview unavailable: ${routePreviewError}`;
    }
    return `Next: ${nextNavigationStop.label}`;
  }, [nextNavigationStop, routePreview, routePreviewBusy, routePreviewError]);

  useEffect(() => {
    const inProgressTask = todaysVisitTasks.find((task) => getVisitStatus(task) === "in_progress");
    setActiveVisitTaskId((current) => {
      if (current && todaysVisitTasks.some((task) => task.id === current)) {
        return current;
      }
      return inProgressTask?.id ?? null;
    });
  }, [todaysVisitTasks]);

  useEffect(() => {
    if (!isAdminViewer) return;
    setRoutePlanDirty(false);
    setRouteSearchResults([]);
    setRouteSearchQuery("");
  }, [isAdminViewer, routePlanDate, selectedSalespersonId]);

  useEffect(() => {
    setRouteSearchQuery("");
    setRouteSearchResults([]);
  }, [routeStopInputMode]);

  useEffect(() => {
    if (!isAdminViewer) return;
    let cancelled = false;
    setRoutePlannerCustomersLoading(true);
    void getDolibarrThirdParties({ limit: 250, sortfield: "nom", sortorder: "asc" })
      .then((customers) => {
        if (cancelled) return;
        setRoutePlannerCustomers(Array.isArray(customers) ? customers : []);
      })
      .catch(() => {
        if (cancelled) return;
        setRoutePlannerCustomers([]);
      })
      .finally(() => {
        if (!cancelled) {
          setRoutePlannerCustomersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isAdminViewer]);

  useEffect(() => {
    if (!isAdminViewer) return;
    if (routePlanDirty) return;
    setRoutePlanStops(selectedDatePlannedStops);
  }, [isAdminViewer, routePlanDirty, selectedDatePlannedStops]);

  const handleSearchRouteLocations = useCallback(async () => {
    const query = routeSearchQuery.trim();
    if (!query) {
      Alert.alert("Search Required", "Enter a location name, area, or address.");
      return;
    }

    setRouteSearchBusy(true);
    try {
      let results: RoutePlannerStop[] = [];
      let mapplsFailureMessage = "";

      // Primary: Mappls autosuggest/text-search so admin route assignment uses the same mapping provider.
      try {
        const autosuggest = await searchMapplsAutosuggest(query, {
          region: "ind",
          limit: ROUTE_SEARCH_RESULTS_LIMIT,
        });
        let mapplsResults = (autosuggest.suggestions || [])
          .map((suggestion, index) => toRoutePlannerStopFromMapplsSuggestion(suggestion, index))
          .filter((item): item is RoutePlannerStop => Boolean(item));

        if (!mapplsResults.length) {
          const textSearch = await searchMapplsTextSearch(query, {
            region: "ind",
            limit: ROUTE_SEARCH_RESULTS_LIMIT,
          });
          mapplsResults = (textSearch.suggestions || [])
            .map((suggestion, index) => toRoutePlannerStopFromMapplsSuggestion(suggestion, index))
            .filter((item): item is RoutePlannerStop => Boolean(item));
          if (!mapplsResults.length && textSearch.error) {
            mapplsFailureMessage = textSearch.error;
          }
        }

        if (mapplsResults.length) {
          results = mapplsResults;
        } else if (autosuggest.error) {
          mapplsFailureMessage = autosuggest.error;
        }
      } catch (error) {
        mapplsFailureMessage =
          error instanceof Error ? error.message : "Mappls place search is unavailable right now.";
      }

      // Fallback: OpenStreetMap Nominatim when Mappls suggestions are unavailable.
      try {
        if (!results.length) {
          const params = new URLSearchParams({
            q: query,
            format: "jsonv2",
            addressdetails: "1",
            limit: String(ROUTE_SEARCH_RESULTS_LIMIT),
          });
          const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
            method: "GET",
            headers: {
              Accept: "application/json",
              "Accept-Language": "en-IN,en",
              "User-Agent": "LuminaFieldForce/1.0 (route-planner)",
            },
          });
          if (response.ok) {
            const payload = (await response.json()) as {
              lat?: string;
              lon?: string;
              name?: string;
              display_name?: string;
            }[];
            if (Array.isArray(payload)) {
              results = payload
                .map((item, index) => {
                  const latitude = Number.parseFloat(item.lat || "");
                  const longitude = Number.parseFloat(item.lon || "");
                  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
                  const displayName = (item.display_name || "").trim();
                  const label =
                    (item.name || "").trim() ||
                    displayName.split(",")[0]?.trim() ||
                    query;
                  return {
                    id: createLocalId(`route_search_osm_${index}`),
                    label,
                    address: displayName || null,
                    latitude,
                    longitude,
                  } as RoutePlannerStop;
                })
                .filter((item): item is RoutePlannerStop => Boolean(item));
            }
          }
        }
      } catch {
        // fallback below
      }

      // Last fallback: Expo geocode when network search providers are unavailable.
      if (!results.length) {
        const geocoded = await Location.geocodeAsync(query);
        const limited = geocoded.slice(0, ROUTE_SEARCH_RESULTS_LIMIT);
        const resolved = await Promise.all(
          limited.map(async (entry, index): Promise<RoutePlannerStop> => {
            let address = "";
            try {
              const reverse = await Location.reverseGeocodeAsync({
                latitude: entry.latitude,
                longitude: entry.longitude,
              });
              address = buildRoutePlannerAddress(reverse[0]);
            } catch {
              address = "";
            }
            return {
              id: createLocalId(`route_search_geo_${index}`),
              label: address.split("|")[0]?.trim() || query,
              address: address || null,
              latitude: entry.latitude,
              longitude: entry.longitude,
            };
          })
        );
        results = resolved;
      }

      const deduped = dedupeRouteStops(results).slice(0, ROUTE_SEARCH_RESULTS_LIMIT);
      setRouteSearchResults(deduped);
      if (!deduped.length) {
        const suffix = mapplsFailureMessage ? `\n\nMappls: ${mapplsFailureMessage}` : "";
        Alert.alert("No Results", `No matching locations found. Try a more specific search.${suffix}`);
      }
    } catch (error) {
      Alert.alert(
        "Location Search Failed",
        error instanceof Error ? error.message : "Unable to search locations right now."
      );
    } finally {
      setRouteSearchBusy(false);
    }
  }, [routeSearchQuery]);

  const routeCustomerResults = useMemo(() => {
    const query = normalizeSearchText(routeSearchQuery);
    if (!query) return [] as DolibarrThirdParty[];
    return routePlannerCustomers
      .filter((party) => {
        const label = normalizeSearchText(getDolibarrThirdPartyLabel(party));
        const address = normalizeSearchText(getDolibarrThirdPartyAddress(party));
        const email = normalizeSearchText((party.email || "").trim());
        return label.includes(query) || address.includes(query) || email.includes(query);
      })
      .slice(0, ROUTE_SEARCH_RESULTS_LIMIT);
  }, [routePlannerCustomers, routeSearchQuery]);

  const handleAddRouteStop = useCallback((stop: RoutePlannerStop) => {
    setRoutePlanStops((current) => {
      const exists = current.some(
        (entry) =>
          Math.abs(entry.latitude - stop.latitude) < 0.00005 &&
          Math.abs(entry.longitude - stop.longitude) < 0.00005
      );
      if (exists) return current;
      return [
        ...current,
        {
          ...stop,
          id: createLocalId("route_stop"),
        },
      ];
    });
    setRoutePlanDirty(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleAddCustomerRouteStop = useCallback(async (party: DolibarrThirdParty) => {
    const rawId = getDolibarrThirdPartyId(party);
    const busyId = rawId ? String(rawId) : getDolibarrThirdPartyLabel(party);
    setRouteCustomerAddBusyId(busyId);
    try {
      const stop = await resolveRoutePlannerCustomerStop(party);
      setRoutePlanStops((current) => {
        const exists = current.some(
          (entry) =>
            Math.abs(entry.latitude - stop.latitude) < 0.00005 &&
            Math.abs(entry.longitude - stop.longitude) < 0.00005
        );
        if (exists) return current;
        return [...current, stop];
      });
      setRoutePlanDirty(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (error) {
      Alert.alert(
        "Customer Location Missing",
        error instanceof Error ? error.message : "Unable to resolve this customer's location."
      );
    } finally {
      setRouteCustomerAddBusyId(null);
    }
  }, []);

  const handleRemoveRouteStop = useCallback((stopId: string) => {
    setRoutePlanStops((current) => current.filter((entry) => entry.id !== stopId));
    setRoutePlanDirty(true);
  }, []);

  const handleMoveRouteStop = useCallback((index: number, direction: "up" | "down") => {
    setRoutePlanStops((current) => {
      const target = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || index >= current.length) return current;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    setRoutePlanDirty(true);
  }, []);

  const handleAssignRoutePlan = useCallback(async () => {
    if (!user || !isAdminViewer) return;
    if (!selectedSalespersonId) {
      Alert.alert("Salesperson Required", "Select a salesperson before assigning route.");
      return;
    }
    if (!isIsoDateKey(routePlanDate)) {
      Alert.alert("Date Format", "Route date must be in YYYY-MM-DD format.");
      return;
    }
    if (!routePlanStops.length) {
      Alert.alert("Route Empty", "Add at least one location to assign a route.");
      return;
    }

    const assignee =
      employees.find((entry) => entry.id === selectedSalespersonId) || selectedSalesperson;
    if (!assignee) {
      Alert.alert("Salesperson Missing", "Unable to resolve selected salesperson.");
      return;
    }

    setRoutePlanSaving(true);
    try {
      const stalePendingStops = selectedDateVisitTasks.filter(
        (task) => task.status === "pending" && !task.arrivalAt && !task.departureAt
      );
      for (const task of stalePendingStops) {
        await removeTask(task.id);
      }

      const nowIso = new Date().toISOString();
      const createdDate = nowIso.split("T")[0];
      for (let index = 0; index < routePlanStops.length; index += 1) {
        const stop = routePlanStops[index];
        const seq = index + 1;
        const locationLabel = stop.label.trim() || `Visit ${seq}`;
        await addTask({
          id: createLocalId("field_visit"),
          title: `Visit ${seq}: ${locationLabel}`,
          description: `Planned route stop ${seq} for ${routePlanDate}.`,
          taskType: "field_visit",
          assignedTo: assignee.id,
          assignedToName: assignee.name,
          assignedBy: user.id,
          teamId: null,
          teamName: null,
          status: "pending",
          priority: "medium",
          dueDate: routePlanDate,
          createdAt: createdDate,
          visitPlanDate: routePlanDate,
          visitSequence: seq,
          visitLatitude: stop.latitude,
          visitLongitude: stop.longitude,
          visitLocationLabel: locationLabel,
          visitLocationAddress: stop.address?.trim() || null,
          arrivalAt: null,
          departureAt: null,
          autoCaptureRecordingActive: false,
          autoCaptureRecordingStartedAt: null,
          autoCaptureRecordingStoppedAt: null,
          autoCaptureConversationId: null,
        });
      }

      await addAuditLog({
        id: createLocalId("audit"),
        userId: user.id,
        userName: user.name,
        action: "Route Assigned",
        details: `${routePlanStops.length} stop(s) assigned to ${assignee.name} for ${routePlanDate}.`,
        timestamp: new Date().toISOString(),
        module: "Sales Intelligence",
      });

      setRoutePlanDirty(false);
      setRouteSearchResults([]);
      setRouteSearchQuery("");
      await loadData();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert(
        "Route Assignment Failed",
        error instanceof Error ? error.message : "Unable to assign route right now."
      );
    } finally {
      setRoutePlanSaving(false);
    }
  }, [
    employees,
    isAdminViewer,
    loadData,
    routePlanDate,
    routePlanStops,
    selectedDateVisitTasks,
    selectedSalesperson,
    selectedSalespersonId,
    user,
  ]);

  const visibleConversations = useMemo(() => {
    if (!isAdminViewer) {
      return conversations.filter(
        (conversation) =>
          conversation.salespersonId === user?.id ||
          conversation.salespersonName === user?.name
      );
    }
    if (!selectedSalespersonId) return conversations;
    const selectedName = normalizeIdentity(selectedSalesperson?.name);
    const currentUserName = normalizeIdentity(user?.name);
    return conversations.filter(
      (conversation) =>
        selectedSalespersonTaskAliases.has(conversation.salespersonId) ||
        (selectedName && normalizeIdentity(conversation.salespersonName) === selectedName) ||
        (currentUserName && normalizeIdentity(conversation.salespersonName) === currentUserName)
    );
  }, [
    conversations,
    isAdminViewer,
    selectedSalesperson?.name,
    selectedSalespersonId,
    selectedSalespersonTaskAliases,
    user?.id,
    user?.name,
  ]);

  const avgInterest = visibleConversations.length > 0
    ? Math.round(visibleConversations.reduce((sum, convo) => sum + convo.interestScore, 0) / visibleConversations.length)
    : 0;
  const avgPitch = visibleConversations.length > 0
    ? Math.round(visibleConversations.reduce((sum, convo) => sum + convo.pitchScore, 0) / visibleConversations.length)
    : 0;

  const normalizedSalesTrendRecommendations = useMemo(
    () =>
      (Array.isArray(salesTrendRecommendations) ? salesTrendRecommendations : []).map((item) => ({
        ...item,
        tags: Array.isArray(item.tags) ? item.tags : [],
        unitsSold: Number.isFinite(item.unitsSold) ? item.unitsSold : 0,
        orderCount: Number.isFinite(item.orderCount) ? item.orderCount : 0,
        activeMonths: Number.isFinite(item.activeMonths) ? item.activeMonths : 0,
        recentUnitsSold: Number.isFinite(item.recentUnitsSold) ? item.recentUnitsSold : 0,
        bestMonthLabel: item.bestMonthLabel || null,
      })),
    [salesTrendRecommendations]
  );

  const liveRecommendationProductIndex = useMemo(
    () => buildConversationRecommendationProductIndex(posProducts),
    [posProducts]
  );

  const liveTranscript = useMemo(() => {
    const finalTranscript = sanitizeConversationTranscript(transcriptDraft);
    const partialTranscript = sanitizeConversationTranscript(interimTranscript);
    if (!finalTranscript) return partialTranscript;
    if (!partialTranscript) return finalTranscript;
    if (finalTranscript === partialTranscript) return finalTranscript;
    if (finalTranscript.endsWith(partialTranscript)) return finalTranscript;
    return `${finalTranscript} ${partialTranscript}`.trim();
  }, [interimTranscript, transcriptDraft]);

  const liveTranscriptSignals = useMemo(
    () =>
      buildTranscriptDrivenProductSignalsFromIndex(
        sanitizeConversationTranscript(liveTranscript),
        liveRecommendationProductIndex
      ),
    [liveRecommendationProductIndex, liveTranscript]
  );

  const liveDetectedPhrases = useMemo(
    () =>
      [...liveTranscriptSignals.specifications, ...liveTranscriptSignals.phrases]
        .map((entry) => toConversationRecommendationTitle(entry))
        .slice(0, 8),
    [liveTranscriptSignals]
  );

  const hasLiveSuggestionSignals = useMemo(
    () => liveDetectedPhrases.length > 0 || sanitizeConversationTranscript(liveTranscript).length >= 3,
    [liveDetectedPhrases.length, liveTranscript]
  );

  const liveProductSuggestions = useMemo(
    () =>
      hasLiveSuggestionSignals
        ? buildMeetingConversationProductRecommendationsFromSignals(
            liveTranscriptSignals,
            liveRecommendationProductIndex
          )
        : [],
    [hasLiveSuggestionSignals, liveRecommendationProductIndex, liveTranscriptSignals]
  );

  useEffect(() => {
    if (isAdminViewer) return;
    if (!(isRecording || isTranscribingFile || activeVisitTask?.autoCaptureRecordingActive)) return;
    if (posProducts.length) return;
    void ensureConversationRecommendationProducts().catch(() => {});
  }, [
    activeVisitTask?.autoCaptureRecordingActive,
    ensureConversationRecommendationProducts,
    isAdminViewer,
    isRecording,
    isTranscribingFile,
    posProducts.length,
  ]);

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
        const transcript = sanitizeConversationTranscript(await transcribeAudioWithSpeechApi(uri));
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
        setRecordError(getErrorMessage(error, TRANSCRIPTION_FAILED_MESSAGE));
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
    liveHintSpeechActiveRef.current = false;
    if (liveHintSpeechRestartTimerRef.current) {
      clearTimeout(liveHintSpeechRestartTimerRef.current);
      liveHintSpeechRestartTimerRef.current = null;
    }
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
    startLiveHintSpeechRecognition();

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
          const transcript = sanitizeConversationTranscript(await transcribeAudioWithSpeechApi(uri));
          const normalizedTranscript = transcript.trim();
          fallbackChunkBufferRef.current.set(chunkIndex, normalizedTranscript);
          if (normalizedTranscript) {
            markVoiceDetected();
          }
          setRecordError(null);
        } catch (error) {
          setRecordError(getErrorMessage(error, TRANSCRIPTION_FAILED_MESSAGE));
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
        setRecordError(getErrorMessage(error, "Fallback recording loop failed."));
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
        liveHintSpeechActiveRef.current = false;
        if (liveHintSpeechRestartTimerRef.current) {
          clearTimeout(liveHintSpeechRestartTimerRef.current);
          liveHintSpeechRestartTimerRef.current = null;
        }
        try {
          ExpoSpeechRecognitionModule?.abort?.();
        } catch {
          // no-op
        }
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
  }, [markVoiceDetected, startLiveHintSpeechRecognition, updateVoicePulseInput]);

  useEffect(() => {
    startFallbackRecordingRef.current = startFallbackRecording;
  }, [startFallbackRecording]);

  const stopFallbackRecordingAndTranscribe = useCallback(async () => {
    if (recordingModeRef.current !== "audio-fallback") return;
    fallbackStopRequestedRef.current = true;
    fallbackLoopRunningRef.current = false;
    liveHintSpeechActiveRef.current = false;
    if (liveHintSpeechRestartTimerRef.current) {
      clearTimeout(liveHintSpeechRestartTimerRef.current);
      liveHintSpeechRestartTimerRef.current = null;
    }
    try {
      ExpoSpeechRecognitionModule?.abort?.();
    } catch {
      // no-op
    }
    setInterimTranscript("Finalizing transcript...");
    const recording = fallbackRecordingRef.current;
    if (!recording) return;
    try {
      await recording.stopAndUnloadAsync();
    } catch {
      // active loop handles final state
    }
  }, []);

  const startRecording = useCallback(
    async (options?: { customerNameOverride?: string; silent?: boolean }): Promise<boolean> => {
      const silent = Boolean(options?.silent);
      const resolvedCustomerName = (options?.customerNameOverride ?? customerName).trim();
      if (!resolvedCustomerName) {
        if (!silent) {
          Alert.alert("Customer Required", "Please enter customer name before recording.");
        }
        return false;
      }
      if (options?.customerNameOverride && options.customerNameOverride.trim() !== customerName.trim()) {
        setCustomerName(options.customerNameOverride.trim());
      }

      if (FORCE_SERVER_TRANSCRIPTION) {
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
          return true;
        } catch (error) {
          setRecordError(
            getErrorMessage(
              error,
              "Groq recorder could not start. Check microphone permission and try again."
            )
          );
          return false;
        } finally {
          setRequestBusy(false);
        }
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
          return true;
        } catch (error) {
          setRecordError(
            getErrorMessage(
              error,
              "Backup recorder could not start. Check microphone permission and try again."
            )
          );
          return false;
        } finally {
          setRequestBusy(false);
        }
      }

      if (!isSpeechRecognitionAvailable()) {
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
          return true;
        } catch (error) {
          setRecordError(
            getErrorMessage(
              error,
              "Backup recorder could not start. Check microphone permission and try again."
            )
          );
          return false;
        } finally {
          setRequestBusy(false);
        }
      }

      setRequestBusy(true);
      try {
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) {
          if (!silent) {
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
              Alert.alert(
                "Permission Required",
                "Microphone permission is required to record conversation."
              );
            }
          }
          return false;
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

        const startOptions: Record<string, any> = {
          interimResults: true,
          continuous: true,
          addsPunctuation: false,
          maxAlternatives: 1,
          volumeChangeEventOptions: {
            enabled: true,
            intervalMillis: 45,
          },
          androidIntentOptions: {
            EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 60_000,
            EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 12_000,
            EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 8_000,
            EXTRA_MASK_OFFENSIVE_WORDS: false,
          },
        };

        if (supportsSpeechPersistedRecording()) {
          startOptions.recordingOptions = {
            persist: true,
          };
        }

        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        ExpoSpeechRecognitionModule.start(startOptions);
        return true;
      } catch (error) {
        const message = getErrorMessage(error, "Unable to start speech recognition.");
        if (isSpeechRecordingStartFailure(message)) {
          try {
            await startFallbackRecording();
            setRecordError(null);
            return true;
          } catch (fallbackError) {
            setRecordError(
              getErrorMessage(
                fallbackError,
                "Backup recorder could not start. Check microphone permission and try again."
              )
            );
            return false;
          }
        }
        setRecordError(message || RECORDING_START_FAILED_MESSAGE);
        return false;
      } finally {
        setRequestBusy(false);
      }
    },
    [customerName, startFallbackRecording]
  );

  const waitForRecorderIdle = useCallback(async (timeoutMs = 30_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!isRecordingStateRef.current && !isTranscribingStateRef.current) {
        return true;
      }
      await wait(240);
    }
    return !isRecordingStateRef.current && !isTranscribingStateRef.current;
  }, []);

  const stopRecordingAndWait = useCallback(async (): Promise<boolean> => {
    if (isRecordingStateRef.current) {
      if (
        recordingModeRef.current === "audio-fallback" ||
        sessionModeRef.current === "audio-fallback"
      ) {
        await stopFallbackRecordingAndTranscribe();
      } else {
        ExpoSpeechRecognitionModule?.stop?.();
      }
    }
    return waitForRecorderIdle();
  }, [stopFallbackRecordingAndTranscribe, waitForRecorderIdle]);

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
    if (FORCE_SERVER_TRANSCRIPTION || !ExpoSpeechRecognitionModule || !recognitionAvailable) {
      void transcribeWithFallbackApi(audioUri);
      return;
    }
    finalSegmentsRef.current = [];
    setTranscriptDraft("");
    setInterimTranscript("");
    setRecordError(null);
    sessionModeRef.current = "file";
    ExpoSpeechRecognitionModule.start({
      interimResults: true,
      audioSource: {
        uri: audioUri,
      },
    });
  }, [audioUri, recognitionAvailable, transcribeWithFallbackApi]);

  const saveConversation = useCallback(
    async (options?: {
      silent?: boolean;
      navigateToDetail?: boolean;
      overrideCustomerName?: string;
      minTranscriptLength?: number;
    }): Promise<Conversation | null> => {
      const silent = Boolean(options?.silent);
      const resolvedCustomerName = (options?.overrideCustomerName ?? customerName).trim();
      const transcript = sanitizeConversationTranscript((transcriptDraft || interimTranscript).trim());
      const minTranscriptLength = Math.max(1, options?.minTranscriptLength ?? 20);

      if (!resolvedCustomerName) {
        if (!silent) {
          Alert.alert("Customer Required", "Please enter customer name.");
        }
        return null;
      }
      if (!transcript || transcript.length < minTranscriptLength) {
        if (!silent) {
          Alert.alert("Transcript Too Short", "Please record a longer conversation before saving.");
        }
        return null;
      }

      setSaving(true);
      try {
        const salespersonName = user?.name ?? "Sales Rep";
        const salespersonId = user?.id ?? "sales_unknown";
        const persistedAudioUri = await persistConversationAudioUri(audioUri);
        const conversation = buildConversationFromTranscript({
          salespersonId,
          salespersonName,
          customerName: resolvedCustomerName,
          transcript,
          durationMs: elapsedMs,
          audioUri: persistedAudioUri,
        });

        await addConversation(conversation);
        setConversations((current) => mergeConversationsById(current, [conversation]));
        await addAuditLog({
          id: `audit_sales_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          userId: salespersonId,
          userName: salespersonName,
          action: "Conversation Recorded",
          details: `Recorded and transcribed conversation with ${resolvedCustomerName}`,
          timestamp: new Date().toISOString(),
          module: "Sales AI",
        });
        await loadData();

        if (!silent) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        setTranscriptDraft("");
        setInterimTranscript("");
        setElapsedMs(0);
        setAudioUri(null);
        setRecordError(null);
        finalSegmentsRef.current = [];
        if (options?.navigateToDetail !== false) {
          router.push({ pathname: "/conversation/[id]", params: { id: conversation.id } });
        }
        return conversation;
      } catch (error) {
        if (!silent) {
          Alert.alert(
            "Save Failed",
            error instanceof Error ? error.message : "Unable to save conversation."
          );
        } else {
          setRecordError(
            error instanceof Error ? error.message : "Unable to save conversation automatically."
          );
        }
        return null;
      } finally {
        setSaving(false);
      }
    },
    [audioUri, customerName, elapsedMs, interimTranscript, loadData, transcriptDraft, user?.id, user?.name]
  );

  const handleVisitArrived = useCallback(
    async (task: Task) => {
      if (!user || isAdminViewer) return;
      if (visitActionTaskId) return;
      if (isRecordingStateRef.current && activeVisitTaskId && activeVisitTaskId !== task.id) {
        Alert.alert("Visit In Progress", "Please complete current active visit before starting another.");
        return;
      }
      setVisitActionTaskId(task.id);
      try {
        const nowIso = new Date().toISOString();
        const arrivalSnapshot = await resolveVisitArrivalSnapshot();
        await updateTask(task.id, {
          status: "in_progress",
          arrivalAt: task.arrivalAt ?? nowIso,
          visitLatitude:
            arrivalSnapshot?.latitude ?? (typeof task.visitLatitude === "number" ? task.visitLatitude : null),
          visitLongitude:
            arrivalSnapshot?.longitude ??
            (typeof task.visitLongitude === "number" ? task.visitLongitude : null),
          departureAt: null,
          autoCaptureRecordingActive: false,
          autoCaptureRecordingStartedAt: task.autoCaptureRecordingStartedAt ?? null,
          autoCaptureRecordingStoppedAt: null,
          autoCaptureConversationId: null,
        });
        await addAuditLog({
          id: createLocalId("audit"),
          userId: user.id,
          userName: user.name,
          action: "Visit Arrived",
          details: `${user.name} arrived at ${getVisitLabel(task)}.`,
          timestamp: nowIso,
          module: "Sales Intelligence",
        });
        setActiveVisitTaskId(task.id);
        await loadData();
      } catch (error) {
        Alert.alert(
          "Unable to Start Visit",
          error instanceof Error ? error.message : "Failed to mark arrival."
        );
      } finally {
        setVisitActionTaskId(null);
      }
    },
    [activeVisitTaskId, isAdminViewer, loadData, resolveVisitArrivalSnapshot, user, visitActionTaskId]
  );

  const handleMeetingStart = useCallback(
    async (task: Task) => {
      if (!user || isAdminViewer) return;
      if (visitActionTaskId) return;
      if (isRecordingStateRef.current && activeVisitTaskId && activeVisitTaskId !== task.id) {
        Alert.alert("Visit In Progress", "Please complete current active visit before starting another.");
        return;
      }
      setVisitActionTaskId(task.id);
      try {
        const nowIso = new Date().toISOString();
        setLocalMeetingCaptureTaskId(task.id);
        await updateTask(task.id, {
          status: "in_progress",
          arrivalAt: task.arrivalAt ?? nowIso,
          autoCaptureRecordingActive: true,
          autoCaptureRecordingStartedAt: task.autoCaptureRecordingStartedAt ?? nowIso,
          autoCaptureRecordingStoppedAt: null,
          autoCaptureConversationId: null,
        });
        await addAuditLog({
          id: createLocalId("audit"),
          userId: user.id,
          userName: user.name,
          action: "Meeting Started",
          details: `${user.name} started meeting at ${getVisitLabel(task)}.`,
          timestamp: nowIso,
          module: "Sales Intelligence",
        });
        setActiveVisitTaskId(task.id);
        void ensureConversationRecommendationProducts().catch(() => {});
        const started = await startRecording({
          customerNameOverride: getVisitLabel(task),
          silent: true,
        });
        if (!started) {
          setLocalMeetingCaptureTaskId(null);
          await updateTask(task.id, {
            autoCaptureRecordingActive: false,
            autoCaptureRecordingStartedAt: task.autoCaptureRecordingStartedAt ?? null,
          });
          throw new Error("Recording could not start. Check microphone permission and try again.");
        }
        await loadData();
      } catch (error) {
        setLocalMeetingCaptureTaskId(null);
        Alert.alert(
          "Unable to Start Meeting",
          error instanceof Error ? error.message : "Failed to start meeting."
        );
      } finally {
        setVisitActionTaskId(null);
      }
    },
    [
      activeVisitTaskId,
      ensureConversationRecommendationProducts,
      isAdminViewer,
      setLocalMeetingCaptureTaskId,
      loadData,
      startRecording,
      user,
      visitActionTaskId,
    ]
  );

  const handleMeetingEnd = useCallback(
    async (task: Task) => {
      if (!user || isAdminViewer) return;
      if (visitActionTaskId) return;
      setVisitActionTaskId(task.id);
      let meetingEndedSuccessfully = false;
      try {
        await stopRecordingAndWait();
        const conversation = await saveConversation({
          silent: true,
          navigateToDetail: false,
          overrideCustomerName: getVisitLabel(task),
          minTranscriptLength: 1,
        });
        if (!conversation) {
          throw new Error("Recording could not be saved. Please try Meeting End again.");
        }
        const nowIso = new Date().toISOString();
        await updateTask(task.id, {
          autoCaptureRecordingActive: false,
          autoCaptureRecordingStoppedAt: nowIso,
          autoCaptureConversationId: conversation.id,
        });
        let analyzedConversation = conversation;
        if ((conversation.transcript || "").trim().length >= 20) {
          try {
            const aiResult = await analyzeConversationWithBackendAIForMeeting({
              transcript: conversation.transcript || "",
              customerName: conversation.customerName,
              salespersonName: conversation.salespersonName,
            });
            const aiUpdates: Partial<Conversation> = {
              ...aiResult,
              analysisProvider: "ai",
            };
            analyzedConversation = {
              ...conversation,
              ...aiUpdates,
            };
            await updateConversation(conversation.id, aiUpdates);
            setConversations((current) => mergeConversationsById(current, [analyzedConversation]));
          } catch {
            analyzedConversation = conversation;
          }
        }
        let recommendationItems: MeetingConversationProductRecommendation[] = [];
        try {
          const recommendationProducts = await ensureConversationRecommendationProducts();
          recommendationItems = buildMeetingConversationProductRecommendations(
            analyzedConversation,
            recommendationProducts
          );
        } catch {
          recommendationItems = [];
        }
        setMeetingRecommendationConversation(analyzedConversation);
        setMeetingRecommendationItems(recommendationItems);
        setMeetingRecommendationVisible(true);
        await addAuditLog({
          id: createLocalId("audit"),
          userId: user.id,
          userName: user.name,
          action: "Meeting Ended",
          details: `${user.name} ended meeting at ${getVisitLabel(task)}.`,
          timestamp: nowIso,
          module: "Sales Intelligence",
        });
        meetingEndedSuccessfully = true;
        await loadData();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        Alert.alert(
          "Unable to End Meeting",
          error instanceof Error ? error.message : "Failed to stop meeting."
        );
      } finally {
        if (meetingEndedSuccessfully) {
          setLocalMeetingCaptureTaskId(null);
        }
        setVisitActionTaskId(null);
      }
    },
    [
      analyzeConversationWithBackendAIForMeeting,
      ensureConversationRecommendationProducts,
      isAdminViewer,
      loadData,
      saveConversation,
      stopRecordingAndWait,
      user,
      visitActionTaskId,
    ]
  );

  const closeDepartureNotesModal = useCallback(() => {
    if (visitActionTaskId) return;
    setDepartureNotesModalVisible(false);
    setDepartureNotesTask(null);
    setDepartureNotesDraft("");
    setDepartureCreateCustomerEnabled(false);
    setDepartureCustomerName("");
    setDepartureCustomerEmail("");
    setDepartureCustomerPhone("");
    setDepartureCustomerAddress("");
  }, [visitActionTaskId]);

  const closeMeetingRecommendationModal = useCallback(() => {
    setMeetingRecommendationVisible(false);
    setMeetingRecommendationConversation(null);
    setMeetingRecommendationItems([]);
  }, []);

  const openDepartureNotesModal = useCallback((task: Task) => {
    setDepartureNotesTask(task);
    setDepartureNotesDraft(task.visitDepartureNotes?.trim() ?? "");
    setDepartureCreateCustomerEnabled(false);
    setDepartureCustomerName(getVisitLabel(task));
    setDepartureCustomerEmail("");
    setDepartureCustomerPhone("");
    setDepartureCustomerAddress(task.visitLocationAddress?.trim() ?? "");
    setDepartureNotesModalVisible(true);
  }, []);

  const confirmVisitDepartureWithNotes = useCallback(async () => {
    if (!user || isAdminViewer || !departureNotesTask) return;
    if (visitActionTaskId) return;
    setVisitActionTaskId(departureNotesTask.id);
    try {
      const nowIso = new Date().toISOString();
      const normalizedNote = departureNotesDraft.trim();
      const normalizedCustomerName = departureCustomerName.trim() || getVisitLabel(departureNotesTask);
      const syncPayload: Task = {
        ...departureNotesTask,
        status: "completed",
        departureAt: nowIso,
        arrivalAt: departureNotesTask.arrivalAt ?? nowIso,
        visitDepartureNotes: normalizedNote || null,
        visitDepartureNotesUpdatedAt: normalizedNote ? nowIso : null,
        autoCaptureRecordingActive: false,
        taskType: "field_visit",
        assignedTo: user.id,
        assignedToName: user.name,
        companyId: user.companyId ?? departureNotesTask.companyId,
      };
      await syncVisitNoteTaskRemote(syncPayload);
      await updateTask(departureNotesTask.id, {
        status: "completed",
        departureAt: nowIso,
        arrivalAt: departureNotesTask.arrivalAt ?? nowIso,
        visitDepartureNotes: normalizedNote || null,
        visitDepartureNotesUpdatedAt: normalizedNote ? nowIso : null,
        autoCaptureRecordingActive: false,
      });
      let selectedCustomerIdForPos: string | null = null;
      let posStatusMessage: string | null = null;
      if (departureCreateCustomerEnabled) {
        if (!normalizedCustomerName) {
          throw new Error("Please enter a customer name before creating the customer.");
        }

        const normalizedCustomerEmail = departureCustomerEmail.trim().toLowerCase();
        const existingCustomer =
          posCustomers.find((entry) => {
            const labelMatches =
              normalizeSearchText(getDolibarrThirdPartyLabel(entry)) ===
              normalizeSearchText(normalizedCustomerName);
            const emailMatches =
              Boolean(normalizedCustomerEmail) &&
              (entry.email || "").trim().toLowerCase() === normalizedCustomerEmail;
            return labelMatches || emailMatches;
          }) || null;

        if (existingCustomer) {
          const existingCustomerId = getDolibarrThirdPartyId(existingCustomer);
          if (existingCustomerId) {
            selectedCustomerIdForPos = String(existingCustomerId);
            posStatusMessage = `${getDolibarrThirdPartyLabel(existingCustomer)} selected in Sales POS.`;
          }
        } else {
          const createdCustomer = await createDolibarrCustomer({
            name: normalizedCustomerName,
            email: departureCustomerEmail.trim() || undefined,
            phone: departureCustomerPhone.trim() || undefined,
            address: departureCustomerAddress.trim() || undefined,
            note: normalizedNote || undefined,
          });
          const createdCustomerId = createdCustomer.customerId;
          if (!createdCustomerId) {
            throw new Error(createdCustomer.message || "Customer created but ID was not returned.");
          }
          selectedCustomerIdForPos = String(createdCustomerId);
          setPosCustomers((current) =>
            mergeUniqueCustomers(current, [
              {
                id: createdCustomerId,
                name: normalizedCustomerName,
                email: departureCustomerEmail.trim() || undefined,
                address: departureCustomerAddress.trim() || undefined,
              },
            ])
          );
          posStatusMessage = `${normalizedCustomerName} created and selected in Sales POS.`;
        }
      }
      await addAuditLog({
        id: createLocalId("audit"),
        userId: user.id,
        userName: user.name,
        action: "Visit Completed",
        details: `${user.name} departed from ${getVisitLabel(departureNotesTask)}${normalizedNote ? " with departure notes." : "."}`,
        timestamp: nowIso,
        module: "Sales Intelligence",
      });
      setLocalMeetingCaptureTaskId(null);
      setActiveVisitTaskId(null);
      setDepartureNotesModalVisible(false);
      setDepartureNotesTask(null);
      setDepartureNotesDraft("");
      setDepartureCreateCustomerEnabled(false);
      setDepartureCustomerName("");
      setDepartureCustomerEmail("");
      setDepartureCustomerPhone("");
      setDepartureCustomerAddress("");
      await loadData();
      if (selectedCustomerIdForPos) {
        setPosLinkedVisitTaskId(syncPayload.id);
        setPosSelectedCustomerId(selectedCustomerIdForPos);
        setPosCustomerQuery("");
        await loadPosData({
          preferredCustomerId: selectedCustomerIdForPos,
          preserveSuccess: true,
        });
        setPosSuccess(posStatusMessage || "Customer selected in Sales POS.");
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert(
        "Unable to Complete Visit",
        error instanceof Error ? error.message : "Failed to mark departure."
      );
    } finally {
      setVisitActionTaskId(null);
    }
  }, [
    departureCreateCustomerEnabled,
    departureCustomerAddress,
    departureCustomerEmail,
    departureCustomerName,
    departureCustomerPhone,
    departureNotesDraft,
    departureNotesTask,
    isAdminViewer,
    loadData,
    loadPosData,
    posCustomers,
    user,
    visitActionTaskId,
  ]);

  const handleVisitDeparture = useCallback(
    async (task: Task) => {
      if (!user || isAdminViewer) return;
      if (visitActionTaskId) return;
      if (task.autoCaptureRecordingActive) {
        Alert.alert("Meeting In Progress", "Please end the meeting before departure.");
        return;
      }
      if (!task.autoCaptureConversationId) {
        Alert.alert("Meeting Not Ended", "Please tap Meeting End before departure.");
        return;
      }
      openDepartureNotesModal(task);
    },
    [isAdminViewer, openDepartureNotesModal, user, visitActionTaskId]
  );

  const handleVisitDelete = useCallback(
    (task: Task) => {
      if (!user || !isAdminViewer) return;
      if (visitActionTaskId) return;
      Alert.alert(
        "Delete Visit",
        `Delete ${getVisitLabel(task)} from assigned field visits?`,
        [
          {
            text: "Cancel",
            style: "cancel",
          },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              setVisitActionTaskId(task.id);
              void (async () => {
                try {
                  const removed = await removeTask(task.id);
                  if (!removed) {
                    throw new Error("Visit could not be deleted.");
                  }
                  await addAuditLog({
                    id: createLocalId("audit"),
                    userId: user.id,
                    userName: user.name,
                    action: "Visit Deleted",
                    details: `${user.name} deleted assigned visit ${getVisitLabel(task)}.`,
                    timestamp: new Date().toISOString(),
                    module: "Sales Intelligence",
                  });
                  await loadData();
                } catch (error) {
                  Alert.alert(
                    "Unable to Delete Visit",
                    error instanceof Error ? error.message : "Failed to delete visit."
                  );
                } finally {
                  setVisitActionTaskId(null);
                }
              })();
            },
          },
        ]
      );
    },
    [isAdminViewer, loadData, user, visitActionTaskId]
  );

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
  const visitSummary = useMemo(() => {
    let completed = 0;
    let inProgress = 0;
    let pending = 0;
    for (const task of todaysVisitTasks) {
      const status = getVisitStatus(task);
      if (status === "completed") completed += 1;
      else if (status === "in_progress") inProgress += 1;
      else pending += 1;
    }
    return {
      total: todaysVisitTasks.length,
      completed,
      inProgress,
      pending,
    };
  }, [todaysVisitTasks]);
  const remainingVisits = Math.max(visitSummary.total - visitSummary.completed, 0);
  const salesHeroMeta = activeVisitTask
    ? `Active: ${getVisitLabel(activeVisitTask)}`
    : nextNavigationStop
      ? `Next stop: ${nextNavigationStop.label}`
      : "No visits pending today.";
  const salesHeroStatus = visitSummary.total
    ? `${visitSummary.completed}/${visitSummary.total} visits completed`
    : "No visits assigned yet.";

  const selectedCustomer = useMemo(() => {
    if (!posSelectedCustomerId) return null;
    return (
      posCustomers.find(
        (entry) => String(getDolibarrThirdPartyId(entry) ?? "") === posSelectedCustomerId
      ) || null
    );
  }, [posCustomers, posSelectedCustomerId]);

  const linkedPosVisitTask = useMemo(
    () => tasks.find((entry) => entry.id === posLinkedVisitTaskId) ?? null,
    [posLinkedVisitTaskId, tasks]
  );

  const filteredCustomers = useMemo(() => {
    const query = normalizeSearchText(posCustomerQuery);
    const matches = posCustomers.filter((entry) => {
      const label = getDolibarrThirdPartyLabel(entry);
      const email = entry.email || "";
      return !query || label.toLowerCase().includes(query) || email.toLowerCase().includes(query);
    });
    return matches;
  }, [posCustomers, posCustomerQuery]);

  const filteredProducts = useMemo(() => {
    const query = normalizeSearchText(posProductQuery);
    const matches = posProducts.filter((entry) => {
      const label = getDolibarrProductLabel(entry);
      const ref = entry.ref || "";
      return !query || label.toLowerCase().includes(query) || ref.toLowerCase().includes(query);
    });
    return matches;
  }, [posProducts, posProductQuery]);

  const cartItems = useMemo(
    () =>
      Object.values(posCart).filter(
        (entry) => entry && typeof entry.qty === "number" && entry.qty > 0
      ),
    [posCart]
  );

  const cartTotal = useMemo(() => {
    return cartItems.reduce((sum, entry) => {
      const price = getDolibarrProductPrice(entry.product);
      const discount = Math.max(0, Math.min(100, entry.discountPercent || 0));
      const discounted = price * (1 - discount / 100);
      return sum + discounted * entry.qty;
    }, 0);
  }, [cartItems]);

  useEffect(() => {
    setPosQtyDrafts((current) => {
      const nextEntries = Object.entries(posCart)
        .filter(([, entry]) => entry && typeof entry.qty === "number" && entry.qty > 0)
        .map(([key, entry]) => [key, String(entry.qty)] as const);
      const next = Object.fromEntries(nextEntries);
      const currentKeys = Object.keys(current);
      if (
        currentKeys.length === nextEntries.length &&
        currentKeys.every((key) => current[key] === next[key])
      ) {
        return current;
      }
      return next;
    });
  }, [posCart]);

  const formatPrice = useCallback((value: number) => {
    return `INR ${value.toFixed(2)}`;
  }, []);

  const handleSelectCustomer = useCallback((party: DolibarrThirdParty) => {
    const id = getDolibarrThirdPartyId(party);
    if (!id) return;
    setPosSelectedCustomerId(String(id));
    if (
      linkedPosVisitTask &&
      normalizeSearchText(getDolibarrThirdPartyLabel(party)) !==
        normalizeSearchText(getVisitLabel(linkedPosVisitTask))
    ) {
      setPosLinkedVisitTaskId(null);
    }
  }, [linkedPosVisitTask]);

  const handleAddProductToCart = useCallback((product: DolibarrProduct) => {
    const id = getDolibarrProductId(product);
    if (!id) return;
    setPosCart((current) => {
      const key = String(id);
      const existing = current[key];
      const nextQty = existing ? existing.qty + 1 : 1;
      const discountPercent = existing ? existing.discountPercent : 0;
      return {
        ...current,
        [key]: {
          product: existing?.product || product,
          qty: nextQty,
          discountPercent,
        },
      };
    });
  }, []);

  const handleSetCartQty = useCallback((productId: number, qty: number) => {
    const safeQty = Math.max(0, Math.floor(qty));
    setPosCart((current) => {
      const key = String(productId);
      if (safeQty <= 0) {
        const { [key]: _removed, ...rest } = current;
        return rest;
      }
      const existing = current[key];
      if (!existing) return current;
      return {
        ...current,
        [key]: {
          ...existing,
          qty: safeQty,
        },
      };
    });
  }, []);

  const handleQtyDraftChange = useCallback((productId: number, value: string) => {
    const key = String(productId);
    const sanitized = value.replace(/[^0-9]/g, "");
    setPosQtyDrafts((current) => ({
      ...current,
      [key]: sanitized,
    }));
    if (!sanitized) return;
    const parsed = Number(sanitized);
    if (Number.isFinite(parsed)) {
      handleSetCartQty(productId, parsed);
    }
  }, [handleSetCartQty]);

  const handleQtyDraftCommit = useCallback((productId: number) => {
    const key = String(productId);
    const rawValue = (posQtyDrafts[key] || "").trim();
    const parsed = Number(rawValue);
    const nextQty = rawValue && Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    handleSetCartQty(productId, nextQty);
    setPosQtyDrafts((current) => {
      if (nextQty <= 0) {
        const { [key]: _removed, ...rest } = current;
        return rest;
      }
      return {
        ...current,
        [key]: String(nextQty),
      };
    });
  }, [handleSetCartQty, posQtyDrafts]);

  const handleQtyInputFocus = useCallback(() => {
    setTimeout(() => {
      rootListRef.current?.scrollToEnd({ animated: true });
    }, Platform.OS === "ios" ? 120 : 80);
  }, []);

  const handleSetCartDiscount = useCallback((productId: number, discountPercent: number) => {
    const safeDiscount = Math.max(0, Math.min(100, Math.round(discountPercent)));
    setPosCart((current) => {
      const key = String(productId);
      const existing = current[key];
      if (!existing) return current;
      return {
        ...current,
        [key]: {
          ...existing,
          discountPercent: safeDiscount,
        },
      };
    });
  }, []);

  const handleLoadMoreProducts = useCallback(async () => {
    if (posProductsLoadingMore || posLoading || !posProductsHasMore) return;
    setPosProductsLoadingMore(true);
    setPosError(null);
    try {
      const nextPage = posProductsPage + 1;
      const nextProducts = await getDolibarrProducts({
        limit: POS_PAGE_SIZE,
        page: nextPage,
        sortfield: "label",
        sortorder: "asc",
        manufacturedOnly: true,
        sellableOnly: true,
      });
      const list = Array.isArray(nextProducts) ? nextProducts : [];
      setPosProducts((current) => mergeUniqueProducts(current, list));
      setPosProductsPage(nextPage);
      setPosProductsHasMore(list.length >= POS_PAGE_SIZE);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load more products.";
      setPosError(message);
    } finally {
      setPosProductsLoadingMore(false);
    }
  }, [
    posLoading,
    posProductsHasMore,
    posProductsLoadingMore,
    posProductsPage,
  ]);

  const handleCreateSalesOrder = useCallback(async () => {
    if (posSubmitting) return;
    if (!selectedCustomer) {
      Alert.alert("Select Customer", "Choose a customer before creating the sales order.");
      return;
    }
    if (!cartItems.length) {
      Alert.alert("Cart Empty", "Add at least one product to create a sales order.");
      return;
    }

    const customerId = getDolibarrThirdPartyId(selectedCustomer);
    if (!customerId) {
      Alert.alert("Customer Missing", "Unable to resolve the selected customer.");
      return;
    }

    const lines: DolibarrOrderLineInput[] = cartItems.flatMap((entry) => {
        const productId = getDolibarrProductId(entry.product);
        if (!productId) return [];
        const unitPrice = getDolibarrProductPrice(entry.product);
        const taxRate = getDolibarrProductTaxRate(entry.product);
        const rawProductType = entry.product.type;
        const productType =
          typeof rawProductType === "number"
            ? rawProductType
            : typeof rawProductType === "string"
              ? Number(rawProductType)
              : 0;
        return [{
          productId,
          qty: entry.qty,
          unitPrice,
          taxRate,
          description: entry.product.description || entry.product.label || undefined,
          productType: Number.isFinite(productType) ? productType : 0,
          discountPercent: entry.discountPercent || 0,
        } satisfies DolibarrOrderLineInput];
      });

    if (!lines.length) {
      Alert.alert("Products Missing", "Unable to build sales order lines.");
      return;
    }

    setPosSubmitting(true);
    setPosError(null);
    setPosSuccess(null);
    try {
      const result = await createDolibarrSalesOrder({
        customerId,
        lines,
      });
      if (!result.orderId) {
        throw new Error(result.message || "Sales order created but ID missing.");
      }
      await validateDolibarrSalesOrder(result.orderId);

      const deductionItems = cartItems
        .map((entry) => {
          const productId = getDolibarrProductId(entry.product);
          if (!productId) return null;
          return {
            productId,
            name: getDolibarrProductLabel(entry.product),
            qty: entry.qty,
          };
        })
        .filter((entry): entry is { productId: number; name: string; qty: number } => Boolean(entry));

      if (deductionItems.length > 0) {
        const assignedStockist = user ? await resolveAssignedStockistForUser(user) : null;

        const now = new Date().toISOString();
        const transferPayloads = assignedStockist
          ? deductionItems.map((item) => ({
              id: `pos_sale_${result.orderId}_${item.productId}_${Date.now()}`,
              stockistId: assignedStockist.id,
              stockistName: assignedStockist.name,
              type: "out" as const,
              itemName: item.name,
              itemId: String(item.productId),
              quantity: item.qty,
              salespersonId: user?.id,
              salespersonName: user?.name,
              note: `POS Order #${result.orderId}`,
              createdAt: now,
            }))
          : [];
        const directCompanyAdjustments = !assignedStockist
          ? deductionItems.map((item) =>
              adjustCompanyProductStock({
                productId: item.productId,
                delta: -item.qty,
                reason: `POS Order #${result.orderId} direct sale by ${user?.name || "salesperson"}`,
              })
            )
          : [];

        const transferResults = transferPayloads.length
          ? await Promise.allSettled(transferPayloads.map((payload) => addStockTransfer(payload)))
          : [];
        const companyAdjustmentResults = directCompanyAdjustments.length
          ? await Promise.allSettled(directCompanyAdjustments)
          : [];

        const transferFailed = transferResults.some((entry) => entry.status === "rejected");
        const companyAdjustmentFailed = companyAdjustmentResults.some(
          (entry) => entry.status === "rejected"
        );
        if (transferFailed || companyAdjustmentFailed) {
          Alert.alert(
            "Stock Update Warning",
            assignedStockist
              ? "Order created but channel partner stock could not be fully updated."
              : "Order created but company stock could not be fully updated."
          );
        }
      }

      if (
        user &&
        linkedPosVisitTask &&
        typeof linkedPosVisitTask.visitLatitude === "number" &&
        Number.isFinite(linkedPosVisitTask.visitLatitude) &&
        typeof linkedPosVisitTask.visitLongitude === "number" &&
        Number.isFinite(linkedPosVisitTask.visitLongitude)
      ) {
        const totalAmount = cartItems.reduce((sum, entry) => {
          const price = getDolibarrProductPrice(entry.product);
          const discount = Math.max(0, Math.min(100, entry.discountPercent || 0));
          return sum + price * (1 - discount / 100) * entry.qty;
        }, 0);
        await addQuickSaleLocationLog({
          id: `quick_sale_${result.orderId}_${Date.now()}`,
          salespersonId: user.id,
          salespersonName: user.name,
          visitTaskId: linkedPosVisitTask.id,
          visitLabel: getVisitLabel(linkedPosVisitTask),
          visitDepartureNotes: linkedPosVisitTask.visitDepartureNotes?.trim() || null,
          visitDepartedAt: linkedPosVisitTask.departureAt ?? null,
          customerId: String(customerId),
          customerName: getDolibarrThirdPartyLabel(selectedCustomer),
          customerEmail: selectedCustomer.email?.trim() || null,
          customerAddress:
            selectedCustomer.address?.trim() ||
            selectedCustomer.town?.trim() ||
            linkedPosVisitTask.visitLocationAddress?.trim() ||
            null,
          orderId: String(result.orderId),
          itemCount: cartItems.reduce((sum, entry) => sum + entry.qty, 0),
          totalAmount,
          latitude: linkedPosVisitTask.visitLatitude,
          longitude: linkedPosVisitTask.visitLongitude,
          capturedAt: linkedPosVisitTask.arrivalAt || linkedPosVisitTask.departureAt || new Date().toISOString(),
        });
      }

      setPosSuccess(`Sales order #${result.orderId} created and validated.`);
      setPosCart({});
      setPosLinkedVisitTaskId(null);
      await loadData();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create sales order.";
      setPosError(message);
      Alert.alert("Order Failed", message);
    } finally {
      setPosSubmitting(false);
    }
  }, [cartItems, linkedPosVisitTask, loadData, posSubmitting, selectedCustomer, user]);

  const shouldShowLiveSuggestions =
    Boolean(activeVisitTaskId) || Boolean(liveTranscript.trim()) || isRecording || isTranscribingFile;

  const liveSuggestionsSection = shouldShowLiveSuggestions ? (
    <Animated.View
      entering={FadeInDown.duration(360).delay(84)}
      style={[
        styles.liveSuggestionCard,
        { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
      ]}
    >
      <View style={styles.liveSuggestionHeader}>
        <View style={styles.liveSuggestionTitleWrap}>
          <View style={[styles.liveSuggestionIcon, { backgroundColor: colors.primary + "14" }]}>
            <Ionicons name="sparkles-outline" size={16} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.liveSuggestionTitle,
                { color: colors.text, fontFamily: "Inter_700Bold" },
              ]}
            >
              Live Product Suggestions
            </Text>
            <Text
              style={[
                styles.liveSuggestionMeta,
                { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
              ]}
            >
              Products will continue updating from live phrases as soon as the meeting starts.
            </Text>
          </View>
        </View>
        <View
          style={[
            styles.liveSuggestionStatusChip,
            {
              backgroundColor:
                isRecording || isTranscribingFile
                  ? colors.success + "14"
                  : colors.surfaceSecondary,
            },
          ]}
        >
          <Text
            style={[
              styles.liveSuggestionStatusText,
              {
                color:
                  isRecording || isTranscribingFile
                    ? colors.success
                    : colors.textSecondary,
                fontFamily: "Inter_700Bold",
              },
            ]}
          >
            {isRecording ? "Listening" : isTranscribingFile ? "Transcribing" : "Standby"}
          </Text>
        </View>
      </View>

      {liveDetectedPhrases.length ? (
        <View style={styles.liveSuggestionPhraseWrap}>
          {liveDetectedPhrases.map((phrase) => (
            <View
              key={`live_phrase_${phrase}`}
              style={[
                styles.liveSuggestionPhraseChip,
                { backgroundColor: colors.primary + "10" },
              ]}
            >
              <Text
                style={[
                  styles.liveSuggestionPhraseText,
                  { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                ]}
              >
                {phrase}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text
          style={[
            styles.liveSuggestionHint,
            { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
          ]}
        >
          Phrases are being captured. As soon as clear specs or product needs are detected, matching products will appear below.
        </Text>
      )}

      {liveProductSuggestions.length ? (
        <View style={styles.liveSuggestionList}>
          {liveProductSuggestions.map((item) => (
            <View
              key={`live_product_${item.id}`}
              style={[
                styles.liveSuggestionRow,
                { backgroundColor: colors.surface, borderColor: colors.borderLight },
              ]}
            >
              <View style={[styles.liveSuggestionProductIcon, { backgroundColor: colors.secondary + "12" }]}>
                <Ionicons name="cube-outline" size={15} color={colors.secondary} />
              </View>
              <View style={styles.liveSuggestionTextWrap}>
                <View style={styles.liveSuggestionRowHeader}>
                  <Text
                    style={[
                      styles.liveSuggestionRowTitle,
                      { color: colors.text, fontFamily: "Inter_700Bold" },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {item.ref ? (
                    <View
                      style={[
                        styles.liveSuggestionRefChip,
                        { backgroundColor: colors.secondary + "16" },
                      ]}
                    >
                      <Text
                        style={[
                          styles.liveSuggestionRefText,
                          { color: colors.secondary, fontFamily: "Inter_700Bold" },
                        ]}
                      >
                        {item.ref}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.liveSuggestionReason,
                    { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                  ]}
                >
                  {item.reason}
                </Text>
                <View style={styles.liveSuggestionMatchWrap}>
                  {item.matchedSpecifications.map((entry) => (
                    <View
                      key={`${item.id}_live_spec_${entry}`}
                      style={[
                        styles.liveSuggestionMatchChip,
                        { backgroundColor: colors.primary + "10" },
                      ]}
                    >
                      <Text
                        style={[
                          styles.liveSuggestionMatchText,
                          { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        Spec: {entry}
                      </Text>
                    </View>
                  ))}
                  {item.matchedKeyPhrases.map((entry) => (
                    <View
                      key={`${item.id}_live_phrase_${entry}`}
                      style={[
                        styles.liveSuggestionMatchChip,
                        { backgroundColor: colors.secondary + "12" },
                      ]}
                    >
                      <Text
                        style={[
                          styles.liveSuggestionMatchText,
                          { color: colors.secondary, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        Phrase: {entry}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : hasLiveSuggestionSignals ? (
        <View
          style={[
            styles.liveSuggestionEmpty,
            { backgroundColor: colors.surface, borderColor: colors.borderLight },
          ]}
        >
          <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
          <Text
            style={[
              styles.liveSuggestionEmptyText,
              { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
            ]}
          >
            Live suggestions will update here as soon as clearer specs or product needs are detected.
          </Text>
        </View>
      ) : null}
    </Animated.View>
  ) : null;

  const salesTrendRecommendationsSection = !isAdminViewer ? (
    <Animated.View entering={FadeInDown.duration(400).delay(86)}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
          Trending Product Recommendations
        </Text>
        <Text
          style={[
            styles.sectionMetaText,
            { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
          ]}
        >
          Reliable product picks tagged by pattern, not just one-off sales spikes.
        </Text>
      </View>
      <View
        style={[
          styles.trendRecommendationsCard,
          { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
        ]}
      >
        {salesTrendLoading ? (
          <View style={styles.trendRecommendationsLoading}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text
              style={[
                styles.trendRecommendationsLoadingText,
                { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
              ]}
            >
              Loading recent product trends...
            </Text>
          </View>
        ) : normalizedSalesTrendRecommendations.length ? (
          normalizedSalesTrendRecommendations.map((item, idx) => (
            <View
              key={`sales_trend_${item.id}`}
              style={[
                styles.trendRecommendationRow,
                idx < normalizedSalesTrendRecommendations.length - 1 && {
                  borderBottomWidth: 0.5,
                  borderBottomColor: colors.borderLight,
                },
              ]}
            >
              <View style={[styles.trendRecommendationIcon, { backgroundColor: colors.success + "15" }]}>
                <Ionicons name="trending-up-outline" size={16} color={colors.success} />
              </View>
              <View style={styles.trendRecommendationTextWrap}>
                <View style={styles.trendRecommendationHeader}>
                  <Text
                    style={[
                      styles.trendRecommendationTitle,
                      { color: colors.text, fontFamily: "Inter_600SemiBold" },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {item.ref ? (
                    <View style={[styles.trendRecommendationRef, { backgroundColor: colors.secondary + "18" }]}>
                      <Text
                        style={[
                          styles.trendRecommendationRefText,
                          { color: colors.secondary, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        {item.ref}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={[
                    styles.trendRecommendationReason,
                    { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                  ]}
                >
                  {item.reason}
                </Text>
                <View style={styles.trendRecommendationMetrics}>
                  {(Array.isArray(item.tags) ? item.tags : []).map((tag) => {
                    const palette = resolveTrendTagColors(colors, tag.tone);
                    return (
                      <View
                        key={`${item.id}_${tag.label}`}
                        style={[styles.trendTagChip, { backgroundColor: palette.backgroundColor }]}
                      >
                        <Text
                          style={[
                            styles.trendTagChipText,
                            { color: palette.textColor, fontFamily: "Inter_600SemiBold" },
                          ]}
                        >
                          {tag.label}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <View style={styles.trendRecommendationMetrics}>
                  <View style={[styles.trendMetricChip, { backgroundColor: colors.success + "12" }]}>
                    <Text
                      style={[
                        styles.trendMetricChipText,
                        { color: colors.success, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      {item.unitsSold} units
                    </Text>
                  </View>
                  <View style={[styles.trendMetricChip, { backgroundColor: colors.primary + "12" }]}>
                    <Text
                      style={[
                        styles.trendMetricChipText,
                        { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      {item.orderCount} orders
                    </Text>
                  </View>
                  {item.activeMonths > 0 ? (
                    <View style={[styles.trendMetricChip, { backgroundColor: colors.warning + "12" }]}>
                      <Text
                        style={[
                          styles.trendMetricChipText,
                          { color: colors.warning, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        {item.activeMonths} months
                      </Text>
                    </View>
                  ) : null}
                </View>
                {item.bestMonthLabel ? (
                  <Text
                    style={[
                      styles.trendRecommendationSubnote,
                      { color: colors.textTertiary, fontFamily: "Inter_500Medium" },
                    ]}
                  >
                    Best month seen: {formatSalesTrendMonthLabel(item.bestMonthLabel)}
                  </Text>
                ) : null}
              </View>
            </View>
          ))
        ) : (
          <View style={styles.trendRecommendationsEmpty}>
            <Ionicons name="trending-up-outline" size={18} color={colors.textTertiary} />
            <Text
              style={[
                styles.trendRecommendationsEmptyText,
                { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
              ]}
            >
              No recent product trends available yet.
            </Text>
          </View>
        )}
      </View>
    </Animated.View>
  ) : null;

  return (
    <AppCanvas>
      <FlatList
        ref={rootListRef}
        data={isAdminViewer ? visibleConversations : []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingTop: insets.top + 16,
            paddingBottom: Math.max(40, keyboardHeight + 24),
          },
        ]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            <View style={styles.navToggleWrap}>
              <DrawerToggleButton
                disabled={meetingFocusMode}
                onBlockedPress={showMeetingExitBlockedAlert}
              />
            </View>
            <Animated.View entering={FadeInDown.duration(400)} style={styles.header}>
              <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                Sales Intelligence
              </Text>
              <Text style={[styles.headerSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {isAdminViewer
                  ? `Admin view for ${company?.name || "your company"}`
                  : `Today's field route and assigned visits for ${company?.name || "your company"}`}
              </Text>
            </Animated.View>

            {isAdminViewer ? (
              <Animated.View
                entering={FadeInDown.duration(400).delay(40)}
                style={[
                  styles.routeCard,
                  { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                ]}
              >
                <View style={styles.routeHeaderRow}>
                  <Text
                    style={[styles.routeHeaderTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}
                  >
                    Today&apos;s Route
                  </Text>
                  <Text
                    style={[
                      styles.routeHeaderSubtitle,
                      { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                    ]}
                  >
                    {mumbaiNowLabel}
                  </Text>
                </View>

                {isAdminViewer ? (
                  <FlatList
                    horizontal
                    data={selectableSalespeople}
                    keyExtractor={(item) => item.id}
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.salespersonChipRow}
                    renderItem={({ item }) => {
                      const active = item.id === selectedSalespersonId;
                      return (
                        <Pressable
                          onPress={() => setSelectedSalespersonId(item.id)}
                          style={[
                            styles.salespersonChip,
                            {
                              borderColor: active ? colors.primary : colors.border,
                              backgroundColor: active ? colors.primary : colors.surfaceSecondary,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.salespersonChipText,
                              {
                                color: active ? "#FFFFFF" : colors.textSecondary,
                                fontFamily: "Inter_500Medium",
                              },
                            ]}
                          >
                            {item.name}
                          </Text>
                        </Pressable>
                      );
                    }}
                  />
                ) : null}

                {isAdminViewer ? (
                  <View style={[styles.routePlannerCard, { borderColor: colors.borderLight }]}>
                    <View style={styles.routePlannerHeader}>
                      <Text
                        style={[
                          styles.routePlannerTitle,
                          { color: colors.text, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        Assign Route Stops
                      </Text>
                      <Text
                        style={[
                          styles.routePlannerSubtitle,
                          { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                        ]}
                      >
                        {selectedSalesperson
                          ? `${selectedSalesperson.name} | ${routePlanDate}`
                          : routePlanDate}
                      </Text>
                    </View>

                    <TextInput
                      value={routePlanDate}
                      onChangeText={setRoutePlanDate}
                      placeholder="Route date (YYYY-MM-DD)"
                      placeholderTextColor={colors.textTertiary}
                      style={[
                        styles.routePlannerInput,
                        {
                          borderColor: colors.border,
                          backgroundColor: colors.surface,
                          color: colors.text,
                          fontFamily: "Inter_500Medium",
                        },
                      ]}
                    />

                    <View
                      style={[
                        styles.routeModeToggleWrap,
                        { borderColor: colors.border, backgroundColor: colors.surface },
                      ]}
                    >
                      {[
                        { key: "customer" as const, label: "Customers" },
                        { key: "location" as const, label: "Location" },
                      ].map((option) => {
                        const active = routeStopInputMode === option.key;
                        return (
                          <Pressable
                            key={option.key}
                            onPress={() => setRouteStopInputMode(option.key)}
                            style={({ pressed }) => [
                              styles.routeModeToggleBtn,
                              {
                                backgroundColor: active ? colors.primary : "transparent",
                                opacity: pressed ? 0.82 : 1,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.routeModeToggleText,
                                {
                                  color: active ? "#FFFFFF" : colors.textSecondary,
                                  fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                                },
                              ]}
                            >
                              {option.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    <View style={styles.routeSearchRow}>
                      <TextInput
                        value={routeSearchQuery}
                        onChangeText={setRouteSearchQuery}
                        onSubmitEditing={() => {
                          if (routeStopInputMode === "location") {
                            void handleSearchRouteLocations();
                          }
                        }}
                        returnKeyType={routeStopInputMode === "location" ? "search" : "done"}
                        placeholder={
                          routeStopInputMode === "customer"
                            ? "Search customer name, address, email..."
                            : "Search location, area, company..."
                        }
                        placeholderTextColor={colors.textTertiary}
                        style={[
                          styles.routeSearchInput,
                          {
                            borderColor: colors.border,
                            backgroundColor: colors.surface,
                            color: colors.text,
                            fontFamily: "Inter_400Regular",
                          },
                        ]}
                      />
                      {routeStopInputMode === "location" ? (
                        <Pressable
                          onPress={() => void handleSearchRouteLocations()}
                          disabled={routeSearchBusy}
                          style={({ pressed }) => [
                            styles.routeSearchButton,
                            {
                              backgroundColor: colors.primary,
                              opacity: pressed || routeSearchBusy ? 0.75 : 1,
                            },
                          ]}
                        >
                          {routeSearchBusy ? (
                            <ActivityIndicator size="small" color="#FFFFFF" />
                          ) : (
                            <Ionicons name="search-outline" size={17} color="#FFFFFF" />
                          )}
                        </Pressable>
                      ) : null}
                    </View>

                    {routeStopInputMode === "location" && routeSearchResults.length ? (
                      <View
                        style={[
                          styles.routeSearchResultWrap,
                          { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                        ]}
                      >
                        {routeSearchResults.map((result) => (
                          <Pressable
                            key={result.id}
                            onPress={() => handleAddRouteStop(result)}
                            style={({ pressed }) => [
                              styles.routeSearchResultRow,
                              {
                                borderBottomColor: colors.borderLight,
                                opacity: pressed ? 0.85 : 1,
                              },
                            ]}
                          >
                            <View style={styles.routeSearchResultTextWrap}>
                              <Text
                                style={[
                                  styles.routeSearchResultTitle,
                                  { color: colors.text, fontFamily: "Inter_600SemiBold" },
                                ]}
                                numberOfLines={1}
                              >
                                {result.label}
                              </Text>
                              <Text
                                style={[
                                  styles.routeSearchResultMeta,
                                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                                ]}
                                numberOfLines={2}
                              >
                                {formatSearchAddress(result.address)}
                              </Text>
                            </View>
                            <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                          </Pressable>
                        ))}
                      </View>
                    ) : null}

                    {routeStopInputMode === "customer" ? (
                      <View
                        style={[
                          styles.routeSearchResultWrap,
                          { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                        ]}
                      >
                        {routePlannerCustomersLoading ? (
                          <View style={styles.routeCustomerEmptyState}>
                            <ActivityIndicator size="small" color={colors.primary} />
                            <Text
                              style={[
                                styles.routeCustomerEmptyText,
                                { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                              ]}
                            >
                              Loading customers...
                            </Text>
                          </View>
                        ) : routeSearchQuery.trim() && routeCustomerResults.length ? (
                          routeCustomerResults.map((party) => {
                            const partyId = getDolibarrThirdPartyId(party);
                            const busyId = partyId ? String(partyId) : getDolibarrThirdPartyLabel(party);
                            const isBusy = routeCustomerAddBusyId === busyId;
                            return (
                              <Pressable
                                key={busyId}
                                onPress={() => void handleAddCustomerRouteStop(party)}
                                disabled={isBusy}
                                style={({ pressed }) => [
                                  styles.routeSearchResultRow,
                                  {
                                    borderBottomColor: colors.borderLight,
                                    opacity: pressed || isBusy ? 0.85 : 1,
                                  },
                                ]}
                              >
                                <View style={styles.routeSearchResultTextWrap}>
                                  <Text
                                    style={[
                                      styles.routeSearchResultTitle,
                                      { color: colors.text, fontFamily: "Inter_600SemiBold" },
                                    ]}
                                    numberOfLines={1}
                                  >
                                    {getDolibarrThirdPartyLabel(party)}
                                  </Text>
                                  <Text
                                    style={[
                                      styles.routeSearchResultMeta,
                                      { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                                    ]}
                                    numberOfLines={2}
                                  >
                                    {formatSearchAddress(getDolibarrThirdPartyAddress(party) || party.email || null)}
                                  </Text>
                                </View>
                                {isBusy ? (
                                  <ActivityIndicator size="small" color={colors.primary} />
                                ) : (
                                  <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                                )}
                              </Pressable>
                            );
                          })
                        ) : (
                          <View style={styles.routeCustomerEmptyState}>
                            <Text
                              style={[
                                styles.routeCustomerEmptyText,
                                { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                              ]}
                            >
                              {routeSearchQuery.trim()
                                ? "No matching customers found."
                                : "Search a customer and add them between route stops."}
                            </Text>
                          </View>
                        )}
                      </View>
                    ) : null}

                    <View
                      style={[
                        styles.routeDraftWrap,
                        { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                      ]}
                    >
                      {routePlanStops.length ? (
                        routePlanStops.map((stop, index) => (
                          <View
                            key={stop.id}
                            style={[
                              styles.routeDraftRow,
                              index < routePlanStops.length - 1 && {
                                borderBottomWidth: 0.5,
                                borderBottomColor: colors.borderLight,
                              },
                            ]}
                          >
                            <View
                              style={[
                                styles.routeDraftSequence,
                                { backgroundColor: `${colors.primary}20` },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.routeDraftSequenceText,
                                  { color: colors.primary, fontFamily: "Inter_700Bold" },
                                ]}
                              >
                                {index + 1}
                              </Text>
                            </View>
                            <View style={styles.routeDraftTextWrap}>
                              <Text
                                style={[
                                  styles.routeDraftTitle,
                                  { color: colors.text, fontFamily: "Inter_600SemiBold" },
                                ]}
                                numberOfLines={1}
                              >
                                {stop.label}
                              </Text>
                              <Text
                                style={[
                                  styles.routeDraftSource,
                                  {
                                    color:
                                      stop.source === "customer" ? colors.primary : colors.textTertiary,
                                    fontFamily: "Inter_600SemiBold",
                                  },
                                ]}
                              >
                                {stop.source === "customer" ? "Customer stop" : "Location stop"}
                              </Text>
                              <Text
                                style={[
                                  styles.routeDraftMeta,
                                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                                ]}
                                numberOfLines={2}
                              >
                                {formatSearchAddress(stop.address)}
                              </Text>
                            </View>
                            <View style={styles.routeDraftActions}>
                              <Pressable
                                onPress={() => handleMoveRouteStop(index, "up")}
                                disabled={index === 0}
                                style={({ pressed }) => [
                                  styles.routeDraftIconBtn,
                                  {
                                    opacity: index === 0 ? 0.35 : pressed ? 0.7 : 1,
                                  },
                                ]}
                              >
                                <Ionicons name="chevron-up-outline" size={16} color={colors.textSecondary} />
                              </Pressable>
                              <Pressable
                                onPress={() => handleMoveRouteStop(index, "down")}
                                disabled={index === routePlanStops.length - 1}
                                style={({ pressed }) => [
                                  styles.routeDraftIconBtn,
                                  {
                                    opacity:
                                      index === routePlanStops.length - 1 ? 0.35 : pressed ? 0.7 : 1,
                                  },
                                ]}
                              >
                                <Ionicons
                                  name="chevron-down-outline"
                                  size={16}
                                  color={colors.textSecondary}
                                />
                              </Pressable>
                              <Pressable
                                onPress={() => handleRemoveRouteStop(stop.id)}
                                style={({ pressed }) => [
                                  styles.routeDraftIconBtn,
                                  { opacity: pressed ? 0.7 : 1 },
                                ]}
                              >
                                <Ionicons name="close-outline" size={16} color={colors.danger} />
                              </Pressable>
                            </View>
                          </View>
                        ))
                      ) : (
                        <View style={styles.routeDraftEmpty}>
                          <Text
                            style={[
                              styles.routeDraftEmptyText,
                              { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                            ]}
                          >
                            Search and add stops to build route order.
                          </Text>
                        </View>
                      )}
                    </View>

                    <Pressable
                      onPress={() => void handleAssignRoutePlan()}
                      disabled={routePlanSaving || !selectedSalespersonId || !routePlanStops.length}
                      style={({ pressed }) => [
                        styles.routeAssignButton,
                        {
                          backgroundColor: colors.primary,
                          opacity:
                            pressed || routePlanSaving || !selectedSalespersonId || !routePlanStops.length
                              ? 0.72
                              : 1,
                        },
                      ]}
                    >
                      {routePlanSaving ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={styles.routeAssignButtonText}>
                          Assign Route ({routePlanStops.length})
                        </Text>
                      )}
                    </Pressable>
                  </View>
                ) : null}

                <View style={styles.routeMapShell}>
                  <RouteMapNative
                    points={routeTimeline.points}
                    halts={routeTimeline.halts}
                    plannedStops={mapPlannedStops}
                    quickSalePoints={nearbyQuickSalePoints}
                    routePath={routePreviewPath}
                    colors={colors}
                    height={255}
                  />
                  {!isSelectedSalespersonTrackingActive ? (
                    <View style={styles.routeMapOverlay}>
                      <View
                        style={[
                          styles.routeMapOverlayCard,
                          {
                            borderColor: colors.warning + "55",
                            backgroundColor: colors.backgroundElevated + "F2",
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.routeMapOverlayTitle,
                            { color: colors.text, fontFamily: "Inter_700Bold" },
                          ]}
                        >
                          {selectedSalespersonTrackingTitle}
                        </Text>
                        <Text
                          style={[
                            styles.routeMapOverlayText,
                            { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                          ]}
                        >
                          {selectedSalespersonTrackingMessage}
                        </Text>
                      </View>
                    </View>
                  ) : null}
                </View>

                <View
                  style={[
                    styles.routePreviewCard,
                    { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                  ]}
                >
                  <View style={[styles.routePreviewIconWrap, { backgroundColor: `${colors.primary}18` }]}>
                    {routePreviewBusy ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Ionicons name="navigate-outline" size={16} color={colors.primary} />
                    )}
                  </View>
                  <View style={styles.routePreviewTextWrap}>
                    <Text
                      style={[
                        styles.routePreviewTitle,
                        { color: colors.text, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      Destination Route
                    </Text>
                    <Text
                      style={[
                        styles.routePreviewMeta,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                      numberOfLines={3}
                    >
                      {routePreviewSummary}
                    </Text>
                  </View>
                </View>

                <View style={styles.summaryRow}>
                  <View
                    style={[
                      styles.summaryCard,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                    ]}
                  >
                    <Text
                      style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}
                    >
                      {routeTimeline.summary.totalDistanceKm.toFixed(2)} km
                    </Text>
                    <Text
                      style={[
                        styles.summaryLabel,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      Distance
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.summaryCard,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                    ]}
                  >
                    <Text
                      style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}
                    >
                      {routeTimeline.summary.totalHaltMinutes} mins
                    </Text>
                    <Text
                      style={[
                        styles.summaryLabel,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      Halt Time
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.summaryCard,
                      { borderColor: colors.border, backgroundColor: colors.backgroundElevated },
                    ]}
                  >
                    <Text
                      style={[styles.summaryValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}
                    >
                      {visiblePlannedStops.length}
                    </Text>
                    <Text
                      style={[
                        styles.summaryLabel,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      Planned Stops
                    </Text>
                  </View>
                </View>

                <View
                  style={[
                    styles.currentLocationCard,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}
                >
                  <View style={[styles.currentLocationIcon, { backgroundColor: `${colors.primary}18` }]}>
                    <Ionicons name="locate-outline" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.currentLocationTitle,
                        { color: colors.text, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      {isSelectedSalespersonTrackingActive ? "Current Location" : "Attendance Status"}
                    </Text>
                    <Text
                      style={[
                        styles.currentLocationMeta,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      {currentLocationMeta}
                    </Text>
                  </View>
                </View>
              </Animated.View>
            ) : (
              <>
                <Animated.View entering={FadeInDown.duration(420).delay(40)}>
                  <LinearGradient
                    colors={isDark ? [colors.heroEnd, colors.primary] : [colors.heroStart, colors.heroEnd]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.salesHeroCard}
                  >
                    <View style={styles.salesHeroTopRow}>
                      <Text style={styles.salesHeroEyebrow}>My Field Day</Text>
                      <Text style={styles.salesHeroDate}>{mumbaiNowLabel}</Text>
                    </View>
                    <Text style={styles.salesHeroTitle}>Route Focus</Text>
                    <Text style={styles.salesHeroMeta}>{salesHeroMeta}</Text>
                    <View style={styles.salesHeroStatsRow}>
                      <View style={styles.salesHeroStat}>
                        <Text style={styles.salesHeroStatValue}>{visitSummary.completed}</Text>
                        <Text style={styles.salesHeroStatLabel}>Completed</Text>
                      </View>
                      <View style={styles.salesHeroStatDivider} />
                      <View style={styles.salesHeroStat}>
                        <Text style={styles.salesHeroStatValue}>{remainingVisits}</Text>
                        <Text style={styles.salesHeroStatLabel}>Remaining</Text>
                      </View>
                      <View style={styles.salesHeroStatDivider} />
                      <View style={styles.salesHeroStat}>
                        <Text style={styles.salesHeroStatValue}>{visitSummary.total}</Text>
                        <Text style={styles.salesHeroStatLabel}>Total</Text>
                      </View>
                    </View>
                    <View style={styles.salesHeroFooter}>
                      <View
                        style={[
                          styles.salesHeroBadge,
                          {
                            backgroundColor: activeVisitTask ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.18)",
                          },
                        ]}
                      >
                        <Ionicons name={activeVisitTask ? "pulse-outline" : "checkmark-circle-outline"} size={14} color="#FFFFFF" />
                        <Text style={styles.salesHeroBadgeText}>
                          {activeVisitTask ? "Visit live" : "Route ready"}
                        </Text>
                      </View>
                      <Text style={styles.salesHeroStatus}>{salesHeroStatus}</Text>
                    </View>
                  </LinearGradient>
                </Animated.View>

                {meetingFocusMode ? (
                  <Animated.View
                    entering={FadeInDown.duration(380).delay(80)}
                    style={[
                      styles.meetingFocusCard,
                      { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                    ]}
                  >
                    <View style={styles.meetingFocusHeader}>
                      <View style={[styles.meetingFocusIcon, { backgroundColor: colors.primary + "16" }]}>
                        <Ionicons name="mic-outline" size={18} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.meetingFocusTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                          Meeting Focus Mode
                        </Text>
                        <Text
                          style={[styles.meetingFocusMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}
                        >
                          Map, route preview, and nearby checks are paused so live phrase-based product matching stays as fast as possible.
                        </Text>
                      </View>
                    </View>
                    <View style={styles.meetingFocusStatRow}>
                      <View style={[styles.meetingFocusStat, { backgroundColor: colors.surface }]}>
                        <Text style={[styles.meetingFocusStatLabel, { color: colors.textSecondary }]}>Meeting</Text>
                        <Text style={[styles.meetingFocusStatValue, { color: colors.text }]}>
                          {activeVisitTask ? getVisitLabel(activeVisitTask) : "Active session"}
                        </Text>
                      </View>
                      <View style={[styles.meetingFocusStat, { backgroundColor: colors.surface }]}>
                        <Text style={[styles.meetingFocusStatLabel, { color: colors.textSecondary }]}>Live state</Text>
                        <Text style={[styles.meetingFocusStatValue, { color: colors.text }]}>
                          {isRecording ? "Listening" : isTranscribingFile ? "Transcribing" : "Focused"}
                        </Text>
                      </View>
                    </View>
                  </Animated.View>
                ) : (
                  <>
                    <Animated.View
                      entering={FadeInDown.duration(380).delay(80)}
                      style={[
                        styles.salesMapCard,
                        { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                      ]}
                    >
                      <View style={styles.salesMapHeader}>
                        <Text style={[styles.salesMapTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          My Route Map
                        </Text>
                        <Text style={[styles.salesMapMeta, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                          {mumbaiNowLabel}
                        </Text>
                      </View>
                      <View style={styles.routeMapShell}>
                        <RouteMapNative
                          points={routeTimeline.points}
                          halts={routeTimeline.halts}
                          plannedStops={mapPlannedStops}
                          routePath={routePreviewPath}
                          colors={colors}
                          height={230}
                        />
                        {!isSelectedSalespersonTrackingActive ? (
                          <View style={styles.routeMapOverlay}>
                            <View
                              style={[
                                styles.routeMapOverlayCard,
                                {
                                  borderColor: colors.warning + "55",
                                  backgroundColor: colors.backgroundElevated + "F2",
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.routeMapOverlayTitle,
                                  { color: colors.text, fontFamily: "Inter_700Bold" },
                                ]}
                              >
                                {selectedSalespersonTrackingTitle}
                              </Text>
                              <Text
                                style={[
                                  styles.routeMapOverlayText,
                                  { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                                ]}
                              >
                                {selectedSalespersonTrackingMessage}
                              </Text>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    </Animated.View>

                    <Animated.View
                      entering={FadeInDown.duration(360).delay(110)}
                      style={[
                        styles.salesInfoCard,
                        { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                      ]}
                    >
                      <View style={[styles.salesInfoIcon, { backgroundColor: `${colors.primary}18` }]}>
                        {routePreviewBusy ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <Ionicons name="navigate-outline" size={16} color={colors.primary} />
                        )}
                      </View>
                      <View style={styles.salesInfoText}>
                        <Text style={[styles.salesInfoTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          Next Stop
                        </Text>
                        <Text style={[styles.salesInfoMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                          {routePreviewSummary}
                        </Text>
                      </View>
                    </Animated.View>

                    <Animated.View
                      entering={FadeInDown.duration(360).delay(130)}
                      style={[
                        styles.salesInfoCard,
                        { backgroundColor: colors.surface, borderColor: colors.border },
                      ]}
                    >
                      <View style={[styles.salesInfoIcon, { backgroundColor: `${colors.secondary}18` }]}>
                        <Ionicons name="locate-outline" size={16} color={colors.secondary} />
                      </View>
                      <View style={styles.salesInfoText}>
                        <Text style={[styles.salesInfoTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                          {isSelectedSalespersonTrackingActive ? "Current Location" : "Attendance Status"}
                        </Text>
                        <Text style={[styles.salesInfoMeta, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                          {currentLocationMeta}
                        </Text>
                      </View>
                    </Animated.View>
                  </>
                )}
              </>
            )}


            <Animated.View entering={FadeInDown.duration(350).delay(70)}>
              <View style={styles.sectionHeaderRow}>
                <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                  {isAdminViewer ? "Assigned Field Visits" : "Today's Visits"}
                </Text>
                {!isAdminViewer ? (
                  <Pressable
                    onPress={() => {
                      if (meetingFocusMode) {
                        showMeetingExitBlockedAlert();
                        return;
                      }
                      router.push("/visit-notes");
                    }}
                    disabled={meetingFocusMode}
                    style={({ pressed }) => [
                      styles.reviewNotesButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                        opacity: meetingFocusMode ? 0.45 : pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Ionicons name="document-text-outline" size={14} color={colors.primary} />
                    <Text
                      style={[
                        styles.reviewNotesButtonText,
                        { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                      ]}
                    >
                      Review Notes
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={[styles.timelineCard, { borderColor: colors.border, backgroundColor: colors.backgroundElevated }]}>
                {todaysVisitTasks.length ? (
                  todaysVisitTasks.map((task, idx) => {
                    const status = getVisitStatus(task);
                    const statusColor = getVisitStatusColor(status, colors);
                    const isBusy = visitActionTaskId === task.id;
                    const canArrive = !isAdminViewer && status === "pending";
                    const recordingActive = Boolean(task.autoCaptureRecordingActive) && status !== "completed";
                    const canMeetingStart =
                      !isAdminViewer && status === "in_progress" && !recordingActive && !task.autoCaptureConversationId;
                    const canMeetingEnd = !isAdminViewer && status === "in_progress" && recordingActive;
                    const canDepart =
                      !isAdminViewer && status === "in_progress" && !recordingActive && Boolean(task.autoCaptureConversationId);
                    const recordingStartAt = task.autoCaptureRecordingStartedAt || task.arrivalAt || null;
                    const recordingStopAt = task.autoCaptureRecordingStoppedAt || task.departureAt || null;
                    const recordingHint =
                      status === "in_progress"
                        ? recordingActive
                          ? `Meeting recording LIVE${recordingStartAt ? ` | ${formatMumbaiTime(recordingStartAt)}` : ""}`
                          : task.autoCaptureConversationId
                            ? `Meeting saved${recordingStopAt ? ` | ${formatMumbaiTime(recordingStopAt)}` : ""}`
                            : "Meeting not started"
                        : task.autoCaptureConversationId
                          ? `Meeting saved${recordingStopAt ? ` | ${formatMumbaiTime(recordingStopAt)}` : ""}`
                          : null;
                    return (
                      <View
                        key={task.id}
                        style={[
                          styles.visitRow,
                          idx < todaysVisitTasks.length - 1 && {
                            borderBottomColor: colors.borderLight,
                            borderBottomWidth: 0.5,
                          },
                        ]}
                      >
                        <View style={[styles.rowIconWrap, { backgroundColor: `${statusColor}20` }]}>
                          <Ionicons
                            name={
                              status === "completed"
                                ? "checkmark-done-outline"
                                : status === "in_progress"
                                  ? "navigate-outline"
                                  : "flag-outline"
                            }
                            size={16}
                            color={statusColor}
                          />
                        </View>
                        <View style={styles.rowTextWrap}>
                          <View style={styles.visitTitleRow}>
                            <Text style={[styles.rowTime, { color: colors.text, fontFamily: "Inter_600SemiBold", flex: 1 }]}>
                              {task.visitSequence ? `#${task.visitSequence} ` : ""}
                              {getVisitLabel(task)}
                            </Text>
                            {isAdminViewer ? (
                              <Pressable
                                onPress={() => handleVisitDelete(task)}
                                disabled={isBusy}
                                style={({ pressed }) => [
                                  styles.visitDeleteButton,
                                  {
                                    backgroundColor: colors.danger + "12",
                                    borderColor: colors.danger + "30",
                                    opacity: pressed || isBusy ? 0.7 : 1,
                                  },
                                ]}
                              >
                                {isBusy ? (
                                  <ActivityIndicator size="small" color={colors.danger} />
                                ) : (
                                  <Ionicons name="trash-outline" size={15} color={colors.danger} />
                                )}
                              </Pressable>
                            ) : null}
                          </View>
                          <Text style={[styles.rowText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                            {getVisitSubtitle(task) || "Field visit point"}
                          </Text>
                          <Text style={[styles.rowText, { color: statusColor, fontFamily: "Inter_500Medium" }]}>
                            {status === "completed"
                              ? `Completed${
                                  task.departureAt
                                    ? ` | ${formatMumbaiTime(task.departureAt)}`
                                    : ""
                                }`
                              : status === "in_progress"
                                ? `Arrived${
                                    task.arrivalAt ? ` | ${formatMumbaiTime(task.arrivalAt)}` : ""
                                  }`
                                : "Pending"}
                          </Text>
                          {task.visitDepartureNotes?.trim() ? (
                            <View
                              style={[
                                styles.visitNotesPreview,
                                { backgroundColor: colors.surface, borderColor: colors.borderLight },
                              ]}
                            >
                              <Ionicons name="create-outline" size={14} color={colors.primary} />
                              <Text
                                numberOfLines={2}
                                style={[
                                  styles.visitNotesPreviewText,
                                  { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                              ]}
                            >
                              {task.visitDepartureNotes.trim()}
                              </Text>
                            </View>
                          ) : null}
                          {isAdminViewer && recordingHint ? (
                            <Text
                              style={[
                                styles.rowText,
                                {
                                  color: recordingActive ? colors.primary : colors.success,
                                  fontFamily: "Inter_500Medium",
                                },
                              ]}
                            >
                              {recordingHint}
                            </Text>
                          ) : null}
                          {canArrive ? (
                            <Pressable
                              onPress={() => void handleVisitArrived(task)}
                              disabled={isBusy}
                              style={({ pressed }) => [
                                styles.visitActionButton,
                                {
                                  backgroundColor: colors.primary,
                                  opacity: pressed || isBusy ? 0.7 : 1,
                                },
                              ]}
                            >
                              {isBusy ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                              ) : (
                                <Text style={styles.visitActionButtonText}>Arrived</Text>
                              )}
                            </Pressable>
                          ) : null}
                          {canMeetingStart ? (
                            <Pressable
                              onPress={() => void handleMeetingStart(task)}
                              disabled={isBusy}
                              style={({ pressed }) => [
                                styles.visitActionButton,
                                {
                                  backgroundColor: colors.primary,
                                  opacity: pressed || isBusy ? 0.7 : 1,
                                },
                              ]}
                            >
                              {isBusy ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                              ) : (
                                <Text style={styles.visitActionButtonText}>Meeting Start</Text>
                              )}
                            </Pressable>
                          ) : null}
                          {canMeetingEnd ? (
                            <Pressable
                              onPress={() => void handleMeetingEnd(task)}
                              disabled={isBusy}
                              style={({ pressed }) => [
                                styles.visitActionButton,
                                {
                                  backgroundColor: colors.warning,
                                  opacity: pressed || isBusy ? 0.7 : 1,
                                },
                              ]}
                            >
                              {isBusy ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                              ) : (
                                <Text style={styles.visitActionButtonText}>Meeting End</Text>
                              )}
                            </Pressable>
                          ) : null}
                          {canDepart ? (
                            <Pressable
                              onPress={() => void handleVisitDeparture(task)}
                              disabled={isBusy}
                              style={({ pressed }) => [
                                styles.visitActionButton,
                                {
                                  backgroundColor: colors.danger,
                                  opacity: pressed || isBusy ? 0.7 : 1,
                                },
                              ]}
                            >
                              {isBusy ? (
                                <ActivityIndicator size="small" color="#FFFFFF" />
                              ) : (
                                <Text style={styles.visitActionButtonText}>Departure</Text>
                              )}
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.emptyTimeline}>
                    <Text style={[styles.emptyTimelineText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      No field visits assigned for today.
                    </Text>
                  </View>
                )}
              </View>
            </Animated.View>

            {!isAdminViewer ? (
              <Animated.View
                entering={FadeInDown.duration(350).delay(78)}
                style={[
                  styles.routeHintCard,
                  { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                ]}
              >
                <Ionicons
                  name={activeVisitTaskId ? "pulse-outline" : "checkmark-circle-outline"}
                  size={16}
                  color={activeVisitTaskId ? colors.warning : colors.success}
                />
                <Text
                  style={[
                    styles.routeHintText,
                    { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                  ]}
                >
                  {meetingFocusMode
                    ? "Meeting recording is active. Background map and refresh are paused, and live suggestions are updating below."
                    : activeVisitTaskId
                    ? "Visit active. Tap Meeting Start when meeting begins, then Meeting End, then Departure."
                    : "Tap Arrived, then Meeting Start when the meeting begins, Meeting End, and finally Departure."}
                </Text>
              </Animated.View>
            ) : null}

            {!isAdminViewer ? liveSuggestionsSection : null}

            {salesTrendRecommendationsSection}

            {!isAdminViewer ? (
              <Animated.View
                entering={FadeInDown.duration(380).delay(92)}
                style={[
                  styles.posCard,
                  { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
                ]}
              >
                <LinearGradient
                  colors={[colors.primary, colors.secondary]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.posHero}
                >
                  <View style={styles.posHeroLeft}>
                    <View style={styles.posHeroIconShell}>
                      <Ionicons name="cart-outline" size={18} color="#FFFFFF" />
                    </View>
                    <View style={styles.posHeroTextWrap}>
                      <Text style={styles.posHeroTitle}>Quick Sale</Text>
                      <Text style={styles.posHeroSubtitle}>
                        Create a validated sales order in seconds.
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => void loadPosData()}
                    style={({ pressed }) => [
                      styles.posHeroAction,
                      { opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <Ionicons name="refresh" size={14} color="#FFFFFF" />
                    <Text style={styles.posHeroActionText}>Refresh</Text>
                  </Pressable>
                </LinearGradient>

                <View style={styles.posMetaRow}>
                  <View
                    style={[
                      styles.posMetaPill,
                      { borderColor: colors.borderLight, backgroundColor: colors.surface },
                    ]}
                  >
                    <Text style={[styles.posMetaLabel, { color: colors.textSecondary }]}>Items</Text>
                    <Text style={[styles.posMetaValue, { color: colors.text }]}>{cartItems.length}</Text>
                  </View>
                  <View
                    style={[
                      styles.posMetaPill,
                      styles.posMetaPillWide,
                      { borderColor: colors.borderLight, backgroundColor: colors.surface },
                    ]}
                  >
                    <Text style={[styles.posMetaLabel, { color: colors.textSecondary }]}>Customer</Text>
                    <Text numberOfLines={1} style={[styles.posMetaValue, { color: colors.text }]}
                    >
                      {selectedCustomer ? getDolibarrThirdPartyLabel(selectedCustomer) : "Not selected"}
                    </Text>
                  </View>
                </View>

                {posLoading ? (
                  <View style={styles.posLoadingRow}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[styles.posLoadingText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Syncing products and customers...
                    </Text>
                  </View>
                ) : null}

                {posError ? (
                  <View style={[styles.posStatusBanner, { backgroundColor: colors.danger + "14", borderColor: colors.danger + "40" }]}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                    <Text style={[styles.posStatusText, { color: colors.danger, fontFamily: "Inter_500Medium" }]}>
                      {posError}
                    </Text>
                  </View>
                ) : null}

                {posSuccess ? (
                  <View style={[styles.posStatusBanner, { backgroundColor: colors.success + "12", borderColor: colors.success + "35" }]}>
                    <Ionicons name="checkmark-circle-outline" size={16} color={colors.success} />
                    <Text style={[styles.posStatusText, { color: colors.success, fontFamily: "Inter_500Medium" }]}>
                      {posSuccess}
                    </Text>
                  </View>
                ) : null}

                {linkedPosVisitTask ? (
                  <View style={[styles.posStatusBanner, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "32" }]}>
                    <Ionicons name="location-outline" size={16} color={colors.primary} />
                    <Text style={[styles.posStatusText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                      Quick sale is linked to {getVisitLabel(linkedPosVisitTask)}. Order location will use the arrived visit point.
                    </Text>
                  </View>
                ) : null}

                <View style={[styles.posSection, styles.posSectionCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
                  <View style={styles.posSectionHeader}>
                    <Ionicons name="person-outline" size={16} color={colors.primary} />
                    <Text style={[styles.posSectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      Customer
                    </Text>
                  </View>
                  <TextInput
                    style={[
                      styles.posInput,
                      { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
                    ]}
                    placeholder="Search customer"
                    placeholderTextColor={colors.textTertiary}
                    value={posCustomerQuery}
                    onChangeText={setPosCustomerQuery}
                  />

                  {selectedCustomer ? (
                    <View style={[styles.posSelectedChip, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}>
                      <Ionicons name="person-outline" size={14} color={colors.primary} />
                      <Text style={[styles.posSelectedText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                        {getDolibarrThirdPartyLabel(selectedCustomer)}
                      </Text>
                      {selectedCustomer.email ? (
                        <Text
                          numberOfLines={1}
                          ellipsizeMode="tail"
                          style={[styles.posSelectedSubtext, { color: colors.primary, fontFamily: "Inter_500Medium" }]}
                        >
                          {selectedCustomer.email}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}

                  <View style={styles.posOptionList}>
                    <View style={[styles.posScrollShell, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
                      <ScrollView
                        nestedScrollEnabled
                        contentContainerStyle={styles.posScrollContent}
                        showsVerticalScrollIndicator={false}
                      >
                        {filteredCustomers.length ? (
                          filteredCustomers.map((entry) => {
                            const id = getDolibarrThirdPartyId(entry);
                            const isSelected = id && String(id) === posSelectedCustomerId;
                            return (
                              <Pressable
                                key={`${id ?? getDolibarrThirdPartyLabel(entry)}_customer`}
                                onPress={() => handleSelectCustomer(entry)}
                                style={({ pressed }) => [
                                  styles.posOptionRow,
                                  {
                                    borderColor: isSelected ? colors.primary : colors.borderLight,
                                    backgroundColor: isSelected ? colors.primary + "12" : colors.surface,
                                    opacity: pressed ? 0.8 : 1,
                                  },
                                ]}
                              >
                                <Text style={[styles.posOptionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                                  {getDolibarrThirdPartyLabel(entry)}
                                </Text>
                                {entry.email ? (
                                  <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[styles.posOptionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}
                                  >
                                    {entry.email}
                                  </Text>
                                ) : null}
                              </Pressable>
                            );
                          })
                        ) : (
                          <Text style={[styles.posEmptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                            No customers found.
                          </Text>
                        )}
                      </ScrollView>
                    </View>
                  </View>
                </View>

                <View style={[styles.posSection, styles.posSectionCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
                  <View style={styles.posSectionHeader}>
                    <Ionicons name="pricetag-outline" size={16} color={colors.primary} />
                    <Text style={[styles.posSectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      Products
                    </Text>
                  </View>
                  <TextInput
                    style={[
                      styles.posInput,
                      { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface },
                    ]}
                    placeholder="Search products"
                    placeholderTextColor={colors.textTertiary}
                    value={posProductQuery}
                    onChangeText={setPosProductQuery}
                  />

                  <View style={styles.posOptionList}>
                    <View style={[styles.posScrollShell, { borderColor: colors.borderLight, backgroundColor: colors.surface }]}>
                      <ScrollView
                        nestedScrollEnabled
                        contentContainerStyle={styles.posScrollContent}
                        showsVerticalScrollIndicator={false}
                      >
                        {filteredProducts.length ? (
                          filteredProducts.map((product) => {
                            const id = getDolibarrProductId(product);
                            const price = getDolibarrProductPrice(product);
                            return (
                              <View
                                key={`${id ?? getDolibarrProductLabel(product)}_product`}
                                style={[
                                  styles.posProductRow,
                                  { borderColor: colors.borderLight, backgroundColor: colors.surface },
                                ]}
                              >
                                <View style={styles.posProductInfo}>
                                  <Text style={[styles.posOptionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                                    {getDolibarrProductLabel(product)}
                                  </Text>
                                  <Text style={[styles.posOptionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                                    {product.ref ? `Ref: ${product.ref}` : "Standard item"} • {formatPrice(price)}
                                  </Text>
                                </View>
                                <Pressable
                                  onPress={() => handleAddProductToCart(product)}
                                  style={({ pressed }) => [
                                    styles.posAddButton,
                                    { backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 },
                                  ]}
                                >
                                  <Ionicons name="add" size={16} color="#FFFFFF" />
                                  <Text style={styles.posAddButtonText}>Add</Text>
                                </Pressable>
                              </View>
                            );
                          })
                        ) : (
                          <Text style={[styles.posEmptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                            No products found.
                          </Text>
                        )}
                      </ScrollView>
                    </View>
                    {posProductsHasMore ? (
                      <Pressable
                        onPress={() => void handleLoadMoreProducts()}
                        disabled={posProductsLoadingMore}
                        style={({ pressed }) => [
                          styles.posLoadMoreButton,
                          {
                            borderColor: colors.border,
                            backgroundColor: colors.surface,
                            opacity: pressed || posProductsLoadingMore ? 0.7 : 1,
                          },
                        ]}
                      >
                        {posProductsLoadingMore ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <>
                            <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
                            <Text style={[styles.posLoadMoreText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                              Load more products
                            </Text>
                          </>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                </View>

                <View style={[styles.posSection, styles.posSectionCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
                  <View style={styles.posSectionHeader}>
                    <Ionicons name="basket-outline" size={16} color={colors.primary} />
                    <Text style={[styles.posSectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                      Cart
                    </Text>
                  </View>
                  {cartItems.length ? (
                    <View style={styles.posCartList}>
                      {cartItems.map((entry) => {
                        const id = getDolibarrProductId(entry.product);
                        if (!id) return null;
                        const price = getDolibarrProductPrice(entry.product);
                        return (
                          <View key={`cart_${id}`} style={[styles.posCartRow, { borderColor: colors.borderLight }]}>
                            <View style={styles.posCartInfo}>
                              <Text style={[styles.posOptionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                                {getDolibarrProductLabel(entry.product)}
                              </Text>
                              <Text style={[styles.posOptionSubtitle, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                                {formatPrice(price)} • Qty {entry.qty}
                              </Text>
                            </View>
                            <View style={styles.posDiscountBlock}>
                              <Text style={[styles.posDiscountLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                                Discount %
                              </Text>
                              <TextInput
                                keyboardType="numeric"
                                value={String(entry.discountPercent || 0)}
                                onChangeText={(value) => {
                                  const parsed = Number(value.replace(/[^0-9.]/g, ""));
                                  handleSetCartDiscount(id, Number.isFinite(parsed) ? parsed : 0);
                                }}
                                style={[
                                  styles.posDiscountInput,
                                  { borderColor: colors.border, color: colors.text, backgroundColor: colors.surface },
                                ]}
                              />
                            </View>
                            <View style={styles.posQtyControls}>
                              <Pressable
                                onPress={() => handleSetCartQty(id, entry.qty - 1)}
                                style={({ pressed }) => [
                                  styles.posQtyButton,
                                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                                ]}
                              >
                                <Ionicons name="remove" size={14} color={colors.textSecondary} />
                              </Pressable>
                              <TextInput
                                keyboardType="number-pad"
                                value={posQtyDrafts[String(id)] ?? String(entry.qty)}
                                onChangeText={(value) => handleQtyDraftChange(id, value)}
                                onFocus={handleQtyInputFocus}
                                onBlur={() => handleQtyDraftCommit(id)}
                                onSubmitEditing={() => handleQtyDraftCommit(id)}
                                returnKeyType="done"
                                selectTextOnFocus
                                style={[
                                  styles.posQtyInput,
                                  {
                                    borderColor: colors.border,
                                    color: colors.text,
                                    backgroundColor: colors.surface,
                                  },
                                ]}
                              />
                              <Pressable
                                onPress={() => handleSetCartQty(id, entry.qty + 1)}
                                style={({ pressed }) => [
                                  styles.posQtyButton,
                                  { borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
                                ]}
                              >
                                <Ionicons name="add" size={14} color={colors.textSecondary} />
                              </Pressable>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ) : (
                    <Text style={[styles.posEmptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      Add products to create an order.
                    </Text>
                  )}
                </View>

                <View style={styles.posFooterRow}>
                  <View>
                    <Text style={[styles.posTotalLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                      Order Total
                    </Text>
                    <Text style={[styles.posTotalValue, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
                      {formatPrice(cartTotal)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void handleCreateSalesOrder()}
                    disabled={posSubmitting || !cartItems.length || !selectedCustomer}
                    style={({ pressed }) => [
                      styles.posCheckoutButton,
                      {
                        backgroundColor: colors.success,
                        opacity: pressed || posSubmitting || !cartItems.length || !selectedCustomer ? 0.6 : 1,
                      },
                    ]}
                  >
                    {posSubmitting ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <>
                        <Ionicons name="checkmark-circle-outline" size={16} color="#FFFFFF" />
                        <Text style={styles.posCheckoutText}>Create Order</Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </Animated.View>
            ) : null}

            {isAdminViewer ? (
              <>
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

              {liveSuggestionsSection}

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
                    <Text style={styles.aiMetricValue}>{visibleConversations.length}</Text>
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
              </>
            ) : null}

            {isAdminViewer ? (
              <View style={styles.sectionHeaderRow}>
                <Text
                  style={[
                    styles.sectionTitle,
                    styles.sectionTitleFlexible,
                    { color: colors.text, fontFamily: "Inter_600SemiBold" },
                  ]}
                >
                  {selectedSalesperson
                    ? `Recent Conversations - ${selectedSalesperson.name}`
                    : "Recent Conversations"}
                </Text>
                <Pressable
                  onPress={() => void loadConversations({ preserveExistingOnEmpty: false, showBusy: true })}
                  disabled={isConversationReloading}
                  style={({ pressed }) => [
                    styles.reviewNotesButton,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      opacity: isConversationReloading ? 0.65 : pressed ? 0.82 : 1,
                    },
                  ]}
                >
                  {isConversationReloading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Ionicons name="refresh-outline" size={14} color={colors.primary} />
                  )}
                  <Text
                    style={[
                      styles.reviewNotesButtonText,
                      { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                    ]}
                  >
                    {isConversationReloading ? "Reloading" : "Reload"}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => <ConversationCard conversation={item} colors={colors} />}
        ListEmptyComponent={
          isAdminViewer ? (
            <View
              style={[styles.emptyState, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}
            >
              <Ionicons name="chatbubbles-outline" size={40} color={colors.textTertiary} />
              <Text style={[styles.emptyText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                No conversations analyzed yet
              </Text>
            </View>
          ) : null
        }
      />
      <Modal
        visible={meetingRecommendationVisible}
        transparent
        animationType="fade"
        onRequestClose={closeMeetingRecommendationModal}
      >
        <View style={styles.departureNotesOverlay}>
          <View
            style={[
              styles.meetingRecommendationCard,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.meetingRecommendationEyebrow,
                { color: colors.primary, fontFamily: "Inter_700Bold" },
              ]}
            >
              Meeting End Analysis
            </Text>
            <Text
              style={[
                styles.meetingRecommendationTitle,
                { color: colors.text, fontFamily: "Inter_700Bold" },
              ]}
            >
              Recommended Products by Conversation Specs
            </Text>
            <Text
              style={[
                styles.meetingRecommendationMeta,
                { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" },
              ]}
            >
              {meetingRecommendationConversation?.customerName?.trim() || "Customer"}
            </Text>
            <Text
              style={[
                styles.meetingRecommendationHint,
                { color: colors.textTertiary, fontFamily: "Inter_400Regular" },
              ]}
            >
              These products were suggested based on the specs and phrases the customer mentioned during the meeting.
            </Text>
            <ScrollView
              style={styles.meetingRecommendationList}
              contentContainerStyle={styles.meetingRecommendationListContent}
              showsVerticalScrollIndicator={false}
            >
              {meetingRecommendationItems.length ? (
                meetingRecommendationItems.map((item, index) => (
                  <View
                    key={`${item.id}_${index}`}
                    style={[
                      styles.meetingRecommendationRow,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.borderLight,
                      },
                    ]}
                  >
                    <View style={styles.meetingRecommendationRowHeader}>
                      <View style={[styles.meetingRecommendationIcon, { backgroundColor: colors.primary + "12" }]}>
                        <Ionicons name="cube-outline" size={18} color={colors.primary} />
                      </View>
                      <View style={styles.meetingRecommendationRowText}>
                        <View style={styles.meetingRecommendationRowTitleWrap}>
                          <Text
                            style={[
                              styles.meetingRecommendationRowTitle,
                              { color: colors.text, fontFamily: "Inter_700Bold" },
                            ]}
                          >
                            {item.label}
                          </Text>
                          {item.ref ? (
                            <View
                              style={[
                                styles.meetingRecommendationRefChip,
                                { backgroundColor: colors.secondary + "16" },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.meetingRecommendationRefText,
                                  { color: colors.secondary, fontFamily: "Inter_700Bold" },
                                ]}
                              >
                                {item.ref}
                              </Text>
                            </View>
                          ) : null}
                        </View>
                        <Text
                          style={[
                            styles.meetingRecommendationReason,
                            { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                          ]}
                        >
                          {item.reason}
                        </Text>
                        <View style={styles.meetingRecommendationChipWrap}>
                          {item.matchedSpecifications.map((entry) => (
                            <View
                              key={`${item.id}_spec_${entry}`}
                              style={[
                                styles.meetingRecommendationChip,
                                { backgroundColor: colors.primary + "10" },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.meetingRecommendationChipText,
                                  { color: colors.primary, fontFamily: "Inter_600SemiBold" },
                                ]}
                              >
                                Spec: {entry}
                              </Text>
                            </View>
                          ))}
                          {item.matchedKeyPhrases.map((entry) => (
                            <View
                              key={`${item.id}_phrase_${entry}`}
                              style={[
                                styles.meetingRecommendationChip,
                                { backgroundColor: colors.secondary + "12" },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.meetingRecommendationChipText,
                                  { color: colors.secondary, fontFamily: "Inter_600SemiBold" },
                                ]}
                              >
                                Phrase: {entry}
                              </Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    </View>
                  </View>
                ))
              ) : (
                <View
                  style={[
                    styles.meetingRecommendationEmpty,
                    { backgroundColor: colors.surface, borderColor: colors.borderLight },
                  ]}
                >
                  <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
                  <Text
                    style={[
                      styles.meetingRecommendationEmptyText,
                      { color: colors.textSecondary, fontFamily: "Inter_500Medium" },
                    ]}
                  >
                    No clear product-spec match was found for this meeting. You can continue the pitch manually from POS after notes and departure.
                  </Text>
                </View>
              )}
            </ScrollView>
            <View style={styles.meetingRecommendationFooter}>
              <Pressable
                onPress={closeMeetingRecommendationModal}
                style={({ pressed }) => [
                  styles.meetingRecommendationButton,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.82 : 1 },
                ]}
              >
                <Ionicons name="checkmark-circle-outline" size={16} color="#FFFFFF" />
                <Text style={styles.meetingRecommendationButtonText}>Continue</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        visible={departureNotesModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeDepartureNotesModal}
      >
        <View style={styles.departureNotesOverlay}>
          <View
            style={[
              styles.departureNotesCard,
              { backgroundColor: colors.backgroundElevated, borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.departureNotesTitle,
                { color: colors.text, fontFamily: "Inter_700Bold" },
              ]}
            >
              Departure Notes
            </Text>
            <Text
              style={[
                styles.departureNotesMeta,
                { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" },
              ]}
            >
              {departureNotesTask ? getVisitLabel(departureNotesTask) : "Visit"}
            </Text>
            <Text
              style={[
                styles.departureNotesHint,
                { color: colors.textTertiary, fontFamily: "Inter_400Regular" },
              ]}
            >
              Add any dates, remarks, commitments, or follow-up details. This note stays attached to the visit for later review.
            </Text>
            <TextInput
              multiline
              maxLength={600}
              value={departureNotesDraft}
              onChangeText={setDepartureNotesDraft}
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              placeholder="Example: Follow up on 15 Apr. Client asked for revised pricing and product brochure."
              placeholderTextColor={colors.textTertiary}
              textAlignVertical="top"
              style={[
                styles.departureNotesInput,
                {
                  color: colors.text,
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  fontFamily: "Inter_500Medium",
                },
              ]}
            />
            <View
              style={[
                styles.departureCustomerPanel,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <Pressable
                onPress={() => setDepartureCreateCustomerEnabled((current) => !current)}
                style={({ pressed }) => [
                  styles.departureCustomerToggleRow,
                  { opacity: pressed ? 0.82 : 1 },
                ]}
              >
                <View style={styles.departureCustomerToggleTextWrap}>
                  <Text
                    style={[
                      styles.departureCustomerToggleTitle,
                      { color: colors.text, fontFamily: "Inter_600SemiBold" },
                    ]}
                  >
                    Create customer after departure
                  </Text>
                  <Text
                    style={[
                      styles.departureCustomerToggleHint,
                      { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                    ]}
                  >
                    If the buyer agreed, create the customer now and keep Sales POS ready with the same customer.
                  </Text>
                </View>
                <View
                  style={[
                    styles.departureCustomerCheck,
                    {
                      borderColor: departureCreateCustomerEnabled ? colors.success : colors.border,
                      backgroundColor: departureCreateCustomerEnabled ? colors.success : colors.surface,
                    },
                  ]}
                >
                  {departureCreateCustomerEnabled ? (
                    <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                  ) : null}
                </View>
              </Pressable>
              {departureCreateCustomerEnabled ? (
                <View style={styles.departureCustomerFields}>
                  <TextInput
                    value={departureCustomerName}
                    onChangeText={setDepartureCustomerName}
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="organizationName"
                    importantForAutofill="no"
                    placeholder="Customer name"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.departureCustomerInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.backgroundElevated,
                        borderColor: colors.border,
                      },
                    ]}
                  />
                  <TextInput
                    value={departureCustomerEmail}
                    onChangeText={setDepartureCustomerEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    importantForAutofill="no"
                    placeholder="Email (optional)"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.departureCustomerInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.backgroundElevated,
                        borderColor: colors.border,
                      },
                    ]}
                  />
                  <TextInput
                    value={departureCustomerPhone}
                    onChangeText={setDepartureCustomerPhone}
                    keyboardType="phone-pad"
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="none"
                    importantForAutofill="no"
                    placeholder="Phone (optional)"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.departureCustomerInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.backgroundElevated,
                        borderColor: colors.border,
                      },
                    ]}
                  />
                  <TextInput
                    value={departureCustomerAddress}
                    onChangeText={setDepartureCustomerAddress}
                    autoCorrect={false}
                    autoComplete="off"
                    textContentType="fullStreetAddress"
                    importantForAutofill="no"
                    placeholder="Address (optional)"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.departureCustomerInput,
                      {
                        color: colors.text,
                        backgroundColor: colors.backgroundElevated,
                        borderColor: colors.border,
                      },
                    ]}
                  />
                </View>
              ) : null}
            </View>
            <View style={styles.departureNotesFooter}>
              <Text
                style={[
                  styles.departureNotesCount,
                  { color: colors.textTertiary, fontFamily: "Inter_500Medium" },
                ]}
              >
                {departureNotesDraft.trim()
                  ? `${departureNotesDraft.trim().length}/600`
                  : "Optional note"}
              </Text>
              <View style={styles.departureNotesActions}>
                <Pressable
                  onPress={closeDepartureNotesModal}
                  disabled={Boolean(visitActionTaskId)}
                  style={({ pressed }) => [
                    styles.departureNotesSecondaryButton,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                      opacity: pressed || visitActionTaskId ? 0.68 : 1,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.departureNotesSecondaryButtonText,
                      { color: colors.textSecondary, fontFamily: "Inter_600SemiBold" },
                    ]}
                  >
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void confirmVisitDepartureWithNotes()}
                  disabled={Boolean(visitActionTaskId)}
                  style={({ pressed }) => [
                    styles.departureNotesPrimaryButton,
                    {
                      backgroundColor: colors.danger,
                      opacity: pressed || visitActionTaskId ? 0.72 : 1,
                    },
                  ]}
                >
                  {visitActionTaskId === departureNotesTask?.id ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle-outline" size={16} color="#FFFFFF" />
                      <Text style={styles.departureNotesPrimaryButtonText}>Save & Depart</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>
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
  routeCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    gap: 10,
    marginBottom: 14,
  },
  routeHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  routeHeaderTitle: {
    fontSize: 15,
  },
  routeHeaderSubtitle: {
    fontSize: 11,
  },
  salespersonChipRow: {
    gap: 8,
    paddingBottom: 2,
  },
  salespersonChip: {
    borderWidth: 1,
    borderRadius: 999,
    minHeight: 34,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
  },
  salespersonChipText: {
    fontSize: 12,
  },
  routePlannerCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 10,
    gap: 8,
  },
  routePlannerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  routePlannerTitle: {
    fontSize: 13.5,
  },
  routePlannerSubtitle: {
    fontSize: 11.5,
  },
  routePlannerInput: {
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 12.5,
  },
  routeModeToggleWrap: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: 1,
    padding: 4,
    gap: 6,
  },
  routeModeToggleBtn: {
    flex: 1,
    minHeight: 34,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  routeModeToggleText: {
    fontSize: 12,
  },
  routeSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  routeSearchInput: {
    flex: 1,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 12.5,
  },
  routeSearchButton: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  routeSearchResultWrap: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  routeSearchResultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  routeSearchResultTextWrap: {
    flex: 1,
    gap: 2,
  },
  routeSearchResultTitle: {
    fontSize: 12.5,
  },
  routeSearchResultMeta: {
    fontSize: 11.5,
    lineHeight: 15,
  },
  routeCustomerEmptyState: {
    minHeight: 70,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    gap: 8,
  },
  routeCustomerEmptyText: {
    fontSize: 11.8,
    lineHeight: 16,
    textAlign: "center",
  },
  routeDraftWrap: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  routeDraftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  routeDraftSequence: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  routeDraftSequenceText: {
    fontSize: 11.5,
  },
  routeDraftTextWrap: {
    flex: 1,
    gap: 2,
  },
  routeDraftTitle: {
    fontSize: 12.5,
  },
  routeDraftSource: {
    fontSize: 10.5,
  },
  routeDraftMeta: {
    fontSize: 11.5,
    lineHeight: 15,
  },
  routeDraftActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  routeDraftIconBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  routeDraftEmpty: {
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  routeDraftEmptyText: {
    fontSize: 12,
    textAlign: "center",
  },
  routeAssignButton: {
    minHeight: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  routeAssignButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  routePreviewCard: {
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 58,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  routeMapShell: {
    position: "relative",
    overflow: "hidden",
    borderRadius: 20,
  },
  routeMapOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
  },
  routeMapOverlayCard: {
    width: "100%",
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  routeMapOverlayTitle: {
    fontSize: 17,
    textAlign: "center",
  },
  routeMapOverlayText: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  routePreviewIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  routePreviewTextWrap: {
    flex: 1,
    gap: 2,
  },
  routePreviewTitle: {
    fontSize: 12.5,
  },
  routePreviewMeta: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  salesHeroCard: {
    borderRadius: 20,
    padding: 18,
    gap: 8,
    marginBottom: 14,
  },
  salesHeroTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  salesHeroEyebrow: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  salesHeroDate: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  salesHeroTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
  },
  salesHeroMeta: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  salesHeroStatsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 6,
  },
  salesHeroStat: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  salesHeroStatValue: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
  },
  salesHeroStatLabel: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  salesHeroStatDivider: {
    width: 1,
    height: 28,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  salesHeroFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
  },
  salesHeroBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  salesHeroBadgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  salesHeroStatus: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  reviewNotesButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reviewNotesButtonText: {
    fontSize: 12.5,
  },
  salesMapCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    gap: 8,
    marginBottom: 12,
  },
  salesMapHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  salesMapTitle: {
    fontSize: 14,
  },
  salesMapMeta: {
    fontSize: 11,
  },
  salesInfoCard: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
  },
  salesInfoIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  salesInfoText: {
    flex: 1,
    gap: 2,
  },
  salesInfoTitle: {
    fontSize: 12.5,
  },
  salesInfoMeta: {
    fontSize: 11.5,
    lineHeight: 16,
  },
  meetingFocusCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    marginBottom: 12,
  },
  meetingFocusHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  meetingFocusIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  meetingFocusTitle: {
    fontSize: 14.5,
  },
  meetingFocusMeta: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  meetingFocusStatRow: {
    flexDirection: "row",
    gap: 10,
  },
  meetingFocusStat: {
    flex: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  meetingFocusStatLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  meetingFocusStatValue: {
    fontSize: 12.5,
    fontFamily: "Inter_700Bold",
  },
  summaryRow: {
    flexDirection: "row",
    gap: 10,
  },
  summaryCard: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: "center",
    gap: 2,
  },
  summaryValue: {
    fontSize: 14,
  },
  summaryLabel: {
    fontSize: 11,
  },
  currentLocationCard: {
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 58,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  currentLocationIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  currentLocationTitle: {
    fontSize: 12.5,
  },
  currentLocationMeta: {
    marginTop: 2,
    fontSize: 11.5,
    lineHeight: 16,
  },
  timelineCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 14,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  visitRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 12,
    gap: 10,
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTextWrap: {
    flex: 1,
    gap: 2,
  },
  visitTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowTime: {
    fontSize: 12.5,
  },
  rowText: {
    fontSize: 12,
    lineHeight: 17,
  },
  visitNotesPreview: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  visitNotesPreviewText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
  },
  emptyTimeline: {
    minHeight: 86,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  emptyTimelineText: {
    fontSize: 12.5,
    textAlign: "center",
  },
  visitActionButton: {
    marginTop: 6,
    minHeight: 34,
    minWidth: 96,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  visitActionButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  visitDeleteButton: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  departureNotesOverlay: {
    flex: 1,
    backgroundColor: "rgba(7, 16, 30, 0.48)",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  departureNotesCard: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    gap: 10,
  },
  departureNotesTitle: {
    fontSize: 20,
    letterSpacing: -0.4,
  },
  departureNotesMeta: {
    fontSize: 13,
  },
  departureNotesHint: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  departureNotesInput: {
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
    textAlignVertical: "top",
  },
  departureCustomerPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  departureCustomerToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  departureCustomerToggleTextWrap: {
    flex: 1,
    gap: 4,
  },
  departureCustomerToggleTitle: {
    fontSize: 13.5,
  },
  departureCustomerToggleHint: {
    fontSize: 12,
    lineHeight: 18,
  },
  departureCustomerCheck: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  departureCustomerFields: {
    gap: 10,
  },
  departureCustomerInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 13,
  },
  departureNotesFooter: {
    gap: 12,
  },
  departureNotesCount: {
    fontSize: 11.5,
  },
  departureNotesActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
  },
  departureNotesSecondaryButton: {
    minHeight: 42,
    minWidth: 90,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  departureNotesSecondaryButtonText: {
    fontSize: 13,
  },
  departureNotesPrimaryButton: {
    minHeight: 42,
    minWidth: 132,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  departureNotesPrimaryButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  meetingRecommendationCard: {
    borderWidth: 1,
    borderRadius: 22,
    padding: 18,
    gap: 10,
    maxHeight: "82%",
  },
  meetingRecommendationEyebrow: {
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  meetingRecommendationTitle: {
    fontSize: 20,
    letterSpacing: -0.4,
  },
  meetingRecommendationMeta: {
    fontSize: 13,
  },
  meetingRecommendationHint: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  meetingRecommendationList: {
    maxHeight: 420,
  },
  meetingRecommendationListContent: {
    gap: 12,
    paddingVertical: 6,
  },
  meetingRecommendationRow: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
  },
  meetingRecommendationRowHeader: {
    flexDirection: "row",
    gap: 12,
  },
  meetingRecommendationIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  meetingRecommendationRowText: {
    flex: 1,
    gap: 8,
  },
  meetingRecommendationRowTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  meetingRecommendationRowTitle: {
    flexShrink: 1,
    fontSize: 18,
    lineHeight: 24,
  },
  meetingRecommendationRefChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  meetingRecommendationRefText: {
    fontSize: 11,
  },
  meetingRecommendationReason: {
    fontSize: 13.5,
    lineHeight: 20,
  },
  meetingRecommendationChipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  meetingRecommendationChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
  },
  meetingRecommendationChipText: {
    fontSize: 11.5,
  },
  meetingRecommendationEmpty: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-start",
  },
  meetingRecommendationEmptyText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 20,
  },
  meetingRecommendationFooter: {
    paddingTop: 6,
    alignItems: "flex-end",
  },
  meetingRecommendationButton: {
    minHeight: 42,
    minWidth: 118,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  meetingRecommendationButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  liveSuggestionCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    marginBottom: 18,
  },
  liveSuggestionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "flex-start",
  },
  liveSuggestionTitleWrap: {
    flex: 1,
    flexDirection: "row",
    gap: 10,
  },
  liveSuggestionIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  liveSuggestionTitle: {
    fontSize: 16,
  },
  liveSuggestionMeta: {
    marginTop: 4,
    fontSize: 12.5,
    lineHeight: 18,
  },
  liveSuggestionStatusChip: {
    minHeight: 30,
    borderRadius: 999,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  liveSuggestionStatusText: {
    fontSize: 11.5,
    letterSpacing: 0.2,
  },
  liveSuggestionHint: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  liveSuggestionPhraseWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  liveSuggestionPhraseChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
  },
  liveSuggestionPhraseText: {
    fontSize: 11.5,
  },
  liveSuggestionList: {
    gap: 10,
  },
  liveSuggestionRow: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    flexDirection: "row",
    gap: 10,
  },
  liveSuggestionProductIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  liveSuggestionTextWrap: {
    flex: 1,
    gap: 7,
  },
  liveSuggestionRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  liveSuggestionRowTitle: {
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  liveSuggestionRefChip: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
  },
  liveSuggestionRefText: {
    fontSize: 10.5,
  },
  liveSuggestionReason: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  liveSuggestionMatchWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  liveSuggestionMatchChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  liveSuggestionMatchText: {
    fontSize: 11,
  },
  liveSuggestionEmpty: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  liveSuggestionEmptyText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
  },
  routeHintCard: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  routeHintText: {
    flex: 1,
    fontSize: 12,
  },
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
  recommendationCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    gap: 14,
  },
  recommendationCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  recommendationCardIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  recommendationCardTitle: {
    fontSize: 16,
    letterSpacing: -0.2,
  },
  recommendationCardSubtitle: {
    marginTop: 2,
    fontSize: 12.5,
    lineHeight: 18,
  },
  recommendationTrendRow: {
    gap: 8,
  },
  recommendationTrendChip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 3,
  },
  recommendationTrendName: {
    fontSize: 13,
  },
  recommendationTrendMeta: {
    fontSize: 11.5,
  },
  recommendationList: {
    gap: 10,
  },
  recommendationItem: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  recommendationItemIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  recommendationItemTitle: {
    fontSize: 13.5,
    marginBottom: 4,
  },
  recommendationItemBody: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  sectionHeader: { marginBottom: 12 },
  sectionTitleFlexible: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  sectionMetaText: {
    marginTop: 4,
    fontSize: 12.5,
    lineHeight: 18,
  },
  sectionTitle: { fontSize: 18, letterSpacing: -0.3 },
  trendRecommendationsCard: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 18,
  },
  trendRecommendationsLoading: {
    minHeight: 92,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  trendRecommendationsLoadingText: {
    fontSize: 12.5,
  },
  trendRecommendationsEmpty: {
    minHeight: 88,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  trendRecommendationsEmptyText: {
    fontSize: 12.5,
    textAlign: "center",
  },
  trendRecommendationRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  trendRecommendationIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  trendRecommendationTextWrap: {
    flex: 1,
    gap: 6,
  },
  trendRecommendationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  trendRecommendationTitle: {
    flex: 1,
    fontSize: 14,
  },
  trendRecommendationRef: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  trendRecommendationRefText: {
    fontSize: 10.5,
    letterSpacing: 0.3,
  },
  trendRecommendationReason: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  trendTagChip: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  trendTagChipText: {
    fontSize: 11.5,
  },
  trendRecommendationMetrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  trendMetricChip: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  trendMetricChipText: {
    fontSize: 11.5,
  },
  trendRecommendationSubnote: {
    fontSize: 11.5,
    lineHeight: 16,
  },
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
  notePreviewCard: {
    minHeight: 36,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  notePreviewText: {
    flex: 1,
    fontSize: 11.5,
    lineHeight: 16,
  },
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
  posCard: {
    borderRadius: 22,
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
    gap: 14,
    shadowColor: "#0B1E3A",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  posHero: {
    borderRadius: 18,
    padding: 14,
    gap: 10,
  },
  posHeroLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  posHeroIconShell: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  posHeroTextWrap: {
    flex: 1,
    gap: 2,
  },
  posHeroTitle: {
    fontSize: 16,
    color: "#FFFFFF",
    fontFamily: "Inter_700Bold",
  },
  posHeroSubtitle: {
    fontSize: 12,
    color: "rgba(255,255,255,0.82)",
    fontFamily: "Inter_400Regular",
  },
  posHeroAction: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  posHeroActionText: {
    fontSize: 11,
    color: "#FFFFFF",
    fontFamily: "Inter_600SemiBold",
  },
  posMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  posMetaPill: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  posMetaPillWide: {
    flex: 1,
  },
  posMetaLabel: {
    fontSize: 10,
    color: "#7C879B",
    fontFamily: "Inter_500Medium",
  },
  posMetaValue: {
    fontSize: 12,
    color: "#101828",
    fontFamily: "Inter_700Bold",
  },
  posLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  posLoadingText: { fontSize: 12 },
  posStatusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  posStatusText: { fontSize: 12, flex: 1 },
  posSection: {
    gap: 8,
  },
  posSectionCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
  },
  posSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  posSectionTitle: { fontSize: 15 },
  posInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
  },
  posSelectedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  posSelectedText: { fontSize: 12, flexShrink: 1 },
  posSelectedSubtext: { fontSize: 11, flexShrink: 1 },
  posOptionList: {
    gap: 8,
  },
  posScrollShell: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 8,
    maxHeight: 220,
  },
  posScrollContent: {
    gap: 8,
  },
  posOptionRow: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  posOptionTitle: { fontSize: 13 },
  posOptionSubtitle: { fontSize: 11, flexShrink: 1 },
  posEmptyText: { fontSize: 12 },
  posProductRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  posProductInfo: { flex: 1, gap: 2 },
  posAddButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  posAddButtonText: {
    fontSize: 12,
    color: "#FFFFFF",
    fontFamily: "Inter_600SemiBold",
  },
  posLoadMoreButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  posLoadMoreText: { fontSize: 12 },
  posCartList: {
    gap: 8,
  },
  posCartRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  posCartInfo: { flex: 1, gap: 2 },
  posDiscountBlock: {
    alignItems: "flex-start",
    gap: 4,
  },
  posDiscountLabel: { fontSize: 10 },
  posDiscountInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 12,
    minWidth: 64,
    textAlign: "center",
  },
  posQtyControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  posQtyButton: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 6,
  },
  posQtyInput: {
    borderWidth: 1,
    borderRadius: 8,
    minWidth: 52,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
    textAlign: "center",
  },
  posFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 6,
    gap: 12,
  },
  posTotalLabel: { fontSize: 12 },
  posTotalValue: { fontSize: 18 },
  posCheckoutButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  posCheckoutText: {
    fontSize: 12,
    color: "#FFFFFF",
    fontFamily: "Inter_600SemiBold",
  },
});
