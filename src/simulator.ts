// The simulated Alexa+ experience (the hackathon's "simulate an Alexa+ experience via a web app" path).
//
// A browser page (public/sim) plays the Echo Show: it listens (Web Speech API), shows the transcript,
// and renders Hearth's MCP App screen with the official MCP Apps host bridge. Behind it, this module
// plays Alexa+: an agent that talks to Hearth ONLY through MCP over Streamable HTTP — tools/list,
// tools/call and resources/read against Hearth's own /mcp endpoint — exactly as Alexa+ would.
//
//   • With Amazon Bedrock configured, the agent is Nova (Converse tool use) and decides which tools to call.
//   • Without it (or if a call fails), a scripted router handles the same conversations, so the demo
//     and the tests always work.
import { readFileSync } from "node:fs";
import type { Express, NextFunction, Request, Response } from "express";
import type { ContentBlock, Message, Tool as BedrockTool } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { allMembers, findMember } from "./db.js";
import { converse, llmEnabled, modelId } from "./llm.js";

type CallResult = { content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; _meta?: { ui?: { resourceUri?: string } } };
type Step = { tool: string; args: Record<string, unknown>; ok: boolean; result: string };
type Ui = { resourceUri: string; tool: string; args: Record<string, unknown>; result: CallResult };
export type TurnResult = { reply: string; agent: "bedrock" | "scripted"; steps: Step[]; ui?: Ui; note?: string };

interface Script {
  mode: "idle" | "answer" | "convo";
  member?: string; prompt?: string; threadId?: number | null; followUps?: number;
  convo?: { prompt: string; threadId: number | null; participants: string[]; turns: { speaker: string; text: string }[] };
  pinFor?: { tool: string; args: Record<string, unknown> };
}
interface Session { messages: Message[]; script: Script; touched: number }

const API_KEY = process.env.HEARTH_API_KEY;
let selfUrl = "";
const sessions = new Map<string, Session>();

function session(id: string): Session {
  for (const [k, s] of sessions) if (Date.now() - s.touched > 3_600_000) sessions.delete(k);
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { messages: [], script: { mode: "idle" }, touched: Date.now() }));
  s.touched = Date.now();
  return s;
}

/** The browser-facing address, so photo links on the screen work behind a tunnel or a real domain. */
export type Forward = { host?: string; proto?: string };
const forwardOf = (req: Request): Forward => ({
  host: req.header("x-forwarded-host") ?? req.header("host"),
  proto: req.header("x-forwarded-proto") ?? req.protocol,
});

/** Connects to Hearth's own MCP endpoint over Streamable HTTP, exactly like Alexa+ would. */
async function withMcp<T>(fn: (c: Client) => Promise<T>, fwd: Forward = {}): Promise<T> {
  const client = new Client({ name: "hearth-alexa-simulator", version: "1.0.0" });
  const url = new URL(process.env.HEARTH_SELF_URL ?? selfUrl);
  const headers: Record<string, string> = {};
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  if (fwd.host) headers["x-forwarded-host"] = fwd.host;
  if (fwd.proto) headers["x-forwarded-proto"] = fwd.proto;
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  try { return await fn(client); } finally { await client.close(); }
}

/** Compares utterances loosely (case, spacing, punctuation, a leading "Alexa,"). */
const norm = (t: string) => t.toLowerCase().replace(/^\s*\[speaker:[^\]]*\]\s*/, "").replace(/^alexa,?\s*/, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const textOf = (r: CallResult) => (r.content ?? []).map((c) => c.text ?? "").join("");
const jsonOf = (r: CallResult): Record<string, unknown> | null => { try { return JSON.parse(textOf(r)); } catch { return null; } };
const maskPin = (a: Record<string, unknown>) => ("pin" in a && a.pin ? { ...a, pin: "••••" } : a);

class Turn {
  steps: Step[] = [];
  ui?: Ui;
  constructor(private client: Client, private tools: McpTool[]) {}
  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const r = (await this.client.callTool({ name, arguments: args })) as CallResult;
    this.steps.push({ tool: name, args: maskPin(args), ok: !r.isError, result: textOf(r).slice(0, 600) });
    const uri = this.tools.find((t) => t.name === name)?._meta?.ui?.resourceUri;
    if (uri && !r.isError) this.ui = { resourceUri: uri, tool: name, args: maskPin(args), result: r };
    return r;
  }
}

// ───────────────────────────── Bedrock agent ─────────────────────────────

