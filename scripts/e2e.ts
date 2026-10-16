// End-to-end test: starts the server, connects a real MCP client over Streamable HTTP
// (exactly what Alexa+ does), and walks the demo plus the privacy and safety rules.
// Uses its own database file. Run: npm run test:e2e
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.HEARTH_DB = "data/e2e.db";
// Always offline: free, and the checks below don't depend on what an AI model writes.
for (const k of ["BEDROCK_MODEL_ID", "BEDROCK_GUARDRAIL_ID", "AWS_BEARER_TOKEN_BEDROCK"]) delete process.env[k];
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { execSync } = await import("node:child_process");

execSync("node --no-warnings --import tsx scripts/seed.ts", { env: { ...process.env, HEARTH_DB: "data/e2e.db" }, stdio: "inherit" });
const { app } = await import("../src/server.js");
const listener = app.listen(0);
await new Promise((r) => listener.once("listening", r));
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const PIN = "1234";

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
async function sessionFor(viewer: string, pin?: string): Promise<string> {
  const r = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewer, pin }) });
  assert.equal(r.status, 200, `session for ${viewer}`);
  return (await r.json()).token;
}
const get = async (path: string, token?: string) => {
  const r = await fetch(`${base}${path}`, { headers: token ? { "x-hearth-session": token } : {} });
  return { status: r.status, json: await r.json() };
};

console.log(`\nHearth e2e against ${base}/mcp\n`);

// ── The core demo ──

await step("negotiates MCP protocol 2025-11-25 and lists 11 tools", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.protocol, "2025-11-25");
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
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

await step("a summary instead of Leo's own words is rejected (paraphrase guard)", async () => {
  const r = await call("save_journal_entry", { member_name: "Leo", prompt, thread_id: threadId, transcript: "Leo said he can ride his bike now and his dad helped." });
  assert.ok(r.isError && /exact words/.test(r.text));
  const r2 = await call("save_journal_entry", { member_name: "Leo", transcript: "He said that he rode his bike." });
  assert.ok(r2.isError);
});

let leoEntry: number;
await step("Leo answers in his own words; Hearth recasts and spots age-graded big words", async () => {
  const { json } = await call("save_journal_entry", {
    member_name: "Leo", prompt, thread_id: threadId,
    transcript: "I can ride my cycle without training wheels now. Dad held the seat and then he let go and I didn't even know. I was wobbly but I balanced.",
  });
  assert.ok(json.recast && json.follow_up);
  assert.ok(json.big_words_today.includes("wobbly"), `big words: ${json.big_words_today}`);
  assert.ok(!json.big_words_today.includes("bicycle"), "words echoed from the question don't count");
  leoEntry = json.entry_id;
  console.log("     Alexa:", json.say);
});

await step("that thread is answered and Gran gets a question back from Leo", async () => {
  const { json: leo } = await call("get_family_threads", { member_name: "Leo" });
  assert.ok(!leo.some((t: { id: number }) => t.id === threadId));
  const { json: gran } = await call("get_journal_prompt", { member_name: "Gran" });
  assert.match(gran.source, /Leo/);
  console.log("     Alexa → Gran:", gran.prompt);
});

