## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# MemoryNode.ai — Engine Skeleton (Internal Architecture)

> **Supporting reference.** Diagrams mirror the Worker layout; validate handler names and order against `apps/api/src/router.ts` and `workerApp.ts` after refactors.

**Purpose:** A technical view of the product’s “engine” — request pipeline, routing, handlers, and how data flows through the system.

---

## 1. Engine overview (inside the API)

```
                    ┌─────────────────────────────────────────────────────────────────┐
                    │                     CLOUDFLARE WORKER (apps/api)                  │
                    │                                                                   │
  Request ────────► │  index.ts (fetch)                                                │
                    │       │                                                           │
                    │       ▼                                                           │
                    │  workerApp.handleRequest()                                        │
                    │       │                                                           │
                    │       ├─► CORS / body size / security / request-id                │
                    │       ├─► /healthz → 200 (early exit)                              │
                    │       ├─► createSupabaseClient(env)                                │
                    │       ├─► Auth: dashboard session OR API key → auditCtx.workspaceId │
                    │       ├─► rateLimit(env)  ◄── RateLimitDO (Durable Object)         │
                    │       │                                                           │
                    │       ▼                                                           │
                    │  router.route()  ── path + method ──► Handler                      │
                    │       │                                                           │
                    │       ▼                                                           │
                    │  Handler (memories | search | context | usage | billing | …)       │
                    │       │                                                           │
                    │       ├──────────────────┬──────────────────┬─────────────────   │
                    │       ▼                  ▼                  ▼                     │
                    │  Supabase           embedText()          bumpUsage()              │
                    │  (Postgres)         (OpenAI)             (caps/limits)            │
                    │       │                  │                     │                 │
                    └───────┼──────────────────┼─────────────────────┼─────────────────┘
                            │                  │                     │
                            ▼                  ▼                     │
                    ┌───────────────┐  ┌───────────────┐              │
                    │   Supabase    │  │   OpenAI      │              │
                    │   (DB + Auth) │  │  embeddings   │              │
                    └───────────────┘  └───────────────┘              │
                                                                     │
                            PayU (billing webhooks / checkout) ◄──────┘
```

---

## 2. Request pipeline (skeleton)

Step-by-step flow inside `workerApp.ts`:

```mermaid
flowchart TB
    subgraph Entry["Entry"]
        A[fetch → index.ts] --> B[handleRequest]
    end

    subgraph Pipeline["Pipeline (workerApp)"]
        B --> C[CORS / body limit / security / request-id]
        C --> D{path === /healthz?}
        D -->|yes| E[200 OK]
        D -->|no| F[createSupabaseClient]
        F --> G{Dashboard route?}
        G -->|yes| H[Session cookie + CSRF]
        G -->|no| I[API key auth → workspaceId]
        H --> J[rateLimit]
        I --> J
        J --> K[route]
        K --> L[Handler]
    end

    subgraph HandlerDeps["Handler has access to"]
        L --> M[Supabase client]
        L --> N[embedText - OpenAI]
        L --> O[bumpUsage / checkCaps]
        L --> P[env, auditCtx, requestId]
    end
```

---

## 3. Router → handlers (skeleton)

Path + method map to handler modules:

```mermaid
flowchart LR
    subgraph Router["router.route()"]
        R[path + method]
    end

    subgraph Handlers["handlers/"]
        R --> M[memories.ts\nCreate, List, Get, Delete]
        R --> S[search.ts\nPOST /v1/search]
        R --> C[context.ts\nPOST /v1/context]
        R --> U[usage.ts\nGET /v1/usage/today]
        R --> B[billing.ts\nCheckout, Portal, Webhook]
        R --> W[webhooks.ts]
        R --> A[admin.ts]
        R --> E[export.ts]
        R --> I[import.ts]
        R --> WS[workspaces.ts]
        R --> K[apiKeys.ts]
        R --> EV[eval.ts]
    end
```

| Route area      | Paths / methods              | Handler module   |
|-----------------|------------------------------|------------------|
| Memories        | `POST/GET/DELETE /v1/memories`| `handlers/memories.ts` |
| Search          | `POST /v1/search`            | `handlers/search.ts`  |
| Context         | `POST /v1/context`           | `handlers/context.ts` |
| Usage           | `GET /v1/usage/today`        | `handlers/usage.ts`  |
| Billing         | checkout, portal, webhook    | `handlers/billing.ts` |
| Dashboard       | `/v1/dashboard/*`            | session, projects (internal workspaces), apiKeys |
| Admin / Export / Import / Eval | various | respective handlers |

