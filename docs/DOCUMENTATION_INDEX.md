## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# Documentation registry & classification

**Runtime truth:** `apps/api/src/router.ts`, `apps/api/src/workerApp.ts`, `apps/api/src/contracts/`, `packages/sdk/src/index.ts`, `apps/dashboard/src/`.

**Canonical API prose:** [`external/API_USAGE.md`](external/API_USAGE.md). **OpenAPI artifact:** [`external/openapi.yaml`](external/openapi.yaml) (`pnpm openapi:gen` / `pnpm openapi:check`).

## Enforcement (CI + local)

| Check | What it does |
|-------|----------------|
| `pnpm openapi:check` | Regenerated `openapi.yaml` matches `apps/api/scripts/generate_openapi.mjs`. |
| `pnpm check:docs-drift` | Mapped triggers (API, SDK, MCP, worker, dashboard, shared, wrangler/workers, entry); fallback for `apps/api/src/**`, `packages/mcp-server/**`, `packages/shared/**`; large-PR gate; diff heuristics (`/v1/`, `/admin/`, MCP tools/schemas, shared exports). Override: `DOCS_DRIFT_ALLOW=1`. See `scripts/check_docs_drift.mjs`. |

`pnpm test:ci` runs both (see root `package.json`). See `.cursor/rules/documentation-governance.mdc`.

---

## Categories

| Label | Meaning |
|-------|---------|
| **SOURCE OF TRUTH** | Must match code; maintained with API changes |
| **SUPPORTING** | Product guides, tutorials, examples — examples must match API_USAGE |
| **INTERNAL / OPERATIONAL** | Runbooks, deploy, observability — **may not reflect exact deployed state**; verify live systems |
| **HISTORICAL / SNAPSHOT** | Audits, dated reports — **not authoritative**; banner at top |
| **META** | Indexes and hubs |

---

## Classification table (87 × `.md`; OpenAPI row in `docs/external/`)

### Repository root & apps / packages

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `README.md` | Repo entry, curls, layout | Product · API samples | SUPPORTING |
| `SECURITY.md` | Security pointers (repo root) | Policy | SUPPORTING |
| `apps/api/README.md` | Wrangler, deploy, abuse responses | Infra · API ops | INTERNAL |
| `apps/dashboard/README.md` | Console/founder build, env | Frontend | INTERNAL |
| `packages/sdk/README.md` | SDK methods ↔ HTTP | SDK | SOURCE OF TRUTH |
| `packages/sdk/CHANGELOG.md` | SDK release notes | SDK | SUPPORTING |
| `packages/mcp-server/README.md` | Stdio MCP package | MCP | SUPPORTING |
| `packages/cli/README.md` | CLI package | CLI | SUPPORTING |
| `public-onboarding/README.md` | Public onboarding narrative | Product | SUPPORTING |
| `bruno/MemoryNode/README.md` | Bruno HTTP collection | API testing | SUPPORTING |
| `examples/node-quickstart/README.md` | Node quickstart | API | SUPPORTING |
| `examples/python-quickstart/README.md` | Python quickstart | API | SUPPORTING |
| `examples/nextjs-middleware/README.md` | Next.js example | API | SUPPORTING |
| `examples/langchain-wrapper/README.md` | LangChain example | API | SUPPORTING |
| `examples/support-bot-minimal/README.md` | Minimal bot example | API | SUPPORTING |