await step("a mild worry about Mum gives Dad a care nudge — without revealing Leo", async () => {
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

await step("Gran's reply joins her memoir", async () => {
  const { json: p } = await call("get_journal_prompt", { member_name: "Gran" });
  const { json } = await call("save_journal_entry", {
    member_name: "Gran", prompt: p.prompt, thread_id: p.thread_id ?? undefined,
    transcript: "Oh Leo, I am so proud of you. When I learned, nobody held the seat for me, I learned by falling. Your Dad held your seat; one day you will hold someone's seat too.",
  });
  assert.ok(json.chapter);
  console.log("     Alexa:", json.say);
});

// ── Light PIN ──

await step("progress by voice: a parent needs their PIN; wrong PIN refused; right PIN works", async () => {
  const none = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Amara" });
  assert.ok(none.isError && /PIN/.test(none.text));
  const wrong = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Amara", pin: "9999" });
  assert.ok(wrong.isError && /didn't match/.test(wrong.text));
  const { json } = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Amara", pin: PIN });
  assert.ok(json.words_per_answer_latest_week > json.words_per_answer_first_week * 2, "answers more than doubled");
  assert.ok(json.recent_big_words.length > 0);
  console.log("     Alexa:", json.say);
});

await step("someone who isn't a parent can't hear the progress report", async () => {
  const r = await call("get_kid_speaking_progress", { child_name: "Leo", requested_by: "Gran" });
  assert.ok(r.isError);
});

await step("recall finds Dad's plumber call, even without a PIN (it isn't private)", async () => {
  const { json } = await call("recall_family_memory", { question: "When is the plumber coming?", asked_by: "Marcus" });
  assert.match(json.matches[0].said, /Dave/);
  console.log("     match:", json.matches[0].date, "—", json.matches[0].summary);
});

await step("Marcus's private entry: hidden from Amara, and from Marcus too until he says his PIN", async () => {
  const q = "surprise party birthday restaurant terrace";
  const { json: amara } = await call("recall_family_memory", { question: q, asked_by: "Amara", pin: PIN });
  assert.ok(!amara.matches.some((m: { said: string }) => /surprise/i.test(m.said)));
  const { json: noPin } = await call("recall_family_memory", { question: q, asked_by: "Marcus" });
  assert.ok(!noPin.matches.some((m: { said: string }) => /surprise/i.test(m.said)), "no PIN = household view");
  const { json: own } = await call("recall_family_memory", { question: q, asked_by: "Marcus", pin: PIN });
  assert.ok(own.matches.some((m: { said: string }) => /surprise/i.test(m.said)), "with his PIN he finds it");
});

// ── Delete, consent ──

await step("\"delete what I just said\": Leo deletes his latest entry with no PIN", async () => {
  const before = await call("save_journal_entry", { member_name: "Leo", transcript: "I want to say something silly about bananas and monkeys dancing on the moon." });
  const { json } = await call("delete_journal_entry", { member_name: "Leo" });
  assert.equal(json.deleted, true);
  assert.equal(json.entry_id, before.json.entry_id);
});

await step("deleting someone else's entry needs to be their parent, with a PIN", async () => {
  const finn = await call("delete_journal_entry", { member_name: "Finn", for_member: "Leo", entry_id: leoEntry, pin: PIN });
  assert.ok(finn.isError, "Finn isn't Leo's parent");
  const noPin = await call("delete_journal_entry", { member_name: "Amara", for_member: "Leo", entry_id: leoEntry });
  assert.ok(noPin.isError && /PIN/.test(noPin.text));
});

await step("a child's profile needs a parent's consent", async () => {
  const noParent = await call("manage_family_members", { action: "add", name: "Mia", role: "child", age: 5 });
  assert.ok(noParent.isError);
  const ask = await call("manage_family_members", { action: "add", name: "Mia", role: "child", age: 5, requested_by: "Amara" });
  assert.ok(ask.isError && /agree/.test(ask.text), "Hearth reads out the consent statement first");
  const ok = await call("manage_family_members", { action: "add", name: "Mia", role: "child", age: 5, requested_by: "Amara", parent_consent: true });
  assert.equal(ok.json.added, "Mia");
});

// ── Safety ──

await step("care nudges never fire on conflict words", async () => {
  // Clear Dad's waiting nudge first so a new one would show up.
  await call("save_journal_entry", { member_name: "Marcus", transcript: "Checked in on Amara and made her tea.", thread_id: (await call("get_journal_prompt", { member_name: "Marcus" })).json.thread_id });
  await call("save_journal_entry", { member_name: "Leo", transcript: "Mum was angry and shouted at the TV during the football." });
  const { json } = await call("get_family_threads", { member_name: "Marcus" });
  assert.ok(!json.some((t: { kind: string }) => t.kind === "care_nudge"));
});

await step("a possible safety disclosure is shared with no one — not even parents", async () => {
  const { json } = await call("save_journal_entry", { member_name: "Leo", transcript: "Someone hurt me and told me not to tell anyone about it." });
  assert.equal(json.safety, "household_harm");
  assert.match(json.say, /grown-up you trust/);
  assert.equal(json.family_threads_created, 0);
  const mum = await sessionFor("Amara", PIN);
  const j = await get("/api/journal/Leo", mum);
  assert.ok(!JSON.stringify(j.json).includes("hurt me"), "parents can't read it");
  assert.ok(j.json.entries.some((e: { hidden?: boolean }) => e.hidden), "it shows only as a private entry");
});

await step("a peer at school is different: parents can still see it, and Alexa encourages telling them", async () => {
  const { json } = await call("save_journal_entry", { member_name: "Leo", transcript: "A boy called Sam kicked me at school today and I cried." });
  assert.equal(json.safety, "peer_harm");
  const j = await get("/api/journal/Leo", await sessionFor("Amara", PIN));
  assert.ok(JSON.stringify(j.json).includes("kicked me"));
});

await step("content headed to a child is checked first (Gran's story with 'died' isn't relayed)", async () => {
  const { json } = await call("save_journal_entry", { member_name: "Gran", transcript: "The winter my grandfather died we all went to stay with my aunt by the sea, and I learned to swim in the cold water there." });
  assert.equal(json.family_threads_created, 0);
  assert.ok(json.held_back_for_child >= 1, "held back for every child");
});

// ── Family conversation ──

let convo: { opener: string; thread_id: number | null };
await step("start a family conversation: the opener comes from the family's own stories", async () => {
  const { json } = await call("start_family_conversation", { participants: ["Gran", "Leo", "Mum"] });
  assert.equal(json.participants.length, 3);
  assert.ok(json.opener && json.host_guide.includes("voice ID"));
  convo = json;
  console.log("     Alexa:", json.opener);
});

await step("save it: each turn goes to that person's journal, and Leo's count toward practice", async () => {
  const { json } = await call("save_family_conversation", {
    prompt: convo.opener, thread_id: convo.thread_id ?? undefined,
    turns: [
      { speaker: "Gran", text: "My grandmother made the best scones in the whole county." },
      { speaker: "Leo", text: "Can we make scones on Saturday? I will measure the flour very carefully and crack the eggs." },
      { speaker: "Mum", text: "That's a lovely idea. Gran, will you teach us the recipe?" },
      { speaker: "Gran", text: "Only if Leo promises to lick the bowl." },
    ],
  });
  assert.equal(json.turns, 4);
  assert.deepEqual(json.participants.sort(), ["Amara", "Leo", "Rose"]);
  console.log("     Alexa:", json.say);
});

await step("conversation privacy: Uncle Finn wasn't there and can't see it; a parent can", async () => {
  const finn = await get("/api/dashboard", await sessionFor("Finn", PIN));
  assert.ok(!JSON.stringify(finn.json.timeline).includes("scones"));
  const mum = await get("/api/dashboard", await sessionFor("Amara", PIN));
  assert.ok(mum.json.timeline.some((x: { type: string; summary?: string; turns?: { text: string }[] }) => x.type === "conversation" && x.turns!.some((t) => t.text.includes("scones"))));
});

// ── Dashboard sessions, radio, paging, live refresh ──

await step("dashboard: no session = household view; wrong PIN refused; parent session sees kids", async () => {
  const house = await get("/api/dashboard");
  assert.equal(house.json.viewer, null);
  const locked = await get("/api/journal/Leo");
  assert.equal(locked.json.locked, true);
  const bad = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewer: "Amara", pin: "0000" }) });
  assert.equal(bad.status, 401);
  const gran = await sessionFor("Rose"); // Gran chose no PIN
  assert.equal((await get("/api/dashboard", gran)).json.viewer, "Rose");
  const mum = await get("/api/journal/Leo", await sessionFor("Amara", PIN));
  assert.equal(mum.json.locked, false);
  assert.ok(mum.json.first_answer && mum.json.stats.length === 3);
});

