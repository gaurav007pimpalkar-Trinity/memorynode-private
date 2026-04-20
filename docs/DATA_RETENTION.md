# Data retention and lifecycle (customer-facing)

Plain-language summary of what MemoryNode stores, how long it is kept, and how you can **export** or **delete** data. For technical security controls, see [SECURITY.md](./SECURITY.md).

## What we store (product data)

- **Memories** — text and optional metadata you send via the API; chunked and embedded for search. Scoped to your **project** and the **`userId`** / optional **`scope`** you provide.
- **API keys** — stored as hashes; the dashboard shows only a **prefix** after creation.
- **Dashboard sessions** — short-lived rows used to bind your browser session to a project (see [SECURITY.md](./SECURITY.md)).
- **Billing and usage records** — as needed to run plans, invoices, and abuse protection.
- **Operational logs** — for example request audit metadata (route, status, timing) used for reliability and security. Retention follows operational policy and infrastructure limits for your deployment.

## What we do not use MemoryNode for

- We do **not** use customer memory content to train foundation models for unrelated products.
- We do **not** store raw API keys in the browser (see [SECURITY.md](./SECURITY.md)).

## Your controls

- **Delete memories** — via API (`DELETE /v1/memories/:id`) or dashboard flows that call the API. See [API usage](./external/API_USAGE.md).
- **Export** — use documented export paths for your project where available ([external README](./external/README.md)).
- **Revoke keys** — create and revoke API keys from the console to cut off access.

## Retention in practice

- **Memories** persist until **you delete them** or the **project** is closed and data is removed per your agreement with MemoryNode (self-hosted or hosted service terms).
- **Logs and audit** rows are kept for a **limited operational window** (exact duration depends on environment and plan); contact support for the current window if you need it for compliance questionnaires.

## Questions

For security review questionnaires or DPA needs, start with [external/TRUST.md](./external/TRUST.md) and [SECURITY.md](./SECURITY.md), then contact your MemoryNode operator with your `x-request-id` from any failing request.
