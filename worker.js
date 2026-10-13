import { PROVIDERS as FREE_PROVIDERS } from "./free-fallback.mjs";
import DASH from "./dashboard.js";

// free-fallback.mjs ka har provider apna alag model ban jata hai (duck ki tarah),
// name se match hoke seedha us provider ko call hota hai (koi chain/fallback nahi)
const FREE_MODELS = FREE_PROVIDERS.map((p) => p.name);
const isFreeModel = (m) => typeof m === "string" && FREE_MODELS.includes(m);

// runner ka jawab fail maana jaye: null (timeout) ya {error} bina choices ke
function failed(out) {
  if (!out) return true;
  try { const o = JSON.parse(out); return !!o.error && !o.choices; } catch { return true; }
}

// fail hue duck jawab se error message + kind nikalo (header me daalne layak saaf text)
function errInfo(out) {
  let msg = "timeout", kind = "timeout";
  if (out) { try { const o = JSON.parse(out); msg = String(o.error || "error"); kind = o._jaat_kind || "error"; } catch { msg = "bad response"; kind = "error"; } }
  return { msg: msg.replace(/[^\x20-\x7e]/g, " ").slice(0, 160), kind };
}

const DUCK_MODELS = [
  "duck-auto", "gpt-5.6-luna", "gpt-5.4-mini", "claude-haiku-4-5",
  "mistral-small-2603", "tinfoil/gpt-oss-120b", "tinfoil/gemma4-31b",
];
const isDuckModel = (m) => typeof m === "string" && (m.startsWith("duck") || DUCK_MODELS.includes(m));

