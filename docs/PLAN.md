# Hearth — build plan, pitch and demo script

Deadline: **Friday 23 October 2026** (Devpost). Judging 9–20 November.

## The pitch (one hero flow)

Lead with one story, not a feature list:

> Gran tells Alexa a story → it becomes Leo's question → Leo answers in his own words and Alexa helps him say it more fully → his answer goes back to Gran → Mum sees Leo's sentences growing.

Everything else (daily logs, memoir chapters, family table, Family Radio, recall) is shown as "and it also…" around that loop. The reviewer should leave remembering one thing: **Alexa+ is the only assistant in the room with the whole family, and Hearth connects their stories.**

The second message is **trust**: privacy and safety rules enforced in code, consent for kids, delete anything, and possible safety disclosures shared with no one.

## Where it stands (Fri 16 Oct)

The hackathon allows a simulated Alexa+ experience ("simulate an Alexa+ experience using your preferred agentic tools via a web app"), and Amazon has run out of credit codes. So the submission is built around the **simulator at `/sim`**. A real Alexa+ device is a bonus, not a dependency.

Done and tested (37 end-to-end checks over Streamable HTTP, plus 5 Bedrock checks against a mock Converse API):
- MCP server, 12 tools, protocol 2025-11-25, Streamable HTTP (stateless, Origin check, version check)
- **MCP Apps:** Hearth's Echo Show screen (`ui://hearth/screen.html`) for saved entries, a child's progress, Family Radio and the family arc
- **Simulated Alexa+:** a Bedrock (Nova Lite) agent that reaches Hearth only through MCP, a voice-ID stand-in, mic and speech, an MCP App host for the screen, and an MCP trace panel. A scripted router is used when offline.
- **Agent Skill:** `skills/hearth/SKILL.md`, loaded by the simulator's agent
- Fast replies (about 20 ms). Bedrock work runs in the background, and Family Radio is pre-written.
- Speaking practice, daily logs, memoir, family table, Family Threads, opt-in care nudges
- Light PIN, consent, delete, retention, paraphrase guard, safety disclosures, child-content check
- Dashboard: photo arc, journal panel, household view and unlock, live refresh
- Bedrock connected in Sydney (`amazon.nova-lite-v1:0`)

## Remaining days

| Day | Date | Goal |
|---|---|---|
| 1 | Sat 17 Oct | Run `npm run lab` and the simulator with Bedrock on, then tune prompts and the agent from what it actually says. Check the agent passes exact words and picks the right tools on every demo line. |
| 2 | Sun 18 Oct | Put a public instance up for judges: a free tunnel (`cloudflared`) from your machine for the demo week, or a small always-on host with a volume. Set `HEARTH_SECRET`. Replace the watermarked photos. |
| 3 | Mon 19 Oct | Rehearse the demo end to end in the simulator, and adjust the seed data so every beat lands. Optional: try the Alexa AI CLI if you get access. |
| 4 | Tue 20 Oct | Record the demo video (script below), with Bedrock on. |
| 5 | Wed 21 Oct | Edit the video, and write the Devpost story (hero flow, simulator + MCP + MCP Apps + Agent Skill, Bedrock, privacy and safety). |
| 6 | Thu 22 Oct | Final repo pass, make the repo public, submit a draft. |
| 7 | Fri 23 Oct | Submit. Don't build anything new. |

## Demo video (about 3 minutes, recorded in the simulator)

Say on screen once that the three weeks of history are sample data, and that the photo chips stand in for Alexa+ voice ID. Everything after that is live. Keep the "What Alexa+ did" panel visible: it proves every answer comes through MCP.

**0:00 – 0:20 · The hook.** Gran's photo and her bicycle story. "Stories like this disappear. Kids' first words go unwritten. Hearth is the family's memory, and it lives where the whole family already is."

**0:20 – 1:05 · The hero loop.** Simulator on the left, dashboard on the right.
- Pick Leo, then say "Alexa, open my journal". Alexa asks Gran's bicycle question (the family thread).
- Leo answers in a short sentence. Alexa recasts it and asks a follow-up, and the Echo Show screen shows his words and a big-word sticker. Caption: *"It never corrects him. It models richer language."*
- **The dashboard updates by itself:** Leo's bubble pulses and his entry appears.

**1:05 – 1:35 · The parent view.** Pick Amara: "Alexa, how's Leo doing?" Alexa asks for her PIN, and the screen shows 7 → 27 words per answer, the weekly bars and the big words. Show the "not a clinical assessment" line.

**1:35 – 2:05 · The family table.** Pick Marcus: "Alexa, start a family chat with Gran and Leo." Switch speakers for a few turns, then say "We're done". The conversation card appears on the dashboard.

**2:05 – 2:30 · Trust, in 25 seconds.** Quick cuts: Uncle Finn can't open Leo's journal; "Alexa, delete what I just said"; the consent statement when adding a child. One line: *"If a child says something that sounds unsafe, Hearth tells no one in the house, and gently helps them find a trusted adult."*

**2:30 – 2:45 · Family Radio.** "Alexa, play Family Radio." The screen highlights each part as it's read, and each person's face pulses when they're mentioned.

**2:45 – 3:00 · Under the hood.** Architecture: simulated Alexa+ (Bedrock agent + Agent Skill) → MCP (Streamable HTTP, 2025-11-25) → Hearth → Bedrock + Guardrails, with the screen as an MCP App. Close on: "Hearth. The family memory that talks back."

## Devpost checklist

- [ ] Public repo with the MCP server source (this repo)
- [ ] Demo video clearly showing the simulated Alexa+ working, with the MCP trace visible
- [ ] Simulator source in the repo (`src/simulator.ts`, `public/sim/`, `ui/`) and the Agent Skill (`skills/hearth/SKILL.md`)
- [ ] Bedrock and Guardrails mentioned and shown, for the AWS Builder Mini Challenge
- [ ] Testing instructions for judges (`npm install && npm run seed && npm start`, open `/sim/`, demo PIN `1234`, plus the public URL)
- [x] Watermarked stock photos replaced
