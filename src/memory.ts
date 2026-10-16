// Hearth core logic. The MCP tools (server.ts) and the dashboard API both call into here.
//
// Who can see what (enforced here, for voice and dashboard alike):
//   • "Household" view (nobody has unlocked): shared grown-up entries only — no children's journals.
//   • A person sees everything of their own, including private entries.
//   • Parents also see their children's journals and progress.
//   • Private entries: only the author. Sensitive entries (possible safety disclosures): only the
//     author — not even parents, because the person told could be the person causing harm.
//   • Family conversations: the people who were there, plus parents.
import {
  allEntriesNewestFirst, allMembers, allThreads, bumpVersion, clearVocabulary, conversationById,
  conversationTurns, dataVersion, deleteEntryRow, entriesFor, entriesOlderThan, entryById, findMember,
  getSetting, insertConversation, insertEntry, insertMember, insertThread, markThreadUsed, memberById,
  nowIso, pendingThreadsFor, recordVocabulary, setSetting, sharedEntriesSince, supersedePending,
  threadById, threadsSince, updateConversationSummary, updateEntryEnrichment, updateEntryNewWords, vocabularySize,
  type Entry, type Member, type Role, type Thread,
} from "./db.js";
import { hashPin, hasPin, pinMatches } from "./auth.js";
import { analyze, bigWords, firstSentence, guessMood, properNouns, round, simpleFollowUp, simpleRecast, tokenize, topKeywords } from "./language.js";
import { completeJson, llmEnabled } from "./llm.js";
import {
  CONVERSATION_SUMMARY_SYSTEM, MEMOIR, MEMOIR_FLAT, RADIO_SYSTEM, STYLE_GUIDE, TABLE_QUESTIONS, bankFor, bridgeRules, recastRules,
} from "./prompts.js";
import { careTarget, checkSafety, looksLikeSummary, okForChild, safetyReply } from "./safety.js";

const TZ = process.env.HEARTH_TZ ?? "Europe/London";
const DAY = 86_400_000;
const PAGE = 12;
const QUICK_DELETE_MINUTES = 15; // "Alexa, delete what I just said" needs no PIN inside this window

export class HearthError extends Error {}

/** null = the household view: what anyone in the home may see without unlocking. */
export type Viewer = Member | null;

const parse = <T>(s: string): T => JSON.parse(s) as T;
const ref = (m: Member) => m.relation || m.name;
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });

export function requireMember(name: string): Member {
  const m = findMember(name);
  if (!m) {
    const names = allMembers().map((x) => x.name).join(", ") || "none yet";
    throw new HearthError(`I don't know anyone called "${name}" in this family. Members: ${names}.`);
  }
  return m;
}

/**
 * Resolves who is asking over voice. Without voice ID, a person with a PIN is only "verified"
 * once they say it. Unverified people get the household view for anything parent-level.
 */
export function voiceViewer(name: string, pin?: string | null): { member: Member; verified: boolean } {
  const member = requireMember(name);
  if (!hasPin(member)) return { member, verified: true };
  if (pin === undefined || pin === null || pin === "") return { member, verified: false };
  if (!pinMatches(member, pin)) throw new HearthError(`That PIN didn't match ${member.name}'s. Try again.`);
  return { member, verified: true };
}

function participantsOf(conversationId: number): number[] {
  const c = conversationById(conversationId);
  return c ? parse<number[]>(c.participants) : [];
}

export function canSee(viewer: Viewer, entry: Entry): boolean {
  if (viewer && entry.member_id === viewer.id) return true;
  if (entry.sensitive || entry.private) return false;
  const author = memberById(entry.member_id);
  if (entry.conversation_id) {
    const people = participantsOf(entry.conversation_id);
    if (viewer && (people.includes(viewer.id) || viewer.is_parent)) return true;
    if (!viewer) return !people.some((id) => memberById(id)?.role === "child");
    return author.role !== "child" && !people.some((id) => memberById(id)?.role === "child");
  }
  if (author.role === "child") return !!viewer?.is_parent;
  return true;
}

function canDelete(viewer: Member, entry: Entry): boolean {
  if (entry.member_id === viewer.id) return true;
  const author = memberById(entry.member_id);
  return author.role === "child" && !!viewer.is_parent && !entry.sensitive;
}

// ───────────────────────────── members ─────────────────────────────

export function registerMember(input: {
  name: string; role: Role; age?: number | null; relation?: string | null; is_parent?: boolean;
  photo?: string | null; pin?: string | null;
  /** Children only: the parent adding the profile, who confirms consent. */
  added_by?: string | null; parent_consent?: boolean;
}): Member {
  if (findMember(input.name)) throw new HearthError(`${input.name} is already part of the family.`);
  let consentBy: number | null = null;
  if (input.role === "child") {
    const parent = input.added_by ? findMember(input.added_by) : undefined;
    if (!parent || !parent.is_parent) {
      throw new HearthError("A parent needs to add a child's profile. Tell me which parent is setting it up.");
    }
    if (!input.parent_consent) {
      throw new HearthError(
        `Before I set up ${input.name}'s journal, ${parent.name}: Hearth will save what ${input.name} says, track ` +
        `their speaking practice, and only parents can read it. You can delete anything at any time. Do you agree?`,
      );
    }
    consentBy = parent.id;
  }
  if (input.pin && !/^\d{4,6}$/.test(input.pin)) throw new HearthError("A PIN is 4 to 6 digits.");
  return insertMember({
    name: input.name.trim(),
    role: input.role,
    age: input.age ?? null,
    relation: input.relation?.trim() || null,
    is_parent: input.is_parent ? 1 : 0,
    photo: input.photo ?? null,
    pin_hash: input.pin && input.role !== "child" ? hashPin(input.pin) : null,
    consent_by: consentBy,
    consent_at: consentBy ? nowIso() : null,
  });
}