export class Hub {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.queue = []; this.pollers = []; this.waiters = new Map(); this.leased = new Map();
    this.lastSeen = 0; this.lastDispatch = 0; this.lastRequest = 0; this.duckBadUntil = 0; this.duckBadModel = new Map();
    state.blockConcurrencyWhile(async () => {
      this.lastRequest = (await state.storage.get("lastRequest")) || 0;
      this.keys = (await state.storage.get("keys")) || {};
      this.hourly = (await state.storage.get("hourly")) || {};
      this.logs = (await state.storage.get("logs")) || [];
    });
    this.win = new Map();
  }

  // keys/stats thodi der baad (2s) ek saath save
  save() {
    if (this.st) return;
    this.st = setTimeout(async () => {
      this.st = 0;
      await this.state.storage.put({ keys: this.keys, hourly: this.hourly, logs: this.logs });
    }, 2000);
  }
  bump(err) {
    const h = new Date().toISOString().slice(0, 13);
    const o = this.hourly[h] || (this.hourly[h] = { n: 0, e: 0 });
    err ? o.e++ : o.n++;
    const old = Object.keys(this.hourly).sort().slice(0, -72);
    old.forEach((x) => delete this.hourly[x]);
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;

    // api key check + rate limit (count=true par request gin bhi li jati hai)
    if (p === "/auth") {
      const { key, count } = await req.json();
      const k = Object.values(this.keys).find((x) => x.key === key);
      const no = (status, error) => Response.json({ ok: false, status, error });
      if (!k) return no(401, "invalid api key");
      const now = Date.now();
      if (k.disabled) return no(403, "api key disabled");
      if (k.expiresAt && now > k.expiresAt) return no(403, "api key expired");
      if (count) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (k.day !== day) { k.day = day; k.today = 0; }
        const m = Math.floor(now / 60000), w = this.win.get(k.id) || { m, n: 0 };
        if (w.m !== m) { w.m = m; w.n = 0; }
        if (k.rpm && w.n >= k.rpm) return no(429, "rate limit: " + k.rpm + " requests/min");
        if (k.rpd && k.today >= k.rpd) return no(429, "daily limit: " + k.rpd + " requests/day");
        w.n++; this.win.set(k.id, w); k.today++; k.total++; k.last = now; this.bump(false); this.save();
      }
      return Response.json({ ok: true, id: k.id });
    }

    if (p === "/record") {
      const { id, model, provider, status, ms } = await req.json();
      const k = this.keys[id];
      if (k) { k.models[model] = (k.models[model] || 0) + 1; if (status >= 400) k.err = (k.err || 0) + 1; }
      if (status >= 400) this.bump(true);
      this.logs.unshift({ t: Date.now(), k: k ? k.name : "legacy", m: model, p: provider, s: status, ms });
      this.logs.length = Math.min(this.logs.length, 150);
      this.save();
      return new Response("ok");
    }

    if (p === "/admin") {
      const a = await req.json(), now = Date.now();
      const k = this.keys[a.id];
      if (a.op === "create") {
        const id = crypto.randomUUID().slice(0, 8);
        const b = crypto.getRandomValues(new Uint8Array(16));
        this.keys[id] = { id, key: "sk-jaat-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""), name: String(a.name || "key").slice(0, 40),
          created: now, expiresAt: a.days > 0 ? now + a.days * 864e5 : 0, rpm: a.rpm || 0, rpd: a.rpd || 0, total: 0, today: 0, day: "", err: 0, last: 0, models: {} };
      } else if (k && a.op === "update") {
        if (a.rpm != null) k.rpm = a.rpm;
        if (a.rpd != null) k.rpd = a.rpd;
        if (a.disabled != null) k.disabled = !!a.disabled;
        if (a.days != null) k.expiresAt = a.days > 0 ? now + a.days * 864e5 : 0;
        if (a.name) k.name = String(a.name).slice(0, 40);
      } else if (k && a.op === "reset") { k.total = 0; k.today = 0; k.err = 0; k.models = {}; }
      else if (a.op === "delete") delete this.keys[a.id];
      if (a.op !== "list") { await this.state.storage.put("keys", this.keys); }
      return Response.json({ keys: Object.values(this.keys).sort((x, y) => y.created - x.created), hourly: this.hourly, logs: this.logs, now });
    }

    if (p === "/submit") {
      // body: { provider: "jaat" | "duck" | "free", name: <free provider ka naam, sirf "free" ke liye>,
      //         body: <json string>, fallback: <json string> (sirf duck ke liye) }
      const job = await req.json();
      this.lastRequest = Date.now();
      await this.state.storage.put("lastRequest", this.lastRequest);

      let provider = job.provider === "duck" ? "duck" : job.provider === "free" ? "free" : "jaat";
      let body = job.body;
      const name = job.name; // free provider ka naam (jaise "vireonix", "kilo-ultra")
      const model = String(job.model || "");
      const fb = job.fallback; // duck fail ho to is body se jaat chalega
      const useFallback = fb && (this.env.DUCK_FALLBACK || "1") !== "0";
      const cooldown = Number(this.env.DUCK_COOLDOWN_MS || 5000);
      const duckWait = Number(this.env.DUCK_WAIT_MS || 100000);
      const fp = provider === "free" ? FREE_PROVIDERS.find((x) => x.name === name) : null;
      const freeWait = Number(this.env.FREE_WAIT_MS || ((fp && fp.timeout) || 60000) + 10000);
      const extra = {};

      // duck abhi-abhi fail hua tha -> seedha jaat (har request par duck ka intezaar nahi).
      // Ban poore duck ka cooldown banata hai; baaki error sirf usi model ka.
      if (provider === "duck" && useFallback &&
          (Date.now() < this.duckBadUntil || Date.now() < (this.duckBadModel.get(model) || 0))) {
        provider = "jaat"; body = fb; extra["x-jaat-duck-skipped"] = "cooldown";
      }

      let out = await this.run(provider, body, provider === "duck" ? duckWait : provider === "free" ? freeWait : 180000, name);

      if (provider === "duck" && failed(out)) {
        const e = errInfo(out);
        if (e.kind === "ban") this.duckBadUntil = Date.now() + cooldown;
        else this.duckBadModel.set(model, Date.now() + cooldown);
        extra["x-jaat-duck-error"] = e.msg;
        if (useFallback) { provider = "jaat"; out = await this.run("jaat", fb, 180000); }
      }

      const headers = { "content-type": "application/json", "x-jaat-provider": provider, ...extra };
      return out
        ? new Response(out, { headers })
        : new Response('{"error":"timeout"}', { status: 504, headers });
    }

    if (p === "/next") {
      this.lastSeen = Date.now();
      if (this.queue.length) return Response.json(this.lease(this.queue.shift()));
      return new Promise(res => {
        this.pollers.push(res);
        setTimeout(() => {
          const i = this.pollers.indexOf(res);
          if (i > -1) { this.pollers.splice(i, 1); res(new Response(null, { status: 204 })); }
        }, 15000);
      });
    }

    if (p === "/result") {
      const { id, data } = await req.json();
      this.unlease(id);
      this.waiters.get(id)?.(data);
      return new Response("ok");
    }

    if (p === "/ack") { const { id } = await req.json(); this.unlease(id); return new Response("ok"); }

    if (p === "/status") return Response.json({ lastRequest: this.lastRequest });

    return new Response("not found", { status: 404 });
  }

  // ek job queue me daalo, jawab ya timeout (null) ka intezaar karo
  async run(provider, body, waitMs, name) {
    const id = crypto.randomUUID();
    const done = new Promise(r => this.waiters.set(id, r));
    this.queue.push({ id, provider, name, body });
    this.flush();

    // koi runner nahi sun raha -> naya run start karo
    const now = Date.now();
    if (now - this.lastSeen > 40000 && now - this.lastDispatch > 60000) {
      this.lastDispatch = now;
      try {
        await fetch(`https://api.github.com/repos/${this.env.GH_REPO}/actions/workflows/run.yml/dispatches`, {
          method: "POST",
          headers: { authorization: "Bearer " + this.env.GH_PAT, accept: "application/vnd.github+json", "user-agent": "hub" },
          body: JSON.stringify({ ref: "main" }),
        });
      } catch {}
    }

    const out = await Promise.race([done, new Promise(r => setTimeout(() => r(null), waitMs))]);
    this.waiters.delete(id);
    if (out === null) { const i = this.queue.findIndex(j => j.id === id); if (i > -1) this.queue.splice(i, 1); }
    return out;
  }

  flush() {
    while (this.queue.length && this.pollers.length)
      this.pollers.shift()(Response.json(this.lease(this.queue.shift())));
  }

  // job runner ko diya; 4s me ack na aaye (runner mar chuka tha) to wapas queue me
  lease(job) {
    const timer = setTimeout(() => {
      if (!this.leased.delete(job.id)) return;
      if (this.waiters.has(job.id)) { this.queue.unshift(job); this.flush(); }
    }, 4000);
    this.leased.set(job.id, timer);
    return job;
  }
  unlease(id) { clearTimeout(this.leased.get(id)); this.leased.delete(id); }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const withCors = (r) => {
  const h = new Headers(r.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  return new Response(r.body, { status: r.status, headers: h });
};

async function handle(req, env) {
  const u = new URL(req.url);
  const hub = env.HUB.get(env.HUB.idFromName("hub"));
  const auth = (req.headers.get("authorization") || "").replace("Bearer ", "");
  const legacy = !!env.USER_KEYS && env.USER_KEYS.split(",").includes(auth); // purani USER_KEYS bhi chalti rahengi
  const gate = async (count) => {
    if (legacy) return { ok: true };
    return (await hub.fetch("https://hub/auth", { method: "POST", body: JSON.stringify({ key: auth, count }) })).json();
  };
  const deny = (g) => Response.json({ error: { message: g.error, type: "auth_error" } }, { status: g.status });

  if (u.pathname === "/admin") {
    if (req.method === "GET") return new Response(DASH, { headers: { "content-type": "text/html;charset=utf-8" } });
    if (!env.ADMIN_KEY || auth !== env.ADMIN_KEY) return Response.json({ error: "wrong admin key" }, { status: 401 });
    return hub.fetch("https://hub/admin", { method: "POST", body: req.body });
  }

  if (u.pathname === "/v1/models") {
    const g = await gate(false);
    if (!g.ok) return deny(g);
    return Response.json({
      object: "list",
      data: [
        { id: "jaat-default", object: "model", created: 0, owned_by: "jaat" },
        ...DUCK_MODELS.map(id => ({ id, object: "model", created: 0, owned_by: "duck.ai" })),
        ...FREE_PROVIDERS.map(p => ({ id: p.name, object: "model", created: 0, owned_by: new URL(p.base).hostname })),
      ],
    });
  }

  if (u.pathname === "/v1/chat/completions") {
    let j;
    try { j = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    const g = await gate(true);
    if (!g.ok) return deny(g);
    const t0 = Date.now();
    const wantStream = j.stream === true;
    const duck = isDuckModel(j.model);
    const free = !duck && isFreeModel(j.model);
    const shownModel = duck || free ? j.model : "jaat-default";
    j.stream = false; delete j.stream_options;

    // jaat (vireonix) wali body: model "auto" + cache todne ke liye random note
    const jaatBody = () => {
      const k = { ...j, model: "auto" }; delete k.reasoning_effort; delete k.reasoningEffort; // duck-only field
      k.messages = [{ role: "system", content: "ref " + crypto.randomUUID().slice(0, 8) }, ...(j.messages || [])];
      return JSON.stringify(k);
    };
    const job = duck
      ? { provider: "duck", model: j.model, body: JSON.stringify({ model: j.model, messages: j.messages || [], reasoning_effort: j.reasoning_effort || j.reasoningEffort }), fallback: jaatBody() }
      : free
      ? { provider: "free", name: j.model, body: JSON.stringify({ messages: j.messages || [] }) }
      : { provider: "jaat", body: jaatBody() };

    const r = await hub.fetch("https://hub/submit", { method: "POST", body: JSON.stringify(job) });
    await hub.fetch("https://hub/record", { method: "POST", body: JSON.stringify({ id: g.id, model: shownModel, provider: r.headers.get("x-jaat-provider") || "", status: r.status, ms: Date.now() - t0 }) });
    if (!wantStream || r.status !== 200) return r;

    const d = await r.json();
    const c = d.choices && d.choices[0];
    if (!c) return Response.json(d);
    const base = {
      id: d.id || "chatcmpl-" + crypto.randomUUID(),
      object: "chat.completion.chunk",
      created: d.created || Math.floor(Date.now() / 1000),
      model: shownModel,
    };
    const ev = (x) => "data: " + JSON.stringify({ ...base, ...x }) + "\n\n";
    const body =
      ev({ choices: [{ index: 0, delta: { role: "assistant", content: (c.message && c.message.content) || "" }, finish_reason: null }] }) +
      ev({ choices: [{ index: 0, delta: {}, finish_reason: c.finish_reason || "stop" }] }) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-jaat-provider": r.headers.get("x-jaat-provider") || "", "x-jaat-duck-error": r.headers.get("x-jaat-duck-error") || "", "x-jaat-duck-skipped": r.headers.get("x-jaat-duck-skipped") || "" } });
  }

  if (["/next", "/result", "/ack", "/status"].includes(u.pathname)) {
    if (auth !== env.RUNNER_SECRET) return new Response("no", { status: 401 });
    return hub.fetch("https://hub" + u.pathname, { method: req.method, body: req.method === "POST" ? req.body : undefined });
  }
  return new Response("ok");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    return withCors(await handle(req, env));
  },
};