// The agent's instructions are Hearth's Agent Skill (skills/hearth/SKILL.md, open Agent Skills format),
// loaded at startup, plus a few lines about how this simulator tags the speaker.
const SKILL = readFileSync(new URL("../skills/hearth/SKILL.md", import.meta.url), "utf8").replace(/^---[\s\S]*?---\s*/, "");
export const skillName = "hearth";
const SYSTEM = `You are Alexa+, the voice assistant in a family's home, using the Hearth add-on through its MCP tools.
In this simulator, every user message starts with [speaker: Name] — the person Alexa+ voice ID recognised. The transcript is the message text after that tag, unchanged.
Follow this Agent Skill:

${SKILL}`;

function toolSpecs(tools: McpTool[]): BedrockTool[] {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema as Record<string, unknown>;
    return { toolSpec: { name: t.name, description: (t.description ?? t.name).slice(0, 1000), inputSchema: { json: schema as never } } };
  });
}

/** Keeps the conversation short without splitting a tool call from its result. */
function trim(messages: Message[]) {
  while (messages.length > 40) {
    messages.shift();
    while (messages.length && !(messages[0].role === "user" && messages[0].content?.some((b) => "text" in b && b.text))) messages.shift();
  }
}

async function bedrockTurn(s: Session, speaker: string, text: string, fwd: Forward): Promise<TurnResult> {
  return withMcp(async (client) => {
    const { tools } = (await client.listTools()) as { tools: McpTool[] };
    const turn = new Turn(client, tools);
    const history = [...s.messages, { role: "user", content: [{ text: `[speaker: ${speaker}] ${text}` }] } as Message];
    const st = s.script;
    // An answer to the journal question Alexa just asked is always saved word for word, without asking the
    // model, so a child's real words can never be paraphrased, skipped or invented.
    if (st.mode === "answer" && st.member && findMember(speaker)?.name === st.member && !/^(alexa,? )?(stop|cancel|never ?mind)\b/i.test(text)) {
      const r = await turn.call("save_journal_entry", { member_name: st.member, transcript: text, prompt: st.prompt, ...(st.threadId ? { thread_id: st.threadId } : {}) });
      const j = jsonOf(r);
      const reply = r.isError ? textOf(r) : String(j?.say ?? "Saved.");
      if (!r.isError && findMember(st.member)?.role === "child" && j?.follow_up && !j.safety && (st.followUps ?? 0) < 1) {
        Object.assign(st, { prompt: String(j.follow_up), threadId: null, followUps: (st.followUps ?? 0) + 1 });
      } else st.mode = "idle";
      s.messages = [...history, { role: "assistant", content: [{ text: reply }] }];
      trim(s.messages);
      return { reply, agent: "bedrock", steps: turn.steps, ui: turn.ui };
    }
    st.mode = "idle";
    let reply = "";
    let greeting = "";
    let lastSay = "";
    let finished = false;
    const said = norm(text);
    for (let i = 0; i < 6 && !finished; i++) {
      const out = await converse({
        system: [{ text: SYSTEM }],
        messages: history,
        toolConfig: { tools: toolSpecs(tools) },
        inferenceConfig: { maxTokens: 1200, temperature: 0.3 },
      });
      const msg = out.output?.message as Message;
      history.push(msg);
      const uses = (msg.content ?? []).filter((b): b is ContentBlock.ToolUseMember => "toolUse" in b && !!b.toolUse);
      if (out.stopReason !== "tool_use" || !uses.length) {
        reply = (msg.content ?? []).map((b) => ("text" in b ? b.text ?? "" : "")).join(" ").trim();
        break;
      }
      const results: ContentBlock[] = [];
      for (const u of uses) {
        const name = u.toolUse.name!;
        const args = (u.toolUse.input ?? {}) as Record<string, unknown>;
        // Guard: a journal entry must be the words the speaker said in THIS message. Small models sometimes
        // invent an answer right after asking the question; refuse that instead of saving made-up words.
        if (name === "save_journal_entry" && norm(String(args.transcript ?? "")) !== said) {
          results.push({ toolResult: { toolUseId: u.toolUse.toolUseId!, status: "error", content: [{ text:
            "Not saved: transcript must be exactly the speaker's words from this message. If you just asked a question, stop and wait for their answer." }] } });
          continue;
        }
        const r = await turn.call(name, args);
        results.push({ toolResult: { toolUseId: u.toolUse.toolUseId!, content: [{ text: textOf(r) || "{}" }], status: r.isError ? "error" : "success" } });
        const j = r.isError ? null : jsonOf(r);
        if (j?.greeting) greeting = String(j.greeting);
        if (j?.say) lastSay = String(j.say);
        // Per the skill, these end the turn: ask the question / speak "say", then wait for the person.
        if (!r.isError && name === "get_journal_prompt" && j?.prompt) {
          reply = `${greeting} ${j.prompt}`.trim();
          finished = true;
          Object.assign(st, { mode: "answer", member: findMember(String(args.member_name ?? speaker))?.name ?? speaker, prompt: String(j.prompt), threadId: (j.thread_id as number | null) ?? null, followUps: 0 });
        }
        if (!r.isError && (name === "save_journal_entry" || name === "save_family_conversation") && j?.say) { reply = String(j.say); finished = true; }
      }
      history.push({ role: "user", content: results });
      if (finished) history.push({ role: "assistant", content: [{ text: reply }] });
    }
    s.messages = history;
    trim(s.messages);
    // Nova sometimes wraps its reasoning in <thinking> tags; never speak it.
    reply = reply.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, "").trim();
    return { reply: reply || lastSay || "Done.", agent: "bedrock", steps: turn.steps, ui: turn.ui };
  }, fwd);
}

