# Hearth — build plan, pitch and demo script

Deadline: **Friday 23 October 2026** (Devpost). Judging 9–20 November.

## The pitch (one hero flow)

Lead with one story, not a feature list:

> Gran tells Alexa a story → it becomes Leo's question → Leo answers in his own words and Alexa helps him say it more fully → his answer goes back to Gran → Mum sees Leo's sentences growing.

Everything else (daily logs, memoir chapters, family table, Family Radio, recall) is shown as "and it also…" around that loop. The reviewer should leave remembering one thing: **Alexa+ is the only assistant in the room with the whole family, and Hearth connects their stories.**

The second message is **trust**: privacy and safety rules enforced in code, consent for kids, delete anything, and possible safety disclosures shared with no one.

## Where it stands (Wed 14 Oct)

Done and tested (31 end-to-end checks over Streamable HTTP):
- MCP server, 11 tools, protocol 2025-11-25, Streamable HTTP
- Speaking practice: recast + follow-up, words per answer, age-graded "big words"
- Daily logs with patterns; memoir chapters; family-table conversations
- Family Threads both ways; opt-in, mild-only care nudges
- Light PIN (once per session), parent consent for kids, delete by voice and on the dashboard, retention
- Paraphrase guard, safety disclosures, child-content check (Bedrock Guardrails or offline filter)
- Family Radio; Bedrock integration with offline fallback
- Dashboard: photo arc, story lines, journal panel, household view and unlock, live refresh

## Remaining days

| Day | Date | Goal |
|---|---|---|
| 1 | Thu 15 Oct | Get Bedrock access; set `BEDROCK_MODEL_ID`; create a Guardrail and set `BEDROCK_GUARDRAIL_ID`. Compare recasts, conversation summaries and Family Radio against the templates; tune the prompts in `src/memory.ts`. Add one Bedrock smoke test. |
| 2 | Fri 16 Oct | Deploy the Docker image to **one instance with a persistent volume** (Lightsail/EC2, or Fly/Railway with a volume — not App Runner). Install the Alexa AI CLI, run `alexa-ai new mcp` and `alexa-ai deploy`. **Riskiest step — do it early.** |
| 3 | Sat 17 Oct | On a real Echo or the Alexa app: **check Alexa+ passes Leo's exact words** (the paraphrase guard will reject summaries — if it keeps happening, tighten the tool descriptions; if it can't be fixed, use the simulated path for the kid segment). Fix tool descriptions wherever Alexa+ picks the wrong tool. Try the family-table flow. |
| 4 | Sun 18 Oct | Rehearse the demo end to end; adjust seed data so every beat lands. Replace the watermarked photos. |
| 5 | Mon 19 Oct | Buffer / polish. |
| 6 | Tue 20 Oct | Record the demo video (script below), with Bedrock on. |
| 7 | Wed 21 Oct | Edit; write the Devpost story (hero flow, how it works, Bedrock + Guardrails, privacy and safety). |
| 8 | Thu 22 Oct | Final repo pass, README screenshots, make the repo public, submit a draft. |
| 9 | Fri 23 Oct | Submit. Don't build anything new. |

**If Alexa+ onboarding is blocked by Day 3:** switch to the rules' simulated-experience path. Keep the MCP server, and add a small voice front-end (browser speech recognition + speech synthesis) that calls the same tools. The rules require the simulation's source in the repo and the demo to clearly show it working.

## Demo video (about 3 minutes)

Say on screen once that the three weeks of history are sample data; everything after that is live.

**0:00 – 0:20 · The hook.** Gran's voice over her photo: the bicycle story. "Stories like this disappear. Kids' first words go unwritten. Hearth is the family's memory — and it lives where the whole family already is."

**0:20 – 1:05 · The hero loop (live).** Split screen: Echo on the left, dashboard on the right.
- "Alexa, open Hearth for Leo." → Alexa asks Gran's bicycle question (the family thread).
- Leo answers in a short sentence → Alexa recasts it and asks a follow-up. Caption: *"It never corrects him — it models richer language."*
- **The dashboard updates by itself**: Leo's bubble pulses, his entry appears, the line to Gran lights up.
- Cut to Gran: Alexa asks her about Leo riding without training wheels.

**1:05 – 1:35 · The parent view.** Unlock as Mum (PIN once). Leo's journal: "We played. It was fun." next to his latest answer, words per answer 7 → 28, big words like *germinating* and *extraordinary*. Show the "not a clinical assessment" line.

**1:35 – 2:05 · The family table.** "Alexa, start a Hearth chat with Gran, Leo and Mum." A few turns; the conversation card appears on the dashboard. Caption: *"Voice ID knows who's speaking."*

**2:05 – 2:30 · Trust, in 25 seconds.** Quick cuts: Uncle Finn can't open Leo's journal; "Alexa, delete what I just said"; the consent statement when adding a child. One line: *"If a child says something that sounds unsafe, Hearth tells no one in the house — and gently helps them find a trusted adult."*

**2:30 – 2:45 · Family Radio.** "Alexa, play Family Radio." Bubbles pulse as each person is mentioned.

**2:45 – 3:00 · Under the hood.** Architecture: Alexa+ → MCP (Streamable HTTP, 2025-11-25) → Hearth → Bedrock + Guardrails. Rules in code. Close on: "Hearth. The family memory that talks back."

## Devpost checklist

- [ ] Public repo with the MCP server source (this repo)
- [ ] Demo video showing the MCP server **in action through Alexa+** (or the simulated path, clearly shown)
- [ ] Screenshot of the add-on in the Alexa developer console
- [ ] Bedrock and Guardrails mentioned and shown, for the AWS Builder Mini Challenge
- [ ] Testing instructions for judges (`npm run seed && npm start`, demo PIN `1234`, plus the public URL)
- [ ] Watermarked stock photos replaced
