# Surgical Cleanup Execution Report

This report captures Step 5/6/7 outcomes from the surgical cleanup plan.

## Step 5 - Safe Removal Plan (`NOISE`)

### Removed in this pass

Component: `InvoicesView` and invoice tab wiring in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: Placeholder-only UI with no data source.  
Used by: Billing tab local state only.  
Safe to remove?: `Yes`

Component: `BillingView` and `_SettingsView` in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: Unreachable dead code path.  
Used by: None in active render tree.  
Safe to remove?: `Yes`

Component: Import dead affordances in `ImportView` (`apps/dashboard/src/App.tsx`)  
Tag: `NOISE`  
Reason: Non-functional dropzone/URL/tag controls created false expectations.  
Used by: None (no request wiring).  
Safe to remove?: `Yes`

### Replaced instead of deleted

Component: broken `docs/build/*` references  
Tag: `NOISE`  
Reason: Link targets missing from docs tree.  
Used by: README/start-here/build paths.  
Safe to remove?: `Yes` (resolved by adding canonical build docs pages)

## Step 6 - Hide vs Delete (`RISKY`)

Component: `POST /v1/billing/portal`  
Tag: `RISKY`  
Decision: `Keep + hide from onboarding`  
Reason: Legacy clients may still call it; removing route can break unknown integrations.

Component: internal admin/control-plane routes (`/admin/*`, `/v1/admin/*`)  
Tag: `RISKY`  
Decision: `Keep as-is + keep out of user onboarding docs`  
Reason: Required for operations/founder flows; not product-facing APIs.

Component: hosted MCP + stdio MCP  
Tag: `RISKY`  
Decision: `Keep both, clarify docs`  
Reason: Different integration channels depend on each path.

Component: destructive infra scripts (`scripts/cloudflare_pages_cleanup.mjs`)  
Tag: `RISKY`  
Decision: `Keep + never surface in user docs`  
Reason: Admin-only emergency utility with high blast radius.

## Step 7 - Alignment Fixes Completed

- Naming standardization in dashboard:
  - `API Access` -> `API Keys`
  - `Team` -> `Workspaces`
  - `Import (Paid)` -> `Import`
  - `MCP` -> `MCP Setup`
- Metrics label alignment:
  - `Documents` -> `Memories`
  - `Memories` -> `Indexed Chunks`
  - `Search Requests` -> `Read Operations`
- Trust copy correction:
  - Added Terms and Privacy links on auth landing.
- Routing alignment:
  - Added `/v1/admin/founder/phase1` to method allowlist in `apps/api/src/workerApp.ts`.
- Docs alignment:
  - Added `docs/build/README.md` and `docs/build/sdk-usage.md` to resolve broken references.
  - Corrected internal doc wording from three to four quickstart calls.
