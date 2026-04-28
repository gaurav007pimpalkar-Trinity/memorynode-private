# Internal Documentation Index

Operator-only docs for the MemoryNode Cloudflare Worker + Supabase data plane. Scope is intentionally narrow: these are the only internal docs the repo ships. System-of-record is the code in `apps/api/`, `packages/`, and `infra/sql/`.

Running documentation checks expect the migration manifest tokens below. Values come from `pnpm migrations:list`.

MIGRATIONS_TOTAL=72
MIGRATIONS_LATEST=070_llm_usage_monthly.sql

## Contents

| File | Purpose |
| --- | --- |
| [INCIDENT_RUNBOOKS.md](./INCIDENT_RUNBOOKS.md) | Response playbooks (contract-checked by `pnpm check:runbooks`). |
| [LEAST_PRIVILEGE_ROADMAP.md](./LEAST_PRIVILEGE_ROADMAP.md) | `rls-first` migration plan (contract-checked by `pnpm check:least-privilege`). |
| [BILLING_RUNBOOK.md](./BILLING_RUNBOOK.md) | PayU billing operations (legacy Stripe tables retained for history). |
| [RELEASE_RUNBOOK.md](./RELEASE_RUNBOOK.md) | Staging→production release flow. |
| [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md) | Pages deploy for `memorynode-console` and `memorynode-app`. |
| [DASHBOARD_SESSION_SETUP.md](./DASHBOARD_SESSION_SETUP.md) | Supabase JWT → `dashboard_sessions` + CSRF flow. |
| [OBSERVABILITY.md](./OBSERVABILITY.md) | Log shape, health endpoints, `api_audit_log`. |
| [ALERTS.md](./ALERTS.md) | Human-facing description of alert rules. |
| [IDENTITY_TENANCY.md](./IDENTITY_TENANCY.md) | Auth surface, tenant isolation, `rls-first` details. |
| [SUPABASE_GOOGLE_OAUTH_SETUP.md](./SUPABASE_GOOGLE_OAUTH_SETUP.md) | Dashboard Supabase Google OAuth handoff. |

Related:

- API truth: [docs/external/API_USAGE.md](../external/API_USAGE.md) + [docs/external/openapi.yaml](../external/openapi.yaml)
- MCP truth: [docs/MCP_SERVER.md](../MCP_SERVER.md)
- SDK: [packages/sdk/README.md](../../packages/sdk/README.md)
- Security: [docs/SECURITY.md](../SECURITY.md)
- Production setup: [docs/PROD_SETUP_CHECKLIST.md](../PROD_SETUP_CHECKLIST.md)

## Maintenance

Update the two migration tokens above after every new migration: run `pnpm migrations:list` and copy the numbers verbatim. `pnpm migrations:check` rejects the PR if they drift.
