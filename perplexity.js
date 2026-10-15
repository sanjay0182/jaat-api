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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = process.env.PPLX_BASE || "https://www.perplexity.ai";
export const DEFAULT_MODEL = "pplx-auto";
const MAX_PAGES = Number(process.env.PPLX_MAX_PAGES || 2); // ek saath kitne chat
const MAX_PROMPT = Number(process.env.PPLX_MAX_PROMPT || 12000);
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
  for (const name of [/^accept( all)?$/i, /^i agree$/i, /^got it$/i, /^continue as guest$/i, /^stay logged out$/i, /^maybe later$/i, /^close$/i, /^skip$/i]) {
    try { const b = page.getByRole("button", { name }).first(); if (await b.count()) await b.click({ timeout: 1500 }); } catch {}
  }
}
// Cloudflare "Just a moment..." challenge: kuch der ruko (headed Chrome me aksar khud paas ho jata hai),
// aur turnstile checkbox dikhe to use click karo. True = page aage badh gaya.
async function passChallenge(page, ms = 35000) {
  const isChallenge = async () => {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (/just a moment|attention required|security verification/.test(title)) return true;
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    return /performing security verification|verify you are human|checking your browser/.test(body);
  };
  if (!(await isChallenge())) return true;
  console.log("pplx: cloudflare challenge mila, intezaar...");
  const end = Date.now() + ms;
  let tries = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(2000);
    if (!(await isChallenge())) { console.log("pplx: challenge paas"); await page.waitForTimeout(1500); return true; }
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

class PplxError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- playwright load (lazy) ---------------------------------------------------
async function loadPlaywright() {
  for (let i = 0; i < 15; i++) {
    try { return await import("playwright-core"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("pplx: playwright-core install ho raha hai...");
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
      const ua = process.env.PPLX_UA ||
        `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
      this.ctx = await this.browser.newContext({ userAgent: ua, locale: "en-US", viewport: { width: 1280, height: 800 } });
      await this.ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} });
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

  // messages (OpenAI style) -> OpenAI chat.completion JSON string
  async chat({ model, messages }, timeoutMs = 100000) {
    const prompt = flatten(messages).slice(-MAX_PROMPT);
    if (!prompt.trim()) throw new PplxError("empty prompt", "bad_request");
    await this.ensure();
    await this.slot();
    const deadline = Date.now() + timeoutMs;
    let page;
    try {
      page = await this.ctx.newPage();
      let sse = "";
      page.on("response", async (r) => {
        try { if (/perplexity_ask/.test(r.url()) && r.request().method() === "POST") sse = await r.text(); } catch {}
      });
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: Math.min(30000, timeoutMs) });

      await page.waitForTimeout(2500);
      await passChallenge(page);
      await dismissPopups(page);
      const box = page.locator(SEL.input).first();
      try { await box.waitFor({ state: "visible", timeout: 25000 }); }
      catch {
        await dismissPopups(page); // ek aur koshish
        try { await box.waitFor({ state: "visible", timeout: 8000 }); }
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
      await box.click();
      // lamba prompt: type() dheema hota hai, isliye insertText (paste jaisa)
      await page.keyboard.insertText(prompt);
      await page.keyboard.press("Enter");

      // jawab aane tak ruko: SSE mile ya DOM me text thehar jaye
      let last = "", stable = 0, started = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const net = answerFromSSE(sse);
        if (net && sse) {
          // SSE poora (response() sirf poora body hone par fire hota hai)
          return completion(model || DEFAULT_MODEL, net.trim());
        }
        const els = page.locator(SEL.answer);
        const n = await els.count().catch(() => 0);
        const txt = n ? (await els.nth(n - 1).innerText().catch(() => "")).trim() : "";
        if (txt) started = true;
        const generating = (await page.locator(SEL.stop).count().catch(() => 0)) > 0;
        if (txt && txt === last && !generating) { if (++stable >= 3) return completion(model || DEFAULT_MODEL, txt); }
        else stable = 0;
        last = txt;
      }
      await this.debug(page, started ? "partial" : "timeout");
      if (last) return completion(model || DEFAULT_MODEL, last); // adhura hi sahi
      throw new PplxError("perplexity.ai timeout", "timeout");
    } finally {
      try { await page?.close(); } catch {}
      this.free();
    }
  }

  async warmup() { try { await this.ensure(); } catch (e) { console.log("pplx warmup fail:", e.message); } }

  async close() {
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
