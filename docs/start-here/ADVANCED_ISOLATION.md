# Advanced isolation and routing

This page describes how MemoryNode routes requests internally while keeping public input simple.

## Public vs internal names

- Public API inputs: `userId`, optional `scope`
- Legacy aliases: `user_id`, `namespace` (still accepted)
- Internal isolation key: `containerTag`

The dashboard and docs use "Project" as user-facing language. Internal ownership/billing primitives still use workspace IDs.

## Routing precedence

Requests resolve in this order:

1. Scoped API key lock (`scoped_container_tag`) if present.
2. Explicit `containerTag` (advanced override path).
3. Derived internal tag from `userId` + optional `scope`.
4. Shared app default when `userId` is absent (`shared_default`).

## Failure fallback path

If subject resolution cannot complete (for example a transient registry issue), routing falls back to a deterministic derived tag so requests remain isolated and available.

When fallback is used, responses include:

- `x-mn-routing-fallback: 1`

## Debug header policy

- Non-production: routing debug headers are emitted by default.
- Production: set `x-mn-debug-routing: 1` to request routing debug headers.

Available debug headers:

- `x-mn-resolved-container-tag`
- `x-mn-routing-mode`
- `x-mn-scope-override` (scoped key forced override)
- `x-mn-routing-fallback` (fallback path was used)

## MCP routing notes

For hosted MCP, routing follows the same precedence:

1. scoped key lock
2. explicit `x-mn-container-tag`
3. `x-mn-user-id` + optional `x-mn-scope`

## Recommended usage

- Most teams should only send `userId` and optional `scope`.
- Use explicit `containerTag` only for advanced migration or compatibility scenarios.
