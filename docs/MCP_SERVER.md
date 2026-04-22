# MemoryNode MCP server

MemoryNode exposes two MCP surfaces:

- **Hosted MCP** — Streamable HTTP JSON-RPC served by the `memorynode-api` Worker at `POST /v1/mcp` and `POST /mcp`. Handler: [apps/api/src/mcpHosted.ts](../apps/api/src/mcpHosted.ts). Tool registry: [packages/mcp-core/](../packages/mcp-core/).
- **stdio MCP** — local binary `memorynode-mcp` (`@memorynodeai/mcp-server`). Source: [packages/mcp-server/src/index.ts](../packages/mcp-server/src/index.ts). Server name reported in the MCP init handshake: `memorynode-mcp` v1.1.0.

Both surfaces call the MemoryNode REST API; the hosted surface can short-circuit `search` and `list_memories` through `hostedDirectSearch` / `hostedDirectListMemories` to avoid HTTP hops.

## 1. Hosted MCP

### 1.1 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/mcp`, `/mcp` | JSON-RPC request (`initialize` / `tools/list` / `tools/call`) |
| `GET` | `/v1/mcp`, `/mcp` | Browser landing or SSE subscription |
| `DELETE` | `/v1/mcp`, `/mcp` | Close session |

Authentication uses the same API key as REST (`Authorization: Bearer <key>` or `x-api-key`). CORS is permissive for MCP paths; non-MCP routes still enforce `ALLOWED_ORIGINS`.

### 1.2 Session and cache TTLs

Constants live in [apps/api/src/mcpHosted.ts](../apps/api/src/mcpHosted.ts):

- Session cache: in-memory `Map`, `MAX_SESSIONS = 2000`, `SESSION_TTL_MS = 60 * 60 * 1000` (1 hour). LRU eviction drops the oldest 100 sessions when the cap is hit.
- Response cache ([apps/api/src/mcpCache.ts](../apps/api/src/mcpCache.ts)): `maxSize: 400`, per-tool TTL — `recall: 15_000 ms`, `context: 8_000 ms`.

### 1.3 Internal subrequest secret

When hosted MCP fans out to REST it sets `x-internal-mcp: 1` and `x-internal-secret: <MCP_INTERNAL_SECRET>`. Only those subrequests skip duplicate edge rate limits. `MCP_INTERNAL_SECRET` must be set in every deployment that uses hosted MCP.

### 1.4 REST origin

`resolveRestApiOrigin` resolves the REST base:

- `MEMORYNODE_REST_ORIGIN` if set.
- Else if the request hit `mcp.memorynode.ai`, use `https://api.memorynode.ai`.
- Else the request origin.

### 1.5 Tool catalog

Registered by `registerAllHostedTools` in [packages/mcp-core/src/registry/registerAllTools.ts](../packages/mcp-core/src/registry/registerAllTools.ts). Manifest version is exported as `TOOL_MANIFEST_VERSION`; policy version as `MCP_POLICY_VERSION`.

| Tool | Group | Purpose |
| --- | --- | --- |
| `recall` | search | Hybrid vector + keyword search (bounded `top_k ≤ 10`). |
| `search` | search | Alias of `recall`. |
| `memory_search` | search | Lower-level search call (bounded). |
| `context` | profile | Prompt-ready context pack. |
| `context_pack` | profile | Alias of `context`. |
| `memory_context` | profile | Same as `context` with extended schema. |
| `memory_insert` | profile | Write a memory via profile engine. |
| `identity_get` | profile | Return resolved scope identity. |
| `whoAmI` / `whoami` | profile | Report session workspace + scope. |
| `memory` | memory | Conversational memory multiplexer. |
| `memory_save` | memory | Persist a memory. |
| `memory_forget` | memory | Stage a forget request. |
| `memory_forget_confirm` | memory | Confirm staged forget. |
| `memory_get` | memory (p1 hosted) | Fetch by id. |
| `memory_list` | memory (p1 hosted) | Paginated list. |
| `memory_delete` | memory (p1 hosted) | Delete by id. |
| `memory_conversation_save` | memory (p1 hosted) | Persist a conversation. |
| `ingest_dispatch` | memory (p1 hosted) | Discriminated ingest (text / conversation / import). |
| `eval_run` | memory (p1 hosted) | Execute an eval set. |
| `connector_settings_get` | connectors | Requires `plan === "team"` unless `MCP_CONNECTOR_SETTINGS_REQUIRES_TEAM=false`. |
| `connector_settings_update` | connectors | Same plan gate. |
| `usage_today` | billing | Current-day usage snapshot. |
| `audit_log_list` | billing | Requires `plan === "team"` unless `MCP_AUDIT_LOG_REQUIRES_TEAM=false`. |
| `billing_get` | billing | Current `workspace_entitlements`. |
| `billing_checkout_create` | billing | Initiate PayU checkout. |
| `billing_portal_create` | billing | **Always returns HTTP 410** (Stripe portal retired). |

Every tool call flows through `McpPolicyEngine` ([packages/shared/src/mcp-policy.ts](../packages/shared/src/mcp-policy.ts)) which emits `mcp_policy_before`, `mcp_policy_after`, and `mcp_tool_execution` logs with policy version and session scope.

### 1.6 Rate limits and quotas

Every MCP call goes through the same `rateLimit` / `rateLimitWorkspace` pipeline as REST and consumes the per-route RPM defined by `getRouteRateLimitMax`. Quotas for search, context, memory, and ingest tools debit through `reserve_usage_if_within_cap` + `commit_usage_reservation` just like REST.

### 1.7 Errors

Hosted MCP returns JSON-RPC errors whose `.data` carries the same `{code, message}` envelope used by REST (see [docs/external/API_USAGE.md §3](./external/API_USAGE.md)). Non-RPC-level failures (auth, rate limit) return HTTP error responses before reaching JSON-RPC.

## 2. stdio MCP

### 2.1 Install and run

```bash
npm install -g @memorynodeai/mcp-server
memorynode-mcp
```

Configure your MCP-speaking client (Claude Desktop, Cursor, etc.) to launch the binary with the env vars below. Source: [packages/mcp-server/src/index.ts](../packages/mcp-server/src/index.ts).

### 2.2 Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `MEMORYNODE_API_KEY` | yes | Bearer key for REST calls. |
| `MEMORYNODE_API_BASE` | no | Default `https://api.memorynode.ai`. |
| `MEMORYNODE_USER_ID` | no | Default owner id for tool calls. |
| `MEMORYNODE_NAMESPACE` | no | Default namespace. |
| `MEMORYNODE_TIMEOUT_MS` | no | Per-request timeout. |

### 2.3 Tools

| Tool | Purpose |
| --- | --- |
| `recall` | Hybrid search. |
| `context` | Prompt-ready context pack. |
| `memory` | Conversational memory multiplexer. |
| `whoAmI` | Current scope / workspace. |
| `memory_search` | Lower-level search. |
| `memory_context` | Explicit context call. |
| `memory_insert` | Write a memory. |

The stdio binary is a strict subset of hosted MCP; billing, connector settings, and admin-adjacent tools are hosted-only.

## 3. Upstream constraints

- `top_k` capped at 10 for `recall` / `search`.
- `containerTag` capped at 128 chars; sanitized to `[-a-zA-Z0-9_.:]`.
- Policy engine may deny unsafe repetition (`loopConfidence`) or forbidden scopes; hosted MCP returns the denial reason in the tool result.
- All hosted MCP responses include `x-request-id` header for log correlation.
