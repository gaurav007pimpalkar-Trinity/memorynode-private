# MemoryNode MCP Server

MemoryNode exposes MCP in two ways:

1. **stdio package** (`@memorynodeai/mcp-server`) — local process for editors; forwards to REST with env vars.
2. **Hosted Streamable HTTP** on the API worker — recommended URL **`https://mcp.memorynode.ai/mcp`** (dedicated host; routes in `apps/api/wrangler.toml`). Same MCP is also available at **`https://api.memorynode.ai/v1/mcp`**. Uses your **workspace API key** (`Authorization: Bearer …` or `x-api-key`). Optional headers: **`x-mn-user-id`** (default `default`), **`x-mn-project`** (default `mcp`, maps to MemoryNode `namespace`). Tooling calls REST on **`api.memorynode.ai`** automatically when the MCP request hits `mcp.memorynode.ai` (override with Worker var **`MEMORYNODE_REST_ORIGIN`** if needed). Canonical tools are **`memory`**, **`recall`**, **`context`**, **`whoAmI`**. Alias tools (`memory_search`, `memory_insert`, `memory_context`) are maintained for migration with deprecated metadata. No Supabase in the MCP layer—only REST.

## Canonical MCP tool contracts

- **Tool `memory`** — durable write with policy guardrails.
  - Input: `action` (`save`), `content`, optional `metadata`, required replay fields (`nonce`, `timestampMs`) for write actions.
  - Output: `status`, `decision`, `data` with `policy_version`.
- **Tool `recall`** — bounded retrieval.
  - Input: `query`, optional `top_k` (default 5, max 10), optional `includeProfile`.
  - Output: `status` (`ok`/`low_confidence`/`degraded`), `results`, `meta`.
- **Tool `context`** — fixed-schema context pipeline.
  - Input: `query`, optional `top_k`, optional `profile`.
  - Output: `context.profileFacts`, `context.relevantHistory`, `context.guidance`, `meta` with budget/truncation details.
- **Tool `whoAmI`** — scope/session identity and policy version.

All tool denials use a uniform refusal envelope:

```json
{
  "status": "denied",
  "error": {
    "code": "RATE_LIMITED",
    "message": "Request denied by policy.",
    "policy_version": "2026-04-19.1",
    "action_id": "recall",
    "scope_hash": "..."
  }
}
```

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

## Guardrails and defaults

- Policy contract version: **`2026-04-19.1`** (`x-mcp-policy-version` header on hosted responses).
- Session window defaults: total calls `<= 40/10m`, read calls `<= 12/10m`, writes `<= 6/10m`.
- API key window defaults: reads `<= 300/h`, writes `<= 60/h`.
- Scope window defaults (`workspace,user,namespace`): writes `<= 20/h`, forgets `<= 10/h`.
- Loop detection: lexical prefilter + semantic confirm, threshold `>= 3` similar queries in `120s`.
- Context budget: fixed cap `2500` chars with deterministic section truncation.
- Mutating actions require replay protection (`nonce`, `timestampMs`).
- Hosted forget flow: low-confidence/ambiguous requests return `needs_confirmation` with tokenized confirm path.

### When to use REST vs MCP

- **REST** (or the **TypeScript SDK**) — your **app backend**, edge functions, or jobs that already speak HTTP. Best when you control retries, auth, and per-tenant routing in your own code.
- **MCP** — **AI tools and editors** (e.g. Cursor) that expose Model Context Protocol tools/resources. Best when you want agents to read/write memory without writing a custom HTTP wrapper for each client.

For product positioning and ICP, see [external/POSITIONING.md](./external/POSITIONING.md).

## Required env vars

- `MEMORYNODE_API_KEY`: API key (Bearer). Required.
- `MEMORYNODE_BASE_URL`: Base URL (e.g. `https://api.memorynode.ai`). No trailing slash. Required.
- `MEMORYNODE_USER_ID`: Default user id for search/insert. Optional; default `default`.

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

## Example tool call (recall)

Client sends a tool call, e.g.:

```json
{ "name": "recall", "arguments": { "query": "user preferences", "top_k": 5 } }
```

Server calls `POST {MEMORYNODE_BASE_URL}/v1/search` with `Authorization: Bearer MEMORYNODE_API_KEY` and body `{ "user_id": "<MEMORYNODE_USER_ID>", "query": "user preferences", "top_k": 5 }`, then returns structured + text output with confidence metadata.

```text
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

| REST status | MCP error       |
| ----------- | --------------- |
| 400         | invalid_request |
| 401         | unauthorized    |
| 403         | forbidden       |
| 500         | internal_error  |

## Constraints

- **stdio package:** keeps a lightweight local in-memory policy layer for deterministic limits; no external stateful policy service.
- **Hosted `/mcp` or `/v1/mcp`:** sessions are **in-memory per isolate** (lost on cold start); use the stdio package if you need a fully local MCP process.
- Backend API contracts unchanged; adapters call the same public REST routes.