export function familyOverview() {
  return allMembers().map((m) => {
    const entries = entriesFor(m.id);
    return {
      name: m.name, role: m.role, age: m.age, called: m.relation, is_parent: !!m.is_parent, photo: m.photo,
      has_pin: hasPin(m),
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

export const careNudgesOn = () => (getSetting("care_nudges") ?? process.env.HEARTH_CARE_NUDGES ?? "off") === "on";

export function setCareNudges(on: boolean, by: string, pin?: string | null) {
  const { member, verified } = voiceViewer(by, pin);
  if (!member.is_parent) throw new HearthError("Only a parent can change care nudges.");
  if (!verified) throw new HearthError(`Please say your PIN, ${member.name}, to change family settings.`);
  setSetting("care_nudges", on ? "on" : "off");
  bumpVersion();
  return {
    care_nudges: on ? "on" : "off",
    say: on
      ? "Care nudges are on. If a child mentions someone seems tired or unwell, I'll gently suggest another grown-up checks in. I never say who mentioned it."
      : "Care nudges are off.",
  };
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
  // Story bridges first for kids; care nudges first for adults (they're time-sensitive).
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

/** Who should hear about this entry as a story bridge. */
function bridgeTargets(author: Member, shareable: boolean, wordCount: number): Member[] {
  if (!shareable || wordCount < 12) return [];
  const others = allMembers().filter((x) => x.id !== author.id);
  if (author.role === "elder") return others.filter((x) => x.role === "child");
  if (author.role === "child") return others.filter((x) => x.role === "elder");
  return [];
}

async function extract(author: Member, text: string, prompt: string | null, targets: Member[], careAbout: Member | null, useAI: boolean): Promise<Extraction> {
  const family = allMembers().map((x) => `${x.name} (${x.role}${x.relation ? `, called "${x.relation}"` : ""}${x.age ? `, age ${x.age}` : ""})`).join("; ");
  const ai = useAI && llmEnabled()
    ? await completeJson<Extraction>(
        `You are Hearth, a warm family-memory assistant inside Alexa+. Family: ${family}.
Given one journal entry, return JSON with:
- summary: one sentence, third person, past tense, specific (who/what/where).
- mood: one word or null.
- topics: 1-4 short lowercase topic phrases.
- people: names or relations mentioned.
${author.role === "child" ? recastRules(author.name, author.age) : ""}
${targets.length ? bridgeRules(ref(author), targets) : ""}
${careAbout ? `- care: the child mentioned ${careAbout.name} may be tired or unwell. Write {"about": "${careAbout.name}", "nudge": text} — a gentle suggestion for OTHER adults to check in on ${careAbout.name}. NEVER reveal a child said anything or quote them.` : ""}`,
        `${prompt ? `Question asked: ${prompt}\n` : ""}Entry by ${author.name}: ${text}`,
        700,
      )
    : null;

  const metrics = analyze(text);
  const out: Extraction = {
    summary: ai?.summary || `${author.name}: ${firstSentence(text)}`,
    mood: ai?.mood ?? guessMood(text),
    topics: ai?.topics?.length ? ai.topics : topKeywords(text),
    people: ai?.people ?? [],
    recast: ai?.recast,
    follow_up: ai?.follow_up,
    bridges: ai?.bridges,
    care: ai?.care ?? null,
  };
  if (author.role === "child") {
    // Quality guard: a recast should be only a little longer than what the child said, in plain words.
    const recastWords = out.recast ? tokenize(out.recast).length : 0;
    if (out.recast && (recastWords > metrics.word_count + 14 || /year[- ]old|exhilarat/i.test(out.recast))) out.recast = undefined;
    if (out.follow_up && tokenize(out.follow_up).length > 14) out.follow_up = undefined;
    out.recast ??= simpleRecast(text);
    out.follow_up ??= simpleFollowUp(text, text.length);
  }
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

// ───────────── Background work ─────────────
// Alexa+ expects an MCP reply in under 500 ms; a Bedrock call takes a couple of seconds. So the reply
// uses Hearth's own in-code recast and summary straight away, and Bedrock's richer summary, story
// bridges and care nudges are added in the background a moment later (the dashboard refreshes itself).
const pending = new Set<Promise<unknown>>();
function inBackground(task: () => Promise<unknown>) {
  const p = task().catch((err) => console.error("[hearth] background task failed:", (err as Error).message)).finally(() => pending.delete(p));
  pending.add(p);
}
/** Resolves when all background work has finished (used by scripts and tests). */
export async function whenIdle(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

async function createThreads(entry: Entry, author: Member, x: Extraction, at: string): Promise<{ created: number; held: number }> {
  let created = 0;
  let held = 0;
  for (const b of x.bridges ?? []) {
    const to = findMember(b.to);
    if (!to || to.id === author.id) continue;
    if (to.role === "child" && !(await okForChild(b.prompt))) { held++; continue; }
    supersedePending(author.id, to.id, "story_bridge"); // one waiting story per pair; newer replaces older
    insertThread({ kind: "story_bridge", source_entry_id: entry.id, from_member_id: author.id, to_member_id: to.id, prompt: b.prompt, created_at: at });
    created++;
  }
  if (x.care) {
    const about = findMember(x.care.about);
    for (const adult of allMembers().filter((a) => a.role !== "child" && a.id !== about?.id && a.is_parent)) {
      if (pendingThreadsFor(adult.id).some((t) => t.kind === "care_nudge")) continue;
      insertThread({ kind: "care_nudge", source_entry_id: entry.id, from_member_id: author.id, to_member_id: adult.id, prompt: x.care.nudge, created_at: at });
      created++;
    }
  }
  return { created, held };
}

function enrichLater(entry: Entry, author: Member, text: string, prompt: string | null, targets: Member[], careAbout: Member | null, at: string) {
  inBackground(async () => {
    const x = await extract(author, text, prompt, targets, careAbout, true);
    if (!entryById(entry.id)) return; // deleted meanwhile
    updateEntryEnrichment(entry.id, x.summary, x.mood, JSON.stringify(x.topics), JSON.stringify(x.people));
    await createThreads(entry, author, x, at);
    scheduleRadio();
  });
}

function childBigWords(m: Member, fresh: string[], prompt: string | null, text: string): string[] {
  return m.role === "child" ? bigWords(fresh, m.age, prompt, properNouns(text)) : [];
}

function requireConsent(m: Member) {
  if (m.role === "child" && !m.consent_at) {
    throw new HearthError(`A parent needs to confirm ${m.name}'s profile before I can save ${m.name}'s journal.`);
  }
}

export async function saveEntry(input: {
  name: string; transcript: string; prompt?: string | null; thread_id?: number | null; private?: boolean; at?: string;
}) {
  const m = requireMember(input.name);
  requireConsent(m);
  const text = input.transcript.trim();
  if (!text) throw new HearthError("The journal entry was empty — ask the question again.");
  if (looksLikeSummary(m, text)) {
    throw new HearthError(
      `That looks like a summary of what ${m.name} said. Hearth needs ${m.name}'s exact words, in first person, ` +
      `exactly as spoken — call save_journal_entry again with the verbatim transcript.`,
    );
  }
  const at = input.at ?? nowIso();
  const family = allMembers();
  const safety = checkSafety(text, family);
  const sensitive = safety.kind === "household_harm" || safety.kind === "self_harm";
  const isPrivate = sensitive || !!input.private || /\b(keep (this|it) private|just between us|don'?t tell anyone)\b/i.test(text);

  const metrics = analyze(text);
  const fresh = recordVocabulary(m.id, tokenize(text), at);
  const targets = bridgeTargets(m, !isPrivate && safety.kind === "none", metrics.word_count);
  const careAbout = !isPrivate && safety.kind === "none" && careNudgesOn() ? careTarget(m, text, family) : null;
  // Sensitive entries never go to the AI model or anywhere else. Everything else gets an instant
  // in-code extraction now, and Bedrock's richer one in the background.
  const background = !sensitive && llmEnabled();
  const x: Extraction = sensitive
    ? { summary: `${m.name}: private entry`, mood: null, topics: [], people: [] }
    : await extract(m, text, input.prompt ?? null, targets, careAbout, false);

  const chapter = m.role === "elder"
    ? (MEMOIR_FLAT.find((q) => q.question === input.prompt)?.chapter ??
        (input.thread_id ? "Talks with the grandchildren" : "Stories"))
    : null;

  const entry = insertEntry({
    member_id: m.id, created_at: at, prompt: input.prompt ?? null, transcript: text,
    summary: x.summary, mood: x.mood, topics: JSON.stringify(x.topics), people: JSON.stringify(x.people),
    private: isPrivate ? 1 : 0, sensitive: sensitive ? 1 : 0,
    word_count: metrics.word_count, mlu: metrics.mlu, unique_words: metrics.unique_words,
    new_words: JSON.stringify(sensitive ? [] : childBigWords(m, fresh, input.prompt ?? null, text)),
    chapter, conversation_id: null, turn: null,
  });

  if (input.thread_id && threadById(input.thread_id)?.to_member_id === m.id) markThreadUsed(input.thread_id);

  let threadsCreated = 0;
  let held = 0;
  if (background) {
    enrichLater(entry, m, text, input.prompt ?? null, targets, careAbout, at);
  } else if (!sensitive) {
    ({ created: threadsCreated, held } = await createThreads(entry, m, x, at));
    scheduleRadio();
  }
  const sharing = background && (targets.length > 0 || !!careAbout);

  const base = {
    saved: true, entry_id: entry.id, private: isPrivate, summary: x.summary, mood: x.mood,
    family_threads_created: threadsCreated,
    ...(sharing ? { family_threads: "being written in the background" } : {}),
    ...(held ? { held_back_for_child: held } : {}),
    can_delete: `If ${m.name} changes their mind, call delete_journal_entry within ${QUICK_DELETE_MINUTES} minutes — no PIN needed.`,
  };
  if (safety.kind !== "none") {
    return {
      ...base,
      safety: safety.kind,
      instructions: sensitive
        ? "Say the `say` text gently and stop the journal session. Do not repeat, summarise or mention this entry to anyone else in the household."
        : "Say the `say` text gently.",
      say: safetyReply(safety.kind, m),
    };
  }
  if (m.role === "child") {
    const words = parse<string[]>(entry.new_words);
    return {
      ...base,
      recast: x.recast,
      follow_up: x.follow_up,
      recast_note: `Say the recast warmly in your own voice if it reads stiffly — keep ${m.name}'s words, add only a few, use words a ${m.age ?? 7}-year-old knows, never correct them.`,
      big_words_today: words,
      words_used: metrics.word_count,
      say: `${x.recast} ${words.length ? `"${words[0][0].toUpperCase()}${words[0].slice(1)}" is a great new word! ` : ""}${x.follow_up}`,
    };
  }
  if (m.role === "adult") {
    const pattern = adultPattern(m);
    return { ...base, pattern, say: pattern ? `Got it, saved. One thing I noticed: ${pattern}` : "Got it, saved to your log." };
  }
  return {
    ...base, chapter,
    memoir_progress: memoirProgress(m),
    say: `Thank you, ${m.name}. That's now part of the "${chapter}" chapter of your story.${threadsCreated || sharing ? " I'll share a little of it with the grandchildren." : ""}`,
  };
}

function adultPattern(m: Member): string | null {
  const week = entriesFor(m.id, new Date(Date.now() - 7 * DAY).toISOString()).filter((e) => !e.sensitive);
  const moods = new Map<string, number>();
  for (const e of week) if (e.mood && ["tired", "worried", "sad"].includes(e.mood)) moods.set(e.mood, (moods.get(e.mood) ?? 0) + 1);
  for (const [mood, n] of moods) if (n >= 3) return `you've mentioned feeling ${mood} on ${n} days this week. Want me to remind you to take a proper break tomorrow?`;
  const topics = new Map<string, number>();
  for (const e of week) for (const t of parse<string[]>(e.topics)) topics.set(t, (topics.get(t) ?? 0) + 1);
  for (const [t, n] of topics) if (n >= 3) return `"${t}" has come up ${n} times this week.`;
  return null;
}

function memoirProgress(m: Member) {
  const entries = entriesFor(m.id).filter((e) => !e.sensitive);
  const chapters = MEMOIR.map((c) => ({
    chapter: c.chapter,
    stories: entries.filter((e) => e.chapter === c.chapter).length,
    questions: c.questions.length as number | null,
  }));
  for (const extra of ["Talks with the grandchildren", "At the family table", "Stories"]) {
    const n = entries.filter((e) => e.chapter === extra).length;
    if (n) chapters.push({ chapter: extra, stories: n, questions: null });
  }
  return chapters;
}

// ───────────────────────────── deleting & retention ─────────────────────────────

/** Re-derives a member's vocabulary and "big words" after entries are removed. */
function rebuildVocabulary(m: Member) {
  clearVocabulary(m.id);
  for (const e of entriesFor(m.id)) {
    const fresh = recordVocabulary(m.id, tokenize(e.transcript), e.created_at);
    updateEntryNewWords(e.id, e.sensitive ? [] : childBigWords(m, fresh, e.prompt, e.transcript));
  }
}

function removeEntry(entry: Entry) {
  deleteEntryRow(entry.id);
  rebuildVocabulary(memberById(entry.member_id));
  if (radioCache) radioCache = null; // never replay an episode that mentions a deleted entry
  scheduleRadio();
}

/** Delete from the dashboard: the viewer is already PIN-verified by their session. */
export function deleteEntryAs(viewer: Member, entryId: number) {
  const e = entryById(entryId);
  if (!e || !canSee(viewer, e)) throw new HearthError("That entry doesn't exist.");
  if (!canDelete(viewer, e)) throw new HearthError("Only the person who said it, or a child's parent, can delete an entry.");
  removeEntry(e);
  return { deleted: true, entry_id: entryId };
}

/** "Alexa, delete what I just said" — or a parent deleting a child's entry by voice. */
export function deleteByVoice(input: { name: string; entry_id?: number; for_member?: string; pin?: string | null }) {
  const { member, verified } = voiceViewer(input.name, input.pin);
  const owner = input.for_member ? requireMember(input.for_member) : member;
  const e = input.entry_id ? entryById(input.entry_id) : entriesFor(owner.id).filter((x) => !x.conversation_id || x.member_id === owner.id).at(-1);
  if (!e || e.member_id !== owner.id) throw new HearthError(`I couldn't find that entry in ${owner.name}'s journal.`);
  const own = owner.id === member.id;
  const recent = Date.now() - Date.parse(e.created_at) < QUICK_DELETE_MINUTES * 60_000;
  if (own && !recent && !verified) {
    throw new HearthError(`That entry is older than ${QUICK_DELETE_MINUTES} minutes. Please say your PIN to delete it, ${member.name}.`);
  }
  if (!own) {
    if (!(owner.role === "child" && member.is_parent)) throw new HearthError(`Only ${owner.name} can delete ${owner.name}'s entries.`);
    if (!verified) throw new HearthError(`Please say your PIN to delete ${owner.name}'s entry, ${member.name}.`);
  }
  removeEntry(e);
  return { deleted: true, entry_id: e.id, say: own ? "Done — I've deleted that. It's gone for good." : `Done — I've deleted that from ${owner.name}'s journal.` };
}

/**
 * How long Hearth keeps things. Grandparents' memoirs are kept until someone deletes them —
 * that's the point of a memoir. Day-to-day logs and kids' practice are kept for a year by default.
 */
export function retentionPolicy() {
  const days = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  return {
    child: days(process.env.HEARTH_KEEP_DAYS_CHILD, 365),
    adult: days(process.env.HEARTH_KEEP_DAYS_ADULT, 365),
    elder: days(process.env.HEARTH_KEEP_DAYS_ELDER, 0), // 0 = keep until deleted
  };
}

export function purgeExpired(): number {
  const policy = retentionPolicy();
  const touched = new Set<number>();
  let n = 0;
  for (const role of ["child", "adult", "elder"] as Role[]) {
    const keep = policy[role];
    if (!keep) continue;
    for (const e of entriesOlderThan([role], new Date(Date.now() - keep * DAY).toISOString())) {
      deleteEntryRow(e.id);
      touched.add(e.member_id);
      n++;
    }
  }
  for (const id of touched) rebuildVocabulary(memberById(id));
  return n;
}

// ───────────────────────────── kids' language progress ─────────────────────────────

export function languageProgress(child: Member, days = 28) {
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const entries = entriesFor(child.id, since.toISOString()).filter((e) => !e.sensitive);
  const weeks: { week: string; entries: number; avg_words: number; big_words: string[] }[] = [];
  for (let start = since.getTime(); start < now - DAY; start += 7 * DAY) {
    const end = Math.min(start + 7 * DAY, now);
    const wk = entries.filter((e) => { const t = Date.parse(e.created_at); return t >= start && t < end; });
    weeks.push({
      week: fmtDate(new Date(start).toISOString()),
      entries: wk.length,
      avg_words: wk.length ? round(wk.reduce((s, e) => s + e.word_count, 0) / wk.length) : 0,
      big_words: wk.flatMap((e) => parse<string[]>(e.new_words)),
    });
  }
  const active = weeks.filter((w) => w.entries > 0);
  const first = active[0];
  const last = active.at(-1);
  const wordsChange = first && last && first.avg_words ? Math.round(((last.avg_words - first.avg_words) / first.avg_words) * 100) : 0;
  const allBig = entriesFor(child.id).filter((e) => !e.sensitive).flatMap((e) => parse<string[]>(e.new_words));
  const recentBig = entries.slice(-6).flatMap((e) => parse<string[]>(e.new_words)).slice(-8);

  return {
    child: child.name, age: child.age, period_days: days,
    practice_sessions: entries.length,
    streak_days: streak(entriesFor(child.id)),
    words_per_answer_change_pct: wordsChange,
    words_per_answer_first_week: first?.avg_words ?? 0,
    words_per_answer_latest_week: last?.avg_words ?? 0,
    big_words_total: allBig.length,
    recent_big_words: recentBig,
    vocabulary_size: vocabularySize(child.id),
    weekly: weeks,
    method:
      "Words per answer is the main measure. \"Big words\" are words used for the first time that are uncommon in everyday " +
      "speech for the child's age (SUBTLEX-US frequency ranks), skipping names and words echoed from the question.",
    note: "Practice and engagement indicators, not a clinical assessment. Talk to a speech-language professional if you have concerns.",
    say:
      `${child.name} practised ${entries.length} times in the last ${days} days. ` +
      (first && last && first !== last ? `Their answers have gone from about ${Math.round(first.avg_words)} words to about ${Math.round(last.avg_words)}. ` : "") +
      (recentBig.length ? `New big words lately: ${recentBig.slice(-4).join(", ")}.` : ""),
  };
}

export function progressByVoice(childName: string, requestedBy: string, pin?: string | null, days = 28) {
  const child = requireMember(childName);
  if (child.role !== "child") throw new HearthError(`${child.name} isn't set up as a child, so there's no speaking-practice report.`);
  const { member, verified } = voiceViewer(requestedBy, pin);
  if (!member.is_parent && member.id !== child.id) throw new HearthError(`Only a parent can hear ${child.name}'s speaking progress.`);
  if (!verified) throw new HearthError(`Please say your PIN first, ${member.name}, and I'll tell you how ${child.name} is doing.`);
  return languageProgress(child, days);
}

// ───────────────────────────── threads, recall, radio ─────────────────────────────

export function listThreads(forName?: string) {
  const rows: Thread[] = forName ? pendingThreadsFor(requireMember(forName).id) : allThreads(40);
  return rows.map((t) => ({
    id: t.id, kind: t.kind, status: t.status,
    from: t.kind === "care_nudge" ? "Hearth" : memberById(t.from_member_id).name, // nudges never show their source
    to: memberById(t.to_member_id).name,
    prompt: t.prompt,
    created: fmtDate(t.created_at),
  }));
}

export function recall(question: string, askedBy: string, pin?: string | null, limit = 5) {
  const { member, verified } = voiceViewer(askedBy, pin);
  const viewer: Viewer = verified ? member : null;
  const q = new Set(tokenize(question).filter((w) => w.length > 2));
  const members = new Map(allMembers().map((m) => [m.id, m]));
  const scored = allEntriesNewestFirst()
    .filter((e) => canSee(viewer, e))
    .map((e) => {
      const author = members.get(e.member_id)!;
      const hay = tokenize(`${e.transcript} ${e.summary} ${e.topics} ${author.name} ${author.relation ?? ""}`);
      return { e, author, score: hay.filter((w) => q.has(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.e.created_at.localeCompare(a.e.created_at))
    .slice(0, limit);
  return {
    question, asked_by: member.name, searched_as: verified ? member.name : "household (say your PIN to include your private entries)",
    matches: scored.map(({ e, author }) => ({ date: fmtDate(e.created_at), who: author.name, summary: e.summary, said: e.transcript })),
    instructions: scored.length
      ? "Answer the question in one or two spoken sentences using only these matches. Mention who said it and when."
      : "Say you couldn't find that in the family's journal yet.",
  };
}

interface RadioEpisode {
  generated_with: "bedrock" | "template";
  period_days: number;
  segments: { member: string; highlight: string; entries: number }[];
  word_of_the_week: { name: string; words: string[] }[];
  cast: { name: string; called: string | null; photo: string | null; role: Role }[];
  script: string;
}

// Family Radio is written by Bedrock ahead of time (a few seconds after the family's journal changes),
// so "Alexa, play Family Radio" answers instantly. Until the first episode is ready, the in-code
// version plays.
let radioCache: { version: number; days: number; episode: RadioEpisode } | null = null;
let radioTimer: NodeJS.Timeout | null = null;
function scheduleRadio(delayMs = 8000) {
  if (!llmEnabled()) return;
  if (radioTimer) clearTimeout(radioTimer);
  radioTimer = setTimeout(() => {
    radioTimer = null;
    inBackground(async () => {
      const version = dataVersion();
      const episode = await buildRadio(7, true);
      if (episode.generated_with === "bedrock") radioCache = { version, days: 7, episode };
    });
  }, delayMs);
  radioTimer.unref?.();
}

export async function familyRadio(days = 7): Promise<RadioEpisode & { fresh?: boolean }> {
  if (!llmEnabled()) return buildRadio(days, false);
  if (radioCache && radioCache.days === days) {
    const fresh = radioCache.version === dataVersion();
    if (!fresh) scheduleRadio(0);
    return { ...radioCache.episode, fresh };
  }
  scheduleRadio(0);
  return buildRadio(days, false);
}

export async function buildRadio(days: number, useAI: boolean): Promise<RadioEpisode> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const entries = sharedEntriesSince(since).filter((e) => !e.conversation_id);
  const conversations = [...new Set(sharedEntriesSince(since).map((e) => e.conversation_id).filter((c): c is number => !!c))]
    .map((id) => conversationById(id)!).filter(Boolean);
  const members = allMembers();
  const byMember = members.map((m) => ({ m, es: entries.filter((e) => e.member_id === m.id) })).filter((x) => x.es.length);
  const cast = members.map((m) => ({ name: m.name, called: m.relation, photo: m.photo, role: m.role }));
  if (!byMember.length) return { generated_with: "template", period_days: days, segments: [], word_of_the_week: [], cast, script: "It's been a quiet week at home — no stories yet. Tell me about your day and I'll have an episode ready next Sunday!" };

  const kidWords = members
    .filter((m) => m.role === "child")
    .map((m) => ({ name: m.name, words: entries.filter((e) => e.member_id === m.id).flatMap((e) => parse<string[]>(e.new_words)).sort((a, b) => b.length - a.length) }))
    .filter((k) => k.words.length);
  const warmth = (e: Entry) => e.word_count + (["happy", "calm", "nostalgic"].includes(e.mood ?? "") ? 40 : 0) - (["tired", "worried", "sad"].includes(e.mood ?? "") ? 30 : 0);
  const pick = (es: Entry[]) => [...es].sort((a, b) => warmth(b) - warmth(a))[0];

  const material = byMember
    .map(({ m, es }) => `${m.name} (${m.relation ?? m.role}): ${es.map((e) => `[${fmtDate(e.created_at)}] ${e.summary}`).join(" ")}`)
    .join("\n");
  const ai = useAI && llmEnabled()
    ? await completeJson<{ script: string }>(
        RADIO_SYSTEM,
        `This week's journal summaries:\n${material}\nFamily-table conversations: ${conversations.map((c) => c.summary).join(" ") || "none"}\nNew big words the kids used: ${kidWords.map((k) => `${k.name}: ${k.words.slice(0, 5).join(", ")}`).join("; ") || "none"}`,
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
      ...conversations.slice(-1).map((c) => `And at the family table: ${c.summary}`),
      `That's this week's Family Radio. Ask each other one question about these stories at dinner tonight. Good night!`,
    ].join("\n\n");

  return { generated_with: ai ? "bedrock" : "template", period_days: days, segments, word_of_the_week: kidWords, cast, script };
}

// ───────────────────────────── family conversations ─────────────────────────────

const HOST_GUIDE =
  "You're hosting a family conversation. Alexa+ voice ID tells you who is speaking — label every turn with that person's name. " +
  "Ask the opener to the person named, then invite each person in turn. Keep turns short, draw quieter people in (especially children), " +
  "and ask follow-ups that connect what one person said to another. After about 6–12 turns, or when someone says they're done, " +
  "call save_family_conversation with every turn: the speaker's name and their exact words. Never summarise turns.";

export function startConversation(names: string[]) {
  const people = [...new Map(names.map((n) => requireMember(n)).map((m) => [m.id, m])).values()];
  if (people.length < 2) throw new HearthError("A family conversation needs at least two people. Who's at the table?");
  for (const p of people) requireConsent(p);
  const ids = new Set(people.map((p) => p.id));
  const child = people.find((p) => p.role === "child");
  const elder = people.find((p) => p.role === "elder");

  // 1. A story waiting between two people at the table is the best opener.
  const thread = people.flatMap((p) => pendingThreadsFor(p.id)).find((t) => t.kind === "story_bridge" && ids.has(t.from_member_id));
  let opener: string;
  let threadId: number | null = null;
  if (thread) {
    const to = memberById(thread.to_member_id);
    const from = memberById(thread.from_member_id);
    opener = `${to.name}, ${thread.prompt} And ${ref(from)}, you can tell us more about it after!`;
    threadId = thread.id;
  } else if (elder) {
    const covered = new Set(entriesFor(elder.id).map((e) => e.prompt));
    const q = MEMOIR_FLAT.find((x) => !covered.has(x.question))?.question ?? MEMOIR_FLAT[0].question;
    opener = `${ref(elder)}, ${q.charAt(0).toLowerCase()}${q.slice(1)}${child ? ` ${child.name}, get a question ready for ${ref(elder)}!` : ""}`;
  } else {
    opener = TABLE_QUESTIONS[(entriesFor(people[0].id).length + people.length) % TABLE_QUESTIONS.length];
  }
  return {
    participants: people.map((p) => ({ name: p.name, called: p.relation, role: p.role })),
    opener,
    thread_id: threadId,
    host_guide: HOST_GUIDE,
    style_notes: people.map((p) => `${p.name}: ${STYLE_GUIDE[p.role]}`),
    next_step: "Read the opener aloud, host the conversation, then call save_family_conversation with every turn.",
  };
}

export async function saveConversation(input: {
  turns: { speaker: string; text: string }[]; prompt?: string | null; thread_id?: number | null; at?: string;
}) {
  const turns = input.turns.map((t) => ({ speaker: requireMember(t.speaker), text: t.text.trim() })).filter((t) => t.text);
  if (turns.length < 2) throw new HearthError("A conversation needs at least two turns.");
  const people = [...new Map(turns.map((t) => [t.speaker.id, t.speaker])).values()];
  if (people.length < 2) throw new HearthError("A conversation needs at least two different people.");
  for (const p of people) requireConsent(p);
  const summarised = turns.find((t) => looksLikeSummary(t.speaker, t.text));
  if (summarised) {
    throw new HearthError(`${summarised.speaker.name}'s turn looks like a summary. Send each person's exact words, as spoken.`);
  }
  const family = allMembers();
  const start = Date.parse(input.at ?? nowIso());
  const names = people.map((p) => p.name);
  const nameList = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
  const allText = turns.map((t) => t.text).join(" ");

  const familyWords = new Set(family.flatMap((f) => [f.name, f.relation ?? ""]).flatMap((n) => tokenize(n)));
  const topic = topKeywords(`${input.prompt ?? ""} ${allText}`, 8).filter((w) => !familyWords.has(w) && w.length >= 5 && !/ly$/.test(w)).slice(0, 2).join(" and ") || "their week";
  const convo = insertConversation({
    created_at: new Date(start).toISOString(),
    prompt: input.prompt ?? null,
    participants: JSON.stringify(people.map((p) => p.id)),
    summary: `${nameList} talked about ${topic}.`,
  });
  // Bedrock writes a warmer one-line summary in the background.
  if (llmEnabled()) {
    // Possible safety disclosures never leave Hearth, so those turns are left out of what Bedrock sees.
    const shareable = turns.filter((t) => !["household_harm", "self_harm"].includes(checkSafety(t.text, family).kind));
    const transcript = `${input.prompt ? `Opener: ${input.prompt}\n` : ""}${shareable.map((t) => `${t.speaker.name}: ${t.text}`).join("\n")}`;
    inBackground(async () => {
      const ai = await completeJson<{ summary: string }>(CONVERSATION_SUMMARY_SYSTEM, transcript, 200);
      if (ai?.summary && conversationById(convo.id)) updateConversationSummary(convo.id, ai.summary);
    });
  }

  const big: Record<string, string[]> = {};
  let sensitiveTurns = 0;
  for (const [i, t] of turns.entries()) {
    const at = new Date(start + i * 1000).toISOString();
    const safety = checkSafety(t.text, family);
    const sensitive = safety.kind === "household_harm" || safety.kind === "self_harm";
    if (sensitive) sensitiveTurns++;
    const metrics = analyze(t.text);
    const fresh = recordVocabulary(t.speaker.id, tokenize(t.text), at);
    const words = sensitive ? [] : childBigWords(t.speaker, fresh, input.prompt ?? null, t.text);
    if (words.length) big[t.speaker.name] = [...(big[t.speaker.name] ?? []), ...words];
    insertEntry({
      member_id: t.speaker.id, created_at: at, prompt: input.prompt ?? null, transcript: t.text,
      summary: sensitive ? `${t.speaker.name}: private entry` : `${t.speaker.name} at the family table: ${firstSentence(t.text)}`,
      mood: sensitive ? null : guessMood(t.text), topics: "[]", people: JSON.stringify(names),
      private: sensitive ? 1 : 0, sensitive: sensitive ? 1 : 0,
      word_count: metrics.word_count, mlu: metrics.mlu, unique_words: metrics.unique_words,
      new_words: JSON.stringify(words), chapter: t.speaker.role === "elder" ? "At the family table" : null,
      conversation_id: convo.id, turn: i,
    });
  }
  if (input.thread_id) {
    const th = threadById(input.thread_id);
    if (th && people.some((p) => p.id === th.to_member_id)) markThreadUsed(th.id);
  }
  scheduleRadio();
  const praise = Object.entries(big).map(([n, w]) => `${n} used ${w.length === 1 ? "a new big word" : `${w.length} new big words`}: ${w.slice(0, 3).join(", ")}.`).join(" ");
  return {
    saved: true, conversation_id: convo.id, turns: turns.length, participants: names, summary: convo.summary,
    big_words: big,
    ...(sensitiveTurns ? { private_turns: sensitiveTurns } : {}),
    say: `What a lovely chat. I've saved it to ${nameList}'s journals.${praise ? ` ${praise}` : ""}`,
  };
}

function conversationView(viewer: Viewer, conversationId: number) {
  const c = conversationById(conversationId);
  if (!c) return null;
  const turns = conversationTurns(c.id).filter((t) => canSee(viewer, t));
  if (!turns.length) return null;
  return {
    type: "conversation" as const,
    id: c.id,
    date: fmtDate(c.created_at),
    at: c.created_at,
    participants: parse<number[]>(c.participants).map((id) => memberById(id)?.name).filter(Boolean) as string[],
    prompt: c.prompt,
    summary: c.summary,
    turns: turns.map((t) => ({ id: t.id, who: memberById(t.member_id).name, text: t.transcript })),
  };
}

// ───────────────────────────── dashboard ─────────────────────────────

const childFirstAndLatest = (k: Member) => {
  const es = entriesFor(k.id).filter((e) => !e.sensitive && !e.conversation_id);
  const latest = [...es].reverse().find((e) => e.word_count >= 15) ?? es.at(-1);
  return {
    first_answer: es[0] ? { date: fmtDate(es[0].created_at), text: es[0].transcript, words: es[0].word_count } : null,
    latest_answer: latest ? { date: fmtDate(latest.created_at), text: latest.transcript, words: latest.word_count } : null,
  };
};

/** Everything the dashboard's arc and family view show. `viewer` null = household view. */
export function dashboard(viewer: Viewer) {
  const members = allMembers();
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const seen = new Set<number>();
  const timeline: unknown[] = [];
  for (const e of sharedEntriesSince(weekAgo).reverse()) {
    if (!canSee(viewer, e)) continue;
    if (e.conversation_id) {
      if (seen.has(e.conversation_id)) continue;
      seen.add(e.conversation_id);
      const view = conversationView(viewer, e.conversation_id);
      if (view) timeline.push(view);
      continue;
    }
    const a = memberById(e.member_id);
    timeline.push({ type: "entry", id: e.id, date: fmtDate(e.created_at), at: e.created_at, who: a.name, role: a.role, text: e.transcript, chapter: e.chapter });
  }
  const recentThreads = threadsSince(new Date(Date.now() - 21 * DAY).toISOString()).map((t) => ({
    id: t.id, kind: t.kind, status: t.status,
    from: t.kind === "care_nudge" ? null : memberById(t.from_member_id).name,
    to: memberById(t.to_member_id).name,
  }));
  return {
    viewer: viewer?.name ?? null,
    viewer_is_parent: !!viewer?.is_parent,
    viewers: members.filter((m) => m.role !== "child").map((m) => ({ name: m.name, has_pin: hasPin(m), is_parent: !!m.is_parent })),
    family: familyOverview(),
    week: { stories: sharedEntriesSince(weekAgo).length, waiting: recentThreads.filter((t) => t.status === "pending").length },
    threads: recentThreads,
    timeline,
    demo: getSetting("demo") === "1",
    care_nudges: careNudgesOn(),
    retention: retentionPolicy(),
    version: dataVersion(),
  };
}

/** One member's journal as `viewer` may see it — the panel under the arc. Pages with `before`. */
export function memberJournal(viewer: Viewer, name: string, before?: number) {
  const m = requireMember(name);
  const self = !!viewer && viewer.id === m.id;
  const person = { name: m.name, called: m.relation, role: m.role, age: m.age, photo: m.photo };
  const mode = m.role === "child" ? "Speaking practice" : m.role === "elder" ? "Memoir" : "Daily log";
  if (m.role === "child" && !viewer?.is_parent && !self) {
    return {
      person, mode, locked: true,
      reason: viewer ? `Only ${m.name}'s parents can open ${m.name}'s journal.` : `Unlock as a parent to open ${m.name}'s journal.`,
    };
  }
  const all = entriesFor(m.id);
  const newestFirst = [...all].reverse();
  const startAt = before ? newestFirst.findIndex((e) => e.id === before) + 1 : 0;
  const page = newestFirst.slice(startAt, startAt + PAGE);
  const entries = page.map((e) => {
    if (!canSee(viewer, e)) return { id: e.id, date: fmtDate(e.created_at), hidden: true as const };
    const others = e.conversation_id ? participantsOf(e.conversation_id).filter((id) => id !== m.id).map((id) => memberById(id)?.relation || memberById(id)?.name) : [];
    return {
      id: e.id, date: fmtDate(e.created_at), text: e.transcript, chapter: e.chapter, prompt: e.prompt,
      private: !!e.private, sensitive: !!e.sensitive,
      conversation: e.conversation_id ? { id: e.conversation_id, with: others } : null,
      can_delete: !!viewer && canDelete(viewer, e),
    };
  });
  const waiting = pendingThreadsFor(m.id).map((t) =>
    t.kind === "care_nudge" && !self
      ? { kind: t.kind, hidden: true as const }
      : { kind: t.kind, from: t.kind === "care_nudge" ? null : memberById(t.from_member_id).name, prompt: t.prompt },
  );
  const base = {
    person, mode, locked: false, streak_days: streak(all), entries, waiting,
    more: startAt + PAGE < newestFirst.length, total: all.length,
    kept_for_days: retentionPolicy()[m.role],
  };
  if (before) return base; // older pages only need entries

  if (m.role === "child") {
    const p = languageProgress(m);
    return {
      ...base,
      stats: [
        { value: p.words_per_answer_first_week && p.words_per_answer_latest_week ? `${Math.round(p.words_per_answer_first_week)} → ${Math.round(p.words_per_answer_latest_week)}` : String(Math.round(p.words_per_answer_latest_week)), label: "words per answer, first week to now" },
        { value: String(p.big_words_total), label: "new big words so far" },
        { value: `${p.streak_days} ${p.streak_days === 1 ? "day" : "days"}`, label: "practice streak" },
      ],
      progress: { weekly: p.weekly, recent_big_words: p.recent_big_words, note: p.note, method: p.method },
      ...childFirstAndLatest(m),
    };
  }
  if (m.role === "elder") {
    const chapters = memoirProgress(m);
    return {
      ...base,
      stats: [
        { value: String(all.filter((e) => !e.conversation_id && !e.sensitive).length), label: "stories told" },
        { value: `${chapters.filter((c) => c.questions && c.stories > 0).length} of ${MEMOIR.length}`, label: "chapters started" },
        { value: String(all.filter((e) => e.chapter === "Talks with the grandchildren" || e.chapter === "At the family table").length), label: "talks with the grandchildren" },
      ],
      chapters,
    };
  }
  const weekAgo = Date.now() - 7 * DAY;
  return {
    ...base,
    stats: [
      { value: String(all.filter((e) => Date.parse(e.created_at) >= weekAgo).length), label: "check-ins this week" },
      base.streak_days > 1
        ? { value: `${base.streak_days} days`, label: "streak" }
        : { value: all.length ? fmtDate(all.at(-1)!.created_at).replace(/^\w+,?\s*/, "") : "None yet", label: "last check-in" },
      { value: String(all.filter((e) => e.private).length), label: "private entries" },
    ],
    noticed: self ? adultPattern(m) : null, // patterns are personal
  };
}
