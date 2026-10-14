// Seeds three weeks of believable history for one family (the Sharmas), so the demo video can
// show growth over time. Run: npm run seed   (wipes the database first)
//
// Story arcs baked in:
//  • Aarav (7): answers grow from 3–5 words to rich multi-clause sentences; new words appear.
//  • Dadu (74): memoir stories that become questions for Aarav — and Aarav's news becomes questions for Dadu.
//  • Priya: "tired" three times this week → Hearth notices the pattern.
//  • Rohan: a plumber call (for recall) and a PRIVATE birthday-surprise entry (privacy demo).
//  • Left pending for the LIVE demo: Dadu's first-bicycle story, waiting as a question for Aarav.
import { pendingThreadsFor, findMember, resetAll } from "../src/db.js";
import { registerMember, saveEntry } from "../src/memory.js";
import { KID_QUESTIONS, ADULT_QUESTIONS } from "../src/prompts.js";

const DAY = 86_400_000;
/** `daysAgo` days back, at a given IST hour. */
function at(daysAgo: number, hourIst: number, minute = 0): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const offset = d.getTime() - ist.getTime();
  ist.setHours(hourIst, minute, 0, 0);
  return new Date(ist.getTime() + offset).toISOString();
}

type Seed = { d: number; h: number; who: string; text: string; prompt?: string; answersThread?: boolean; private?: boolean };

const ENTRIES: Seed[] = [
  // ── Week 1 ──
  { d: 20, h: 19, who: "Aarav", prompt: KID_QUESTIONS[0], text: "We played. It was fun." },
  { d: 20, h: 21, who: "Priya", prompt: ADULT_QUESTIONS[0], text: "Win: the client presentation went well. Worry: Aarav's school project is due Friday and we haven't started." },
  { d: 19, h: 10, who: "Dadu", prompt: "Where did you grow up, and what did your home look like?", text: "I grew up in a small village near Warangal. Our house had a red tiled roof and a big neem tree in the courtyard. Every evening my mother would light a lamp under that tree and all of us children would sit there and listen to stories from my grandmother." },
  { d: 19, h: 19, who: "Aarav", prompt: KID_QUESTIONS[6], text: "I ate dosa. I like dosa." },
  { d: 18, h: 19, who: "Aarav", prompt: KID_QUESTIONS[7], text: "Rahul pushed me. I was sad." },
  { d: 18, h: 22, who: "Rohan", prompt: ADULT_QUESTIONS[2], text: "Long day at work. Remember to renew the car insurance before the end of the month." },
  { d: 17, h: 19, who: "Aarav", answersThread: true, text: "No. I sit on the sofa. Mum tells stories." },
  { d: 16, h: 10, who: "Dadu", prompt: "What games did you play as a child?", text: "We played gilli danda and marbles all day in the summer holidays. I was the marbles champion of our street. One summer I won fifty marbles from my cousin Venu and kept them in a tin box under my bed. He still talks about it when we meet!" },
  { d: 16, h: 19, who: "Aarav", prompt: KID_QUESTIONS[2], text: "I saw a big dog. It was brown." },
  { d: 15, h: 19, who: "Aarav", prompt: KID_QUESTIONS[4], text: "We did drawing. I made a house with a tree." },
  { d: 15, h: 21, who: "Priya", prompt: ADULT_QUESTIONS[3], text: "Slept okay. Energy is fine. Yoga in the morning helped." },
  // ── Week 2 ──
  { d: 13, h: 19, who: "Aarav", answersThread: true, text: "I never played marbles. I want to play with Dadu. I think I will win because I am fast." },
  { d: 12, h: 10, who: "Dadu", prompt: "Tell me about your mother or father when you were small.", text: "My father was a school teacher. He walked six kilometres to the school every day, even in the rains, holding a black umbrella. He used to say that a person who reads is never alone. He gave me my first book, a Telugu Panchatantra, when I was seven." },
  { d: 12, h: 19, who: "Aarav", prompt: KID_QUESTIONS[1], text: "Today in school we planted seeds in small cups. Mine is next to the window so it gets sunlight." },
  { d: 11, h: 19, who: "Aarav", prompt: KID_QUESTIONS[2], text: "Me and Rahul made a fort with the sofa cushions. It fell down two times but we fixed it with the big blanket." },
  { d: 10, h: 21, who: "Rohan", prompt: ADULT_QUESTIONS[2], text: "Called the plumber Suresh about the kitchen sink leak. He's coming on Saturday morning at ten. His number is in my phone under Suresh Plumber." },
  { d: 10, h: 19, who: "Aarav", prompt: KID_QUESTIONS[4], text: "I learned that an octopus has three hearts and blue blood. That is so weird and cool. I told everyone in my class at lunch." },
  { d: 9, h: 10, who: "Dadu", answersThread: true, text: "When I was seven we had no seeds in cups, we had a whole field! My father grew tomatoes and chillies behind the house, and my job was to carry water from the well in a small brass pot. I spilled half of it every time." },
  { d: 9, h: 19, who: "Aarav", prompt: KID_QUESTIONS[7], text: "We had a maths test and I was nervous, but I finished everything before the bell rang and I checked my answers twice." },
  { d: 8, h: 10, who: "Dadu", prompt: "What was school like for you? Who was your favourite teacher?", text: "My favourite teacher was Lakshmi madam. She taught us English using old newspapers because we had no books. She made me read the cricket scores aloud every morning, and that is how I learned English, and also how I fell in love with cricket." },
  { d: 8, h: 21, who: "Rohan", private: true, text: "Keep this private. I'm planning a surprise party for Priya's birthday on the 24th. Booked the terrace at her favourite restaurant, need to call her college friends." },
  // ── Week 3 ──
  { d: 6, h: 19, who: "Aarav", answersThread: true, text: "Lakshmi madam sounds amazing. I want to read the cricket scores too. My favourite player is a fast bowler because he runs so fast and the ball goes zoom." },
  { d: 6, h: 22, who: "Priya", prompt: ADULT_QUESTIONS[1], text: "Work deadlines took everything today. I'm tired and I still have emails to send tonight." },
  { d: 5, h: 19, who: "Aarav", prompt: KID_QUESTIONS[1], text: "My seed finally sprouted! It has two tiny leaves, and my teacher said it is germinating, which means it is starting to grow into a real plant." },
  { d: 5, h: 22, who: "Priya", prompt: ADULT_QUESTIONS[3], text: "Slept late again, maybe five hours. Tired and a bit worried about the quarterly review." },
  { d: 4, h: 10, who: "Dadu", prompt: "What was your first job, and how much did you earn?", text: "My first job was as a clerk in the railway office in Secunderabad in 1972. I earned one hundred and forty rupees a month. With my first salary I bought my mother a green silk saree and she cried. I still remember her face." },
  { d: 4, h: 19, who: "Aarav", prompt: KID_QUESTIONS[0], text: "Today was extraordinary because we went to the planetarium on a school trip. The dome was enormous, and when the lights went off it felt like we were floating between the planets. Saturn was my favourite because of its rings." },
  { d: 3, h: 22, who: "Priya", prompt: ADULT_QUESTIONS[0], text: "Win: the review is done. Worry: still tired, my back hurts from sitting all day." },
  { d: 3, h: 19, who: "Aarav", answersThread: true, text: "Dadu, one hundred and forty rupees is so little! I think you should have bought yourself a bicycle. When I get my first salary I will buy Mum and Papa a holiday to the beach." },
  { d: 2, h: 19, who: "Aarav", prompt: KID_QUESTIONS[3], text: "Rahul and I had an argument about who should be the captain, but then we decided to take turns, which was fair, and we both got to choose the team." },
  { d: 2, h: 21, who: "Rohan", prompt: ADULT_QUESTIONS[4], text: "Proud that I finally fixed the balcony light myself. Saved a call to the electrician." },
  { d: 1, h: 19, who: "Aarav", prompt: KID_QUESTIONS[6], text: "I helped Mum make parathas and I was in charge of rolling them. Mine were not circles, they looked like maps of different countries, but Mum said they tasted delicious anyway." },
  // Yesterday: the story that becomes Aarav's live-demo question.
  { d: 1, h: 11, who: "Dadu", prompt: "What's the first thing you remember learning to do on your own?", text: "I learned to ride a bicycle in 1968, on my uncle's big black Atlas bicycle. It was too tall for me, so I rode it standing up, through the frame, on the mud road to the temple. I fell into a ditch full of water the first day, but by the end of the week I was racing the bullock carts." },
];

