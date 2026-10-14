// Seeds three weeks of believable history for one family (the Hales), so the demo video can
// show growth over time. Run: npm run seed   (wipes the database first)
//
// The family: Gran (Rose, 78), Mum (Amara) and Dad (Marcus), Leo (7), and Uncle Finn — an adult
// who isn't a parent, so he can't see Leo's journal (privacy demo).
//
// Story arcs baked in:
//  • Leo: answers grow from 3–5 words to rich multi-clause sentences; new words appear.
//  • Gran: memoir stories that become questions for Leo — and Leo's news becomes questions for Gran.
//  • Amara: "tired" several times this week → Hearth notices the pattern.
//  • Marcus: a plumber call (for recall) and a PRIVATE birthday-surprise entry (privacy demo).
//  • Two family conversations (speaker labels stand in for Alexa+ voice ID).
//  • Left pending for the LIVE demo: Gran's first-bicycle story, waiting as a question for Leo.
//
// Demo PIN for Amara, Marcus and Finn: 1234. Gran chose not to use a PIN.
import { pendingThreadsFor, findMember, resetAll, setSetting } from "../src/db.js";
import { registerMember, saveConversation, saveEntry } from "../src/memory.js";
import { KID_QUESTIONS, ADULT_QUESTIONS } from "../src/prompts.js";

const DAY = 86_400_000;
const TZ = process.env.HEARTH_TZ ?? "Europe/London";
const DEMO_PIN = "1234";
/** `daysAgo` days back, at a given local hour. */
function at(daysAgo: number, hour: number, minute = 0): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  const local = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const offset = d.getTime() - local.getTime();
  local.setHours(hour, minute, 0, 0);
  return new Date(local.getTime() + offset).toISOString();
}

type Seed = { d: number; h: number; who: string; text: string; prompt?: string; answersThread?: boolean; private?: boolean };

