// Prompt lab: runs real examples through Hearth with Amazon Bedrock, on a throwaway database,
// so you can see exactly what Alexa will say. Run: npm run lab   (reads .env; costs a fraction of a cent)
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

if (!process.env.BEDROCK_MODEL_ID) {
  console.log("BEDROCK_MODEL_ID isn't set — add your Bedrock settings to .env first (see .env.example).");
  process.exit(1);
}
const LAB_DB = "data/lab.db";
for (const f of [LAB_DB, `${LAB_DB}-wal`, `${LAB_DB}-shm`]) rmSync(f, { force: true });

// Seed the demo family offline (fast, free), then switch Bedrock on for the examples.
const offline: NodeJS.ProcessEnv = { ...process.env, HEARTH_DB: LAB_DB };
for (const k of ["BEDROCK_MODEL_ID", "BEDROCK_GUARDRAIL_ID"]) delete offline[k];
execSync("node --no-warnings --import tsx scripts/seed.ts", { env: offline, stdio: "ignore" });
process.env.HEARTH_DB = LAB_DB;

const { saveEntry, saveConversation, familyRadio } = await import("../src/memory.js");
const { db } = await import("../src/db.js");
const { llmLabel } = await import("../src/llm.js");

const bridgesFrom = (entryId: number) =>
  (db.prepare("SELECT prompt FROM threads WHERE source_entry_id = ? AND kind = 'story_bridge'").all(entryId) as { prompt: string }[]).map((r) => r.prompt);
const isTemplate = (s?: string) => !!s && (/^Wow, so /.test(s) || /^Ooh — /.test(s));
const line = () => console.log("─".repeat(72));

console.log(`\nHearth prompt lab · ${llmLabel()}\n`);

line();
console.log("1. Leo's speaking practice (recast + follow-up)\n");
const kid = [
  "We went to the park. I went on the big slide.",
  "I drawed a dinosaur. It was green.",
  "Me and Sam builded a tower with blocks and it falled down.",
  "Today I learned about volcanoes. They are hot inside and lava comes out of the top.",
];
let lastKidEntry = 0;
for (const text of kid) {
  const r = (await saveEntry({ name: "Leo", transcript: text })) as { recast?: string; follow_up?: string; big_words_today?: string[]; entry_id: number };
  console.log(`  Leo:   ${text}`);
  console.log(`  Alexa: ${r.recast} ${r.follow_up}${isTemplate(r.recast) ? "   [template fallback]" : ""}`);
  if (r.big_words_today?.length) console.log(`  (big words: ${r.big_words_today.join(", ")})`);
  console.log();
  lastKidEntry = r.entry_id;
}
const toGran = bridgesFrom(lastKidEntry);
if (toGran.length) console.log(`  …and later, to Gran: ${toGran[0]}\n`);

line();
console.log("2. Gran's memoir → a question for Leo\n");
const gran = await saveEntry({
  name: "Gran",
  prompt: "What do you remember about the day your first child was born?",
  transcript: "It was the coldest night of the year, and the snow was so deep the midwife had to come on a tractor. When I first held Marcus he had a full head of black hair and the loudest cry in the whole street.",
}) as { entry_id: number; summary: string };
console.log(`  Summary: ${gran.summary}`);
console.log(`  To Leo:  ${bridgesFrom(gran.entry_id)[0] ?? "(no bridge — check held_back_for_child)"}\n`);

line();
console.log("3. Family-table conversation summary\n");
const convo = await saveConversation({
  prompt: "If our family went on an adventure tomorrow, where should we go, and why?",
  turns: [
    { speaker: "Leo", text: "The beach! I want to find a crab and build a sandcastle with a moat." },
    { speaker: "Gran", text: "When I was a girl we went to Scarborough every summer and ate chips on the sea wall." },
    { speaker: "Amara", text: "Then it's settled. Scarborough, chips, and the biggest sandcastle ever." },
  ],
}) as { summary: string; say: string };
console.log(`  Summary: ${convo.summary}`);
console.log(`  Alexa:   ${convo.say}\n`);

line();
console.log("4. Family Radio\n");
const radio = await familyRadio(7) as { script: string; generated_with?: string };
console.log(radio.script.split("\n").map((l) => `  ${l}`).join("\n"));
console.log(`\n  [${radio.generated_with ?? "?"}]`);
line();

db.close();
for (const f of [LAB_DB, `${LAB_DB}-wal`, `${LAB_DB}-shm`]) rmSync(f, { force: true });
console.log("\nDone. Paste this output to Claude to tune the prompts further.\n");
