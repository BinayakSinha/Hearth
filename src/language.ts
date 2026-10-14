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
