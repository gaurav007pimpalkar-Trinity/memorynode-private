## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# Recipe: SMB / high-volume chatbot

**Goal:** WhatsApp- or web-chat bots that talk to **many** end-users, need **cheap, predictable** behavior, and must not **hallucinate** past deals.

## Model

- **`userId`:** phone number id, CRM id, or opaque id per chatter (stable across days).
- **`scope`:** e.g. `whatsapp` or `storefront` so you can split campaigns.

## 1. Minimal loop (same as core quickstart)

Insert → search or context. See [Quickstart](./QUICKSTART.md) for curl.

## 2. Plan for caps and errors

High volume hits **fair-use and plan caps**. Your app should handle:

- **`daily_cap_exceeded`** — backoff, upgrade messaging, or queue until tomorrow.
- **`monthly_cap_exceeded`** — billing period limit; same UX pattern.
- **`RATE_LIMITED`** — exponential backoff; do not tight-loop retries.

Details and codes: [external README](./README.md) and [API usage](./API_USAGE.md).

## 3. Cost-conscious tips

- Prefer **shorter memory text** (one fact per write) over dumping whole transcripts every turn.
- Use **`search_mode`** / filters from [API usage](./API_USAGE.md) when you want keyword-only passes to reduce embedding spend (when supported for your tier).

## 4. Runnable minimal example

Clone the repo and run:

```bash
cd examples/support-bot-minimal
export API_KEY="mn_live_..."
export BASE_URL="https://api.memorynode.ai"
node index.mjs
```

That script uses a `support` scope pattern you can copy for chatbots.

Legacy aliases (`user_id`, `namespace`) remain supported for compatibility.
