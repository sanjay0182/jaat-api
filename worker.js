export class Hub {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.queue = []; this.pollers = []; this.waiters = new Map();
    this.lastSeen = 0; this.lastDispatch = 0; this.lastRequest = 0;
    state.blockConcurrencyWhile(async () => {
      this.lastRequest = (await state.storage.get("lastRequest")) || 0;
    });
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;

    if (p === "/submit") {
      const id = crypto.randomUUID();
      const done = new Promise(r => this.waiters.set(id, r));
      this.lastRequest = Date.now();
      await this.state.storage.put("lastRequest", this.lastRequest);
      this.queue.push({ id, body: await req.text() });
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

      const out = await Promise.race([done, new Promise(r => setTimeout(() => r(null), 90000))]);
      this.waiters.delete(id);
      return out
        ? new Response(out, { headers: { "content-type": "application/json" } })
        : new Response('{"error":"timeout"}', { status: 504 });
    }

    if (p === "/next") {
      this.lastSeen = Date.now();
      if (this.queue.length) return Response.json(this.queue.shift());
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
      this.waiters.get(id)?.(data);
      return new Response("ok");
    }

    if (p === "/status") return Response.json({ lastRequest: this.lastRequest });

    return new Response("not found", { status: 404 });
  }

  flush() {
    while (this.queue.length && this.pollers.length)
      this.pollers.shift()(Response.json(this.queue.shift()));
  }
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
      data: [{ id: "jaat-default", object: "model", created: 0, owned_by: "jaat" }],
    });
  }

  if (u.pathname === "/v1/chat/completions") {
    if (!isUser) return new Response("unauthorized", { status: 401 });
    let j;
    try { j = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    const wantStream = j.stream === true;
    j.stream = false; delete j.stream_options; j.model = "auto";

    const r = await hub.fetch("https://hub/submit", { method: "POST", body: JSON.stringify(j) });
    if (!wantStream || r.status !== 200) return r;

    const d = await r.json();
    const c = d.choices && d.choices[0];
    if (!c) return Response.json(d);
    const base = {
      id: d.id || "chatcmpl-" + crypto.randomUUID(),
      object: "chat.completion.chunk",
      created: d.created || Math.floor(Date.now() / 1000),
      model: "jaat-default",
    };
    const ev = (x) => "data: " + JSON.stringify({ ...base, ...x }) + "\n\n";
    const body =
      ev({ choices: [{ index: 0, delta: { role: "assistant", content: (c.message && c.message.content) || "" }, finish_reason: null }] }) +
      ev({ choices: [{ index: 0, delta: {}, finish_reason: c.finish_reason || "stop" }] }) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  if (["/next", "/result", "/status"].includes(u.pathname)) {
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
