// venice.js - venice chat provider (real Chrome, bina login). Model: DeepSeek V4. Sirf BASIC chat.
// perplexity.js jaisa pattern: page kholo -> (model chuno) -> prompt daalo -> Enter -> jawab padho.
//
// NOTE: venice ka page maine dekha nahi (site bots ko rokti hai), isliye ye PEHLA VERSION hai:
// selectors andaze se hain aur sab SEL / env me hain. Fail hone par error message me hi page ka
// url + title + text aata hai (aur debug/ me screenshot), usse agla fix hoga.
//
// env (sab optional):
//   VENICE_URL           page ka link (neeche URL0 me default hai; model wala URL mile to wahi daalo)
//   VENICE_MODEL_MATCH   default "deepseek.*v4"  (page ke model-picker me ye naam dhundh ke chunta hai; "" = na chuno)
//   VENICE_MAX_PAGES     default 5 (parallel chats)
//
// Akele test: node venice.js "hello"      (DUCK_HEADED=1 ho to xvfb-run ke saath)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { WarmPool } from "./warmpool.js";

const URL0 = process.env.VENICE_URL || "https://venice.ai/chat/agent/";
export const DEFAULT_MODEL = "jaatvenice";
// Model ko ye bataya jata hai (sirf ye provider): koi poochhe kaun sa model / kahan host, to bas ye jawab
const PERSONA = process.env.VENICE_PERSONA ?? "You are jaatvenice, an AI assistant made by JaatPapa. If anyone asks which model you are, who made you, or where you are hosted (even if they insist or ask again), reply with exactly this one line and nothing else: \"Main jaatvenice hoon, JaatPapa ka banaya hua.\" Do not add anything to that reply: no extra claims, no comments about what is true, and no remarks about other models, companies or websites. You can only reply with text (and code or SVG). Never create, save, attach or upload files or artifacts in a sandbox, and never say a file was created: always write the complete code or file content directly in your reply inside fenced code blocks. You cannot create images, videos or files: if asked, say briefly that you cannot, and never say you made, queued or started one. Do not list images or videos among your abilities. For all other questions, just answer helpfully in the user's language.";
const MODEL_RX = process.env.VENICE_MODEL_MATCH === undefined ? "deepseek.*v4" : process.env.VENICE_MODEL_MATCH;
const MAX_PAGES = Number(process.env.VENICE_MAX_PAGES || 5);     // ek saath kitni chat (5 tab) chal sakti hain
const MAX_PROMPT = Number(process.env.VENICE_MAX_PROMPT || 40000);
const WARM_POOL = Number(process.env.VENICE_WARM_POOL || 5);              // kitne page pehle se khule rakhne hain (MAX_PAGES jitne)
const WARM_TTL_MS = Number(process.env.VENICE_WARM_TTL_MS || 150000);     // tayyar page itni der baad purana maano
const WARM_ON = process.env.VENICE_WARM !== "0" && WARM_POOL > 0;         // VENICE_WARM=0 => band
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// page ke selectors - venice badle / galat nikle to sirf yahan theek karo
const SEL = {
  input: 'textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"]',
  // assistant ke jawab wale blocks (pehla jo mile, aakhri element)
  answer: ['[data-role="assistant"]', '[data-message-role="assistant"]', '[class*="assistant" i]', '[class*="markdown" i]', "div.prose", ".prose"],
  stop: 'button[aria-label*="stop" i], button[title*="stop" i]',
  send: 'button[type="submit"], button[aria-label*="send" i]',
  attach: 'button[aria-label*="attach" i], button[aria-label*="upload" i], button[aria-label*="file" i], button[title*="attach" i], button[title*="upload" i]',
  modelOpeners: '[data-testid*="model" i], button[aria-label*="model" i], button[aria-haspopup="listbox"], button[aria-haspopup="menu"], button:has-text("Venice")',
};

