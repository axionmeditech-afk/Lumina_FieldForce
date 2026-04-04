import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
} from "react-native";
import { Audio, type AVPlaybackStatus } from "expo-av";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import Animated, { FadeInDown } from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import {
  addAuditLog,
  getConversations,
  getSettings,
  updateConversation,
} from "@/lib/storage";
import type { Conversation } from "@/lib/types";
import { useAppTheme } from "@/contexts/ThemeContext";
import { AppCanvas } from "@/components/AppCanvas";
import { useAuth } from "@/contexts/AuthContext";
import {
  getApiBaseUrlCandidates,
  getDolibarrProducts,
  type DolibarrProduct,
} from "@/lib/attendance-api";
import {
  analyzeConversationWithAI,
  type AISalesAnalysisResult,
} from "@/lib/aiSalesAnalysis";
import { buildConversationFromTranscript } from "@/lib/sales-analysis";

function normalizeConversationNotes(value: string | undefined | null): string {
  if (!value) return "";
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function ScoreGauge({
  label,
  score,
  colors,
  delay,
}: {
  label: string;
  score: number;
  colors: typeof Colors.light;
  delay: number;
}) {
  const color = score >= 80 ? colors.success : score >= 60 ? colors.warning : colors.danger;
  const width = `${Math.min(score, 100)}%` as any;

  return (
    <Animated.View entering={FadeInDown.duration(400).delay(delay)} style={styles.gaugeItem}>
      <View style={styles.gaugeHeader}>
        <Text style={[styles.gaugeLabel, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>{label}</Text>
        <Text style={[styles.gaugeValue, { color, fontFamily: "Inter_700Bold" }]}>{score}%</Text>
      </View>
      <View style={[styles.gaugeTrack, { backgroundColor: colors.surfaceSecondary }]}>
        <View style={[styles.gaugeFill, { width, backgroundColor: color }]} />
      </View>
    </Animated.View>
  );
}

function parseDurationToMs(duration: string | undefined): number {
  if (!duration || typeof duration !== "string") return 0;
  const cleaned = duration.trim();
  const parts = cleaned.split(":").map((part) => Number(part));
  if (parts.length !== 2 || parts.some((value) => Number.isNaN(value) || value < 0)) {
    return 0;
  }
  return Math.round((parts[0] * 60 + parts[1]) * 1000);
}

function normalizeApiSecret(value: string | undefined | null): string {
  if (!value) return "";
  return value.trim().replace(/^['"]+|['"]+$/g, "");
}

type ConversationProductRecommendation = {
  id: string;
  label: string;
  ref: string | null;
  matchedAttributes: string[];
  matchedKeyPhrases: string[];
  reason: string;
};

const PRODUCT_RECOMMENDATION_STOP_WORDS = new Set([
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
  "follow",
  "follow up",
  "details",
  "need",
  "needs",
  "requirement",
  "requirements",
]);

function normalizeMatcherText(value: string | undefined | null): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (segment) => segment.toUpperCase());
}

function buildConversationAttributeCandidates(
  convo: Conversation
): Array<{ phrase: string; source: "key_phrase" | "objection" | "summary" }> {
  const summaryBits = convo.summary
    .split(/[.!?]/)
    .map((entry) => normalizeMatcherText(entry))
    .filter(Boolean);

  const tagged = [
    ...convo.keyPhrases.map((entry) => ({
      phrase: normalizeMatcherText(entry),
      source: "key_phrase" as const,
    })),
    ...convo.objections.map((entry) => ({
      phrase: normalizeMatcherText(entry),
      source: "objection" as const,
    })),
    ...summaryBits.map((entry) => ({
      phrase: entry,
      source: "summary" as const,
    })),
  ].filter(
    (entry) =>
      entry.phrase.length >= 4 &&
      entry.phrase.length <= 48 &&
      !PRODUCT_RECOMMENDATION_STOP_WORDS.has(entry.phrase) &&
      !/^\d+$/.test(entry.phrase)
  );

  const seen = new Set<string>();
  const unique: Array<{ phrase: string; source: "key_phrase" | "objection" | "summary" }> = [];
  for (const entry of tagged) {
    if (seen.has(entry.phrase)) continue;
    seen.add(entry.phrase);
    unique.push(entry);
    if (unique.length >= 12) break;
  }
  return unique;
}

function buildProductRecommendations(
  convo: Conversation,
  products: DolibarrProduct[]
): ConversationProductRecommendation[] {
  const attributeCandidates = buildConversationAttributeCandidates(convo);
  if (!attributeCandidates.length || !products.length) return [];

  const recommendations = products
    .map((product) => {
      const label = (product.label || product.ref || "Product").trim();
      const ref = (product.ref || "").trim() || null;
      const searchable = normalizeMatcherText(
        [product.label, product.ref, product.description].filter(Boolean).join(" ")
      );
      if (!searchable) return null;

      const matchedCandidates = attributeCandidates.filter((candidate) => {
        if (candidate.phrase.includes(" ")) {
          return searchable.includes(candidate.phrase);
        }
        return ` ${searchable} `.includes(` ${candidate.phrase} `);
      });
      if (!matchedCandidates.length) return null;

      const highIntentBoost = convo.buyingIntent === "high" ? 2 : convo.buyingIntent === "medium" ? 1 : 0;
      const keyPhraseMatches = matchedCandidates.filter((entry) => entry.source === "key_phrase");
      const matchedAttributes = matchedCandidates.slice(0, 4).map((entry) => toTitleCase(entry.phrase));
      const matchedKeyPhrases = keyPhraseMatches.slice(0, 3).map((entry) => toTitleCase(entry.phrase));
      const leadAttribute = matchedAttributes[0];
      const score =
        matchedCandidates.length * 3 +
        keyPhraseMatches.length * 2 +
        highIntentBoost;
      return {
        id: String(product.id ?? `${label}_${ref || "product"}`),
        label,
        ref,
        matchedAttributes,
        matchedKeyPhrases,
        reason:
          matchedKeyPhrases.length > 0
            ? `${label} is a strong fit because the customer mentioned ${matchedKeyPhrases
                .slice(0, 2)
                .join(" and ")} in the key phrases.`
            : `${label} can be pitched because it aligns with ${leadAttribute}${
                matchedAttributes.length > 1 ? " and similar needs mentioned in the conversation" : " mentioned in the conversation"
              }.`,
        score,
      };
    })
    .filter(
      (
        item
      ): item is ConversationProductRecommendation & {
        score: number;
      } => Boolean(item)
    )
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 3)
    .map(({ score: _score, ...item }) => item);

  return recommendations;
}

function resolveAiRuntimeConfig(
  settings: Record<string, string>,
  currentModel?: string
): {
  apiKey: string;
  model: string;
} {
  const envGroqKey = (
    process.env.EXPO_PUBLIC_GROQ_API_KEY ||
    process.env.GROQ_API_KEY ||
    ""
  ).trim();
  const apiKey = normalizeApiSecret(envGroqKey || settings.aiApiKey || "");
  const envGroqModel = (
    process.env.EXPO_PUBLIC_GROQ_MODEL || process.env.GROQ_MODEL || "openai/gpt-oss-20b"
  ).trim();
  const configuredModel = (settings.aiModel || currentModel || envGroqModel).trim();
  const model = configuredModel || envGroqModel;
  return {
    apiKey,
    model,
  };
}

async function analyzeConversationWithBackendAI(input: {
  transcript: string;
  customerName: string;
  salespersonName: string;
  model: string;
}): Promise<AISalesAnalysisResult> {
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
        body: JSON.stringify(input),
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
        return payload.result as AISalesAnalysisResult;
      }
      if (payload && typeof payload === "object") {
        return payload as AISalesAnalysisResult;
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

export default function ConversationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { colors, isDark } = useAppTheme();
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiModel, setAiModel] = useState("openai/gpt-oss-20b");
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPositionMs, setAudioPositionMs] = useState(0);
  const [audioDurationMs, setAudioDurationMs] = useState(0);
  const [productCatalog, setProductCatalog] = useState<DolibarrProduct[]>([]);
  const autoAttemptedRef = useRef(false);
  const audioSoundRef = useRef<Audio.Sound | null>(null);

  const loadConversation = useCallback(async () => {
    const convos = await getConversations();
    setConvo(convos.find((c) => c.id === id) || null);
  }, [id]);

  const loadAiConfig = useCallback(async () => {
    const settings = await getSettings();
    const runtimeConfig = resolveAiRuntimeConfig(settings);
    setAiConfigured(Boolean(runtimeConfig.apiKey));
    setAiModel(runtimeConfig.model || "openai/gpt-oss-20b");
  }, []);

  const loadProductCatalog = useCallback(async () => {
    try {
      const products = await getDolibarrProducts({ limit: 120 });
      setProductCatalog(Array.isArray(products) ? products : []);
    } catch {
      setProductCatalog([]);
    }
  }, []);

  useEffect(() => {
    autoAttemptedRef.current = false;
    void loadConversation();
    void loadAiConfig();
    void loadProductCatalog();
  }, [loadAiConfig, loadConversation, loadProductCatalog]);

  const productRecommendations = useMemo(
    () => (convo ? buildProductRecommendations(convo, productCatalog) : []),
    [convo, productCatalog]
  );

  const runAiAnalysis = useCallback(
    async (mode: "auto" | "manual") => {
      if (user?.role !== "admin") {
        return;
      }
      if (!convo?.transcript?.trim()) {
        if (mode === "manual") {
          Alert.alert("Transcript Missing", "A conversation transcript is required first.");
        }
        return;
      }

      const settings = await getSettings();
      const runtimeConfig = resolveAiRuntimeConfig(settings, aiModel);
      const { apiKey, model: configuredModel } = runtimeConfig;
      setAiConfigured(Boolean(apiKey));
      setAiModel(configuredModel);

      setAnalysisBusy(true);
      setAnalysisError(null);

      try {
        let result: AISalesAnalysisResult;
        try {
          if (!apiKey) {
            throw new Error("Client Groq key missing. Using backend AI analysis.");
          }
          result = await analyzeConversationWithAI({
            apiKey,
            model: configuredModel,
            transcript: convo.transcript,
            customerName: convo.customerName,
            salespersonName: convo.salespersonName,
          });
        } catch (directError) {
          const directMessage =
            directError instanceof Error ? directError.message : "AI analysis failed.";
          const directKind =
            typeof (directError as any)?.kind === "string"
              ? String((directError as any).kind)
              : "";
          const shouldFallbackToBackend =
            !apiKey ||
            directKind === "invalid_api_key" ||
            directKind === "network_error" ||
            /unauthorized|permission denied|valid api key|api key|client groq key missing/i.test(
              directMessage.toLowerCase()
            );
          if (!shouldFallbackToBackend) {
            throw directError;
          }
          result = await analyzeConversationWithBackendAI({
            model: configuredModel,
            transcript: convo.transcript,
            customerName: convo.customerName,
            salespersonName: convo.salespersonName,
          });
        }

        await updateConversation(convo.id, {
          ...result,
          analysisProvider: "ai",
        });

        if (user) {
          await addAuditLog({
            id: `audit_ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId: user.id,
            userName: user.name,
            action: "AI Analysis Completed",
            details: `Conversation analyzed with AI for ${convo.customerName}`,
            timestamp: new Date().toISOString(),
            module: "Sales AI",
          });
        }

        await loadConversation();
        if (mode === "manual") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Analysis Updated", "AI analysis was refreshed successfully.");
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "AI analysis failed. Please try again.";
        const normalizedKind =
          typeof (error as any)?.kind === "string" ? String((error as any).kind) : "";
        const shouldApplyRulesFallback =
          normalizedKind === "quota_exhausted" ||
          normalizedKind === "rate_limited" ||
          /insufficient_quota|quota|billing|rate[_\s-]?limit|rate_limited|credit/i.test(message);

        if (shouldApplyRulesFallback) {
          const rulesFallback = buildConversationFromTranscript({
            salespersonId: convo.salespersonId,
            salespersonName: convo.salespersonName,
            customerName: convo.customerName,
            transcript: convo.transcript,
            durationMs: parseDurationToMs(convo.duration),
            audioUri: convo.audioUri ?? null,
            dateISO: convo.date,
          });

          await updateConversation(convo.id, {
            interestScore: rulesFallback.interestScore,
            pitchScore: rulesFallback.pitchScore,
            confidenceScore: rulesFallback.confidenceScore,
            talkListenRatio: rulesFallback.talkListenRatio,
            sentiment: rulesFallback.sentiment,
            buyingIntent: rulesFallback.buyingIntent,
            summary: rulesFallback.summary,
            keyPhrases: rulesFallback.keyPhrases,
            objections: rulesFallback.objections,
            improvements: rulesFallback.improvements,
            analysisProvider: "rules",
          });

          if (user) {
            await addAuditLog({
              id: `audit_rules_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              userId: user.id,
              userName: user.name,
              action: "AI Fallback Analysis Applied",
              details: `Rules-based analysis applied after AI quota/rate limit for ${convo.customerName}`,
              timestamp: new Date().toISOString(),
              module: "Sales AI",
            });
          }

          await loadConversation();
          const fallbackMsg =
            "AI quota/rate limit detected. Rules-based fallback analysis was applied.";
          setAnalysisError(fallbackMsg);
          if (mode === "manual") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            Alert.alert("Fallback Analysis Applied", fallbackMsg);
          }
          return;
        }

        setAnalysisError(message);
        if (mode === "manual") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          Alert.alert("Analysis Failed", message);
        }
      } finally {
        setAnalysisBusy(false);
      }
    },
    [aiModel, convo, loadConversation, user]
  );

  useEffect(() => {
    if (!convo) return;
    if (user?.role !== "admin") return;
    if (analysisBusy) return;
    if (autoAttemptedRef.current) return;
    if (convo.analysisProvider === "ai") return;
    autoAttemptedRef.current = true;
    void runAiAnalysis("auto");
  }, [analysisBusy, convo, runAiAnalysis, user?.role]);

  const unloadAudio = useCallback(async () => {
    const sound = audioSoundRef.current;
    audioSoundRef.current = null;
    setAudioPlaying(false);
    setAudioPositionMs(0);
    setAudioDurationMs(0);
    if (!sound) return;
    try {
      await sound.unloadAsync();
    } catch {
      // ignore unload issues
    }
  }, []);

  useEffect(() => {
    return () => {
      void unloadAudio();
    };
  }, [unloadAudio]);

  useEffect(() => {
    void unloadAudio();
  }, [convo?.id, unloadAudio]);

  if (!convo) {
    return (
      <AppCanvas>
        <View style={[styles.loadingContainer, { justifyContent: "center", alignItems: "center" }]}>
          <Text style={{ color: colors.textSecondary, fontFamily: "Inter_400Regular" }}>Loading...</Text>
        </View>
      </AppCanvas>
    );
  }

  const canViewAnalysis = user?.role === "admin";
  const normalizedStoredNotes = normalizeConversationNotes(convo.notes);
  const showConversationNotes = canViewAnalysis && Boolean(normalizedStoredNotes);

  const onPlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      setAudioPlaying(false);
      return;
    }
    setAudioPlaying(status.isPlaying);
    setAudioPositionMs(status.positionMillis || 0);
    setAudioDurationMs(status.durationMillis || 0);
    if (status.didJustFinish) {
      setAudioPlaying(false);
    }
  };

  const playConversationAudio = async () => {
    if (!convo.audioUri) {
      Alert.alert("Audio Missing", "Audio file is not available for this conversation.");
      return;
    }
    if (audioBusy) return;
    setAudioBusy(true);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
      });

      const currentSound = audioSoundRef.current;
      if (currentSound) {
        const status = await currentSound.getStatusAsync();
        if (!status.isLoaded) {
          await unloadAudio();
          return;
        }
        if (status.isPlaying) {
          await currentSound.pauseAsync();
          setAudioPlaying(false);
        } else {
          await currentSound.playAsync();
          setAudioPlaying(true);
        }
        return;
      }

      const { sound, status } = await Audio.Sound.createAsync(
        { uri: convo.audioUri },
        {
          shouldPlay: true,
          progressUpdateIntervalMillis: 250,
        },
        onPlaybackStatusUpdate
      );
      audioSoundRef.current = sound;
      if (status.isLoaded) {
        setAudioPlaying(status.isPlaying);
        setAudioPositionMs(status.positionMillis || 0);
        setAudioDurationMs(status.durationMillis || 0);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Audio playback failed.";
      Alert.alert("Playback Failed", message);
      await unloadAudio();
    } finally {
      setAudioBusy(false);
    }
  };

  const sentimentColor =
    convo.sentiment === "positive" ? colors.success :
    convo.sentiment === "neutral" ? colors.warning : colors.danger;

  return (
    <AppCanvas>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 16 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: colors.text, fontFamily: "Inter_700Bold" }]}>
            {canViewAnalysis ? "Analysis" : "Conversation"}
          </Text>
          <View style={{ width: 24 }} />
        </View>

        <Animated.View entering={FadeInDown.duration(400)}>
          <LinearGradient
            colors={isDark ? [colors.heroEnd, colors.heroStart] : [colors.heroStart, colors.heroEnd]}
            style={styles.heroCard}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <View style={styles.heroRow}>
              <MaterialCommunityIcons name="brain" size={28} color="rgba(255,255,255,0.9)" />
              <View style={styles.heroInfo}>
                <Text style={styles.heroCustomer}>{convo.customerName}</Text>
                <Text style={styles.heroSalesperson}>{convo.salespersonName} - {convo.duration}</Text>
              </View>
            </View>
            {canViewAnalysis ? (
              <View style={styles.heroMetrics}>
                <View style={styles.heroMetric}>
                  <Text style={styles.heroMetricValue}>{convo.interestScore}</Text>
                  <Text style={styles.heroMetricLabel}>Interest</Text>
                </View>
                <View style={styles.heroMetricDivider} />
                <View style={styles.heroMetric}>
                  <Text style={styles.heroMetricValue}>{convo.pitchScore}</Text>
                  <Text style={styles.heroMetricLabel}>Pitch</Text>
                </View>
                <View style={styles.heroMetricDivider} />
                <View style={styles.heroMetric}>
                  <Text style={styles.heroMetricValue}>{convo.confidenceScore}</Text>
                  <Text style={styles.heroMetricLabel}>Confidence</Text>
                </View>
              </View>
            ) : null}
          </LinearGradient>
        </Animated.View>

        {canViewAnalysis ? (
          <>
            <Animated.View entering={FadeInDown.duration(400).delay(100)} style={styles.overviewSection}>
              <View style={styles.overviewRow}>
                <View style={[styles.overviewCard, { backgroundColor: sentimentColor + "15" }]}>
                  <Ionicons name="happy-outline" size={20} color={sentimentColor} />
                  <Text style={[styles.overviewLabel, { color: sentimentColor, fontFamily: "Inter_500Medium" }]}>
                    {convo.sentiment.toUpperCase()}
                  </Text>
                  <Text style={[styles.overviewSub, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>Sentiment</Text>
                </View>
                <View style={[styles.overviewCard, { backgroundColor: colors.primary + "15" }]}>
                  <Ionicons name="trending-up" size={20} color={colors.primary} />
                  <Text style={[styles.overviewLabel, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>
                    {convo.buyingIntent.toUpperCase()}
                  </Text>
                  <Text style={[styles.overviewSub, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>Buying Intent</Text>
                </View>
                <View style={[styles.overviewCard, { backgroundColor: colors.warning + "15" }]}>
                  <Ionicons name="mic-outline" size={20} color={colors.warning} />
                  <Text style={[styles.overviewLabel, { color: colors.warning, fontFamily: "Inter_500Medium" }]}>
                    {convo.talkListenRatio}%
                  </Text>
                  <Text style={[styles.overviewSub, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>Talk Ratio</Text>
                </View>
              </View>
            </Animated.View>

            <View style={[styles.scoresCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <Text style={[styles.scoresTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
                Performance Breakdown
              </Text>
              <ScoreGauge label="Interest Level" score={convo.interestScore} colors={colors} delay={200} />
              <ScoreGauge label="Pitch Clarity" score={convo.pitchScore} colors={colors} delay={250} />
              <ScoreGauge label="Confidence" score={convo.confidenceScore} colors={colors} delay={300} />
              <ScoreGauge label="Talk-to-Listen" score={convo.talkListenRatio} colors={colors} delay={350} />
            </View>
          </>
        ) : null}

        {showConversationNotes ? (
        <Animated.View entering={FadeInDown.duration(400).delay(400)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            Meeting Notes
          </Text>
          <View style={[styles.textCard, styles.notesCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <View style={styles.notesHeaderRow}>
              <View style={[styles.notesBadge, { backgroundColor: colors.primary + "14", borderColor: colors.primary + "26" }]}>
                <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                <Text style={[styles.notesBadgeText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                  Attached to conversation
                </Text>
              </View>
              <Text style={[styles.notesHelperText, { color: colors.textTertiary, fontFamily: "Inter_500Medium" }]}>
                Interest, objection, next step
              </Text>
            </View>

            {normalizedStoredNotes ? (
              <View style={[styles.notesReadOnlyCard, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}>
                <Ionicons name="document-text-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.summaryText, styles.notesReadOnlyText, { color: colors.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  {normalizedStoredNotes}
                </Text>
              </View>
            ) : null}
          </View>
        </Animated.View>
        ) : null}

        <Animated.View entering={FadeInDown.duration(400).delay(430)}>
          <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
            {canViewAnalysis ? "AI Summary" : "Conversation Summary"}
          </Text>
          <View style={[styles.textCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
            <Text style={[styles.summaryText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {convo.summary}
            </Text>
            <Pressable
              onPress={() => void playConversationAudio()}
              disabled={audioBusy}
              style={({ pressed }) => [
                styles.audioButton,
                {
                  backgroundColor: colors.primary,
                  opacity: pressed || audioBusy ? 0.88 : 1,
                },
              ]}
            >
              {audioBusy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name={audioPlaying ? "pause-circle-outline" : "play-circle-outline"} size={18} color="#FFFFFF" />
              )}
              <Text style={styles.audioButtonText}>
                {audioPlaying ? "Pause Conversation Audio" : "Play Conversation Audio"}
              </Text>
            </Pressable>
            {(audioDurationMs > 0 || audioPositionMs > 0) ? (
              <Text style={[styles.audioMetaText, { color: colors.textSecondary, fontFamily: "Inter_400Regular" }]}>
                {Math.max(0, Math.floor(audioPositionMs / 1000))}s / {Math.max(0, Math.floor(audioDurationMs / 1000))}s
              </Text>
            ) : null}
            <View style={styles.metaRow}>
              {convo.source ? (
                <View style={[styles.metaPill, { backgroundColor: colors.secondary + "18" }]}>
                  <Text style={[styles.metaPillText, { color: colors.secondary, fontFamily: "Inter_600SemiBold" }]}>
                    {convo.source.toUpperCase()}
                  </Text>
                </View>
              ) : null}
              {canViewAnalysis && convo.analysisProvider ? (
                <View style={[styles.metaPill, { backgroundColor: colors.primary + "15" }]}>
                  <Text style={[styles.metaPillText, { color: colors.primary, fontFamily: "Inter_600SemiBold" }]}>
                    {convo.analysisProvider.toUpperCase()} ANALYSIS
                  </Text>
                </View>
              ) : null}
            </View>

            {canViewAnalysis ? (
              <View style={styles.analysisActionsWrap}>
                {analysisError ? (
                  <View
                    style={[
                      styles.analysisBanner,
                      {
                        backgroundColor: colors.danger + "12",
                        borderColor: colors.danger + "40",
                      },
                    ]}
                  >
                    <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                    <Text
                      style={[
                        styles.analysisBannerText,
                        { color: colors.danger, fontFamily: "Inter_500Medium" },
                      ]}
                    >
                      {analysisError}
                    </Text>
                  </View>
                ) : null}

                {!aiConfigured ? (
                  <View
                    style={[
                      styles.analysisBanner,
                      {
                        backgroundColor: colors.warning + "12",
                        borderColor: colors.warning + "40",
                      },
                    ]}
                  >
                    <Ionicons name="key-outline" size={15} color={colors.warning} />
                    <Text
                      style={[
                        styles.analysisBannerText,
                        { color: colors.warning, fontFamily: "Inter_500Medium" },
                      ]}
                    >
                      AI env key missing.
                    </Text>
                  </View>
                ) : (
                  <Text
                    style={[
                      styles.aiMetaText,
                      { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                    ]}
                  >
                    Model: {aiModel}
                  </Text>
                )}

                <Pressable
                  onPress={() => void runAiAnalysis("manual")}
                  disabled={analysisBusy}
                  style={({ pressed }) => [
                    styles.aiButton,
                    {
                      backgroundColor: colors.primary,
                      opacity: pressed || analysisBusy ? 0.8 : 1,
                    },
                  ]}
                >
                  {analysisBusy ? (
                    <>
                      <ActivityIndicator size="small" color="#FFFFFF" />
                      <Text style={styles.aiButtonText}>Analyzing...</Text>
                    </>
                  ) : (
                    <>
                    <Ionicons name="sparkles-outline" size={16} color="#FFFFFF" />
                    <Text style={styles.aiButtonText}>
                        {convo.analysisProvider === "ai"
                          ? "Re-run AI Analysis"
                          : "Run AI Analysis"}
                    </Text>
                  </>
                )}
                </Pressable>
              </View>
            ) : null}
          </View>
        </Animated.View>

        {canViewAnalysis && convo.transcript ? (
          <Animated.View entering={FadeInDown.duration(400).delay(460)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Transcript
            </Text>
            <View style={[styles.textCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              <Text style={[styles.summaryText, { color: colors.text, fontFamily: "Inter_400Regular" }]}>
                {convo.transcript}
              </Text>
            </View>
          </Animated.View>
        ) : null}

        {canViewAnalysis ? (
          <Animated.View entering={FadeInDown.duration(400).delay(450)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Key Phrases
            </Text>
            <View style={styles.tagsRow}>
              {convo.keyPhrases.map((phrase, idx) => (
                <View key={idx} style={[styles.tag, { backgroundColor: colors.primary + "15" }]}>
                  <Text style={[styles.tagText, { color: colors.primary, fontFamily: "Inter_500Medium" }]}>{phrase}</Text>
                </View>
              ))}
            </View>
          </Animated.View>
        ) : null}

        {canViewAnalysis && productRecommendations.length > 0 ? (
          <Animated.View entering={FadeInDown.duration(400).delay(480)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Recommended Products by Key Phrases
            </Text>
            <View style={[styles.listCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {productRecommendations.map((item, idx) => (
                <View
                  key={item.id}
                  style={[
                    styles.productRecommendationItem,
                    idx < productRecommendations.length - 1 && {
                      borderBottomWidth: 0.5,
                      borderBottomColor: colors.borderLight,
                    },
                  ]}
                >
                  <View style={[styles.productRecommendationIcon, { backgroundColor: colors.primary + "15" }]}>
                    <Ionicons name="cube-outline" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.productRecommendationHeader}>
                      <Text
                        style={[
                          styles.productRecommendationTitle,
                          { color: colors.text, fontFamily: "Inter_600SemiBold" },
                        ]}
                      >
                        {item.label}
                      </Text>
                      {item.ref ? (
                        <View style={[styles.metaPill, { backgroundColor: colors.secondary + "18" }]}>
                          <Text
                            style={[
                              styles.metaPillText,
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
                        styles.productRecommendationReason,
                        { color: colors.textSecondary, fontFamily: "Inter_400Regular" },
                      ]}
                    >
                      {item.reason}
                    </Text>
                    {item.matchedKeyPhrases.length > 0 ? (
                      <View style={styles.productAttributeRow}>
                        {item.matchedKeyPhrases.map((phrase) => (
                          <View
                            key={`${item.id}_phrase_${phrase}`}
                            style={[styles.productKeyPhraseChip, { backgroundColor: colors.secondary + "14" }]}
                          >
                            <Text
                              style={[
                                styles.productKeyPhraseChipText,
                                { color: colors.secondary, fontFamily: "Inter_500Medium" },
                              ]}
                            >
                              Key phrase: {phrase}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <View style={styles.productAttributeRow}>
                      {item.matchedAttributes.map((attribute) => (
                        <View
                          key={`${item.id}_${attribute}`}
                          style={[styles.productAttributeChip, { backgroundColor: colors.primary + "12" }]}
                        >
                          <Text
                            style={[
                              styles.productAttributeChipText,
                              { color: colors.primary, fontFamily: "Inter_500Medium" },
                            ]}
                          >
                            {attribute}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </Animated.View>
        ) : null}

        {canViewAnalysis && convo.objections.length > 0 && (
          <Animated.View entering={FadeInDown.duration(400).delay(500)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              Objections Detected
            </Text>
            <View style={[styles.listCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {convo.objections.map((obj, idx) => (
                <View key={idx} style={[styles.listItem, idx < convo.objections.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: colors.borderLight }]}>
                  <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
                  <Text style={[styles.listText, { color: colors.text, fontFamily: "Inter_400Regular" }]}>{obj}</Text>
                </View>
              ))}
            </View>
          </Animated.View>
        )}

        {canViewAnalysis && convo.improvements.length > 0 && (
          <Animated.View entering={FadeInDown.duration(400).delay(550)}>
            <Text style={[styles.sectionTitle, { color: colors.text, fontFamily: "Inter_600SemiBold" }]}>
              AI Coaching Tips
            </Text>
            <View style={[styles.listCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.border }]}>
              {convo.improvements.map((imp, idx) => (
                <View key={idx} style={[styles.listItem, idx < convo.improvements.length - 1 && { borderBottomWidth: 0.5, borderBottomColor: colors.borderLight }]}>
                  <Ionicons name="bulb-outline" size={16} color={colors.success} />
                  <Text style={[styles.listText, { color: colors.text, fontFamily: "Inter_400Regular" }]}>{imp}</Text>
                </View>
              ))}
            </View>
          </Animated.View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </AppCanvas>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, letterSpacing: -0.3 },
  heroCard: {
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  heroInfo: { flex: 1, gap: 2 },
  heroCustomer: { color: "#fff", fontSize: 17, fontFamily: "Inter_600SemiBold" },
  heroSalesperson: { color: "rgba(255,255,255,0.6)", fontSize: 13, fontFamily: "Inter_400Regular" },
  heroMetrics: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  heroMetric: { alignItems: "center", gap: 2 },
  heroMetricValue: { color: "#fff", fontSize: 28, fontFamily: "Inter_700Bold" },
  heroMetricLabel: { color: "rgba(255,255,255,0.5)", fontSize: 11, fontFamily: "Inter_400Regular" },
  heroMetricDivider: { width: 1, height: 30, backgroundColor: "rgba(255,255,255,0.15)" },
  overviewSection: { marginBottom: 16 },
  overviewRow: { flexDirection: "row", gap: 10 },
  overviewCard: {
    flex: 1,
    borderRadius: 14,
    padding: 12,
    alignItems: "center",
    gap: 4,
  },
  overviewLabel: { fontSize: 12, letterSpacing: 0.3 },
  overviewSub: { fontSize: 10 },
  scoresCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    gap: 14,
    borderWidth: 1,
  },
  scoresTitle: { fontSize: 15, marginBottom: 4 },
  gaugeItem: { gap: 6 },
  gaugeHeader: { flexDirection: "row", justifyContent: "space-between" },
  gaugeLabel: { fontSize: 13 },
  gaugeValue: { fontSize: 14 },
  gaugeTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
  gaugeFill: { height: "100%", borderRadius: 4 },
  sectionTitle: { fontSize: 16, marginBottom: 10 },
  textCard: { borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1 },
  notesCard: {
    gap: 12,
  },
  notesHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  notesBadge: {
    minHeight: 30,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  notesBadgeText: {
    fontSize: 11,
  },
  notesHelperText: {
    fontSize: 11,
  },
  quickNoteRow: {
    gap: 8,
    paddingRight: 6,
  },
  quickNoteChip: {
    minHeight: 32,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quickNoteChipText: {
    fontSize: 11.5,
  },
  notesComposer: {
    minHeight: 86,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  notesInput: {
    flex: 1,
    minHeight: 58,
    fontSize: 13,
    lineHeight: 18,
    paddingTop: 0,
    paddingBottom: 0,
  },
  notesFooterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  notesMetaText: {
    flex: 1,
    fontSize: 11.5,
  },
  notesSaveButton: {
    minHeight: 36,
    borderRadius: 999,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  notesSaveButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  notesReadOnlyCard: {
    minHeight: 54,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  notesReadOnlyText: {
    flex: 1,
  },
  notesEmptyText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18,
  },
  summaryText: { fontSize: 14, lineHeight: 20 },
  audioButton: {
    marginTop: 14,
    minHeight: 40,
    borderRadius: 10,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  audioButtonText: { color: "#FFFFFF", fontSize: 12.5, fontFamily: "Inter_600SemiBold" },
  audioMetaText: {
    marginTop: 6,
    fontSize: 11.5,
  },
  metaRow: {
    marginTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  metaPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  metaPillText: {
    fontSize: 10.5,
    letterSpacing: 0.4,
  },
  analysisActionsWrap: {
    marginTop: 12,
    gap: 8,
  },
  analysisBanner: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  analysisBannerText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  aiMetaText: {
    fontSize: 11.5,
  },
  aiButton: {
    minHeight: 40,
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    alignSelf: "flex-start",
  },
  aiButtonText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: "Inter_600SemiBold",
  },
  tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  tag: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  tagText: { fontSize: 12 },
  listCard: { borderRadius: 16, overflow: "hidden", marginBottom: 20, borderWidth: 1 },
  productRecommendationItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  productRecommendationIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  productRecommendationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  productRecommendationTitle: {
    flex: 1,
    fontSize: 14,
  },
  productRecommendationReason: {
    fontSize: 12.5,
    lineHeight: 18,
  },
  productAttributeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  productKeyPhraseChip: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  productKeyPhraseChipText: { fontSize: 11.5 },
  productAttributeChip: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  productAttributeChipText: { fontSize: 11.5 },
  listItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 14,
    gap: 10,
  },
  listText: { fontSize: 13, flex: 1, lineHeight: 18 },
});
