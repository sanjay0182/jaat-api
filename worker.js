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
    });
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;

    if (p === "/submit") {
      // body: { provider: "jaat" | "duck", body: <json string>, fallback: <json string> (sirf duck ke liye) }
      const job = await req.json();
      this.lastRequest = Date.now();
      await this.state.storage.put("lastRequest", this.lastRequest);

      let provider = job.provider === "duck" ? "duck" : "jaat";
      let body = job.body;
      const model = String(job.model || "");
      const fb = job.fallback; // duck fail ho to is body se jaat chalega
      const useFallback = fb && (this.env.DUCK_FALLBACK || "1") !== "0";
      const cooldown = Number(this.env.DUCK_COOLDOWN_MS || 120000);
      const duckWait = Number(this.env.DUCK_WAIT_MS || 100000);
      const extra = {};

      // duck abhi-abhi fail hua tha -> seedha jaat (har request par duck ka intezaar nahi).
      // Ban poore duck ka cooldown banata hai; baaki error sirf usi model ka.
      if (provider === "duck" && useFallback &&
          (Date.now() < this.duckBadUntil || Date.now() < (this.duckBadModel.get(model) || 0))) {
        provider = "jaat"; body = fb; extra["x-jaat-duck-skipped"] = "cooldown";
      }

      let out = await this.run(provider, body, provider === "duck" ? duckWait : 180000);

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
  async run(provider, body, waitMs) {
    const id = crypto.randomUUID();
    const done = new Promise(r => this.waiters.set(id, r));
    this.queue.push({ id, provider, body });
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
  const isUser = env.USER_KEYS.split(",").includes(auth);

  if (u.pathname === "/v1/models") {
    if (!isUser) return new Response("unauthorized", { status: 401 });
    return Response.json({
      object: "list",
      data: [
        { id: "jaat-default", object: "model", created: 0, owned_by: "jaat" },
        ...DUCK_MODELS.map(id => ({ id, object: "model", created: 0, owned_by: "duck.ai" })),
      ],
    });
  }

  if (u.pathname === "/v1/chat/completions") {
    if (!isUser) return new Response("unauthorized", { status: 401 });
    let j;
    try { j = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    const wantStream = j.stream === true;
    const duck = isDuckModel(j.model);
    const shownModel = duck ? j.model : "jaat-default";
    j.stream = false; delete j.stream_options;

    // jaat (vireonix) wali body: model "auto" + cache todne ke liye random note
    const jaatBody = () => {
      const k = { ...j, model: "auto" };
      k.messages = [{ role: "system", content: "ref " + crypto.randomUUID().slice(0, 8) }, ...(j.messages || [])];
      return JSON.stringify(k);
    };
    const job = duck
      ? { provider: "duck", model: j.model, body: JSON.stringify({ model: j.model, messages: j.messages || [] }), fallback: jaatBody() }
      : { provider: "jaat", body: jaatBody() };

    const r = await hub.fetch("https://hub/submit", { method: "POST", body: JSON.stringify(job) });
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
