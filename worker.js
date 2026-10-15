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
  return { msg: msg.replace(/[^\x20-\x7e]/g, " ").slice(0, 600), kind };
}

const DUCK_MODELS = [
  "duck-auto", "gpt-5.6-luna", "gpt-5.4-mini", "claude-haiku-4-5",
  "mistral-small-2603", "tinfoil/gpt-oss-120b", "tinfoil/gemma4-31b",
];
// duck.js ke ALIAS jaise naam (claude-sonnet, gpt-4o...) bhi duck par jayen - /v1/messages ke liye zaroori
const DUCK_ALIASES = ["gpt-5.6", "gpt-5.4", "gpt-5", "gpt-4o", "gpt-4o-mini", "o3-mini", "claude-haiku", "claude-sonnet", "claude-opus", "mistral-small", "gpt-oss-120b", "gemma4-31b"];
const isDuckModel = (m) => typeof m === "string" && (m.startsWith("duck") || DUCK_MODELS.includes(m) || DUCK_ALIASES.includes(m) || /^claude-/.test(m) || /^(gpt-|o\d)/.test(m));

// perplexity.ai provider (real Chrome, basic chat, no tools/streaming/session-reuse)
const PPLX_MODELS = ["pplx-auto", "perplexity"];
const isPplxModel = (m) => typeof m === "string" && (m.startsWith("pplx") || PPLX_MODELS.includes(m));
// legacy functions/function_call -> tools/tool_choice (sirf duck ke liye; free providers ko body untouched)
function normalizeLegacy(j) {
  if (j.tools || !Array.isArray(j.functions) || !j.functions.length) return { j, legacy: false };
  const o = { ...j }, fc = o.function_call;
  o.tools = o.functions.map((f) => ({ type: "function", function: f }));
  o.tool_choice = fc === "none" ? "none" : fc && fc.name ? { type: "function", function: { name: fc.name } } : "auto";
  delete o.functions; delete o.function_call;
  return { j: o, legacy: true };
}
const MODELS_TTL_MS = 3600e3; // live catalog 1 ghante se purana ho to fallback list

// stream state ko ek event (naya chunk / final result) tak ya ms tak ruko
function waitEvt(st, ms) {
  return new Promise((r) => {
    const t = setTimeout(() => { st.wake = null; r(); }, Math.max(1, ms));
    st.wake = () => { clearTimeout(t); st.wake = null; r(); };
  });
}

