import { createRequire } from "node:module";

// Deterministic language analysis. These numbers are computed in code (not by the LLM)
// so the parent dashboard is reproducible and explainable.
//
// Metrics (standard in child-language research, used here for practice tracking — NOT diagnosis):
//  - word count
//  - MLU: mean length of utterance, in words per sentence
//  - unique words / type-token ratio
//  - new words: words this child has never used with Hearth before

const STOPWORDS = new Set(
  `a an the and or but so if then than to of in on at by for with from up down out over under
  is am are was were be been being do does did have has had i me my mine you your we our us
  he him his she her they them their it its this that these those there here what who whom
  which when where why how not no yes very just also too can could will would shall should
  may might must went go goes going get got gets like really um uh oh okay ok well all some
  any one two three about into as because after before again then now today yesterday
  said says say tell told know think thing things lot lots bit much many more most
  hundred thousand twenty thirty forty fifty sixty seventy eighty ninety eleven twelve first second third
  little cannot didn don doesn isn wasn wouldn couldn mine yours their theirs`
    .split(/\s+/)
    .filter(Boolean),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []).map((w) => w.replace(/'s$/, ""));
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length > 0);
}

export interface LanguageMetrics {
  word_count: number;
  mlu: number;
  unique_words: number;
  type_token_ratio: number;
  content_words: string[];
}

export function analyze(text: string): LanguageMetrics {
  const words = tokenize(text);
  const sents = sentences(text);
  const unique = new Set(words);
  return {
    word_count: words.length,
    mlu: sents.length ? round(words.length / sents.length, 2) : 0,
    unique_words: unique.size,
    type_token_ratio: words.length ? round(unique.size / words.length, 2) : 0,
    content_words: [...unique].filter((w) => !STOPWORDS.has(w) && w.length > 2),
  };
}

/** Words worth celebrating to a parent: new, not a stopword, and not trivially short. */
export function notableWords(fresh: string[]): string[] {
  return fresh.filter((w) => !STOPWORDS.has(w) && w.length >= 5);
}

// ── Age-graded "big words" ──
// Word frequency ranks from SUBTLEX-US (74k words ranked by how often they're spoken).
// A word counts as a "big word" for a child when it's rarer in everyday speech than the
// threshold for their age: "played" (#1,203) isn't one; "extraordinary" (#3,262) is for a
// seven-year-old; "germinating" (#55,387) is for nearly anyone.
let RANKS: Map<string, number> | null = null;
function ranks(): Map<string, number> {
  if (!RANKS) {
    const list = createRequire(import.meta.url)("subtlex-word-frequencies") as { word: string }[];
    RANKS = new Map();
    list.forEach((x, i) => {
      const w = x.word.toLowerCase();
      if (!RANKS!.has(w)) RANKS!.set(w, i + 1);
    });
  }
  return RANKS;
}

/** Rank of a word, trying the US spelling for British variants (favourite → favorite, colour → color). */
export function wordRank(word: string): number | undefined {
  const w = word.toLowerCase();
  const variants = [w, w.replace(/our(s?)$/, "or$1"), w.replace(/our/, "or"), w.replace(/is(e|ed|es|ing)$/, "iz$1"), w.replace(/tre$/, "ter"), w.replace(/s$/, ""), w.replace(/es$/, "")];
  const found = variants.map((v) => ranks().get(v)).filter((r): r is number => r !== undefined);
  return found.length ? Math.min(...found) : undefined;
}

/** Rough syllable count — good enough to tell "blanket" from "extraordinary". */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  return Math.max(1, (w.match(/[aeiouy]{1,2}/g) ?? []).length);
}

export function bigWordThreshold(age: number | null): number {
  const a = age ?? 8;
  if (a <= 5) return 1800;
  if (a <= 8) return 2500;
  if (a <= 10) return 4000;
  if (a <= 12) return 6000;
  return 9000;
}

/**
 * Of the words a child used for the first time, which are worth celebrating?
 * Skips names, stopwords, unknown words (often names or transcription errors) and any word
 * that was in the question Alexa asked — repeating "bicycle" back isn't learning it.
 */
export function bigWords(fresh: string[], age: number | null, prompt: string | null, names: Set<string>): string[] {
  const echoed = new Set(tokenize(prompt ?? ""));
  const limit = bigWordThreshold(age);
  return fresh.filter((w) => {
    if (w.length < 4 || STOPWORDS.has(w) || names.has(w) || echoed.has(w)) return false;
    const r = wordRank(w);
    if (r === undefined || r <= limit) return false;
    // Rare in film dialogue isn't the same as advanced: "blanket" and "cushions" are rare on
    // screen but everyday for a child. Long words, or genuinely rare ones, are the real signal.
    return syllables(w) >= 3 || r > 15000;
  });
}

/** Capitalised words that aren't at the start of a sentence — names like "Lakshmi" or "Saturn". */
export function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const s of sentences(text)) {
    const words = s.match(/[A-Za-z]+/g) ?? [];
    for (const w of words.slice(1)) if (/^[A-Z][a-z]/.test(w) && w !== "I") out.add(w.toLowerCase());
  }
  return out;
}

/** Simple keyword topics for the offline fallback (the LLM path does better). */
export function topKeywords(text: string, n = 4): string[] {
  const counts = new Map<string, number>();
  for (const w of tokenize(text)) {
    if (STOPWORDS.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map(([w]) => w);
}

const MOOD_LEXICON: Record<string, string[]> = {
  happy: ["happy", "fun", "great", "awesome", "excited", "love", "loved", "glad", "proud", "yay", "best", "laughed"],
  tired: ["tired", "exhausted", "sleepy", "drained", "sleep", "slept", "late"],
  worried: ["worried", "anxious", "nervous", "scared", "stress", "stressed", "afraid", "deadline"],
  sad: ["sad", "upset", "cried", "lonely", "miss", "missed", "angry", "bad"],
  calm: ["calm", "peaceful", "relaxed", "quiet", "slow", "nice"],
  nostalgic: ["remember", "remembered", "used", "those", "days", "young", "childhood", "village", "father", "mother"],
};

export function guessMood(text: string): string | null {
  const words = tokenize(text);
  let best: string | null = null;
  let bestScore = 0;
  for (const [mood, cues] of Object.entries(MOOD_LEXICON)) {
    const score = words.filter((w) => cues.includes(w)).length;
    if (score > bestScore) {
      best = mood;
      bestScore = score;
    }
  }
  return best;
}

export function firstSentence(text: string, max = 160): string {
  const s = sentences(text)[0] ?? text;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

export function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
