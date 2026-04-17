# MemoryNode MCP Server

Thin MCP (Model Context Protocol) adapter for MemoryNode. Exposes **search** and **insert** over stdio. No Supabase access, no business logic—calls existing REST APIs only.

## What it does

- **Tool `memory_search`** — Semantic + recency-aware search. Input: `query` (required), `limit` (optional, default 5, max 20). Calls `POST /v1/search`.
- **Tool `memory_insert`** — Store a memory. Input: `content` (required, max 10k chars), `metadata` (optional, stringified max 5KB). Calls `POST /v1/memories`.
- **Resource `memory://search?q=...`** — Read-only search. Parse `q`, call same `/v1/search`, return markdown results. Missing `q` → invalid_request.

All ranking and workspace isolation stay server-side; the MCP server only forwards requests with your API key.

### When to use REST vs MCP

- **REST** (or the **TypeScript SDK**) — your **app backend**, edge functions, or jobs that already speak HTTP. Best when you control retries, auth, and per-tenant routing in your own code.
- **MCP** — **AI tools and editors** (e.g. Cursor) that expose Model Context Protocol tools/resources. Best when you want agents to read/write memory without writing a custom HTTP wrapper for each client.

For product positioning and ICP, see [external/POSITIONING.md](./external/POSITIONING.md).

## Required env vars

| Variable | Description |
|----------|-------------|
| `MEMORYNODE_API_KEY` | API key (Bearer). Required. |
| `MEMORYNODE_BASE_URL` | Base URL (e.g. `https://api.memorynode.ai`). No trailing slash. Required. |
| `MEMORYNODE_USER_ID` | Default user id for search/insert. Optional; default `default`. |

If `MEMORYNODE_API_KEY` or `MEMORYNODE_BASE_URL` is missing, the server exits at startup with a clear error.

## Run locally

```bash
# From repo root
cd packages/mcp-server
pnpm install
pnpm build

# Set env then run (stdio)
export MEMORYNODE_API_KEY=your_key
export MEMORYNODE_BASE_URL=https://api.memorynode.ai
pnpm start
```

Or use a `.env` file and load it before starting (e.g. `dotenv` or your shell).

### Example .env

```env
MEMORYNODE_API_KEY=mn_...
MEMORYNODE_BASE_URL=https://api.memorynode.ai
MEMORYNODE_USER_ID=default
```

## Example tool call (memory_search)

Client sends a tool call, e.g.:

```json
{ "name": "memory_search", "arguments": { "query": "user preferences", "limit": 5 } }
```

Server calls `POST {MEMORYNODE_BASE_URL}/v1/search` with `Authorization: Bearer MEMORYNODE_API_KEY` and body `{ "user_id": "<MEMORYNODE_USER_ID>", "query": "user preferences", "top_k": 5 }`, then returns formatted text:

```
Result 1
Score: 0.82
Content: ...

Result 2
Score: ...
```

## Example resource (memory://search)

Resource URI: `memory://search?q=hello`

Server calls the same `/v1/search` and returns markdown-formatted results. If `q` is missing, returns invalid_request.

## Connect in Claude Desktop

Add the server to your Claude Desktop config (e.g. `%APPDATA%\Claude\claude_desktop_config.json` on Windows, or macOS equivalent):

```json
{
  "mcpServers": {
    "memorynode": {
      "command": "node",
      "args": ["C:/path/to/MemoryNode.ai/packages/mcp-server/dist/index.js"],
      "env": {
        "MEMORYNODE_API_KEY": "your_api_key",
        "MEMORYNODE_BASE_URL": "https://api.memorynode.ai"
      }
    }
  }
}
```

Use the path to the built `dist/index.js` and ensure `MEMORYNODE_API_KEY` and `MEMORYNODE_BASE_URL` are set in `env`. Restart Claude Desktop after changing the config.

## Error mapping (REST → MCP)

| REST status | MCP error |
|-------------|-----------|
| 400        | invalid_request |
| 401        | unauthorized   |
| 403        | forbidden      |
| 500        | internal_error |

## Constraints (Phase 3)

- No episode logging, analytics, rate limiting, retries, or background workers.
- No extra endpoints or config beyond env vars.
- Backend API contracts unchanged; this is a thin adapter only.
