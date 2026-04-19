# MemoryNode + MCP (Mode 1)

Use this when you want **Cursor**, **Claude Code**, or another MCP-aware tool to read and write memories **without** writing your own HTTP wrapper.

## What you need

1. A MemoryNode API key (from your console).
2. The npm package **`@memorynodeai/mcp-server`** in the project where your tool runs.

## Install

```bash
pnpm add @memorynodeai/mcp-server
```

(or `npm install` / `yarn add` — same package.)

## Configure

Set environment variables your MCP host reads (names may vary; check your editor’s MCP docs):

- **`MEMORYNODE_API_KEY`** — your server-side API key.
- **`MEMORYNODE_BASE_URL`** — usually `https://api.memorynode.ai` (or your private gateway).

Full protocol details and tool list: [MCP_SERVER.md](../MCP_SERVER.md) (includes **hosted** MCP at `https://mcp.memorynode.ai/mcp`) · Package readme: [packages/mcp-server/README.md](../../packages/mcp-server/README.md).

## What happens automatically

- Canonical tools are `memory`, `recall`, `context`, and `whoAmI`.
- Container scoping uses `containerTag` (hosted header: `x-mn-container-tag`).
- Context is bounded with fixed schema and deterministic truncation.
- Recall/memory calls are guarded by policy limits (session/key/scope caps, loop protection, replay checks for writes).
- Denials are explicit and structured (for example `RATE_LIMITED`, `LOOP_DETECTED`, `COST_BUDGET_EXCEEDED`).
- Supported clients include Claude Desktop, Cursor IDE, Windsurf, VS Code MCP extensions, Cline/Roo-Cline, and any MCP-compatible host.

**Need more control?** → [Build mode](../external/API_USAGE.md).
