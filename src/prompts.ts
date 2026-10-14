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
