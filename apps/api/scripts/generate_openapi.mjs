#!/usr/bin/env node
/**
 * Generate docs/external/openapi.yaml from Zod schemas (Phase 5, Option A).
 *
 * Usage:
 *   node apps/api/scripts/generate_openapi.mjs          # write docs/external/openapi.yaml
 *   node apps/api/scripts/generate_openapi.mjs --check   # exit 1 if file differs from generated
 */

import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { stringify as yamlStringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Bootstrap zod-to-openapi ────────────────────────────────────────────────
extendZodWithOpenApi(z);

// ── Constants (mirror apps/api/src/limits.ts) ───────────────────────────────
const MAX_TEXT_CHARS = 50_000;
const MAX_QUERY_CHARS = 2_000;
const MAX_TOPK = 20;

// ── Paths ───────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = resolve(__dirname, "../../../docs/external/openapi.yaml");

// ── Registry ────────────────────────────────────────────────────────────────
const registry = new OpenAPIRegistry();

// Security scheme
const bearerAuth = registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  description:
    'Worker API key. Pass via "Authorization: Bearer <key>" or "x-api-key" header.',
});

const adminAuth = registry.registerComponent("securitySchemes", "AdminToken", {
  type: "apiKey",
  in: "header",
  name: "x-admin-token",
  description: "Master admin token for control-plane endpoints.",
});

// ── Shared response schemas ─────────────────────────────────────────────────
const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "BAD_REQUEST" }),
      message: z.string().openapi({ example: "Validation failed" }),
      details: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .openapi({ example: { text: ["Required"] } }),
    }),
    request_id: z.string().openapi({ example: "req_abc123" }),
  })
  .openapi("ErrorResponse");

// ── Memory schemas ──────────────────────────────────────────────────────────
const metadataValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
/** Mirrors apps/api/src/contracts/search.ts MEMORY_TYPES */
const MEMORY_TYPES = ["fact", "preference", "event", "note", "task", "correction", "pin"];
const memoryTypeEnum = z.enum(MEMORY_TYPES);

const MemoryInsertSchema = z
  .object({
    userId: z.string().min(1).optional().openapi({ example: "user_42" }),
    user_id: z.string().min(1).optional().openapi({ example: "user_42" }),
    owner_id: z.string().min(1).optional(),
    owner_type: z.enum(["user", "team", "app"]).optional(),
    entity_id: z.string().min(1).optional(),
    entity_type: z.enum(["user", "team", "app"]).optional(),
    scope: z.string().optional(),
    namespace: z.string().optional().openapi({ example: "default" }),
    containerTag: z.string().optional(),
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT_CHARS)
      .openapi({ example: "Meeting notes from standup..." }),
    metadata: z
      .record(z.string(), metadataValue)
      .optional()
      .openapi({ example: { project: "alpha", priority: 1 } }),
    memory_type: memoryTypeEnum
      .optional()
      .openapi({
        description: "Optional memory type tag (see MEMORY_TYPES in apps/api/src/contracts/search.ts).",
      }),
    importance: z
      .number()
      .min(0.01)
      .max(100)
      .optional()
      .openapi({
        description: "Optional ranking multiplier. Higher values increase retrieval likelihood.",
      }),
    chunk_profile: z
      .enum(["balanced", "dense", "document"])
      .optional()
      .openapi({ description: "Chunking preset for long text before embedding." }),
    extract: z
      .boolean()
      .default(true)
      .optional()
      .openapi({
        description:
          "When true (default), may run lightweight LLM extraction to child memories when plan and budget allow. Set false to store only the parent memory.",
      }),
    effective_at: z.string().optional(),
    replaces_memory_id: z.string().uuid().optional(),
    idempotency_key: z.string().min(8).max(128).optional(),
  })
  .openapi("MemoryInsertPayload");

const MemoryInsertResponse = z
  .object({
    memory_id: z.string().openapi({ example: "mem_abc123" }),
    stored: z
      .literal(true)
      .openapi({
        description: "Always true on HTTP 200 — your memory row was persisted.",
      }),
    chunks: z
      .number()
      .int()
      .optional()
      .openapi({
        description:
          "Number of search-indexed chunks created for this write. Omitted when embedding was skipped (e.g. budget text-only ingest); use `stored` + `embedding` instead.",
        example: 3,
      }),
    embedding: z
      .literal("skipped_due_to_budget")
      .optional()
      .openapi({
        description:
          "Present when the memory row was saved but vector embedding was skipped (e.g. workspace AI budget). Search may not return this text until re-embedded.",
      }),
    extraction: z
      .object({
        status: z.enum(["run", "degraded", "skipped"]),
        reason: z
          .enum([
            "user_disabled",
            "low_importance",
            "plan_limit",
            "entitlement_degraded",
            "budget_limit",
            "extraction_error",
            "none",
          ])
          .optional()
          .openapi({
            description: "Only present when status is skipped (or extraction_error details).",
          }),
        error: z.string().optional(),
      })
      .openapi({ description: "What happened with automatic fact extraction for this write." }),
    safety: z
      .object({
        pii_hints: z.array(z.enum(["email", "phone"])),
      })
      .optional()
      .openapi({
        description: 'Present when request included header x-safety-pii-scan: "1" and hints were found.',
      }),
  })
  .openapi("MemoryInsertResponse");

