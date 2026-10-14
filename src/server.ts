// Hearth MCP server — Streamable HTTP transport (MCP spec 2025-11-25), ready to onboard to Alexa+
// with the Alexa AI CLI (`alexa-ai new mcp --mcp-server-url https://<your-host>/mcp`).
//
// Endpoints:
//   POST /mcp            MCP Streamable HTTP endpoint (stateless: a fresh server per request)
//   GET  /               Family dashboard (static page in /public)
//   POST /api/session    Unlock the dashboard as a person (PIN once per browser session)
//   GET  /api/...        JSON for the dashboard (viewer comes from the session, never the URL)
//   GET  /health         Liveness check
import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  HearthError, dashboard, deleteByVoice, deleteEntryAs, familyOverview, familyRadio, listThreads, memberJournal,
  nextPrompt, progressByVoice, purgeExpired, recall, registerMember, saveConversation, saveEntry, setCareNudges,
  startConversation, startSession, type Viewer,
} from "./memory.js";
import { readSession, signIn } from "./auth.js";
import { dataVersion } from "./db.js";
import { llmLabel } from "./llm.js";
import { guardrailLabel } from "./safety.js";

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.HEARTH_API_KEY; // optional bearer token for /mcp and /api

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Wraps tool logic: JSON result for the agent, friendly error text on failure. */
async function run(fn: () => unknown): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof HearthError ? err.message : `Hearth hit a problem: ${(err as Error).message}`;
    if (!(err instanceof HearthError)) console.error(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const memberName = z.string().min(1).describe("The family member's first name or what the family calls them, e.g. \"Leo\" or \"Gran\". Use whoever is speaking.");
const pin = z.string().optional().describe("The speaker's parent PIN, only if they said it. Needed for parent-level requests; never guess it or say it back.");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "hearth", title: "Hearth — family memory", version: "0.2.0" },
    {
      instructions:
        "Hearth is a voice journal for the whole family. Each member talks to Alexa in their own mode: children get " +
        "speaking practice (Alexa recasts their answers into richer sentences), adults keep a one-minute daily log, and " +
        "grandparents build a memoir one story a day. Hearth links stories across generations: a grandparent's story " +
        "becomes a question for the grandchild, and vice versa. Typical flow: start_journal_session → get_journal_prompt " +
        "→ (ask the question, listen) → save_journal_entry with the speaker's EXACT words → say the `say` field. " +
        "For several people talking together, use start_family_conversation and save_family_conversation. " +
        "Parent-level requests (a child's progress, deleting older entries, settings) need the parent's PIN; ask for it " +
        "if a tool says so, and never repeat it aloud. Never reveal one member's private entries to another.",
    },
  );

  server.registerTool(
    "start_journal_session",
    {
      title: "Start a journal session",
      description:
        "Start a Hearth journal session for the family member who is speaking. Returns their mode (speaking_practice " +
        "for kids, daily_log for adults, memoir for grandparents), a greeting to say, their streak, and how Alexa " +
        "should behave. Use when someone says things like \"Alexa, open my journal\", \"I want to tell Hearth about my day\", " +
        "or \"start Dadu's story time\".",
      inputSchema: { member_name: memberName },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ member_name }) => run(() => startSession(member_name)),
  );

  server.registerTool(
    "get_journal_prompt",
    {
      title: "Get today's journal question",
      description:
        "Get the next question to ask a family member. Questions written from another family member's story " +
        "(family threads) come first — for example a grandchild may be asked about the grandparent's first bicycle. " +
        "Otherwise returns the next daily or memoir question. Read `prompt` aloud, then call save_journal_entry with " +
        "their answer, passing `prompt` and `thread_id` through.",
      inputSchema: { member_name: memberName },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ member_name }) => run(() => nextPrompt(member_name)),
  );

  server.registerTool(
    "save_journal_entry",
    {
      title: "Save a journal entry",
      description:
        "Save what a family member said as a journal entry. Pass their EXACT words in first person, as spoken — never a " +
        "summary like \"Leo said he…\" (Hearth rejects summaries, because kids' speaking practice is measured from the " +
        "real words). For children it returns a `recast` (their idea said back " +
        "as a fuller sentence) and a `follow_up` question — say both to keep them talking. For adults it may return a " +
        "pattern noticed this week; for grandparents, which memoir chapter the story joined. Always speak the `say` field. " +
        "Hearth also creates family threads so other members hear about this story later. Set private=true if the " +
        "speaker asks to keep it private.",
      inputSchema: {
        member_name: memberName,
        transcript: z.string().min(1).describe("Exactly what the member said, word for word, in first person. Never summarise or rephrase."),
        prompt: z.string().optional().describe("The question that was asked (from get_journal_prompt)."),
        thread_id: z.number().int().optional().describe("thread_id from get_journal_prompt, if the question came from a family thread."),
        private: z.boolean().optional().describe("True if the speaker wants this kept private (never shared with others)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => run(() => saveEntry({ name: args.member_name, transcript: args.transcript, prompt: args.prompt, thread_id: args.thread_id, private: args.private })),
  );

  server.registerTool(
    "get_kid_speaking_progress",
    {
      title: "Child's speaking-practice progress",
      description:
        "For parents: how a child's speaking practice is going — sessions, streak, words per answer then and now, and " +
        "new \"big words\" they've started using. Parents only, and needs the parent's PIN. Use for \"How is Leo's " +
        "speaking coming along?\" or \"What new words has Leo learned?\". This tracks practice, not a diagnosis.",
      inputSchema: {
        child_name: z.string().min(1).describe("The child's first name."),
        requested_by: memberName.describe("Name of the parent asking."),
        pin,
        days: z.number().int().min(7).max(120).optional().describe("Look-back window in days (default 28)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ child_name, requested_by, pin, days }) => run(() => progressByVoice(child_name, requested_by, pin, days ?? 28)),
  );

  server.registerTool(
    "recall_family_memory",
    {
      title: "Recall a family memory",
      description:
        "Search the family's journal to answer a question like \"When is the plumber coming?\", \"What did Gran " +
        "say about the farm?\" or \"What did we do last Sunday?\". Without a PIN it searches only what the whole " +
        "household may see; with the asker's PIN it also includes their own private entries (and, for parents, the kids'). " +
        "Answer briefly from the matches.",
      inputSchema: {
        question: z.string().min(1).describe("The question, in the speaker's words."),
        asked_by: memberName.describe("Name of the person asking."),
        pin,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ question, asked_by, pin }) => run(() => recall(question, asked_by, pin)),
  );

  server.registerTool(
    "play_family_radio",
    {
      title: "Play Family Radio",
      description:
        "Create this week's \"Family Radio\" episode: a warm 2–3 minute spoken recap of the family's week — a highlight " +
        "for each member, the kids' Word of the Week, a moment from the grandparent's memoir, and an idea for something " +
        "to do together. Read the `script` aloud. Use for \"Alexa, play Family Radio\" or \"What happened in our family this week?\".",
      inputSchema: {
        requested_by: memberName.optional().describe("Name of the person asking (optional — Family Radio is for the whole household)."),
        days: z.number().int().min(1).max(31).optional().describe("How many days to cover (default 7)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ days }) => run(() => familyRadio(days ?? 7)),
  );

  server.registerTool(
    "get_family_threads",
    {
      title: "See family threads",
      description:
        "List the story threads connecting family members — e.g. a question waiting for Aarav that came from Dadu's " +
        "story. Pass member_name to see only what's waiting for that person.",
      inputSchema: { member_name: memberName.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ member_name }) => run(() => listThreads(member_name)),
  );

  server.registerTool(
    "manage_family_members",
    {
      title: "Family members",
      description:
        "List family members, add one, or turn care nudges on or off. Roles: child (speaking practice), adult (daily log), " +
        "elder (memoir). `called` is what the family calls them, e.g. \"Gran\" or \"Mum\". A child's profile must be " +
        "added by a parent who agrees to the consent statement Hearth reads out — if the tool returns that statement, read " +
        "it to the parent and only call again with parent_consent=true after they clearly say yes.",
      inputSchema: {
        action: z.enum(["list", "add", "care_nudges_on", "care_nudges_off"]).describe("What to do"),
        name: z.string().optional().describe("New member's first name (for add)."),
        role: z.enum(["child", "adult", "elder"]).optional().describe("Role (for add)."),
        age: z.number().int().min(2).max(120).optional(),
        called: z.string().optional().describe("What the family calls them, e.g. Gran, Nani, Mum, Papa."),
        is_parent: z.boolean().optional().describe("True for parents (they can see kids' progress)."),
        new_member_pin: z.string().optional().describe("Optional 4–6 digit PIN for a new adult or grandparent."),
        requested_by: memberName.optional().describe("Who is asking. Required for adding a child and for settings."),
        parent_consent: z.boolean().optional().describe("True only after the parent agreed to the consent statement."),
        pin,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (a) =>
      run(() => {
        if (a.action === "list") return familyOverview();
        if (a.action === "care_nudges_on" || a.action === "care_nudges_off") {
          if (!a.requested_by) throw new HearthError("Which parent is changing this?");
          return setCareNudges(a.action === "care_nudges_on", a.requested_by, a.pin);
        }
        if (!a.name || !a.role) throw new HearthError("To add someone I need their name and role (child, adult or elder).");
        const m = registerMember({
          name: a.name, role: a.role, age: a.age, relation: a.called, is_parent: a.is_parent, pin: a.new_member_pin,
          added_by: a.requested_by, parent_consent: a.parent_consent,
        });
        return { added: m.name, role: m.role, say: `Welcome to the family journal, ${m.name}!` };
      }),
  );

  server.registerTool(
    "delete_journal_entry",
    {
      title: "Delete a journal entry",
      description:
        "Delete an entry for good. \"Alexa, delete what I just said\" deletes the speaker's latest entry — no PIN needed " +
        "within 15 minutes. Older entries need the speaker's PIN. A parent can delete a child's entry with their PIN " +
        "(pass for_member). Confirm with the person before calling, because it can't be undone.",
      inputSchema: {
        member_name: memberName.describe("Who is asking."),
        for_member: z.string().optional().describe("Whose entry, if not the speaker's own (a parent deleting a child's)."),
        entry_id: z.number().int().optional().describe("A specific entry; omit for the latest one."),
        pin,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => deleteByVoice({ name: a.member_name, for_member: a.for_member, entry_id: a.entry_id, pin: a.pin })),
  );

  server.registerTool(
    "start_family_conversation",
    {
      title: "Start a family conversation",
      description:
        "Start a conversation for several family members talking together with Alexa — at dinner, say: \"Alexa, start a " +
        "Hearth chat with Gran, Leo and Mum.\" Returns an opener (often a story waiting between people at the table) and a " +
        "hosting guide. Use voice ID to know who says what, then call save_family_conversation.",
      inputSchema: {
        participants: z.array(z.string().min(1)).min(2).describe("Everyone taking part, by name or what the family calls them."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ participants }) => run(() => startConversation(participants)),
  );

  server.registerTool(
    "save_family_conversation",
    {
      title: "Save a family conversation",
      description:
        "Save a family conversation to everyone's journals, one turn at a time, each labelled with who spoke (from voice ID) " +
        "and their exact words. Kids' turns count toward their speaking practice. Speak the `say` field afterwards.",
      inputSchema: {
        turns: z.array(z.object({
          speaker: z.string().min(1).describe("Who said it (voice ID)."),
          text: z.string().min(1).describe("Their exact words, in first person."),
        })).min(2),
        prompt: z.string().optional().describe("The opener from start_family_conversation."),
        thread_id: z.number().int().optional().describe("thread_id from start_family_conversation, if any."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (a) => run(() => saveConversation({ turns: a.turns, prompt: a.prompt, thread_id: a.thread_id })),
  );

  return server;
}

// ───────────────────────────── HTTP ─────────────────────────────

const app = express();
app.use(express.json({ limit: "1mb" }));

function auth(req: Request, res: Response, next: NextFunction) {
  if (!API_KEY || req.headers.authorization === `Bearer ${API_KEY}`) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

// Stateless Streamable HTTP: every POST gets its own server + transport. (The SQLite store still means
// one instance with a persistent disk — see the README's deploy section.)
app.post("/mcp", auth, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[hearth] MCP request failed:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
// Stateless mode has no server-initiated stream or session to delete.
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));

app.get("/health", (_req, res) => res.json({ ok: true, protocol: LATEST_PROTOCOL_VERSION, reasoning: llmLabel(), child_content_check: guardrailLabel() }));

const apiError = (res: Response, err: unknown) =>
  res.status(err instanceof HearthError ? 400 : 500).json({ error: (err as Error).message });

/** The dashboard viewer comes from a signed session, never from the URL. No session = household view. */
const viewerOf = (req: Request): Viewer => readSession(req.header("x-hearth-session") ?? undefined);

app.post("/api/session", auth, (req, res) => {
  const out = signIn(String(req.body?.viewer ?? ""), req.body?.pin ? String(req.body.pin) : undefined);
  if (!out) return res.status(401).json({ error: "That PIN didn't match. Try again." });
  res.json(out);
});
app.get("/api/pulse", auth, (_req, res) => res.json({ version: dataVersion() }));
app.get("/api/dashboard", auth, (req, res) => {
  try { res.json(dashboard(viewerOf(req))); } catch (e) { apiError(res, e); }
});
app.get("/api/journal/:name", auth, (req, res) => {
  try {
    const before = req.query.before ? Number(req.query.before) : undefined;
    res.json(memberJournal(viewerOf(req), String(req.params.name), before));
  } catch (e) { apiError(res, e); }
});
app.delete("/api/entries/:id", auth, (req, res) => {
  const viewer = viewerOf(req);
  if (!viewer) return res.status(401).json({ error: "Unlock as yourself to delete entries." });
  try { res.json(deleteEntryAs(viewer, Number(req.params.id))); } catch (e) { apiError(res, e); }
});
app.get("/api/family", auth, (_req, res) => res.json(familyOverview()));
app.get("/api/radio", auth, async (req, res) => {
  try { res.json(await familyRadio(Number(req.query.days ?? 7))); } catch (e) { apiError(res, e); }
});

const here = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(here, "..", "public")));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const purged = purgeExpired();
  setInterval(() => purgeExpired(), 6 * 3_600_000).unref(); // retention: remove expired entries every 6 hours
  app.listen(PORT, () => {
    console.log(`Hearth MCP server  →  http://localhost:${PORT}/mcp   (protocol ${LATEST_PROTOCOL_VERSION}, Streamable HTTP)`);
    console.log(`Family dashboard   →  http://localhost:${PORT}/`);
    console.log(`Reasoning          →  ${llmLabel()}   ·   child content check: ${guardrailLabel()}`);
    if (purged) console.log(`Retention          →  removed ${purged} expired entries`);
  });
}

export { app };
