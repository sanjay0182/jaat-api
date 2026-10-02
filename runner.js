// Har run ~3 min chalta hai. Agle run ko 2 min par start karta hai (overlap),
// lekin sirf tab jab pichhli request 15 min ke andar aayi ho.
const W = process.env.WORKER;
const H = { authorization: "Bearer " + process.env.RUNNER_SECRET };

const RUN_MS = 3 * 60e3;
const NEXT_AT_MS = 2 * 60e3;
const IDLE_MS = 15 * 60e3;

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

// Har request alag chalti hai: loop turant agli request sun'ne lagta hai
async function handle({ id, body }) {
  inflight++;
  const t0 = Date.now();
  let data;
  try {
    const u = await fetch("https://vireonix.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*", "user-agent": "curl/8.5.0" },
      body,
    });
    data = await u.text();
  } catch { data = JSON.stringify({ error: "upstream failed" }); }
  const ms = Date.now() - t0;
  console.log("upstream ms:", ms);
  try { const o = JSON.parse(data); o._jaat_upstream_ms = ms; data = JSON.stringify(o); } catch {}
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
