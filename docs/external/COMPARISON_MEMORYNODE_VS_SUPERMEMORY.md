# MemoryNode vs Supermemory.ai — Comparison

A side-by-side comparison of **core memory API** capabilities. Excluded from this table: browser products, Ray browser, MCP, and connectors (MemoryNode does not offer these).

---

## Comparison table

| Aspect | **MemoryNode** | **Supermemory.ai** |
|--------|----------------|--------------------|
| **Positioning** | Memory layer for AI apps — store what matters, retrieve when your chatbot/copilot needs it. One API, no vector DB or embedding pipeline to run yourself. | Universal Memory API + context engineering infrastructure: memory, RAG, user profiles, extractors. “Context engineering infrastructure for your AI agent.” |
| **Store** | `POST /v1/memories` — `user_id`, text, optional `namespace` and metadata. You send facts/snippets; we chunk, embed, and store. | Add documents/memories with content and metadata; ingest from text, URLs, files, PDFs. Organize with `containerTags` (e.g. user/project). `customId` for updates and dedup. |
| **Search** | `POST /v1/search` — natural-language query, same `user_id`/namespace → ranked memories. | Semantic + hybrid search (memories + document chunks). Filter by `containerTag` and metadata (AND/OR). Optional reranking, similarity thresholds, result limits. |
| **Context for prompts** | `POST /v1/context` — same as search; returns `context_text` + citations ready to drop into your LLM prompt. | Context retrieval for prompts; Memory Router can manage context automatically (transparent proxy). |
| **Per-user / scoping** | Per-user via `user_id`; optional `namespace` (e.g. app or feature). | Per-user / per-project via `containerTags` and metadata. |
| **User profiles / long-term state** | Not a separate product; memories and search/context provide recall per user. | Persistent user profiles — roles, past actions, preferences for long-running agents. |
| **RAG vs memory** | Single memory API: store and retrieve. No separate “RAG” product; you use context for RAG-like flows. | Hybrid memory + RAG: separate concepts and controls for memory vs document retrieval, latency, and data inclusion. |
| **Extractors / enrichment** | No built-in extractors; you send text (or pre-extracted content) to the API. | Built-in extractors to derive structured memory from raw content (e.g. documents). |
| **Embeddings / infra** | Hosted; we run embeddings (e.g. OpenAI) and storage. No embedding pipeline for you to manage. | Hosted; custom vector engine on Cloudflare Durable Objects + Postgres. Sub-400ms latency at scale. |
| **SDKs** | TypeScript SDK: `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `getUsageToday`. | Python and JavaScript/TypeScript SDKs; sync and async (Python). |
| **Integrations** | Next.js example, LangChain adapter (calls `/v1/context`, injects into chain). | LangChain, AI SDK; works with OpenAI, Anthropic, Google, Groq, etc. |
| **Auth** | API key: `Authorization: Bearer <key>` or `x-api-key`. Dashboard session for app. Workspaces and keys in dashboard. | API key / console auth; workspace and key management in console. |
| **Usage & limits** | `GET /v1/usage/today`; plan limits (writes, reads, embeddings). `GET /v1/billing/status` for plan and caps. | Usage and limits per plan (tokens processed, search queries). Advanced analytics on higher tiers. |
| **Export / import** | Backup or migrate memories via API (export/import). No lock-in; export anytime. | Not highlighted in core docs (may be available in API or enterprise). |
| **Dashboard** | app.memorynode.ai — workspaces, API keys, memory browser, usage, billing. | console.supermemory.ai — billing, keys, and product console. |
| **Pricing (high level)** | Launch (trial), Build, Deploy, Scale. Usage-based (writes, reads, embedding). Upgrade as needed. | Free ($0): 1M tokens, 10K search queries. Pro ($19/mo): 2–3M tokens, 100K queries. Scale ($399/mo): 80M tokens, 20M queries. Enterprise: custom, self-owned data, SLA. Overages: token processing and search queries. |
| **Target users** | Solo founders, indie devs, small teams building chatbots/copilots who want per-user memory without running a vector DB or embedding pipeline. | Developers and enterprises building AI agents; “power users and quick-moving teams” through to large orgs with dedicated support. |
| **Data ownership** | You own your data; export supported. | Enterprise tier offers “self own data” option. |

---

## Summary

- **MemoryNode**: Focused **memory API** — store, search, and context in one place. Minimal surface: no vector DB or embedding pipeline to run, no built-in RAG product, extractors, or connectors. Best for teams that want to ship quickly and own the product, not the infra.
- **Supermemory.ai**: Broader **memory + context platform** — memory API, RAG, user profiles, extractors, and advanced search (hybrid, reranking, filters). Targets more complex “context engineering” and scales to very high token and query volumes with dedicated infra and enterprise options.

*Excluded from this comparison: browser, Ray browser, MCP, and connectors, as MemoryNode does not provide these.*