const ENTRIES: Seed[] = [
  // ── Week 1 ──
  { d: 20, h: 19, who: "Leo", prompt: KID_QUESTIONS[0], text: "We played. It was fun." },
  { d: 20, h: 21, who: "Amara", prompt: ADULT_QUESTIONS[0], text: "Win: the client presentation went well. Worry: Leo's school project is due Friday and we haven't started." },
  { d: 19, h: 10, who: "Rose", prompt: "Where did you grow up, and what did your home look like?", text: "I grew up on a little farm outside a village in Yorkshire. Our house had a slate roof and a big apple tree by the gate. Every autumn my mother made apple pies, and all of us children sat on the kitchen floor waiting for the burnt edges, because those were the best bits." },
  { d: 19, h: 19, who: "Leo", prompt: KID_QUESTIONS[6], text: "I ate pasta. I like pasta." },
  { d: 18, h: 19, who: "Leo", prompt: KID_QUESTIONS[7], text: "Sam pushed me. I was sad." },
  { d: 18, h: 22, who: "Marcus", prompt: ADULT_QUESTIONS[2], text: "Long day at work. Remember to renew the car insurance before the end of the month." },
  { d: 17, h: 19, who: "Leo", answersThread: true, text: "No. I like the burnt bits too." },
  { d: 17, h: 20, who: "Finn", prompt: ADULT_QUESTIONS[2], text: "Started the new climbing course at the wall on Hill Road. My arms are jelly but I loved it." },
  { d: 16, h: 10, who: "Rose", prompt: "What games did you play as a child?", text: "We played hopscotch and marbles all summer long. I was the marbles champion of our lane. One summer I won fifty marbles from my cousin Peter and kept them in a biscuit tin under my bed. He still grumbles about it at Christmas!" },
  { d: 16, h: 19, who: "Leo", prompt: KID_QUESTIONS[2], text: "I saw a big dog. It was brown." },
  { d: 15, h: 19, who: "Leo", prompt: KID_QUESTIONS[4], text: "We did drawing. I made a house with a tree." },
  { d: 15, h: 21, who: "Amara", prompt: ADULT_QUESTIONS[3], text: "Slept okay. Energy is fine. Yoga in the morning helped." },
  // ── Week 2 ──
  { d: 13, h: 19, who: "Leo", answersThread: true, text: "I never played marbles. I want to play with Gran. I think I will win because I am fast." },
  { d: 12, h: 10, who: "Rose", prompt: "Tell me about your mother or father when you were small.", text: "My father was the village postman. He cycled ten miles every day, even in the snow, with a big canvas bag. He used to say that a person who reads is never alone. He gave me my first book, a battered copy of The Wind in the Willows, when I was seven." },
  { d: 12, h: 19, who: "Leo", prompt: KID_QUESTIONS[1], text: "Today in school we planted seeds in small cups. Mine is next to the window so it gets sunlight." },
  { d: 11, h: 19, who: "Leo", prompt: KID_QUESTIONS[2], text: "Me and Sam made a fort with the sofa cushions. It fell down two times but we fixed it with the big blanket." },
  { d: 11, h: 21, who: "Finn", prompt: ADULT_QUESTIONS[4], text: "Proud moment: got to the top of the orange route without falling off. Only took me four tries." },
  { d: 10, h: 21, who: "Marcus", prompt: ADULT_QUESTIONS[2], text: "Called the plumber Dave about the kitchen sink leak. He's coming on Saturday morning at ten. His number is in my phone under Dave Plumber." },
  { d: 10, h: 19, who: "Leo", prompt: KID_QUESTIONS[4], text: "I learned that an octopus has three hearts and blue blood. That is so weird and cool. I told everyone in my class at lunch." },
  { d: 9, h: 10, who: "Rose", answersThread: true, text: "When I was seven we had no seeds in cups, we had a whole vegetable patch! My father grew runner beans and potatoes behind the house, and my job was to carry water from the pump in a little tin watering can. I spilled half of it every single time." },
  { d: 9, h: 19, who: "Leo", prompt: KID_QUESTIONS[7], text: "We had a maths test and I was nervous, but I finished everything before the bell rang and I checked my answers twice." },
  { d: 8, h: 10, who: "Rose", prompt: "What was school like for you? Who was your favourite teacher?", text: "My favourite teacher was Miss Abbott. We had only a few books, so she taught us to read with old newspapers. She made me read the football results aloud every Monday, and that is how I learned to read properly, and also how I fell in love with football." },
  { d: 8, h: 21, who: "Marcus", private: true, text: "Keep this private. I'm planning a surprise party for Amara's birthday on the 24th. Booked the terrace at her favourite restaurant, need to call her university friends." },
  // ── Week 3 ──
  { d: 6, h: 19, who: "Leo", answersThread: true, text: "Miss Abbott sounds amazing. I want to read the football scores too. My favourite player is a striker because he runs so fast and the ball goes zoom." },
  { d: 6, h: 22, who: "Amara", prompt: ADULT_QUESTIONS[1], text: "Work deadlines took everything today. I'm tired and I still have emails to send tonight." },
  { d: 5, h: 19, who: "Leo", prompt: KID_QUESTIONS[1], text: "My seed finally sprouted! It has two tiny leaves, and my teacher said it is germinating, which means it is starting to grow into a real plant." },
  { d: 5, h: 22, who: "Amara", prompt: ADULT_QUESTIONS[3], text: "Slept late again, maybe five hours. Tired and a bit worried about the quarterly review." },
  { d: 4, h: 10, who: "Rose", prompt: "What was your first job, and how much did you earn?", text: "My first job was as a telephone operator at the exchange in Leeds in 1964. I earned six pounds a week. With my first wages I bought my mother a blue wool coat and she cried. I still remember her face." },
  { d: 4, h: 19, who: "Leo", prompt: KID_QUESTIONS[0], text: "Today was extraordinary because we went to the planetarium on a school trip. The dome was enormous, and when the lights went off it felt like we were floating between the planets. Saturn was my favourite because of its rings." },
  { d: 4, h: 21, who: "Finn", prompt: ADULT_QUESTIONS[0], text: "Win: finished the garden shed with Marcus. Worry: the flat viewing on Thursday, the rent is a stretch." },
  { d: 3, h: 22, who: "Amara", prompt: ADULT_QUESTIONS[0], text: "Win: the review is done. Worry: still tired, my back hurts from sitting all day." },
  { d: 3, h: 19, who: "Leo", answersThread: true, text: "Gran, six pounds is so little! I think you should have bought yourself a bicycle. When I get my first wages I will buy Mum and Dad a holiday to the beach." },
  { d: 2, h: 19, who: "Leo", prompt: KID_QUESTIONS[3], text: "Sam and I had an argument about who should be the captain, but then we decided to take turns, which was fair, and we both got to choose the team." },
  { d: 2, h: 20, who: "Leo", text: "Mum was really tired tonight, so I made her a card with a big sun on it to cheer her up." },
  { d: 2, h: 21, who: "Marcus", prompt: ADULT_QUESTIONS[4], text: "Proud that I finally fixed the porch light myself. Saved a call to the electrician." },
  { d: 1, h: 19, who: "Leo", prompt: KID_QUESTIONS[6], text: "I helped Mum make pancakes and I was in charge of flipping them. Mine were not circles, they looked like maps of different countries, but Mum said they tasted delicious anyway." },
  // Yesterday: the story that becomes Leo's live-demo question.
  { d: 1, h: 11, who: "Rose", prompt: "What's the first thing you remember learning to do on your own?", text: "I learned to ride a bicycle in 1955, on my brother's big black bicycle. It was far too tall for me, so I rode it standing up, through the frame, down the lane to the church. I fell into a ditch full of water the first day, but by the end of the week I was racing the milk cart." },
];

