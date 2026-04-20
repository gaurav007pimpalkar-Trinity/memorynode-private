## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# External docs classification (user-facing)

Guidelines for **`docs/external/`**: safe for integrators and end users; avoid undocumented operator-only procedures. **Canonical API truth:** [../external/API_USAGE.md](../external/API_USAGE.md), [../external/openapi.yaml](../external/openapi.yaml) (generated via `pnpm openapi:gen` from `apps/api/scripts/generate_openapi.mjs`).

## Current files (verify paths exist)

| Document | Role |
|----------|------|
| [README.md](../external/README.md) | Hub — links to modes and canonical pages |
| [API_USAGE.md](../external/API_USAGE.md) | **REST reference** (routes, enums, billing, SDK index) |
| [openapi.yaml](../external/openapi.yaml) | OpenAPI 3 artifact (CI: `pnpm openapi:check`) |
| [API_SURFACE_PHASE1.md](../external/API_SURFACE_PHASE1.md) | Smaller “Phase 1 onboarding” surface vs full router |
| [POSITIONING.md](../external/POSITIONING.md) | ICP, promise, non-goals |
| [QUICKSTART.md](../external/QUICKSTART.md) | Short redirect to start-here + self-host |
| [TRUST.md](../external/TRUST.md) | Customer-facing trust summary |
| [DATA_RETENTION.md](../DATA_RETENTION.md) (parent `docs/`) | Retention / deletion expectations — keep aligned with code + policy |
| [AUDIENCES_US_IN.md](../external/AUDIENCES_US_IN.md) | Audience notes |
| [ASSISTANT_WORKSPACE.md](../external/ASSISTANT_WORKSPACE.md), [SAAS_MEMORY_CONSOLE.md](../external/SAAS_MEMORY_CONSOLE.md) | Product flows for console surfaces |
| [RECIPE_*.md](../external/) | Vertical recipes (support, SaaS copilot, SMB) |

Internal-only material belongs under **`docs/internal/`** (runbooks, deploy, billing ops). The historical note about **TRUST_CHANGELOG** living under internal remains valid — see [TRUST_CHANGELOG.md](./TRUST_CHANGELOG.md).
