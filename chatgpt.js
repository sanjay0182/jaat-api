// chatgpt.js - chatgpt.com provider (real Chrome, bina login / guest mode). Sirf BASIC chat.
// Koi tools / streaming / session-reuse / image nahi. perplexity.js jaisa pattern:
// chrome kholo -> prompt textbox me daalo -> Enter -> jawab padho.
//
// Chhoti baatein jo handle hoti hain:
//   - Cloudflare "Just a moment" challenge  -> intezaar, na ho to kind="challenge" (worker 403 deta hai)
//   - cookie / "Stay logged out" / login popup -> band karta hai
//   - guest limit / login wall / HTTP 429   -> kind="ratelimit" (worker 429 + retry-after deta hai), session reset
//   - jawab na aaye                         -> kind="timeout" (504)
//
// NOTE: ye live test nahi hua. ChatGPT ka page badalta rehta hai, isliye selectors ek jagah (SEL) hain.
// Fail hone par debug/ folder me screenshot + text milta hai.
// GitHub runner (datacenter IP) ko ChatGPT block kar sakta hai - pehle chatgpt-test workflow chalao.
//
// Sirf runner.js import karta hai. Akele test ke liye:
//   node chatgpt.js "hello"        (DUCK_HEADED=1 ho to xvfb-run ke saath)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = process.env.CGPT_BASE || "https://chatgpt.com";
export const DEFAULT_MODEL = "chatgpt-guest";
const MAX_PAGES = Number(process.env.CGPT_MAX_PAGES || 1); // guest ko ek waqt me ek hi conversation milti hai
const MAX_PROMPT = Number(process.env.CGPT_MAX_PROMPT || 12000);
const WARM_MAX_MS = Number(process.env.CGPT_WARM_MAX_MS || 120000); // garam page ki umar
const PREWARM = process.env.CGPT_PREWARM === "1"; // default band: guest ko ek waqt me ek hi chat, doosra page "Clear current chat?" dikhata hai
const FRESH = process.env.CGPT_FRESH !== "0"; // har request ka apna naya browser session (chats takrate nahi)
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// page ke selectors - chatgpt badle to sirf yahan theek karo
const SEL = {
  input: '#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea',
  send: 'button[data-testid="send-button"], button[aria-label*="Send" i]',
  user: '[data-message-author-role="user"]',
  answer: '[data-message-author-role="assistant"]',
  stop: 'button[data-testid="stop-button"], button[aria-label*="Stop" i]',
  dialog: '[role="dialog"]',
};

// Generic popup band karne wala: kisi bhi dialog/banner ka X (cross), "Continue on web", "Stay logged out",
// "Not now" jaise buttons dabata hai. "Log in" / "Sign up" / "Clear chat" kabhi nahi dabta.
// Page ka design badle tab bhi kaam kare, isliye naam-par-bharosa kam, X-button par zyada.
async function closeOverlays(page) {
  try {
    return await page.evaluate(() => {
      const txt = (e) => ((e.innerText || "") || e.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const OK = /^(stay logged out|stay signed out|continue (on|with|in) (the )?(web|browser)( instead)?|use (the )?web( version)?|not now|no,? thanks|maybe later|got it|okay,? let'?s go|dismiss|skip|reject (all|non-essential)|accept( all)?)$/i;
      const BAD = /log ?in|sign ?up|clear chat|create account|continue with (google|apple|microsoft|phone|email)/i;
      const cands = [...document.querySelectorAll("button, a, [role=button]")].filter((e) => e.offsetParent !== null);
      for (const e of cands) { const t = txt(e); if (t && !BAD.test(t) && OK.test(t)) { e.click(); return "text:" + t; } }
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        const x = [...dlg.querySelectorAll('button, [role=button]')].find((e) => /close|dismiss|cancel/i.test((e.getAttribute("aria-label") || "") + " " + (e.getAttribute("data-testid") || "")));
        if (x) { x.click(); return "x"; }
        const ic = [...dlg.querySelectorAll("button")].find((e) => !txt(e) && e.querySelector("svg") && !BAD.test(e.getAttribute("aria-label") || ""));
        if (ic) { ic.click(); return "icon"; }
      }
      return "";
    });
  } catch { return ""; }
}
async function dismissPopups(page) {
  try { await page.keyboard.press("Escape"); } catch {}
  for (let i = 0; i < 3; i++) { // ek ke baad doosra popup bhi aa sakta hai
    const r = await closeOverlays(page);
    if (!r) break;
    console.log("cgpt: popup band:", r);
    await page.waitForTimeout(400);
  }
}
// Cloudflare "Just a moment..." challenge: kuch der ruko (headed Chrome me aksar khud paas ho jata hai),
// aur turnstile checkbox dikhe to use click karo. True = page aage badh gaya.
async function passChallenge(page, ms = 22000) {
  const isChallenge = async () => {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (/just a moment|attention required|security verification/.test(title)) return true;
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    return /performing security verification|verify you are human|checking your browser|checking if the site connection is secure/.test(body);
  };
  if (!(await isChallenge())) return true;
  console.log("cgpt: cloudflare challenge mila, intezaar...");
  const end = Date.now() + ms;
  let tries = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(2000);
    if (!(await isChallenge())) { console.log("cgpt: challenge paas"); await page.waitForTimeout(1500); return true; }
    if (tries++ % 2 === 0) { // turnstile iframe ke andar checkbox dabao
      for (const f of page.frames()) {
        if (!/challenges\.cloudflare\.com|turnstile/.test(f.url())) continue;
        try { await f.locator('input[type="checkbox"], label, body').first().click({ timeout: 2000, position: { x: 20, y: 20 } }); } catch {}
      }
    }
  }
  return false;
}
// page kya dikha raha hai - error message me jata hai (API ke 502 me bhi dikhega)
async function pageInfo(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  const n = await page.evaluate(() => ({ ce: document.querySelectorAll('[contenteditable]').length, ta: document.querySelectorAll('textarea').length, inp: document.querySelectorAll('input').length })).catch(() => ({}));
  return `url=${page.url()} | title=${title} | ce=${n.ce} ta=${n.ta} input=${n.inp} | body: ${body}`;
}

