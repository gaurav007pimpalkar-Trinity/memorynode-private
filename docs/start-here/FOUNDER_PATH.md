# Founder path (no repo, no infra)

You are **not** expected to clone GitHub, run databases, or read runbooks.

## Checklist

1. **Sign up** and create a workspace + API key in the product console.
2. **Call three endpoints** from the main guide: [README.md](./README.md) — `POST /v1/memories`, `POST /v1/search`, `POST /v1/context`.
3. **Hand the key to your engineer** with that page only. Everything else is optional.

## Using AI tools (Cursor, etc.)

If your team uses MCP in the editor, install the MemoryNode MCP package and set `MEMORYNODE_API_KEY` and `MEMORYNODE_BASE_URL`. Details: [MCP_SERVER.md](../../docs/MCP_SERVER.md).

## Trust and compliance

- [Trust (customer-facing)](../external/TRUST.md)
- [Data retention](../DATA_RETENTION.md)

When you need namespaces, metadata filters, or language-specific examples, switch to **[Build mode](../build/README.md)** — not required for your first ship.
