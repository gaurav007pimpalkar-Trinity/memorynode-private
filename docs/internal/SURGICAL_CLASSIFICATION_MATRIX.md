# Surgical Classification Matrix

This inventory classifies the current system for cleanup without breaking behavior.

## API Endpoints

Component: `GET /healthz`, `GET /ready`, `GET /v1/health` (`apps/api/src/workerApp.ts`)  
Tag: `CORE_ENGINE`  
Reason: Runtime health and readiness contract for operations and deploy gates.  
Used by: CI/deploy checks, operators, uptime monitors.  
Safe to remove?: `No`

Component: `POST /v1/memories`, `GET /v1/memories`, `GET /v1/memories/{uuid}`, `DELETE /v1/memories/{uuid}` (`apps/api/src/router.ts`)  
Tag: `CORE_ENGINE`  
Reason: Primary memory write/read/delete primitives.  
Used by: API clients, SDK, dashboard memory workflows.  
Safe to remove?: `No`

Component: `POST /v1/search`, `GET /v1/search/history`, `POST /v1/search/replay` (`apps/api/src/router.ts`)  
Tag: `CORE_ENGINE`  
Reason: Retrieval pipeline and retrieval observability.  
Used by: SDK/API users, dashboard memory browser.  
Safe to remove?: `No`

Component: `POST /v1/context`, `GET /v1/context/explain`, `POST /v1/context/feedback` (`apps/api/src/router.ts`)  
Tag: `CORE_ENGINE`  
Reason: Prompt-ready context and explainability are core product contract.  
Used by: API users, docs quickstart, dashboard advanced tooling.  
Safe to remove?: `No`

Component: `GET /v1/usage/today` (`apps/api/src/router.ts`)  
Tag: `CORE_ENGINE`  
Reason: Billing/entitlement enforcement visibility and customer feedback loop.  
Used by: Dashboard usage, operator checks.  
Safe to remove?: `No`

Component: `GET /v1/billing/status`, `POST /v1/billing/checkout`, `POST /v1/billing/webhook` (`apps/api/src/router.ts`)  
Tag: `CORE_ENGINE`  
Reason: Commercial control and payment lifecycle.  
Used by: Dashboard billing and PayU lifecycle automation.  
Safe to remove?: `No`

Component: `POST /v1/billing/portal` (`apps/api/src/router.ts`, `apps/api/src/handlers/billing.ts`)  
Tag: `NOISE`  
Reason: Endpoint intentionally returns `410 Gone`; legacy Stripe surface.  
Used by: Legacy clients only (if any).  
Safe to remove?: `Unknown`

Component: `GET /v1/dashboard/overview-stats`, `GET /v1/audit/log` (`apps/api/src/router.ts`)  
Tag: `SAAS_LAYER`  
Reason: Product console metrics and workspace visibility.  
Used by: Dashboard overview and audit views.  
Safe to remove?: `No`

Component: `POST /v1/import` (`apps/api/src/router.ts`)  
Tag: `SAAS_LAYER`  
Reason: Paid import workflow for customer data onboarding.  
Used by: Dashboard import tab and API users.  
Safe to remove?: `No`

Component: `GET/PATCH /v1/connectors/settings` (`apps/api/src/router.ts`)  
Tag: `SAAS_LAYER`  
Reason: Capture policy controls for connector ingestion.  
Used by: Dashboard connectors tab.  
Safe to remove?: `No`

Component: `GET/POST/DELETE /v1/evals/*`, `POST /v1/evals/run` (`apps/api/src/router.ts`)  
Tag: `DEV_LAYER`  
Reason: Retrieval quality evaluation tooling for builder workflows.  
Used by: Dashboard memory browser advanced sections.  
Safe to remove?: `Unknown`

Component: `GET /v1/pruning/metrics`, `POST /v1/explain/answer` (`apps/api/src/router.ts`)  
Tag: `DEV_LAYER`  
Reason: Advanced diagnostics and explainability extension.  
Used by: Advanced API/dashboard workflows.  
Safe to remove?: `Unknown`

