# API Surface (Phase 1)

This page defines the public API surface exposed in Phase 1 so developers and SaaS teams see only the stable paths needed for first value.

## Public Endpoints (Phase 1)

### Developer Core

- `POST /v1/memories`
- `GET /v1/memories`
- `GET /v1/memories/{uuid}`
- `DELETE /v1/memories/{uuid}`
- `POST /v1/search`
- `POST /v1/context`
- `GET /v1/context/explain`

### SaaS Console Support

- `GET /v1/usage/today`
- `GET /v1/dashboard/overview-stats`
- `POST /v1/import`
- `GET /v1/connectors/settings`
- `PATCH /v1/connectors/settings`
- `GET /v1/billing/status`
- `POST /v1/billing/checkout`

## Hidden/Internal Endpoints

These remain operational but are not part of the default public onboarding surface:

- Legacy billing path: `POST /v1/billing/portal` (returns `410 Gone`)
- Control plane: `/admin/*`, `/v1/admin/*`
- Billing webhook callback: `POST /v1/billing/webhook`
- Admin provisioning routes: `/v1/workspaces`, `/v1/api-keys*`

## Advanced Developer Endpoints (Phase 2+ docs)

These exist now but are intentionally withheld from Phase 1 onboarding:

- Search history/replay
- Context feedback
- Pruning metrics
- Explain answer
- Evals routes

## Validation

Phase 1 surface parity is enforced by:

- `pnpm check:api-surface-phase1`

This check validates that each Phase 1 endpoint exists in both:

- `apps/api/src/router.ts`
- `docs/external/openapi.yaml`
