# Trust Breakers (Priority Order)

## P0 - Broken Onboarding Links

Component: Missing `docs/build/*` references in onboarding docs  
Tag: `NOISE`  
Reason: New users hit dead links in first-run path and lose confidence immediately.  
Used by: `README.md`, start-here docs, external quickstart references.  
Safe to remove?: `Yes` (replace dead references)

Why dangerous: onboarding appears abandoned or stale even when backend is healthy.

## P0 - Legal/Trust Copy Without Destinations

Component: Auth footer terms text in `apps/dashboard/src/App.tsx`  
Tag: `SAAS_LAYER`  
Reason: Claims Terms/Privacy acceptance without actual links.  
Used by: Every console sign-in attempt.  
Safe to remove?: `No` (fix copy and links)

Why dangerous: compliance/trust posture is weakened during account creation.

## P1 - Metrics Language Misrepresents Product Behavior

Component: Overview stat labels in `apps/dashboard/src/App.tsx` backed by `infra/sql/033_dashboard_console_overview_stats.sql`  
Tag: `RISKY`  
Reason: Labels imply one thing while fields measure something else (chunk/read semantics).  
Used by: Primary dashboard landing experience.  
Safe to remove?: `No` (rename labels, preserve data)

Why dangerous: customers question whether ingestion/retrieval works correctly.

## P1 - UI Naming Drift Across Navigation And Docs

Component: `API Access`, `Team`, `Memories` label drift in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: Terminology diverges from docs and API concepts.  
Used by: Console navigation and support references.  
Safe to remove?: `Yes` (rename only)

Why dangerous: support friction increases and onboarding takes longer.

## P1 - Non-Functional UI Affordances

Component: Import dropzone/url controls and placeholder invoices in `apps/dashboard/src/App.tsx`  
Tag: `NOISE`  
Reason: UI advertises capabilities that are not implemented.  
Used by: Import/Billing tabs.  
Safe to remove?: `Yes`

Why dangerous: users perceive product as unreliable after first clicks.

## P2 - Legacy Endpoint Still Discoverable

Component: `POST /v1/billing/portal` legacy route in API/docs  
Tag: `NOISE`  
Reason: Publicly visible endpoint that is intentionally gone (`410`).  
Used by: Legacy Stripe-era clients only.  
Safe to remove?: `Unknown`

Why dangerous: integrators discover dead path and assume billing stack is unstable.