Component: `POST /v1/dashboard/session`, `POST /v1/dashboard/logout` (`apps/api/src/workerApp.ts`)  
Tag: `CORE_ENGINE`  
Reason: Console session establishment and CSRF-protected logout.  
Used by: Dashboard auth bootstrap.  
Safe to remove?: `No`

Component: `POST /v1/workspaces`, `GET/POST /v1/api-keys`, `POST /v1/api-keys/revoke` (`apps/api/src/router.ts`)  
Tag: `RISKY`  
Reason: Critical provisioning endpoints but naming suggests end-user flow while admin-gated in API handler path.  
Used by: Admin/control plane and operational scripts/SDK admin methods.  
Safe to remove?: `No`

Component: `/admin/*`, `/v1/admin/*` endpoints (`apps/api/src/router.ts`)  
Tag: `RISKY`  
Reason: Operational maintenance and founder metrics; not public product surface.  
Used by: Internal operations and founder dashboard.  
Safe to remove?: `No`

Component: `/v1/mcp`, `/mcp` hosted MCP transport (`apps/api/src/workerApp.ts`, `apps/api/src/mcpHosted.ts`)  
Tag: `ASSISTANT_LAYER`  
Reason: Agent-native access path for assistant/cross-tool memory integrations.  
Used by: MCP-compatible clients and assistant roadmap.  
Safe to remove?: `No`

## Backend Modules

Component: `apps/api/src/handlers/memories.ts`, `search.ts`, `context.ts`, `contextExplain.ts`  
Tag: `CORE_ENGINE`  
Reason: Memory engine request processing path.  
Used by: Core `/v1` API endpoints.  
Safe to remove?: `No`

Component: `apps/api/src/auth.ts`, `dashboardSession.ts`, `dbClientFactory.ts`, `requestIdentity.ts`  
Tag: `CORE_ENGINE`  
Reason: Authentication, session security, and request scoping.  
Used by: Every authenticated route and dashboard sessions.  
Safe to remove?: `No`

Component: `apps/api/src/usage/*`, `apps/api/src/billing/*`  
Tag: `CORE_ENGINE`  
Reason: Quota/budget/entitlement and billing enforcement logic.  
Used by: Request limits, billing APIs, plan controls.  
Safe to remove?: `No`

Component: `apps/api/src/mcpHosted.ts`, `mcpCache.ts`  
Tag: `ASSISTANT_LAYER`  
Reason: Hosted MCP interface for tool-based clients.  
Used by: `/v1/mcp` and `/mcp` paths.  
Safe to remove?: `No`

Component: `apps/api/src/handlers/admin.ts`  
Tag: `RISKY`  
Reason: Operational endpoints with high blast radius if altered.  
Used by: Internal workflows and founder metrics.  
Safe to remove?: `No`

Component: `apps/api/src/workerApp.ts` `KNOWN_PATH_ALLOWED_METHODS` list  
Tag: `RISKY`  
Reason: Method validation gate can diverge from router and create trust issues (404 vs 405).  
Used by: All requests before routing.  
Safe to remove?: `No`

Component: `packages/shared/src/*`  
Tag: `CORE_ENGINE`  
Reason: Shared contracts, plan limits, and policy definitions.  
Used by: API, SDK, MCP packages.  
Safe to remove?: `No`

Component: `packages/sdk/src/index.ts`  
Tag: `DEV_LAYER`  
Reason: Developer-facing API abstraction.  
Used by: SDK users, examples, docs.  
Safe to remove?: `No`

Component: `packages/mcp-server/src/index.ts`  
Tag: `ASSISTANT_LAYER`  
Reason: Stdio MCP distribution path for assistant hosts.  
Used by: Cursor/Claude/Windsurf integrations.  
Safe to remove?: `No`

## Dashboard Components

Component: `OverviewView`, `RequestsView`, `UsageView`, `BillingConsoleView`, `WorkspacesView` in `apps/dashboard/src/App.tsx`  
Tag: `SAAS_LAYER`  
Reason: Workspace operations, billing/usage visibility, account lifecycle.  
Used by: SaaS-oriented console users.  
Safe to remove?: `No`

