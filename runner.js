// Har run ~3 min chalta hai. Agle run ko 2 min par start karta hai (overlap),
// lekin sirf tab jab pichhli request 15 min ke andar aayi ho.
const W = process.env.WORKER;
const H = { authorization: "Bearer " + process.env.RUNNER_SECRET };

const RUN_MS = 3 * 60e3;        // ye run kitni der chalega
const NEXT_AT_MS = 2 * 60e3;    // is time par agla run start karo
const IDLE_MS = 15 * 60e3;      // itni der request na aaye to chain band

const start = Date.now();
let dispatched = false;

async function lastRequestAgo() {
  try {
    const r = await fetch(W + "/status", { headers: H });
    const j = await r.json();
    return Date.now() - j.lastRequest;
  } catch { return 0; } // error ho to chain chalti rakho
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

while (true) {
  const el = Date.now() - start;

  if (el > NEXT_AT_MS && !dispatched) {
    dispatched = true;
    if ((await lastRequestAgo()) < IDLE_MS) await dispatchNext();
  }
  if (el > RUN_MS) process.exit(0); // naya kaam mat lo; pichhli request poori ho chuki hai

  let r;
  try { r = await fetch(W + "/next", { headers: H }); } catch { continue; }
  if (r.status !== 200) continue;

  const { id, body } = await r.json();
  let data;
  const t0 = Date.now();
  try {
    const u = await fetch("https://vireonix.ai/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body });
    data = await u.text();
  } catch { data = JSON.stringify({ error: "upstream failed" }); }
  const ms = Date.now() - t0;
  console.log("upstream ms:", ms);
  try { const o = JSON.parse(data); o._jaat_upstream_ms = ms; data = JSON.stringify(o); } catch {}

  await fetch(W + "/result", {
    method: "POST", headers: { ...H, "content-type": "application/json" },
    body: JSON.stringify({ id, data }),
  });
}
