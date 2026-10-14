# Hearth — build plan and demo script

Deadline: **Friday 23 October 2026** (Devpost). Judging 9–20 November.

## Where it stands (Wed 14 Oct)

Done and tested (15 end-to-end checks over Streamable HTTP):
- MCP server, 8 tools, protocol 2025-11-25, stateless Streamable HTTP
- Kid speaking practice: recast + follow-up, sentence length, vocabulary, new words
- Adult logs with pattern detection; memoir chapters for grandparents
- Family Threads (story bridges both ways) and care nudges
- Privacy rules (kids' journals, private entries, anonymous nudges)
- Family Radio weekly script
- Bedrock integration with offline fallback
- Seeded demo family (the Sharmas) and the parent dashboard

## Remaining days

| Day | Date | Goal |
|---|---|---|
| 1 | Thu 15 Oct | Get Bedrock access; set `BEDROCK_MODEL_ID`; compare recasts and Family Radio against the templates and tune the prompts in `src/memory.ts`. |
| 2 | Fri 16 Oct | Deploy (Dockerfile → App Runner or similar). Install the Alexa AI CLI, run `alexa-ai new mcp` and `alexa-ai deploy`. **This is the riskiest step — do it early.** |
| 3 | Sat 17 Oct | Talk to it on a real Echo or the Alexa app. Fix tool descriptions wherever Alexa+ picks the wrong tool or skips `save_journal_entry`. |
| 4 | Sun 18 Oct | Rehearse the demo flow on-device end to end; adjust seed data so every beat lands. |
| 5 | Mon 19 Oct | Buffer / polish: dashboard tweaks, edge cases found on-device. |
| 6 | Tue 20 Oct | Record the demo video (script below). Record extra takes of the voice moments. |
| 7 | Wed 21 Oct | Edit video; write the Devpost story (problem, how it works, Bedrock, privacy). |
| 8 | Thu 22 Oct | Final repo pass, README screenshots, make the repo public, submit a draft. |
| 9 | Fri 23 Oct | Submit. Don't build anything new. |

**If Alexa+ onboarding is blocked by Day 3:** switch to the rules' simulated-experience path. Keep the MCP server, and add a small voice front-end (browser speech recognition + speech synthesis) that calls the same tools. The rules require the simulation's source in the repo and the demo to clearly show it working.

## Demo video (about 3 minutes)

**0:00 – 0:20 · The hook.** Dadu's voice over a photo: the bicycle story. Then: "Stories like this disappear. Kids' first words go unwritten. Busy parents forget their own weeks. Hearth is the family's memory — and it lives where the whole family already is."

**0:20 – 1:00 · Aarav, speaking practice (live, on device).**
- "Alexa, open Hearth for Aarav." → greeting with his streak.
- Alexa asks Dadu's bicycle question (the family thread).
- Aarav answers in a short sentence → Alexa recasts it and asks a follow-up. Point out: it never corrects him, it models richer language.

**1:00 – 1:30 · The threads close the loop.**
- Cut to Dadu: Alexa asks him about Aarav riding without training wheels. Dadu answers.
- Aarav mentions "Mum looked tired" → cut to Rohan getting a care nudge. Caption: *"It never says who said it."*

**1:30 – 2:10 · The parent view.**
- "Alexa, how's Aarav's speaking coming along?" → spoken answer.
- Dashboard: first answer ("We played. It was fun.") next to the latest one; sentence length ×4; new words like *germinating* and *extraordinary*. Show the "not a clinical assessment" line.

**2:10 – 2:40 · Family Radio.** "Alexa, play Family Radio." Let it play over shots of the family.

**2:40 – 3:00 · Under the hood.** Quick architecture slide: Alexa+ → MCP (Streamable HTTP, 2025-11-25) → Hearth → Bedrock. Privacy rules enforced in code. Close on: "Hearth. The family memory that talks back."

## Devpost checklist

- [ ] Public repo with the MCP server source (this repo)
- [ ] Demo video showing the MCP server **in action through Alexa+** (or the simulated path, clearly shown)
- [ ] Screenshot of the add-on in the Alexa developer console
- [ ] Bedrock mentioned and shown, for the AWS Builder Mini Challenge
- [ ] Testing instructions for judges (`npm run seed && npm start`, plus the public URL)
