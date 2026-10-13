// duck.js - duck.ai provider (real Chrome + app ka apna send-logic)
//
// KYUN aisa: duck.ai ne 2026 me protocol badal diya (x-vqd-4 band, ab x-vqd-hash-1 +
// x-fe-signals, jo sirf page ka apna JS banata hai). Seedha fetch() karne par ERR_CHALLENGE
// aata hai. Isliye hum real Chrome (GitHub runner par pehle se installed) me duck.ai page
// kholte hain, textarea me prompt daal ke Send dabate hain, aur /duckchat/v1/chat ka
// SSE response tee karke token-by-token padhte hain.
//
// Approach duckapi (hirotomasato/duckapi, MIT) ke research par based hai.
//
// Sirf runner.js isse import karta hai. Akele test ke liye:
//   node duck.js "hello"            (DUCK_HEADED=1 ho to xvfb-run ke saath chalao)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const BASE = process.env.DUCK_BASE || "https://duck.ai";
export const DEFAULT_MODEL = "gpt-5.6-luna";
const WARM_MIN_MS = Number(process.env.DUCK_WARM_MIN_MS || 2000);
const WARM_MAX_MS = Number(process.env.DUCK_WARM_MAX_MS || 8000);
const MAX_PAGES = Number(process.env.DUCK_MAX_PAGES || 3);
const PROMPT_FALLBACK_LIMIT = 12000; // textarea me maxlength na mile to
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// ---- model names ---------------------------------------------------------
const LIVE = [
  "gpt-5.6-luna", "gpt-5.4-mini", "claude-haiku-4-5", "mistral-small-2603",
  "tinfoil/gpt-oss-120b", "tinfoil/gemma4-31b",
  "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-4-6", "claude-opus-4-8", // paid ho sakte hain
];
const ALIAS = {
  "duck-auto": DEFAULT_MODEL, "duck": DEFAULT_MODEL, "duck-default": DEFAULT_MODEL,
  "gpt-5.6": "gpt-5.6-luna", "gpt-5.4": "gpt-5.4-mini", "gpt-5": "gpt-5.4-mini",
  "gpt-4o": "gpt-5.4-mini", "gpt-4o-mini": "gpt-5.4-mini",
  "claude-haiku": "claude-haiku-4-5", "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-8", "mistral-small": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b", "gemma4-31b": "tinfoil/gemma4-31b",
};
export function resolveModel(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return DEFAULT_MODEL;
  if (ALIAS[n]) return ALIAS[n];
  const hit = LIVE.find((m) => m.toLowerCase() === n);
  return hit || String(name).trim();
}

// ---- messages -> ek prompt string ------------------------------------------
function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).filter(Boolean).join("\n");
  return String(content);
}

export function flatten(messages) {
  const ms = (messages || []).filter(Boolean);
  const parts = [];
  for (const m of ms) {
    let t = textOf(m.content);
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length)
      t += (t ? "\n" : "") + m.tool_calls.map((c) => `[tool_call ${c.function?.name}(${c.function?.arguments || ""})]`).join("\n");
    if (!t.trim()) continue;
    const role = m.role === "tool" ? `Tool result${m.tool_call_id ? " " + m.tool_call_id : ""}`
      : m.role === "assistant" ? "Assistant"
      : m.role === "system" || m.role === "developer" ? "System" : "Human";
    parts.push({ role, t: t.trim() });
  }
  if (parts.length === 1 && parts[0].role === "Human") return parts[0].t; // simple sawaal: as-is
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message. " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

function clamp(prompt, limit) {
  if (prompt.length <= limit) return prompt;
  const marker = "\n...[context truncated]...\n";
  const head = Math.max(1, Math.floor(limit / 10));
  const tail = limit - head - marker.length;
  return prompt.slice(0, head) + marker + prompt.slice(-tail);
}

