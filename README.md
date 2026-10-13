# DuckAI Server: Cloudflare + GitHub Actions Relay Plan

Date: 2026-10-13

## Idea

Server ka public endpoint Cloudflare par host hoga (Worker ya Pages). Lekin DuckDuckGo (duck.ai) ko asli request GitHub Actions runner se jayegi, seedha Cloudflare se nahi.

Fayda: GitHub Actions ka har run naya IP leta hai (Azure datacenter se), to IP-based rate-limit/ban se bachne me madad milti hai.

## Base repo

- `amirkabiri/duckai` (Bun/TypeScript, OpenAI-compatible server, Docker image available)
- Source files: `duckai.ts`, `openai-service.ts`, `server.ts`, `tool-service.ts`, `rate-limit-store.ts`

## Architecture

```
User -> Cloudflare Worker -> repository_dispatch (GitHub API)
     -> GitHub Actions runner (fresh IP) -> duck.ai
     -> result -> callback to Worker -> User
```

## GitHub Actions ke zaroori concepts

- `repository_dispatch`: Worker se `POST /repos/{owner}/{repo}/dispatches` bhejo, custom `event_type` ke saath. Workflow me `on: repository_dispatch` set karo.
- `workflow_dispatch`: ye bhi API se trigger hota hai, input parameters bhejna aasan hai.
- Token: GitHub PAT chahiye (`actions: write` scope), Worker ke secret me store karo.
- Runner IP: Azure ke shared pool se aata hai, har job pe alag, lekin dedicated/private nahi.
- Limits: free account pe ~20 concurrent jobs. Job start hone me 5 se 30 sec ka queue delay aa sakta hai.

## Implementation steps

1. GitHub repo banao, usme duckai ka logic aur `.github/workflows/relay.yml` rakho (trigger: `repository_dispatch`).
2. Workflow me client payload (messages) padho, duck.ai ko request bhejo.
3. Result wapas bhejne ke liye workflow Worker ke `/callback` endpoint par POST kare.
4. Cloudflare Worker banao jo `/v1/chat/completions` serve kare. Request aane par GitHub API ko dispatch call kare aur result ka wait kare.
5. Result Durable Object ya KV me store karo taaki original request resolve ho sake.
6. Secrets (PAT, callback token) Worker env me rakho, code me hardcode mat karo. Callback par auth zaroor lagao.
7. End-to-end test karo aur latency naapo.

## Limitations aur risks

- Latency: queue + runner start ke baad request, real-time chat ke liye dheema.
- GitHub ToS: Actions ko proxy/relay ki tarah heavy use karna acceptable use policy ke khilaf ja sakta hai, account suspend ho sakta hai.
- Concurrency: free tier pe parallel requests zyada aayi to queue lambi hogi.
- Reliability: callback chain me failure points zyada hain, workflow fail/timeout hua to request hang ho sakti hai.
- DuckDuckGo GitHub Actions ka poora IP range block kar sakta hai.
- Ye unofficial hai aur DuckDuckGo ke internal API par chalta hai, kabhi bhi toot sakta hai.

## Open question

Result wapas laane ke liye callback approach theek hai, ya polling wala simple tareeka chahiye?
