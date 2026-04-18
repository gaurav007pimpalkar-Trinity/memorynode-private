# MemoryNode.ai

**MemoryNode lets you store, retrieve, and explain why AI remembered something.**

---

## Choose your path

### 🚀 Just use it (recommended)

- No setup on your laptop  
- Works in minutes  
- Best for founders and solo developers  
- **Designed for production** customer-facing AI systems that need **reliable long-term memory**.  
- **Built for real traffic:** everyday usage patterns, including **high-volume chat** and **many users at once**, without you running a vector stack.

→ **[docs/start-here/README.md](docs/start-here/README.md)**

---

### 🧩 Build with control

- Namespaces, filters, TypeScript SDK, OpenAPI  
- For product engineers shipping real apps  

→ **[docs/build/README.md](docs/build/README.md)**

---

### ⚙️ Self-host (advanced)

- Full control of infrastructure  
- For contributors and teams running a private stack  

→ **[docs/self-host/README.md](docs/self-host/README.md)**

---

**Who it is for:** support bots, busy in-app assistants, and B2B SaaS copilots. **What we are not:** [docs/external/POSITIONING.md](docs/external/POSITIONING.md)

---

## Try the hosted API

```bash
export API_KEY=mn_live_xxx
curl -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","text":"User prefers dark mode"}'
curl -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","query":"theme preference","top_k":5}'
curl -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user-1","query":"What do we know about theme preferences?"}'
curl -G "https://api.memorynode.ai/v1/context/explain" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode "user_id=user-1" \
  --data-urlencode "query=What do we know about theme preferences?" \
  --data-urlencode "top_k=5"
```

**Step-by-step (about 10 minutes):** [docs/start-here/README.md](docs/start-here/README.md)

---

## MCP (Cursor, Claude Code, and similar)

```bash
pnpm add @memorynodeai/mcp-server
```

**Short setup:** [docs/start-here/MCP.md](docs/start-here/MCP.md) · **Package readme:** [packages/mcp-server/README.md](packages/mcp-server/README.md)

---

## Examples

- **Node:** [examples/node-quickstart/README.md](examples/node-quickstart/README.md)  
- **Python:** [examples/python-quickstart/README.md](examples/python-quickstart/README.md)

---

## Trust

- [Trust (customer-facing)](docs/external/TRUST.md) · [Data retention](docs/DATA_RETENTION.md) · [Security](docs/SECURITY.md)

---

## Optional: running locally (advanced)

Only if you chose **Self-host** above or you contribute to this repo:

1. **[docs/self-host/LOCAL_DEV.md](docs/self-host/LOCAL_DEV.md)** — environment, stub mode, first run  
2. From repo root: `pnpm dev:stub` (runs preflight, then starts the API with `wrangler dev`). To only validate `.dev.vars` without starting the server, use `pnpm preflight:dev` alone, or `pnpm dev` if you already ran preflight.

**Repository layout (contributors):**

| Path | Description |
|------|-------------|
| `apps/api` | HTTP API (Worker) |
| `apps/dashboard` | Web console |
| `packages/sdk` | TypeScript SDK |
| `packages/mcp-server` | MCP server |
| `packages/shared` | Shared types |
| `docs/start-here` | Mode 1 — quickstart |
| `docs/build` | Mode 2 — advanced usage |
| `docs/self-host` | Mode 3 — local / private deploy |

Internal runbooks: [docs/internal/README.md](docs/internal/README.md).