// ── Search / Context schemas ────────────────────────────────────────────────
const filtersSchema = z
  .object({
    metadata: z.record(z.string(), metadataValue).optional(),
    start_time: z.string().optional().openapi({ example: "2025-01-01T00:00:00Z" }),
    end_time: z.string().optional().openapi({ example: "2025-12-31T23:59:59Z" }),
    memory_type: z
      .union([memoryTypeEnum, z.array(memoryTypeEnum).min(1)])
      .optional()
      .openapi({ description: "Single memory type or array (OR semantics)." }),
    filter_mode: z
      .enum(["and", "or"])
      .optional()
      .openapi({ description: "Metadata match mode (default and)." }),
  })
  .optional();

const SearchPayloadSchema = z
  .object({
    userId: z.string().min(1).optional(),
    user_id: z.string().min(1).optional().openapi({ example: "user_42" }),
    owner_id: z.string().min(1).optional(),
    owner_type: z.enum(["user", "team", "app"]).optional(),
    entity_id: z.string().min(1).optional(),
    entity_type: z.enum(["user", "team", "app"]).optional(),
    scope: z.string().optional(),
    namespace: z.string().optional().openapi({ example: "default" }),
    containerTag: z.string().optional(),
    query: z
      .string()
      .min(1)
      .max(MAX_QUERY_CHARS)
      .openapi({ example: "project status update" }),
    top_k: z.number().int().min(1).max(MAX_TOPK).optional().openapi({ example: 8 }),
    page: z.number().int().min(1).optional().openapi({ example: 1 }),
    page_size: z.number().int().min(1).max(50).optional().openapi({ example: 10 }),
    filters: filtersSchema,
    explain: z.boolean().optional(),
    search_mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
    min_score: z.number().min(0).max(1).optional(),
    retrieval_profile: z.enum(["balanced", "recall", "precision"]).optional(),
  })
  .openapi("SearchPayload");

const SearchResultItem = z
  .object({
    chunk_id: z.string(),
    memory_id: z.string(),
    chunk_index: z.number().int(),
    text: z.string(),
    score: z.number(),
    _explain: z
      .object({
        rrf_score: z.number(),
        match_sources: z.array(z.enum(["vector", "text"])),
        vector_score: z.number().optional(),
        text_score: z.number().optional(),
      })
      .optional(),
  })
  .openapi("SearchResultItem");

