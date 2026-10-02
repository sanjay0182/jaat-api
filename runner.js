// Har run ~3 min chalta hai. Agle run ko 2 min par start karta hai (overlap),
// lekin sirf tab jab pichhli request 15 min ke andar aayi ho.
const W = process.env.WORKER;
const H = { authorization: "Bearer " + process.env.RUNNER_SECRET };

const RUN_MS = 3 * 60e3;
const NEXT_AT_MS = 2 * 60e3;
const IDLE_MS = 15 * 60e3;

// vireonix kabhi 5s me, kabhi 50s me jawab deta hai.
// 12s me jawab na aaye to wahi request dobara bhejo, jo pehle de wahi lo.
const URL_UP = "https://vireonix.ai/v1/chat/completions";
const HEDGE_MS = 12000;
const MAX_TRIES = 2;

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
    if (!ok) throw new Error("bad " + u.status);
    return text;
  };

  return new Promise((resolve, reject) => {
    let started = 0, failed = 0, done = false, timer;
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
      }).catch(() => {
        if (done) return;
        failed++;
        if (started < MAX_TRIES) launch();          // fail hua to turant dusri try
        else if (failed >= started) { done = true; reject(new Error("all failed")); }
      });
      if (started < MAX_TRIES) timer = setTimeout(launch, HEDGE_MS); // der ho rahi to dusri try
    };
    launch();
  });
}

// Har request alag chalti hai: loop turant agli request sun'ne lagta hai
async function handle({ id, body }) {
  inflight++;
  const t0 = Date.now();
  let data, tries = 0;
  try {
    const r = await callUpstream(body);
    data = r.text; tries = r.n;
  } catch { data = JSON.stringify({ error: "upstream failed" }); }
  const ms = Date.now() - t0;
  console.log("upstream ms:", ms, "winner try:", tries);
  try { const o = JSON.parse(data); o._jaat_upstream_ms = ms; o._jaat_try = tries; data = JSON.stringify(o); } catch {}
  try {
    await fetch(W + "/result", {
      method: "POST", headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ id, data }),
    });
  } catch {}
  inflight--;
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
  r.json().then(handle).catch(() => {});
}

// chal rahi requests poori hone do, phir band
while (inflight > 0) await sleep(200);
process.exit(0);
