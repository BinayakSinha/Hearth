// Hearth core logic. The MCP tools (server.ts) and the parent dashboard API both call into here.
import {
  allMembers, allSharedEntries, allThreads, db, entriesFor, findMember, insertEntry, insertMember,
  insertThread, markThreadUsed, supersedePending, memberById, nowIso, pendingThreadsFor, recordVocabulary,
  sharedEntriesSince, vocabularySize, type Entry, type Member, type Role, type Thread,
} from "./db.js";
import { analyze, firstSentence, guessMood, notableWords, properNouns, round, tokenize, topKeywords } from "./language.js";
import { completeJson, llmEnabled } from "./llm.js";
import { MEMOIR, MEMOIR_FLAT, STYLE_GUIDE, bankFor } from "./prompts.js";

const TZ = process.env.HEARTH_TZ ?? "Asia/Kolkata";
const DAY = 86_400_000;

export class HearthError extends Error {}

const parse = <T>(s: string): T => JSON.parse(s) as T;
const ref = (m: Member) => m.relation || m.name;
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });

function requireMember(name: string): Member {
  const m = findMember(name);
  if (!m) {
    const names = allMembers().map((x) => x.name).join(", ") || "none yet";
    throw new HearthError(`I don't know anyone called "${name}" in this family. Members: ${names}.`);
  }
  return m;
}

/** Child journals are visible to that child and to parents only. Private entries only to their author. */
function canSee(viewer: Member, entry: Entry): boolean {
  if (entry.member_id === viewer.id) return true;
  if (entry.private) return false;
  const author = memberById(entry.member_id);
  if (author.role === "child") return viewer.is_parent === 1;
  return true;
}

// ───────────────────────────── members ─────────────────────────────

export function registerMember(input: {
  name: string; role: Role; age?: number | null; relation?: string | null; is_parent?: boolean; photo?: string | null;
}): Member {
  if (findMember(input.name)) throw new HearthError(`${input.name} is already part of the family.`);
  return insertMember({
    name: input.name.trim(),
    role: input.role,
    age: input.age ?? null,
    relation: input.relation?.trim() || null,
    is_parent: input.is_parent ? 1 : 0,
    photo: input.photo ?? null,
  });
}

export function familyOverview() {
  return allMembers().map((m) => {
    const entries = entriesFor(m.id);
    return {
      name: m.name, role: m.role, age: m.age, called: m.relation, is_parent: !!m.is_parent, photo: m.photo,
      entries: entries.length,
      week_entries: entries.filter((e) => Date.parse(e.created_at) >= Date.now() - 7 * DAY).length,
      waiting: pendingThreadsFor(m.id).length,
      streak_days: streak(entries),
      last_entry: entries.at(-1) ? fmtDate(entries.at(-1)!.created_at) : null,
    };
  });
}

function streak(entries: Entry[]): number {
  const days = new Set(entries.map((e) => new Date(e.created_at).toLocaleDateString("en-CA", { timeZone: TZ })));
  let n = 0;
  for (let d = new Date(); ; d = new Date(d.getTime() - DAY)) {
    const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
    if (days.has(key)) n++;
    else if (n > 0 || key !== new Date().toLocaleDateString("en-CA", { timeZone: TZ })) break;
  }
  return n;
}

// ───────────────────────────── sessions & prompts ─────────────────────────────

export function startSession(name: string) {
  const m = requireMember(name);
  const entries = entriesFor(m.id);
  const pending = pendingThreadsFor(m.id);
  const mode = m.role === "child" ? "speaking_practice" : m.role === "adult" ? "daily_log" : "memoir";
  const s = streak(entries);
  const greeting =
    m.role === "child"
      ? `Hi ${m.name}! Ready to tell me about your day?${s > 1 ? ` That's ${s} days in a row — amazing!` : ""}`
      : m.role === "elder"
        ? `Hello ${m.name}. I've been looking forward to today's story.`
        : `Hi ${m.name}. Quick check-in?`;
  return {
    member: { name: m.name, role: m.role, age: m.age, called: m.relation },
    mode,
    style_guide: STYLE_GUIDE[m.role],
    greeting,
    streak_days: s,
    total_entries: entries.length,
    family_threads_waiting: pending.length,
    next_step: "Call get_journal_prompt to get today's question for this member.",
  };
}

