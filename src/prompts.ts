// Question banks per role. Alexa+ reads the chosen question aloud; Hearth rotates through the
// bank so a member never hears the same question twice in a row, and thread prompts
// (from other family members' stories) always take priority.
import type { Role } from "./db.js";

export const KID_QUESTIONS = [
  "What was the best part of your day? Tell me what happened, from the very beginning.",
  "Did anything surprise you today? What happened?",
  "Who did you play with today, and what game did you play?",
  "If you could change one thing about today, what would it be and why?",
  "What's something new you learned today? Can you explain it to me like I'm a robot who knows nothing?",
  "Tell me about something that made you laugh today.",
  "What did you eat today that you really liked? Describe how it tasted.",
  "Was anything hard today? What did you do about it?",
  "If your day was a movie, what would it be called?",
  "Who was kind to you today? What did they do?",
];

export const ADULT_QUESTIONS = [
  "How was today, in a minute? One win, one worry.",
  "What took most of your energy today?",
  "Anything you want to remember from today, big or small?",
  "How did you sleep, and how's your energy right now?",
  "Was there a moment today you felt proud of?",
  "Anything on your mind for tomorrow?",
];

/** Elder memoir chapters, in order. One question per day builds a life story. */
export const MEMOIR: { chapter: string; questions: string[] }[] = [
  {
    chapter: "Childhood",
    questions: [
      "Where did you grow up, and what did your home look like?",
      "What games did you play as a child?",
      "Tell me about your mother or father when you were small.",
    ],
  },
  {
    chapter: "Growing up",
    questions: [
      "What was school like for you? Who was your favourite teacher?",
      "What's the first thing you remember learning to do on your own?",
      "Who was your best friend when you were young?",
    ],
  },
  {
    chapter: "Work and purpose",
    questions: [
      "What was your first job, and how much did you earn?",
      "What work are you most proud of?",
    ],
  },
  {
    chapter: "Family",
    questions: [
      "How did you meet your life partner?",
      "What do you remember about the day your first child was born?",
    ],
  },
  {
    chapter: "Wisdom",
    questions: [
      "What's one thing you wish someone had told you at twenty?",
      "What do you hope your grandchildren remember about you?",
    ],
  },
];

export const MEMOIR_FLAT = MEMOIR.flatMap((c) => c.questions.map((q) => ({ chapter: c.chapter, question: q })));

export function bankFor(role: Role): string[] {
  if (role === "child") return KID_QUESTIONS;
  if (role === "adult") return ADULT_QUESTIONS;
  return MEMOIR_FLAT.map((m) => m.question);
}

/** How Alexa+ should behave with each member — returned to the agent with every prompt. */
export const STYLE_GUIDE: Record<Role, string> = {
  child:
    "Speaking-practice mode. Be warm and playful, use short sentences. After the child answers, " +
    "use the `recast` from save_journal_entry: repeat their idea back as a fuller sentence, then ask the " +
    "`follow_up` question. Never correct them directly or say they were wrong. Praise effort, not perfection.",
  adult:
    "Daily-log mode. Keep it under a minute. Listen, don't lecture. Reflect back one pattern only if " +
    "save_journal_entry returns one.",
  elder:
    "Memoir mode. Be patient and curious, like a grandchild interviewing them. Let them ramble — " +
    "every detail is valuable. Ask one gentle follow-up about a specific detail they mentioned.",
};

/** Openers for a family conversation when there's no story waiting and no grandparent at the table. */
export const TABLE_QUESTIONS = [
  "Let's go round the table: what was the best thing that happened to each of you this week?",
  "If our family went on an adventure tomorrow, where should we go, and why? Everyone gets a turn!",
  "What's something you were scared of when you were little, and how did you get brave?",
  "If you could invent a new family tradition, what would it be?",
  "Who was kind to you this week, and what did they do?",
];

// ───────────── Prompts for Amazon Bedrock ─────────────
// Kept here so they're easy to tune. `npm run lab` shows what the model makes of them.

/** Recasting: say the child's idea back just a little fuller — not a rewrite. */
export function recastRules(name: string, age: number | null): string {
  const a = age ?? 7;
  return `- recast: ${name} is a young child. Say their idea back to them in ONE short sentence, the way a warm parent or speech teacher "recasts":
    • Keep their own words and meaning. Add only 2 to 5 words — one describing word, or a link like "and then" or "because".
    • Use simple, everyday words a ${a}-year-old already knows. No grand or adult words (not "towering", "exhilaration", "delightful").
    • Start naturally, like "Oh, you…" or "Wow, you…". Talk to them as "you".
    • Never correct them, never exaggerate, never mention their age.
- follow_up: ONE short question (under 10 words) about something NEW they haven't said yet — who was there, why, what happened next, or how it felt. Don't ask about the same thing the recast just said.
  Examples:
    Child: "We played. It was fun." → recast: "Oh, you played, and it was really fun!" follow_up: "What game did you play?"
    Child: "I ate pasta. I like pasta." → recast: "Mmm, you ate pasta, and you really like it!" follow_up: "Who made it for you?"
    Child: "Sam pushed me. I was sad." → recast: "Oh no, Sam pushed you, and you felt sad." follow_up: "What did you do then?"`;
}

/** Story bridges: one person's story, retold briefly as a question for another. */
export function bridgeRules(authorRef: string, targets: { name: string; role: string; age: number | null }[]): string {
  return `- bridges: for each of [${targets.map((t) => `${t.name} (${t.role}${t.age ? `, age ${t.age}` : ""})`).join(", ")}], write what Alexa will say to THEM later: share one small, true detail from this story (call the storyteller "${authorRef}"), then ask them one question that invites their own related story.
    • Two sentences, under 35 words. Only use details that are in the entry — don't invent any.
    • For a child: simple words, warm and playful. For a grandparent: respectful and curious.
    • Format: [{"to": name, "prompt": text}].`;
}

export const RADIO_SYSTEM = `You write "Family Radio", a warm 2-3 minute weekly episode Alexa reads aloud to a whole family on Sunday evening, including young children.
Sections, in order:
1. A cheerful one-line welcome.
2. One highlight per family member: specific, affectionate, one or two sentences each.
3. "Word of the Week": celebrate one new big word a child used, and say it in a sentence.
4. "From the memory box": one moment from the grandparent's stories.
5. One line about any family-table conversation.
6. A short goodbye that suggests one thing the family could do together this week, based on their stories.
Rules: only use facts from the summaries — never invent events. Simple spoken English a 7-year-old can follow. Leave out anything sad or worrying (tiredness, stress, illness). No stage directions, sound effects or emojis. Under 320 words. Return {"script": "..."} with a blank line between sections.`;

export const CONVERSATION_SUMMARY_SYSTEM =
  "Summarise this family conversation in ONE warm sentence for a family journal: who talked, and what about. " +
  "Use their names, only facts from the conversation, under 25 words. Return {\"summary\": \"...\"}.";