const SearchResponse = z
  .object({
    results: z.array(SearchResultItem),
    page: z.number().int(),
    page_size: z.number().int().optional(),
    total: z.number().int(),
    has_more: z.boolean(),
    retrieval_trace: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SearchResponse");

const ContextResponse = z
  .object({
    context_text: z.string(),
    citations: z.array(
      z.object({
        i: z.number().int(),
        chunk_id: z.string(),
        memory_id: z.string(),
        chunk_index: z.number().int(),
      }),
    ),
    page: z.number().int(),
    page_size: z.number().int().optional(),
    total: z.number().int(),
    has_more: z.boolean(),
    context_blocks: z.number().int().optional(),
  })
  .openapi("ContextResponse");

const ContextExplainResponse = z
  .object({
    query: z.object({
      user_id: z.string(),
      namespace: z.string().nullable(),
      query: z.string(),
      top_k: z.number().nullable(),
      search_mode: z.enum(["hybrid", "vector", "keyword"]),
      min_score: z.number().nullable(),
      retrieval_profile: z.enum(["balanced", "recall", "precision"]).nullable(),
    }),
    memories_retrieved: z.array(
      z.object({
        memory_id: z.string(),
        text: z.string(),
      }),
    ),
    chunk_ids_used: z.array(z.string()),
    results: z.array(
      z.object({
        rank: z.number().int(),
        memory_id: z.string(),
        chunk_id: z.string(),
        chunk_index: z.number().int(),
        text: z.string(),
        scores: z.object({
          relevance_score: z.number(),
          recency_score: z.number(),
          importance_score: z.number(),
          final_score: z.number(),
        }),
        ordering_explanation: z.string(),
      }),
    ),
    total: z.number().int(),
    page: z.number().int(),
    page_size: z.number().int(),
    has_more: z.boolean(),
  })
  .openapi("ContextExplainResponse");

// ── Import schemas ──────────────────────────────────────────────────────────
const ImportModeSchema = z
  .enum([
    "upsert",
    "skip_existing",
    "error_on_conflict",
    "replace_ids",
    "replace_all",
  ])
  .openapi("ImportMode");

const ImportPayloadSchema = z
  .object({
    artifact_base64: z
      .string()
      .min(1)
      .openapi({ example: "eyJ2ZXJzaW9uIjoxLC4uLn0=" }),
    mode: ImportModeSchema.optional(),
  })
  .openapi("ImportPayload");

const ImportResponse = z
  .object({
    imported_memories: z.number().int().openapi({ example: 42 }),
    imported_chunks: z.number().int().openapi({ example: 126 }),
  })
  .openapi("ImportResponse");

// ── Usage schemas ───────────────────────────────────────────────────────────
const UsageCapAlertSchema = z
  .object({
    resource: z.enum([
      "writes",
      "reads",
      "embeds",
      "embed_tokens",
      "extraction_calls",
      "gen_tokens",
      "storage",
    ]),
    severity: z.enum(["warning", "critical"]),
    used: z.number(),
    cap: z.number(),
    ratio: z.number(),
  })
  .openapi("UsageCapAlert");

const UsageResponse = z
  .object({
    day: z.string().optional().openapi({ example: "2026-04-18" }),
    workspace_id: z.string().optional().openapi({ example: "00000000-0000-4000-8000-000000000000" }),
    plan: z.string().openapi({ example: "launch" }),
    entitlement_active: z.boolean().optional().openapi({ example: true }),
    entitlement_source: z.enum(["billing", "internal_grant"]).optional().openapi({ example: "billing" }),
    writes: z.number().int(),
    reads: z.number().int(),
    embeds: z.number().int(),
    limits: z
      .object({
        writes: z.number().int(),
        reads: z.number().int(),
        embeds: z.number().int(),
      })
      .optional(),
    caps: z
      .object({
        writes: z.number().int(),
        reads: z.number().int(),
        embeds: z.number().int(),
      })
      .optional()
      .openapi({ deprecated: true, description: "Legacy alias; prefer limits." }),
    cap_alerts: z.array(UsageCapAlertSchema).optional(),
    operational_mode: z.enum(["normal", "degraded", "sleep"]).optional(),
    grace_soft_downgrade: z.boolean().optional().openapi({
      description:
        "True when entitlement is in billing grace: daily limits floored toward Launch while plan reflects the paid tier.",
    }),
  })
  .openapi("UsageResponse");

const AuditLogEntrySchema = z
  .object({
    id: z.string(),
    route: z.string(),
    method: z.string(),
    status: z.number().int(),
    bytes_in: z.number().int(),
    bytes_out: z.number().int(),
    latency_ms: z.number().int(),
    ip_hash: z.string(),
    api_key_id: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("AuditLogEntry");

const AuditLogListResponse = z
  .object({
    entries: z.array(AuditLogEntrySchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1),
    has_more: z.boolean(),
  })
  .openapi("AuditLogListResponse");

const DashboardOverviewResponse = z
  .object({
    range: z.enum(["1d", "7d", "30d", "all"]),
    documents: z.number().int(),
    memories: z.number().int(),
    search_requests: z.number().int(),
    container_tags: z.number().int(),
  })
  .openapi("DashboardOverviewResponse");

const ConnectorCaptureTypesSchema = z
  .object({
    pdf: z.boolean().optional(),
    docx: z.boolean().optional(),
    txt: z.boolean().optional(),
    md: z.boolean().optional(),
    html: z.boolean().optional(),
    csv: z.boolean().optional(),
    tsv: z.boolean().optional(),
    xlsx: z.boolean().optional(),
    pptx: z.boolean().optional(),
    eml: z.boolean().optional(),
    msg: z.boolean().optional(),
  })
  .openapi("ConnectorCaptureTypes");

const ConnectorSettingRowSchema = z
  .object({
    connector_id: z.string(),
    sync_enabled: z.boolean(),
    capture_types: ConnectorCaptureTypesSchema,
    updated_at: z.string(),
  })
  .openapi("ConnectorSettingRow");

const ConnectorSettingsListResponse = z
  .object({
    settings: z.array(ConnectorSettingRowSchema),
  })
  .openapi("ConnectorSettingsListResponse");

const ConnectorSettingPatchPayload = z
  .object({
    connector_id: z.string().min(1).max(120),
    sync_enabled: z.boolean().optional(),
    capture_types: ConnectorCaptureTypesSchema.optional(),
  })
  .openapi("ConnectorSettingPatchPayload");

const ConnectorSettingPatchResponse = z
  .object({
    connector_id: z.string(),
    sync_enabled: z.boolean(),
    capture_types: ConnectorCaptureTypesSchema,
    updated_at: z.string(),
  })
  .openapi("ConnectorSettingPatchResponse");

// ── Billing schemas ─────────────────────────────────────────────────────────
const BillingStatusResponse = z
  .object({
    plan: z.string().openapi({ example: "pro", description: "Legacy internal DB plan label (pro/team) for compatibility. Use effective_plan for display and quotas." }),
    plan_status: z.string().openapi({ example: "active" }),
    current_period_end: z.string().nullable().openapi({ example: null }),
    cancel_at_period_end: z.boolean().openapi({ example: false }),
    effective_plan: z.string().openapi({ example: "build", description: "Plan code for display: launch|build|deploy|scale|scale_plus." }),
  })
  .openapi("BillingStatusResponse");

/** Matches CHECKOUT_PLAN_IDS in apps/api/src/handlers/billing.ts — scale_plus is an entitlement tier only (GET /v1/billing/status), not a checkout target. */
const BillingCheckoutPayload = z
  .object({
    plan: z
      .enum(["launch", "build", "deploy", "scale"])
      .optional()
      .openapi({ example: "build" }),
    firstname: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  .openapi("BillingCheckoutPayload");

// ── Admin schemas ───────────────────────────────────────────────────────────
const CreateWorkspacePayload = z
  .object({
    name: z.string().min(1).openapi({ example: "My Workspace" }),
    internal: z.boolean().optional().openapi({ example: false }),
    entitlement_source: z.enum(["billing", "internal_grant"]).optional().openapi({ example: "billing" }),
    grant_reason: z.string().min(3).max(200).optional().openapi({ example: "production_smoke_workspace" }),
  })
  .openapi("CreateWorkspacePayload");

const CreateApiKeyPayload = z
  .object({
    workspace_id: z.string().min(1).openapi({ example: "ws_abc123" }),
    name: z.string().min(1).openapi({ example: "production" }),
  })
  .openapi("CreateApiKeyPayload");

const RevokeApiKeyPayload = z
  .object({
    api_key_id: z.string().min(1).openapi({ example: "key_abc123" }),
  })
  .openapi("RevokeApiKeyPayload");

// ── 400 / 401 / 404 response helpers ───────────────────────────────────────
function errorRef(description) {
  return {
    description,
    content: {
      "application/json": { schema: ErrorResponse },
    },
  };
}

// ── Register paths ──────────────────────────────────────────────────────────

// Health
registry.registerPath({
  method: "get",
  path: "/healthz",
  summary: "Health check",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            version: z.string(),
            build_version: z.string().optional(),
            stage: z.string().optional(),
            git_sha: z.string().optional(),
          }),
        },
      },
    },
  },
});

