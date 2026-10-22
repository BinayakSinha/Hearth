// Tests the Bedrock code paths against a local mock of the Converse API:
// instant replies with background enrichment, pre-written Family Radio, and the simulator's agent loop.
// Run: npm run test:bedrock
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { startMockBedrock } from "./mock-bedrock.js";

const mock = await startMockBedrock(300); // each "Bedrock" call takes 300 ms
const DB = "data/bedrock-test.db";
execSync("node --no-warnings --import tsx scripts/seed.ts", { env: { ...process.env, HEARTH_DB: DB, BEDROCK_MODEL_ID: "" }, stdio: "ignore" });
Object.assign(process.env, {
  HEARTH_DB: DB, BEDROCK_MODEL_ID: "mock-model", BEDROCK_ENDPOINT: mock.url, AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
});
delete process.env.AWS_BEARER_TOKEN_BEDROCK;

const { saveEntry, saveConversation, familyRadio, whenIdle } = await import("../src/memory.js");
const { db } = await import("../src/db.js");

let passed = 0;
async function step(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${label}`);
}
const settle = async () => { await new Promise((r) => setTimeout(r, 60)); await whenIdle(); };

console.log(`\nHearth × mock Bedrock (${mock.url})\n`);

await step("a journal save answers fast even though Bedrock is slow (300 ms per call)", async () => {
  const t0 = Date.now();
  const r = await saveEntry({ name: "Gran", transcript: "When I was nine I won a prize at the village fair for growing the biggest marrow anyone had ever seen." }) as { entry_id: number; family_threads?: string };
  const ms = Date.now() - t0;
  assert.ok(ms < 250, `took ${ms} ms`);
  assert.match(r.family_threads ?? "", /background/);
  console.log(`     answered in ${ms} ms`);
  await settle();
  const e = db.prepare("SELECT summary FROM entries WHERE id = ?").get(r.entry_id) as { summary: string };
  assert.equal(e.summary, "MOCK summary.", "Bedrock's summary replaced the quick one");
  const t = db.prepare("SELECT prompt FROM threads WHERE source_entry_id = ?").all(r.entry_id) as { prompt: string }[];
  assert.ok(t.some((x) => x.prompt.startsWith("MOCK bridge for Leo")), "Bedrock's story bridge reached Leo");
});

await step("a safety disclosure is never sent to Bedrock", async () => {
  const before = mock.calls.length;
  await saveEntry({ name: "Leo", transcript: "Someone hurt me and told me not to tell anyone." });
  await settle();
  const sent = mock.calls.slice(before).filter((c) => JSON.stringify(c.body).includes("hurt me"));
  assert.equal(sent.length, 0);
});

await step("conversation summary is written by Bedrock in the background — without sensitive turns", async () => {
  const before = mock.calls.length;
  const r = await saveConversation({
    turns: [
      { speaker: "Leo", text: "Can we go to the beach on Saturday and build a sandcastle?" },
      { speaker: "Amara", text: "Yes, if the weather is nice we can take a picnic too." },
      { speaker: "Leo", text: "Someone told me not to tell anyone about our secret." },
    ],
  }) as { conversation_id: number };
  await settle();
  const c = db.prepare("SELECT summary FROM conversations WHERE id = ?").get(r.conversation_id) as { summary: string };
  assert.equal(c.summary, "MOCK conversation summary.");
  const leaked = mock.calls.slice(before).some((x) => JSON.stringify(x.body).includes("not to tell"));
  assert.ok(!leaked, "the sensitive turn stayed out of the Bedrock request");
});

await step("Family Radio is written ahead of time, so asking for it is instant", async () => {
  // Hearth writes the episode a few seconds after the journal changes; the first request
  // (or that timer) kicks it off, and every request after that is served from the finished episode.
  await familyRadio(7);
  await settle();
  const t0 = Date.now();
  const ep = await familyRadio(7);
  const ms = Date.now() - t0;
  assert.equal(ep.generated_with, "bedrock");
  assert.match(ep.script, /MOCK episode/);
  assert.ok(ms < 100, `took ${ms} ms`);
  console.log(`     served in ${ms} ms`);
});

// ── The simulator's Alexa+ agent: Bedrock tool use → MCP tools over Streamable HTTP ──
const { app } = await import("../src/server.js");
const listener = app.listen(0);
await new Promise((r) => listener.once("listening", r));
const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
process.env.HEARTH_SELF_URL = `${base}/mcp`;

await step("simulator agent: Bedrock picks a Hearth tool and calls it over MCP (Streamable HTTP)", async () => {
  const r = await fetch(`${base}/api/sim/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "t1", speaker: "Amara", text: "Alexa, play Family Radio" }),
  });
  assert.equal(r.status, 200);
  const j = await r.json() as { reply: string; agent: string; steps: { tool: string }[]; ui?: { resourceUri: string } };
  assert.equal(j.agent, "bedrock");
  assert.ok(j.steps.some((s) => s.tool === "play_family_radio"));
  assert.equal(j.ui?.resourceUri, "ui://hearth/screen.html", "Family Radio comes with its Echo Show screen");
  console.log(`     Alexa: ${j.reply.slice(0, 80)}`);
});

await step("simulator agent: never saves words the child didn't say; asks the question and waits", async () => {
  const r = await fetch(`${base}/api/sim/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "t2", speaker: "Leo", text: "Alexa, open my journal" }),
  });
  const j = await r.json() as { reply: string; steps: { tool: string }[] };
  assert.ok(!j.steps.some((s) => s.tool === "save_journal_entry"), "the invented answer was not saved");
  assert.ok(j.steps.some((s) => s.tool === "get_journal_prompt"));
  assert.match(j.reply, /\?/, "Alexa asks the journal question");
  assert.notEqual(j.reply, "Done.");
  console.log(`     Alexa: ${j.reply.slice(0, 90)}`);
  const ans = await (await fetch(`${base}/api/sim/turn`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "t2", speaker: "Leo", text: "I rode my bike to the shop with Dad" }),
  })).json() as { reply: string; steps: { tool: string; args: { transcript?: string } }[] };
  const save = ans.steps.find((s) => s.tool === "save_journal_entry");
  assert.equal(save?.args.transcript, "I rode my bike to the shop with Dad", "Leo's answer is saved word for word");
  console.log(`     Alexa: ${ans.reply.slice(0, 90)}`);
});

listener.close();
await mock.close();
db.close();
console.log(`\n${passed} checks passed.\n`);
process.exit(0);
