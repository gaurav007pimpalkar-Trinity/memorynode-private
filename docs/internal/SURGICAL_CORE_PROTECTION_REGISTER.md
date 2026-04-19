# Core Protection Register (Do Not Touch During Cleanup)

These components are mandatory for system integrity and are excluded from cleanup deletions.

Component: `apps/api/src/router.ts`, `apps/api/src/handlers/*`  
Tag: `CORE_ENGINE`  
Reason: Primary memory/search/context/billing route behavior.  
Used by: All API consumers and dashboard API calls.  
Safe to remove?: `No`

Component: `apps/api/src/auth.ts`, `apps/api/src/dashboardSession.ts`, `apps/api/src/requestIdentity.ts`  
Tag: `CORE_ENGINE`  
Reason: Authentication, CSRF/session security, tenancy identity.  
Used by: API auth and dashboard sessions.  
Safe to remove?: `No`

Component: `apps/api/src/usage/*`, `apps/api/src/billing/*`  
Tag: `CORE_ENGINE`  
Reason: Quota and billing enforcement are business-critical controls.  
Used by: Every metered operation and billing workflows.  
Safe to remove?: `No`

Component: `apps/api/src/workerApp.ts` request lifecycle  
Tag: `CORE_ENGINE`  
Reason: CORS, hosted MCP switch, health endpoints, method gating, control-plane checks.  
Used by: All incoming traffic.  
Safe to remove?: `No`

Component: `packages/shared/src/*`  
Tag: `CORE_ENGINE`  
Reason: Shared contracts and policy invariants used across services/packages.  
Used by: API, SDK, MCP.  
Safe to remove?: `No`

Component: `infra/sql/*.sql`, migration verification scripts in `scripts/migrations_*.mjs`, `scripts/db_*.mjs`  
Tag: `CORE_ENGINE`  
Reason: Schema/RLS/runtime assumptions required by handlers and auth model.  
Used by: Deploy gates and production runtime.  
Safe to remove?: `No`

Component: `.github/workflows/ci.yml`, `.github/workflows/api-deploy.yml`, `scripts/release_gate_runner.mjs`  
Tag: `CORE_ENGINE`  
Reason: Deployment safety and regression prevention controls.  
Used by: CI/CD and release flow.  
Safe to remove?: `No`

Component: `apps/api/wrangler.toml`, `apps/dashboard/wrangler.toml`  
Tag: `RISKY`  
Reason: Environment routing/deploy contracts; accidental edits can break production traffic.  
Used by: Cloudflare deployment targets.  
Safe to remove?: `No`
