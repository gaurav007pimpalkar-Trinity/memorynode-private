# Three-Layer Surface Matrix

Single source mapping for API routes, dashboard surfaces, and docs surfaces.

## API Route Mapping

| Route | Layer | Visibility Phase 1 | Notes |
| --- | --- | --- | --- |
| `POST /v1/memories` | Developer | Visible | Core write primitive |
| `GET /v1/memories` | Developer | Visible | Memory browse/list primitive |
| `GET /v1/memories/{uuid}` | Developer | Visible | Memory detail |
| `DELETE /v1/memories/{uuid}` | Developer | Visible | Memory delete primitive |
| `POST /v1/search` | Developer | Visible | Core retrieval call |
| `POST /v1/context` | Developer | Visible | Prompt-ready context |
| `GET /v1/context/explain` | Developer | Visible | Aha validation endpoint |
| `GET /v1/search/history` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/search/replay` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/context/feedback` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `GET /v1/pruning/metrics` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/explain/answer` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `GET /v1/evals/sets` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/evals/sets` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `DELETE /v1/evals/sets/{uuid}` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `GET /v1/evals/items` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/evals/items` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `DELETE /v1/evals/items/{uuid}` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `POST /v1/evals/run` | Developer | Hidden (advanced) | Phase 2 advanced tooling |
| `GET /v1/usage/today` | SaaS | Visible | Shared ops visibility |
| `GET /v1/dashboard/overview-stats` | SaaS | Visible | Console KPIs |
| `POST /v1/import` | SaaS | Visible | Paid import flow |
| `GET /v1/connectors/settings` | SaaS | Visible | Connector settings |
| `PATCH /v1/connectors/settings` | SaaS | Visible | Connector settings |
| `GET /v1/billing/status` | SaaS | Visible | Billing state |
| `POST /v1/billing/checkout` | SaaS | Visible | Billing activation |
| `POST /v1/billing/portal` | Internal | Hidden | Legacy endpoint, returns 410 |
| `POST /v1/billing/webhook` | Internal | Hidden | Platform callback |
| `GET /v1/audit/log` | Internal | Hidden | Internal operations |
| `POST /v1/workspaces` | Internal | Hidden | Admin provisioning path |
| `GET /v1/api-keys` | Internal | Hidden | Admin provisioning path |
| `POST /v1/api-keys` | Internal | Hidden | Admin provisioning path |
| `POST /v1/api-keys/revoke` | Internal | Hidden | Admin provisioning path |
| `/admin/*` | Internal | Hidden | Control-plane maintenance |
| `/v1/admin/*` | Internal | Hidden | Control-plane/founder metrics |
| `/v1/mcp`, `/mcp` | Assistant | Hidden (technical only) | Assistant UX in Phase 3 |

## Dashboard Surface Mapping

| Surface | Tabs (Phase 1) | Layer |
| --- | --- | --- |
| Developer Console | `Overview`, `Memory Browser`, `Import`, `API Keys`, `MCP Setup`, `Connectors`, `Usage`, `Workspaces` | Developer |
| SaaS Memory Console | `Overview`, `Continuity`, `Usage`, `Workspaces`, `Billing` | SaaS |
| Assistant Workspace | `Assistant` (remember + ask/recall + recent memories) | Assistant |

## Docs Surface Mapping

| Docs Entry | Layer | Purpose |
| --- | --- | --- |
| `docs/start-here/README.md` | Developer | 4-call quickstart |
| `docs/build/README.md` | Developer | Advanced build/integration path |
| `docs/build/sdk-usage.md` | Developer | SDK method usage |
| `docs/external/API_SURFACE_PHASE1.md` | Developer + SaaS | Public API visibility boundary |
| `docs/start-here/FOUNDER_PATH.md` | SaaS | Founder/operator onboarding path |
| `docs/external/ASSISTANT_WORKSPACE.md` | Assistant | No-code assistant workspace flow |
| `docs/MCP_SERVER.md`, `docs/start-here/MCP.md` | Assistant | MCP technical setup for tool-host integrations |
| `docs/internal/*` | Internal | Operations and release controls |
