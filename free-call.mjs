// free-call.mjs - free-fallback.mjs ke ek provider ko seedha call karta hai.
// type: "oai" (default, /chat/completions) | "proxy_get" | "deepai" | "uai". Jawab hamesha OpenAI chat.completion JSON.
import { flatten } from "./duck.js";
import { keyOf } from "./free-fallback.mjs";

const UA = "Mozilla/5.0 (Linux; Android 13; Mumbai) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const REPLY_KEYS = ["response", "reply", "answer", "text", "result", "content", "message", "data", "output"];

// JSON kitna bhi andar ho, AI ka jawab (string) dhundho (21.py ka dig)
export function dig(j) {
  if (typeof j === "string") return j;
  if (Array.isArray(j)) { for (const x of j) { const r = dig(x); if (r && r.trim()) return r; } return null; }
  if (j && typeof j === "object") {
    for (const k of REPLY_KEYS) if (k in j) { const r = dig(j[k]); if (r && r.trim()) return r; }
    for (const v of Object.values(j)) if (v && typeof v === "object") { const r = dig(v); if (r && r.trim()) return r; }
  }
  return null;
}

export function extract(out) {
  let j;
  try { j = JSON.parse(out); } catch { return out; }
  if (j && j.status === false) throw new Error("provider error: " + JSON.stringify(j).slice(0, 100));
  const r = j && typeof j === "object" ? dig(j) : out;
  if (!r || !r.trim()) throw new Error("khali jawab: " + String(out).slice(0, 100));
  return r;
}

function clamp(s, n) {
  if (s.length <= n) return s;
  const head = Math.max(1, Math.floor(n / 10));
  return s.slice(0, head) + "\n...[context truncated]...\n" + s.slice(-(n - head - 28));
}

const completion = (model, text) => JSON.stringify({
  id: "chatcmpl-" + Math.random().toString(36).slice(2) + Date.now().toString(36),
  object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 0, completion_tokens: Math.ceil(text.length / 4), total_tokens: Math.ceil(text.length / 4) },
});

// UnlimitedAI guest chat: jawab SSE stream me (data: {"delta":".."})
function parseUai(raw) {
  const txt = [], any = []; let err = "";
  for (let ln of raw.split("\n")) {
    ln = ln.trim();
    if (ln.startsWith("data:")) ln = ln.slice(5).trim();
    if (!ln.startsWith("{")) continue;
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (!j || typeof j !== "object") continue;
    if (j.error && !err) err = String(j.error).slice(0, 100);
    if (typeof j.delta === "string") { any.push(j.delta); if (String(j.type || "text-delta").startsWith("text")) txt.push(j.delta); }
  }
  const out = txt.join("") || any.join("");
  if (!out.trim()) throw new Error(err ? "UAI error: " + err : "UAI: khali/anjaan jawab: " + raw.slice(0, 100).replace(/\n/g, " "));
  return out;
}

export async function callFree(p, body, timeoutMs = 60000) {
  const base = typeof body === "string" ? JSON.parse(body) : body;
  const key = keyOf(p);
  if (p.keyEnv && !key) throw new Error(p.name + ": " + p.keyEnv + " set nahi hai (GitHub Secret me daalo)");
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  const go = async (url, init) => {
    const r = await fetch(url, { ...init, signal: c.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(p.name + " " + r.status + ": " + text.slice(0, 200));
    return text;
  };
  try {
    const type = p.type || "oai";
    if (type === "oai") {
      const b = { ...base, model: p.model, stream: false };
      delete b.stream_options; delete b.reasoning_effort;
      const headers = { "content-type": "application/json" };
      if (key) headers.authorization = "Bearer " + key;
      const text = await go(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(b) });
      let ok = false;
      try { ok = !!JSON.parse(text).choices; } catch {}
      if (!ok) throw new Error(p.name + " bad response: " + text.slice(0, 200));
      return text;
    }
    const prompt = clamp(flatten(base.messages), p.maxChars || 6000);
    let out;
    if (type === "proxy_get") {
      out = extract(await go(p.base + "?" + new URLSearchParams({ prompt, model: p.model }), { headers: { "user-agent": UA } }));
    } else if (type === "deepai") {
      const hist = JSON.stringify([{ role: "user", content: prompt }]);
      out = extract(await go(p.base, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "api-key": key, "user-agent": UA },
        body: new URLSearchParams({ chat_style: "chat", chatHistory: hist, model: p.model }).toString(),
      }));
    } else if (type === "uai") {
      const origin = "https://app.unlimitedai.chat";
      const id = () => crypto.randomUUID();
      out = parseUai(await go(p.base, {
        method: "POST",
        headers: { "content-type": "application/json", origin, referer: origin + "/", accept: "text/event-stream", "user-agent": UA },
        body: JSON.stringify({
          chatId: id(),
          messages: [{ id: id(), role: "user", content: prompt, parts: [{ type: "text", text: prompt }], createdAt: new Date().toISOString() }],
          selectedChatModel: p.model, selectedCharacterId: null, selectedStoryId: null, locale: "en",
        }),
      }));
    } else throw new Error(p.name + ": anjaan type " + type);
    return completion(p.model, out);
  } catch (e) {
    throw e.name === "AbortError" ? new Error(p.name + " timeout") : e;
  } finally {
    clearTimeout(t);
  }
}
