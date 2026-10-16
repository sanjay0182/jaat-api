// Har run ~3 min chalta hai. Agle run ko 2 min par start karta hai (overlap),
// lekin sirf tab jab pichhli request 15 min ke andar aayi ho.
import { DuckClient } from "./duck.js";
import { PplxClient } from "./perplexity.js";
import { VeniceClient } from "./venice.js";
import { PROVIDERS as FREE_PROVIDERS } from "./free-fallback.mjs";
import { callFree } from "./free-call.mjs";

const W = process.env.WORKER;
const H = { authorization: "Bearer " + process.env.RUNNER_SECRET };

const RUN_MS = Number(process.env.RUN_MS || 3 * 60e3);
const NEXT_AT_MS = Number(process.env.NEXT_AT_MS || 2 * 60e3);
const IDLE_MS = 15 * 60e3;

// vireonix kabhi 5s me, kabhi 50s me jawab deta hai.
// 12s me jawab na aaye to wahi request dobara bhejo, jo pehle de wahi lo.
const URL_UP = process.env.JAAT_UPSTREAM || "https://vireonix.ai/v1/chat/completions";
const HEDGE_MS = 10000;
const MAX_TRIES = 1; // 1 = normal mode, ek request ke liye vireonix ko sirf ek call

// duck.ai provider (real Chrome). Pehli duck request par hi chrome khulta hai.
const duck = new DuckClient();
const DUCK_TIMEOUT_MS = Number(process.env.DUCK_TIMEOUT_MS || 80000);
const DUCK_IMAGE_TIMEOUT_MS = Number(process.env.DUCK_IMAGE_TIMEOUT_MS || 150000);

// perplexity.ai provider (real Chrome, basic chat). Chrome pehli pplx request par hi khulta hai.
const pplx = new PplxClient();
const PPLX_TIMEOUT_MS = Number(process.env.PPLX_TIMEOUT_MS || 130000);
// venice provider (DeepSeek V4, real Chrome, basic chat)
const venice = new VeniceClient();
const VENICE_TIMEOUT_MS = Number(process.env.VENICE_TIMEOUT_MS || 130000);

const start = Date.now();
duck.warmup(); // chrome + duck.ai page pehle se tayyar (background)
// duck.ai ka asli model catalog (page ke network response se) worker ko bhejo. Na mile to hardcoded fallback chalta hai.
// Runner har ~3 min rotate hota hai, isliye har run me ek baar (start ke baad) publish; lamba run ho to 10 min me dobara.
async function publishDuckModels() {
  try {
    const models = await duck.discoverModels();
    if (models.length) await fetch(W + "/models", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ models }) });
  } catch (e) { console.log("duck model catalog update skipped:", e.message); }
}
publishDuckModels();
const modelRefresh = setInterval(publishDuckModels, 10 * 60e3); modelRefresh.unref?.();
let dispatched = false;
let inflight = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastRequestAgo() {
  try {
    const r = await fetch(W + "/status", { headers: H });
    const j = await r.json();
    return Date.now() - j.lastRequest;
  } catch { return 0; }
}

