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
const WARM_POOL = Number(process.env.DUCK_WARM_POOL || 3); // kitne page pehle se garam rakhne hain
const WARM_MAX_MS = Number(process.env.DUCK_WARM_MAX_MS || 8000);
const MAX_PAGES = Math.max(Number(process.env.DUCK_MAX_PAGES || 3), WARM_POOL); // MAX_PAGES kabhi pool se chhota nahi
const PAGE_CAP = MAX_PAGES + WARM_POOL; // chrome ke kul pages: MAX_PAGES (sessions/active) + WARM_POOL (garam spare). Runner memory ke liye upar nahi
const SESSION_TTL = Number(process.env.DUCK_SESSION_TTL_MS || 600000); // idle session ~10 min
const STALE_MS = 150000; // itne se purana warm page band karke naya banate hain
const SWEEP_MS = 30000;  // har 30s warm pages ki safai
const PROMPT_FALLBACK_LIMIT = 12000; // textarea me maxlength na mile to
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// ---- model names ---------------------------------------------------------
// FALLBACK = hardcoded list. Asli catalog duck.ai page ke network response se pakda jata hai (setLiveModels -> LIVE_CAT)
const FALLBACK = [
  "gpt-5.6-luna", "gpt-5.4-mini", "claude-haiku-4-5", "mistral-small-2603",
  "tinfoil/gpt-oss-120b", "tinfoil/gemma4-31b",
  "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-4-6", "claude-opus-4-8", // paid ho sakte hain
];
let LIVE_CAT = []; // [{id, name?, free?}]
const ALIAS = {
  "duck-auto": DEFAULT_MODEL, "duck": DEFAULT_MODEL, "duck-default": DEFAULT_MODEL,
  "gpt-5.6": "gpt-5.6-luna", "gpt-5.4": "gpt-5.4-mini", "gpt-5": "gpt-5.4-mini",
  "gpt-4o": "gpt-5.4-mini", "gpt-4o-mini": "gpt-5.4-mini", "o3-mini": "gpt-5.4-mini",
  "claude-haiku": "claude-haiku-4-5", "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus": "claude-opus-4-8", "mistral-small": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b", "gemma4-31b": "tinfoil/gemma4-31b",
};
export function getLiveModels() { return LIVE_CAT.length ? LIVE_CAT.map((x) => ({ ...x })) : FALLBACK.map((id) => ({ id })); }
export function setLiveModels(models) {
  const out = [], seen = new Set();
  for (const x of Array.isArray(models) ? models : []) {
    const o = typeof x === "string" ? { id: x } : x && typeof x.id === "string" ? x : null;
    if (!o || o.id.length > 120 || seen.has(o.id)) continue;
    seen.add(o.id); out.push(o);
  }
  if (out.length) LIVE_CAT = out;
}

export function resolveModel(name) {
  const raw = String(name || "").trim(), n = raw.toLowerCase();
  if (!n) return DEFAULT_MODEL;
  const ids = LIVE_CAT.length ? LIVE_CAT.map((x) => x.id) : FALLBACK; // live list ho to wahi, warna hardcoded
  const exact = ids.find((m) => m.toLowerCase() === n);
  if (exact) return exact;
  if (ALIAS[n]) {
    if (!LIVE_CAT.length || ids.includes(ALIAS[n])) return ALIAS[n];
    const near = ids.find((m) => m.toLowerCase().startsWith(n)); // alias ka target live catalog se hat gaya: nazdeeki live model
    return near || ALIAS[n];
  }
  // purane / lambe naam (claude-3-5-sonnet-2024..., gpt-4-turbo) -> nazdeeki duck model
  if (/^claude-.*haiku/.test(n)) return "claude-haiku-4-5";
  if (/^claude-.*sonnet/.test(n)) return "claude-sonnet-4-6";
  if (/^claude-.*opus/.test(n)) return "claude-opus-4-8";
  if (/^(gpt-4|gpt-3|o\d)/.test(n)) return "gpt-5.4-mini";
  return ids.find((m) => m.toLowerCase().startsWith(n)) || raw;
}

