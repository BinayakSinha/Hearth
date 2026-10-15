// One real call to Amazon Bedrock, with a plain-English diagnosis if it fails.
// Run: npm run check:bedrock   (reads .env)
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { completeJson } from "../src/llm.js";

const region = process.env.AWS_REGION;
const model = process.env.BEDROCK_MODEL_ID;
const hasKey = !!process.env.AWS_BEARER_TOKEN_BEDROCK || !!process.env.AWS_ACCESS_KEY_ID || !!process.env.AWS_PROFILE;

console.log(`Region: ${region ?? "(not set)"}   Model: ${model ?? "(not set)"}   Key: ${hasKey ? "found" : "missing"}\n`);
if (!region || !model || !hasKey) {
  console.log("Add AWS_REGION, BEDROCK_MODEL_ID and AWS_BEARER_TOKEN_BEDROCK to your .env file (see .env.example).");
  process.exit(1);
}

function explain(err: Error & { name?: string; $metadata?: { httpStatusCode?: number } }): string {
  const m = `${err.name ?? ""} ${err.message ?? ""}`;
  if (/scoped to a valid region/i.test(m)) return `Your API key was made in a different region. Generate it again with the console set to ${region}, or change AWS_REGION to match the key.`;
  if (/UnrecognizedClient|invalid.*token|security token|Unauthorized|bearer/i.test(m) || err.$metadata?.httpStatusCode === 401) return "The API key wasn't accepted. Check it's pasted completely, with no quotes or spaces, and hasn't expired.";
  if (/AccessDenied|don't have access|not authorized|model access/i.test(m)) return "Your account doesn't have access to this model yet. In the Bedrock console (same region), open Model access and request Amazon Nova Lite, or try it once in the playground.";
  if (/ValidationException.*(model|identifier)|invalid model|not found|on-demand throughput/i.test(m)) return `That model ID doesn't work in ${region}. In Sydney use amazon.nova-lite-v1:0 (or apac.amazon.nova-lite-v1:0); in US East use us.amazon.nova-lite-v1:0.`;
  if (/Throttl|TooManyRequests|ServiceQuota/i.test(m)) return "Bedrock is rate-limiting this account. Wait a minute and try again, or try the apac. model ID.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|network/i.test(m)) return "Couldn't reach AWS. Check your internet connection, VPN or firewall.";
  return "Unexpected error — send me the message above.";
}

const client = new BedrockRuntimeClient({ region });
const t0 = Date.now();
try {
  const out = await client.send(new ConverseCommand({
    modelId: model,
    messages: [{ role: "user", content: [{ text: "Reply with exactly: Hearth is connected." }] }],
    inferenceConfig: { maxTokens: 20, temperature: 0 },
  }));
  const text = out.output?.message?.content?.map((c) => c.text ?? "").join("").trim();
  console.log(`✓ Bedrock answered in ${Date.now() - t0} ms: "${text}"   (${out.usage?.inputTokens} in / ${out.usage?.outputTokens} out tokens)`);
} catch (e) {
  const err = e as Error;
  console.log(`✗ Bedrock call failed: ${err.name}: ${err.message}\n\n→ ${explain(err)}`);
  process.exit(1);
}

// A taste of what Hearth will now say to Leo.
const sample = await completeJson<{ recast: string; follow_up: string }>(
  `You are Hearth, a warm family-memory assistant inside Alexa+. Return JSON with:
- recast: the child is 7. Repeat their main idea back as ONE fuller, richer sentence (the "recasting" technique speech educators use): keep their meaning, add one or two descriptive words, never say they were wrong. Speak to them as "you".
- follow_up: one short, open question about a specific detail they mentioned.`,
  "Entry by Leo: We went to the park. I went on the big slide.",
  200,
);
if (sample) {
  console.log(`\nSample recast for Leo ("We went to the park. I went on the big slide."):\n  Alexa: ${sample.recast} ${sample.follow_up}`);
} else {
  console.log("\nThe connection works, but the sample recast didn't come back as expected — Hearth will fall back to templates for that call.");
}
