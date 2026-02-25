# Data Retention & Deletion

**Purpose:** How we retain data, how you can delete it, and what audit trails exist.

---

## 1. Data we store

| Data | Location | Purpose |
|------|----------|---------|
| Memories & chunks | `memories`, `memory_chunks` | Ingested content, embeddings, search |
| API keys (hashed) | `api_keys` | Authentication; plaintext shown once at creation |
| Workspaces & members | `workspaces`, `workspace_members` | Tenancy, billing, access control |
| Usage counts | `usage_daily` | Plan caps, rate limiting |
| API audit log | `api_audit_log` | Route, method, status, latency, workspace_id, api_key_id, ip_hash |
| Billing webhooks | `payu_webhook_events` | PayU callbacks, verify-before-grant, idempotency |
| Dashboard sessions | `dashboard_sessions` | Short-lived session tokens (15 min TTL) |
| Product events | `product_events` | Workspace/key creation, first ingest, cap_exceeded, etc. |

---

## 2. User-initiated deletion

| Action | How | Notes |
|--------|-----|-------|
| **Delete a memory** | `DELETE /v1/memories/:id` (API key auth) or dashboard | Cascades to `memory_chunks`; permanent |
| **Revoke an API key** | `POST /v1/api-keys/revoke` (admin) or dashboard | Key immediately invalid; row retained with `revoked_at` |
| **Leave a workspace** | Dashboard or Supabase RPC `remove_member` | You lose access; workspace data remains |
| **Logout** | Dashboard | Session invalidated; cookie cleared |

---

## 3. Full data deletion (workspace / account)

There is no self-service "delete workspace" or "delete account" API. To request full deletion of your workspace and all associated data (memories, chunks, API keys, usage, audit log rows, billing-related rows):

- **Contact:** [support@memorynode.ai](mailto:support@memorynode.ai) (or your deployed contact) with workspace ID or account identifier.
- **Process:** We verify identity and ownership, then delete the workspace (DB cascade removes memories, chunks, keys, usage, invites, members, entitlements, dashboard sessions). Audit and billing tables may retain anonymized or aggregated rows for legal/compliance (see §5).
- **Timeline:** Target completion within 30 days of verified request, unless retention obligations apply.

---

## 4. Export (data portability)

- **Export memories:** `POST /v1/export` — returns artifact (base64 or ZIP) of memories and chunks for your workspace.
- **Import:** `POST /v1/import` — restore from export (upsert, skip_existing, etc.).

See `docs/API_REFERENCE.md` for payloads.

---

## 5. Audit trail & retention

### API audit log (`api_audit_log`)

- **Contents:** Route, method, HTTP status, latency_ms, bytes_in/out, ip_hash, workspace_id, api_key_id, user_agent, created_at.
- **Purpose:** Security review, abuse detection, incident investigation.
- **Retention:** Operationally retained for **90 days** (configurable). Older rows may be purged by scheduled job. Adjust in operations if needed.
- **Access:** Workspace members can read their workspace’s audit rows via Supabase RLS (when exposed in dashboard or RPC).

### Billing webhook events (`payu_webhook_events`)

- **Contents:** PayU event_id, txn_id, status, workspace_id, payload (redacted if logged), processed_at.
- **Purpose:** Webhook replay, dispute resolution, financial reconciliation.
- **Retention:** Retained for **2 years** (or as required for financial/legal). No automatic purge in current schema.

### Product events (`product_events`)

- **Contents:** workspace_created, api_key_created, first_ingest_success, first_search_success, etc.
- **Purpose:** Product analytics, SLO measurement.
- **Retention:** Operationally retained; purge policy TBD.

---

## 6. Retention summary

| Data | Retention | Purge |
|------|-----------|-------|
| Memories, chunks | Until user/workspace deletion | On DELETE or workspace cascade |
| API keys | Indefinite (revoked_at set on revoke) | Optional purge of revoked keys >1 year |
| API audit log | 90 days (target) | Scheduled job (to be implemented) |
| Billing webhook events | 2 years (target) | Manual or scheduled |
| Dashboard sessions | 15 min TTL | Expired rows cleaned on access or scheduled |

---

## 7. Links

- **Security & auth:** [SECURITY.md](./SECURITY.md)
- **API reference:** [API_REFERENCE.md](./API_REFERENCE.md)
- **Trust entry point:** [TRUST.md](./TRUST.md)