### `docs/external/` (customer / integrator)

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `docs/external/README.md` | External docs hub | Meta | META |
| `docs/external/API_USAGE.md` | Full REST reference | API | SOURCE OF TRUTH |
| `docs/external/openapi.yaml` | OpenAPI 3 (generated) | API | SOURCE OF TRUTH |
| `docs/external/API_SURFACE_PHASE1.md` | Phase‑1 onboarding subset | API policy | SUPPORTING |
| `docs/external/POSITIONING.md` | ICP & promise | Product | SUPPORTING |
| `docs/external/QUICKSTART.md` | Redirect to start-here / self-host | Meta | META |
| `docs/external/TRUST.md` | Trust narrative | Product | SUPPORTING |
| `docs/external/AUDIENCES_US_IN.md` | Audience notes | Product | SUPPORTING |
| `docs/external/ASSISTANT_WORKSPACE.md` | Assistant workspace UX | Product · Frontend | SUPPORTING |
| `docs/external/SAAS_MEMORY_CONSOLE.md` | SaaS console story | Product | SUPPORTING |
| `docs/external/RECIPE_SUPPORT_AGENT.md` | Support recipe | Product | SUPPORTING |
| `docs/external/RECIPE_SAAS_COPILOT.md` | SaaS copilot recipe | Product | SUPPORTING |
| `docs/external/RECIPE_SMB_CHATBOT.md` | SMB recipe | Product | SUPPORTING |

### `docs/start-here/`

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `docs/start-here/README.md` | 10‑minute hosted onboarding | Product · API | SUPPORTING |
| `docs/start-here/QUICKSTART.md` | Condensed curls + explain JSON | API | SUPPORTING |
| `docs/start-here/MCP.md` | MCP setup (editors) | MCP | SUPPORTING |
| `docs/start-here/PER_USER_MEMORY.md` | Per-user model | Product | SUPPORTING |
| `docs/start-here/SCOPES.md` | Scopes / namespaces | API concept | SUPPORTING |
| `docs/start-here/ADVANCED_ISOLATION.md` | Routing & headers | API internals | SUPPORTING |
| `docs/start-here/FOUNDER_PATH.md` | Founder checklist | Product | SUPPORTING |

### `docs/self-host/`

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `docs/self-host/README.md` | Self-host index | Infra | SUPPORTING |
| `docs/self-host/LOCAL_DEV.md` | Local Worker dev | Infra | INTERNAL |

### `docs/` (top-level)

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `docs/DOCUMENTATION_INDEX.md` | This registry | Meta | META |
| `docs/MCP_SERVER.md` | Hosted + stdio MCP | MCP | SOURCE OF TRUTH |
| `docs/DATA_RETENTION.md` | Retention policy narrative | Policy | SUPPORTING |
| `docs/SECURITY.md` | Security doc | Policy | SUPPORTING |
| `docs/INCIDENT_PROCESS.md` | Incident process | Ops | INTERNAL |
| `docs/OPERATIONS.md` | Operations overview | Ops | INTERNAL |
| `docs/BACKUP_RESTORE.md` | Backup / restore | Ops | INTERNAL |
| `docs/E2E_CRITICAL_PATH.md` | E2E critical path | QA | INTERNAL |
| `docs/PRODUCTION_REQUIREMENTS.md` | Prod requirements | Ops | INTERNAL |
| `docs/PROD_SETUP_CHECKLIST.md` | Prod setup checklist | Ops | INTERNAL |
| `docs/LAUNCH_CHECKLIST.md` | Launch checklist | Ops | INTERNAL |
| `docs/LAUNCH_RUNBOOK.md` | Launch runbook | Ops | INTERNAL |
| `docs/SECURITY_READINESS_ONE_PAGER.md` | Secrets checklist | Ops | INTERNAL |
| `docs/FOUNDER_SECRETS_CREDENTIALS_ACCESS_REGISTRY.md` | Blank credential name template | Ops | INTERNAL |
| `docs/FULL_TECHNICAL_PRODUCT_AUDIT.md` | Repo audit (dated) | Mixed | HISTORICAL |
| `docs/SDK_DX_AUDIT.md` | SDK DX audit | SDK | HISTORICAL |
| `docs/CLOUDFLARE_INFRASTRUCTURE_AUDIT.md` | CF DNS snapshot | Infra | HISTORICAL |
| `docs/COST_BILLING_AUDIT.md` | Billing/cost audit | Billing | HISTORICAL |
| `docs/MEMORYNODE_COST_DISCIPLINE_ABUSE_CONTROL_REVIEW.md` | Cost/abuse review | Billing | HISTORICAL |
| `docs/RESILIENCE_UPGRADE_SUMMARY.md` | Resilience change summary | Infra | HISTORICAL |
| `docs/SAFE_PLAN_V2.md` | Plan v2 economics / migration | Billing | HISTORICAL |
| `docs/AGENT_NATIVE_UPGRADE_IMPLEMENTATION_PLAN.md` | Agent SDK plan | Planning | HISTORICAL |

