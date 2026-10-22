// A tiny stand-in for the Amazon Bedrock Converse API, for tests without AWS access.
// It answers each kind of Hearth prompt with canned JSON, and plays a simple tool-using agent.
import http from "node:http";
import type { AddressInfo } from "node:net";

type Block = { text?: string; toolUse?: { toolUseId: string; name: string; input: unknown }; toolResult?: { toolUseId: string; content: { text?: string; json?: unknown }[] } };
type Msg = { role: "user" | "assistant"; content: Block[] };

export interface MockBedrock { url: string; calls: { kind: string; body: unknown }[]; close: () => Promise<void> }

const reply = (content: Block[], stopReason: string) => ({
  output: { message: { role: "assistant", content } },
  stopReason,
  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  metrics: { latencyMs: 5 },
});

/** The mock agent: picks a tool from keywords, then speaks the tool's `say` (or a short line). */
function agentTurn(messages: Msg[], toolNames: string[]) {
  const last = messages.at(-1)!;
  const result = last.content.find((b) => b.toolResult)?.toolResult;
  if (result) {
    const text = result.content.map((c) => c.text ?? JSON.stringify(c.json ?? "")).join("");
    let say = "Done.";
    try { say = (JSON.parse(text) as { say?: string; script?: string }).say ?? "Here you go."; } catch { say = text.slice(0, 120); }
    return reply([{ text: say }], "end_turn");
  }
  const said = (last.content.find((b) => b.text)?.text ?? "").toLowerCase();
  const speaker = /speaker: (\w+)/i.exec(said)?.[1] ?? "Amara";
  const pick = (name: string, input: unknown) =>
    toolNames.includes(name) ? reply([{ text: "One moment." }, { toolUse: { toolUseId: `t${Date.now()}`, name, input } }], "tool_use") : reply([{ text: "I can't do that." }], "end_turn");
  // Reproduces a real Nova Lite slip: opening the journal AND inventing the child's answer in one go.
  if (said.includes("open my journal")) return reply([
    { toolUse: { toolUseId: "j1", name: "start_journal_session", input: { member_name: speaker } } },
    { toolUse: { toolUseId: "j2", name: "get_journal_prompt", input: { member_name: speaker } } },
    { toolUse: { toolUseId: "j3", name: "save_journal_entry", input: { member_name: speaker, transcript: "I felt happy and proud." } } },
  ], "tool_use");
  if (said.includes("radio")) return pick("play_family_radio", {});
  if (said.includes("show") && said.includes("family")) return pick("show_family", { requested_by: speaker });
  if (said.includes("doing")) return pick("get_kid_speaking_progress", { child_name: "Leo", requested_by: speaker, pin: "1234" });
  return pick("get_family_threads", { member_name: speaker });
}

export async function startMockBedrock(delayMs = 150): Promise<MockBedrock> {
  const calls: MockBedrock["calls"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { system?: { text: string }[]; messages: Msg[]; toolConfig?: { tools: { toolSpec: { name: string } }[] } };
      const system = (body.system ?? []).map((s) => s.text).join("\n");
      const user = body.messages?.[0]?.content?.map((b) => b.text ?? "").join("") ?? "";
      let out: unknown;
      let kind: string;
      if (body.toolConfig) {
        kind = "agent";
        out = agentTurn(body.messages, body.toolConfig.tools.map((t) => t.toolSpec.name));
      } else if (system.includes("Family Radio")) {
        kind = "radio";
        out = reply([{ text: JSON.stringify({ script: "MOCK episode. Good evening, family!\n\nThat's all for this week." }) }], "end_turn");
      } else if (system.includes("Summarise this family conversation")) {
        kind = "conversation";
        out = reply([{ text: JSON.stringify({ summary: "MOCK conversation summary." }) }], "end_turn");
      } else if (system.includes("Given one journal entry")) {
        kind = "extract";
        const targets = /bridges: for each of \[([^\]]+)\]/.exec(system)?.[1].split(", ").map((t) => t.split(" ")[0]) ?? [];
        const care = /care: the child mentioned (\w+)/.exec(system)?.[1];
        out = reply([{ text: JSON.stringify({
          summary: "MOCK summary.", mood: "happy", topics: ["mock"], people: [],
          bridges: targets.map((to) => ({ to, prompt: `MOCK bridge for ${to}: tell me about it?` })),
          ...(care ? { care: { about: care, nudge: `MOCK nudge about ${care}.` } } : {}),
        }) }], "end_turn");
      } else {
        kind = "other";
        out = reply([{ text: user.includes("Hearth is connected") ? "Hearth is connected." : "{}" }], "end_turn");
      }
      calls.push({ kind, body });
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise((r) => server.close(() => r())) };
}
