// free-fallback.mjs
// Bina key wale free OpenAI-compatible providers ki chain.
// Upar wala pehle try hota hai, fail ho to agla. Naya provider = PROVIDERS me ek line add karo.
// Node (Termux/runner.js) aur Cloudflare Worker dono me chalta hai (sirf fetch use karta hai).

export const PROVIDERS = [
  { name: "vireonix", base: "https://vireonix.ai/v1", model: "auto" },
  { name: "kilo-ultra", base: "https://api.kilo.ai/api/gateway", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  { name: "kilo-super", base: "https://api.kilo.ai/api/gateway", model: "nvidia/nemotron-3-super-120b-a12b:free" },
  { name: "chat-oss120", base: "https://ch.at/v1", model: "gpt-oss-120b" },
  { name: "chat-gpt4o", base: "https://ch.at/v1", model: "gpt-4o" },
  { name: "chat-llama70", base: "https://ch.at/v1", model: "llama-3.3-70b" },
  { name: "br-ultra", base: "https://blockrun.ai/v1", model: "nvidia/nemotron-3-ultra-550b" },
  { name: "kilo-auto", base: "https://api.kilo.ai/api/gateway", model: "kilo-auto/free" },
  { name: "kilo-router", base: "https://api.kilo.ai/api/gateway", model: "openrouter/free" },
  { name: "kilo-lightning", base: "https://api.kilo.ai/api/gateway", model: "nvidia/nemotron-3.5-lightning:free" },
  { name: "kilo-poolside", base: "https://api.kilo.ai/api/gateway", model: "poolside/laguna-s-2.1:free" },
  { name: "kilo-stepfun", base: "https://api.kilo.ai/api/gateway", model: "stepfun/step-5-preview-free" },
  { name: "kilo-cohere", base: "https://api.kilo.ai/api/gateway", model: "cohere/north-mini-code:free" },
  { name: "kilo-dots", base: "https://api.kilo.ai/api/gateway", model: "dots-studio/dots-3-note-preview:free" },
  { name: "br-lightning", base: "https://blockrun.ai/v1", model: "nvidia/nemotron-3.5-lightning" },
  { name: "br-cohere", base: "https://blockrun.ai/v1", model: "cohere/north-mini-code" },
  { name: "br-poolside", base: "https://blockrun.ai/v1", model: "poolside/laguna-xs-2.1" },
  { name: "br-glimmer", base: "https://blockrun.ai/v1", model: "nvidia/muse-glimmer-30b" },
  { name: "br-nano-omni", base: "https://blockrun.ai/v1", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
  { name: "ovh-qwen397", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Qwen3.5-397B-A17B" },
  { name: "ovh-oss120", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "gpt-oss-120b" },
  { name: "ovh-llama70", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Meta-Llama-3_3-70B-Instruct" },
  { name: "ovh-qwen27", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Qwen3.6-27B" },
  { name: "ovh-mistral-s", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Mistral-Small-3.2-24B-Instruct-2506" },
  { name: "unturf-qwen", base: "https://qwen.ai.unturf.com/v1", model: "turboderp/Qwen3.8-27B-exl3" },
  { name: "unturf-hermes", base: "https://hermes.ai.unturf.com/v1", model: "turboderp/Qwen3.8-27B-exl3" },
  { name: "kilo-lfm", base: "https://api.kilo.ai/api/gateway", model: "liquid/lfm-2.5-2.6b:free" },
  { name: "br-llama-vision", base: "https://blockrun.ai/v1", model: "nvidia/llama-3.2-11b-vision" },
  // vlm.run — tested free (2026-10-13)
  { name: "vlm-qwen27b", base: "https://gateway.vlm.run/v1/openai", model: "qwen/qwen3.8-27b" },
  { name: "vlm-qwen08b", base: "https://gateway.vlm.run/v1/openai", model: "qwen/qwen3.5-0.8b" },
  { name: "vlm-diffgemma", base: "https://gateway.vlm.run/v1/openai", model: "google/diffusiongemma-26b-a4b-it" },
  // naya jodne ka namuna (key ho to key: "..." bhi do):
  // { name: "llm7", base: "https://api.llm7.io/v1", model: "MODEL-ID-YAHAN" },
];

const TIMEOUT_MS = 60000;
// fail hone par provider kitni der skip hoga (ms). 401/402/403 = key/paid maangta hai
const COOL = { 429: 60e3, 401: 3600e3, 402: 3600e3, 403: 3600e3, other: 30e3 };
const badUntil = new Map();

// body: OpenAI chat body (object ya JSON string). Return: { text, provider, n }
export async function chat(body, timeoutMs = TIMEOUT_MS) {
  const base = typeof body === "string" ? JSON.parse(body) : body;
  let list = PROVIDERS.filter((p) => (badUntil.get(p.name) || 0) <= Date.now());
  if (!list.length) list = PROVIDERS; // sab cooldown me hon to bhi try karo
  const errs = [];

  for (const p of list) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (p.key) headers.authorization = "Bearer " + p.key;
      const b = { ...base, model: p.model, stream: false };
      delete b.stream_options;
      delete b.reasoning_effort;
      const r = await fetch(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(b), signal: c.signal });
      const text = await r.text();
      let ok = false;
      try { ok = r.ok && !!JSON.parse(text).choices; } catch {}
      if (ok) { badUntil.delete(p.name); return { text, provider: p.name, n: 1 }; }
      badUntil.set(p.name, Date.now() + (COOL[r.status] || COOL.other));
      errs.push(`${p.name}: ${r.status} ${text.slice(0, 80)}`);
    } catch (e) {
      badUntil.set(p.name, Date.now() + COOL.other);
      errs.push(`${p.name}: ${e.name === "AbortError" ? "timeout" : e.message}`);
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error("sab fail -> " + errs.join(" | "));
}