export function nextPrompt(name: string) {
  const m = requireMember(name);
  const pending = pendingThreadsFor(m.id);
  // Story bridges beat care nudges for kids; care nudges go first for adults (they're time-sensitive).
  const pick =
    pending.find((t) => (m.role === "adult" ? t.kind === "care_nudge" : t.kind === "story_bridge")) ?? pending[0];
  if (pick) {
    const from = memberById(pick.from_member_id);
    return {
      prompt: pick.prompt,
      thread_id: pick.id,
      source: pick.kind === "care_nudge" ? "family care nudge" : `story thread from ${from.name}${from.relation && from.relation !== from.name ? ` (${from.relation})` : ""}`,
      chapter: null as string | null,
      style_guide: STYLE_GUIDE[m.role],
      instructions: "Read the prompt aloud. Pass thread_id to save_journal_entry with the answer.",
    };
  }
  const count = entriesFor(m.id).length;
  if (m.role === "elder") {
    const covered = new Set(entriesFor(m.id).map((e) => e.prompt));
    const next = MEMOIR_FLAT.find((q) => !covered.has(q.question)) ?? MEMOIR_FLAT[count % MEMOIR_FLAT.length];
    return {
      prompt: next.question, thread_id: null as number | null, source: "memoir", chapter: next.chapter,
      style_guide: STYLE_GUIDE.elder,
      instructions: "Read the prompt aloud, then pass it as `prompt` to save_journal_entry with the answer.",
    };
  }
  const bank = bankFor(m.role);
  return {
    prompt: bank[count % bank.length], thread_id: null as number | null, source: "daily", chapter: null as string | null,
    style_guide: STYLE_GUIDE[m.role],
    instructions: "Read the prompt aloud, then pass it as `prompt` to save_journal_entry with the answer.",
  };
}

// ───────────────────────────── saving entries ─────────────────────────────

interface Extraction {
  summary: string;
  mood: string | null;
  topics: string[];
  people: string[];
  recast?: string;
  follow_up?: string;
  bridges?: { to: string; prompt: string }[];
  care?: { about: string; nudge: string } | null;
}

const NEGATIVE = ["tired", "sad", "angry", "sick", "crying", "cried", "upset", "worried", "headache", "unwell", "grumpy", "stressed", "shouted"];
const KID_FOLLOWUPS = [
  "What happened next?",
  "Who else was there?",
  "How did that make you feel?",
  "Can you describe what it looked like?",
  "What was the funniest part?",
  "If you did it again, what would you do differently?",
];

/** Who should hear about this entry, and as what kind of thread. */
function bridgeTargets(author: Member, isPrivate: boolean, wordCount: number): Member[] {
  if (isPrivate || wordCount < 12) return [];
  const others = allMembers().filter((x) => x.id !== author.id);
  if (author.role === "elder") return others.filter((x) => x.role === "child");
  if (author.role === "child") return others.filter((x) => x.role === "elder");
  return [];
}

/** Care nudges: a child mentions a family member alongside a worry word. Never quotes the child. */
function detectCare(author: Member, text: string): Member | null {
  if (author.role !== "child") return null;
  const words = new Set(tokenize(text));
  if (!NEGATIVE.some((w) => words.has(w))) return null;
  return (
    allMembers().find(
      (x) => x.id !== author.id && x.role !== "child" &&
        [x.name, x.relation ?? ""].some((n) => n && words.has(n.toLowerCase())),
    ) ?? null
  );
}

