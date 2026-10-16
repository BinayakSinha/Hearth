// Hearth's Echo Show screen — an MCP App (MCP Apps extension, @modelcontextprotocol/ext-apps).
// The host (Alexa+ on a screen device, or Hearth's simulator) loads this page in a sandboxed iframe
// and sends it each tool result; the page draws the matching view from `structuredContent`.
import { App } from "@modelcontextprotocol/ext-apps";

type Person = { name: string; called?: string | null; photo?: string | null; role?: string; waiting?: number; week_entries?: number };
type Screen =
  | { view: "progress"; child: Person; first: number; latest: number; weekly: { week: string; avg_words: number }[]; big_words: string[]; streak: number; note: string }
  | { view: "radio"; cast: Person[]; script: string; period_days: number }
  | { view: "family"; family: Person[]; stories: number; waiting: number }
  | { view: "saved"; person: Person; said: string; reply: string; big_words: string[]; private?: boolean; safety?: boolean }
  | { view: "message"; title: string; body: string };

const root = document.getElementById("root")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const COLORS: Record<string, string> = { child: "#F2A33A", adult: "#4C8BD6", elder: "#D9708F" };
const ring = (p: Person) => COLORS[p.role ?? "adult"] ?? "#8B7BD8";
const face = (p: Person, size: number) =>
  `<span class="face" style="--c:${ring(p)};width:${size}px;height:${size}px">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<b>${esc(p.name[0])}</b>`}</span>`;
const SPARK = `<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" fill="currentColor"/></svg>`;

function progress(s: Extract<Screen, { view: "progress" }>) {
  const max = Math.max(...s.weekly.map((w) => w.avg_words), 1);
  return `<section class="progress">
    <div class="who">${face(s.child, 210)}<h1>${esc(s.child.name)}</h1><p>Speaking practice · ${s.streak}-day streak</p></div>
    <div class="growth">
      <div class="big"><span class="from">${s.first}</span><span class="arrow">→</span><span class="to">${s.latest}</span></div>
      <p class="cap">words per answer, from the first week to now</p>
      <div class="bars">${s.weekly.map((w) => `<div><i style="height:${Math.max(8, (w.avg_words / max) * 120)}px"></i><span>${esc(w.week.replace(/^\w+,?\s*/, "").replace(/(\w{3})\w*$/, "$1"))}</span></div>`).join("")}</div>
      ${s.big_words.length ? `<p class="cap">New big words</p><div class="chips">${s.big_words.slice(-6).map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : ""}
      <p class="note">${esc(s.note)}</p>
    </div>
  </section>`;
}

let radioTimer: number | undefined;
function radio(s: Extract<Screen, { view: "radio" }>) {
  const paras = s.script.split(/\n+/).filter(Boolean);
  setTimeout(() => {
    // Light up one paragraph at a time, roughly at speaking pace, and pulse whoever it mentions.
    let i = 0;
    const step = () => {
      const ps = root.querySelectorAll<HTMLElement>(".script p");
      ps.forEach((p, j) => p.classList.toggle("on", j === i));
      ps[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
      root.querySelectorAll<HTMLElement>(".cast .face").forEach((f) => f.classList.toggle("speaking", !!paras[i] && (paras[i].includes(f.dataset.name!) || (!!f.dataset.called && paras[i].includes(f.dataset.called!)))));
      const words = (paras[i] ?? "").split(/\s+/).length;
      i++;
      if (i <= paras.length) radioTimer = window.setTimeout(step, Math.max(2500, words * 330));
    };
    clearTimeout(radioTimer);
    step();
  }, 400);
  return `<section class="radio">
    <header><h1>Family Radio</h1><p>The last ${s.period_days} days at home</p></header>
    <div class="cast">${s.cast.map((p) => `<span data-name="${esc(p.name)}" data-called="${esc(p.called ?? "")}" class="face" style="--c:${ring(p)};width:84px;height:84px">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<b>${esc(p.name[0])}</b>`}</span>`).join("")}</div>
    <div class="script">${paras.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
  </section>`;
}

function family(s: Extract<Screen, { view: "family" }>) {
  const n = s.family.length;
  return `<section class="family">
    <div class="arc">${s.family.map((p, i) => {
      const a = Math.PI + (Math.PI * (i + 0.5)) / n;
      const x = 50 + 41 * Math.cos(a), y = 88 + 68 * Math.sin(a);
      return `<div class="seat" style="left:${x}%;top:${y}%">${face(p, 150)}${p.waiting ? `<em>${p.waiting}</em>` : ""}<strong>${esc(p.name)}</strong><small>${esc(p.called && p.called !== p.name ? p.called : "")}</small></div>`;
    }).join("")}</div>
    <div class="center"><h1>${s.stories}</h1><p>stories this week${s.waiting ? ` · ${s.waiting} waiting to be heard` : ""}</p></div>
  </section>`;
}

function saved(s: Extract<Screen, { view: "saved" }>) {
  if (s.safety) {
    return `<section class="saved quiet">${face(s.person, 120)}<h1>Thank you, ${esc(s.person.name)}</h1><p class="reply">${esc(s.reply)}</p></section>`;
  }
  return `<section class="saved">
    <div class="who">${face(s.person, 200)}<strong>${esc(s.person.name)}</strong>${s.private ? `<small>Kept private</small>` : ""}</div>
    <div class="words">
      <blockquote>“${esc(s.said)}”</blockquote>
      <p class="reply">${esc(s.big_words.length ? s.reply.replace(/"[^"]+" is a great new word! /, "") : s.reply)}</p>
      ${s.big_words.length ? `<div class="sticker">${SPARK}<span>New big word: <b>${esc(s.big_words[0])}</b></span></div>` : ""}
    </div>
  </section>`;
}

function render(s: Screen | undefined) {
  clearTimeout(radioTimer);
  if (!s) { root.innerHTML = `<section class="message"><h1>Hearth</h1></section>`; return; }
  root.className = `view-${s.view}`;
  root.innerHTML =
    s.view === "progress" ? progress(s)
    : s.view === "radio" ? radio(s)
    : s.view === "family" ? family(s)
    : s.view === "saved" ? saved(s)
    : `<section class="message"><h1>${esc(s.title)}</h1><p>${esc(s.body)}</p></section>`;
}

const app = new App({ name: "Hearth screen", version: "1.0.0" }, {}, { autoResize: true });
app.ontoolinput = () => { root.innerHTML = `<section class="message"><div class="flame"></div></section>`; };
app.ontoolresult = (result) => {
  const screen = (result as { structuredContent?: Screen }).structuredContent;
  if ((result as { isError?: boolean }).isError) {
    const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "Something went wrong.";
    render({ view: "message", title: "Hearth", body: text });
  } else render(screen);
};
app.onhostcontextchanged = (ctx) => document.documentElement.dataset.theme = (ctx as { theme?: string }).theme ?? "light";
render(undefined);
await app.connect();
const theme = (app.getHostContext() as { theme?: string } | undefined)?.theme;
if (theme) document.documentElement.dataset.theme = theme;