await step("the URL can't pick the viewer any more (?viewer=Amara is ignored)", async () => {
  const r = await get("/api/journal/Leo?viewer=Amara");
  assert.equal(r.json.locked, true);
});

await step("deleting from the dashboard: the author can; Finn can't delete Leo's entry", async () => {
  const finn = await sessionFor("Finn", PIN);
  const r1 = await fetch(`${base}/api/entries/${leoEntry}`, { method: "DELETE", headers: { "x-hearth-session": finn } });
  assert.ok(r1.status >= 400);
  const mum = await sessionFor("Amara", PIN);
  const r2 = await fetch(`${base}/api/entries/${leoEntry}`, { method: "DELETE", headers: { "x-hearth-session": mum } });
  assert.equal(r2.status, 200, "a parent can delete their child's entry");
  const j = await get("/api/journal/Leo", mum);
  assert.ok(!j.json.entries.some((e: { id: number }) => e.id === leoEntry));
});

await step("older entries page in 12 at a time", async () => {
  const mum = await sessionFor("Amara", PIN);
  const p1 = await get("/api/journal/Leo", mum);
  assert.equal(p1.json.entries.length, 12);
  assert.equal(p1.json.more, true);
  const p2 = await get(`/api/journal/Leo?before=${p1.json.entries.at(-1).id}`, mum);
  assert.ok(p2.json.entries.length > 0);
  assert.ok(!p2.json.entries.some((e: { id: number }) => p1.json.entries.some((x: { id: number }) => x.id === e.id)));
});

