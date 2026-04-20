# Next.js Middleware/Route Example

This folder shows a minimal pattern for chat memory integration:

1. Store incoming user messages as memories (`/v1/memories`)
2. Fetch relevant context (`/v1/context`)
3. Inject context into the prompt before your LLM call
4. Optionally store assistant replies back into memory

## Files

- `memorynode.ts`: tiny API helper (`storeChatMessage`, `fetchMemoryContext`)
- `route.ts`: example `POST` handler for Next.js App Router
- `demo.mjs`: runnable pseudo-integration without scaffolding a full Next app

## Use inside Next.js

1. Copy `memorynode.ts` to `lib/memorynode.ts`
2. Copy `route.ts` to `app/api/chat/route.ts`
3. Set environment variables:
   - `BASE_URL`
   - `API_KEY`
4. Call your API route with:
   - `userId` (preferred; `user_id` still supported)
   - optional `scope` (preferred; `namespace` still supported)
   - `message`

## Run the demo quickly

```bash
BASE_URL=https://<api-host> API_KEY=mn_live_... USER_ID=demo-user NAMESPACE=demo node examples/nextjs-middleware/demo.mjs
```

PowerShell:

```powershell
$env:BASE_URL="https://<api-host>"
$env:API_KEY="mn_live_..."
$env:USER_ID="demo-user"
$env:NAMESPACE="demo"
node examples/nextjs-middleware/demo.mjs
```
