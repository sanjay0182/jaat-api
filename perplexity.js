// perplexity.js - perplexity.ai provider (real Chrome, bina login). Sirf BASIC chat.
// Koi tools / streaming / session-reuse / image nahi. duck.js jaisa pattern:
// chrome kholo -> prompt textbox me daalo -> Enter -> jawab padho.
//
// Jawab 2 tareeke se pakadta hai:
//   1) network: /rest/sse/perplexity_ask ka SSE response (agar page ne wahi use kiya)
//   2) DOM: jawab wale markdown block ka text (fallback)
//
// NOTE: ye live test nahi hua. Perplexity ka page badalta rehta hai, isliye selectors
// ek jagah (SEL) rakhe hain. Fail hone par debug/ folder me screenshot + text milta hai.
//
// Sirf runner.js import karta hai. Akele test ke liye:
//   node perplexity.js "hello"        (DUCK_HEADED=1 ho to xvfb-run ke saath)

import { loadChromium } from "./pw.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { WarmPool } from "./warmpool.js";

const BASE = process.env.PPLX_BASE || "https://www.perplexity.ai";
export const DEFAULT_MODEL = "pplx-auto";
const MAX_PAGES = Number(process.env.PPLX_MAX_PAGES || 2); // ek saath kitne chat
const MAX_PROMPT = Number(process.env.PPLX_MAX_PROMPT || 12000);
const WARM_MAX_MS = Number(process.env.PPLX_WARM_MAX_MS || 120000); // garam page ki umar
const WARM_POOL = Number(process.env.PPLX_WARM_POOL || 3);          // kitne page pehle se khule rakhne hain
const WARM_ON = process.env.PPLX_WARM !== "0" && WARM_POOL > 0;     // PPLX_WARM=0 => band
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// page ke selectors - perplexity badle to sirf yahan theek karo
const SEL = {
  input: '#ask-input, [data-lexical-editor="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"], textarea',
  answer: '[id^="markdown-content-"], div.prose',
  stop: 'button[aria-label*="Stop" i]',
};

