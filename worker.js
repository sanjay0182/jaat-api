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

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    const auth = (req.headers.get("authorization") || "").replace("Bearer ", "");

    if (u.pathname === "/v1/chat/completions") {
      if (!env.USER_KEYS.split(",").includes(auth)) return new Response("unauthorized", { status: 401 });
      return hub.fetch("https://hub/submit", { method: "POST", body: await req.text() });
    }
    if (["/next", "/result", "/status"].includes(u.pathname)) {
      if (auth !== env.RUNNER_SECRET) return new Response("no", { status: 401 });
      return hub.fetch("https://hub" + u.pathname, { method: req.method, body: req.method === "POST" ? req.body : undefined });
    }
    return new Response("ok");
  },
};