// duck.ai ke models response (shape badalta rehta hai) se id/name/free nikalo - tolerant parser
function normModel(x) {
  const o = { id: x.id };
  const name = x.name || x.displayName || x.label || x.title;
  if (typeof name === "string") o.name = name.slice(0, 80);
  const free = typeof x.free === "boolean" ? x.free : typeof x.isFree === "boolean" ? x.isFree
    : typeof x.paid === "boolean" ? !x.paid : typeof x.isPaid === "boolean" ? !x.isPaid
    : typeof x.tier === "string" ? /free/i.test(x.tier) : typeof x.access === "string" ? /free/i.test(x.access) : undefined;
  if (free !== undefined) o.free = free;
  return o;
}
function extractModels(json, depth = 0) {
  if (depth > 5 || !json || typeof json !== "object") return [];
  if (Array.isArray(json)) {
    const items = json.map((x) => typeof x === "string" ? { id: x } : x && typeof x === "object" ? { ...x, id: x.id || x.model || x.modelId || x.slug } : null);
    const ok = items.filter((x) => x && typeof x.id === "string" && /^[\w.\-\/:@]{2,120}$/.test(x.id));
    if (ok.length >= 2 && ok.length >= items.length / 2) return ok.map(normModel);
  }
  for (const v of Object.values(json)) { const r = extractModels(v, depth + 1); if (r.length) return r; }
  return [];
}

// ---- messages -> ek prompt string ------------------------------------------
function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).filter(Boolean).join("\n");
  return String(content);
}

// assistant ke tool call ko wahi <tool_call> format me likho jo model ko bola gaya hai (model galat format copy na kare)
function callText(c) {
  const f = (c && c.function) || c || {};
  let a = f.arguments ?? {};
  if (typeof a === "string") { try { a = JSON.parse(a); } catch {} }
  return `<tool_call>${JSON.stringify({ name: f.name, arguments: a })}</tool_call>`;
}
function msgText(m) {
  let t = textOf(m.content);
  const calls = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : m.function_call ? [m.function_call] : [];
  if (m.role === "assistant" && calls.length) t += (t ? "\n" : "") + calls.map(callText).join("\n");
  return t;
}
// session reuse ke liye har message ki canonical string (tool_calls wale assistant message bhi match karte hain)
const canon = (m) => `${m.role}|${m.tool_call_id || m.name || ""}|${msgText(m).trim()}`;

