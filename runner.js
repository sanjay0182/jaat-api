// Har run ~3 min chalta hai. Agle run ko 2 min par start karta hai (overlap),
// lekin sirf tab jab pichhli request 15 min ke andar aayi ho.
import { DuckClient } from "./duck.js";

const W = process.env.WORKER;
const H = { authorization: "Bearer " + process.env.RUNNER_SECRET };

const RUN_MS = Number(process.env.RUN_MS || 3 * 60e3);
const NEXT_AT_MS = 2 * 60e3;
const IDLE_MS = 15 * 60e3;

// vireonix kabhi 5s me, kabhi 50s me jawab deta hai.
// 12s me jawab na aaye to wahi request dobara bhejo, jo pehle de wahi lo.
const URL_UP = process.env.JAAT_UPSTREAM || "https://vireonix.ai/v1/chat/completions";
const HEDGE_MS = 10000;
const MAX_TRIES = 1; // 1 = normal mode, ek request ke liye vireonix ko sirf ek call

// duck.ai provider (real Chrome). Pehli duck request par hi chrome khulta hai.
const duck = new DuckClient();
const DUCK_TIMEOUT_MS = Number(process.env.DUCK_TIMEOUT_MS || 80000);

const start = Date.now();
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
    if (!ok) throw new Error("upstream " + u.status + ": " + text.slice(0, 300));
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

// Har request alag chalti hai: loop turant agli request sun'ne lagta hai
async function handle({ id, provider, body }) {
  // job milte hi worker ko ack (nahi to worker 4s baad job dusre runner ko de deta hai)
  fetch(W + "/ack", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  const t0 = Date.now();
  let data, tries = 0;
  try {
    if (provider === "duck") {
      const j = JSON.parse(body);
      data = await duck.chat({ model: j.model, messages: j.messages }, DUCK_TIMEOUT_MS);
    } else {
      const r = await callUpstream(body);
      data = r.text; tries = r.n;
    }
  } catch (e) {
    console.log(provider === "duck" ? "duck error:" : "upstream error:", e.message);
    data = JSON.stringify({ error: String(e.message || "upstream failed"), _jaat_kind: e.kind || "error" });
  }
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
await duck.close();
process.exit(0);