async function main() {
  resetAll();
  registerMember({ name: "Amara", role: "adult", age: 35, relation: "Mum", is_parent: true, photo: "photos/amara.jpg", pin: DEMO_PIN });
  registerMember({ name: "Marcus", role: "adult", age: 36, relation: "Dad", is_parent: true, photo: "photos/marcus.jpg", pin: DEMO_PIN });
  registerMember({ name: "Leo", role: "child", age: 7, relation: "Leo", photo: "photos/leo.jpg", added_by: "Amara", parent_consent: true });
  registerMember({ name: "Rose", role: "elder", age: 78, relation: "Gran", photo: "photos/rose.jpg" });
  registerMember({ name: "Finn", role: "adult", age: 31, relation: "Uncle Finn", photo: "photos/finn.jpg", pin: DEMO_PIN });
  setSetting("demo", "1");
  setSetting("care_nudges", "on");

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
  // Family conversations (each turn labelled with its speaker, as Alexa+ voice ID would).
  await saveConversation({
    at: at(13, 18, 30),
    prompt: "If our family went on an adventure tomorrow, where should we go, and why? Everyone gets a turn!",
    turns: [
      { speaker: "Finn", text: "Climbing! There's a big outdoor crag in the Peak District, an hour from here." },
      { speaker: "Leo", text: "I want to climb too. I am good at the climbing frame." },
      { speaker: "Marcus", text: "You are, mate. Finn, could Leo try the kids' wall at your centre first?" },
      { speaker: "Finn", text: "Definitely. They have a beginners' session on Saturday mornings. I'll book two spots." },
      { speaker: "Leo", text: "Can I wear the helmet? And the rope thing?" },
      { speaker: "Marcus", text: "The harness. Yes, you'll wear both, and Finn will hold the rope." },
    ],
  });
  await saveConversation({
    at: at(2, 18, 0),
    prompt: "Gran, what was the village like when you were little? Leo, get a question ready for Gran!",
    turns: [
      { speaker: "Rose", text: "It was tiny. One shop, one church, and a pond where we skated when it froze in January." },
      { speaker: "Leo", text: "Gran, did you have a television? And what did you do when it was raining and you could not go outside?" },
      { speaker: "Rose", text: "No television until I was twelve! When it rained we played cards by the fire and listened to the radio." },
      { speaker: "Amara", text: "That's where your love of cards comes from, isn't it? You still beat everyone at rummy." },
      { speaker: "Leo", text: "That sounds peaceful but also a bit boring. I think I would build an enormous den with all the blankets and pretend it was a submarine." },
      { speaker: "Rose", text: "We did build dens! Under the kitchen table, with my mother's tablecloths. She was not pleased." },
    ],
  });

  const waiting = pendingThreadsFor(findMember("Leo")!.id);
  console.log(`Seeded ${ENTRIES.length} entries and 2 family conversations for the Hale family. Demo PIN: ${DEMO_PIN}`);
  console.log(`Waiting for Leo (live demo): ${waiting.map((t) => t.prompt).join(" | ") || "nothing"}`);
}

main();