// Versioned health (API clients; same payload as /healthz)
registry.registerPath({
  method: "get",
  path: "/v1/health",
  summary: "Health check (versioned)",
  description: "Returns service health and version. Same response as /healthz. No auth required. Prefer this for API clients that version endpoints.",
  tags: ["Health"],
  responses: {
    200: {
      description: "Service healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            version: z.string(),
            build_version: z.string().optional(),
            stage: z.string().optional(),
            git_sha: z.string().optional(),
            embedding_model: z.string().optional(),
          }),
        },
      },
    },
  },
});

// Readiness (deep: DB check; for LB/CF)
registry.registerPath({
  method: "get",
  path: "/ready",
  summary: "Readiness check",
  description: "Checks DB connectivity. Returns 200 when DB is reachable, 503 otherwise. No auth required. Use for load balancer or platform health checks.",
  tags: ["Health"],
  responses: {
    200: {
      description: "Ready to serve traffic",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            db: z.literal("connected"),
          }),
        },
      },
    },
    503: {
      description: "Not ready (e.g. DB unavailable)",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("degraded"),
            db: z.literal("unavailable"),
            message: z.string().optional(),
          }),
        },
      },
    },
  },
});

// POST /v1/memories
registry.registerPath({
  method: "post",
  path: "/v1/memories",
  summary: "Ingest a memory",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    headers: z.object({
      "x-safety-pii-scan": z
        .enum(["1"])
        .optional()
        .openapi({
          description:
            'When set to "1", response may include safety.pii_hints (heuristic email/phone hints only; not a DLP scan).',
        }),
    }),
    body: {
      required: true,
      content: {
        "application/json": { schema: MemoryInsertSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Memory ingested",
      content: { "application/json": { schema: MemoryInsertResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

// GET /v1/memories
registry.registerPath({
  method: "get",
  path: "/v1/memories",
  summary: "List memories with pagination and filters",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      user_id: z.string().optional(),
      owner_id: z.string().optional(),
      entity_id: z.string().optional(),
      owner_type: z.enum(["user", "team", "app"]).optional(),
      entity_type: z.enum(["user", "team", "app"]).optional(),
      namespace: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      page_size: z.coerce.number().int().min(1).max(100).optional(),
      memory_type: memoryTypeEnum.optional(),
      metadata: z.string().optional().openapi({ description: "JSON-encoded metadata filter" }),
      start_time: z.string().optional(),
      end_time: z.string().optional(),
    }),
  },
  responses: {
    200: { description: "Paginated list of memories" },
    401: errorRef("Unauthorized"),
  },
});

// GET /v1/memories/:id
registry.registerPath({
  method: "get",
  path: "/v1/memories/{id}",
  summary: "Fetch a single memory by ID",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Memory object" },
    404: errorRef("Memory not found"),
    401: errorRef("Unauthorized"),
  },
});

// DELETE /v1/memories/:id
registry.registerPath({
  method: "delete",
  path: "/v1/memories/{id}",
  summary: "Delete a memory",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { description: "Memory deleted" },
    404: errorRef("Memory not found"),
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/search
registry.registerPath({
  method: "post",
  path: "/v1/search",
  summary: "Hybrid search (vector + full-text + RRF)",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SearchPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: SearchResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/context
registry.registerPath({
  method: "post",
  path: "/v1/context",
  summary: "Prompt-ready context with citations",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: SearchPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Context text and citations",
      content: { "application/json": { schema: ContextResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/context/explain",
  summary: "Explain retrieval and ranking for a context query",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      userId: z.string().min(1).optional(),
      user_id: z.string().min(1).optional(),
      owner_id: z.string().min(1).optional(),
      owner_type: z.enum(["user", "team", "app"]).optional(),
      entity_id: z.string().min(1).optional(),
      entity_type: z.enum(["user", "team", "app"]).optional(),
      scope: z.string().optional(),
      namespace: z.string().optional(),
      containerTag: z.string().optional(),
      query: z.string().min(1),
      top_k: z.coerce.number().int().min(1).max(MAX_TOPK).optional(),
      page: z.coerce.number().int().min(1).optional(),
      page_size: z.coerce.number().int().min(1).max(50).optional(),
      search_mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
      min_score: z.coerce.number().min(0).max(1).optional(),
      retrieval_profile: z.enum(["balanced", "recall", "precision"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Retrieval/ranking explanation payload",
      content: { "application/json": { schema: ContextExplainResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

// GET /v1/usage/today
registry.registerPath({
  method: "get",
  path: "/v1/usage/today",
  summary: "Usage counters and effective plan caps for today",
  tags: ["Usage"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Current usage",
      content: { "application/json": { schema: UsageResponse } },
    },
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/audit/log",
  summary: "Tenant-scoped API request audit trail (paginated)",
  tags: ["Usage"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional().openapi({ example: 1 }),
      limit: z.coerce.number().int().min(1).max(200).optional().openapi({ example: 50 }),
    }),
  },
  responses: {
    200: {
      description: "Audit log page",
      content: { "application/json": { schema: AuditLogListResponse } },
    },
    401: errorRef("Unauthorized"),
    402: errorRef("Upgrade required"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/dashboard/overview-stats",
  summary:
    "Console overview aggregates for the authenticated workspace. Optional query: range=1d|7d|30d|all (default all).",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Aggregate counts",
      content: { "application/json": { schema: DashboardOverviewResponse } },
    },
    401: errorRef("Unauthorized"),
    500: errorRef("Server error"),
  },
});

const DashboardOpsEnvelope = z
  .object({ ok: z.boolean() })
  .passthrough()
  .openapi("DashboardOpsEnvelope");

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/bootstrap",
  summary:
    "Pre-session workspace bootstrap: validates Supabase access_token, returns existing workspace or creates one via create_workspace; client then establishes cookie via POST /v1/dashboard/session.",
  tags: ["Dashboard"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              access_token: z.string(),
              workspace_name: z.string().optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Workspace id and name; created indicates new workspace",
      content: { "application/json": { schema: DashboardOpsEnvelope } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/dashboard/workspaces",
  summary: "List workspaces for the signed-in dashboard user (membership-scoped)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Workspace list", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    401: errorRef("Unauthorized"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/workspaces",
  summary: "Create a workspace (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ name: z.string() }).strict() } },
    },
  },
  responses: {
    200: { description: "Created workspace", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/dashboard/api-keys",
  summary: "List API keys for a workspace (query workspace_id optional; must match session workspace)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      workspace_id: z.string().uuid().optional().openapi({ example: "00000000-0000-4000-8000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "API keys", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    401: errorRef("Unauthorized"),
    403: errorRef("Forbidden"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/api-keys",
  summary: "Create API key (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              workspace_id: z.string().uuid(),
              name: z.string(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "New key material (once)", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/api-keys/revoke",
  summary: "Revoke API key (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ api_key_id: z.string().uuid() }).strict() } },
    },
  },
  responses: {
    200: { description: "Revocation result", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/dashboard/members",
  summary: "List workspace members (query workspace_id optional; must match session workspace)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      workspace_id: z.string().uuid().optional().openapi({ example: "00000000-0000-4000-8000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Members", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    401: errorRef("Unauthorized"),
    403: errorRef("Forbidden"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/dashboard/invites",
  summary: "List pending workspace invites (query workspace_id optional; must match session workspace)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      workspace_id: z.string().uuid().optional().openapi({ example: "00000000-0000-4000-8000-000000000000" }),
    }),
  },
  responses: {
    200: { description: "Invites", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    401: errorRef("Unauthorized"),
    403: errorRef("Forbidden"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/invites",
  summary: "Create workspace invite (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              workspace_id: z.string().uuid(),
              email: z.string().email(),
              role: z.enum(["member", "admin", "owner"]),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Invite created", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/invites/revoke",
  summary: "Revoke workspace invite (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ invite_id: z.string().uuid() }).strict() } },
    },
  },
  responses: {
    200: { description: "Revocation result", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/members/role",
  summary: "Update member role (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              workspace_id: z.string().uuid(),
              user_id: z.string().uuid(),
              role: z.enum(["member", "admin", "owner"]),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Update result", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/members/remove",
  summary: "Remove workspace member (CSRF required)",
  tags: ["Dashboard"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ workspace_id: z.string().uuid(), user_id: z.string().uuid() }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "Removal result", content: { "application/json": { schema: DashboardOpsEnvelope } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    403: errorRef("Invalid CSRF"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/connectors/settings",
  summary: "List connector capture settings for the workspace",
  tags: ["Connectors"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Connector settings rows",
      content: { "application/json": { schema: ConnectorSettingsListResponse } },
    },
    401: errorRef("Unauthorized"),
    429: errorRef("Rate limited"),
    500: errorRef("Server error"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/connectors/settings",
  summary: "Upsert capture settings for one connector",
  tags: ["Connectors"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ConnectorSettingPatchPayload } },
    },
  },
  responses: {
    200: {
      description: "Updated connector row",
      content: { "application/json": { schema: ConnectorSettingPatchResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    429: errorRef("Rate limited"),
    500: errorRef("Server error"),
  },
});

// POST /v1/import
registry.registerPath({
  method: "post",
  path: "/v1/import",
  summary: "Import memories from artifact (paid plans)",
  tags: ["Import"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ImportPayloadSchema } },
    },
  },
  responses: {
    200: {
      description: "Import result",
      content: { "application/json": { schema: ImportResponse } },
    },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    402: errorRef("Upgrade required for import"),
  },
});

// ── Billing ─────────────────────────────────────────────────────────────────

// GET /v1/billing/status
registry.registerPath({
  method: "get",
  path: "/v1/billing/status",
  summary: "Current billing status and plan",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Billing status",
      content: { "application/json": { schema: BillingStatusResponse } },
    },
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/billing/checkout
registry.registerPath({
  method: "post",
  path: "/v1/billing/checkout",
  summary: "Create PayU checkout session",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: BillingCheckoutPayload } },
    },
  },
  responses: {
    200: { description: "Checkout URL or form fields" },
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/billing/portal
registry.registerPath({
  method: "post",
  path: "/v1/billing/portal",
  summary: "Legacy billing portal (returns 410 Gone)",
  tags: ["Billing"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    410: { description: "Gone – legacy Stripe portal removed" },
  },
});

// POST /v1/billing/webhook
registry.registerPath({
  method: "post",
  path: "/v1/billing/webhook",
  summary: "PayU webhook callback",
  tags: ["Billing"],
  responses: {
    200: { description: "Webhook processed" },
    400: errorRef("Invalid webhook payload or signature"),
  },
});

// ── Admin ───────────────────────────────────────────────────────────────────

// POST /v1/workspaces
registry.registerPath({
  method: "post",
  path: "/v1/workspaces",
  summary: "Create a workspace (admin only)",
  tags: ["Admin"],
  security: [{ [adminAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateWorkspacePayload } },
    },
  },
  responses: {
    200: { description: "Workspace created" },
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/api-keys
registry.registerPath({
  method: "post",
  path: "/v1/api-keys",
  summary: "Create an API key for a workspace (admin only)",
  tags: ["Admin"],
  security: [{ [adminAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateApiKeyPayload } },
    },
  },
  responses: {
    200: { description: "API key created" },
    401: errorRef("Unauthorized"),
  },
});

// GET /v1/api-keys
registry.registerPath({
  method: "get",
  path: "/v1/api-keys",
  summary: "List masked API keys for a workspace (admin only)",
  tags: ["Admin"],
  security: [{ [adminAuth.name]: [] }],
  request: {
    query: z.object({
      workspace_id: z.string().openapi({ example: "ws_abc123" }),
    }),
  },
  responses: {
    200: { description: "List of masked API keys" },
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/api-keys/revoke
registry.registerPath({
  method: "post",
  path: "/v1/api-keys/revoke",
  summary: "Revoke an API key (admin only)",
  tags: ["Admin"],
  security: [{ [adminAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RevokeApiKeyPayload } },
    },
  },
  responses: {
    200: { description: "API key revoked" },
    401: errorRef("Unauthorized"),
  },
});

const ConversationInsertPayload = z
  .object({
    userId: z.string().optional(),
    user_id: z.string().optional(),
    transcript: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant", "system", "tool"]),
          content: z.string(),
          at: z.string().optional(),
        }),
      )
      .optional(),
    namespace: z.string().optional(),
    scope: z.string().optional(),
    metadata: z.record(z.string(), metadataValue).optional(),
    memory_type: memoryTypeEnum.optional(),
    extract: z.boolean().optional(),
  })
  .openapi("ConversationInsertPayload");

const IngestEnvelope = z
  .object({
    kind: z.enum(["memory", "conversation", "document", "bundle"]),
    body: z.record(z.string(), z.unknown()).openapi({
      description:
        "Discriminated by kind: memory/conversation/document use MemoryInsertSchema or conversation fields; bundle uses ImportPayload fields.",
    }),
  })
  .openapi("IngestEnvelope");

const MemoryLinkCreatePayload = z
  .object({
    to_memory_id: z.string().uuid(),
    link_type: z.enum(["related_to", "about_ticket", "same_topic"]),
  })
  .openapi("MemoryLinkCreatePayload");

const ProfilePinsPatchPayload = z
  .object({
    userId: z.string().optional(),
    user_id: z.string().optional(),
    scope: z.string().optional(),
    namespace: z.string().optional(),
    memory_ids: z.array(z.string().uuid()).max(10),
  })
  .openapi("ProfilePinsPatchPayload");

const SearchReplayPayload = z.object({ query_id: z.string().uuid() }).openapi("SearchReplayPayload");

const ContextFeedbackPayload = z
  .object({
    trace_id: z.string().min(1),
    query_id: z.string().optional(),
    eval_set_id: z.string().optional(),
    chunk_ids_used: z.array(z.string()).optional(),
    chunk_ids_unused: z.array(z.string()).optional(),
  })
  .openapi("ContextFeedbackPayload");

const ExplainAnswerPayload = z
  .object({
    question: z.string().min(1),
    context: z.string().min(1),
  })
  .openapi("ExplainAnswerPayload");

const EvalSetCreatePayload = z.object({ name: z.string().min(1).max(120) }).openapi("EvalSetCreatePayload");

const EvalItemCreatePayload = z
  .object({
    eval_set_id: z.string().uuid(),
    query: z.string().min(1),
    expected_memory_ids: z.array(z.string().uuid()).default([]),
  })
  .openapi("EvalItemCreatePayload");

const EvalRunPayload = z
  .object({
    eval_set_id: z.string().uuid(),
    user_id: z.string().optional(),
    owner_id: z.string().optional(),
    namespace: z.string().optional(),
    top_k: z.number().int().min(1).max(MAX_TOPK).optional(),
    search_mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
    min_score: z.number().min(0).max(1).optional(),
  })
  .openapi("EvalRunPayload");

const MemoryWebhookPayload = z
  .object({
    workspace_id: z.string().min(1),
  })
  .passthrough()
  .openapi({
    description:
      "Same fields as POST /v1/memories plus workspace_id. Signed with X-MN-Webhook-Signature (see docs/external/API_USAGE.md).",
  });

// ── Additional routes (also in apps/api/src/router.ts) ─────────────────────

registry.registerPath({
  method: "post",
  path: "/v1/memories/conversation",
  summary: "Ingest transcript or structured messages as a memory",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ConversationInsertPayload } },
    },
  },
  responses: {
    200: { description: "Conversation stored", content: { "application/json": { schema: MemoryInsertResponse } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/ingest",
  summary: "Unified ingest dispatcher (memory, conversation, document text, or bundle import)",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: IngestEnvelope } } },
  },
  responses: {
    200: { description: "Ingest result (shape varies by kind)" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/memories/{id}/links",
  summary: "Create a typed link between two memories",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { required: true, content: { "application/json": { schema: MemoryLinkCreatePayload } } },
  },
  responses: {
    200: { description: "Link created" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
    402: errorRef("Upgrade required"),
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/memories/{id}/links",
  summary: "Delete a typed link from this memory",
  tags: ["Memories"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      to_memory_id: z.string().uuid(),
      link_type: z.enum(["related_to", "about_ticket", "same_topic"]),
    }),
  },
  responses: {
    200: { description: "Link removed" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/search/history",
  summary: "Recent search queries for the workspace",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: { description: "Search history rows" },
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/search/replay",
  summary: "Replay a stored search by query_id",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: SearchReplayPayload } } },
  },
  responses: {
    200: { description: "Replay results" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/profile/pins",
  summary: "Replace pinned memories (metadata.pinned) for a user/namespace",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: ProfilePinsPatchPayload } } },
  },
  responses: {
    200: { description: "Pins updated" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/context/feedback",
  summary: "Submit retrieval feedback for a trace",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: ContextFeedbackPayload } } },
  },
  responses: {
    200: { description: "Feedback accepted", content: { "application/json": { schema: z.object({ accepted: z.boolean() }) } } },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/pruning/metrics",
  summary: "Workspace pruning / dedupe counters",
  tags: ["Usage"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "Metrics" },
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/explain/answer",
  summary: "Explain an answer from question + retrieved context text",
  tags: ["Retrieval"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: ExplainAnswerPayload } } },
  },
  responses: {
    200: { description: "Generated explanation" },
    400: errorRef("Validation error"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/webhooks/memory",
  summary: "Signed memory ingest webhook (not the project API-key path; uses HMAC + optional internal forward token)",
  tags: ["Webhooks"],
  request: {
    body: { required: true, content: { "application/json": { schema: MemoryWebhookPayload } } },
  },
  responses: {
    200: { description: "Accepted" },
    400: errorRef("Invalid signature or body"),
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/evals/sets",
  summary: "List evaluation sets",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "Eval sets" }, 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/v1/evals/sets",
  summary: "Create an evaluation set",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: EvalSetCreatePayload } } },
  },
  responses: { 200: { description: "Created" }, 400: errorRef("Validation error"), 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/v1/evals/sets/{eval_set_id}",
  summary: "Delete an evaluation set",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ eval_set_id: z.string().uuid() }) },
  responses: { 200: { description: "Deleted" }, 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "get",
  path: "/v1/evals/items",
  summary: "List eval items for a set",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    query: z.object({ eval_set_id: z.string().uuid() }),
  },
  responses: { 200: { description: "Items" }, 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/v1/evals/items",
  summary: "Create an eval item (query + expected memory IDs)",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: EvalItemCreatePayload } } },
  },
  responses: { 200: { description: "Created" }, 400: errorRef("Validation error"), 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "delete",
  path: "/v1/evals/items/{eval_item_id}",
  summary: "Delete an eval item",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: { params: z.object({ eval_item_id: z.string().uuid() }) },
  responses: { 200: { description: "Deleted" }, 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/v1/evals/run",
  summary: "Run precision/recall evaluation for a set",
  tags: ["Evals"],
  security: [{ [bearerAuth.name]: [] }],
  request: {
    body: { required: true, content: { "application/json": { schema: EvalRunPayload } } },
  },
  responses: { 200: { description: "Eval metrics" }, 400: errorRef("Validation error"), 401: errorRef("Unauthorized") },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/session",
  summary: "Establish dashboard browser session (cookie + CSRF); implemented in workerApp.ts",
  tags: ["Dashboard"],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            access_token: z.string(),
            workspace_id: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Session established; sets cookies and returns csrf_token when applicable" },
    401: errorRef("Unauthorized"),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/dashboard/logout",
  summary: "Clear dashboard session cookie",
  tags: ["Dashboard"],
  responses: {
    200: { description: "Logout acknowledged", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    403: errorRef("Invalid CSRF"),
    429: errorRef("Rate limited"),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/mcp",
  summary: "Hosted Streamable MCP (also served as /mcp); Authorization: Bearer API key",
  tags: ["MCP"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: { description: "MCP capability response (SSE/streamable HTTP)" },
    426: { description: "Upgrade required for WebSocket legacy clients" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/mcp",
  summary: "Hosted MCP POST (JSON-RPC / streamable)",
  tags: ["MCP"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "MCP response" } },
});

registry.registerPath({
  method: "delete",
  path: "/v1/mcp",
  summary: "Terminate MCP session when applicable",
  tags: ["MCP"],
  security: [{ [bearerAuth.name]: [] }],
  responses: { 200: { description: "Session cleared" } },
});

// ── Generate document ───────────────────────────────────────────────────────
const generator = new OpenApiGeneratorV3(registry.definitions);

const doc = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "MemoryNode API",
    version: "1.0.0",
    description:
      "MemoryNode — reliable per-user memory for customer-facing AI (support bots, SMB chat, SaaS copilots). " +
      "Store, search, and prompt-ready context over HTTPS; hybrid retrieval is server-managed.\n\n" +
      "This file is produced by `pnpm openapi:gen` from `apps/api/scripts/generate_openapi.mjs` (schemas aligned with `apps/api/src/contracts/`).\n\n" +
      "**Also implemented in the Worker but omitted or summarized here:** `/healthz`, `/ready`, `/mcp`, PayU `/v1/billing/webhook`, " +
      "admin cron endpoints (`/admin/*`), read-only `/v1/admin/*`, and `/v1/admin/founder/phase1`. Dashboard routes use the browser session cookie in production; OpenAPI lists `BearerAuth` for generator consistency. See `apps/api/src/router.ts` and `workerApp.ts`.",
    "x-doc-governance":
      "SOURCE_OF_TRUTH: Regenerate via `pnpm openapi:gen` when `apps/api/scripts/generate_openapi.mjs`, `apps/api/src/contracts/`, or `apps/api/src/router.ts` change. Same PR as behavioral API changes. Human prose: `docs/external/API_USAGE.md`.",
  },
  servers: [
    { url: "https://api.memorynode.ai", description: "Production" },
    { url: "http://127.0.0.1:8787", description: "Local development" },
  ],
});