async function main() {
  resetAll();
  registerMember({ name: "Aarav", role: "child", age: 7, relation: "Aarav" });
  registerMember({ name: "Priya", role: "adult", age: 38, relation: "Mum", is_parent: true });
  registerMember({ name: "Rohan", role: "adult", age: 40, relation: "Papa", is_parent: true });
  registerMember({ name: "Dadu", role: "elder", age: 74, relation: "Dadu" });

  // Insert in chronological order so threads are created and answered in the right sequence.
  const ordered = [...ENTRIES].sort((a, b) => (b.d - a.d) || (a.h - b.h));
  for (const e of ordered) {
    let prompt = e.prompt ?? null;
    let thread_id: number | null = null;
    if (e.answersThread) {
      const t = pendingThreadsFor(findMember(e.who)!.id).find((x) => x.kind === "story_bridge");
      if (t) { prompt = t.prompt; thread_id = t.id; }
    }
    await saveEntry({ name: e.who, transcript: e.text, prompt, thread_id, private: e.private, at: at(e.d, e.h) });
  }
  const waiting = pendingThreadsFor(findMember("Aarav")!.id);
  console.log(`Seeded ${ENTRIES.length} entries for the Sharma family.`);
  console.log(`Waiting for Aarav (live demo): ${waiting.map((t) => t.prompt).join(" | ") || "nothing"}`);
}

main();
