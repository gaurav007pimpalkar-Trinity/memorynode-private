# MemoryNode — One-pager for developers & founders

**Memory layer for AI apps.** Store what matters, retrieve it when your chatbot or copilot needs it. No vector DB, no embedding pipeline — one API.

---

## The problem

Your chatbot or AI assistant has no memory. Users repeat themselves. You don’t want to run Pinecone, pgvector, and embedding jobs yourself. You want to ship fast and own the product, not the infra.

---

## The solution

MemoryNode is a **memory API**: you send facts and conversation snippets; when the user asks something, you call one endpoint and get back the right context, formatted and ready to drop into your LLM prompt. Per-user, semantic retrieval, hosted — you focus on your app.

---

## What you get

| Capability | How you use it |
|------------|----------------|
| **Store** | `POST /v1/memories` — user_id, text, optional namespace & metadata |
| **Search** | `POST /v1/search` — natural-language query, same user_id/namespace → ranked memories |
| **Context for prompts** | `POST /v1/context` — same as search; returns `context_text` + citations for your prompt |
| **Usage & limits** | `GET /v1/usage/today` — see usage and plan limits in your app |
| **Export / import** | Backup or migrate memories via API |

**Auth:** API key in `Authorization: Bearer <key>` or `x-api-key`. Get keys from the dashboard after signup.

---

## How it fits in your stack (3 steps)

1. **Ingest** — When a user says something worth remembering (or you infer a preference), call `POST /v1/memories` with their id and the text.
2. **Retrieve** — Before each LLM call, call `POST /v1/context` with the same user_id and the current message (or a short query). You get `context_text` and `citations`.
3. **Prompt** — Put `context_text` into your system or user prompt, then call OpenAI/Anthropic/etc. Optionally store the assistant reply as another memory.

No embeddings, no index tuning — we handle storage and retrieval.

---

## SDK & examples

- **TypeScript SDK** — `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `getUsageToday`. Same API key.
- **Next.js** — Example chat route: store message → fetch context → LLM → store reply. See `examples/nextjs-middleware/`.
- **LangChain** — Adapter that calls `/v1/context` and injects into your chain. See `examples/langchain-wrapper/`.

---

## Quick start (under 5 minutes)

1. **Sign up** → [Dashboard](https://app.memorynode.ai) → create workspace → create API key (copy it once).
2. **Store a memory:**
   ```bash
   curl -X POST "https://api.memorynode.ai/v1/memories" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"user_id":"user-123","namespace":"myapp","text":"User prefers dark mode"}'
   ```
3. **Get context for a prompt:**
   ```bash
   curl -X POST "https://api.memorynode.ai/v1/context" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"user_id":"user-123","namespace":"myapp","query":"theme preference","top_k":5}'
   ```
   Use the `context_text` from the response in your LLM prompt.

Full request/response shapes and errors: [API usage](./API_USAGE.md). Step-by-step: [Quickstart](./QUICKSTART.md).

---

## Who it’s for

- Solo founders and indie devs shipping a chatbot or copilot.
- Small teams that want per-user memory without running a vector DB or embedding pipeline.
- Anyone building an AI assistant that should recall preferences and history across sessions.

---

## Plans

Plans from **Launch** (trial) to **Build**, **Deploy**, and **Scale**. Usage-based limits (writes, reads, embedding). Check current plan and limits via `GET /v1/billing/status` and the dashboard. Upgrade when you need more — no lock-in; export your memories anytime.

---

## Next step

- **Try it:** [Quickstart](./QUICKSTART.md) → first memory stored and retrieved in minutes.  
- **Build chat:** Use the Next.js chat example (`examples/nextjs-middleware/`) or the LangChain context adapter (`examples/langchain-wrapper/`) in this repo as your integration pattern.  
- **Dashboard:** [app.memorynode.ai](https://app.memorynode.ai) — workspaces, API keys, memory browser, usage, billing.

**API base URL:** `https://api.memorynode.ai`