### `docs/internal/` (operator)

| Path | Purpose | Coverage | Category |
|------|---------|----------|----------|
| `docs/internal/README.md` | Internal docs hub | Meta | META |
| `docs/internal/EXTERNAL_DOCS_CLASSIFICATION.md` | Maps `docs/external/` files | Meta | META |
| `docs/internal/RELEASE_RUNBOOK.md` | Release process | Ops | INTERNAL |
| `docs/internal/RELEASE_GATE.md` | Release gate | Ops | INTERNAL |
| `docs/internal/PRODUCTION_DEPLOY.md` | Production deploy | Ops | INTERNAL |
| `docs/internal/PROD_READY.md` | Go/no-go | Ops | INTERNAL |
| `docs/internal/DASHBOARD_DEPLOY.md` | Dashboard deploy | Ops | INTERNAL |
| `docs/internal/DASHBOARD_SESSION_SETUP.md` | Dashboard session | Ops | INTERNAL |
| `docs/internal/BILLING_RUNBOOK.md` | Billing ops | Ops | INTERNAL |
| `docs/internal/INCIDENT_RUNBOOKS.md` | Incident runbooks | Ops | INTERNAL |
| `docs/internal/ALERTS.md` | Alerts | Ops | INTERNAL |
| `docs/internal/OBSERVABILITY.md` | Observability | Ops | INTERNAL |
| `docs/internal/observability/saved_queries.md` | Saved queries | Ops | INTERNAL |
| `docs/internal/PERFORMANCE.md` | Performance | Ops | INTERNAL |
| `docs/internal/HEALTH_VIEW.md` | Health view | Ops | INTERNAL |
| `docs/internal/OPERATIONAL_GUIDE.md` | Operator guide | Ops | INTERNAL |
| `docs/internal/FIRST_RUN_FLOW.md` | First run | Ops | INTERNAL |
| `docs/internal/GO_LIVE_CHECKLIST.md` | Go live | Ops | INTERNAL |
| `docs/internal/SUPABASE_GOOGLE_OAUTH_SETUP.md` | OAuth setup | Ops | INTERNAL |
| `docs/internal/TRUST_CHANGELOG.md` | Trust changelog | Ops | INTERNAL |
| `docs/internal/GTM_PLAYBOOK_2026.md` | GTM | Internal | INTERNAL |
| `docs/internal/PUBLIC_ONBOARDING_REPO.md` | Public onboarding | Ops | INTERNAL |
| `docs/internal/IDENTITY_TENANCY.md` | Identity model | Architecture | INTERNAL |
| `docs/internal/REQUEST_PATH_PRIVILEGE_INVENTORY.md` | Path privileges | Security | INTERNAL |
| `docs/internal/LEAST_PRIVILEGE_ROADMAP.md` | Least privilege roadmap | Security | INTERNAL |
| `docs/internal/THREE_LAYER_SURFACE_MATRIX.md` | Surface matrix | Product | INTERNAL |
| `docs/internal/THREE_LAYER_PHASE_GATES.md` | Phase gates | Product | INTERNAL |
| `docs/internal/RETRIEVAL_COCKPIT_DEMO.md` | Retrieval demo | Product | INTERNAL |
| `docs/internal/ENGINE_SKELETON.md` | Worker pipeline diagram | Architecture | INTERNAL |

`docs/external/openapi.yaml` is not Markdown; it is listed in the **`docs/external/`** table above (generated; `info.description` notes admin/cron paths summarized only).

---

## Removed in this pass

| File | Reason |
|------|--------|
| `docs/NEXTGEN_AI_MEMORY_SDK_AUDIT_2026.md` | **Deleted** — factually wrong vs code (e.g. claimed MCP absent; repo ships `@memorynodeai/mcp-server` and hosted `/v1/mcp`). No unique value after removal. |
