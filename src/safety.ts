// Safety rules. These run in code — before anything reaches the AI model or another family member —
// so they hold no matter how a prompt is worded.
import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { tokenize } from "./language.js";
import type { Member } from "./db.js";

// ── 1. Paraphrase guard ──
// Speaking-practice numbers only mean something if Hearth gets the child's exact words. If the
// assistant hands over a summary ("Leo said he rode his bike"), refuse it and ask for the words.
export function looksLikeSummary(member: Member, text: string): boolean {
  const t = text.trim();
  const names = [member.name, member.relation].filter(Boolean).map((n) => n!.toLowerCase());
  const first = t.split(/\s+/).slice(0, 6).join(" ").toLowerCase();
  const reported = /\b(said|says|told|tells|mentioned|explained|shared|talked|described|reports?|reported)\b/;
  // Nobody talks about themselves by name: "Leo said…", "Gran told me…" coming from Gran.
  if (names.some((n) => first.startsWith(n + " ")) && reported.test(first)) return true;
  if (/^(the (child|kid|user|speaker|boy|girl)|user)\b/i.test(t)) return true;
  if (member.role === "child" && /^(he|she|they)\s+(said|says|told|mentioned|explained|talked|shared|wants|thinks)\b/i.test(t)) return true;
  return false;
}

// ── 2. Safety disclosures ──
// If someone says something that sounds like they're being hurt or might hurt themselves, Hearth
// must not pass it to anyone in the house (the person told could be the person causing harm).
// The entry is kept only for its author, nothing is shared, and Alexa answers gently.
const HURT_VERBS = "hit|hits|hitting|slap|slaps|slapped|kick|kicks|kicked|punch|punched|punches|hurt|hurts|beat|beats|choke|choked|burned|burnt|grabbed";
const HOUSEHOLD_WORDS = ["mum", "mom", "mummy", "mommy", "dad", "daddy", "papa", "mama", "gran", "granny", "grandma", "grandpa", "grandad", "uncle", "aunt", "auntie", "brother", "sister", "he", "she", "they", "someone", "somebody", "a man", "a lady", "a grown-up", "an adult"];

export type SafetyResult =
  | { kind: "none" }
  | { kind: "self_harm" }
  | { kind: "household_harm" } // hurt by someone at home, or an unnamed adult, or secrecy pressure
  | { kind: "peer_harm" }; // e.g. "Sam hit me at school" — parents should still know

