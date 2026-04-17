# Trust and data handling (MemoryNode)

This page is for **builders and security reviewers** who need a clear picture before shipping customer-facing AI.

## What MemoryNode does

MemoryNode is a **hosted memory API**: your application stores text “memories” per **`user_id`** and optional **`namespace`**, then searches or fetches **prompt-ready context**. Embeddings and retrieval run **on the service** — you do not operate the vector index yourself.

## Isolation model

- **Workspace** — Your tenant boundary. API keys belong to a workspace; all memories created with that key are in that workspace.
- **`user_id` and `namespace`** — **You** choose these strings. They partition data **inside** the workspace so one end-user’s memories are not returned for another’s queries when you use consistent ids.

## Credentials

- **API keys** — For server-side and tool access. Shown **once** at creation in the console; stored hashed server-side.
- **Dashboard** — Uses Supabase Auth in the browser plus a **short-lived httpOnly session cookie** to the API for mutating calls; see [SECURITY.md](../SECURITY.md) for CSRF and origin rules.

## Security detail

For headers, PayU billing hardening, admin auth, and rotation guidance, read **[SECURITY.md](../SECURITY.md)** (technical).

## Data retention and deletion

See **[DATA_RETENTION.md](../DATA_RETENTION.md)** for what is stored, your export/delete controls, and high-level retention.

## Reviewer checklist (non-certification)

Use this as a conversation starter — not a substitute for your own review:

- [ ] API key only on **server** or **secure tool** — not in mobile bundles or public repos.
- [ ] **`user_id`** encodes tenant if you are multi-tenant B2B.
- [ ] You handle **`daily_cap_exceeded` / `monthly_cap_exceeded` / `RATE_LIMITED`** in UX for high-volume bots.
- [ ] You have a **support path** and request ids for incidents.

Formal certifications (e.g. SOC 2) are **not claimed here** unless your operator publishes an attestation separately.
