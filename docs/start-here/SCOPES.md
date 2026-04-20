## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# Scopes

Use `scope` when one user can have multiple memory contexts.

Examples:

- `support` for support conversations
- `sales` for deal context
- `copilot` for product assistant context

## Rule of thumb

- Start with no scope if you only need one memory stream per user.
- Add `scope` only when you need hard separation within the same user.

## Keep scope stable

Use short, stable scope values (for example `support`, not timestamps or random IDs).

Good:

- `support`
- `billing`
- `web-app`

Avoid:

- `session-2026-04-20-13-44`
- `temp-${random}`

Changing scope values frequently fragments retrieval across many tiny buckets.

## Scope + userId

Memory continuity depends on both values:

- same `userId` + same `scope` -> same isolated memory stream
- same `userId` + different `scope` -> separate isolated memory streams

## Continue

- Need exact routing precedence and debug headers? -> [ADVANCED_ISOLATION.md](./ADVANCED_ISOLATION.md)
