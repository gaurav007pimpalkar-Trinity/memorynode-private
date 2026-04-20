# Support-bot minimal example

Runnable **insert → search → context** loop with a **`support`** scope (SDK/example env uses `NAMESPACE`) — copy this pattern for WhatsApp or web chat bots.

## Prerequisites

- Node.js 20+
- MemoryNode API key (`mn_live_...`)

## Run

From **repo root**:

```bash
export BASE_URL="https://api.memorynode.ai"
export API_KEY="mn_live_..."
export USER_ID="demo-customer-1"
node examples/support-bot-minimal/index.mjs
```

Optional: override `NAMESPACE` (maps to API `scope`; default `support`).

## What it demonstrates

- Storing a **short ticket-style fact** instead of a full transcript.
- Searching before the model turn.
- Fetching **`context_text`** for a system prompt.

See [docs/external/RECIPE_SUPPORT_AGENT.md](../../docs/external/RECIPE_SUPPORT_AGENT.md) for the full recipe.
