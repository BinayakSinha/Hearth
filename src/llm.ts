// Amazon Bedrock (Converse API) for the reasoning steps: entry extraction, kid recasting,
// cross-family story bridges and the Family Radio script.
//
// If BEDROCK_MODEL_ID is not set (or a call fails), callers fall back to deterministic
// templates, so the server always works offline for local testing and judging.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = process.env.BEDROCK_MODEL_ID; // e.g. "us.amazon.nova-lite-v1:0"
const client = MODEL_ID ? new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" }) : null;

export const llmEnabled = () => client !== null;
export const llmLabel = () => (client ? `Amazon Bedrock (${MODEL_ID})` : "offline templates");

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