export class Hub {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.queue = []; this.pollers = []; this.waiters = new Map(); this.leased = new Map();
    this.streams = new Map(); // job id -> { chunks:[], last, fin, data, wake } (real streaming buffer)
    this.duckModels = []; this.duckModelsAt = 0;
    this.lastSeen = 0; this.lastDispatch = 0; this.lastRequest = 0;
    state.blockConcurrencyWhile(async () => {
      this.lastRequest = (await state.storage.get("lastRequest")) || 0;
      this.keys = (await state.storage.get("keys")) || {};
      this.hourly = (await state.storage.get("hourly")) || {};
      this.logs = (await state.storage.get("logs")) || [];
      this.duckModels = (await state.storage.get("duckModels")) || [];
      this.duckModelsAt = (await state.storage.get("duckModelsAt")) || 0;
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

    if (p === "/models") {
      if (req.method === "GET") { const fresh = Date.now() - (this.duckModelsAt || 0) < MODELS_TTL_MS; return Response.json({ models: fresh ? this.duckModels || [] : [], updatedAt: this.duckModelsAt || 0 }); }
      const body = await req.json().catch(() => ({}));
      const models = Array.isArray(body.models) ? body.models.filter(x => typeof x === "string" || (x && typeof x.id === "string")) : [];
      if (models.length) { this.duckModels = models.slice(0, 200); this.duckModelsAt = Date.now(); await this.state.storage.put({ duckModels: this.duckModels, duckModelsAt: this.duckModelsAt }); }
      return Response.json({ ok: true, count: this.duckModels.length });
    }

    if (p === "/submit") {
      // body: { provider: "jaat" | "duck" | "free", name, model, body }
      // Jis provider ko request gayi, wahi jawab dega. Koi fallback nahi: fail hua to uska asli error.
      const job = await req.json();
      this.lastRequest = Date.now();
      await this.state.storage.put("lastRequest", this.lastRequest);

      const provider = job.provider === "duck-image" ? "duck-image" : job.provider === "duck" ? "duck" : job.provider === "perplexity" ? "perplexity" : job.provider === "free" ? "free" : "jaat";
      const name = job.name; // free provider ka naam
      const model = String(job.model || "");
      const duckWait = Number(this.env.DUCK_WAIT_MS || 100000);
      const pplxWait = Number(this.env.PPLX_WAIT_MS || 140000);
      const fp = provider === "free" ? FREE_PROVIDERS.find((x) => x.name === name) : null;
      const freeWait = Number(this.env.FREE_WAIT_MS || ((fp && fp.timeout) || 600000) + 100000);
      const label = provider === "free" ? name : provider === "duck" ? model : provider === "duck-image" ? "duck-image" : provider === "perplexity" ? model : "vireonix";

      const wait = provider === "duck-image" ? Number(this.env.DUCK_IMAGE_WAIT_MS || 240000) : provider === "duck" ? duckWait : provider === "perplexity" ? pplxWait : provider === "free" ? freeWait : 180000;

      // real streaming: sirf duck + stream=true. Pehla chunk aane tak normal (JSON error / fake-stream fallback) rasta
      if (provider === "duck" && job.stream === true) {
        const { id, done } = await this.enqueue(provider, job.body, name, true);
        const st = this.streams.get(id);
        const deadline = Date.now() + wait;
        while (!st.chunks.length && !st.fin && Date.now() < deadline) await waitEvt(st, deadline - Date.now());
        if (!st.chunks.length) { // koi chunk nahi aaya: final result (ya timeout) ko normal tareeke se lautao
          const out = st.fin ? st.data : null;
          this.cleanup(id);
          return this.reply(out, provider, label);
        }
        return this.streamResponse(id, st, deadline, model, label);
      }

      const out = await this.run(provider, job.body, wait, name);
      return this.reply(out, provider, label);
    }

    // runner se aaye delta chunks (batched). seq se duplicate/purane chunk ignore
    if (p === "/chunk") {
      const { id, delta, seq } = await req.json();
      const st = this.streams.get(id);
      if (st && typeof delta === "string" && delta && !(seq <= st.last)) {
        st.last = seq; st.chunks.push(delta); st.wake?.();
      }
      return new Response("ok");
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
      const st = this.streams.get(id);
      if (st) { st.fin = true; st.data = data; st.wake?.(); }
      this.waiters.get(id)?.(data);
      return new Response("ok");
    }

    if (p === "/ack") { const { id } = await req.json(); this.unlease(id); return new Response("ok"); }

    if (p === "/status") return Response.json({ lastRequest: this.lastRequest });

    return new Response("not found", { status: 404 });
  }

  // job queue me daalo (+ zarurat ho to naya runner dispatch). { id, done } lautata hai
  async enqueue(provider, body, name, stream) {
    const id = crypto.randomUUID();
    const done = new Promise(r => this.waiters.set(id, r));
    if (stream) this.streams.set(id, { chunks: [], last: -1, fin: false, data: null, wake: null });
    this.queue.push({ id, provider, name, body, stream: !!stream });
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
    return { id, done };
  }

  // job ka saaf-safai: waiter, stream buffer, aur agar queue me hi pada ho to wahan se bhi
  cleanup(id) {
    this.waiters.delete(id); this.streams.delete(id);
    const i = this.queue.findIndex(j => j.id === id);
    if (i > -1) this.queue.splice(i, 1);
  }

  // ek job queue me daalo, jawab ya timeout (null) ka intezaar karo
  async run(provider, body, waitMs, name) {
    const { id, done } = await this.enqueue(provider, body, name, false);
    const out = await Promise.race([done, new Promise(r => setTimeout(() => r(null), waitMs))]);
    this.cleanup(id);
    return out;
  }

  // runner ka final jawab -> HTTP Response (pehle /submit me inline tha, ab stream wale path se bhi use hota hai)
  reply(out, provider, label) {
    const headers = { "content-type": "application/json", "x-jaat-provider": provider };
    if (!out) {
      return new Response(JSON.stringify({ error: { message: label + ": timeout (koi jawab nahi aaya)", type: "timeout", provider: label } }), { status: 504, headers });
    }
    if (failed(out)) {
      const e = errInfo(out);
      headers["x-jaat-error"] = e.msg;
      // error kind -> sahi HTTP status: ratelimit=429, challenge/ban/forbidden=403, timeout=504, baaki 502
      const status = e.kind === "ratelimit" ? 429 : /^(challenge|ban|forbidden)$/.test(e.kind) ? 403 : e.kind === "timeout" ? 504 : 502;
      if (status === 429) headers["retry-after"] = "60";
      return new Response(JSON.stringify({ error: { message: label + ": " + e.msg, type: e.kind, provider: label } }), { status, headers });
    }
    return new Response(out, { headers });
  }

  // asli SSE: OpenAI chunk format. role delta -> content deltas -> finish chunk -> [DONE]. Beech me error aaye to error event + [DONE]
  streamResponse(id, st, deadline, model, label) {
    const enc = new TextEncoder();
    const cid = "chatcmpl-" + crypto.randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const ev = (x) => enc.encode("data: " + JSON.stringify({ id: cid, object: "chat.completion.chunk", created, model, ...x }) + "\n\n");
    const errEv = (message, type) => enc.encode("data: " + JSON.stringify({ error: { message: label + ": " + message, type, provider: label } }) + "\n\n");
    const hub = this;
    let cancelled = false;
    return new Response(new ReadableStream({
      async start(ctrl) {
        try {
          ctrl.enqueue(ev({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
          let pos = 0, timedOut = false;
          while (!cancelled) {
            while (pos < st.chunks.length) ctrl.enqueue(ev({ choices: [{ index: 0, delta: { content: st.chunks[pos++] }, finish_reason: null }] }));
            if (st.fin) break;
            if (Date.now() >= deadline) { timedOut = true; break; }
            await waitEvt(st, deadline - Date.now());
          }
          if (!cancelled) {
            if (timedOut) ctrl.enqueue(errEv("timeout (stream beech me ruk gayi)", "timeout"));
            else {
              let err = null, fr = "stop";
              try {
                const o = JSON.parse(st.data);
                if (o.error && !o.choices) err = { msg: String(o.error).replace(/[^\x20-\x7e]/g, " ").slice(0, 160), kind: o._jaat_kind || "error" };
                else fr = (o.choices && o.choices[0] && o.choices[0].finish_reason) || "stop";
              } catch { err = { msg: "bad response", kind: "error" }; }
              ctrl.enqueue(err ? errEv(err.msg, err.kind) : ev({ choices: [{ index: 0, delta: {}, finish_reason: fr }] }));
            }
            ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
          }
        } catch {}
        hub.cleanup(id);
        try { ctrl.close(); } catch {}
      },
      cancel() { cancelled = true; st.wake?.(); hub.cleanup(id); }, // client chala gaya
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", "x-jaat-provider": "duck", "x-jaat-stream": "1" } });
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

// ---- Anthropic / Responses <-> OpenAI chat translators ----------------------------------
const textBlocks = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => typeof b === "string" ? b : (b && (b.text ?? b.input_text ?? b.output_text)) || "").filter(Boolean).join("\n") : "";
const rid = (p) => p + crypto.randomUUID().replace(/-/g, "").slice(0, 24);

function anthropicToChat(a) {
  const messages = [];
  if (a.system) messages.push({ role: "system", content: textBlocks(a.system) });
  for (const m of a.messages || []) {
    if (!Array.isArray(m.content)) { messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" }); continue; }
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const t = textBlocks(m.content.filter((b) => b.type === "text"));
      messages.push({ role: "assistant", content: t || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content.filter((x) => x.type === "tool_result")) // tool results pehle (tool_use ke turant baad)
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + textBlocks(b.content) });
      const t = textBlocks(m.content.filter((x) => x.type === "text"));
      if (t) messages.push({ role: "user", content: t });
    }
  }
  const tools = (a.tools || []).filter((t) => t && t.name).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } } }));
  const tc = a.tool_choice;
  const tool_choice = !tc || !tools.length ? undefined : tc.type === "none" ? "none" : tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : "auto";
  return { messages, tools, tool_choice };
}

function responsesToChat(a) {
  const messages = [];
  if (a.instructions) messages.push({ role: "system", content: a.instructions });
  const items = typeof a.input === "string" ? [{ role: "user", content: a.input }] : Array.isArray(a.input) ? a.input : [];
  for (const it of items) {
    if (it.type === "function_call") {
      const call = { id: it.call_id || it.id, type: "function", function: { name: it.name, arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments || {}) } };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && last.tool_calls && last.content == null) last.tool_calls.push(call); // parallel calls ek message me
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (it.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: it.call_id, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
    } else if (it.role || it.type === "message") {
      messages.push({ role: it.role || "user", content: textBlocks(it.content) });
    }
  }
  // Responses ke tools flat hote hain {type,name,parameters}; chat ke nested
  const tools = (a.tools || []).filter((t) => t && t.type === "function" && (t.name || t.function?.name)).map((t) => t.function ? t : { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } } });
  const tc = a.tool_choice;
  const tool_choice = !tc || !tools.length ? undefined : typeof tc === "string" ? tc : tc.type === "function" ? { type: "function", function: { name: tc.name || tc.function?.name } } : "auto";
  return { messages, tools, tool_choice };
}