// upload par login/upgrade maange to wall maano (nav ke "Sign up" se confuse na ho)
const UPLOAD_WALL = /(sign (up|in)|log ?in|upgrade|create (an )?account) (to|for) (upload|attach)|(upload|attach)\w* (is |are )?(only|require\w*|need\w*|available).{0,30}(account|sign|log ?in|pro|premium|paid)/i;
const textLike = (name, mime) => /^text\//i.test(mime || "") || /\.(txt|md|csv|tsv|json|jsonl|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|c|cpp|h|go|rs|rb|php|sh|sql|ya?ml|toml|ini|log|cfg)$/i.test(name || "");

// files page ke file-input / attach button se daalo. Kaise hua wo naam lautata hai, na hua to null
async function uploadFiles(page, att) {
  const tryInput = async () => {
    const i = page.locator('input[type="file"]').first();
    if (!(await i.count())) return false;
    await i.setInputFiles(att, { timeout: 8000 });
    return true;
  };
  if (await tryInput()) return "input";
  const btn = page.locator(SEL.attach).first();
  if (await btn.count()) {
    try { const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 4000 }), btn.click({ timeout: 3000 })]); await fc.setFiles(att); return "chooser"; } catch {}
    try { // menu khula ho sakta hai: uske andar upload wala item
      const it = page.getByText(/upload|add (a )?(photo|file|image)|attach/i).first();
      if (await it.count()) { const [fc] = await Promise.all([page.waitForEvent("filechooser", { timeout: 4000 }), it.click({ timeout: 3000 })]); await fc.setFiles(att); return "menu"; }
    } catch {}
    try { if (await tryInput()) return "input-after"; } catch {}
    try { await page.keyboard.press("Escape"); } catch {}
  }
  return null;
}