async function extract(author: Member, text: string, prompt: string | null, targets: Member[], careAbout: Member | null): Promise<Extraction> {
  const family = allMembers().map((x) => `${x.name} (${x.role}${x.relation ? `, called "${x.relation}"` : ""}${x.age ? `, age ${x.age}` : ""})`).join("; ");
  const ai = llmEnabled()
    ? await completeJson<Extraction>(
        `You are Hearth, a warm family-memory assistant inside Alexa+. Family: ${family}.
Given one journal entry, return JSON with:
- summary: one sentence, third person, past tense, specific (who/what/where).
- mood: one word or null.
- topics: 1-4 short lowercase topic phrases.
- people: names or relations mentioned.
${author.role === "child" ? `- recast: the child is ${author.age ?? "young"}. Repeat their main idea back as ONE fuller, richer sentence (the "recasting" technique speech educators use): keep their meaning, add one or two descriptive words, never say they were wrong. Speak to them as "you".
- follow_up: one short, open question about a specific detail they mentioned.` : ""}
${targets.length ? `- bridges: for each of [${targets.map((t) => `${t.name} (${t.role}, age ${t.age ?? "?"})`).join(", ")}], write a prompt Alexa will ask THEM later, that shares a small, kind piece of this story (refer to the author as "${ref(author)}") and invites their own related memory. Age-appropriate, one or two sentences. Format: [{"to": name, "prompt": text}].` : ""}
${careAbout ? `- care: the child mentioned ${careAbout.name} may not be feeling great. Write {"about": "${careAbout.name}", "nudge": text} — a gentle suggestion for OTHER adults to check in on ${careAbout.name}. NEVER reveal the child said anything or quote them.` : ""}`,
        `${prompt ? `Question asked: ${prompt}\n` : ""}Entry by ${author.name}: ${text}`,
        700,
      )
    : null;

  const metrics = analyze(text);
  const fallbackTopics = topKeywords(text);
  const out: Extraction = {
    summary: ai?.summary || `${author.name}: ${firstSentence(text)}`,
    mood: ai?.mood ?? guessMood(text),
    topics: ai?.topics?.length ? ai.topics : fallbackTopics,
    people: ai?.people ?? [],
    recast: ai?.recast,
    follow_up: ai?.follow_up,
    bridges: ai?.bridges,
    care: ai?.care ?? null,
  };
  if (author.role === "child") {
    out.recast ??= metrics.word_count < 8
      ? `Ooh — "${firstSentence(text)}" Tell me more so I can picture it!`
      : `Wow, so ${firstSentence(text).replace(/^i /i, "you ").replace(/\bI\b/g, "you").replace(/\bmy\b/gi, "your")}`;
    out.follow_up ??= KID_FOLLOWUPS[text.length % KID_FOLLOWUPS.length];
  }
  // Fill any missing bridges with templates.
  const have = new Set((out.bridges ?? []).map((b) => b.to.toLowerCase()));
  out.bridges = [...(out.bridges ?? [])];
  for (const t of targets) {
    if (have.has(t.name.toLowerCase())) continue;
    out.bridges.push({
      to: t.name,
      prompt:
        author.role === "elder"
          ? `${ref(author)} told me a story: "${firstSentence(text)}" Isn't that something? Have you ever done anything like that? Tell me about it!`
          : `${ref(author)} told me something today: "${firstSentence(text)}" What does that remind you of from when you were young?`,
    });
  }
  if (careAbout && !out.care) {
    out.care = {
      about: careAbout.name,
      nudge: `Small nudge: it might be a good day to check in on ${careAbout.name} — maybe make them a cup of tea or take something off their plate tonight.`,
    };
  }
  return out;
}

