// Storage layer: a single SQLite file via Node's built-in node:sqlite (no native build step).
// Swap for DynamoDB later if you deploy to Lambda; every query lives in this file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Role = "child" | "adult" | "elder";

export interface Member {
  id: number;
  name: string;
  role: Role;
  age: number | null;
  relation: string | null; // e.g. "grandfather", "mother" — used in prompts ("Dadu told me…")
  is_parent: number; // 1 = can see children's journals and the progress dashboard
  photo: string | null; // URL path of their bubble photo, e.g. "photos/leo.jpg"
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
  private: number; // 1 = never shared in threads, recall or Family Radio
  word_count: number;
  mlu: number; // mean length of utterance (words per sentence)
  unique_words: number;
  new_words: string; // JSON string[] — words this member used for the first time
  chapter: string | null; // elder memoir chapter
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
CREATE INDEX IF NOT EXISTS idx_entries_member ON entries(member_id, created_at);
CREATE INDEX IF NOT EXISTS idx_threads_to ON threads(to_member_id, status);
`);

// Older databases: add the photo column if it's missing.
if (!(db.prepare("PRAGMA table_info(members)").all() as { name: string }[]).some((c) => c.name === "photo")) {
  db.exec("ALTER TABLE members ADD COLUMN photo TEXT");
}

export const nowIso = () => new Date().toISOString();

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
    "INSERT INTO members (name, role, age, relation, is_parent, photo) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(m.name, m.role, m.age, m.relation, m.is_parent, m.photo);
  return findMember(m.name)!;
}

export function entriesFor(memberId: number, sinceIso?: string): Entry[] {
  if (sinceIso) {
    return db
      .prepare("SELECT * FROM entries WHERE member_id = ? AND created_at >= ? ORDER BY created_at")
      .all(memberId, sinceIso) as unknown as Entry[];
  }
  return db
    .prepare("SELECT * FROM entries WHERE member_id = ? ORDER BY created_at")
    .all(memberId) as unknown as Entry[];
}

export function sharedEntriesSince(sinceIso: string): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE private = 0 AND created_at >= ? ORDER BY created_at")
    .all(sinceIso) as unknown as Entry[];
}

export function allSharedEntries(): Entry[] {
  return db
    .prepare("SELECT * FROM entries WHERE private = 0 ORDER BY created_at")
    .all() as unknown as Entry[];
}

export function insertEntry(e: Omit<Entry, "id">): Entry {
  const r = db
    .prepare(
      `INSERT INTO entries (member_id, created_at, prompt, transcript, summary, mood, topics, people,
        private, word_count, mlu, unique_words, new_words, chapter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.member_id, e.created_at, e.prompt, e.transcript, e.summary, e.mood, e.topics, e.people,
      e.private, e.word_count, e.mlu, e.unique_words, e.new_words, e.chapter,
    );
  return db.prepare("SELECT * FROM entries WHERE id = ?").get(r.lastInsertRowid) as unknown as Entry;
}

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

export function vocabularySize(memberId: number, untilIso?: string): number {
  const row = untilIso
    ? db.prepare("SELECT COUNT(*) AS n FROM vocabulary WHERE member_id = ? AND first_seen <= ?").get(memberId, untilIso)
    : db.prepare("SELECT COUNT(*) AS n FROM vocabulary WHERE member_id = ?").get(memberId);
  return Number((row as { n: number }).n);
}

export function insertThread(t: Omit<Thread, "id" | "status" | "used_at">): void {
  db.prepare(
    `INSERT INTO threads (kind, source_entry_id, from_member_id, to_member_id, prompt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(t.kind, t.source_entry_id, t.from_member_id, t.to_member_id, t.prompt, t.created_at);
}

export function pendingThreadsFor(memberId: number): Thread[] {
  return db
    .prepare("SELECT * FROM threads WHERE to_member_id = ? AND status = 'pending' ORDER BY created_at")
    .all(memberId) as unknown as Thread[];
}

export function allThreads(limit = 50): Thread[] {
  return db.prepare("SELECT * FROM threads ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as Thread[];
}

export function markThreadUsed(id: number): void {
  db.prepare("UPDATE threads SET status = 'used', used_at = ? WHERE id = ?").run(nowIso(), id);
}

export function supersedePending(fromId: number, toId: number, kind: Thread["kind"]): void {
  db.prepare(
    "UPDATE threads SET status = 'superseded' WHERE from_member_id = ? AND to_member_id = ? AND kind = ? AND status = 'pending'",
  ).run(fromId, toId, kind);
}

export function resetAll(): void {
  db.exec("DELETE FROM threads; DELETE FROM vocabulary; DELETE FROM entries; DELETE FROM members;");
  db.exec("DELETE FROM sqlite_sequence;");
}