export function checkSafety(text: string, family: Member[]): SafetyResult {
  const t = text.toLowerCase();
  if (/\b(kill myself|hurt myself|end my life|don'?t want to (be alive|live)|want to die|wish i (was|were) dead|cut myself)\b/.test(t)) {
    return { kind: "self_harm" };
  }
  // Secrecy pressure from someone: "he told me not to tell", "she said it's our secret".
  if (/\b(told|tells|said|says|made)\s+me\s+(to\s+)?(not\s+tell|never\s+tell|keep\s+(it\s+)?(a\s+)?secret)\b/.test(t) || /\bour (little )?secret\b/.test(t)) {
    return { kind: "household_harm" };
  }
  if (/\btouch(ed|es|ing)?\s+(me|my\s+(private|privates|bottom|body|chest))\b/.test(t)) return { kind: "household_harm" };
  if (/\b(scared|afraid|frightened)\s+(of|to go)\s+(home|going home|my\s+\w+|mum|mom|dad|daddy|papa|him|her|them)\b/.test(t)) return { kind: "household_harm" };

  const m = t.match(new RegExp(`\\b([a-z'-]+(?:\\s+[a-z'-]+)?)\\s+(?:${HURT_VERBS})\\s+me\\b`));
  if (m) {
    const who = m[1].replace(/^(and|then|but|so|because)\s+/, "").trim();
    const last = who.split(/\s+/).pop()!;
    const familyNames = family.flatMap((f) => [f.name, f.relation ?? ""]).filter(Boolean).map((n) => n.toLowerCase());
    const household = HOUSEHOLD_WORDS.includes(who) || HOUSEHOLD_WORDS.includes(last) ||
      familyNames.includes(who) || familyNames.includes(last) || /^my\s/.test(who);
    return household ? { kind: "household_harm" } : { kind: "peer_harm" };
  }
  return { kind: "none" };
}

const RESOURCE = process.env.HEARTH_SAFETY_RESOURCE; // e.g. "Childline on 1098" (India) or "Childline on 0800 1111" (UK)

export function safetyReply(kind: SafetyResult["kind"], member: Member): string {
  if (kind === "self_harm") {
    return `Thank you for telling me, ${member.name}. That sounds really hard, and you deserve support. ` +
      `Please reach out to someone you trust today${RESOURCE ? `, or call ${RESOURCE}` : ", or a local crisis line"}. ` +
      `If you're in danger right now, contact emergency services.`;
  }
  if (kind === "household_harm") {
    return `Thank you for telling me, ${member.name}. That was brave, and it's not your fault. ` +
      `It's really important to tell a grown-up you trust, like a teacher or another adult you feel safe with` +
      `${RESOURCE ? `. You can also call ${RESOURCE}` : ""}. If you ever feel unsafe right now, ask a grown-up to call for help.`;
  }
  return `Thank you for telling me, ${member.name}. Nobody should hurt you. Please tell a grown-up at home or a teacher about it so they can help.`;
}

// ── 3. Care nudges: mild wellbeing only, never conflict ──
const MILD = ["tired", "sleepy", "sick", "unwell", "poorly", "headache", "cold", "cough", "coughing", "exhausted"];
const CONFLICT = ["angry", "shout", "shouted", "shouting", "yelled", "yelling", "fight", "fighting", "fought", "argue", "argued", "arguing", "cried", "crying", "upset", "scared", "slammed", "hit", "hurt"];

/** Returns the adult a child seems concerned about, only for mild wellbeing — never conflict. */
export function careTarget(author: Member, text: string, family: Member[]): Member | null {
  if (author.role !== "child") return null;
  const words = new Set(tokenize(text));
  if (CONFLICT.some((w) => words.has(w))) return null;
  if (!MILD.some((w) => words.has(w)) && !/not feeling (well|good)/i.test(text)) return null;
  return family.find((x) => x.id !== author.id && x.role !== "child" &&
    [x.name, x.relation ?? ""].some((n) => n && words.has(n.toLowerCase()))) ?? null;
}

// ── 4. Content headed to a child ──
// Anything Hearth will read aloud to a child (a story bridge from Gran, say) is checked first:
// with Amazon Bedrock Guardrails when BEDROCK_GUARDRAIL_ID is set, otherwise a conservative word filter.
const NOT_FOR_KIDS = ["kill", "killed", "killing", "murder", "dead", "died", "death", "blood", "bloody", "gun", "guns", "knife", "war", "bomb", "suicide", "drunk", "drugs", "sex", "sexy", "naked", "damn", "hell", "shit", "fuck", "bastard", "bitch", "crap"];
const GUARDRAIL_ID = process.env.BEDROCK_GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.BEDROCK_GUARDRAIL_VERSION ?? "DRAFT";
const guardrailClient = GUARDRAIL_ID ? new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" }) : null;

export const guardrailLabel = () => (GUARDRAIL_ID ? `Bedrock Guardrails (${GUARDRAIL_ID})` : "offline word filter");

export async function okForChild(text: string): Promise<boolean> {
  if (guardrailClient && GUARDRAIL_ID) {
    try {
      const out = await guardrailClient.send(
        new ApplyGuardrailCommand({
          guardrailIdentifier: GUARDRAIL_ID,
          guardrailVersion: GUARDRAIL_VERSION,
          source: "OUTPUT",
          content: [{ text: { text } }],
        }),
      );
      return out.action !== "GUARDRAIL_INTERVENED";
    } catch (err) {
      console.error("[hearth] Guardrail check failed, using word filter:", (err as Error).message);
    }
  }
  const words = new Set(tokenize(text));
  return !NOT_FOR_KIDS.some((w) => words.has(w));
}