// cookie / login / "continue" popups jo input ko dhak sakte hain
async function dismissPopups(page) {
  try { await page.keyboard.press("Escape"); } catch {}
  await closeCross(page);
  for (const name of [/^accept( all)?$/i, /^i agree$/i, /^got it$/i, /^decline optional$/i, /^continue as guest$/i, /^stay logged out$/i, /^maybe later$/i, /^close$/i, /^skip$/i]) {
    try { const b = page.getByRole("button", { name }).first(); if (await b.count()) await b.click({ timeout: 1500 }); } catch {}
  }
  await nukeOverlays(page); // button se na hate (ya bina label ka X ho) to seedha DOM se hatao
}
// Phone par input ke upar fixed overlays aate hain: "Search like never before / better in the app" (X bina label ka),
// cookie banner, login popup, "This session is private". Ye click rok dete hain (log: submit button fail: Timeout exceeded).
// Inhe CSS se chhupa do (DOM se remove() KABHI nahi: React ka node hatane par page "Internal Error" ho jata hai), aur popup ke lagaye pointer-events/inert/scroll-lock bhi khol do. Kabhi error nahi fenkta.
async function nukeOverlays(page) {
  try {
    return await page.evaluate(() => {
      const inputSel = '#ask-input, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"], textarea';
      const bad = /better in the app|open in app|get the app|download the app|cookie|pixels, sdks|sign up|log ?in\b|create (an )?account|continue with (google|apple|email)|this session is private|decline optional|single sign-on/i;
      const vw = window.innerWidth, vh = window.innerHeight;
      let n = 0; const gone = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (!el.isConnected || el.matches("html, body, script, style")) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed") continue;
        if (el.matches(inputSel) || el.querySelector(inputSel)) continue; // composer (input wala) kabhi nahi hatana
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.4 || r.height < 30) continue;
        const txt = (el.innerText || "").trim();
        const full = r.width >= vw * 0.9 && r.height >= vh * 0.9;
        const blocker = !txt && full && cs.zIndex !== "auto" && cs.pointerEvents !== "none"; // khali full-screen parda
        if ((txt && bad.test(txt)) || blocker) { gone.push(el.tagName.toLowerCase() + ":" + (txt || "(khali parda)").replace(/\s+/g, " ").slice(0, 40)); el.style.setProperty("display", "none", "important"); n++; }
      }
      document.body.style.pointerEvents = "";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
      document.body.removeAttribute("data-scroll-locked");
      document.querySelectorAll("[inert]").forEach((e) => e.removeAttribute("inert"));
      document.querySelectorAll('body > [aria-hidden="true"]').forEach((e) => { if (e.querySelector(inputSel)) e.removeAttribute("aria-hidden"); });
      return gone;
    }).then((g) => { if (g && g.length) console.log("pplx: overlay hataye:", g.join(" | ")); return g ? g.length : 0; });
  } catch { return 0; }
}
// sign up / login popup ka cross (X): popup ke andar ka close button turant dabao. Kabhi error nahi fenkta.
const CROSS_SEL = [
  '[role="dialog"] button[aria-label*="close" i]', '[role="dialog"] button[aria-label*="dismiss" i]',
  '[aria-modal="true"] button[aria-label*="close" i]', '[aria-modal="true"] button[aria-label*="dismiss" i]',
  'button[aria-label="Close" i]', 'button[aria-label*="close" i][class*="modal" i]', '[data-testid*="close" i]', '[data-testid*="dismiss" i]',
].join(", ");
// cookie / sign up banner (role=dialog, fixed, input ke upar aa jata hai aur click rok deta hai): button dabao, na hate to DOM se hata do
async function killCookieBanner(page) {
  try {
    const dlg = page.locator('[role="dialog"]');
    if (!(await dlg.count())) return false;
    const btn = dlg.getByRole("button", { name: /accept|agree|allow|reject|decline|necessary|got it|^ok$|close|dismiss|not now|maybe later/i }).first();
    if (await btn.count()) { try { await btn.click({ timeout: 1500 }); } catch {} }
    await page.waitForTimeout(250);
    if (await dlg.count()) {
      await page.evaluate(() => { document.querySelectorAll('[role="dialog"]').forEach((d) => { if (/cookie|pixels|sign up|log ?in|create (an )?account|continue with/i.test(d.innerText || "")) d.style.setProperty("display", "none", "important"); }); });
      return true;
    }
    return true;
  } catch { return false; }
}
async function closeCross(page) {
  for (const name of [/^got it$/i, /^decline optional$/i]) { // cookie banner ka asli button pehle (React khud hata leta hai)
    try { const b = page.getByRole("button", { name }).first(); if (await b.count()) await b.click({ timeout: 800 }); } catch {}
  }
  const killed = await nukeOverlays(page);
  if (await killCookieBanner(page)) return true;
  if (killed) return true;
  try {
    const b = page.locator(CROSS_SEL).first();
    if (await b.count()) { await b.click({ timeout: 800 }); return true; }
  } catch {}
  return false;
}
// Cloudflare "Just a moment..." challenge: kuch der ruko (headed Chrome me aksar khud paas ho jata hai),
// aur turnstile checkbox dikhe to use click karo. True = page aage badh gaya.
async function passChallenge(page, ms = 45000) {
  const isChallenge = async () => {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (/just a moment|attention required|security verification/.test(title)) return true;
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    return /performing security verification|verify you are human|checking your browser/.test(body);
  };
  if (!(await isChallenge())) return true;
  console.log("pplx: cloudflare challenge mila, intezaar...");
  const end = Date.now() + ms;
  let tries = 0, reloads = 0, lastReload = Date.now();
  while (Date.now() < end) {
    await page.waitForTimeout(2000);
    if (!(await isChallenge())) { console.log("pplx: challenge paas"); await page.waitForTimeout(1500); return true; }
    // 3 page ek saath khule hon to koi ek challenge paar kar leta hai aur cf_clearance cookie poore context me aa jati hai:
    // baaki atke pages ko reload karo, wo turant paas ho jate hain (ya 12s se atka ho to bhi ek baar naya challenge)
    try {
      const cleared = (await page.context().cookies()).some((c) => c.name === "cf_clearance");
      if (reloads < 3 && ((cleared && Date.now() - lastReload > 2500) || Date.now() - lastReload > 12000)) {
        reloads++; lastReload = Date.now();
        console.log("pplx: challenge page reload (" + reloads + (cleared ? ", cf_clearance mili" : "") + ")");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        continue;
      }
    } catch {}
    if (tries++ % 2 === 0) { // turnstile iframe ke andar checkbox dabao
      for (const f of page.frames()) {
        if (!/challenges\.cloudflare\.com|turnstile/.test(f.url())) continue;
        try { await f.locator('input[type="checkbox"], label, body').first().click({ timeout: 2000, position: { x: 20, y: 20 } }); } catch {}
      }
    }
  }
  return false;
}
// citation chips (source naam, +N) ko page me hi chhupa do, taaki innerText me aayein hi nahi
async function hideChips(page) {
  try {
    await page.evaluate((sel) => {
      const clean = (e) => (e.textContent || "").replace(/[\u200b-\u200d\u00a0\ufeff]/g, " ").trim();
      for (const r of document.querySelectorAll(sel)) {
        r.querySelectorAll("a, span, div, button").forEach((e) => {
          if (e.children.length > 2) return;
          const t = clean(e);
          if (!t || t.length > 40) return;
          if (/^\+\d+$/.test(t)) { e.style.display = "none"; return; }
          const inLink = e.tagName === "A" || !!e.closest("a");
          if (inLink && /^[a-z0-9][a-z0-9.\-]*(\s*\+\d+)?$/i.test(t)) e.style.display = "none";
        });
      }
    }, SEL.answer);
  } catch {}
}
// page kya dikha raha hai - error message me jata hai (API ke 502 me bhi dikhega)
async function pageInfo(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  const n = await page.evaluate(() => ({ ce: document.querySelectorAll('[contenteditable]').length, ta: document.querySelectorAll('textarea').length, inp: document.querySelectorAll('input').length })).catch(() => ({}));
  return `url=${page.url()} | title=${title} | ce=${n.ce} ta=${n.ta} input=${n.inp} | body: ${body}`;
}