Component: `MemoryBrowserView`, `ApiKeysView`, `McpView`, `DeveloperNextSteps`  
Tag: `DEV_LAYER`  
Reason: Builder/operator tooling for API integration and retrieval debugging.  
Used by: Developer console flow.  
Safe to remove?: `No`

Component: `ImportView` static dropzone/url affordances (pre-cleanup) in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: Previously implied unsupported interactions.  
Used by: None (dead UI affordances).  
Safe to remove?: `Yes`

Component: `InvoicesView`, `BillingView`, `_SettingsView` in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: Placeholder/unreachable UI paths that confuse product surface.  
Used by: `InvoicesView` only via placeholder tab; others unused.  
Safe to remove?: `Yes`

Component: `FounderApp` and app-surface routing (`apps/dashboard/src/FounderApp.tsx`, `main.tsx`, `appSurface.ts`)  
Tag: `RISKY`  
Reason: Internal founder telemetry surface with separate auth model.  
Used by: Founder/internal operations.  
Safe to remove?: `No`

## Docs Files

Component: `docs/start-here/*`, `docs/external/API_USAGE.md`, `docs/external/openapi.yaml`  
Tag: `DEV_LAYER`  
Reason: Developer onboarding and API references.  
Used by: New API adopters and SDK users.  
Safe to remove?: `No`

Component: `docs/MCP_SERVER.md`, `docs/start-here/MCP.md`, `packages/mcp-server/README.md`  
Tag: `ASSISTANT_LAYER`  
Reason: MCP setup and assistant-facing integrations.  
Used by: MCP users and no-code-adjacent hosts.  
Safe to remove?: `No`

Component: Broken `docs/build/*` references in docs/readmes (pre-cleanup)  
Tag: `NOISE`  
Reason: Dead references break onboarding continuity.  
Used by: Documentation links only.  
Safe to remove?: `Yes` (replace with valid docs)

Component: `docs/internal/EXTERNAL_DOCS_CLASSIFICATION.md`  
Tag: `RISKY`  
Reason: Contains stale inventory; internal process doc may still be referenced by team.  
Used by: Internal documentation governance.  
Safe to remove?: `Unknown`

## Scripts / Infra

Component: `.github/workflows/ci.yml`, `.github/workflows/api-deploy.yml`, `scripts/release_gate_runner.mjs`  
Tag: `CORE_ENGINE`  
Reason: Release safety and production deployment guardrails.  
Used by: CI/CD pipeline.  
Safe to remove?: `No`

Component: `infra/sql/*.sql`, migration verification scripts (`scripts/migrations_*.mjs`, `scripts/db_*.mjs`)  
Tag: `CORE_ENGINE`  
Reason: Database integrity and runtime contract enforcement.  
Used by: Deployment and production runtime.  
Safe to remove?: `No`

Component: `scripts/memory_hygiene_dry_run.sh` plus `.github/workflows/memory-hygiene.yml`  
Tag: `RISKY`  
Reason: Overlapping hygiene paths with different env var contracts.  
Used by: Ops maintenance.  
Safe to remove?: `Unknown`

Component: `scripts/cloudflare_pages_cleanup.mjs`  
Tag: `RISKY`  
Reason: Destructive operation guarded by env flag; should stay hidden from normal workflows.  
Used by: Rare infra cleanup.  
Safe to remove?: `Unknown`

Component: `scripts/e2e_smoke.sh` wrapper around `scripts/verify_e2e.sh`  
Tag: `NOISE`  
Reason: Thin alias wrapper with potential duplication.  
Used by: Script aliases/docs (verify before deleting).  
Safe to remove?: `Unknown`

Component: `public-onboarding/*` sample app  
Tag: `DEV_LAYER`  
Reason: External onboarding proof path.  
Used by: Sales/onboarding demos and examples.  
Safe to remove?: `No`
