// Amazon Bedrock (Converse API) for the reasoning steps: entry summaries, story bridges, care nudges,
// conversation summaries, Family Radio — and the simulator's Alexa+ agent (tool use).
//
// If BEDROCK_MODEL_ID is not set (or a call fails), callers fall back to deterministic
// templates, so the server always works offline for local testing and judging.
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";

const MODEL_ID = process.env.BEDROCK_MODEL_ID; // e.g. "amazon.nova-lite-v1:0"
// BEDROCK_ENDPOINT points at a local mock for tests (scripts/mock-bedrock.ts); unset in real use.
const ENDPOINT = process.env.BEDROCK_ENDPOINT;
const client = MODEL_ID
  ? new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      ...(ENDPOINT ? { endpoint: ENDPOINT, requestHandler: new NodeHttpHandler() } : {}),
    })
  : null;

export const llmEnabled = () => client !== null;
export const llmLabel = () => (client ? `Amazon Bedrock (${MODEL_ID})` : "offline templates");
export const modelId = () => MODEL_ID;

/** Raw Converse call (used by the agent for tool use). Throws on failure. */
export async function converse(input: Omit<ConverseCommandInput, "modelId">): Promise<ConverseCommandOutput> {
  if (!client || !MODEL_ID) throw new Error("Bedrock is not configured");
  return client.send(new ConverseCommand({ modelId: MODEL_ID, ...input }));
}

export async function complete(system: string, user: string, maxTokens = 600): Promise<string | null> {
  if (!client || !MODEL_ID) return null;
  try {
    const out = await client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: system }],
        messages: [{ role: "user", content: [{ text: user }] }],
        inferenceConfig: { maxTokens, temperature: 0.6 },
      }),
    );
    const text = out.output?.message?.content?.map((c) => c.text ?? "").join("").trim();
    return text || null;
  } catch (err) {
    console.error("[hearth] Bedrock call failed, using fallback:", (err as Error).message);
    return null;
  }
}

/** Asks for JSON and parses the first object in the reply; null on any failure. */
export async function completeJson<T>(system: string, user: string, maxTokens = 600): Promise<T | null> {
  const text = await complete(system + "\nReply with a single JSON object and nothing else.", user, maxTokens);
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
