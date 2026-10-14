// End-to-end test: starts the server, connects a real MCP client over Streamable HTTP
// (exactly what Alexa+ does), and walks the demo script. Uses its own database file.
// Run: npm run test:e2e
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.HEARTH_DB = "data/e2e.db";
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { execSync } = await import("node:child_process");

execSync("tsx scripts/seed.ts", { env: { ...process.env, HEARTH_DB: "data/e2e.db" }, stdio: "inherit" });
const { app } = await import("../src/server.js");
const listener = app.listen(0);
await new Promise((r) => listener.once("listening", r));
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

const client = new Client({ name: "hearth-e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

let passed = 0;
async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
}
async function step(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

console.log(`\nHearth e2e against ${base}/mcp\n`);

await step("negotiates MCP protocol 2025-11-25 and lists 8 tools", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.protocol, "2025-11-25");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);
  console.log("     tools:", tools.map((t) => t.name).join(", "));
});

await step("Leo starts a session in speaking-practice mode", async () => {
  const { json } = await call("start_journal_session", { member_name: "Leo" });
  assert.equal(json.mode, "speaking_practice");
  assert.ok(json.family_threads_waiting >= 1);
  console.log("     Alexa:", json.greeting);
});

let threadId: number;
let prompt: string;
await step("Leo's prompt is Gran's bicycle story (family thread)", async () => {
  const { json } = await call("get_journal_prompt", { member_name: "Leo" });
  assert.match(json.prompt, /bicycle/i);
  assert.match(json.source, /Gran/);
  threadId = json.thread_id;
  prompt = json.prompt;
  console.log("     Alexa:", json.prompt);
});

await step("Leo answers; Hearth recasts, follows up and spots a new word", async () => {
  const { json } = await call("save_journal_entry", {
    member_name: "Leo", prompt, thread_id: threadId,
    transcript: "I can ride my cycle without training wheels now. Dad held the seat and then he let go and I didn't even know. I was wobbly but I balanced.",
  });
  assert.ok(json.recast && json.follow_up);
  assert.ok(json.new_words_today.length > 0);
  console.log("     Alexa:", json.say);
});

await step("that thread is now answered and Gran gets a question back from Leo", async () => {
  const { json: aarav } = await call("get_family_threads", { member_name: "Leo" });
  assert.ok(!aarav.some((t: { id: number }) => t.id === threadId));
  const { json: dadu } = await call("get_journal_prompt", { member_name: "Gran" });
  assert.match(dadu.source, /Leo/);
  console.log("     Alexa → Gran:", dadu.prompt);
});

await step("a worried mention of Mum creates a care nudge for Dad — without revealing Leo", async () => {
  await call("save_journal_entry", { member_name: "Leo", transcript: "Mum looked really tired today and she had a headache after work." });
  const { json } = await call("get_journal_prompt", { member_name: "Marcus" });
  assert.equal(json.source, "family care nudge");
  assert.doesNotMatch(json.prompt, /Leo/);
  const { json: forAmara } = await call("get_family_threads", { member_name: "Amara" });
  assert.ok(!forAmara.some((t: { kind: string }) => t.kind === "care_nudge"), "the person it's about doesn't get the nudge");
  console.log("     Alexa → Marcus:", json.prompt);
});

await step("Amara's log notices she's been tired several days this week", async () => {
  const { json } = await call("save_journal_entry", { member_name: "Amara", transcript: "Tired again, the deadline moved up. Going to bed early." });
  assert.ok(json.pattern, "expected a pattern");
  console.log("     Alexa:", json.say);
});

await step("Gran's story joins a memoir chapter", async () => {
  const { json: p } = await call("get_journal_prompt", { member_name: "Gran" });
  const { json } = await call("save_journal_entry", {
    member_name: "Gran", prompt: p.prompt, thread_id: p.thread_id ?? undefined,
    transcript: "Leo, I am so proud of you. When I learned, nobody held the seat for me — I learned by falling. Your Dad held your seat; one day you will hold someone's seat too.",
  });
  assert.ok(json.chapter);
  console.log("     Alexa:", json.say);
});

await step("parent sees Leo's speaking progress; Leo's sentences got longer", async () => {
  const { json } = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Amara" });
  assert.ok(json.sentence_length_change_pct > 50, `MLU change ${json.sentence_length_change_pct}%`);
  console.log("     Alexa:", json.say);
});

await step("someone who isn't a parent can't open the progress report", async () => {
  const r = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Gran" });
  assert.ok(r.isError);
});

await step("recall finds Dad's plumber call", async () => {
  const { json } = await call("recall_family_memory", { question: "When is the plumber coming?", asked_by: "Marcus" });
  assert.match(json.matches[0].said, /Dave/);
  console.log("     match:", json.matches[0].date, "—", json.matches[0].summary);
});

await step("privacy: Amara can't recall Marcus's private surprise-party entry", async () => {
  const { json } = await call("recall_family_memory", { question: "surprise party birthday restaurant terrace", asked_by: "Amara" });
  assert.ok(!json.matches.some((m: { said: string }) => /surprise/i.test(m.said)));
  const { json: own } = await call("recall_family_memory", { question: "surprise party birthday restaurant terrace", asked_by: "Marcus" });
  assert.ok(own.matches.some((m: { said: string }) => /surprise/i.test(m.said)), "the author can still see it");
});

await step("Family Radio script covers everyone and leaves out private entries", async () => {
  const { json } = await call("play_family_radio", { requested_by: "Amara" });
  for (const n of ["Leo", "Amara", "Marcus"]) assert.ok(json.script.includes(n), `script mentions ${n}`);
  assert.doesNotMatch(json.script, /surprise/i);
  console.log("     script:\n" + json.script.split("\n").filter(Boolean).map((l: string) => "       " + l).join("\n"));
});

await step("unknown member gets a friendly error", async () => {
  const r = await call("start_journal_session", { member_name: "Zorro" });
  assert.ok(r.isError && /Members:/.test(r.text));
});

await step("journal panel: Uncle Finn can't open Leo's journal, a parent can", async () => {
  const finn = await (await fetch(`${base}/api/journal/Leo?viewer=Finn`)).json();
  assert.equal(finn.locked, true);
  const mum = await (await fetch(`${base}/api/journal/Leo?viewer=Amara`)).json();
  assert.equal(mum.locked, false);
  assert.ok(mum.entries.length > 0 && mum.first_answer);
});

await step("journal panel: Marcus's private entry is a placeholder for Amara, and nudges stay hidden", async () => {
  const j = await (await fetch(`${base}/api/journal/Marcus?viewer=Amara`)).json();
  assert.ok(j.entries.some((e: { hidden?: boolean }) => e.hidden));
  assert.ok(!JSON.stringify(j).includes("surprise"));
  assert.ok(j.waiting.every((w: { kind: string; hidden?: boolean }) => w.kind !== "care_nudge" || w.hidden));
  assert.equal(j.noticed, null, "patterns are only shown to the person themselves");
});

await step("dashboard API serves parents and refuses non-parents", async () => {
  const ok = await fetch(`${base}/api/dashboard?viewer=Amara`);
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.equal(d.kids[0].child, "Leo");
  assert.equal((await fetch(`${base}/api/dashboard?viewer=Leo`)).status, 400);
});

await client.close();
listener.close();
console.log(`\n${passed} checks passed.\n`);
process.exit(0);
