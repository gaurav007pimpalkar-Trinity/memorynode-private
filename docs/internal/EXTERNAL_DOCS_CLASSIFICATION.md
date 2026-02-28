# External docs classification (user-facing only)

Used to keep `docs/external/` safe for end users. Do not expose internal behaviour, ops, or system mechanics.

| Document | Classification | Reason |
|----------|----------------|--------|
| **openapi.yaml** | Keep (as-is) | Machine-readable API spec; no prose exposing internals. |
| **API_REFERENCE.md** | Rewrite | Referenced internal docs (README, RELEASE_RUNBOOK), regeneration/CI, internal plan/limit jargon, PayU verification details. Rewritten to endpoints/auth/shapes and user-facing plans only; errors as “what to try”. |
| **QUICKSTART.md** | Rewrite | Linked to internal/ops docs (BILLING_RUNBOOK, PROD_SETUP, RELEASE_RUNBOOK, OBSERVABILITY, ALERTS, SECURITY); CONFIG_ERROR/RATE_LIMIT_DO; “monitor production”. Rewritten to setup and first calls only; troubleshooting = retry, check input, contact support. |
| **BETA_ONBOARDING.md** | Rewrite | Operator-only content (admin bootstrap, BILLING_RUNBOOK); internal commands (db:migrate, release:staging:validate, e2e:verify); success metrics. Rewritten to access, concepts, gotchas, support template; no operator actions. |
| **ARCHITECTURE_CEO.md** | Rewrite (minor) | Internal link to README#plans. Updated to user-facing plans reference only. |
| **TROUBLESHOOTING_BETA.md** | Rewrite | Supabase/RLS, logs, PayU webhook/BILLING_RUNBOOK, release:staging:validate, e2e:verify. Rewritten to symptom → check input/auth/scope, retry, contact support; no internal tools. |
| **TRUST.md** | Rewrite | Index of internal/ops docs (INCIDENT_PROCESS, OBSERVABILITY, ALERTS, OPERATIONS, SLOs). Replaced with short user-facing trust page: security summary, data retention; no incident/ops links. |
| **DATA_RETENTION.md** | Rewrite | DB table names, operational retention details, purge jobs. Rewritten to what we store (plain language), how to delete/export, retention in simple terms. |
| **TRUST_CHANGELOG.md** | Remove (moved to internal) | Internal ops/security changelog (observability, SLOs, incident process). Moved to `docs/internal/TRUST_CHANGELOG.md`. |