class VeniceError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- playwright load (lazy) ---------------------------------------------------
async function loadPlaywright() {
  for (let i = 0; i < 15; i++) {
    try { return await import("playwright-core"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("venice: playwright-core install ho raha hai...");
  execFileSync("npm", ["i", "--no-audit", "--no-fund", "--no-save", "playwright-core"], { stdio: "inherit" });
  return await import("playwright-core");
}
function chromePath() {
  for (const p of [process.env.DUCK_CHROME_PATH, "/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"])
    if (p && fs.existsSync(p)) return p;
  return undefined;
}

// ---- messages -> ek prompt string ---------------------------------------------
function textOf(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).filter(Boolean).join("\n");
  return String(c);
}
export function flatten(messages) {
  const parts = [];
  for (const m of (messages || []).filter(Boolean)) {
    const t = textOf(m.content).trim();
    if (!t) continue;
    const role = m.role === "assistant" ? "Assistant" : m.role === "system" || m.role === "developer" ? "System" : "Human";
    parts.push({ role, t });
  }
  if (parts.length === 1 && parts[0].role === "Human") return PERSONA ? PERSONA + "\n\nUser message: " + parts[0].t : parts[0].t;
  if (PERSONA) parts.unshift({ role: "System", t: PERSONA });
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message. " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

// Prompt MAX_PROMPT se bada ho to pehle .slice(-MAX) se SHURU ka hissa (persona + system + purani baatein) kat jata tha.
// Ab: System parts hamesha rakho, sabse purane Human/Assistant turns ek-ek karke hatao, aakhri message hamesha rakho.
export function flattenFit(messages, max) {
  let msgs = (messages || []).filter(Boolean);
  let out = flatten(msgs);
  if (out.length <= max) return out;
  const idx = msgs.map((m, i) => (m.role === "system" || m.role === "developer" ? -1 : i)).filter((i) => i >= 0);
  while (out.length > max && idx.length > 1) {
    msgs = msgs.filter((_, i) => i !== idx[0]);
    for (let k = 1; k < idx.length; k++) idx[k]--;
    idx.shift();
    out = flatten(msgs);
  }
  return out.length > max ? out.slice(0, 600) + "\n...\n" + out.slice(-(max - 610)) : out; // ek hi message bahut bada: shuru + aakhir
}

// login wall / limit message jawab nahi, error hai
function isWall(t) {
  const x = String(t || "").trim();
  return x.length > 0 && x.length < 300 && /sign up|sign in|log ?in\b|create (an )?account|continue with (google|apple|email)|upgrade to|you('| ha)ve reached|limit reached|out of (credits|messages)/i.test(x);
}

// ---- Cloudflare challenge: ruko / checkbox dabao --------------------------------
async function passChallenge(page, ms = 22000) {
  const isChallenge = async () => {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (/just a moment|attention required|security verification/.test(title)) return true;
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    return /performing security verification|verify you are human|checking your browser/.test(body);
  };
  if (!(await isChallenge())) return true;
  console.log("venice: cloudflare challenge mila, intezaar...");
  const end = Date.now() + ms;
  let tries = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(2000);
    if (!(await isChallenge())) { console.log("venice: challenge paas"); await page.waitForTimeout(1500); return true; }
    if (tries++ % 2 === 0) {
      for (const f of page.frames()) {
        if (!/challenges\.cloudflare\.com|turnstile/.test(f.url())) continue;
        try { await f.locator('input[type="checkbox"], label, body').first().click({ timeout: 2000, position: { x: 20, y: 20 } }); } catch {}
      }
    }
  }
  return false;
}

async function dismissPopups(page) {
  try { await page.keyboard.press("Escape"); } catch {}
  for (const name of [/^accept( all)?$/i, /^i agree$/i, /^got it$/i, /^continue as guest$/i, /^continue without (an )?account$/i, /^stay logged out$/i, /^maybe later$/i, /^not now$/i, /^close$/i, /^skip$/i, /^dismiss$/i]) {
    try { const b = page.getByRole("button", { name }).first(); if (await b.count()) await b.click({ timeout: 1500 }); } catch {}
  }
}

async function pageInfo(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  const n = await page.evaluate(() => ({ ce: document.querySelectorAll("[contenteditable]").length, ta: document.querySelectorAll("textarea").length, btn: document.querySelectorAll("button").length })).catch(() => ({}));
  return `url=${page.url()} | title=${title} | ce=${n.ce} ta=${n.ta} btn=${n.btn} | body: ${body}`;
}

// model-picker se DeepSeek V4 chuno (best effort; fail ho to chhod do aur jo default ho wahi chalega)
async function pickModel(page) {
  if (!MODEL_RX) return "skip";
  const rx = new RegExp(MODEL_RX, "i");
  try {
    const before = (await page.innerText("body").catch(() => "")).slice(0, 4000);
    // picker pehle se wahi dikha raha ho to chhod do
    const opener = page.locator(SEL.modelOpeners).first();
    if (!(await opener.count())) return "no-picker";
    const label = ((await opener.innerText().catch(() => "")) || "").trim();
    if (rx.test(label)) return "already:" + label.slice(0, 40);
    await opener.click({ timeout: 3000 });
    await page.waitForTimeout(700);
    const opt = page.getByText(rx).first();
    if (await opt.count()) { await opt.click({ timeout: 3000 }); await page.waitForTimeout(600); return "picked"; }
    await page.keyboard.press("Escape").catch(() => {});
    return "not-in-list(" + before.length + ")";
  } catch (e) { try { await page.keyboard.press("Escape"); } catch {} return "err:" + String(e.message).slice(0, 60); }
}

// jawab padho: assistant-block selectors, nahi to "prompt ke baad ka body text"
// head = prompt ka shuru (user ke bubble ko pehchanne ke liye), tail = prompt ka AKHIR (fallback me jawab isi ke baad shuru hota hai).
// Pehle fallback prompt ke SHURU ke baad ka text uthata tha, to page par dikh rahe prompt ka bacha hissa ("y ONLY as the Assistant...
// System: You are jaatvenice...") hi jawab ban kar Telegram par chala jata tha.
async function readAnswer(page, head, tail) {
  return page.evaluate(({ sels, head, tail }) => {
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mk = (s) => { const w = String(s || "").split(/\s+/).filter(Boolean).map(esc); return w.length ? new RegExp(w.join("\\s+")) : null; };
    const rxHead = mk(head), rxTail = mk(tail);
    const isUser = (txt) => (rxHead && rxHead.test(txt)) || (rxTail && rxTail.test(txt));
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)].filter((e) => e.innerText && e.innerText.trim() && !isUser(e.innerText));
      if (els.length) {
        const el = els[els.length - 1];
        let t = el.innerText.trim();
        // Page code ko code-box (<pre>) me dikhata hai; innerText me ``` fence aur language nahi aati, to bot ko code seedha text lagta tha.
        // Har code-box ko wapas ```lang ... ``` bana do (bot isi se copy-message / file banata hai).
        let from = 0;
        for (const pre of el.querySelectorAll("pre")) {
          const c = pre.querySelector("code") || pre;
          const code = String(pre.innerText || c.textContent || "").replace(/\s+$/, "").replace(/^\n+/, "");
          if (!code.trim() || code.includes("```")) continue;
          let lang = (/language-([\w+#-]+)/.exec((c.className || "") + " " + (pre.className || "")) || [])[1] || "";
          if (!lang) { // code-box ke upar wale label ("python  Copy code") se
            let p = pre;
            for (let i = 0; i < 3 && p && !lang; i++) { p = p.parentElement; const m = p && /^\s*([A-Za-z+#.\-]{1,14}?)\s*Copy/i.exec(p.innerText || ""); if (m) lang = m[1].toLowerCase(); }
          }
          const idx = t.indexOf(code.trim(), from);
          if (idx < 0) continue;
          const body = code.trim(), rep = "\n```" + lang + "\n" + body + "\n```\n";
          t = t.slice(0, idx) + rep + t.slice(idx + body.length);
          from = idx + rep.length;
        }
        return { via: sel, text: t };
      }
    }
    // fallback: page ke text me prompt ka AKHIRI hissa (aakhri baar) dhundo, jawab uske baad ka text hai.
    // Prompt ka akhir na mile to khali lautao (jawab abhi shuru nahi hua / page ne prompt chhota dikhaya) - galat text mat do.
    const t = document.body.innerText || "";
    if (rxTail) {
      const g = new RegExp(rxTail.source, "g");
      let m, end = -1;
      while ((m = g.exec(t))) { end = m.index + m[0].length; if (m[0].length === 0) g.lastIndex++; }
      if (end >= 0) return { via: "body-after-prompt", text: t.slice(end).trim() };
    }
    return { via: "none", text: "" };
  }, { sels: SEL.answer, head, tail }).catch(() => ({ via: "err", text: "" }));
}

// jawab ki jagah prompt (ya persona / transcript wali line) ka echo aaya ho to wo jawab nahi hai
const ECHO_RX = /Reply ONLY as the Assistant to the last Human|Below is a conversation transcript|You are jaatvenice, an AI assistant made by/i;
const isEcho = (t) => ECHO_RX.test(String(t || "").slice(0, 500));

// Venice page ka UI-kachra jawab se hatao: "Worked for 2s · 1 step", code-box ka label + "Copy code"
function cleanAnswer(t) {
  const lines = String(t || "").split(/\r?\n/);
  const out = [];
  // Venice page ke UI button / label (poori line sirf yahi ho tabhi hatao, jawab ka asli text na kate)
  const UI_LINE = /^(copy|copied!?|regenerate|retry|try again|share|edit|read aloud|good response|bad response|like|dislike|report|more)$/i;
  const NOTICE = /^(venice|ai) can make mistakes\b.*$/i;
  for (const l of lines) {
    const x = l.replace(/[\u200b-\u200d\u00a0\ufeff]/g, " ").trim();
    if (/^(worked|thought|thinking|reasoned) for\b.*$/i.test(x)) continue;          // Worked for 2s · 1 step
    if (/^[A-Za-z+#.\-]{1,14}\s*copy( code)?$/i.test(x) && !/^copy( code)?$/i.test(x)) continue; // "pythonCopy code" ek hi line me
    if (/^copy( code)?$/i.test(x)) {                                                  // Copy code (aur uske upar ka akela label)
      if (out.length && /^[A-Za-z+#.\-]{1,14}$/.test(out[out.length - 1].trim())) out.pop();
      continue;
    }
    if (UI_LINE.test(x) || NOTICE.test(x)) continue;
    if (/^\[(files?|attached file|end of file|image)\b[^\]]*\]$/i.test(x)) continue; // bot ke history tag ([files: a.jpg]) jawab me echo ho gaye to hatao
    out.push(l);
  }
  // shuru me role label ("Assistant:", "Human:" ...) lagake jawab diya ho to hatao
  let body = out.join("\n").replace(/^\s*(?:(?:assistant|jaatvenice|ai)\s*:\s*)+/i, "");
  // transcript aage badha diya ho ("Human: ..." se naya turn shuru) to wahan se kaat do
  const cut = body.search(/\n\s*(?:human|user)\s*:\s/i);
  if (cut > 0) body = body.slice(0, cut);
  // jawab me "Venice" / "Venice.ai" likha ho to "jaatvenice" kar do (link/URL ko mat chhedo)
  const res = body.replace(/\n{3,}/g, "\n\n").trim()
    .replace(/(?<![\/\w.@-])venice(?:\.ai)?(?![\w\/-])/gi, (m) => (m[0] === "V" ? "Jaatvenice" : "jaatvenice"));
  return res || String(t || "").trim(); // sab hat gaya to original
}

function completion(model, text) {
  return JSON.stringify({
    id: "chatcmpl-venice-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export class VeniceClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.pool = new WarmPool({ size: WARM_POOL, ttlMs: WARM_TTL_MS, label: "venice", open: async () => { await this.ensure(); return this._prepare(); } });
  }

  async ensure() {
    if (this.ctx) return;
    if (!this.starting) this.starting = (async () => {
      const { chromium } = await loadPlaywright();
      const headless = process.env.DUCK_HEADED !== "1";
      const launch = { headless, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] };
      const exe = chromePath();
      if (exe) launch.executablePath = exe; else launch.channel = "chrome";
      this.browser = await chromium.launch(launch);
      const ver = this.browser.version();
      const ua = process.env.VENICE_UA ||
        `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
      this.ctx = await this.browser.newContext({ userAgent: ua, locale: "en-US", viewport: { width: 1280, height: 800 } });
      await this.ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
      console.log("venice: chrome ready", ver, headless ? "(headless)" : "(headed)");
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  async slot() { if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r)); this.active++; }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); }

  async debug(page, tag) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const f = `${DEBUG_DIR}/${Date.now()}-venice-${tag}`;
      await page.screenshot({ path: f + ".png" }).catch(() => {});
      fs.writeFileSync(f + ".json", JSON.stringify({ info: await pageInfo(page) }, null, 1));
      console.log("venice debug:", f);
    } catch {}
  }

  // wall / limit mila to error (jawab nahi) + session reset
  async guard(text, page) {
    if (!isWall(text)) return;
    console.log("venice: login wall / limit:", String(text).trim().slice(0, 120));
    await this.debug(page, "wall");
    try { await this.ctx.clearCookies(); } catch {}
    this.pool.flush(); // purani session wale warm pages hatao
    throw new VeniceError("jaatvenice guest limit / login maang raha hai. Thodi der baad try karo", "ratelimit");
  }

  // ---- PEHLE SE TAYYAR PAGE: goto + challenge + input + model sab pehle ho chuka hota hai ----
  async _prepare(prog = () => {}) {
    const page = await this.ctx.newPage();
    try {
      await page.goto(URL0, { waitUntil: "domcontentloaded", timeout: 25000 });
      prog("page-opened");
      await page.waitForTimeout(1500);
      await passChallenge(page);
      await dismissPopups(page);
      prog("challenge-checked");

      const box = page.locator(SEL.input).first();
      try { await box.waitFor({ state: "visible", timeout: 12000 }); }
      catch {
        await dismissPopups(page);
        try { await box.waitFor({ state: "visible", timeout: 5000 }); }
        catch {
          const info = await pageInfo(page);
          console.log("venice no-input:", info);
          await this.debug(page, "no-input");
          if (/verify you are human|just a moment|captcha|security verification|checking your browser/i.test(info))
            throw new VeniceError("jaatvenice bot check (DUCK_HEADED=1 try karo) | " + info.slice(0, 380), "challenge");
          if (/sign up|log in|sign in|create account/i.test(info)) throw new VeniceError("jaatvenice login maang raha hai | " + info.slice(0, 380), "ratelimit");
          throw new VeniceError("jaatvenice input box nahi mila | " + info.slice(0, 380), "error");
        }
      }
      prog("input-ready");
      const pm = await pickModel(page);
      prog("model", { detail: pm });
      await dismissPopups(page);
      return { page, box, pm };
    } catch (e) { try { await page.close(); } catch {} throw e; }
  }

  // runner start par: chrome + WARM_POOL pages pehle se tayyar (background)
  warmUp() { if (WARM_ON) this.pool.start(); }
  warmReady(ms) { return WARM_ON ? this.pool.settled(ms) : Promise.resolve(); }

  // wall / bot-check / limit aaye to ek baar nayi page (saaf cookies) se khud dobara koshish. Runner badalne ke waqt naye
  // runner ki pehli pages par aksar yahi aata tha aur user ko seedha error milta tha.
  async chat(args, timeoutMs = 240000) {
    const t0 = Date.now();
    try { return await this._chat(args, timeoutMs, false); }
    catch (e) {
      const left = timeoutMs - (Date.now() - t0);
      if (e && (e.kind === "ratelimit" || e.kind === "challenge") && left > 70000) {
        console.log("venice: " + e.kind + " aaya, nayi page se ek baar dobara:", String(e.message).slice(0, 100));
        try { args.onProgress && args.onProgress({ stage: "retry", ms: Date.now() - t0, detail: e.kind }); } catch {}
        await new Promise((r) => setTimeout(r, 2500));
        if (args.shouldStop && (await args.shouldStop())) throw new VeniceError("jaatvenice request cancel ho gayi", "cancelled");
        return await this._chat(args, left - 3000, true);
      }
      throw e;
    }
  }

  async _chat({ model, messages, files, onProgress, shouldStop }, timeoutMs = 240000, fresh = false) {
    const att = (files || []).map((f) => ({ name: f.name || "file", mimeType: f.mime || "application/octet-stream", buffer: Buffer.from(String(f.b64 || ""), "base64") }));
    if (att.length && !(messages || []).some((m) => m && m.role === "user" && textOf(m.content).trim()))
      messages = [...(messages || []), { role: "user", content: "Look at the attached file(s) and tell me what is in them." }];
    let prompt = flattenFit(messages, MAX_PROMPT);
    if (!prompt.trim()) throw new VeniceError("empty prompt", "bad_request");
    await this.ensure();
    await this.slot();
    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    let lastGen = 0;
    // live progress: console + (runner ke through) worker ko, taaki API se dekh sako venice kya kar raha hai
    const prog = (stage, extra = {}) => {
      const ms = Date.now() - t0;
      console.log(`venice [${Math.round(ms / 1000)}s]: ${stage}` + (extra.detail ? " | " + extra.detail : "") + (extra.chars != null ? ` | ${extra.chars} chars` : ""));
      try { onProgress && onProgress({ stage, ms, ...extra }); } catch {}
    };
    let page;
    try {
      prog("start");
      let w = WARM_ON && !fresh ? await this.pool.take() : null;
      if (w) { prog("page-opened", { detail: "warm" }); prog("input-ready"); prog("model", { detail: w.pm }); }
      else w = await this._prepare(prog);
      page = w.page;
      const box = w.box;

      if (att.length) {
        const mb = att.reduce((a, f) => a + f.buffer.length, 0) / 1048576;
        prog("uploading", { detail: att.length + " file, " + mb.toFixed(1) + "MB" });
        let how = null, why = "";
        try { how = await uploadFiles(page, att); } catch (e) { why = String((e && e.message) || e).slice(0, 120); }
        if (how) {
          await page.waitForTimeout(Math.min(15000, 1500 + mb * 1500)); // upload/preview poora hone do
          const bt = (await page.innerText("body").catch(() => "")).slice(0, 4000);
          if (UPLOAD_WALL.test(bt)) { how = null; why = "login/upgrade maang raha hai"; }
        }
        if (how) prog("uploaded", { detail: how });
        else {
          await this.debug(page, "upload-fail");
          const tx = att.filter((f) => textLike(f.name, f.mimeType));
          if (tx.length !== att.length) throw new VeniceError("jaatvenice me file upload nahi ho paya (guest mode me band ho sakta hai) " + why + " | " + (await pageInfo(page)).slice(0, 250), "error");
          prog("upload-fallback", { detail: "text files prompt me inline kiye" });
          prompt = tx.map((f) => "[Attached file: " + f.name + "]\n" + f.buffer.toString("utf8").slice(0, 30000) + "\n[end of file]").join("\n\n") + "\n\n" + prompt;
        }
      }

      await box.click();
      await page.keyboard.insertText(prompt); // lamba prompt: paste jaisa
      await page.waitForTimeout(250);
      await page.keyboard.press("Enter");
      // Enter se na bhej paye to send button
      await page.waitForTimeout(600);
      try { const sb = page.locator(SEL.send).first(); if ((await sb.count()) && (await box.innerText().catch(() => "")).trim().length > 5) await sb.click({ timeout: 1500 }); } catch {}

      prog("prompt-sent", { chars: prompt.length });
      const flat = prompt.replace(/\s+/g, " ").trim();
      const probe = flat.slice(0, 40).trim(), tailProbe = flat.slice(-40).trim();
      let last = "", stable = 0, started = false, via = "";
      while (Date.now() < deadline) {
        if (shouldStop && (await shouldStop())) {
          prog("cancelled", { chars: last.length });
          throw new VeniceError("jaatvenice request cancel ho gayi", "cancelled");
        }
        await page.waitForTimeout(400);
        const r = await readAnswer(page, probe, tailProbe);
        const raw = (r.text || "").trim();
        const txt = isEcho(raw) ? "" : raw; // prompt ka echo jawab nahi: jab tak asli jawab na aaye "abhi shuru nahi hua" maano
        if (txt) { started = true; via = r.via; }
        if (txt && txt !== last && Date.now() - lastGen > 1500) { lastGen = Date.now(); prog("generating", { chars: txt.length, preview: txt.slice(-200) }); }
        const generating = (await page.locator(SEL.stop).count().catch(() => 0)) > 0;
        if (txt && txt === last && !generating) {
          if (++stable >= 6) { prog("done", { chars: txt.length, detail: "via " + via }); await this.guard(txt, page); return completion(DEFAULT_MODEL, cleanAnswer(txt)); }
        } else stable = 0;
        last = txt;
      }
      prog(started ? "timeout-partial" : "timeout", { chars: last.length });
      await this.debug(page, started ? "partial" : "timeout");
      if (last) { await this.guard(last, page); return completion(DEFAULT_MODEL, cleanAnswer(last)); } // adhura hi sahi
      throw new VeniceError("jaatvenice timeout (jawab nahi mila) | " + (await pageInfo(page)).slice(0, 300), "timeout");
    } catch (e) {
      prog("error", { detail: String((e && e.message) || e).slice(0, 200) });
      throw e;
    } finally {
      try { await page?.close(); } catch {}
      this.free();
    }
  }

  async close() { try { await this.pool.closeAll(); } catch {} try { await this.browser?.close(); } catch {} this.browser = null; this.ctx = null; this.starting = null; }
}

// ---- akele chalao: node venice.js "prompt" --------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PONG";
  const c = new VeniceClient();
  try {
    const t0 = Date.now();
    const r = JSON.parse(await c.chat({ model: "venice", messages: [{ role: "user", content: prompt }] }, 240000));
    console.log("\n=== VENICE OK in", Date.now() - t0, "ms ===\n" + r.choices[0].message.content);
    await c.close();
    process.exit(0);
  } catch (e) {
    console.log("\n=== VENICE FAIL ===", e.kind || "", e.message);
    await c.close();
    process.exit(1);
  }
}