class CgptError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- playwright load (lazy) ---------------------------------------------------
async function loadPlaywright() {
  for (let i = 0; i < 15; i++) {
    try { return await import("playwright-core"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("cgpt: playwright-core install ho raha hai...");
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
  if (parts.length === 1 && parts[0].role === "Human") return parts[0].t;
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message. " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

// guest limit / login wall jawab nahi, error hai (chhota text + limit/login jaise shabd)
function isWall(t) {
  const x = String(t || "").trim();
  return x.length > 0 && x.length < 400 && /reached (our|the|your) (limit|cap)|hit (the|your) (free )?(plan )?limit|too many (requests|messages)|rate limit|log ?in or sign ?up|sign ?up to continue|create (a free )?account|try again later|come back (later|tomorrow)|limit (of|for) messages|usage limit/i.test(x);
}
// ChatGPT ka apna error text (jawab nahi) - 502
function isPageError(t) {
  const x = String(t || "").trim();
  return x.length > 0 && x.length < 200 && /^(something went wrong|an error occurred|network error|error in message stream|unusual activity)/i.test(x);
}

function completion(model, text) {
  return JSON.stringify({
    id: "chatcmpl-cgpt-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export class CgptClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.warm = null; // pehle se tayyar page (promise)
  }

  async ensure() {
    if (this.browser) return;
    if (!this.starting) this.starting = (async () => {
      const { chromium } = await loadPlaywright();
      const headless = process.env.DUCK_HEADED !== "1";
      const launch = { headless, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] };
      const exe = chromePath();
      if (exe) launch.executablePath = exe; else launch.channel = "chrome";
      this.browser = await chromium.launch(launch);
      const ver = this.browser.version();
      this.ua = process.env.CGPT_UA ||
        `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
      console.log("cgpt: chrome ready", ver, headless ? "(headless)" : "(headed)", FRESH ? "fresh-session" : "shared-session");
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  // FRESH: har page ka naya context (alag cookies/storage). Warna ek shared context.
  async newCtx() {
    const ctx = await this.browser.newContext({ userAgent: this.ua, locale: "en-US", viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
    return ctx;
  }
  async getCtx() {
    if (FRESH) return await this.newCtx();
    if (!this.ctx) this.ctx = await this.newCtx();
    return this.ctx;
  }

  async slot() { if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r)); this.active++; }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); }

  async debug(page, tag) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const f = `${DEBUG_DIR}/${Date.now()}-cgpt-${tag}`;
      await page.screenshot({ path: f + ".png" }).catch(() => {});
      const info = { url: page.url(), title: await page.title().catch(() => ""), text: (await page.innerText("body").catch(() => "")).slice(0, 1500) };
      fs.writeFileSync(f + ".json", JSON.stringify(info, null, 1));
      console.log("cgpt debug:", f, info.url, info.title);
    } catch {}
  }

  // naya page kholo, challenge paar karo, popups hatao, input box tak pahuncho. Fail hone par saaf error.
  async open(budgetMs = 60000) {
    const ctx = await this.getCtx();
    const page = await ctx.newPage();
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: Math.min(25000, budgetMs) });
      await passChallenge(page);
      await dismissPopups(page);
      const box = page.locator(SEL.input).first();
      try { await box.waitFor({ state: "visible", timeout: 10000 }); }
      catch {
        await dismissPopups(page); // ek aur koshish
        try { await box.waitFor({ state: "visible", timeout: 4000 }); }
        catch {
          const info = await pageInfo(page);
          console.log("cgpt no-input:", info);
          await this.debug(page, "no-input");
          const low = info.toLowerCase();
          if (/verify you are human|just a moment|captcha|security verification|checking your browser|cloudflare|access denied|unusual activity|blocked/.test(low))
            throw new CgptError("chatgpt.com bot check / IP block (runner IP ya headless block?) DUCK_HEADED=1 try karo | " + info.slice(0, 380), "challenge");
          if (/log ?in|sign ?up|welcome back/.test(low) && !/message chatgpt|ask anything/.test(low))
            throw new CgptError("chatgpt.com guest mode nahi mila, login maang raha hai (is IP/country me guest band ho sakta hai) | " + info.slice(0, 380), "ratelimit");
          throw new CgptError("chatgpt.com input box nahi mila | " + info.slice(0, 380), "error");
        }
      }
      return { page, box, ctx, t: Date.now() };
    } catch (e) { try { await page.close(); } catch {} if (FRESH) { try { await ctx.close(); } catch {} } throw e; }
  }

  // agli request ke liye ek page pehle se garam rakho (background me)
  prewarm() {
    if (!PREWARM || FRESH || this.warm || !this.browser) return;
    this.warm = this.open(45000).catch((e) => { console.log("cgpt prewarm fail:", e.message.slice(0, 120)); return null; });
  }

  // session reset: shared ho to cookies saaf + garam page band (FRESH me har request naya session hai)
  async reset() {
    try { if (this.ctx) await this.ctx.clearCookies(); } catch {}
    try { const w = this.warm ? await this.warm : null; this.warm = null; await w?.page?.close(); } catch {}
  }

  // error ke saath debug + session reset, phir throw
  async fail(page, tag, msg, kind) {
    console.log("cgpt:", kind, msg.slice(0, 140));
    await this.debug(page, tag);
    await this.reset();
    throw new CgptError(msg, kind);
  }

  // network status: conversation POST par 429 = limit, 403 = block/sentinel, 401 = login wall
  async checkNet(net, page) {
    if (net.status === 429) await this.fail(page, "429", "chatgpt.com guest limit / too many requests (429). Thodi der baad try karo", "ratelimit");
    if (net.status === 401) await this.fail(page, "401", "chatgpt.com login maang raha hai (guest limit). Thodi der baad try karo", "ratelimit");
    if (net.status === 403) await this.fail(page, "403", "chatgpt.com ne request roki (Cloudflare/sentinel, shayad runner IP block). DUCK_HEADED=1 try karo", "challenge");
  }

  // beech me popup/dialog: cookie / "stay logged out" hatao; limit = ratelimit;
  // login dialog 8 sec tak band na ho to ratelimit (error me dialog ka text bhi)
  async checkDialog(page, st) {
    const d = page.locator(SEL.dialog).first();
    if (!(await d.count().catch(() => 0))) { st.seen = 0; return; }
    const t = (await d.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
    if (!t) return;
    if (/limit|too many|reached|come back|try again later/i.test(t) && !/cookie/i.test(t))
      await this.fail(page, "limit", "chatgpt.com guest limit: " + t.slice(0, 160), "ratelimit");
    if (/clear current chat/i.test(t)) { // guest warning: sirf Escape. "Clear chat" / "Log in" kabhi mat dabao
      try { await page.keyboard.press("Escape"); } catch {}
      await closeOverlays(page);
      if (!st.seen) st.seen = Date.now();
      if (Date.now() - st.seen > 8000)
        await this.fail(page, "clearchat", "chatgpt.com 'Clear current chat?' dialog band nahi hua | dialog: " + t.slice(0, 200), "ratelimit");
      return;
    }
    await dismissPopups(page);
    try { await page.locator('a:has-text("Stay logged out"), button:has-text("Stay logged out"), [role="dialog"] button[aria-label*="Close" i]').first().click({ timeout: 1500 }); } catch {}
    if (/log ?in|sign ?up/i.test(t) && !/cookie/i.test(t)) {
      if (!st.seen) st.seen = Date.now();
      if (Date.now() - st.seen > 8000)
        await this.fail(page, "loginwall", "chatgpt.com login dialog band nahi hua | dialog: " + t.slice(0, 200), "ratelimit");
    }
  }

  // messages (OpenAI style) -> OpenAI chat.completion JSON string
  async chat({ model, messages }, timeoutMs = 100000) {
    const prompt = flatten(messages).slice(-MAX_PROMPT);
    if (!prompt.trim()) throw new CgptError("empty prompt", "bad_request");
    await this.ensure();
    await this.slot();
    const deadline = Date.now() + timeoutMs;
    let h = null;
    try {
      // garam page ho (aur 2 min se purana na ho) to wahi, warna naya
      if (this.warm) { const w = await this.warm; this.warm = null; if (w && Date.now() - w.t < WARM_MAX_MS) h = w; else if (w) { try { await w.page.close(); } catch {} } }
      if (!h) h = await this.open(Math.min(60000, timeoutMs));
      const { page, box } = h;
      this.prewarm(); // agli request ke liye abhi se tayyari (is page se alag)

      const net = { status: 0 };
      page.on("response", (r) => {
        try {
          if (r.request().method() !== "POST") return;
          const p = new URL(r.url()).pathname;
          if (/\/backend-(anon|api)\/(f\/)?conversation$/.test(p)) net.status = r.status();
        } catch {}
      });
      await dismissPopups(page);
      await box.click();
      // lamba prompt: type() dheema hota hai, isliye insertText (paste jaisa)
      await page.keyboard.insertText(prompt);
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      // Enter se message na gaya ho (user bubble nahi dikha) to send button dabao
      await page.waitForTimeout(1500);
      if (!(await page.locator(SEL.user).count().catch(() => 0)) && !net.status) {
        try { await page.locator(SEL.send).first().click({ timeout: 3000 }); } catch {}
      }

      // jawab aane tak ruko: DOM me text thehar jaye
      const st = { seen: 0 };
      let last = "", stable = 0, started = false, tick = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(350);
        await this.checkNet(net, page);
        if (!started || tick % 6 === 0) await this.checkDialog(page, st);
        if (tick++ % 6 === 3) { const r = await closeOverlays(page); if (r) console.log("cgpt: popup band:", r); }
        const els = page.locator(SEL.answer);
        const n = await els.count().catch(() => 0);
        const txt = n ? (await els.nth(n - 1).innerText().catch(() => "")).trim() : "";
        if (txt) started = true;
        const generating = (await page.locator(SEL.stop).count().catch(() => 0)) > 0;
        if (txt && txt === last && !generating) {
          if (++stable >= 4) { await this.guard(txt, page); return completion(model || DEFAULT_MODEL, txt); } // ~1.4s same text
        } else stable = 0;
        last = txt;
      }
      await this.debug(page, started ? "partial" : "timeout");
      if (last) { await this.guard(last, page); return completion(model || DEFAULT_MODEL, last); } // adhura hi sahi
      throw new CgptError("chatgpt.com timeout", "timeout");
    } finally {
      try { await h?.page?.close(); } catch {}
      if (FRESH) { try { await h?.ctx?.close(); } catch {} }
      this.free();
    }
  }

  // limit / login wall / page error text mila to error do (jawab bana ke mat bhejo)
  async guard(text, page) {
    if (isWall(text)) await this.fail(page, "wall", "chatgpt.com guest limit (login/sign up maang raha hai). Thodi der baad try karo", "ratelimit");
    if (isPageError(text)) await this.fail(page, "pageerr", "chatgpt.com error: " + String(text).trim().slice(0, 120), "error");
  }

  async warmup() { try { await this.ensure(); } catch (e) { console.log("cgpt warmup fail:", e.message); } }

  async close() {
    try { const w = this.warm ? await this.warm : null; this.warm = null; await w?.page?.close(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = null; this.ctx = null; this.starting = null;
  }
}

// ---- akele chalao: node chatgpt.js "prompt" -------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PONG";
  const c = new CgptClient();
  try {
    const t0 = Date.now();
    const r = JSON.parse(await c.chat({ model: "chatgpt-guest", messages: [{ role: "user", content: prompt }] }, 100000));
    console.log("\n=== CGPT OK in", Date.now() - t0, "ms ===\n" + r.choices[0].message.content);
    await c.close();
    process.exit(0);
  } catch (e) {
    console.log("\n=== CGPT FAIL ===", e.kind || "", e.message);
    await c.close();
    process.exit(1);
  }
}
