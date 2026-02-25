#!/usr/bin/env node
/**
 * Generate docs/openapi.yaml from Zod schemas (Phase 5, Option A).
 *
 * Usage:
 *   node apps/api/scripts/generate_openapi.mjs          # write docs/openapi.yaml
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
const OPENAPI_PATH = resolve(__dirname, "../../../docs/openapi.yaml");

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

const MemoryInsertSchema = z
  .object({
    user_id: z.string().min(1).openapi({ example: "user_42" }),
    namespace: z.string().optional().openapi({ example: "default" }),
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT_CHARS)
      .openapi({ example: "Meeting notes from standup..." }),
    metadata: z
      .record(z.string(), metadataValue)
      .optional()
      .openapi({ example: { project: "alpha", priority: 1 } }),
  })
  .openapi("MemoryInsertPayload");

const MemoryInsertResponse = z
  .object({
    memory_id: z.string().openapi({ example: "mem_abc123" }),
    chunks: z.number().int().openapi({ example: 3 }),
  })
  .openapi("MemoryInsertResponse");

// ── Search / Context schemas ────────────────────────────────────────────────
const filtersSchema = z
  .object({
    metadata: z.record(z.string(), metadataValue).optional(),
    start_time: z.string().optional().openapi({ example: "2025-01-01T00:00:00Z" }),
    end_time: z.string().optional().openapi({ example: "2025-12-31T23:59:59Z" }),
  })
  .optional();

const SearchPayloadSchema = z
  .object({
    user_id: z.string().min(1).openapi({ example: "user_42" }),
    namespace: z.string().optional().openapi({ example: "default" }),
    query: z
      .string()
      .min(1)
      .max(MAX_QUERY_CHARS)
      .openapi({ example: "project status update" }),
    top_k: z.number().int().min(1).max(MAX_TOPK).optional().openapi({ example: 8 }),
    page: z.number().int().min(1).optional().openapi({ example: 1 }),
    page_size: z.number().int().min(1).max(50).optional().openapi({ example: 10 }),
    filters: filtersSchema,
  })
  .openapi("SearchPayload");

const SearchResultItem = z
  .object({
    chunk_id: z.string(),
    memory_id: z.string(),
    chunk_index: z.number().int(),
    text: z.string(),
    score: z.number(),
    metadata: z.record(z.string(), metadataValue).optional(),
  })
  .openapi("SearchResultItem");

const SearchResponse = z
  .object({
    results: z.array(SearchResultItem),
    page: z.number().int(),
    total: z.number().int(),
    has_more: z.boolean(),
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
    total: z.number().int(),
    has_more: z.boolean(),
  })
  .openapi("ContextResponse");

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
    imported: z.number().int().openapi({ example: 42 }),
    skipped: z.number().int().openapi({ example: 0 }),
    errors: z.number().int().openapi({ example: 0 }),
  })
  .openapi("ImportResponse");

// ── Export schemas ──────────────────────────────────────────────────────────
const ExportResponse = z
  .object({
    artifact_base64: z.string(),
    bytes: z.number().int(),
    sha256: z.string(),
  })
  .openapi("ExportResponse");

// ── Usage schemas ───────────────────────────────────────────────────────────
const UsageResponse = z
  .object({
    plan: z.string().openapi({ example: "free" }),
    writes: z.number().int(),
    reads: z.number().int(),
    embeds: z.number().int(),
    caps: z.object({
      writes: z.number().int(),
      reads: z.number().int(),
      embeds: z.number().int(),
    }),
  })
  .openapi("UsageResponse");

// ── Billing schemas ─────────────────────────────────────────────────────────
const BillingStatusResponse = z
  .object({
    plan: z.string().openapi({ example: "free", description: "Legacy internal DB plan label (free/pro) for compatibility. Use effective_plan for display and quotas." }),
    plan_status: z.string().openapi({ example: "active" }),
    current_period_end: z.string().nullable().openapi({ example: null }),
    cancel_at_period_end: z.boolean().openapi({ example: false }),
    effective_plan: z.string().openapi({ example: "build", description: "Plan code for display: launch|build|deploy|scale|scale_plus|free." }),
  })
  .openapi("BillingStatusResponse");

const BillingCheckoutPayload = z
  .object({
    plan: z
      .enum(["launch", "build", "deploy", "scale", "scale_plus"])
      .optional()
      .openapi({ example: "build" }),
  })
  .openapi("BillingCheckoutPayload");

// ── Admin schemas ───────────────────────────────────────────────────────────
const CreateWorkspacePayload = z
  .object({
    name: z.string().min(1).openapi({ example: "My Workspace" }),
  })
  .openapi("CreateWorkspacePayload");

const CreateApiKeyPayload = z
  .object({
    workspace_id: z.string().min(1).openapi({ example: "ws_abc123" }),
    label: z.string().optional().openapi({ example: "production" }),
  })
  .openapi("CreateApiKeyPayload");

const RevokeApiKeyPayload = z
  .object({
    key_id: z.string().min(1).openapi({ example: "key_abc123" }),
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
      namespace: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      page_size: z.coerce.number().int().min(1).max(100).optional(),
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

// POST /v1/export
registry.registerPath({
  method: "post",
  path: "/v1/export",
  summary: "Export memories (JSON or ZIP)",
  tags: ["Export / Import"],
  security: [{ [bearerAuth.name]: [] }],
  responses: {
    200: {
      description: "Export artifact",
      content: { "application/json": { schema: ExportResponse } },
    },
    401: errorRef("Unauthorized"),
  },
});

// POST /v1/import
registry.registerPath({
  method: "post",
  path: "/v1/import",
  summary: "Import memories from export artifact",
  tags: ["Export / Import"],
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

// ── Generate document ───────────────────────────────────────────────────────
const generator = new OpenApiGeneratorV3(registry.definitions);

const doc = generator.generateDocument({
  openapi: "3.0.3",
  info: {
    title: "MemoryNode API",
    version: "1.0.0",
    description:
      "MemoryNode – long-term memory layer for AI agents. " +
      "This spec is auto-generated from Zod schemas in apps/api/src/contracts/.",
  },
  servers: [
    { url: "https://api.memorynode.ai", description: "Production" },
    { url: "http://127.0.0.1:8787", description: "Local development" },
  ],
});

const yamlOutput = yamlStringify(doc, { lineWidth: 120 });

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
    console.log("docs/openapi.yaml is up to date.");
    process.exit(0);
  } else {
    const existingLines = existing.split("\n");
    const generatedLines = yamlOutput.split("\n");
    const maxLines = Math.max(existingLines.length, generatedLines.length);
    for (let i = 0; i < maxLines; i++) {
      if (existingLines[i] !== generatedLines[i]) {
        console.error(
          `docs/openapi.yaml is out of date (first diff at line ${i + 1}):`,
        );
        console.error(`  existing : ${existingLines[i] ?? "(EOF)"}`);
        console.error(`  generated: ${generatedLines[i] ?? "(EOF)"}`);
        break;
      }
    }
    console.error(
      '\nRun "pnpm openapi:gen" and commit the updated docs/openapi.yaml.',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OPENAPI_PATH, yamlOutput, "utf-8");
  console.log(`Wrote ${OPENAPI_PATH}`);
}
