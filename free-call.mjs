// free-call.mjs - ek hi free provider ko call karo (koi fallback chain nahi; chain wali chat() free-fallback.mjs me hai)
// runner.js isse import karta hai: callFree(provider, body, timeoutMs) -> OpenAI chat.completion JSON string
import { keyOf } from "./free-fallback.mjs";

export async function callFree(p, body, timeoutMs = 60000) {
  const base = typeof body === "string" ? JSON.parse(body) : body;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (keyOf(p)) headers.authorization = "Bearer " + keyOf(p);
    const b = { ...base, model: p.model, stream: false };
    delete b.stream_options;
    delete b.reasoning_effort;
    const r = await fetch(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(b), signal: c.signal });
    const text = await r.text();
    let ok = false;
    try { ok = r.ok && !!JSON.parse(text).choices; } catch {}
    if (!ok) throw new Error(p.name + " " + r.status + ": " + text.slice(0, 200));
    return text;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(p.name + ": timeout");
    throw e;
  } finally {
    clearTimeout(t);
  }
}
