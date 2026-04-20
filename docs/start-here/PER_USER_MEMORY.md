# Per-user memory

Use this guide when you want personalized memory for each end user.

## The default pattern

1. Pick a stable `userId` from your app (for example your internal user UUID).
2. Store facts with `POST /v1/memories`.
3. Retrieve with `POST /v1/search` or `POST /v1/context`.
4. Verify ranking with `GET /v1/context/explain`.

If you keep the same `userId`, MemoryNode keeps continuity for that user across sessions.

## First-success loop (recommended)

Run this exact sequence for your first integration check:

1. Save one memory.
2. Immediately call `context` for the same `userId`.
3. Confirm the response contains your stored detail.
4. Call `context/explain` to see why it was ranked.

This proves your write path and retrieval path are wired correctly.

## Request shape

Use public fields:

- `userId` (recommended)
- optional `scope`

Legacy aliases still accepted for compatibility:

- `user_id` -> `userId`
- `namespace` -> `scope`

## Missing `userId`

If `userId` is omitted, requests route to a shared app bucket (`shared_default`).

That is useful for global app memory, but not for user-personalized memory.

## Continue

- Need controlled separation inside a user? -> [SCOPES.md](./SCOPES.md)
- Need routing internals and precedence? -> [ADVANCED_ISOLATION.md](./ADVANCED_ISOLATION.md)
