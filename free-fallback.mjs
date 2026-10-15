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
  // researched 2026-10-14 — khud test nahi kiya (bash offline), kilo gateway ke hi 2 free model add
  { name: "kilo-tencent-hy3", base: "https://api.kilo.ai/api/gateway", model: "tencent/hy3:free" },
  { name: "kilo-qwen38-27b", base: "https://api.kilo.ai/api/gateway", model: "qwen/qwen3.8-27b:free" },
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
  // OVH ke chote/lightweight free-tier models — user ne khud live test kiya (2026-10-14), sab 200 PASS
  { name: "ovh-qwen35-9b", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Qwen3.5-9B" },
  { name: "ovh-oss20", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "gpt-oss-20b" },
  { name: "ovh-mistral7b", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Mistral-7B-Instruct-v0.3" },
  { name: "ovh-mistral-nemo", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Mistral-Nemo-Instruct-2407" },
  { name: "ovh-qwen-vl", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "Qwen2.5-VL-72B-Instruct" },
  // tested 404 (2026-10-14), model ID format galat tha, isliye hata diya:
  // Qwen3-Coder-30B-A3B-Instruct, Llama-3.1-8B-Instruct, Qwen3-32B
  { name: "unturf-qwen", base: "https://qwen.ai.unturf.com/v1", model: "turboderp/Qwen3.8-27B-exl3" },
  { name: "unturf-hermes", base: "https://hermes.ai.unturf.com/v1", model: "turboderp/Qwen3.8-27B-exl3" },
  { name: "kilo-lfm", base: "https://api.kilo.ai/api/gateway", model: "liquid/lfm-2.5-2.6b:free" },
  { name: "br-llama-vision", base: "https://blockrun.ai/v1", model: "nvidia/llama-3.2-11b-vision" },
  // vlm.run — tested free (2026-10-13)
  { name: "vlm-qwen27b", base: "https://gateway.vlm.run/v1/openai", model: "qwen/qwen3.8-27b" },
  { name: "vlm-qwen08b", base: "https://gateway.vlm.run/v1/openai", model: "qwen/qwen3.5-0.8b" },
  { name: "vlm-diffgemma", base: "https://gateway.vlm.run/v1/openai", model: "google/diffusiongemma-26b-a4b-it" },
  // ---- Mumbai (21.py) ke providers, har model alag. GROQ, GEM3, DSX jaan-boojh ke nahi liye ----
  // keyDefault = seedha key (jaise 21.py me thi) | keyEnv = chahe to GitHub Secret se badal sakte ho | timeout = ms
  { name: "gem-flash-3.7", base: "https://gimmni.blitz.cloud/v1", model: "gemini-3.7-flash", keyEnv: "GEM_KEY", timeout: 150000 },
  { name: "gem2-flash-3.6", base: "https://gemini.jaatbahi76.workers.dev/v1", model: "gemini-3.6-flash@think=0", keyEnv: "GEM2_KEY", timeout: 150000 },
  { name: "gem2-flash-3.5", base: "https://gemini.jaatbahi76.workers.dev/v1", model: "gemini-3.5-flash", keyEnv: "GEM2_KEY", timeout: 150000 },
  { name: "rev-mimo26", base: "https://rev9.top/v1", model: "mimo-v2.6-flash:free", keyEnv: "REV_KEY", timeout: 120000 },
  { name: "rev-mimo25", base: "https://rev9.top/v1", model: "mimo-v2.5:free", keyEnv: "REV_KEY", timeout: 120000 },
  { name: "rev-dsf41", base: "https://rev9.top/v1", model: "deepseek-v4.1-flash:free", keyEnv: "REV_KEY", timeout: 120000 },
  { name: "rev-dsf4", base: "https://rev9.top/v1", model: "deepseek-v4-flash:free", keyEnv: "REV_KEY", timeout: 120000 },
  { name: "rev-haiku", base: "https://rev9.top/v1", model: "claude-haiku-5.5:free", keyEnv: "REV_KEY", timeout: 120000 },
  { name: "rev-grok-4.7", base: "https://rev9.top/v1", model: "grok-4.7", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-4.6", base: "https://rev9.top/v1", model: "grok-4.6", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-4.5-latest", base: "https://rev9.top/v1", model: "grok-4.5-latest", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-4.5", base: "https://rev9.top/v1", model: "grok-4.5", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-latest", base: "https://rev9.top/v1", model: "grok-latest", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok", base: "https://rev9.top/v1", model: "grok", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-build", base: "https://rev9.top/v1", model: "grok-build-latest", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-composer", base: "https://rev9.top/v1", model: "grok-composer", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-composer-2.5", base: "https://rev9.top/v1", model: "composer-2.5", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-grok-composer-fast", base: "https://rev9.top/v1", model: "grok-composer-2.5-fast", keyEnv: "REV_GROK_KEY", timeout: 120000 },
  { name: "rev-dspro", base: "https://rev9.top/v1", model: "DeepSeek-V4-Pro", keyEnv: "REV_PRO_KEY", timeout: 120000 },
  { name: "rev-kimi", base: "https://rev9.top/v1", model: "Kimi-K2.7-Code", keyEnv: "REV_PRO_KEY", timeout: 120000 },
  { name: "rev-luna", base: "https://rev9.top/v1", model: "gpt-6-luna", keyEnv: "REV_LUNA_KEY", timeout: 120000 },
  { name: "ds-flash", type: "proxy_get", base: "https://anshapi.vercel.app/api/deepseek", model: "deepseek-v4-flash", maxChars: 6500 },
  { name: "dai-standard", type: "deepai", base: "https://api.deepai.org/hacking_is_a_serious_crime", model: "standard", keyEnv: "DAI_KEY", maxChars: 3000 },
  { name: "uai-reasoning", type: "uai", base: "https://app.unlimitedai.chat/api/chat", model: "chat-model-reasoning", maxChars: 6000, timeout: 150000 },
  // ---- researched 2026-10-14, bina key ke chalte hain (khud test nahi kiya, bash yahan offline hai) ----
  // Pollinations.ai — text.pollinations.ai/openai, bilkul free, signup/key zaroori nahi
  { name: "poll-openai", base: "https://text.pollinations.ai/openai", model: "openai" },
  { name: "poll-openai-large", base: "https://text.pollinations.ai/openai", model: "openai-large" },
  { name: "poll-openai-reasoning", base: "https://text.pollinations.ai/openai", model: "openai-reasoning" },
  { name: "poll-qwen-coder", base: "https://text.pollinations.ai/openai", model: "qwen-coder" },
  { name: "poll-llama", base: "https://text.pollinations.ai/openai", model: "llama" },
  { name: "poll-mistral", base: "https://text.pollinations.ai/openai", model: "mistral" },
  { name: "poll-deepseek-r", base: "https://text.pollinations.ai/openai", model: "deepseek-reasoning" },
  // LLM7.io — api.llm7.io/v1, bina signup 30 RPM free (key na ho to bhi chal jata hai)
  { name: "llm7-deepseek-r1", base: "https://api.llm7.io/v1", model: "deepseek-r1", keyDefault: "unused" },
  { name: "llm7-qwen25", base: "https://api.llm7.io/v1", model: "qwen2.5", keyDefault: "unused" },
  { name: "llm7-gpt4o-mini", base: "https://api.llm7.io/v1", model: "gpt-4o-mini-2024-07-18", keyDefault: "unused" },
  // naya jodne ka namuna (key ho to key: "..." bhi do):
  // { name: "llm7", base: "https://api.llm7.io/v1", model: "MODEL-ID-YAHAN" },
];

// Provider key sirf explicit config ya GitHub Secret se; leaked defaults kabhi use nahi hote.
export const keyOf = (p) => p.key || (p.keyEnv && typeof process !== "undefined" && process.env && process.env[p.keyEnv]) || p.keyDefault || "";

const TIMEOUT_MS = 60000;
// fail hone par provider kitni der skip hoga (ms). 401/402/403 = key/paid maangta hai
const COOL = { 429: 60e3, 401: 3600e3, 402: 3600e3, 403: 3600e3, other: 30e3 };
const badUntil = new Map();

// body: OpenAI chat body (object ya JSON string). Return: { text, provider, n }
export async function chat(body, timeoutMs = TIMEOUT_MS) {
  const base = typeof body === "string" ? JSON.parse(body) : body;
  let list = PROVIDERS.filter((p) => (!p.type || p.type === "oai") && (badUntil.get(p.name) || 0) <= Date.now());
  if (!list.length) list = PROVIDERS; // sab cooldown me hon to bhi try karo
  const errs = [];

  for (const p of list) {
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
