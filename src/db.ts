// Storage layer: a single SQLite file via Node's built-in node:sqlite (no native build step).
// Every query lives in this file, so swapping to DynamoDB later only touches this module.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Role = "child" | "adult" | "elder";

export interface Member {
  id: number;
  name: string;
  role: Role;
  age: number | null;
  relation: string | null; // what the family calls them, e.g. "Gran", "Mum" — used in prompts
  is_parent: number; // 1 = can see children's journals and progress
  photo: string | null; // URL path of their bubble photo, e.g. "photos/leo.jpg"
  pin_hash: string | null; // optional PIN for parent-level actions (scrypt "salt:hash")
  consent_by: number | null; // children: the parent who consented to the profile
  consent_at: string | null;
}

export interface Entry {
  id: number;
  member_id: number;
  created_at: string;
  prompt: string | null;
  transcript: string;
  summary: string;
  mood: string | null;
  topics: string; // JSON string[]
  people: string; // JSON string[]
  private: number; // 1 = only the author sees it; never in threads, recall or Family Radio
  sensitive: number; // 1 = possible safety disclosure: hidden from everyone but the author, no sharing at all
  word_count: number;
  mlu: number; // words per sentence (approximate — depends on transcript punctuation)
  unique_words: number;
  new_words: string; // JSON string[] — children: "big words" used for the first time (age-graded)
  chapter: string | null; // elder memoir chapter
  conversation_id: number | null; // set when this entry is one turn of a family conversation
  turn: number | null; // order within the conversation
}

export interface Thread {
  id: number;
  kind: "story_bridge" | "care_nudge";
  source_entry_id: number;
  from_member_id: number;
  to_member_id: number;
  prompt: string;
  status: "pending" | "used" | "superseded";
  created_at: string;
  used_at: string | null;
}

export interface Conversation {
  id: number;
  created_at: string;
  prompt: string | null;
  participants: string; // JSON number[] (member ids)
  summary: string;
}