export async function saveEntry(input: {
  name: string; transcript: string; prompt?: string | null; thread_id?: number | null; private?: boolean; at?: string;
}) {
  const m = requireMember(input.name);
  const text = input.transcript.trim();
  if (!text) throw new HearthError("The journal entry was empty — ask the question again.");
  const at = input.at ?? nowIso();
  const isPrivate = !!input.private || /\b(keep (this|it) private|just between us|don't tell anyone)\b/i.test(text);

  const metrics = analyze(text);
  const names = properNouns(text);
  const fresh = recordVocabulary(m.id, tokenize(text), at).filter((w) => !names.has(w));
  const targets = bridgeTargets(m, isPrivate, metrics.word_count);
  const careAbout = detectCare(m, text);
  const x = await extract(m, text, input.prompt ?? null, targets, careAbout);

  const chapter = m.role === "elder"
    ? (MEMOIR_FLAT.find((q) => q.question === input.prompt)?.chapter ??
        (input.thread_id ? "Talks with the grandchildren" : "Stories"))
    : null;

  const entry = insertEntry({
    member_id: m.id, created_at: at, prompt: input.prompt ?? null, transcript: text,
    summary: x.summary, mood: x.mood, topics: JSON.stringify(x.topics), people: JSON.stringify(x.people),
    private: isPrivate ? 1 : 0, word_count: metrics.word_count, mlu: metrics.mlu,
    unique_words: metrics.unique_words, new_words: JSON.stringify(fresh), chapter,
  });

  if (input.thread_id) markThreadUsed(input.thread_id);

  // Create threads for other members.
  let threadsCreated = 0;
  for (const b of x.bridges ?? []) {
    const to = findMember(b.to);
    if (!to || to.id === m.id) continue;
    // Keep one waiting story per (from → to) pair: a newer story replaces an unheard older one.
    supersedePending(m.id, to.id, "story_bridge");
    insertThread({ kind: "story_bridge", source_entry_id: entry.id, from_member_id: m.id, to_member_id: to.id, prompt: b.prompt, created_at: at });
    threadsCreated++;
  }
  if (x.care) {
    const about = findMember(x.care.about);
    for (const adult of allMembers().filter((a) => a.role !== "child" && a.id !== about?.id && a.is_parent)) {
      const already = pendingThreadsFor(adult.id).some((t) => t.kind === "care_nudge");
      if (already) continue;
      insertThread({ kind: "care_nudge", source_entry_id: entry.id, from_member_id: m.id, to_member_id: adult.id, prompt: x.care.nudge, created_at: at });
      threadsCreated++;
    }
  }

  // Role-specific feedback for Alexa+ to say.
  const base = {
    saved: true, entry_id: entry.id, private: isPrivate, summary: x.summary, mood: x.mood,
    family_threads_created: threadsCreated,
  };
  if (m.role === "child") {
    const notable = notableWords(fresh);
    return {
      ...base,
      recast: x.recast,
      follow_up: x.follow_up,
      new_words_today: notable,
      words_used: metrics.word_count,
      say: `${x.recast} ${x.follow_up}${notable.length ? ` (Celebrate: "${notable[0]}" is a new word for ${m.name}!)` : ""}`,
    };
  }
  if (m.role === "adult") {
    const pattern = adultPattern(m);
    return { ...base, pattern, say: pattern ? `Got it, saved. One thing I noticed: ${pattern}` : "Got it, saved to your log." };
  }
  return {
    ...base, chapter,
    memoir_progress: memoirProgress(m),
    say: `Thank you, ${m.name}. That's now part of the "${chapter}" chapter of your story.${threadsCreated ? " I'll share a little of it with the grandchildren." : ""}`,
  };
}

function adultPattern(m: Member): string | null {
  const week = entriesFor(m.id, new Date(Date.now() - 7 * DAY).toISOString());
  const moods = new Map<string, number>();
  for (const e of week) if (e.mood && ["tired", "worried", "sad"].includes(e.mood)) moods.set(e.mood, (moods.get(e.mood) ?? 0) + 1);
  for (const [mood, n] of moods) if (n >= 3) return `you've mentioned feeling ${mood} on ${n} days this week. Want me to remind you to take a proper break tomorrow?`;
  const topics = new Map<string, number>();
  for (const e of week) for (const t of parse<string[]>(e.topics)) topics.set(t, (topics.get(t) ?? 0) + 1);
  for (const [t, n] of topics) if (n >= 3) return `"${t}" has come up ${n} times this week.`;
  return null;
}

function memoirProgress(m: Member) {
  const entries = entriesFor(m.id);
  const chapters = MEMOIR.map((c) => ({
    chapter: c.chapter,
    stories: entries.filter((e) => e.chapter === c.chapter).length,
    questions: c.questions.length as number | null,
  }));
  for (const extra of ["Talks with the grandchildren", "Stories"]) {
    const n = entries.filter((e) => e.chapter === extra).length;
    if (n) chapters.push({ chapter: extra, stories: n, questions: null });
  }
  return chapters;
}

// ───────────────────────────── kids' language progress ─────────────────────────────

export function languageProgress(childName: string, requestedBy: string, days = 28) {
  const child = requireMember(childName);
  const viewer = requireMember(requestedBy);
  if (child.role !== "child") throw new HearthError(`${child.name} isn't set up as a child, so there's no speaking-practice report.`);
  if (!viewer.is_parent && viewer.id !== child.id) throw new HearthError(`Only a parent can see ${child.name}'s speaking progress.`);

  const now = Date.now();
  const since = new Date(now - days * DAY);
  const entries = entriesFor(child.id, since.toISOString());
  const weeks: { week: string; entries: number; avg_words: number; avg_mlu: number; vocabulary: number; new_words: string[] }[] = [];
  for (let start = since.getTime(); start < now - DAY; start += 7 * DAY) {
    const end = Math.min(start + 7 * DAY, now);
    const wk = entries.filter((e) => { const t = Date.parse(e.created_at); return t >= start && t < end; });
    weeks.push({
      week: fmtDate(new Date(start).toISOString()),
      entries: wk.length,
      avg_words: wk.length ? round(wk.reduce((s, e) => s + e.word_count, 0) / wk.length) : 0,
      avg_mlu: wk.length ? round(wk.reduce((s, e) => s + e.mlu, 0) / wk.length) : 0,
      vocabulary: vocabularySize(child.id, new Date(end).toISOString()),
      new_words: notableWords(wk.flatMap((e) => parse<string[]>(e.new_words))).slice(0, 12),
    });
  }
  const active = weeks.filter((w) => w.entries > 0);
  const first = active[0];
  const last = active.at(-1);
  const change = (a?: number, b?: number) => (a && b ? Math.round(((b - a) / a) * 100) : 0);
  const mluChange = change(first?.avg_mlu, last?.avg_mlu);
  const wordsChange = change(first?.avg_words, last?.avg_words);
  const recentNew = notableWords(entries.slice(-5).flatMap((e) => parse<string[]>(e.new_words))).slice(0, 8);

  return {
    child: child.name, age: child.age, period_days: days,
    practice_sessions: entries.length,
    streak_days: streak(entriesFor(child.id)),
    vocabulary_size: vocabularySize(child.id),
    sentence_length_change_pct: mluChange,
    words_per_answer_change_pct: wordsChange,
    recent_new_words: recentNew,
    weekly: weeks,
    note: "Practice and engagement indicators, not a clinical assessment. Talk to a speech-language professional if you have concerns.",
    say:
      `${child.name} practised ${entries.length} times in the last ${days} days. ` +
      (first && last && first !== last
        ? `Compared with the first week, their sentences are ${describeChange(mluChange)} and their answers are ${describeChange(wordsChange)}. `
        : "") +
      (recentNew.length ? `New words lately: ${recentNew.slice(0, 4).join(", ")}.` : ""),
  };
}

function describeChange(pct: number): string {
  if (pct >= 100) return `about ${round(1 + pct / 100)} times as long`;
  if (pct > 0) return `${pct}% longer`;
  if (pct < 0) return `${-pct}% shorter`;
  return "about the same length";
}

// ───────────────────────────── threads, recall, radio ─────────────────────────────

export function listThreads(forName?: string) {
  const rows: Thread[] = forName ? pendingThreadsFor(requireMember(forName).id) : allThreads(40);
  return rows.map((t) => ({
    id: t.id, kind: t.kind, status: t.status,
    // Care nudges never reveal who triggered them.
    from: t.kind === "care_nudge" ? "Hearth" : memberById(t.from_member_id).name,
    to: memberById(t.to_member_id).name,
    prompt: t.prompt,
    created: fmtDate(t.created_at),
  }));
}

export function recall(question: string, askedBy: string, limit = 5) {
  const viewer = requireMember(askedBy);
  const q = new Set(tokenize(question).filter((w) => w.length > 2));
  const members = new Map(allMembers().map((m) => [m.id, m]));
  const visible = (db.prepare("SELECT * FROM entries ORDER BY created_at DESC").all() as unknown as Entry[]).filter((e) => canSee(viewer, e));
  const scored = visible
    .map((e) => {
      const author = members.get(e.member_id)!;
      const hay = tokenize(`${e.transcript} ${e.summary} ${e.topics} ${author.name} ${author.relation ?? ""}`);
      const score = hay.filter((w) => q.has(w)).length;
      return { e, author, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.e.created_at.localeCompare(a.e.created_at))
    .slice(0, limit);
  return {
    question, asked_by: viewer.name,
    matches: scored.map(({ e, author }) => ({ date: fmtDate(e.created_at), who: author.name, summary: e.summary, said: e.transcript })),
    instructions: scored.length
      ? "Answer the question in one or two spoken sentences using only these matches. Mention who said it and when."
      : "Say you couldn't find that in the family's journal yet.",
  };
}

export async function familyRadio(requestedBy: string, days = 7) {
  requireMember(requestedBy);
  const since = new Date(Date.now() - days * DAY).toISOString();
  const entries = sharedEntriesSince(since);
  const members = allMembers();
  const byMember = members.map((m) => ({ m, es: entries.filter((e) => e.member_id === m.id) })).filter((x) => x.es.length);
  if (!byMember.length) return { script: "It's been a quiet week at home — no stories yet. Tell me about your day and I'll have an episode ready next Sunday!", segments: [] };

  const kidWords = members
    .filter((m) => m.role === "child")
    .map((m) => ({ name: m.name, words: notableWords(entries.filter((e) => e.member_id === m.id).flatMap((e) => parse<string[]>(e.new_words))).sort((a, b) => b.length - a.length) }))
    .filter((k) => k.words.length);
  // Prefer upbeat, detailed moments for highlights.
  const warmth = (e: Entry) => e.word_count + (["happy", "calm", "nostalgic"].includes(e.mood ?? "") ? 40 : 0) - (["tired", "worried", "sad"].includes(e.mood ?? "") ? 30 : 0);
  const pick = (es: Entry[]) => [...es].sort((a, b) => warmth(b) - warmth(a))[0];

  const material = byMember
    .map(({ m, es }) => `${m.name} (${m.relation ?? m.role}): ${es.map((e) => `[${fmtDate(e.created_at)}] ${e.summary}`).join(" ")}`)
    .join("\n");
  const ai = llmEnabled()
    ? await completeJson<{ script: string }>(
        `You write "Family Radio", a warm 2-3 minute weekly audio episode Alexa reads to a family on Sunday evening.
Sections: a cheerful intro, one highlight per family member (specific and affectionate), "Word of the Week" celebrating a new word a child used, a "From the memory box" moment from the grandparent's memoir, and a short outro that suggests one thing the family could do together this week based on their stories.
Plain spoken English, no stage directions, no emojis, under 380 words. Return {"script": "..."}.`,
        `This week's journal summaries:\n${material}\nNew words the kids used: ${kidWords.map((k) => `${k.name}: ${k.words.slice(0, 5).join(", ")}`).join("; ") || "none"}`,
        900,
      )
    : null;

  const segments = byMember.map(({ m, es }) => ({ member: m.name, highlight: pick(es).summary, entries: es.length }));
  const elder = byMember.find((x) => x.m.role === "elder");
  const script =
    ai?.script ??
    [
      `Good evening, and welcome to Family Radio — your week at home, in three minutes.`,
      ...byMember
        .filter((x) => x.m.role !== "elder")
        .map(({ m, es }) => `${m.name} checked in ${es.length} time${es.length > 1 ? "s" : ""} this week. A highlight: ${pick(es).summary.replace(/^[^:]+:\s*/, "")}`),
      ...kidWords.map((k) => `Word of the Week goes to ${k.name}, who used "${k.words[0]}" for the very first time. Give them a round of applause!`),
      ...(elder ? [`From the memory box: ${ref(elder.m)} remembered — ${pick(elder.es).summary.replace(/^[^:]+:\s*/, "")}`] : []),
      `That's this week's Family Radio. Ask each other one question about these stories at dinner tonight. Good night!`,
    ].join("\n\n");

  return { generated_with: ai ? "bedrock" : "template", period_days: days, segments, word_of_the_week: kidWords, script };
}

const childFirstAndLatest = (k: Member) => {
  const es = entriesFor(k.id);
  const latest = [...es].reverse().find((e) => e.word_count >= 15) ?? es.at(-1);
  return {
    first_answer: es[0] ? { date: fmtDate(es[0].created_at), text: es[0].transcript, words: es[0].word_count } : null,
    latest_answer: latest ? { date: fmtDate(latest.created_at), text: latest.transcript, words: latest.word_count } : null,
  };
};

/** Everything the family dashboard's arc shows, in one call. Children can't open the dashboard. */
export function dashboard(viewerName: string) {
  const viewer = requireMember(viewerName);
  if (viewer.role === "child") throw new HearthError("The family dashboard is for the grown-ups.");
  const members = allMembers();
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const timeline = sharedEntriesSince(weekAgo)
    .filter((e) => canSee(viewer, e))
    .reverse()
    .map((e) => {
      const a = memberById(e.member_id);
      return { id: e.id, date: fmtDate(e.created_at), at: e.created_at, who: a.name, role: a.role, summary: e.summary, text: e.transcript, mood: e.mood, chapter: e.chapter };
    });
  const kids = viewer.is_parent
    ? members.filter((m) => m.role === "child").map((k) => ({ ...languageProgress(k.name, viewer.name), ...childFirstAndLatest(k) }))
    : [];
  const recentThreads = (db.prepare("SELECT * FROM threads WHERE created_at >= ? AND status != 'superseded' ORDER BY created_at").all(
    new Date(Date.now() - 21 * DAY).toISOString(),
  ) as unknown as Thread[]).map((t) => ({
    id: t.id, kind: t.kind, status: t.status,
    from: t.kind === "care_nudge" ? null : memberById(t.from_member_id).name, // care nudges never show their source
    to: memberById(t.to_member_id).name,
  }));
  return {
    viewer: viewer.name,
    viewers: members.filter((m) => m.role !== "child").map((m) => m.name),
    family: familyOverview(),
    week: { stories: sharedEntriesSince(weekAgo).length, waiting: recentThreads.filter((t) => t.status === "pending").length },
    kids, threads: recentThreads, timeline,
  };
}

/** One member's journal as `viewer` is allowed to see it — the panel under the arc. */
export function memberJournal(viewerName: string, name: string) {
  const viewer = requireMember(viewerName);
  const m = requireMember(name);
  const self = viewer.id === m.id;
  const person = { name: m.name, called: m.relation, role: m.role, age: m.age, photo: m.photo };
  const mode = m.role === "child" ? "Speaking practice" : m.role === "elder" ? "Memoir" : "Daily log";
  if (m.role === "child" && !viewer.is_parent && !self) {
    return { person, mode, locked: true, reason: `Only ${m.name}'s parents can open ${m.name}'s journal.` };
  }
  const all = entriesFor(m.id);
  const weekAgo = Date.now() - 7 * DAY;
  const entries = [...all].reverse().slice(0, 12).map((e) =>
    canSee(viewer, e)
      ? { id: e.id, date: fmtDate(e.created_at), text: e.transcript, mood: e.mood, chapter: e.chapter, prompt: e.prompt, private: !!e.private }
      : { id: e.id, date: fmtDate(e.created_at), hidden: true as const },
  );
  const waiting = pendingThreadsFor(m.id).map((t) =>
    t.kind === "care_nudge" && !self
      ? { kind: t.kind, hidden: true as const }
      : { kind: t.kind, from: t.kind === "care_nudge" ? null : memberById(t.from_member_id).name, prompt: t.prompt },
  );
  const base = { person, mode, locked: false, streak_days: streak(all), entries, waiting };

  if (m.role === "child") {
    const p = languageProgress(m.name, self ? m.name : viewer.name);
    return {
      ...base,
      stats: [
        { value: describeTimes(p.sentence_length_change_pct), label: "longer sentences than week one" },
        { value: String(p.vocabulary_size), label: "different words used" },
        { value: `${p.streak_days} ${p.streak_days === 1 ? "day" : "days"}`, label: "practice streak" },
      ],
      progress: { weekly: p.weekly, recent_new_words: p.recent_new_words, note: p.note },
      ...childFirstAndLatest(m),
    };
  }
  if (m.role === "elder") {
    const chapters = memoirProgress(m);
    return {
      ...base,
      stats: [
        { value: String(all.length), label: "stories told" },
        { value: `${chapters.filter((c) => c.questions && c.stories > 0).length} of ${MEMOIR.length}`, label: "chapters started" },
        { value: String(all.filter((e) => e.chapter === "Talks with the grandchildren").length), label: "talks with grandchildren" },
      ],
      chapters,
    };
  }
  return {
    ...base,
    stats: [
      { value: String(all.filter((e) => Date.parse(e.created_at) >= weekAgo).length), label: "check-ins this week" },
      base.streak_days > 1
        ? { value: `${base.streak_days} days`, label: "streak" }
        : { value: all.length ? fmtDate(all.at(-1)!.created_at).replace(/^\w+,\s*/, "") : "None yet", label: "last check-in" },
      { value: String(all.filter((e) => e.private).length), label: "private entries" },
    ],
    // Patterns are personal: only the person themselves sees what Hearth noticed.
    noticed: self ? adultPattern(m) : null,
  };
}

function describeTimes(pct: number): string {
  if (pct >= 100) return `${round(1 + pct / 100)}×`;
  return `${pct > 0 ? "+" : ""}${pct}%`;
}
