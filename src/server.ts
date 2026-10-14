// Hearth MCP server — Streamable HTTP transport (MCP spec 2025-11-25), ready to onboard to Alexa+
// with the Alexa AI CLI (`alexa-ai new mcp --mcp-server-url https://<your-host>/mcp`).
//
// Endpoints:
//   POST /mcp            MCP Streamable HTTP endpoint (stateless: a fresh server per request)
//   GET  /               Parent dashboard (static page in /public)
//   GET  /api/...        JSON for the dashboard
//   GET  /health         Liveness check
import express, { type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  HearthError, dashboard, memberJournal, familyOverview, familyRadio, languageProgress, listThreads, nextPrompt,
  recall, registerMember, saveEntry, startSession,
} from "./memory.js";
import { llmLabel } from "./llm.js";

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

const memberName = z.string().min(1).describe("The family member's first name, e.g. \"Aarav\". Use the name of whoever is speaking.");

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "hearth", title: "Hearth — family memory", version: "0.1.0" },
    {
      instructions:
        "Hearth is a voice journal for the whole family. Each member talks to Alexa in their own mode: children get " +
        "speaking practice (Alexa recasts their answers into richer sentences), adults keep a one-minute daily log, and " +
        "grandparents build a memoir one story a day. Hearth links stories across generations: a grandparent's story " +
        "becomes a question for the grandchild, and vice versa. Typical flow: start_journal_session → get_journal_prompt " +
        "→ (ask the question, listen) → save_journal_entry → say the `say` field. Never reveal one member's private " +
        "entries to another.",
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
        "Save what a family member said as a journal entry. For children it returns a `recast` (their idea said back " +
        "as a fuller sentence) and a `follow_up` question — say both to keep them talking. For adults it may return a " +
        "pattern noticed this week; for grandparents, which memoir chapter the story joined. Always speak the `say` field. " +
        "Hearth also creates family threads so other members hear about this story later. Set private=true if the " +
        "speaker asks to keep it private.",
      inputSchema: {
        member_name: memberName,
        transcript: z.string().min(1).describe("Exactly what the member said, as fully as possible. Do not summarise."),
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
        "For parents: how a child's speaking practice is going — sessions, streak, vocabulary size, change in sentence " +
        "length and answer length, and new words they've started using. Only parents can ask. Use for \"How is Aarav's " +
        "speaking coming along?\" or \"What new words has Aarav learned this week?\". This tracks practice, not a diagnosis.",
      inputSchema: {
        child_name: z.string().min(1).describe("The child's first name."),
        requested_by: memberName.describe("Name of the parent asking."),
        days: z.number().int().min(7).max(120).optional().describe("Look-back window in days (default 28)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ child_name, requested_by, days }) => run(() => languageProgress(child_name, requested_by, days ?? 28)),
  );

  server.registerTool(
    "recall_family_memory",
    {
      title: "Recall a family memory",
      description:
        "Search the family's journal to answer a question like \"When did I last call the plumber?\", \"What did Dadu " +
        "say about his village?\" or \"What did we do last Sunday?\". Respects privacy: only returns entries the asker " +
        "is allowed to see. Answer briefly from the matches.",
      inputSchema: {
        question: z.string().min(1).describe("The question, in the speaker's words."),
        asked_by: memberName.describe("Name of the person asking."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ question, asked_by }) => run(() => recall(question, asked_by)),
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
        requested_by: memberName.describe("Name of the person asking."),
        days: z.number().int().min(1).max(31).optional().describe("How many days to cover (default 7)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ requested_by, days }) => run(() => familyRadio(requested_by, days ?? 7)),
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
        "List the family members Hearth knows, or add one. A parent sets up children's profiles. Roles: child (speaking " +
        "practice), adult (daily log), elder (memoir). `called` is what the family calls them, e.g. \"Dadu\" or \"Mum\".",
      inputSchema: {
        action: z.enum(["list", "add"]).describe("list members, or add a new one"),
        name: z.string().optional().describe("New member's first name (for add)."),
        role: z.enum(["child", "adult", "elder"]).optional().describe("Role (for add)."),
        age: z.number().int().min(2).max(120).optional(),
        called: z.string().optional().describe("What the family calls them, e.g. Dadu, Nani, Mum, Papa."),
        is_parent: z.boolean().optional().describe("True for parents (they can see kids' progress)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (a) =>
      run(() => {
        if (a.action === "list") return familyOverview();
        if (!a.name || !a.role) throw new HearthError("To add someone I need their name and role (child, adult or elder).");
        const m = registerMember({ name: a.name, role: a.role, age: a.age, relation: a.called, is_parent: a.is_parent });
        return { added: m.name, role: m.role, say: `Welcome to the family journal, ${m.name}!` };
      }),
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

// Stateless Streamable HTTP: every POST gets its own server + transport, so it scales horizontally
// and runs fine behind Lambda / App Runner / a tunnel.
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

app.get("/health", (_req, res) => res.json({ ok: true, protocol: LATEST_PROTOCOL_VERSION, reasoning: llmLabel() }));

const apiError = (res: Response, err: unknown) =>
  res.status(err instanceof HearthError ? 400 : 500).json({ error: (err as Error).message });

app.get("/api/dashboard", auth, (req, res) => {
  try { res.json(dashboard(String(req.query.viewer ?? ""))); } catch (e) { apiError(res, e); }
});
app.get("/api/journal/:name", auth, (req, res) => {
  try { res.json(memberJournal(String(req.query.viewer ?? ""), String(req.params.name))); } catch (e) { apiError(res, e); }
});
app.get("/api/family", auth, (_req, res) => res.json(familyOverview()));
app.get("/api/radio", auth, async (req, res) => {
  try { res.json(await familyRadio(String(req.query.viewer ?? ""), Number(req.query.days ?? 7))); } catch (e) { apiError(res, e); }
});

const here = dirname(fileURLToPath(import.meta.url));
app.use(express.static(join(here, "..", "public")));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`Hearth MCP server  →  http://localhost:${PORT}/mcp   (protocol ${LATEST_PROTOCOL_VERSION}, Streamable HTTP)`);
    console.log(`Parent dashboard   →  http://localhost:${PORT}/`);
    console.log(`Reasoning          →  ${llmLabel()}`);
  });
}

export { app };
