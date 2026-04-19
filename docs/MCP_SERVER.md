# MemoryNode MCP Server

MemoryNode exposes MCP in two ways:

1. **stdio package** (`@memorynodeai/mcp-server`) — local process for editors; forwards to REST with env vars.
2. **Hosted Streamable HTTP** on the API worker — recommended URL **`https://mcp.memorynode.ai/mcp`** (dedicated host; routes in `apps/api/wrangler.toml`). Same MCP is also available at **`https://api.memorynode.ai/v1/mcp`**. Uses your **workspace API key** (`Authorization: Bearer …` or `x-api-key`). Optional headers: **`x-mn-user-id`** (default `default`), **`x-mn-project`** (default `mcp`, maps to MemoryNode `namespace`). Tooling calls REST on **`api.memorynode.ai`** automatically when the MCP request hits `mcp.memorynode.ai` (override with Worker var **`MEMORYNODE_REST_ORIGIN`** if needed). MemoryNode-branded tools/resources/prompts: **`memory`**, **`recall`**, **`whoAmI`**; resources **`memorynode://profile`**, **`memorynode://projects`**; prompt **`context`**. No Supabase in the MCP layer—only REST.

## What the stdio package does

- **Tool `memory_search`** — Semantic + recency-aware search. Input: `query` (required), `limit` (optional, default 5, max 20). Calls `POST /v1/search`.
- **Tool `memory_context`** — Prompt-ready context. Calls `POST /v1/context`.
- **Tool `memory_insert`** — Store a memory. Input: `content` (required, max 10k chars), `metadata` (optional, stringified max 5KB). Calls `POST /v1/memories`.
- **Resource `memory://search?q=...`** — Read-only search. Parse `q`, call same `/v1/search`, return markdown results. Missing `q` → invalid_request.

All ranking and workspace isolation stay server-side; the MCP adapter only forwards requests with your API key.

## Hosted MCP (Cursor, Claude, VS Code, etc.)

**DNS:** create **`mcp.memorynode.ai`** in the `memorynode.ai` zone (proxied through Cloudflare). Deploy the API worker so the **`mcp.memorynode.ai/*`** route is active (see `wrangler.toml`).

Add a **url** server in your client MCP config (example: Cursor `mcp.json`). Prefer the MCP subdomain:

```json
{
  "mcpServers": {
    "memorynode": {
      "url": "https://mcp.memorynode.ai/mcp",
      "headers": {
        "Authorization": "Bearer mn_live_xxx"
      }
    }
  }
}
```

Same behavior on the API host (alternative URL):

```json
{ "mcpServers": { "memorynode": { "url": "https://api.memorynode.ai/v1/mcp", "headers": { "Authorization": "Bearer mn_live_xxx" } } } }
```

Optional project and user slice (same as setting `MEMORYNODE_USER_ID` / namespace on the stdio server):

```json
{
  "mcpServers": {
    "memorynode": {
      "url": "https://mcp.memorynode.ai/mcp",
      "headers": {
        "Authorization": "Bearer mn_live_xxx",
        "x-mn-user-id": "default",
        "x-mn-project": "my-repo"
      }
    }
  }
}
```

Per-tool **`containerTag`** overrides the namespace for that call (same idea as a project tag). Sessions use **`mcp-session-id`** after `initialize` (Streamable HTTP); the worker keeps sessions in memory until idle expiry or `DELETE`.

Authentication is **API key only** on this path (no OAuth on the MCP URL yet).

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

- **stdio package:** no episode logging, analytics, rate limiting, retries, or background workers in the package; no extra config beyond env vars.
- **Hosted `/mcp` or `/v1/mcp`:** sessions are **in-memory per isolate** (lost on cold start); use the stdio package if you need a fully local MCP process.
- Backend API contracts unchanged; adapters call the same public REST routes.
