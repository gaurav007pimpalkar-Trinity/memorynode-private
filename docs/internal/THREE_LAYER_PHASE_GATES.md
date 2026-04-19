# Three-Layer Phase Gates

Execution guardrails to keep the roadmap strict and avoid backend rewrites.

## Phase 1 Gate (Immediate)

### Must be fully complete before Phase 2

- Developer and SaaS surfaces are explicit in dashboard navigation.
- Dead/misleading UI removed from active flows.
- Public endpoint boundary documented in `docs/external/API_SURFACE_PHASE1.md`.
- Phase 1 endpoint parity check passes (`pnpm check:api-surface-phase1`).
- Core backend invariants remain unchanged (`apps/api/src/handlers/*`, auth/session, usage/billing enforcement).

### Allowed partial in Phase 1

- OpenAPI coverage for advanced endpoints can remain partial if Phase 1 surface is fully accurate.
- Assistant remains technical-only (MCP docs and transport).

## Phase 2 Gate (Next)

### Must be fully complete before Phase 3

- SaaS continuity/personalization controls are user-visible and testable.
- Public/internal endpoint taxonomy is reflected in docs and dashboard wording.
- Developer advanced routes are moved into explicit advanced docs sections (not main onboarding).

### Allowed partial in Phase 2

- Assistant UI shell can exist without full cross-tool orchestration.

## Phase 3 Gate (Later)

### Must be fully complete

- Assistant workspace is no-code usable for connect, remember, recall, edit, and delete flows.
- All three layers have distinct entry points and first-success tests.
- Shared Memory Engine remains the single backend path.

## Non-Negotiable Do-Not-Touch During All Phases

- Memory/search/context handler behavior
- Auth/session/CSRF flow
- Usage and billing enforcement logic
- Migration and deployment safety gates
