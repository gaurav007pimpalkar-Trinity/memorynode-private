<p align="center">
  <strong>MemoryNode</strong>
</p>

<p align="center">
  <strong>Per-user memory for AI apps — store, search, and ship without running a vector database.</strong>
</p>

<p align="center">
  <a href="https://console.memorynode.ai">Console</a>
  ·
  <a href="https://api.memorynode.ai">API</a>
  ·
  <a href="https://www.npmjs.com/package/@memorynodeai/sdk">SDK (npm)</a>
  ·
  <a href="./docs/TRUST.md">Trust</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@memorynodeai/sdk"><img src="https://img.shields.io/npm/v/@memorynodeai/sdk?style=flat-square&color=blue" alt="npm @memorynodeai/sdk" /></a>
  <a href="https://www.npmjs.com/package/@memorynodeai/mcp-server"><img src="https://img.shields.io/npm/v/@memorynodeai/mcp-server?style=flat-square&color=blue" alt="npm @memorynodeai/mcp-server" /></a>
</p>

---

This repository is a **minimal quickstart** for the hosted MemoryNode API. Use it to verify your API key, run one script, and see add + search in under a minute.

**Trust, security, and retention:** [docs/TRUST.md](./docs/TRUST.md) · [docs/SECURITY.md](./docs/SECURITY.md) · [docs/DATA_RETENTION.md](./docs/DATA_RETENTION.md)

**Positioning (ICP and non-goals):** [docs/POSITIONING.md](./docs/POSITIONING.md)

**SDK and HTTP details:** [@memorynodeai/sdk on npm](https://www.npmjs.com/package/@memorynodeai/sdk). This public repository stays intentionally small (quickstart + curated trust docs).

---

## Features

- **Store memories** — Text and metadata scoped by `userId` and namespace (maps to API `scope`).
- **Semantic search** — Natural-language query over a user’s memories.
- **Official SDK** — [`@memorynodeai/sdk`](https://www.npmjs.com/package/@memorynodeai/sdk) for Node/TypeScript backends.
- **MCP** — For editors and agents, use [`@memorynodeai/mcp-server`](https://www.npmjs.com/package/@memorynodeai/mcp-server) or hosted MCP (see npm readme / your operator docs).

---

## Get an API key

1. Open **[console.memorynode.ai](https://console.memorynode.ai)**.
2. Create a project and an API key.
3. Export it as `API_KEY` for the commands below.

---

## Quickstart (this repo)

**Prerequisites:** Node.js **20+**

```bash
git clone https://github.com/gaurav007pimpalkar-Trinity/memorynode.git
cd memorynode
npm install
export API_KEY=your_api_key_here
npm start
```

On Windows (PowerShell):

```powershell
$env:API_KEY="your_api_key_here"
npm start
```

The script adds a sample memory, runs search, and prints JSON. Source: [`index.mjs`](./index.mjs).

**Optional:** `export BASE_URL=https://api.memorynode.ai` (default if unset).

---

## Try the HTTP API directly

```bash
export API_KEY=mn_live_xxx
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user-1","scope":"default","text":"User prefers dark mode"}'
curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user-1","scope":"default","query":"theme","top_k":5}'
```

---

## License

MIT — see [LICENSE](./LICENSE).
