# Surgical Cleanup Ledger

This ledger tracks dead, misleading, duplicate, or inconsistent elements with exact locations.

## Dead Or Misleading Endpoints

- Endpoint: `POST /v1/billing/portal`
  - Files: `apps/api/src/router.ts`, `apps/api/src/handlers/billing.ts`, `docs/external/openapi.yaml`
  - Function: `handleBillingPortal`
  - Evidence: handler returns `410 Gone` with Stripe-removed message.
  - Action: keep route for backward compatibility, mark as legacy/deprecated in docs, hide from onboarding flows.

## Broken Or Missing Documentation References

- Missing path: `docs/build/README.md`
  - Referenced from: `README.md`, `docs/internal/README.md`, `docs/external/QUICKSTART.md`, `examples/python-quickstart/README.md`
  - Impact: broken links in primary onboarding routes.
  - Action: restore build docs hub and SDK usage page.

- Missing path: `docs/build/sdk-usage.md`
  - Referenced from: `docs/external/API_USAGE.md`
  - Impact: broken deep-link for SDK workflow.
  - Action: add SDK usage document and point to `packages/sdk/src/index.ts` methods.

## Duplicate Or Overlapping Systems

- Overlap: hosted MCP + stdio MCP
  - Files: `apps/api/src/mcpHosted.ts`, `packages/mcp-server/src/index.ts`, `docs/MCP_SERVER.md`
  - Impact: unclear user choice if not explicitly explained.
  - Action: keep both, but clearly label hosted vs package path in docs.

- Overlap: route map vs method allowlist
  - Files: `apps/api/src/router.ts`, `apps/api/src/workerApp.ts`
  - Impact: method mismatch can cause 404 instead of 405 for known routes.
  - Action: align `KNOWN_PATH_ALLOWED_METHODS` with router coverage.

## Naming Inconsistencies (UI / API / Docs)

- `API Access` vs `API keys`
  - Files: `apps/dashboard/src/App.tsx`, `docs/start-here/QUICKSTART.md`
  - Impact: users cannot map docs to UI quickly.
  - Action: standardize UI wording to `API Keys`.

- `Team` vs `Workspace & Team` vs `Workspaces`
  - Files: `apps/dashboard/src/App.tsx`
  - Impact: navigation mismatch and support confusion.
  - Action: standardize nav/panel to `Workspaces`.

- `Memories` vs `Memory Browser`
  - Files: `apps/dashboard/src/App.tsx`
  - Impact: command palette and panel wording mismatch.
  - Action: standardize to one label (`Memory Browser`).

- Metrics wording mismatch
  - Files: `apps/dashboard/src/App.tsx`, `infra/sql/033_dashboard_console_overview_stats.sql`, `apps/api/src/handlers/dashboardOverview.ts`
  - Impact: `Documents` and `Search Requests` labels misrepresent memory/read metrics.
  - Action: rename visible labels to `Memories`, `Indexed Chunks`, `Read Operations`.

## Misleading UI Elements (Pre-Cleanup)

- Dead import affordances
  - File: `apps/dashboard/src/App.tsx` (`ImportView`)
  - Elements: static dropzone copy, URL input Add button without behavior, unused container tag field.
  - Action: remove non-functional controls and replace with explicit supported import contract copy.

- Placeholder invoices tab
  - File: `apps/dashboard/src/App.tsx` (`BillingConsoleView`, `InvoicesView`)
  - Evidence: `InvoicesView` always empty state.
  - Action: remove invoices tab until real invoice data source exists.

- Unreachable settings/billing blocks
  - File: `apps/dashboard/src/App.tsx` (`BillingView`, `_SettingsView`)
  - Evidence: no render path in active app flow.
  - Action: delete unused components after reference check.
