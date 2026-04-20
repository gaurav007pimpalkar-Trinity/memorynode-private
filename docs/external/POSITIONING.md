## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# MemoryNode — positioning and ICP

This file is the **canonical product narrative** for MemoryNode. Other READMEs and landing copy should align here or link here so messaging does not drift.

## One-line promise

**MemoryNode lets you store, retrieve, and explain why AI remembered something.** MemoryNode decides what to surface (scoring, types, decay), shows why retrieval picked each path, and retrieval improves using recency and usage signals without you running a RAG lab. Ship without operating your own vector stack.

## Who it is for (ICP)

Primary:

- **Individual builders** — ship personal assistants, side projects, or solo products that need durable memory without building a custom RAG stack.
- **Teams / organizations** — centralize product memory for support, success, and internal copilots.
- **AI agents / applications** — use MemoryNode as a hosted memory layer for structured recall across sessions.
- **Support and success copilots** — bots that must remember ticket context, prior promises, and account facts.
- **SMB and messaging-channel bots** — high-volume chat where repeating questions erodes trust.
- **B2B SaaS copilots** — in-app assistants scoped per account with `userId` + optional `scope`.

Secondary:

- Agencies shipping the above patterns for clients.
- Developers using **MCP**-connected tools who want memory tools without custom glue.

## What MemoryNode is

- A **hosted API** plus **console** for projects, API keys, usage, and billing.
- **Long-lived memories** you define (text and optional metadata), chunked and embedded server-side, retrieved with **hybrid search** and **prompt-ready context** (`POST /v1/context`).
- **Deterministic ranking system:** types (e.g. fact, preference), dedupe hooks, recency-aware ranking, and importance/retrieval signals — not “dumb storage with a vector bolt-on.”
- **Core debugging visibility:** explainability (`GET /v1/context/explain`), query history, and replay so teams can see **which chunks scored how** and stop guessing when context is wrong.
- **Tenant boundary:** projects organize access and billing. They do not own memories.
- **Ownership model:** most apps use `userId` + optional `scope`; internal owner semantics remain supported. Legacy `user_id` and `entity_*` aliases remain supported.

## Who can own memory?

- Individual users
- Teams
- Apps / AI systems

## Explicit non-goals

MemoryNode is **not**:

- A **universal knowledge platform** that syncs all of Notion, Slack, Drive, and email out of the box.
- A **replacement for your data warehouse** or analytical lake.
- A **full autonomous agent operating system** (tool orchestration, long-running workers, etc.) — we are the **memory layer**, not the whole agent stack.

## REST vs MCP (when to use which)

- Use **REST** (or the **TypeScript SDK**) when your **app** owns the HTTP lifecycle: web backends, mobile apps, strict request/response flows.
- Use **MCP** when **AI tools and editors** should read/write memory over the Model Context Protocol without you wrapping each call. See [MCP_SERVER.md](../MCP_SERVER.md).

## Where to go next

- [Quickstart](./QUICKSTART.md) — first API calls in minutes.
- [Support-style agent recipe](./RECIPE_SUPPORT_AGENT.md)
- [SaaS copilot recipe](./RECIPE_SAAS_COPILOT.md)
- [SMB / high-volume chatbot recipe](./RECIPE_SMB_CHATBOT.md)
- [Trust (customer-facing)](./TRUST.md) and [Data retention](./../DATA_RETENTION.md)
- [US vs India audiences](./AUDIENCES_US_IN.md) — same product, different proof order.