// OpenAI SSE ko Anthropic / Responses events me badlo. Text + tool_calls dono, error par saaf end.
function translateStream(r, kind, model) {
  const dec = new TextDecoder(), enc = new TextEncoder(), anth = kind === "anthropic";
  const reader = r.body.getReader();
  const respId = rid(anth ? "msg_" : "resp_"), created = Math.floor(Date.now() / 1000);
  return new ReadableStream({
    async start(ctrl) {
      let seqn = 0, started = false, finished = false, full = "", outTok = 0;
      const send = (event, data) => { if (!anth) data.sequence_number = seqn++; ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
      // anthropic state
      let nextIdx = 0, textIdx = -1, textOpen = false;
      const aTools = new Map(); // openai tool index -> {idx,open}
      // responses state
      const items = []; let msgItem = null, msgOi = -1;
      const rTools = new Map(); // openai tool index -> {item, oi, args}
      const respObj = (status) => ({ id: respId, object: "response", created_at: created, status, model, output: status === "completed" ? items.map((x) => x.final || x) : [], ...(status === "completed" ? { output_text: full } : {}) });

      const begin = () => {
        if (started) return; started = true;
        if (anth) send("message_start", { type: "message_start", message: { id: respId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        else { send("response.created", { type: "response.created", response: respObj("in_progress") }); send("response.in_progress", { type: "response.in_progress", response: respObj("in_progress") }); }
      };
      const closeMsgR = () => {
        if (!msgItem) return;
        const part = { type: "output_text", text: full, annotations: [] };
        send("response.output_text.done", { type: "response.output_text.done", item_id: msgItem.id, output_index: msgOi, content_index: 0, text: full });
        send("response.content_part.done", { type: "response.content_part.done", item_id: msgItem.id, output_index: msgOi, content_index: 0, part });
        msgItem.final = { ...msgItem, status: "completed", content: [part] };
        send("response.output_item.done", { type: "response.output_item.done", output_index: msgOi, item: msgItem.final });
        msgItem = null;
      };
      const onText = (t) => {
        begin(); full += t; outTok += Math.ceil(t.length / 4);
        if (anth) {
          if (!textOpen) { textOpen = true; textIdx = nextIdx++; send("content_block_start", { type: "content_block_start", index: textIdx, content_block: { type: "text", text: "" } }); }
          send("content_block_delta", { type: "content_block_delta", index: textIdx, delta: { type: "text_delta", text: t } });
        } else {
          if (!msgItem) {
            msgOi = items.length; msgItem = { id: rid("msg_"), type: "message", status: "in_progress", role: "assistant", content: [] }; items.push(msgItem);
            send("response.output_item.added", { type: "response.output_item.added", output_index: msgOi, item: msgItem });
            send("response.content_part.added", { type: "response.content_part.added", item_id: msgItem.id, output_index: msgOi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          send("response.output_text.delta", { type: "response.output_text.delta", item_id: msgItem.id, output_index: msgOi, content_index: 0, delta: t });
        }
      };
      const onTool = (tc) => {
        begin();
        const i = tc.index ?? 0, name = tc.function?.name, args = tc.function?.arguments || "";
        if (anth) {
          if (textOpen) { send("content_block_stop", { type: "content_block_stop", index: textIdx }); textOpen = false; }
          let st = aTools.get(i);
          if (!st) { st = { idx: nextIdx++, open: true }; aTools.set(i, st); send("content_block_start", { type: "content_block_start", index: st.idx, content_block: { type: "tool_use", id: tc.id || rid("toolu_"), name: name || "", input: {} } }); }
          if (args) send("content_block_delta", { type: "content_block_delta", index: st.idx, delta: { type: "input_json_delta", partial_json: args } });
        } else {
          closeMsgR();
          let st = rTools.get(i);
          if (!st) {
            const item = { id: rid("fc_"), type: "function_call", status: "in_progress", call_id: tc.id || rid("call_"), name: name || "", arguments: "" };
            st = { item, oi: items.length, args: "" }; items.push(item); rTools.set(i, st);
            send("response.output_item.added", { type: "response.output_item.added", output_index: st.oi, item });
          }
          if (args) { st.args += args; send("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: st.item.id, output_index: st.oi, delta: args }); }
        }
      };
      const finish = (fr) => {
        if (finished) return; finished = true; begin();
        if (anth) {
          if (textOpen) send("content_block_stop", { type: "content_block_stop", index: textIdx });
          for (const st of aTools.values()) send("content_block_stop", { type: "content_block_stop", index: st.idx });
          send("message_delta", { type: "message_delta", delta: { stop_reason: fr === "tool_calls" || fr === "function_call" ? "tool_use" : fr === "length" ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: outTok || Math.ceil(full.length / 4) } });
          send("message_stop", { type: "message_stop" });
        } else {
          closeMsgR();
          for (const st of rTools.values()) {
            send("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: st.item.id, output_index: st.oi, arguments: st.args });
            st.item.final = { ...st.item, status: "completed", arguments: st.args };
            send("response.output_item.done", { type: "response.output_item.done", output_index: st.oi, item: st.item.final });
          }
          send("response.completed", { type: "response.completed", response: { ...respObj("completed"), usage: { input_tokens: 0, output_tokens: outTok || Math.ceil(full.length / 4), total_tokens: outTok || Math.ceil(full.length / 4) } } });
        }
      };
      const fail = (message) => {
        if (finished) return;
        begin();
        if (anth) send("error", { type: "error", error: { type: "api_error", message } });
        else send("response.failed", { type: "response.failed", response: { ...respObj("failed"), error: { code: "server_error", message } } });
        if (anth) finish("stop"); else finished = true; // anthropic: error ke baad message_stop bhi do
      };
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split("\n").find((x) => x.startsWith("data: "));
            if (!line) continue;
            const raw = line.slice(6);
            if (raw === "[DONE]") continue;
            let ev; try { ev = JSON.parse(raw); } catch { continue; }
            if (ev.error) { fail(String(ev.error.message || ev.error)); continue; }
            const c = ev.choices && ev.choices[0];
            if (!c) continue;
            const d = c.delta || {};
            if (d.content) onText(d.content);
            if (Array.isArray(d.tool_calls)) d.tool_calls.forEach(onTool);
            if (d.function_call) onTool({ index: 0, id: rid("call_"), function: d.function_call }); // legacy
            if (c.finish_reason) finish(c.finish_reason);
          }
        }
        finish("stop"); // upstream bina finish_reason ke band hui
      } catch (e) { fail(String((e && e.message) || e)); }
      finally { try { ctrl.close(); } catch {} }
    },
    cancel() { try { reader.cancel(); } catch {} },
  });
}

// non-stream chat.completion -> Anthropic message / Responses object
function translateFull(data, kind, model) {
  const c = data.choices?.[0], m = c?.message || { content: "" };
  const calls = m.tool_calls || (m.function_call ? [{ id: rid("call_"), type: "function", function: m.function_call }] : []);
  const inTok = data.usage?.prompt_tokens || 0, outTok = data.usage?.completion_tokens || 0;
  if (kind === "anthropic") {
    const content = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const tc of calls) { let input = {}; try { input = JSON.parse(tc.function.arguments || "{}"); } catch {} content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input }); }
    if (!content.length) content.push({ type: "text", text: "" });
    return { id: rid("msg_"), type: "message", role: "assistant", content, model, stop_reason: calls.length ? "tool_use" : c?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: inTok, output_tokens: outTok } };
  }
  const output = [];
  if (m.content || !calls.length) output.push({ id: rid("msg_"), type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: m.content || "", annotations: [] }] });
  for (const tc of calls) output.push({ id: rid("fc_"), type: "function_call", status: "completed", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
  return { id: rid("resp_"), object: "response", created_at: data.created || Math.floor(Date.now() / 1000), status: "completed", model, output, output_text: m.content || "", usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok } };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,x-api-key,x-conversation-id,anthropic-version,anthropic-beta",
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
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || "";
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
    const g = env.ADMIN_KEY && auth === env.ADMIN_KEY ? { ok: true } : await gate(false); // admin key se dashboard bhi list padh sakta hai
    if (!g.ok) return deny(g);
    const catalog = await hub.fetch("https://hub/models").then(r => r.json()).catch(() => ({ models: [] }));
    const liveModels = Array.isArray(catalog.models) ? catalog.models : [];
    const liveById = new Map(liveModels.filter(x => x && typeof x === "object" && x.id).map(x => [x.id, x]));
    return Response.json({
      object: "list",
      data: [
        { id: "jaat-default", object: "model", created: 0, owned_by: "jaat" },
        ...[...new Set([...DUCK_MODELS, ...liveModels.map(x => typeof x === "string" ? x : x.id).filter(Boolean)])].map(id => ({ ...(liveById.get(id) || {}), id, object: "model", created: 0, owned_by: "duck.ai" })),
        { id: "pplx-auto", object: "model", created: 0, owned_by: "perplexity.ai" },
        ...FREE_PROVIDERS.map(p => ({ id: p.name, object: "model", created: 0, owned_by: new URL(p.base).hostname })),
      ],
    });
  }

  // Anthropic Messages + OpenAI Responses route: common chat pipeline (streaming, tools, session reuse) reuse hoti hai.
  if (u.pathname === "/v1/messages" || u.pathname === "/v1/responses") {
    let a; try { a = await req.json(); } catch { return Response.json({ error: { message: "bad json", type: "invalid_request_error" } }, { status: 400 }); }
    const kind = u.pathname === "/v1/messages" ? "anthropic" : "responses";
    const model = a.model || "duck-auto";
    const t = kind === "anthropic" ? anthropicToChat(a) : responsesToChat(a);
    const chatBody = { model, messages: t.messages, stream: !!a.stream, tools: t.tools.length ? t.tools : undefined, tool_choice: t.tool_choice, max_tokens: a.max_tokens || a.max_output_tokens || 1024, conversation_id: a.conversation_id || req.headers.get("x-conversation-id") || a.user || a.metadata?.user_id };
    const chatReq = new Request(new URL("/v1/chat/completions", req.url), { method: "POST", headers: { authorization: req.headers.get("authorization") || "", "x-api-key": req.headers.get("x-api-key") || "", "content-type": "application/json" }, body: JSON.stringify(chatBody) });
    const r = await handle(chatReq, env);
    const errOut = (data, status) => kind === "anthropic"
      ? Response.json({ type: "error", error: { type: data?.error?.type || "api_error", message: data?.error?.message || "error" } }, { status })
      : Response.json(data, { status });
    if (a.stream && r.ok && r.headers.get("content-type")?.includes("text/event-stream"))
      return new Response(translateStream(r, kind, model), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-jaat-provider": r.headers.get("x-jaat-provider") || "" } });
    let data; try { data = await r.json(); } catch { return r; }
    if (!r.ok) return errOut(data, r.status);
    if (a.stream) { // upstream ne JSON diya (stream nahi): chhota fake event stream banao
      const fake = new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: data.choices?.[0]?.message?.content || "", ...(data.choices?.[0]?.message?.tool_calls ? { tool_calls: data.choices[0].message.tool_calls.map((tc, i) => ({ index: i, ...tc })) } : {}) }, finish_reason: data.choices?.[0]?.finish_reason || "stop" }] })}\n\ndata: [DONE]\n\n`);
      return new Response(translateStream(fake, kind, model), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return Response.json(translateFull(data, kind, model), { headers: { "x-jaat-provider": r.headers.get("x-jaat-provider") || "" } });
  }

  if (u.pathname === "/v1/images/generations") {
    let a; try { a = await req.json(); } catch { return Response.json({ error: { message: "bad json", type: "invalid_request_error" } }, { status: 400 }); }
    const prompt = String(a.prompt || "").trim();
    if (!prompt) return Response.json({ error: { message: "prompt required", type: "invalid_request_error" } }, { status: 400 });
    const g = await gate(true); if (!g.ok) return deny(g);
    const t0 = Date.now();
    // duck.ai image tool (runner me real Chrome). Ek call = ek image.
    const jobBody = JSON.stringify({ provider: "duck-image", model: "image-generation", body: JSON.stringify({ prompt: prompt.slice(0, 4000), size: typeof a.size === "string" ? a.size.slice(0, 20) : "" }) });
    const r = await hub.fetch("https://hub/submit", { method: "POST", body: jobBody });
    await hub.fetch("https://hub/record", { method: "POST", body: JSON.stringify({ id: g.id, model: "image-generation", provider: "duck-image", status: r.status, ms: Date.now() - t0 }) });
    if (r.status !== 200) return r;
    let d; try { d = await r.json(); } catch { return Response.json({ error: { message: "bad image response from runner", type: "error" } }, { status: 502 }); }
    const item = d.b64_json ? { b64_json: d.b64_json, ...(a.response_format === "url" ? { url: "data:" + (d.mime || "image/png") + ";base64," + d.b64_json } : {}) } : d.url ? { url: d.url } : null;
    if (!item) return Response.json({ error: { message: "runner ne image nahi di", type: "error" } }, { status: 502 });
    return Response.json({ created: Math.floor(Date.now() / 1000), data: [item] });
  }

  if (u.pathname === "/v1/chat/completions") {
    let j;
    try { j = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
    const g = await gate(true);
    if (!g.ok) return deny(g);
    const t0 = Date.now();
    const wantStream = j.stream === true;
    const catalog = await hub.fetch("https://hub/models").then(r => r.json()).catch(() => ({ models: [] }));
    const free = isFreeModel(j.model); // free provider ka exact naam sabse pehle
    const duck = !free && (isDuckModel(j.model) || (catalog.models || []).some(x => (typeof x === "string" ? x : x.id) === j.model));
    const pplx = !free && !duck && isPplxModel(j.model);
    const shownModel = duck || free || pplx ? j.model : "jaat-default";
    const inputStream = j.stream === true; delete j.stream_options;

    // jaat (vireonix) wali body: model "auto" + cache todne ke liye random note
    const jaatBody = () => {
      const k = { ...j, model: "auto" }; delete k.reasoning_effort; delete k.reasoningEffort; // duck-only field
      k.messages = [{ role: "system", content: "ref " + crypto.randomUUID().slice(0, 8) }, ...(j.messages || [])];
      return JSON.stringify(k);
    };
    // conversation_id ko api key ke hisaab se namespace karo (do keys ke ids na takrayen)
    const cidRaw = j.conversation_id || req.headers.get("x-conversation-id") || j.user || "";
    const cid = cidRaw ? String(g.id || "legacy") + ":" + String(cidRaw).slice(0, 150) : "";
    const lg = duck ? normalizeLegacy(j) : { j, legacy: false };
    const job = duck
      ? { provider: "duck", model: j.model, stream: wantStream, body: JSON.stringify({ ...lg.j, stream: false, model: j.model, messages: j.messages || [], conversation_id: cid, legacy_fn: lg.legacy, reasoning_effort: j.reasoning_effort || j.reasoningEffort }) }
      : free
      ? { provider: "free", name: j.model, body: JSON.stringify({ ...j, stream: false, messages: j.messages || [] }) }
      : pplx
      ? { provider: "perplexity", model: j.model, body: JSON.stringify({ model: j.model, messages: j.messages || [] }) }
      : { provider: "jaat", body: jaatBody() };

    const r = await hub.fetch("https://hub/submit", { method: "POST", body: JSON.stringify(job) });
    await hub.fetch("https://hub/record", { method: "POST", body: JSON.stringify({ id: g.id, model: shownModel, provider: r.headers.get("x-jaat-provider") || "", status: r.status, ms: Date.now() - t0 }) });
    if (!wantStream || r.status !== 200) return r;
    if (r.headers.get("x-jaat-stream") === "1") return r; // duck ki asli stream: seedha aage bhej do

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
    const firstDelta = { role: "assistant" };
    if (c.message && c.message.function_call) firstDelta.function_call = c.message.function_call;
    else if (c.message && Array.isArray(c.message.tool_calls)) firstDelta.tool_calls = c.message.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: tc.type || "function", function: tc.function }));
    else firstDelta.content = (c.message && c.message.content) || "";
    const body =
      ev({ choices: [{ index: 0, delta: firstDelta, finish_reason: null }] }) +
      ev({ choices: [{ index: 0, delta: {}, finish_reason: c.finish_reason || "stop" }] }) +
      "data: [DONE]\n\n";
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-jaat-provider": r.headers.get("x-jaat-provider") || "", "x-jaat-duck-error": r.headers.get("x-jaat-duck-error") || "", "x-jaat-duck-skipped": r.headers.get("x-jaat-duck-skipped") || "" } });
  }

  if (["/next", "/result", "/ack", "/status", "/chunk", "/models"].includes(u.pathname)) {
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