// page abhi kya dikha raha hai: title, sabse upar ka text, aur screen ke upar/beech/neeche (x-center) pe sabse upar kaun sa element hai + fixed overlays
async function topLog(page, tag) {
  try {
    const i = await page.evaluate(() => {
      const d = (el) => el ? el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "") + ":" + (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50) : "-";
      const vw = innerWidth, vh = innerHeight;
      const pts = [[vw / 2, 8], [vw / 2, vh * 0.3], [vw / 2, vh * 0.6], [vw / 2, vh - 8]];
      const fixed = Array.from(document.querySelectorAll("body *")).filter((e) => getComputedStyle(e).position === "fixed" && e.getBoundingClientRect().width > vw * 0.4).slice(0, 4).map(d);
      return { top: pts.map(([x, y]) => d(document.elementFromPoint(x, y))), fixed, text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160) };
    });
    const title = await page.title().catch(() => "");
    console.log("pplx top [" + tag + "]: title=" + title + " | text: " + i.text + " | upar/30%/60%/neeche: " + i.top.join(" || ") + " | fixed: " + (i.fixed.join(" || ") || "-"));
  } catch {}
}
// prompt box me text gaya ya nahi (Lexical editor kabhi insertText nahi pakadta)
async function boxText(page, box) {
  try { return ((await box.innerText({ timeout: 1500 }).catch(() => "")) || (await box.inputValue({ timeout: 1500 }).catch(() => "")) || "").trim(); } catch { return ""; }
}
// send button dabao: pehle aria-label wala (force), phir composer ka aakhri enabled button (mic ke baad wala arrow), phir Enter
async function trySubmit(page, box) {
  await nukeOverlays(page);
  const sels = 'button[aria-label*="submit" i], button[aria-label*="send" i], button[type="submit"]';
  try {
    const sb = page.locator(sels).first();
    if (await sb.count()) { await sb.click({ timeout: 2000, force: true }); return "button"; }
  } catch (e) { console.log("pplx: submit button fail:", String((e && e.message) || e).split("\n")[0].slice(0, 100)); }
  try {
    const ok = await page.evaluate(() => {
      const ed = document.querySelector('#ask-input, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"], textarea');
      if (!ed) return false;
      let el = ed;
      for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
        const btns = Array.from(el.querySelectorAll("button")).filter((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true" && b.offsetParent !== null);
        if (btns.length >= 2) { btns[btns.length - 1].click(); return true; }
      }
      return false;
    });
    if (ok) return "dom-last-button";
  } catch {}
  try { await box.press("Enter", { timeout: 1500 }); return "enter-again"; } catch {}
  return "";
}

class PplxError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- playwright load (lazy) ---------------------------------------------------

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
  if (parts.length === 1 && parts[0].role === "Human") return parts[0].t;
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message. " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

// ---- SSE parse: perplexity ke events se final answer nikalo (tolerant) ---------
function answerFromEvent(o) {
  let best = "";
  const take = (s) => { if (typeof s === "string" && s.trim().length >= best.length) best = s; };
  try {
    for (const b of Array.isArray(o.blocks) ? o.blocks : []) {
      take(b?.markdown_block?.answer);
      if (Array.isArray(b?.markdown_block?.chunks)) take(b.markdown_block.chunks.join(""));
    }
    if (typeof o.answer === "string") take(o.answer);
    // purana format: text = JSON string of steps, FINAL step me answer
    if (typeof o.text === "string" && o.text.startsWith("[")) {
      const steps = JSON.parse(o.text);
      const fin = steps.find((s) => s && s.step_type === "FINAL");
      if (fin?.content?.answer) {
        const a = typeof fin.content.answer === "string" ? fin.content.answer : "";
        try { take(JSON.parse(a).answer); } catch { take(a); }
      }
    }
  } catch {}
  return best;
}
function answerFromSSE(raw) {
  let best = "";
  for (let line of String(raw || "").split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line.startsWith("{")) continue;
    try { const a = answerFromEvent(JSON.parse(line)); if (a.length >= best.length) best = a; } catch {}
  }
  return best;
}