async function dispatchNext() {
  try {
    await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/run.yml/dispatches`, {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "r" },
      body: JSON.stringify({ ref: "main" }),
    });
  } catch {}
}

function callUpstream(body) {
  const ctrls = [];
  const attempt = async (c) => {
    const u = await fetch(URL_UP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*", "user-agent": "curl/8.5.0" },
      body,
      signal: c.signal,
    });
    const text = await u.text();
    let ok = false;
    try { ok = u.ok && !!JSON.parse(text).choices; } catch {}
    if (!ok) throw new Error("vireonix " + u.status + ": " + ((/<title>([\s\S]*?)<\/title>/.exec(text) || [])[1] || text.slice(0, 200)).trim());
    return text;
  };

  return new Promise((resolve, reject) => {
    let started = 0, failed = 0, done = false, timer, lastErr = "";
    const launch = () => {
      if (done || started >= MAX_TRIES) return;
      clearTimeout(timer);
      const n = ++started;
      const c = new AbortController();
      ctrls.push(c);
      attempt(c).then((text) => {
        if (done) return;
        done = true; clearTimeout(timer);
        ctrls.forEach((x) => x.abort());
        resolve({ text, n });
      }).catch((e) => {
        if (done) return;
        lastErr = String((e && e.message) || e);
        failed++;
        if (started < MAX_TRIES) launch();          // fail hua to turant dusri try
        else if (failed >= started) { done = true; reject(new Error(lastErr || "all failed")); }
      });
      if (started < MAX_TRIES) timer = setTimeout(launch, HEDGE_MS); // der ho rahi to dusri try
    };
    launch();
  });
}

const FREE_TIMEOUT_MS = Number(process.env.FREE_TIMEOUT_MS || 60000); // provider me "timeout" ho to wahi chalta hai

// duck stream: deltas ko ~120ms me batch karke worker ke /chunk par bhejo.
// Pehla delta turant jata hai (first-token fast), baaki batch me. chain se order same rehta hai.
function makeSink(id) {
  let buf = "", seq = 0, timer = null, chain = Promise.resolve();
  const push = () => {
    timer = null;
    if (!buf) return;
    const delta = buf, s = seq++; buf = "";
    chain = chain.then(() =>
      fetch(W + "/chunk", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ id, delta, seq: s }) }).catch(() => {})
    );
  };
  return {
    add(t) { buf += t; if (seq === 0) push(); else if (!timer) timer = setTimeout(push, 120); },
    async end() { clearTimeout(timer); push(); await chain; }, // /result se pehle saare chunks pahunch jayen
  };
}

// Har request alag chalti hai: loop turant agli request sun'ne lagta hai
async function handle({ id, provider, name, body, stream }) {
  // job milte hi worker ko ack (nahi to worker 4s baad job dusre runner ko de deta hai)
  fetch(W + "/ack", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  const t0 = Date.now();
  let data, tries = 0;
  const sink = provider === "duck" && stream ? makeSink(id) : null; // sirf duck + stream=true par
  try {
    if (provider === "duck") {
      const j = JSON.parse(body);
      // tools ke saath jawab tool_call ho sakta hai, isliye real stream sirf tab jab tools na ho (ya tool_choice none)
      const canStream = sink && (!j.tools?.length || j.tool_choice === "none");
      data = await duck.chat({ model: j.model, messages: j.messages, reasoning_effort: j.reasoning_effort, conversation_id: j.conversation_id, tools: j.tools, tool_choice: j.tool_choice, legacy_fn: j.legacy_fn, onDelta: canStream ? sink.add : undefined }, DUCK_TIMEOUT_MS);
    } else if (provider === "duck-image") {
      const j = JSON.parse(body);
      data = await duck.image(j.prompt, DUCK_IMAGE_TIMEOUT_MS, j.size); // {b64_json,mime} ya {url}; image na mile to error (fake nahi)
    } else if (provider === "venice") {
      const j = JSON.parse(body);
      data = await venice.chat({ model: j.model, messages: j.messages }, VENICE_TIMEOUT_MS);
    } else if (provider === "perplexity") {
      const j = JSON.parse(body);
      data = await pplx.chat({ model: j.model, messages: j.messages }, PPLX_TIMEOUT_MS);
    } else if (provider === "free") {
      const p = FREE_PROVIDERS.find((x) => x.name === name);
      if (!p) throw new Error("free model '" + name + "' PROVIDERS list me nahi mila");
      data = await callFree(p, body, p.timeout || FREE_TIMEOUT_MS);
    } else {
      const r = await callUpstream(body);
      data = r.text; tries = r.n;
    }
  } catch (e) {
    console.log(provider + " error:", e.message);
    data = JSON.stringify({ error: String(e.message || "upstream failed"), _jaat_kind: e.kind || "error" });
  }
  if (sink) await sink.end(); // error aaye tab bhi pehle bache chunks bhejo, phir final /result
  const ms = Date.now() - t0;
  console.log(provider || "jaat", "ms:", ms, "winner try:", tries);
  try { const o = JSON.parse(data); o._jaat_upstream_ms = ms; o._jaat_try = tries; data = JSON.stringify(o); } catch {}
  try {
    await fetch(W + "/result", {
      method: "POST", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ id, data }),
    });
  } catch {}
}

while (true) {
  const el = Date.now() - start;

  if (el > NEXT_AT_MS && !dispatched) {
    dispatched = true;
    if ((await lastRequestAgo()) < IDLE_MS) await dispatchNext();
  }
  if (el > RUN_MS) break;

  let r;
  try { r = await fetch(W + "/next", { headers: H }); } catch { await sleep(1000); continue; }
  if (r.status !== 200) continue;
  inflight++; // turant, json parse se pehle: nahi to runner job leke exit ho sakta hai
  r.json().then(handle).catch(() => {}).finally(() => { inflight--; });
}

// chal rahi requests poori hone do, phir band
while (inflight > 0) await sleep(200);
clearInterval(modelRefresh);
await duck.close();
await pplx.close();
await venice.close();
process.exit(0);