// ---- errors ----------------------------------------------------------------
export class DuckError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- page me daalne wali scripts (duckapi se) ----------------------------------
const INIT_SCRIPT = `
Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
window.__duckai = {chunks:[], done:false, err:null, status:0, rewrite:null, rewriteApplied:false};
(function(){
  const O = window.fetch;
  window.fetch = async function(u,o){
    o = o || {};
    const url = typeof u === 'string' ? u : (u && u.url) || '';
    if(url.includes('/duckchat/v1/chat')){
      const D = window.__duckai;
      D.chunks = []; D.done = false; D.err = null; D.status = 0;
      const rw = D.rewrite; D.rewrite = null;
      if(rw && typeof o.body === 'string'){
        try{
          const j = JSON.parse(o.body);
          if(rw.model) j.model = rw.model;
          if(rw.reasoningEffort) j.reasoningEffort = rw.reasoningEffort;
          o = Object.assign({}, o, {body: JSON.stringify(j)});
          D.rewriteApplied = true;
        }catch(e){}
      }
      const r = await O.call(this, u, o);
      D.status = r.status;
      try{
        const reader = r.clone().body.getReader();
        const dec = new TextDecoder();
        (async function pump(){
          try{
            while(true){
              const {value,done} = await reader.read();
              if(done){ D.chunks.push(dec.decode()); D.done=true; break; }
              const s = dec.decode(value,{stream:true});
              D.chunks.push(s);
              if(s.indexOf('"action":"error"') !== -1) D.err = s;
            }
          }catch(e){ D.err = String(e); D.done = true; }
        })();
      }catch(e){ D.err = String(e); D.done = true; }
      return r;
    }
    return O.apply(this, arguments);
  };
})();
`;
const RESET_JS = (rw) => { window.__duckai = { chunks: [], done: false, err: null, status: 0, rewrite: rw, rewriteApplied: false }; };
const POLL_JS = (n) => {
  const D = window.__duckai || { chunks: [], done: false, err: null, status: 0 };
  return { n: D.chunks.length, text: D.chunks.slice(n).join(""), done: D.done, err: D.err, status: D.status, rw: !!D.rewriteApplied };
};

function parseLine(line) {
  line = line.trim();
  if (line.startsWith("data:")) line = line.slice(5).trim();
  if (!line.startsWith("{")) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function classify(text, status) {
  if (/ERR_BN_LIMIT/.test(text) || status === 418) return new DuckError("duck.ai ERR_BN_LIMIT (IP/fingerprint ban)", "ban");
  if (/ERR_CHALLENGE/.test(text)) return new DuckError("duck.ai ERR_CHALLENGE (challenge fail)", "challenge");
  if (status === 429) return new DuckError("duck.ai 429 rate limited", "ratelimit");
  const m = /"type"\s*:\s*"([^"]+)"/.exec(text || "");
  return new DuckError("duck.ai error: " + (m ? m[1] : (text || "").slice(0, 200) || "status " + status));
}

