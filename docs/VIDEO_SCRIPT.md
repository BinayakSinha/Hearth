# Hearth — demo video script (about 2:50)

**Before recording:** `npm run seed`, then `npm start`. Open http://localhost:8787/sim/ on the left half of the screen and http://localhost:8787/ (dashboard) on the right. Keep the "What Alexa+ did" panel visible. Bedrock stays on, except where marked **[tick Scripted]**.

`TYPE` = type into the sim (or say it into the mic). `CLICK` = pick that photo chip.

---

### 0:00 – 0:20 · Hook
*(Dashboard, Rose's photo and her bicycle story)*

> "In 1955, Rose learned to ride a bicycle on her brother's big black bike. Stories like this usually vanish, and a seven-year-old's first long sentences go unwritten. Hearth is a family memory that lives on Alexa+, the one assistant that's in the room with everyone. Quick note: the three weeks of history are sample data, and these photo chips stand in for Alexa+ voice ID. Everything else is live."

### 0:20 – 1:05 · Leo's journal and the bicycle thread
CLICK **Leo** → TYPE `Alexa, open my journal`

> "Leo opens his journal. Alexa doesn't ask a generic question. It asks about Gran's story. That's a Family Thread: one generation's memory becomes the next one's prompt."

TYPE `I rode my bike down a giant hill. It was enormous!`

> "Leo answers in his own words, and that's exactly what's saved, word for word. Alexa never corrects him. It says his idea back a little more fully and asks a follow-up. The Echo Show screen is an MCP App, showing his words and his new big word. On the right, the dashboard updates by itself, and his answer goes back to Gran."

### 1:05 – 1:35 · Mum's progress screen
CLICK **Amara** → TYPE `Alexa, how's Leo doing? My PIN is 1234`

> "Mum asks how Leo's doing. Kids' data needs a parent PIN. In four weeks his answers grew from about seven words to about twenty-seven, with new words like 'submarine' and 'peaceful'. It's encouragement, not a clinical assessment, and the screen says so."

### 1:35 – 2:05 · Family chat **[tick Scripted]**
CLICK **Marcus** → TYPE `Alexa, start a family chat with Gran and Leo`
CLICK **Rose** → TYPE `My best friend was Margaret. We climbed the apple tree every day.`
CLICK **Leo** → TYPE `Gran, did you ever fall out of the tree?`
CLICK **Marcus** → TYPE `We're done`

> "The Family Table hosts a conversation across three generations: it asks Gran a question, prompts Leo to ask one back, and saves the chat to everyone's journal."

**[untick Scripted]**

### 2:05 – 2:30 · Trust
CLICK **Finn** → TYPE `Alexa, how's Leo doing?`

> "Uncle Finn isn't Leo's parent, so he's refused."

CLICK **Finn** → TYPE `Alexa, open my journal` → TYPE `Busy day. I fixed the shed roof.` → TYPE `Alexa, delete what I just said`

> "Anyone can delete by voice. Adding a child needs parent consent, old entries expire, and Alexa can't save a paraphrase as someone's words. And if a child says something that sounds unsafe, Hearth tells no one in the house. It gently helps them find a trusted adult."

### 2:30 – 2:45 · Family Radio
CLICK **Amara** → TYPE `Alexa, play Family Radio`

> "Every week, Family Radio reads the household its own story. Each face lights up as they're mentioned."

### 2:45 – 2:55 · Under the hood
*(Architecture slide or README diagram)*

> "Under the hood: a Bedrock Nova Lite agent, guided by the Hearth Agent Skill, plays Alexa+ and reaches Hearth only through MCP over Streamable HTTP. The screen is an MCP App. Twelve tools, with every rule enforced in code. Hearth: the family memory that talks back."