export function flatten(messages) {
  const ms = (messages || []).filter(Boolean);
  const parts = [];
  for (const m of ms) {
    const t = msgText(m);
    if (!t.trim()) continue;
    const isTool = m.role === "tool" || m.role === "function";
    const role = isTool ? `Tool result${m.tool_call_id || m.name ? " " + (m.tool_call_id || m.name) : ""}`
      : m.role === "assistant" ? "Assistant"
      : m.role === "system" || m.role === "developer" ? "System" : "Human";
    parts.push({ role, t: t.trim() });
  }
  if (parts.length === 1 && parts[0].role === "Human") return parts[0].t; // simple sawaal: as-is
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message (or to the last Tool result). " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

// transcript prompt par model kabhi "\n\nH: ..." likh ke agla Human turn khud bana deta hai: wahin kaat do
const TURN_RE = /\n+[ \t]*(?:Human|H)[ \t]*:/;
const cleanReply = (t) => { const m = TURN_RE.exec(t); return (m ? t.slice(0, m.index) : t).replace(/^\s*Assistant:\s*/, "").trim(); };

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

// ---- image generation helpers ---------------------------------------------------
// p2d-duck ke hisaab se duck.ai image model id "image-generation" hai (usi chat endpoint par). Response ka exact shape verified nahi,
// isliye tolerant extraction: data URL / markdown image / http image url / lambi base64 string.
const IMAGE_MODEL = process.env.DUCK_IMAGE_MODEL || "image-generation";
const mimeOfB64 = (b) => (b.startsWith("/9j/") ? "image/jpeg" : b.startsWith("UklGR") ? "image/webp" : b.startsWith("R0lGOD") ? "image/gif" : "image/png");
function imgFromText(s) {
  let m = /data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+\/=]+)/.exec(s);
  if (m) return { b64: m[2], mime: "image/" + (m[1] === "jpg" ? "jpeg" : m[1]) };
  m = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(s);
  if (m) return { url: m[1] };
  const flat = s.replace(/\s+/g, "");
  if (flat.length > 2000 && /^[A-Za-z0-9+\/]+={0,2}$/.test(flat) && /^(iVBOR|\/9j\/|UklGR|R0lGOD)/.test(flat)) return { b64: flat, mime: mimeOfB64(flat) };
  return null;
}
export function findImage(raw) {
  const t = String(raw || "");
  const msg = [];
  let hit = null;
  const walk = (v, k, d) => {
    if (hit || d > 6 || v == null) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+$/.test(v) && (/\.(png|jpe?g|webp)(\?|$)/i.test(v) || /image|img/i.test(k))) hit = { url: v };
      else if (k !== "message" && (v.length > 2000 || v.includes("data:image"))) hit = imgFromText(v);
      return;
    }
    if (typeof v !== "object") return;
    for (const [kk, vv] of Object.entries(v)) walk(vv, kk, d + 1);
  };
  for (const line of t.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (typeof ev.message === "string") msg.push(ev.message); // base64 / data URL kai events me tuta ho sakta hai: message jodke dekho
    walk(ev, "", 0);
    if (hit) return hit;
  }
  return imgFromText(msg.join("")) || imgFromText(t);
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
    if(url.includes('/duckchat/v1/chat') || url.includes('/duckchat/v1/image')){
      const D = window.__duckai;
      D.chunks = []; D.done = false; D.err = null; D.status = 0;
      const rw = D.rewrite; D.rewrite = null;
      if(rw && typeof o.body === 'string'){
        try{
          const j = JSON.parse(o.body);
          D.sent = {model:j.model, reasoningEffort:j.reasoningEffort, keys:Object.keys(j)};
          if(rw.model) j.model = rw.model;
          if(rw.reasoningEffort) j.reasoningEffort = rw.reasoningEffort;
          D.final = {model:j.model, reasoningEffort:j.reasoningEffort};
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
  return { sent: D.sent || null, final: D.final || null, n: D.chunks.length, text: D.chunks.slice(n).join(""), done: D.done, err: D.err, status: D.status, rw: !!D.rewriteApplied };
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

// Duck ke paas native function-call API nahi; schema ko prompt me strict format me bhejte hain.
const toolSchemas = (tools) => (Array.isArray(tools) ? tools : []).map((t) => (t && t.type === "function" && t.function ? t.function : t)).filter((t) => t && typeof t.name === "string");
const forcedName = (tc) => (tc && typeof tc === "object" ? tc.function?.name || tc.name || null : null);

function withToolInstruction(messages, tools, toolChoice) {
  const schemas = toolSchemas(tools);
  if (!schemas.length || toolChoice === "none") return messages || []; // tool_choice none: kuch alag nahi
  const fn = forcedName(toolChoice);
  const rule = fn ? `You MUST call the tool "${fn}" now.`
    : toolChoice === "required" || toolChoice === "any" ? "You MUST call at least one of the tools now."
    : "If a listed tool is needed, call it; otherwise answer normally.";
  const ex = fn ? schemas.find((t) => t.name === fn) || schemas[0] : schemas[0];
  const req = (ex.parameters && ex.parameters.required) || [];
  const exArgs = {}; for (const k of req) exArgs[k] = "<" + k + ">";
  const instruction = `\n\nTOOL CALLING RULE: You are connected to external tools that the system runs for you, so you CAN use them. ${rule} To call a tool output ONLY <tool_call>{"name":"tool_name","arguments":{}}</tool_call> (one block per call; several blocks for parallel calls) and no other text, no apology, no explanation. Example: <tool_call>{"name":"${ex.name}","arguments":${JSON.stringify(exArgs)}}</tool_call> Arguments must be a JSON object matching the tool parameters. Never invent tool names. Tool outputs come back as "Tool result" messages. Available tools: ${JSON.stringify(schemas)}`;
  const out = (messages || []).map((m) => ({ ...m }));
  const i = out.findIndex((m) => m.role === "system");
  if (i >= 0) out[i].content = textOf(out[i].content) + instruction;
  else out.unshift({ role: "system", content: instruction });
  // model aakhri message ko zyada dhyan se padhta hai: wahan chhota reminder bhi
  const last = out[out.length - 1];
  if (last && last.role !== "system" && last.role !== "assistant")
    last.content = textOf(last.content) + `\n\n[${rule} Tool call format: <tool_call>{"name":"...","arguments":{...}}</tool_call> only.]`;
  return out;
}

function parseToolReply(text, tools, toolChoice) {
  const schemas = toolSchemas(tools);
  if (!schemas.length || toolChoice === "none") return null;
  const allowed = new Set(schemas.map((t) => t.name));
  const cands = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = re.exec(text))) cands.push(m[1]);
  if (!cands.length) { const f = /```(?:json)?\s*([\s\S]*?)```/i.exec(text); cands.push(f ? f[1] : text.trim()); } // fenced / bare JSON fallback
  const calls = [];
  for (const c of cands) {
    let obj; try { obj = JSON.parse(c.trim()); } catch { continue; }
    const list = Array.isArray(obj) ? obj : Array.isArray(obj && obj.tool_calls) ? obj.tool_calls : [obj];
    for (let o of list) {
      if (o && o.function && typeof o.function === "object") o = o.function;
      if (!o || typeof o.name !== "string" || !allowed.has(o.name)) continue; // naam provided tools me hona chahiye
      let args = o.arguments ?? o.parameters ?? o.input ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      calls.push({ id: "call_" + Math.random().toString(36).slice(2, 12), type: "function", function: { name: o.name, arguments: JSON.stringify(args) } });
    }
  }
  return calls.length ? calls : null;
}

// ---- client ------------------------------------------------------------------
export class DuckClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.rewriteOk = true; // body rewrite ERR_CHALLENGE de to band
    this.n = 0;
    this.ready = []; this.refilling = 0; // pehle se garam (warm) pages
    this.sweeper = null;
    this.sessions = new Map(); // conversation_id -> {page, model, canon[], lastUsed, busy}; runner rotation par naturally reset
    this.catalog = []; this.catalogAt = 0; // duck.ai se pakda hua models catalog
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
      this.sweeper = setInterval(() => this.#sweep(), SWEEP_MS); // stale warm pages hatao + naye banao
      this.sweeper.unref?.();
      console.log("duck: chrome ready", ver, headless ? "(headless)" : "(headed)", "pool", WARM_POOL, "max", MAX_PAGES);
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  async slot() {
    if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r));
    this.active++;
  }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); this.#refill(); }

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
  // onDelta(text) optional: SSE ka har naya tukda aate hi turant call hota hai (real streaming ke liye)
  async chat({ model, messages, reasoning_effort, onDelta, conversation_id, tools, tool_choice, legacy_fn }, timeoutMs = 80000) {
    await this.ensure();
    await this.slot();
    const id = ++this.n;
    const t0 = Date.now();
    const ms = withToolInstruction((messages || []).filter(Boolean), tools, tool_choice);
    const key = typeof conversation_id === "string" ? conversation_id.slice(0, 200) : "";
    const wantModel = resolveModel(model);
    const rw = {};
    if (wantModel !== DEFAULT_MODEL) rw.model = wantModel;
    if (reasoning_effort) {
      const e = String(reasoning_effort).toLowerCase();
      rw.reasoningEffort = { fast: "none", off: "none", false: "none" }[e] || e;
    }
    const rwArg = () => (this.rewriteOk && Object.keys(rw).length ? rw : null);
    const left = () => Math.max(15000, timeoutMs - (Date.now() - t0));
    const canons = ms.map(canon);
    let emitted = 0; // client ko kitna text ja chuka (retry par double text na ho)
    let guard = false, acc = "", sentLen = 0, cut = false; // guard: sirf poore transcript prompt par on
    const od = onDelta ? (t) => {
      if (!guard) { emitted += t.length; onDelta(t); return; }
      if (cut) return;
      acc += t;
      const m = TURN_RE.exec(acc);
      let upto = acc.length;
      if (m) { cut = true; upto = m.index; }
      else { const tail = /\n+[ \t]*(?:H(?:u(?:m(?:a(?:n)?)?)?)?)?[ \t]*$/.exec(acc); if (tail) upto = tail.index; } // adhura "\nH" ruko
      if (upto > sentLen) { const piece = acc.slice(sentLen, upto); sentLen = upto; emitted += piece.length; onDelta(piece); }
    } : undefined;
    try {
      let text = null, page = null;
      let session = key ? this.sessions.get(key) : null;
      let store = !!key;
      if (session && session.busy) { session = null; store = false; } // isi conversation par doosri request chal rahi: ye fresh page par, session store nahi
      if (session) {
        const n = session.canon.length, delta = ms.slice(n);
        const fine = session.model === wantModel && !session.page.isClosed() && Date.now() - session.lastUsed < SESSION_TTL
          && delta.length > 0 && canons.slice(0, n).every((c, i) => c === session.canon[i])
          && delta.every((m) => m.role === "user" || m.role === "tool" || m.role === "function");
        if (fine) {
          session.busy = true;
          try {
            // sirf naye turn(s) usi khuli page me type karo (new chat nahi)
            text = await this.#send(id, flatten(delta), timeoutMs, rwArg(), od, session.page, null);
            page = session.page;
          } catch (e) {
            this.sessions.delete(key); await session.page.close().catch(() => {});
            // text pehle hi client ko ja chuka ho (ya ban/ratelimit) to retry nahi, warna double text ho jata
            if (emitted > 0 || e.kind === "ban" || e.kind === "ratelimit") throw e;
            console.log("duck: session reuse fail (" + e.message + ") -> fresh page par poora prompt");
          } finally { session.busy = false; }
        } else { this.sessions.delete(key); await session.page.close().catch(() => {}); }
      }
      if (text === null) {
        const hold = store ? {} : null; // #send isme page batata hai, race-free (shared variable nahi)
        guard = flatten(ms).startsWith("Below is a conversation transcript");
        try {
          text = await this.#send(id, flatten(ms), left(), rwArg(), od, null, hold);
        } catch (e) {
          if (e.kind !== "rewrite" || emitted > 0) throw e;
          this.rewriteOk = false;
          console.log("duck: model rewrite reject hua, default model use ho raha hai");
          text = await this.#send(id, flatten(ms), left(), null, od, null, hold);
        }
        page = (hold && hold.page) || null;
      }
      if (guard) text = cleanReply(text);
      let toolCalls = parseToolReply(text, tools, tool_choice);
      const must = tool_choice === "required" || tool_choice === "any" || !!forcedName(tool_choice);
      if (!toolCalls && must && toolSchemas(tools).length) {
        // tool_choice required/forced tha par model ne text diya: ek baar sakht reminder ke saath fresh page par dobara
        console.log("duck: tool_call nahi aaya (required), ek retry");
        const m2 = [...ms, { role: "assistant", content: text }, { role: "user", content: "That was not a tool call. Reply with ONLY the <tool_call>{\"name\":...,\"arguments\":{...}}</tool_call> block now. No other text." }];
        if (page) { if (key && this.sessions.get(key) && this.sessions.get(key).page === page) this.sessions.delete(key); await page.close().catch(() => {}); page = null; } // session ki history ab mel nahi khati
        try {
          const t2 = await this.#send(id, flatten(m2), left(), rwArg(), null, null, null);
          const c2 = parseToolReply(t2, tools, tool_choice);
          if (c2) { toolCalls = c2; text = t2; }
        } catch (e) { console.log("duck: tool retry fail:", e.message); }
      }
      if (key && store && page && !page.isClosed()) {
        const sc = [...canons, canon(toolCalls ? { role: "assistant", content: null, tool_calls: toolCalls } : { role: "assistant", content: text })];
        if (session && page === session.page && this.sessions.get(key) === session) { session.canon = sc; session.lastUsed = Date.now(); }
        else await this.#storeSession(key, wantModel, page, sc);
      }
      const plen = JSON.stringify(messages || "").length;
      const msg = !toolCalls ? { role: "assistant", content: text }
        : legacy_fn ? { role: "assistant", content: null, function_call: toolCalls[0].function }
        : { role: "assistant", content: null, tool_calls: toolCalls };
      return JSON.stringify({
        ...(process.env.DUCK_DEBUG_SENT === "1" ? { _jaat_sent: this.lastSent || null } : {}), // debug sirf opt-in (reply me prompt leak na ho)
        id: "chatcmpl-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
        object: "chat.completion", created: Math.floor(Date.now() / 1000), model: String(model || DEFAULT_MODEL),
        choices: [{ index: 0, message: msg, finish_reason: toolCalls ? (legacy_fn ? "function_call" : "tool_calls") : "stop" }],
        usage: { prompt_tokens: Math.ceil(plen / 4), completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil((plen + text.length) / 4) },
      });
    } finally { this.free(); }
  }

  async #storeSession(key, model, page, canonList) {
    const old = this.sessions.get(key);
    if (old && old.page !== page) await old.page.close().catch(() => {});
    this.sessions.set(key, { page, model, canon: canonList.slice(), lastUsed: Date.now(), busy: false });
    // bounded LRU: sessions MAX_PAGES se upar nahi (sabse purani idle session band)
    while (this.sessions.size > MAX_PAGES) {
      const idle = [...this.sessions.entries()].filter(([, v]) => !v.busy && v.page !== page).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) break;
      this.sessions.delete(idle[0]); await idle[1].page.close().catch(() => {});
    }
  }

  // ---- pre-warm: duck.ai page pehle se khol ke rakho, request aate hi use ho ----
  async #prepare() {
    const page = await this.ctx.newPage();
    page.on("response", (r) => { this.#sniff(r); }); // models catalog yahin se pakdo (extra page nahi khulta)
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });
      const t0 = Date.now();
      while (Date.now() - t0 < WARM_MAX_MS) {
        await this.#dismiss(page);
        if (Date.now() - t0 >= WARM_MIN_MS && (await page.$("textarea"))) break;
        await page.waitForTimeout(200);
      }
      return { page, at: Date.now() };
    } catch (e) { await page.close().catch(() => {}); throw e; }
  }

  // duck.ai page ka "models" JSON response pakdo -> catalog (+ resolveModel ke liye setLiveModels)
  async #sniff(r) {
    try {
      const u = r.url();
      if (!/models/i.test(u) || !/duck\.ai|duckduckgo\.com/i.test(u)) return;
      if (process.env.DUCK_LOG_MODELS === "1") console.log("duck: models-type response", r.status(), u.split("?")[0]);
      if (r.status() !== 200 || !/json/i.test(r.headers()["content-type"] || "")) return;
      const found = extractModels(await r.json());
      if (found.length) { this.catalog = found; this.catalogAt = Date.now(); setLiveModels(found); }
    } catch {}
  }

  #refill() {
    if (!this.ctx) return;
    // pool poora rakho; chrome ke kul pages PAGE_CAP (= MAX_PAGES + WARM_POOL) se upar nahi
    while (this.ready.length + this.refilling < WARM_POOL && this.ctx.pages().length + this.refilling < PAGE_CAP) {
      const delay = this.refilling * 400; // ek saath 3 page khulne se CPU na atke, thoda gap
      this.refilling++;
      setTimeout(() => {
        this.#prepare().then(async (p) => {
          if (this.ctx) this.ready.push(p); else await p.page.close().catch(() => {});
        }).catch(() => {}).finally(() => { this.refilling--; });
      }, delay);
    }
  }

  // stale (>150s) warm pages + idle (>TTL) sessions band karo, phir pool dobara bharo
  async #sweep() {
    if (!this.ctx) return;
    const now = Date.now();
    for (const [key, ss] of this.sessions) {
      if (!ss.busy && (now - ss.lastUsed >= SESSION_TTL || ss.page.isClosed())) { this.sessions.delete(key); await ss.page.close().catch(() => {}); }
    }
    const bad = (p) => now - p.at >= STALE_MS || p.page.isClosed();
    const old = this.ready.filter(bad);          // sync partition: beech me #takePage se race nahi
    this.ready = this.ready.filter((p) => !bad(p));
    await Promise.all(old.map((p) => p.page.close().catch(() => {})));
    this.#refill();
  }

  async #takePage() {
    // 150s se purana warm page chhod do (stale ho sakta hai)
    while (this.ready.length) {
      const p = this.ready.shift();
      if (Date.now() - p.at < STALE_MS && !p.page.isClosed()) { this.#refill(); return p.page; }
      await p.page.close().catch(() => {});
    }
    // warm page nahi aur total pages cap par: sabse purani idle session hatao
    if (this.ctx.pages().length >= PAGE_CAP) {
      const idle = [...this.sessions.entries()].filter(([, v]) => !v.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) { this.sessions.delete(idle[0]); await idle[1].page.close().catch(() => {}); }
    }
    const p = await this.#prepare();
    this.#refill();
    return p.page;
  }

  // runner start hote hi chrome + warm pool tayyar rakho (pehli duck request fast ho)
  async warmup() {
    try { await this.ensure(); this.#refill(); } catch (e) { console.log("duck warmup fail:", e.message); }
  }

  // Warm pages ke network response se pakda catalog (max waitMs ruk ke). Na mile to [] -> hardcoded fallback chalta rahega.
  // Debug: DUCK_LOG_MODELS=1 se "models" wale saare duck.ai URLs log hote hain.
  async discoverModels(waitMs = 12000) {
    try {
      await this.ensure(); this.#refill();
      const t0 = Date.now();
      while (!this.catalog.length && Date.now() - t0 < waitMs) await new Promise((r) => setTimeout(r, 300));
      if (!this.catalog.length) console.log("duck: models catalog intercept nahi hua (DUCK_LOG_MODELS=1 DUCK_HEADED=1 se check karo), fallback list chalegi");
      return this.catalog.slice();
    } catch (e) { console.log("duck model discovery skipped:", e.message); return []; }
  }

  async #send(id, prompt, timeoutMs, rewrite, onDelta, reusePage = null, hold = null, raw = false) {
    const deadline = Date.now() + timeoutMs;
    let started = false; // pehla delta bhejne se pehle shuruaati whitespace hata do (final out.trim() jaisa)
    const emit = (t) => {
      if (!onDelta || !t) return;
      if (!started) { t = t.replace(/^\s+/, ""); if (!t) return; started = true; }
      try { onDelta(t); } catch {} // callback ka error duck ko na roke
    };
    const page = reusePage || await this.#takePage();
    if (hold) hold.page = page; // session store ke liye page chat() ko batao
    let ok = false;
    try {
      const ta = await page.$("textarea");
      if (!ta) { await this.debug(page, `r${id}-no-textarea`); throw new DuckError("duck.ai textarea nahi mila (page badal gaya ya block page)", "layout"); }

      const maxlen = Number(await ta.getAttribute("maxlength"));
      prompt = clamp(prompt, maxlen > 0 ? maxlen : PROMPT_FALLBACK_LIMIT);

      await page.evaluate(RESET_JS, rewrite);
      await ta.click();
      await ta.fill(prompt);
      await page.waitForTimeout(100);
      let sent = false;
      for (const b of await page.$$("button")) {
        const label = ((await b.innerText().catch(() => "")) || "").trim();
        const aria = (await b.getAttribute("aria-label")) || "";
        if (["Ask", "Send"].includes(label) || ["Ask", "Send"].includes(aria)) { await b.click({ force: true }); sent = true; break; }
      }
      if (!sent) await ta.press("Enter");

      let idx = 0, buf = "", out = "", saw = false, rawAll = ""; // rawAll: sirf raw mode (image) me poora response
      while (Date.now() < deadline) {
        const st = await page.evaluate(POLL_JS, idx);
        idx = st.n;
        if (st.sent) this.lastSent = { page_default: st.sent, we_sent: st.final };
        if (st.err || (st.status && st.status !== 200)) {
          const err = classify((st.err || "") + st.text, st.status);
          if (err.kind === "challenge" && st.rw) throw new DuckError("rewrite rejected", "rewrite");
          await this.debug(page, `r${id}-${err.kind}`);
          throw err;
        }
        if (st.text) {
          saw = true; buf += st.text;
          if (raw) rawAll += st.text;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const ev = parseLine(buf.slice(0, i)); buf = buf.slice(i + 1);
            if (ev && ev.message) { out += ev.message; emit(ev.message); }
          }
        }
        if (st.done) {
          const ev = parseLine(buf); if (ev && ev.message) { out += ev.message; emit(ev.message); }
          if (!saw) { await this.debug(page, `r${id}-empty`); throw new DuckError("duck.ai ne bina jawab ke stream band kar di"); }
          if (raw) { ok = true; return rawAll; } // image: text nahi, poora raw response caller parse karega (hold wali page khuli rehti hai)
          if (!out.trim()) throw new DuckError("duck.ai ka jawab khali aaya");
          ok = true;
          return out.trim();
        }
        await page.waitForTimeout(saw ? 80 : 150);
      }
      await this.debug(page, `r${id}-timeout`);
      throw new DuckError("duck.ai timeout", "timeout");
    } finally {
      // reuse page ko caller sambhalta hai; hold wali page sirf success par khuli rehti hai
      if (!reusePage && !(hold && ok)) await page.close().catch(() => {});
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

  // ---- image generation ----------------------------------------------------------
  // Route A (default, behtar quality): duck.ai ke normal chat model se "Generate an image: ..." bolo. duck.ai apna native image tool
  //   (app me "GPT Image 2") chalata hai; result page me <img> banke aata hai, wahin se bytes uthate hain (protocol par nirbhar nahi).
  // Route B (fallback): body rewrite se model "image-generation" (purana, kam quality).
  // Return: JSON string {b64_json, mime} ya {url}. Image na mile to error (fake image kabhi nahi).
  async image(prompt, timeoutMs = Number(process.env.DUCK_IMAGE_TIMEOUT_MS || 150000)) {
    await this.ensure();
    await this.slot();
    const t0 = Date.now();
    const text = String(prompt || "").slice(0, 3800);
    try {
      let found = null, errA = "";
      try {
        found = await this.#imageViaChat(++this.n, "Generate an image: " + text, Math.min(95000, timeoutMs));
      } catch (e) {
        errA = e.message;
        if (e.kind === "ban" || e.kind === "ratelimit") throw e;
        console.log("duck-image: chat-tool route fail ->", e.message);
      }
      if (!found) {
        try {
          found = await this.#imageViaModel(++this.n, text, Math.max(30000, timeoutMs - (Date.now() - t0)));
        } catch (e) {
          throw new DuckError("chat-tool route: " + errA + " | model route: " + e.message, e.kind || "noimage");
        }
      }
      if (found.url && !found.b64) {
        try {
          const r = await fetch(found.url);
          if (r.ok) { const b = Buffer.from(await r.arrayBuffer()).toString("base64"); found = { b64: b, mime: (r.headers.get("content-type") || "").startsWith("image/") ? r.headers.get("content-type") : mimeOfB64(b) }; }
        } catch {}
      }
      return JSON.stringify(found.b64 ? { b64_json: found.b64, mime: found.mime || mimeOfB64(found.b64) } : { url: found.url });
    } finally { this.free(); }
  }

  async #imageViaChat(id, prompt, ms) {
    const hold = {};
    let page = null;
    try {
      const raw = await this.#send(id, prompt, ms, null, null, null, hold, true);
      page = hold.page;
      let found = findImage(raw);
      const until = Date.now() + 40000; // stream khatam ho gayi par image render hone me der ho sakti hai
      while (!found && Date.now() < until) {
        found = await this.#domImage(page);
        if (!found) await page.waitForTimeout(1000);
      }
      if (!found) { await this.#imgDiag(page, raw); throw new DuckError("image page me nahi aayi (model ne shayad sirf text diya)", "noimage"); }
      return found;
    } finally { if (page) await page.close().catch(() => {}); }
  }

  async #imageViaModel(id, prompt, ms) {
    try {
      const raw = await this.#send(id, prompt, ms, { model: IMAGE_MODEL }, null, null, null, true);
      const found = findImage(raw);
      if (!found) {
        console.log("duck-image: model route me image nahi mili. sent:", JSON.stringify(this.lastSent || null), "raw head:", raw.replace(/[A-Za-z0-9+\/=]{200,}/g, "<b64>").slice(0, 600));
        throw new DuckError("response me image nahi mili", "noimage");
      }
      return found;
    } catch (e) {
      if (e.kind === "rewrite") throw new DuckError("image model (" + IMAGE_MODEL + ") wali body reject hui (ERR_CHALLENGE)", "rewrite");
      throw e;
    }
  }

  // page me sabse nayi badi <img> (blob:/data:/https) ke bytes. Logo/icon chhote hote hain, isliye 400px se chhoti skip.
  async #domImage(page) {
    try {
      return await page.evaluate(async () => {
        const imgs = [...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth >= 400 && i.naturalHeight >= 400).reverse();
        for (const i of imgs) {
          const src = i.currentSrc || i.src || "";
          if (!src || /\.svg(\?|$)/i.test(src)) continue;
          try {
            const r = await fetch(src);
            if (!r.ok) continue;
            const b = new Uint8Array(await r.arrayBuffer());
            if (b.length < 5000) continue;
            let s = "";
            for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
            const ct = (r.headers.get("content-type") || "").split(";")[0];
            return { b64: btoa(s), mime: ct.startsWith("image/") ? ct : "" };
          } catch {}
        }
        return null;
      }).then((r) => (r ? { b64: r.b64, mime: r.mime || mimeOfB64(r.b64) } : null));
    } catch { return null; }
  }

  // image na mile to log me page ki halat (agli iteration me yahi dekhna hai)
  async #imgDiag(page, raw) {
    try {
      const info = await page.evaluate(() => ({
        imgs: [...document.querySelectorAll("img")].map((i) => ({ src: (i.currentSrc || i.src || "").slice(0, 90), w: i.naturalWidth, h: i.naturalHeight })).slice(-8),
        canvas: document.querySelectorAll("canvas").length,
        btns: [...document.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.innerText || "").trim().slice(0, 30)).filter(Boolean).slice(0, 25),
        text: (document.body.innerText || "").slice(-400),
      }));
      console.log("duck-image diag:", JSON.stringify(info), "| raw head:", String(raw || "").replace(/[A-Za-z0-9+\/=]{200,}/g, "<b64>").slice(0, 500));
      await this.debug(page, "image-none");
    } catch {}
  }

  async close() {
    clearInterval(this.sweeper); this.sweeper = null;
    const rd = this.ready; this.ready = [];
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    await Promise.all([...rd.map((p) => p.page.close().catch(() => {})), ...sessions.map((p) => p.page.close().catch(() => {}))]);
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