// ---- playwright load (lazy: sirf duck request aane par) -------------------------
async function loadPlaywright() {
  // workflow peeche install kar raha hota hai - thoda ruk ke dobara try karo
  for (let i = 0; i < 15; i++) {
    try { return await import("playwright-core"); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("duck: playwright-core install ho raha hai...");
  execFileSync("npm", ["i", "--no-audit", "--no-fund", "--no-save", "playwright-core"], { stdio: "inherit" });
  return await import("playwright-core");
}

function chromePath() {
  for (const p of [process.env.DUCK_CHROME_PATH, "/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"])
    if (p && fs.existsSync(p)) return p;
  return undefined;
}

// ---- client ------------------------------------------------------------------
export class DuckClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.rewriteOk = true; // body rewrite ERR_CHALLENGE de to band
    this.n = 0;
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
      const ua = process.env.DUCK_UA ||
        `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
      this.ctx = await this.browser.newContext({ userAgent: ua, locale: "en-US", viewport: { width: 1280, height: 800 } });
      await this.ctx.addInitScript(INIT_SCRIPT);
      console.log("duck: chrome ready", ver, headless ? "(headless)" : "(headed)");
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  async slot() {
    if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r));
    this.active++;
  }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); }

  async debug(page, tag) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const f = `${DEBUG_DIR}/${Date.now()}-${tag}`;
      await page.screenshot({ path: f + ".png" }).catch(() => {});
      const info = { url: page.url(), title: await page.title().catch(() => ""), text: (await page.innerText("body").catch(() => "")).slice(0, 1500) };
      fs.writeFileSync(f + ".json", JSON.stringify(info, null, 1));
      console.log("duck debug:", f, info.url, info.title);
    } catch {}
  }

  // messages (OpenAI style) -> OpenAI chat.completion JSON string
  async chat({ model, messages, reasoning_effort }, timeoutMs = 80000) {
    await this.ensure();
    await this.slot();
    const id = ++this.n;
    const t0 = Date.now();
    try {
      const wantModel = resolveModel(model);
      let text;
      try {
        const rw = {};
        if (wantModel !== DEFAULT_MODEL) rw.model = wantModel;
        if (reasoning_effort) rw.reasoningEffort = String(reasoning_effort); // duck.ai body field: reasoningEffort
        text = await this.#send(id, flatten(messages), timeoutMs, this.rewriteOk && Object.keys(rw).length ? rw : null);
      } catch (e) {
        if (e.kind === "rewrite") { // body badalne par challenge fail -> bina badle default model se
          this.rewriteOk = false;
          console.log("duck: model rewrite reject hua, default model use ho raha hai");
          text = await this.#send(id, flatten(messages), Math.max(15000, timeoutMs - (Date.now() - t0)), null);
        } else throw e;
      }
      const plen = JSON.stringify(messages || "").length;
      return JSON.stringify({
        id: "chatcmpl-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: String(model || DEFAULT_MODEL),
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil(plen / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil((plen + text.length) / 4) },
      });
    } finally { this.free(); }
  }

  async #send(id, prompt, timeoutMs, rewrite) {
    const deadline = Date.now() + timeoutMs;
    const page = await this.ctx.newPage();
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: Math.min(45000, timeoutMs) });
      // warm: textarea aaye aur kam se kam WARM_MIN_MS beete (challenge JS ko time chahiye)
      const t0 = Date.now();
      while (Date.now() - t0 < WARM_MAX_MS) {
        await this.#dismiss(page);
        if (Date.now() - t0 >= WARM_MIN_MS && (await page.$("textarea"))) break;
        await page.waitForTimeout(200);
      }
      const ta = await page.$("textarea");
      if (!ta) { await this.debug(page, `r${id}-no-textarea`); throw new DuckError("duck.ai textarea nahi mila (page badal gaya ya block page)", "layout"); }

      const maxlen = Number(await ta.getAttribute("maxlength"));
      prompt = clamp(prompt, maxlen > 0 ? maxlen : PROMPT_FALLBACK_LIMIT);

      await page.evaluate(RESET_JS, rewrite);
      await ta.click();
      await ta.fill(prompt);
      await page.waitForTimeout(300);
      let sent = false;
      for (const b of await page.$$("button")) {
        const label = ((await b.innerText().catch(() => "")) || "").trim();
        const aria = (await b.getAttribute("aria-label")) || "";
        if (["Ask", "Send"].includes(label) || ["Ask", "Send"].includes(aria)) { await b.click({ force: true }); sent = true; break; }
      }
      if (!sent) await ta.press("Enter");

      let idx = 0, buf = "", out = "", saw = false;
      while (Date.now() < deadline) {
        const st = await page.evaluate(POLL_JS, idx);
        idx = st.n;
        if (st.err || (st.status && st.status !== 200)) {
          const err = classify((st.err || "") + st.text, st.status);
          if (err.kind === "challenge" && st.rw) throw new DuckError("rewrite rejected", "rewrite");
          await this.debug(page, `r${id}-${err.kind}`);
          throw err;
        }
        if (st.text) {
          saw = true; buf += st.text;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const ev = parseLine(buf.slice(0, i)); buf = buf.slice(i + 1);
            if (ev && ev.message) out += ev.message;
          }
        }
        if (st.done) {
          const ev = parseLine(buf); if (ev && ev.message) out += ev.message;
          if (!saw) { await this.debug(page, `r${id}-empty`); throw new DuckError("duck.ai ne bina jawab ke stream band kar di"); }
          if (!out.trim()) throw new DuckError("duck.ai ka jawab khali aaya");
          return out.trim();
        }
        await page.waitForTimeout(saw ? 200 : 400);
      }
      await this.debug(page, `r${id}-timeout`);
      throw new DuckError("duck.ai timeout", "timeout");
    } finally {
      await page.close().catch(() => {});
    }
  }

  // consent / welcome popup ho to hata do (best effort)
  async #dismiss(page) {
    try {
      for (const b of await page.$$("button")) {
        const t = ((await b.innerText().catch(() => "")) || "").trim();
        if (/^(agree and continue|got it|i agree|accept all|accept|get started)$/i.test(t) && (await b.isVisible())) {
          await b.click({ force: true }); await page.waitForTimeout(300); return;
        }
      }
    } catch {}
  }

  async close() {
    try { await this.browser?.close(); } catch {}
    this.browser = null; this.ctx = null; this.starting = null;
  }
}

// ---- akele chalao: node duck.js "prompt" -------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PONG";
  const c = new DuckClient();
  try {
    const t0 = Date.now();
    const r = JSON.parse(await c.chat({ model: process.env.DUCK_MODEL || "duck-auto", messages: [{ role: "user", content: prompt }] }, 90000));
    console.log("\n=== DUCK OK in", Date.now() - t0, "ms ===\n" + r.choices[0].message.content);
    await c.close();
    process.exit(0);
  } catch (e) {
    console.log("\n=== DUCK FAIL ===", e.kind || "", e.message);
    await c.close();
    process.exit(1);
  }
}