const OPENAPI_FILE_PREAMBLE = `# -----------------------------------------------------------------------------
# Source of Truth (OpenAPI artifact)
#
# This file MUST reflect actual HTTP behavior. Regenerate with: pnpm openapi:gen
# If apps/api/src/router.ts, apps/api/src/contracts/, or packages/sdk/src/ change
# API behavior → update apps/api/scripts/generate_openapi.mjs and/or docs, then
# commit the regenerated openapi.yaml in the SAME PR (see scripts/check_docs_drift.mjs).
# -----------------------------------------------------------------------------

`;

const yamlOutput = OPENAPI_FILE_PREAMBLE + yamlStringify(doc, { lineWidth: 120 });

// ── Write or check ──────────────────────────────────────────────────────────
const isCheck = process.argv.includes("--check");

if (isCheck) {
  let existing;
  try {
    existing = readFileSync(OPENAPI_PATH, "utf-8");
  } catch {
    console.error(
      `ERROR: ${OPENAPI_PATH} does not exist. Run "pnpm openapi:gen" first.`,
    );
    process.exit(1);
  }
  if (existing === yamlOutput) {
    console.log("docs/external/openapi.yaml is up to date.");
    process.exit(0);
  } else {
    const existingLines = existing.split("\n");
    const generatedLines = yamlOutput.split("\n");
    const maxLines = Math.max(existingLines.length, generatedLines.length);
    for (let i = 0; i < maxLines; i++) {
      if (existingLines[i] !== generatedLines[i]) {
        console.error(
          `docs/external/openapi.yaml is out of date (first diff at line ${i + 1}):`,
        );
        console.error(`  existing : ${existingLines[i] ?? "(EOF)"}`);
        console.error(`  generated: ${generatedLines[i] ?? "(EOF)"}`);
        break;
      }
    }
    console.error(
      '\nRun "pnpm openapi:gen" and commit the updated docs/external/openapi.yaml.',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OPENAPI_PATH, yamlOutput, "utf-8");
  console.log(`Wrote ${OPENAPI_PATH}`);
}