// ───────────────────────────── Scripted router (offline) ─────────────────────────────

const namesIn = (text: string) =>
  allMembers().filter((m) => [m.name, m.relation ?? ""].some((n) => n && new RegExp(`\\b${n}\\b`, "i").test(text))).map((m) => m.name);

async function scriptedTurn(s: Session, speaker: string, text: string, fwd: Forward): Promise<TurnResult> {
  return withMcp(async (client) => {
    const { tools } = (await client.listTools()) as { tools: McpTool[] };
    const turn = new Turn(client, tools);
    const st = s.script;
    const t = text.toLowerCase();
    const pin = /\b(?:pin(?: is| number is)?|it's)\s*(\d{4,6})\b/i.exec(text)?.[1] ?? (st.pinFor ? /\b(\d{4,6})\b/.exec(text)?.[1] : undefined);
    const say = (r: CallResult, fallback = "Done.") => (r.isError ? textOf(r) : String(jsonOf(r)?.say ?? fallback));
    let reply = "";

    const startJournal = async (who: string) => {
      const sess = jsonOf(await turn.call("start_journal_session", { member_name: who }));
      const p = jsonOf(await turn.call("get_journal_prompt", { member_name: who }));
      if (!sess || !p) return "I couldn't open that journal.";
      Object.assign(st, { mode: "answer", member: findMember(who)?.name ?? who, prompt: String(p.prompt), threadId: (p.thread_id as number | null) ?? null, followUps: 0 });
      return `${sess.greeting} ${p.prompt}`;
    };

    if (st.pinFor && pin) {
      const r = await turn.call(st.pinFor.tool, { ...st.pinFor.args, pin });
      st.pinFor = undefined;
      reply = say(r);
    } else if (st.mode === "convo" && st.convo) {
      if (/\b(that'?s all|we'?re done|we are done|finish|save (it|the chat)|goodbye|bye)\b/.test(t)) {
        const r = await turn.call("save_family_conversation", { turns: st.convo.turns, prompt: st.convo.prompt, ...(st.convo.threadId ? { thread_id: st.convo.threadId } : {}) });
        reply = say(r);
        st.mode = "idle"; st.convo = undefined;
      } else {
        st.convo.turns.push({ speaker, text });
        const others = st.convo.participants.filter((p) => p !== (findMember(speaker)?.name ?? speaker));
        const next = others[st.convo.turns.length % Math.max(1, others.length)] ?? others[0];
        const who = findMember(next ?? "");
        reply = next ? `Lovely. ${who?.relation && who.relation !== who.name ? who.relation : next}, what do you think?` : "Lovely. Tell me more!";
      }
    } else if (st.mode === "answer" && st.member && findMember(speaker)?.name === st.member && !/^(alexa,? )?(stop|cancel)\b/.test(t)) {
      const r = await turn.call("save_journal_entry", { member_name: st.member, transcript: text, prompt: st.prompt, ...(st.threadId ? { thread_id: st.threadId } : {}) });
      const j = jsonOf(r);
      reply = say(r);
      const member = findMember(st.member);
      if (!r.isError && member?.role === "child" && j?.follow_up && !j.safety && (st.followUps ?? 0) < 1) {
        Object.assign(st, { prompt: String(j.follow_up), threadId: null, followUps: (st.followUps ?? 0) + 1 });
      } else st.mode = "idle";
    } else if (/\b(start|have|begin)\b.*\b(chat|conversation)\b|\bfamily table\b/.test(t)) {
      const people = [...new Set([findMember(speaker)?.name ?? speaker, ...namesIn(text)])];
      const r = await turn.call("start_family_conversation", { participants: people });
      const j = jsonOf(r);
      if (j) {
        st.mode = "convo";
        st.convo = { prompt: String(j.opener), threadId: (j.thread_id as number | null) ?? null, participants: (j.participants as { name: string }[]).map((p) => p.name), turns: [] };
        reply = String(j.opener);
      } else reply = textOf(r);
    } else if (/\bradio\b/.test(t)) {
      const r = await turn.call("play_family_radio", { requested_by: speaker });
      const j = jsonOf(r);
      reply = j ? `Here's this week's Family Radio. ${String(j.script).replace(/\n+/g, " ")}` : textOf(r);
    } else if (/\bshow\b.*\bfamily\b|\b(anything|something|who'?s) waiting\b/.test(t)) {
      reply = say(await turn.call("show_family", { requested_by: speaker }));
    } else if (/\bdelete\b/.test(t)) {
      reply = say(await turn.call("delete_journal_entry", { member_name: speaker, ...(pin ? { pin } : {}) }));
    } else if (/\b(how('?s| is)\b.*\b(doing|speaking|coming along|going)|progress|new words)\b/.test(t)) {
      const child = namesIn(text).map((n) => findMember(n)!).find((m) => m.role === "child") ?? allMembers().find((m) => m.role === "child");
      const args = { child_name: child?.name ?? "", requested_by: speaker };
      const r = await turn.call("get_kid_speaking_progress", { ...args, ...(pin ? { pin } : {}) });
      if (r.isError && /PIN/.test(textOf(r)) && !pin) st.pinFor = { tool: "get_kid_speaking_progress", args };
      reply = say(r);
    } else if (/^(alexa,? )?(when|what did|who|where|did)\b|\bremember\b/.test(t) && !/\bjournal\b/.test(t)) {
      const r = await turn.call("recall_family_memory", { question: text, asked_by: speaker, ...(pin ? { pin } : {}) });
      const m = (jsonOf(r)?.matches as { date: string; who: string; said: string }[] | undefined)?.[0];
      reply = m ? `On ${m.date}, ${m.who} said: "${m.said}"` : r.isError ? textOf(r) : "I couldn't find that in the family's journal yet.";
    } else {
      reply = await startJournal(speaker);
    }
    return { reply, agent: "scripted", steps: turn.steps, ui: turn.ui };
  }, fwd);
}

// ───────────────────────────── HTTP ─────────────────────────────

export async function simulatorTurn(sessionId: string, speaker: string, text: string, prefer: "auto" | "scripted" = "auto", fwd: Forward = {}): Promise<TurnResult> {
  const s = session(sessionId);
  if (prefer !== "scripted" && llmEnabled()) {
    try {
      return await bedrockTurn(s, speaker, text, fwd);
    } catch (err) {
      console.error("[hearth] simulator agent (Bedrock) failed, using the scripted router:", (err as Error).message);
      s.messages = [];
      return { ...(await scriptedTurn(s, speaker, text, fwd)), note: "Bedrock didn't answer, so the scripted router handled this turn." };
    }
  }
  return scriptedTurn(s, speaker, text, fwd);
}

export function mountSimulator(app: Express, auth: (req: Request, res: Response, next: NextFunction) => void, port: number) {
  selfUrl = `http://127.0.0.1:${port}/mcp`;
  const fail = (res: Response, err: unknown) => res.status(500).json({ error: (err as Error).message });

  // Express treats /sim and /sim/ alike, so only redirect the bare path (the static handler serves /sim/).
  app.get("/sim", (req, res, next) => (req.originalUrl === "/sim" ? res.redirect("/sim/") : next()));
  app.get("/api/sim/info", auth, (_req, res) =>
    res.json({
      agent: llmEnabled() ? "bedrock" : "scripted",
      model: modelId() ?? null,
      skill: { name: skillName, path: "skills/hearth/SKILL.md" },
      members: allMembers().map((m) => ({ name: m.name, called: m.relation, role: m.role, photo: m.photo })),
    }),
  );
  app.post("/api/sim/turn", auth, async (req, res) => {
    const { session: id, speaker, text, prefer } = req.body ?? {};
    if (!id || !speaker || !text) return res.status(400).json({ error: "session, speaker and text are required" });
    try { res.json(await simulatorTurn(String(id), String(speaker), String(text), prefer === "scripted" ? "scripted" : "auto", forwardOf(req))); } catch (e) { fail(res, e); }
  });
  app.post("/api/sim/reset", auth, (req, res) => { sessions.delete(String(req.body?.session ?? "")); res.json({ ok: true }); });
  // The host side of MCP Apps: fetch the screen (resources/read) and relay calls the screen makes (tools/call).
  app.get("/api/sim/resource", auth, async (req, res) => {
    try {
      const out = await withMcp((c) => c.readResource({ uri: String(req.query.uri) }), forwardOf(req));
      const item = out.contents[0] as { text?: string; mimeType?: string; _meta?: unknown };
      res.json({ html: item.text ?? "", mimeType: item.mimeType, meta: item._meta ?? null });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/sim/tool", auth, async (req, res) => {
    try { res.json(await withMcp((c) => c.callTool({ name: String(req.body?.name), arguments: req.body?.arguments ?? {} }), forwardOf(req))); } catch (e) { fail(res, e); }
  });
}