// DOM se text lene par citation chips (britannica, +1, worldometers...) saath aa jate hain - unhe hatao.
// Sirf akele source-jaise lines hatate hain; kuch bacha hi na to original wapas.
function cleanDom(t) {
  const lines = String(t || "").split(/\r?\n/);
  const isChip = (l) => {
    const x = l.replace(/[\u200b-\u200d\u00a0\ufeff]/g, " ").trim();
    if (/^\+\d+$/.test(x)) return true;
    const y = x.replace(/\s*\+\d+$/, ""); // "cardekho +1" ek hi line me
    return y.length > 0 && y.length <= 40 && /^[a-z0-9][a-z0-9.\-]*$/.test(y) && !/^\d+$/.test(y);
  };
  const kept = lines.filter((l) => !isChip(l));
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out && kept.length < lines.length && kept.some((l) => /\s/.test(l.trim())) ? out : String(t || "").trim();
}

// Perplexity guest limit / login wall ("Sign up and repeat your request.") jawab nahi, error hai
function isWall(t) {
  const x = String(t || "").trim();
  return x.length > 0 && x.length < 300 && /sign up|log ?in\b|create (an )?account|continue with (google|apple|email)|repeat your request|upgrade to/i.test(x);
}

function completion(model, text) {
  return JSON.stringify({
    id: "chatcmpl-pplx-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export class PplxClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.pool = new WarmPool({ size: WARM_POOL, ttlMs: WARM_MAX_MS, label: "pplx", open: async () => { await this.ensure(); return this.open(45000); } });
  }

  async ensure() {
    if (this.ctx) return;
    if (!this.starting) this.starting = (async () => {
      const chromium = await loadChromium();
      const headless = process.env.DUCK_HEADED !== "1";
      const launch = { headless, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] };
      const exe = chromePath();
      if (exe) launch.executablePath = exe; else launch.channel = "chrome";
      this.browser = await chromium.launch(launch);
      const ver = this.browser.version();
      const ua = process.env.PPLX_UA ||
        `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
      // Perplexity sirf phone (Android Chrome) jaisa chalta hai, desktop nahi.
      const mobileUA = process.env.PPLX_UA ||
        `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36`;
      this.ctx = await this.browser.newContext({ userAgent: mobileUA, locale: "en-US", viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
      await this.ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} try { Object.defineProperty(navigator, "platform", { get: () => "Linux armv8l" }); } catch {} }); // UA Android hai to platform bhi Linux x86_64 na dikhe (Cloudflare mismatch pakadta hai)
      console.log("pplx: chrome ready", ver, headless ? "(headless)" : "(headed)");
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  async slot() { if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r)); this.active++; }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); }

  async debug(page, tag) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const f = `${DEBUG_DIR}/${Date.now()}-pplx-${tag}`;
      await page.screenshot({ path: f + ".png" }).catch(() => {});
      const info = { url: page.url(), title: await page.title().catch(() => ""), text: (await page.innerText("body").catch(() => "")).slice(0, 1500) };
      fs.writeFileSync(f + ".json", JSON.stringify(info, null, 1));
      console.log("pplx debug:", f, info.url, info.title);
    } catch {}
  }

  // naya page kholo, challenge paar karo, input box tak pahuncho. Fail hone par saaf error.
  async open(budgetMs = 60000) {
    const page = await this.ctx.newPage();
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: Math.min(20000, budgetMs) });
      await passChallenge(page);
      await dismissPopups(page);
      const box = page.locator(SEL.input).first();
      try { await box.waitFor({ state: "visible", timeout: 10000 }); }
      catch {
        await dismissPopups(page); // ek aur koshish
        try { await box.waitFor({ state: "visible", timeout: 4000 }); }
        catch {
          const info = await pageInfo(page);
          console.log("pplx no-input:", info);
          await this.debug(page, "no-input");
          const low = info.toLowerCase();
          if (/verify you are human|just a moment|captcha|security verification|checking your browser|cloudflare/.test(low))
            throw new PplxError("perplexity.ai bot check (headless block?) DUCK_HEADED=1 try karo | " + info.slice(0, 380), "challenge");
          throw new PplxError("perplexity.ai input box nahi mila | " + info.slice(0, 380), "error");
        }
      }
      return { page, box, t: Date.now() };
    } catch (e) { try { await page.close(); } catch {} throw e; }
  }

  // messages (OpenAI style) -> OpenAI chat.completion JSON string
  async chat({ model, messages }, timeoutMs = 100000) {
    const prompt = flatten(messages).slice(-MAX_PROMPT);
    if (!prompt.trim()) throw new PplxError("empty prompt", "bad_request");
    await this.ensure();
    await this.slot();
    const deadline = Date.now() + timeoutMs;
    let h = null;
    try {
      // pool me tayyar page ho to wahi (pool khud naya bharta hai), warna naya kholo
      if (WARM_ON) h = await this.pool.take();
      if (!h) h = await this.open(Math.min(60000, timeoutMs));
      // input box dikh raha hai? na dikhe to popup hatao; phir bhi na dikhe to purana page chhodo aur naya kholo (warm page kharab ho sakta hai)
      const visible = async (b) => { try { await b.waitFor({ state: "visible", timeout: 3000 }); return true; } catch { return false; } };
      await topLog(h.page, "page-mila");
      await closeCross(h.page);
      await topLog(h.page, "popup-hatane-ke-baad");
      if (!(await visible(h.box))) {
        console.log("pplx: warm page me input nahi dikha:", (await pageInfo(h.page).catch(() => "")).slice(0, 300));
        await this.debug(h.page, "nobox");
        await dismissPopups(h.page);
        if (!(await visible(h.box))) {
          try { await h.page.close(); } catch {}
          h = null; h = await this.open(Math.max(20000, Math.min(60000, deadline - Date.now())));
        }
      }
      const { page, box } = h;

      let sse = "";
      page.on("response", async (r) => {
        try { if (/perplexity_ask/.test(r.url()) && r.request().method() === "POST") sse = await r.text(); } catch {}
      });
      await closeCross(page); // popup ka cross pehle hata do, warna input dhak sakta hai
      await nukeOverlays(page);
      try { await box.click({ timeout: 6000 }); }
      catch { // koi banner click rok raha ho to hatao, phir force se
        await killCookieBanner(page);
        try { await box.click({ timeout: 4000, force: true }); }
        catch { try { await box.focus({ timeout: 3000 }); } catch { throw new PplxError("perplexity.ai input box click/focus nahi hua | " + (await pageInfo(page).catch(() => "")).slice(0, 400), "error"); } }
      }
      // lamba prompt: type() dheema hota hai, isliye insertText (paste jaisa)
      await page.keyboard.insertText(prompt);
      if (!(await boxText(page, box))) { // insertText box me nahi gaya: asli key events se daalo
        console.log("pplx: insertText se box khali raha, keyboard.type se daal raha hu");
        try { await box.click({ timeout: 3000, force: true }); } catch {}
        await page.keyboard.type(prompt.slice(0, 3000), { delay: 0 });
      }
      await nukeOverlays(page); // typing ke dauran koi popup/banner aa gaya ho
      await topLog(page, "type-ke-baad");
      await page.keyboard.press("Enter");
      // phone layout me Enter kabhi sirf nayi line banata hai: 1.5s me kuch shuru na ho to submit button dabao
      await page.waitForTimeout(1500);
      if (!sse && !(await page.locator(SEL.answer).count().catch(() => 0)) && !(await page.locator(SEL.stop).count().catch(() => 0))) {
        const how = await trySubmit(page, box);
        console.log(how ? "pplx: Enter se nahi gaya, submit dabaya (" + how + ")" : "pplx: Enter se nahi gaya aur submit bhi nahi hua");
      }

      await topLog(page, "submit-ke-baad");
      // jawab aane tak ruko: SSE mile ya DOM me text thehar jaye
      let last = "", stable = 0, started = false, tick = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(350);
        const net = answerFromSSE(sse);
        if (net && sse) { console.log("pplx: jawab SSE se (saaf)"); await this.guard(net, page); return completion(model || DEFAULT_MODEL, net.trim()); } // SSE poora aate hi turant
        if (!last && tick > 0 && tick % 15 === 0) await topLog(page, "intezaar-" + Math.round(tick * 0.35) + "s"); // ~5s me ek baar
        if (++tick % 4 === 0) await closeCross(page); // sign up popup beech me aaye to uska cross turant dabao
        if (tick % 8 === 0 && !last) { // "Internal Error ... Return home" page: 100s ruk ke kya fayda, jaldi error do
          const bt = await page.innerText("body").catch(() => "");
          if (/internal error|something went wrong|return home/i.test(bt)) { console.log("pplx: internal error page mila, jaldi fail"); break; }
        }
        await hideChips(page);
        const els = page.locator(SEL.answer);
        const n = await els.count().catch(() => 0);
        const txt = n ? (await els.nth(n - 1).innerText().catch(() => "")).trim() : "";
        if (txt) started = true;
        const generating = (await page.locator(SEL.stop).count().catch(() => 0)) > 0;
        if (txt && txt === last && !generating) { if (++stable >= 4) { console.log("pplx: jawab DOM se; sse mila:", sse ? "haan, parse khali (" + sse.slice(0, 160).replace(/\s+/g, " ") + ")" : "nahi"); await this.guard(txt, page); return completion(model || DEFAULT_MODEL, cleanDom(txt)); } } // ~1.4s same text
        else stable = 0;
        last = txt;
      }
      await topLog(page, started ? "partial" : "timeout");
      await this.debug(page, started ? "partial" : "timeout");
      if (last) { await this.guard(last, page); return completion(model || DEFAULT_MODEL, cleanDom(last)); } // adhura hi sahi
      const info = await pageInfo(page).catch(() => "");
      const sseHead = sse ? " [" + sse.slice(0, 200).replace(/\s+/g, " ") + "]" : "";
      console.log("pplx timeout: sse=" + (sse ? sse.length + " bytes" : "nahi") + sseHead + " | " + info);
      throw new PplxError("perplexity.ai timeout | sse=" + (sse ? sse.length + "B" + sseHead : "nahi") + " | " + info.slice(0, 450), "timeout");
    } finally {
      try { await h?.page?.close(); } catch {}
      this.free();
    }
  }

  // login wall / guest limit mila to error do (jawab bana ke mat bhejo) aur session reset karo
  async guard(text, page) {
    if (!isWall(text)) return;
    console.log("pplx: guest limit / login wall:", String(text).trim().slice(0, 120));
    await this.debug(page, "wall");
    try { await this.ctx.clearCookies(); } catch {} // naya anonymous session agli baar
    this.pool.flush(); // purani session wale warm pages hatao
    throw new PplxError("perplexity.ai guest limit (login/sign up maang raha hai). Thodi der baad try karo", "ratelimit");
  }

  warmReady(ms) { return WARM_ON ? this.pool.settled(ms) : Promise.resolve(); }

  async warmup() { try { await this.ensure(); if (WARM_ON) this.pool.start(); } catch (e) { console.log("pplx warmup fail:", e.message); } }

  async close() {
    try { await this.pool.closeAll(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = null; this.ctx = null; this.starting = null;
  }
}

// ---- akele chalao: node perplexity.js "prompt" ----------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PONG";
  const c = new PplxClient();
  try {
    const t0 = Date.now();
    const r = JSON.parse(await c.chat({ model: "pplx-auto", messages: [{ role: "user", content: prompt }] }, 100000));
    console.log("\n=== PPLX OK in", Date.now() - t0, "ms ===\n" + r.choices[0].message.content);
    await c.close();
    process.exit(0);
  } catch (e) {
    console.log("\n=== PPLX FAIL ===", e.kind || "", e.message);
    await c.close();
    process.exit(1);
  }
}
