# @memorynodeai/mcp-server

Thin **Model Context Protocol (MCP)** adapter for **MemoryNode** with canonical tools and deterministic policy guardrails over stdio.

**Full documentation:** [docs/MCP_SERVER.md](../../docs/MCP_SERVER.md) (install, env vars, tools, resources, Cursor config). **Hosted URL MCP** (no local `node`): **`https://mcp.memorynode.ai/mcp`** (or `https://api.memorynode.ai/v1/mcp`) with `Authorization: Bearer …` — see the “Hosted MCP” section in that doc.

**Product positioning (ICP):** [docs/external/POSITIONING.md](../../docs/external/POSITIONING.md).

## When to use MCP vs REST

Use **MCP** when a **tooling client** should call memory without you wrapping each HTTP request. Use **REST** or the **[TypeScript SDK](../sdk/)** from your **app backend** in production. See the “When to use REST vs MCP” section in [MCP_SERVER.md](../../docs/MCP_SERVER.md).

## Install

```bash
pnpm add @memorynodeai/mcp-server
# or
npm install @memorynodeai/mcp-server
```

## CLI

After `pnpm build` in this package (or when consuming the published package), the binary **`memorynode-mcp`** runs the MCP server on stdio.

## Tool surface

- Canonical tools: `memory`, `recall`, `context`, `whoAmI`
- Deprecated aliases (non-breaking migration): `memory_insert`, `memory_search`, `memory_context`
- Structured denials include `policy_version`, `action_id`, and stable error codes.

## Required environment

| Variable               | Required | Description                                           |
| ---------------------- | -------- | ----------------------------------------------------- |
| `MEMORYNODE_API_KEY`   | Yes      | Workspace API key (`mn_live_...`).                    |
| `MEMORYNODE_BASE_URL`  | Yes      | e.g. `https://api.memorynode.ai` (no trailing slash). |
| `MEMORYNODE_USER_ID`   | No       | Default `user_id` for tools; default `default`.       |
| `MEMORYNODE_NAMESPACE` | No       | Default namespace for tools; see MCP doc.             |

Details and examples: **[docs/MCP_SERVER.md](../../docs/MCP_SERVER.md)**.

## Monorepo development

```bash
cd packages/mcp-server
pnpm install
pnpm build
pnpm start   # set MEMORYNODE_* env vars first
```

## License

MIT
