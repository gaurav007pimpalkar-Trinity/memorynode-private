## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# External docs hub

User-facing documentation for MemoryNode.

## Choose your mode

| Mode | Audience | Start |
|------|------------|--------|
| **1 — Just use it** | Everyone shipping on the hosted API | [../start-here/README.md](../start-here/README.md) |
| **2 — Build** | Engineers who need filters, SDK, OpenAPI | [API_USAGE.md](./API_USAGE.md) |
| **3 — Self-host** | Contributors and private deployments | [../self-host/README.md](../self-host/README.md) |

**New here?** Open **[Start here →](../start-here/README.md)** (~10 minutes, hosted only).

## Map

| Audience | Link |
|----------|------|
| Default (everyone) | [../start-here/README.md](../start-here/README.md) |
| Per-user setup | [../start-here/PER_USER_MEMORY.md](../start-here/PER_USER_MEMORY.md) |
| Scope strategy | [../start-here/SCOPES.md](../start-here/SCOPES.md) |
| Isolation internals | [../start-here/ADVANCED_ISOLATION.md](../start-here/ADVANCED_ISOLATION.md) |
| Founders (no repo) | [../start-here/FOUNDER_PATH.md](../start-here/FOUNDER_PATH.md) |
| Advanced usage | [API_USAGE.md](./API_USAGE.md) |
| Self-host / contributors | [../self-host/README.md](../self-host/README.md) |

## Canonical pages in this folder

- [POSITIONING.md](./POSITIONING.md) — product promise & ICP
- [QUICKSTART.md](./QUICKSTART.md) — short pointer to start-here + legacy anchors
- [API_USAGE.md](./API_USAGE.md) — full request/field reference
- [SAAS_MEMORY_CONSOLE.md](./SAAS_MEMORY_CONSOLE.md) — SaaS-layer onboarding and continuity controls
- [ASSISTANT_WORKSPACE.md](./ASSISTANT_WORKSPACE.md) — no-code assistant memory flow
- [API_SURFACE_PHASE1.md](./API_SURFACE_PHASE1.md) — public vs hidden endpoint boundary for Phase 1
- [openapi.yaml](./openapi.yaml) — OpenAPI 3 spec (**`pnpm openapi:gen`** from `apps/api/scripts/generate_openapi.mjs`; must match `pnpm openapi:check` in CI)
- Recipes: [RECIPE_SUPPORT_AGENT.md](./RECIPE_SUPPORT_AGENT.md), [RECIPE_SAAS_COPILOT.md](./RECIPE_SAAS_COPILOT.md), [RECIPE_SMB_CHATBOT.md](./RECIPE_SMB_CHATBOT.md)
- [TRUST.md](./TRUST.md)

## Operator / internal

Contributor and production docs live under [../internal/README.md](../internal/README.md).
