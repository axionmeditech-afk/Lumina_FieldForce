import type { Conversation } from "@/lib/types";

interface BuildConversationFromTranscriptInput {
  salespersonId: string;
  salespersonName: string;
  customerName: string;
  transcript: string;
  durationMs: number;
  audioUri?: string | null;
  dateISO?: string;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "with",
  "from",
  "this",
  "have",
  "will",
  "about",
  "your",
  "our",
  "you",
  "are",
  "was",
  "were",
  "they",
  "their",
  "there",
  "what",
  "when",
  "where",
  "which",
  "while",
  "would",
  "could",
  "should",
  "into",
  "been",
  "being",
  "also",
  "than",
  "just",
  "only",
  "over",
  "some",
  "more",
  "very",
  "please",
  "hello",
  "thanks",
  "thank",
  "haan",
  "ha",
  "han",
  "acha",
  "accha",
  "nahi",
  "nahin",
  "kya",
  "kar",
  "karna",
  "karne",
  "krna",
  "krne",
  "bolo",
  "boliye",
  "de",
  "dijiye",
  "sakta",
  "sakte",
  "sakta",
  "wale",
  "wala",
  "wali",
  "liye",
  "aur",
  "sir",
  "madam",
  "bhai",
]);

const SPOKEN_NUMBER_WORDS: Record<string, string> = {
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

const SPEC_UNIT_PATTERN =
  /\b\d+(?:\.\d+)?\s?(?:mm|cm|ml|l|ltr|micron|microns|g|kg|gsm|inch|inches|gauge|ga|cc)\b/gi;
const SPEC_DIMENSION_PATTERN =
  /\b\d+(?:\.\d+)?\s?[x*]\s?\d+(?:\.\d+)?(?:\s?[x*]\s?\d+(?:\.\d+)?)?\b/gi;

const POSITIVE_SIGNALS = [
  "interested",
  "great",
  "good",
  "excellent",
  "impressive",
  "like",
  "sounds good",
  "move forward",
  "next step",
  "proposal",
  "demo",
  "pilot",
  "shortlist",
  "approved",
  "agree",
];

const NEGATIVE_SIGNALS = [
  "expensive",
  "costly",
  "no budget",
  "budget issue",
  "not interested",
  "later",
  "not now",
  "delay",
  "risk",
  "concern",
  "problem",
  "difficult",
  "competitor",
  "locked in",
];

const OBJECTION_KEYWORDS = [
  "budget",
  "price",
  "expensive",
  "approval",
  "contract",
  "timeline",
  "integration",
  "security",
  "competitor",
  "renewal",
  "procurement",
];

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countSignalMatches(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

function formatDuration(durationMs: number): string {
  const safeMs = Math.max(0, Math.round(durationMs));
  const totalSeconds = Math.floor(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeSpokenSpecificationPhrases(value: string): string {
  return value.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine)\s+point\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi,
    (_, whole: string, fraction: string) =>
      `${SPOKEN_NUMBER_WORDS[whole.toLowerCase()]}.${SPOKEN_NUMBER_WORDS[fraction.toLowerCase()]}`
  );
}

function normalizePhraseText(value: string): string {
  return normalizeSpokenSpecificationPhrases(value.toLowerCase())
    .replace(/speaker\s+[a-z0-9_-]+(?:\s*\[[^\]]+\])?:/gi, " ")
    .replace(/[^a-z0-9.+\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPhraseLabel(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part) || part === "mm" || part === "cm" || part === "ml" || part === "cc") {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function scorePhraseCandidate(phrase: string, frequency: number): number {
  let score = frequency * 3;
  if (/\d/.test(phrase)) score += 6;
  if (phrase.split(" ").length >= 2) score += 2;
  if (phrase.length > 34) score -= 2;
  return score;
}

function extractSpecificationPhrases(text: string): string[] {
  const normalized = normalizePhraseText(text);
  const set = new Set<string>();
  for (const raw of normalized.match(SPEC_UNIT_PATTERN) || []) {
    const cleaned = raw.trim();
    if (cleaned) set.add(cleaned);
  }
  for (const raw of normalized.match(SPEC_DIMENSION_PATTERN) || []) {
    const cleaned = raw.trim();
    if (cleaned) set.add(cleaned);
  }
  return Array.from(set);
}

function detectObjections(transcript: string): string[] {
  const lower = transcript.toLowerCase();
  const sentences = splitSentences(transcript);
  const extracted = sentences.filter((sentence) => {
    const line = sentence.toLowerCase();
    return OBJECTION_KEYWORDS.some((keyword) => line.includes(keyword));
  });
  if (extracted.length) return extracted.slice(0, 4);

  const matchedKeywords = OBJECTION_KEYWORDS.filter((keyword) => lower.includes(keyword));
  return matchedKeywords.slice(0, 3).map((keyword) => `Discussion around ${keyword} constraints.`);
}

function extractKeyPhrases(transcript: string): string[] {
  const normalized = normalizePhraseText(transcript);
  const tokens = normalized.match(/[a-z0-9.+-]{2,}/g) || [];
  const phraseScores = new Map<string, number>();

  for (const spec of extractSpecificationPhrases(normalized)) {
    phraseScores.set(spec, (phraseScores.get(spec) || 0) + 12);
  }

  for (let size = 1; size <= 3; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const window = tokens.slice(index, index + size);
      if (
        window.every((token) => STOP_WORDS.has(token)) ||
        window.some((token) => token.length <= 1) ||
        (size === 1 && /^\d+$/.test(window[0]))
      ) {
        continue;
      }

      const phrase = window.join(" ").trim();
      if (!phrase || phrase.length < 3) continue;
      if (size >= 2 && window[0] === "speaker") continue;
      if (size >= 2 && window.every((token) => STOP_WORDS.has(token))) continue;

      const nonStopCount = window.filter((token) => !STOP_WORDS.has(token)).length;
      if (nonStopCount === 0) continue;
      if (size >= 2 && nonStopCount < Math.max(1, size - 1)) continue;

      phraseScores.set(phrase, (phraseScores.get(phrase) || 0) + 1);
    }
  }

  const ranked = [...phraseScores.entries()]
    .map(([phrase, frequency]) => ({
      phrase,
      frequency,
      score: scorePhraseCandidate(phrase, frequency),
    }))
    .filter((entry) => entry.phrase.length >= 3)
    .sort((a, b) => b.score - a.score || b.frequency - a.frequency || a.phrase.localeCompare(b.phrase));

  const selected: string[] = [];
  for (const entry of ranked) {
    const alreadyCovered = selected.some(
      (picked) => picked.includes(entry.phrase) || entry.phrase.includes(picked)
    );
    if (alreadyCovered) continue;
    selected.push(formatPhraseLabel(entry.phrase));
    if (selected.length >= 6) break;
  }

  return selected.length ? selected : ["Sales Discussion", "Customer Requirement", "Follow-up"];
}

function buildSummary(transcript: string, buyingIntent: Conversation["buyingIntent"]): string {
  const sentences = splitSentences(transcript);
  if (!sentences.length) {
    return "Conversation was recorded successfully. Transcript is available for detailed AI analysis.";
  }
  const topLines = sentences.slice(0, 2).join(". ");
  return `${topLines}. Overall buying intent appears ${buyingIntent}.`;
}

function computeTalkListenRatio(transcript: string): number {
  const salesMatches = transcript.match(/\b(sales|agent|rep|me):/gi)?.length || 0;
  const customerMatches = transcript.match(/\b(customer|client|prospect):/gi)?.length || 0;
  if (salesMatches === 0 && customerMatches === 0) {
    return 50;
  }
  const total = salesMatches + customerMatches;
  return clampScore((salesMatches / Math.max(total, 1)) * 100);
}

function computeScores(transcript: string): {
  interestScore: number;
  pitchScore: number;
  confidenceScore: number;
  buyingIntent: Conversation["buyingIntent"];
  sentiment: Conversation["sentiment"];
  talkListenRatio: number;
  improvements: string[];
} {
  const lower = transcript.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const questionCount = (transcript.match(/\?/g) || []).length;
  const fillerCount = (lower.match(/\b(um+|uh+|like|basically|actually)\b/g) || []).length;

  const positiveHits = countSignalMatches(lower, POSITIVE_SIGNALS);
  const negativeHits = countSignalMatches(lower, NEGATIVE_SIGNALS);

  const interestBase =
    50 + positiveHits * 8 - negativeHits * 9 + Math.min(questionCount * 2, 12) + Math.min(words.length / 25, 10);
  const pitchBase = 58 + Math.min(questionCount * 4, 20) - Math.min(fillerCount * 3, 18) - negativeHits * 3;
  const confidenceBase = 60 + positiveHits * 6 - fillerCount * 2 - negativeHits * 4;

  const interestScore = clampScore(interestBase);
  const pitchScore = clampScore(pitchBase);
  const confidenceScore = clampScore(confidenceBase);

  let buyingIntent: Conversation["buyingIntent"] = "medium";
  if (interestScore >= 75) buyingIntent = "high";
  if (interestScore <= 45) buyingIntent = "low";

  let sentiment: Conversation["sentiment"] = "neutral";
  if (interestScore >= 70 && negativeHits <= 1) sentiment = "positive";
  if (interestScore <= 45 || negativeHits >= 3) sentiment = "negative";

  const talkListenRatio = computeTalkListenRatio(transcript);
  const improvements: string[] = [];
  if (talkListenRatio > 62) {
    improvements.push("Reduce monologue and ask more discovery questions.");
  }
  if (pitchScore < 65) {
    improvements.push("Structure the pitch with clearer value and ROI framing.");
  }
  if (confidenceScore < 65) {
    improvements.push("Use stronger closes and confirm next steps explicitly.");
  }
  if (improvements.length === 0) {
    improvements.push("Good flow. Add one quantified case study for stronger impact.");
  }

  return {
    interestScore,
    pitchScore,
    confidenceScore,
    buyingIntent,
    sentiment,
    talkListenRatio,
    improvements,
  };
}

export function buildConversationFromTranscript(
  input: BuildConversationFromTranscriptInput
): Conversation {
  const transcript = input.transcript.trim();
  const analysis = computeScores(transcript);
  const objections = detectObjections(transcript);
  const keyPhrases = extractKeyPhrases(transcript);
  const summary = buildSummary(transcript, analysis.buyingIntent);
  const date = input.dateISO ?? new Date().toISOString();

  return {
    id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    salespersonId: input.salespersonId,
    salespersonName: input.salespersonName,
    customerName: input.customerName.trim(),
    date,
    duration: formatDuration(input.durationMs),
    transcript,
    transcriptStatus: "completed",
    audioUri: input.audioUri ?? null,
    transcriptionError: null,
    source: "recorded",
    analysisProvider: "rules",
    interestScore: analysis.interestScore,
    pitchScore: analysis.pitchScore,
    confidenceScore: analysis.confidenceScore,
    talkListenRatio: analysis.talkListenRatio,
    sentiment: analysis.sentiment,
    buyingIntent: analysis.buyingIntent,
    objections,
    improvements: analysis.improvements,
    summary,
    keyPhrases,
  };
}