---

## 4. Core data flow: memory write

What happens inside the engine when a memory is created:

```mermaid
flowchart TB
    subgraph In["Request"]
        REQ[POST /v1/memories]
    end

    subgraph API["API engine"]
        REQ --> H[handleCreateMemory]
        H --> PARSE[Parse body]
        PARSE --> CHUNK[chunkText]
        CHUNK --> EMBED[embedText chunks]
        EMBED --> DB[(memories + memory_chunks)]
        DB --> BUMP[bumpUsage writes + embeds]
        BUMP --> RES[Response]
    end

    subgraph External["External"]
        EMBED -.->|OpenAI| OAI[text-embedding-3-small]
        DB -.->|Supabase| SB[(Postgres + pgvector)]
    end
```

---

## 5. Core data flow: search / context

What happens when the app asks for search or context:

```mermaid
flowchart TB
    subgraph In["Request"]
        REQ[POST /v1/search or /v1/context]
    end

    subgraph API["API engine"]
        REQ --> H[handleSearch / handleContext]
        H --> EMBED[embedText query]
        EMBED --> RPC[Supabase RPC: vector + keyword]
        RPC --> BUMP[bumpUsage reads + embeds]
        BUMP --> FORMAT[Format results / context]
        FORMAT --> RES[Response]
    end

    subgraph External["External"]
        EMBED -.->|OpenAI| OAI[Embeddings]
        RPC -.->|Supabase| SB[(memory_chunks\nvector + tsvector)]
    end
```

---

## 6. Component dependency skeleton

```mermaid
flowchart TB
    subgraph Apps["Apps"]
        DASH[apps/dashboard\nReact + Vite]
        API[apps/api\nWorker]
    end

    subgraph Packages["Packages"]
        SHARED[packages/shared\nplans, types]
        SDK[packages/sdk\nMemoryNodeClient]
    end

    subgraph API_Internals["API internals"]
        IDX[index.ts]
        APP[workerApp.ts]
        RTR[router.ts]
        IDX --> APP
        APP --> RTR
        RTR --> MEM[handlers/memories]
        RTR --> SRC[handlers/search]
        RTR --> CTX[handlers/context]
        RTR --> OTH[handlers/usage, billing, ...]
    end

    subgraph Storage_External["Storage & external"]
        SB[(Supabase)]
        OAI[OpenAI]
        PAYU[PayU]
        RL[RateLimitDO]
    end

    DASH --> API
    SDK --> API
    API --> SHARED
    APP --> RL
    MEM --> SB
    MEM --> OAI
    SRC --> SB
    SRC --> OAI
    CTX --> SB
    CTX --> OAI
    OTH --> SB
    OTH -.-> PAYU
```

---

## 7. File skeleton (key files)

| Layer        | File(s)              | Role |
|-------------|----------------------|------|
| Entry       | `apps/api/src/index.ts` | Worker `fetch`, exports `RateLimitDO` |
| Pipeline    | `apps/api/src/workerApp.ts` | CORS, auth, Supabase, rate limit, **route()**, handler wiring |
| Routing     | `apps/api/src/router.ts` | Path+method → handler |
| Auth        | `apps/api/src/auth.ts` | API key -> project context (internal workspace); dashboard session |
| Handlers    | `apps/api/src/handlers/*.ts` | Memories, search, context, usage, billing, admin, export, import, workspaces, apiKeys, eval, webhooks |
| Embeddings  | Inline in `workerApp.ts` | `embedText()` → OpenAI or stub |
| Rate limit  | `apps/api/src/rateLimitDO.ts` | Durable Object |
| Storage     | Supabase (Postgres)  | `infra/sql/*.sql` migrations; tables: workspaces, api_keys, memories, memory_chunks, usage_daily, billing, etc. |
| Plans/limits| `packages/shared` + `apps/api/src/limits.js` | Caps, `checkCapsAndMaybeRespond`, `bumpUsage` |

---

*This doc describes the internal engine/skeleton of MemoryNode.ai. For a high-level product view, see [ARCHITECTURE_CEO.md](ARCHITECTURE_CEO.md).*
