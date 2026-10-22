# Hearth — Devpost submission text

**Tagline:** A family memory that talks back: a shared voice journal on Alexa+ that passes stories between generations and helps kids find their words.

## Inspiration
Every family has a Gran with stories that never get written down, and a seven-year-old whose sentences are growing faster than anyone notices. Phones are personal; Alexa is the one assistant in the room with the whole family. We wanted to use that: one shared memory that every generation adds to, and that connects their stories.

## What it does
Hearth is an MCP server that turns Alexa+ into a family voice journal.
- **Kids' speaking practice.** Leo (7) answers a question. Alexa never corrects him. It says his idea back more fully (a "recast") and asks a follow-up. Parents see words per answer grow (7 → 27 over four weeks) and the new "big words" he uses.
- **Adults' daily logs, grandparents' memoirs.** Short spoken check-ins and memoir chapters, saved in the speaker's own words.
- **Family Threads.** Gran's 1955 bicycle story becomes a question for her grandson. His answer goes back to her.
- **The Family Table.** Alexa hosts a multi-person conversation and saves it to everyone's journal.
- **Family Radio.** A weekly spoken recap of the household's week.
- **Care nudges.** Opt-in, gentle prompts when someone has gone quiet.
- **A trust layer enforced in code:** a light PIN instead of voice ID, parent consent for kids, delete by voice, retention limits, rejection of paraphrased entries, and possible safety disclosures from a child kept private from everyone in the house, with gentle guidance to a trusted adult.

## How we built it
- **MCP server** in TypeScript (Node 22, Express 5, `@modelcontextprotocol/sdk`), spec 2025-11-25 over **Streamable HTTP** (`POST /mcp`, stateless, Origin and protocol-version checks), with 12 tools.
- **MCP Apps** (`@modelcontextprotocol/ext-apps`): Hearth's Echo Show screen (`ui://hearth/screen.html`) shows saved entries, a child's progress, Family Radio and the family arc.
- **Agent Skill** (`skills/hearth/SKILL.md`): how an assistant should use Hearth's tools: tone for kids, when to recast, when to stop and wait.
- **Amazon Bedrock** (Converse API, `amazon.nova-lite-v1:0`, ap-southeast-2) writes recasts, summaries, memoir chapters and Family Radio.
- **Simulated Alexa+** (allowed by the rules): a web Echo Show at `/sim/`. A Bedrock agent loads the Agent Skill and reaches Hearth *only* through MCP. Photo chips stand in for voice ID, and a "What Alexa+ did" panel shows every MCP call. A scripted router covers the same flows offline.
- **SQLite** (`node:sqlite`) for storage, plus a live family dashboard.

## Challenges we ran into
- **A 500 ms reply budget.** Voice can't wait for an LLM. Every tool replies in about 20 ms with a fast local answer, and Bedrock enriches the entry in the background (with retries for a new account's throttling). Family Radio is pre-written.
- **A small model inventing a child's answer.** Nova Lite once made up and saved an answer for Leo. We now enforce exact words in code: a save must match what the speaker actually said, and answers to journal questions are stored word for word. A paraphrase is rejected.

## Accomplishments that we're proud of
- One loop that really connects three generations: Gran's story → Leo's question → Leo's answer → back to Gran → Mum sees his progress.
- The trust rules aren't prompts. They're code paths with tests (37 end-to-end checks over Streamable HTTP, plus Bedrock checks against a mock).
- A full Alexa+ experience in the browser, with every step visible through MCP.

## What we learned
- MCP plus MCP Apps is a clean split: the assistant owns the conversation, the server owns the rules, and the screen comes with the server.
- With small models, guardrails belong in the tool layer, not the prompt.
- For kids, modelling richer language works better than correcting it.

## What's next for Hearth
- Running on a real Alexa+ device with real voice ID.
- Photo memories on the Echo Show, and printed memoir books for Gran.
- More languages, for bilingual families.
- Bedrock Guardrails on every generated summary, and a pilot with real families.

## Testing instructions for judges
Requires Node 22.13+. Works fully offline (no AWS needed).
```
git clone <REPO_URL>
cd hearth
npm install
npm run seed
npm start
```
- Simulator: http://localhost:8787/sim/ · Dashboard: http://localhost:8787/
- Pick **Leo** and type `Alexa, open my journal`, then answer in a sentence.
- Pick **Amara** and type `Alexa, how's Leo doing? My PIN is 1234` (demo PIN `1234`; Rose has no PIN).
- Also try: as Marcus, `Alexa, start a family chat with Gran and Leo` … `We're done`; `Alexa, play Family Radio`; as Finn, `Alexa, how's Leo doing?` (refused).
- Without AWS credentials the scripted agent runs. To use Bedrock, copy `.env.example` to `.env` and set `AWS_BEARER_TOKEN_BEDROCK`.
- Tests: `npm run test:e2e` (37 checks, offline), `npm run test:bedrock`, `npm run typecheck`.
- MCP endpoint: `POST http://localhost:8787/mcp`.

## Built with
typescript · node.js · express · model-context-protocol · mcp-apps · streamable-http · amazon-bedrock · amazon-nova · alexa-plus · agent-skills · sqlite · html · css