const DB_PATH = resolve(process.env.HEARTH_DB ?? "data/hearth.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('child','adult','elder')),
  age INTEGER,
  relation TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0,
  photo TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  prompt TEXT,
  transcript TEXT NOT NULL,
  summary TEXT NOT NULL,
  mood TEXT,
  topics TEXT NOT NULL DEFAULT '[]',
  people TEXT NOT NULL DEFAULT '[]',
  private INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  mlu REAL NOT NULL DEFAULT 0,
  unique_words INTEGER NOT NULL DEFAULT 0,
  new_words TEXT NOT NULL DEFAULT '[]',
  chapter TEXT
);
CREATE TABLE IF NOT EXISTS vocabulary (
  member_id INTEGER NOT NULL REFERENCES members(id),
  word TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (member_id, word)
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source_entry_id INTEGER NOT NULL REFERENCES entries(id),
  from_member_id INTEGER NOT NULL REFERENCES members(id),
  to_member_id INTEGER NOT NULL REFERENCES members(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  prompt TEXT,
  participants TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_member ON entries(member_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_to ON threads(to_member_id, status);
`);

// Migrations for databases created by earlier versions.
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn("members", "photo", "photo TEXT");
addColumn("members", "pin_hash", "pin_hash TEXT");
addColumn("members", "consent_by", "consent_by INTEGER");
addColumn("members", "consent_at", "consent_at TEXT");
addColumn("entries", "sensitive", "sensitive INTEGER NOT NULL DEFAULT 0");
addColumn("entries", "conversation_id", "conversation_id INTEGER");
addColumn("entries", "turn", "turn INTEGER");

export const nowIso = () => new Date().toISOString();

// ───────────────────────────── settings & change tracking ─────────────────────────────

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Bumped on every write so the dashboard can refresh itself when something changes. */
export function bumpVersion(): void {
  setSetting("version", String(Number(getSetting("version") ?? 0) + 1));
}
export const dataVersion = () => Number(getSetting("version") ?? 0);

// ───────────────────────────── members ─────────────────────────────

/** Finds a member by first name, or by what the family calls them ("Gran", "Mum"). */
export function findMember(name: string): Member | undefined {
  const n = name.trim();
  return (db.prepare("SELECT * FROM members WHERE name = ? COLLATE NOCASE").get(n) ??
    db.prepare("SELECT * FROM members WHERE relation = ? COLLATE NOCASE").get(n)) as Member | undefined;
}

export function allMembers(): Member[] {
  return db.prepare("SELECT * FROM members ORDER BY id").all() as unknown as Member[];
}

export function memberById(id: number): Member {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(id) as unknown as Member;
}

export function insertMember(m: Omit<Member, "id">): Member {
  db.prepare(
    `INSERT INTO members (name, role, age, relation, is_parent, photo, pin_hash, consent_by, consent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.name, m.role, m.age, m.relation, m.is_parent, m.photo, m.pin_hash, m.consent_by, m.consent_at);
  bumpVersion();
  return findMember(m.name)!;
}

export function setMemberPin(id: number, pinHash: string | null): void {
  db.prepare("UPDATE members SET pin_hash = ? WHERE id = ?").run(pinHash, id);
}

// ───────────────────────────── entries ─────────────────────────────

export function entriesFor(memberId: number, sinceIso?: string): Entry[] {
  if (sinceIso) {
    return db
      .prepare("SELECT * FROM entries WHERE member_id = ? AND created_at >= ? ORDER BY created_at, id")
      .all(memberId, sinceIso) as unknown as Entry[];
  }
  return db
    .prepare("SELECT * FROM entries WHERE member_id = ? ORDER BY created_at, id")
    .all(memberId) as unknown as Entry[];
}

export function entryById(id: number): Entry | undefined {
  return db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Entry | undefined;
}

/** Entries that can be shared with the family at all (not private, not sensitive). */
export function sharedEntriesSince(sinceIso: string): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE private = 0 AND sensitive = 0 AND created_at >= ? ORDER BY created_at, id")
    .all(sinceIso) as unknown as Entry[];
}

export function allEntriesNewestFirst(): Entry[] {
  return db.prepare("SELECT * FROM entries ORDER BY created_at DESC, id DESC").all() as unknown as Entry[];
}

export function insertEntry(e: Omit<Entry, "id">): Entry {
  const r = db
    .prepare(
      `INSERT INTO entries (member_id, created_at, prompt, transcript, summary, mood, topics, people,
        private, sensitive, word_count, mlu, unique_words, new_words, chapter, conversation_id, turn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.member_id, e.created_at, e.prompt, e.transcript, e.summary, e.mood, e.topics, e.people,
      e.private, e.sensitive, e.word_count, e.mlu, e.unique_words, e.new_words, e.chapter,
      e.conversation_id, e.turn,
    );
  bumpVersion();
  return entryById(Number(r.lastInsertRowid))!;
}

export function updateEntryNewWords(id: number, newWords: string[]): void {
  db.prepare("UPDATE entries SET new_words = ? WHERE id = ?").run(JSON.stringify(newWords), id);
}

/** Deletes an entry and every thread that came from it. Empty conversations go too. */
export function deleteEntryRow(id: number): void {
  const e = entryById(id);
  if (!e) return;
  db.prepare("DELETE FROM threads WHERE source_entry_id = ?").run(id);
  db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  if (e.conversation_id) {
    const left = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE conversation_id = ?").get(e.conversation_id) as { n: number };
    if (Number(left.n) === 0) db.prepare("DELETE FROM conversations WHERE id = ?").run(e.conversation_id);
  }
  bumpVersion();
}

/** Entries older than `beforeIso` for members with the given roles — used by the retention purge. */
export function entriesOlderThan(roles: Role[], beforeIso: string): Entry[] {
  const placeholders = roles.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT e.* FROM entries e JOIN members m ON m.id = e.member_id
       WHERE m.role IN (${placeholders}) AND e.created_at < ?`,
    )
    .all(...roles, beforeIso) as unknown as Entry[];
}

// ───────────────────────────── vocabulary ─────────────────────────────

/** Records words for a member and returns the ones never seen before. */
export function recordVocabulary(memberId: number, words: string[], at: string): string[] {
  const fresh: string[] = [];
  const get = db.prepare("SELECT word FROM vocabulary WHERE member_id = ? AND word = ?");
  const ins = db.prepare("INSERT INTO vocabulary (member_id, word, first_seen) VALUES (?, ?, ?)");
  const bump = db.prepare("UPDATE vocabulary SET uses = uses + 1 WHERE member_id = ? AND word = ?");
  for (const w of new Set(words)) {
    if (get.get(memberId, w)) bump.run(memberId, w);
    else {
      ins.run(memberId, w, at);
      fresh.push(w);
    }
  }
  return fresh;
}

export function clearVocabulary(memberId: number): void {
  db.prepare("DELETE FROM vocabulary WHERE member_id = ?").run(memberId);
}

export function vocabularySize(memberId: number, untilIso?: string): number {
  const row = untilIso
    ? db.prepare("SELECT COUNT(*) AS n FROM vocabulary WHERE member_id = ? AND first_seen <= ?").get(memberId, untilIso)
    : db.prepare("SELECT COUNT(*) AS n FROM vocabulary WHERE member_id = ?").get(memberId);
  return Number((row as { n: number }).n);
}

// ───────────────────────────── threads ─────────────────────────────

export function insertThread(t: Omit<Thread, "id" | "status" | "used_at">): void {
  db.prepare(
    `INSERT INTO threads (kind, source_entry_id, from_member_id, to_member_id, prompt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(t.kind, t.source_entry_id, t.from_member_id, t.to_member_id, t.prompt, t.created_at);
  bumpVersion();
}

export function pendingThreadsFor(memberId: number): Thread[] {
  return db
    .prepare("SELECT * FROM threads WHERE to_member_id = ? AND status = 'pending' ORDER BY created_at")
    .all(memberId) as unknown as Thread[];
}

export function threadById(id: number): Thread | undefined {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
}

export function allThreads(limit = 50): Thread[] {
  return db.prepare("SELECT * FROM threads ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Thread[];
}

export function threadsSince(sinceIso: string): Thread[] {
  return db
    .prepare("SELECT * FROM threads WHERE created_at >= ? AND status != 'superseded' ORDER BY created_at")
    .all(sinceIso) as unknown as Thread[];
}

export function markThreadUsed(id: number): void {
  db.prepare("UPDATE threads SET status = 'used', used_at = ? WHERE id = ?").run(nowIso(), id);
  bumpVersion();
}

export function supersedePending(fromId: number, toId: number, kind: Thread["kind"]): void {
  db.prepare(
    "UPDATE threads SET status = 'superseded' WHERE from_member_id = ? AND to_member_id = ? AND kind = ? AND status = 'pending'",
  ).run(fromId, toId, kind);
}

// ───────────────────────────── conversations ─────────────────────────────

export function insertConversation(c: Omit<Conversation, "id">): Conversation {
  const r = db
    .prepare("INSERT INTO conversations (created_at, prompt, participants, summary) VALUES (?, ?, ?, ?)")
    .run(c.created_at, c.prompt, c.participants, c.summary);
  bumpVersion();
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(r.lastInsertRowid) as unknown as Conversation;
}

export function conversationById(id: number): Conversation | undefined {
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation | undefined;
}

export function conversationTurns(id: number): Entry[] {
  return db.prepare("SELECT * FROM entries WHERE conversation_id = ? ORDER BY turn, id").all(id) as unknown as Entry[];
}

export function conversationsSince(sinceIso: string): Conversation[] {
  return db.prepare("SELECT * FROM conversations WHERE created_at >= ? ORDER BY created_at").all(sinceIso) as unknown as Conversation[];
}

export function resetAll(): void {
  db.exec(
    "DELETE FROM threads; DELETE FROM vocabulary; DELETE FROM entries; DELETE FROM conversations; DELETE FROM members; DELETE FROM settings;",
  );
  db.exec("DELETE FROM sqlite_sequence;");
}