await step("live refresh: the data version changes when someone talks to Alexa", async () => {
  const v1 = (await get("/api/pulse")).json.version;
  await call("save_journal_entry", { member_name: "Finn", transcript: "Booked the climbing session for Saturday morning." });
  const v2 = (await get("/api/pulse")).json.version;
  assert.ok(v2 > v1);
});

await step("Family Radio covers everyone and leaves out private and sensitive entries", async () => {
  const { json } = await call("play_family_radio", {});
  for (const n of ["Leo", "Amara", "Marcus"]) assert.ok(json.script.includes(n), `script mentions ${n}`);
  assert.doesNotMatch(json.script, /surprise|hurt me/i);
  console.log("     script:\n" + json.script.split("\n").filter(Boolean).map((l: string) => "       " + l).join("\n"));
});

await step("Streamable HTTP spec: untrusted Origin → 403, bad protocol version → 400, GET/DELETE → 405", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { ...h, origin: "https://evil.example" }, body: init })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { ...h, origin: base }, body: init })).status, 200, "same origin is fine");
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: h, body: init })).status, 200, "no Origin (Alexa+, server-to-server) is fine");
  const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { ...h, "mcp-protocol-version": "1999-01-01" }, body: listTools })).status, 400);
  assert.equal((await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } })).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: "DELETE" })).status, 405);
});

await step("unknown member gets a friendly error", async () => {
  const r = await call("start_journal_session", { member_name: "Zorro" });
  assert.ok(r.isError && /Members:/.test(r.text));
});

await step("retention: entries older than the keep period are removed (memoir is kept)", async () => {
  const { purgeExpired } = await import("../src/memory.js");
  const mum = await sessionFor("Amara", PIN);
  const leoBefore = (await get("/api/journal/Leo", mum)).json.total;
  const granBefore = (await get("/api/journal/Gran", mum)).json.total;
  process.env.HEARTH_KEEP_DAYS_CHILD = "10";
  const removed = purgeExpired();
  delete process.env.HEARTH_KEEP_DAYS_CHILD;
  assert.ok(removed > 0);
  assert.ok((await get("/api/journal/Leo", mum)).json.total < leoBefore);
  assert.equal((await get("/api/journal/Gran", mum)).json.total, granBefore, "memoir stories are kept until deleted");
});

await client.close();
listener.close();
console.log(`\n${passed} checks passed.\n`);
process.exit(0);
