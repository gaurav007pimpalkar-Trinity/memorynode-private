/**
 * Route request to the correct handler. Single source of truth for path+method matching.
 * Handlers are injected to avoid circular dependency with index.ts.
 * Phase 4: Worker split (IMPROVEMENT_PLAN.md). Refactor invariant: no external API behavior change.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditCtx {
  workspaceId?: string;
  apiKeyId?: string;
}

export type JsonResponseFn = (
  data: unknown,
  status?: number,
  extraHeaders?: Record<string, string>,
) => Response;

export interface RouterHandlers {
  handleCreateMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCreateConversation: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleIngest: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListMemories: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleGetMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    memoryId: string,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handlePostMemoryLink: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    fromMemoryId: string,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteMemoryLink: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    fromMemoryId: string,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handlePatchProfilePins: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleSearch: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListSearchHistory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleReplaySearch: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleContext: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleContextExplain: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleContextFeedback: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleUsageToday: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListAuditLog: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleDashboardOverviewStats: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleBillingStatus: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleBillingCheckout: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleBillingPortal: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleBillingWebhook: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleMemoryWebhookIngest: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCreateWorkspace: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCreateApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListApiKeys: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleRevokeApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleReprocessDeferredWebhooks: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleReconcileUsageRefunds: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleAdminBillingHealth: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleFounderPhase1Metrics: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCleanupExpiredSessions: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleMemoryHygiene: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleMemoryRetention: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleImport: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleGetConnectorSettings: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handlePatchConnectorSettings: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCreateEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListEvalSets: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    evalSetId: string,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleCreateEvalItem: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleListEvalItems: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    url: URL,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleDeleteEvalItem: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    evalItemId: string,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleRunEvalSet: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handlePruningMetrics: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    deps: HandlerDeps,
  ) => Promise<Response>;
  handleExplainAnswer: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: AuditCtx,
    requestId: string,
    deps: HandlerDeps,
  ) => Promise<Response>;
}

/** Injected per-request deps (e.g. bound jsonResponse). Passed to every handler. */
export interface HandlerDeps {
  jsonResponse: JsonResponseFn;
}

export interface RouterDeps {
  handlers: RouterHandlers;
  handlerDeps: HandlerDeps;
}

/**
 * Match path+method and delegate to the appropriate handler. Returns null for 404.
 */
export async function route(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
  url: URL,
  auditCtx: AuditCtx,
  requestId: string,
  deps: RouterDeps,
): Promise<Response | null> {
  const { handlers, handlerDeps } = deps;
  const { jsonResponse } = handlerDeps;

  if (request.method === "POST" && url.pathname === "/v1/memories") {
    return handlers.handleCreateMemory(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/memories/conversation") {
    return handlers.handleCreateConversation(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/ingest") {
    return handlers.handleIngest(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  const memoryLinksMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)\/links$/);
  if (memoryLinksMatch) {
    const rawFromId = decodeURIComponent(memoryLinksMatch[1]);
    const fromMemoryId = rawFromId.split("?")[0].split("#")[0].trim();
    if (fromMemoryId.startsWith("=") || !UUID_RE.test(fromMemoryId)) {
      return jsonResponse(
        { error: { code: "BAD_REQUEST", message: "memory_id must be a valid UUID" } },
        400,
      );
    }
    if (request.method === "POST") {
      return handlers.handlePostMemoryLink(
        request,
        env,
        supabase,
        fromMemoryId,
        auditCtx,
        requestId,
        handlerDeps,
      );
    }
    if (request.method === "DELETE") {
      return handlers.handleDeleteMemoryLink(
        request,
        env,
        supabase,
        fromMemoryId,
        auditCtx,
        requestId,
        handlerDeps,
      );
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/memories") {
    return handlers.handleListMemories(request, env, supabase, url, auditCtx, requestId, handlerDeps);
  }

  const memoryIdMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)$/);
  if (memoryIdMatch) {
    const rawMemoryId = decodeURIComponent(memoryIdMatch[1]);
    const memoryId = rawMemoryId.split("?")[0].split("#")[0].trim();
    if (memoryId.startsWith("=") || !UUID_RE.test(memoryId)) {
      return jsonResponse(
        { error: { code: "BAD_REQUEST", message: "memory_id must be a valid UUID" } },
        400,
      );
    }
    if (request.method === "GET") {
      return handlers.handleGetMemory(request, env, supabase, memoryId, auditCtx, requestId, handlerDeps);
    }
    if (request.method === "DELETE") {
      return handlers.handleDeleteMemory(request, env, supabase, memoryId, auditCtx, handlerDeps);
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/search/history") {
    return handlers.handleListSearchHistory(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/search/replay") {
    return handlers.handleReplaySearch(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/search") {
    return handlers.handleSearch(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/context") {
    return handlers.handleContext(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "PATCH" && url.pathname === "/v1/profile/pins") {
    return handlers.handlePatchProfilePins(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/context/explain") {
    return handlers.handleContextExplain(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/context/feedback") {
    return handlers.handleContextFeedback(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/pruning/metrics") {
    return handlers.handlePruningMetrics(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/explain/answer") {
    return handlers.handleExplainAnswer(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/usage/today") {
    return handlers.handleUsageToday(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/audit/log") {
    return handlers.handleListAuditLog(request, env, supabase, url, auditCtx, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/dashboard/overview-stats") {
    return handlers.handleDashboardOverviewStats(request, env, supabase, url, auditCtx, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/billing/status") {
    return handlers.handleBillingStatus(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    return handlers.handleBillingCheckout(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/portal") {
    return handlers.handleBillingPortal(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/webhooks/memory") {
    return handlers.handleMemoryWebhookIngest(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
    return handlers.handleBillingWebhook(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/workspaces") {
    return handlers.handleCreateWorkspace(request, env, supabase, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/api-keys") {
    return handlers.handleCreateApiKey(request, env, supabase, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/api-keys") {
    return handlers.handleListApiKeys(request, env, supabase, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/api-keys/revoke") {
    return handlers.handleRevokeApiKey(request, env, supabase, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/admin/webhooks/reprocess") {
    return handlers.handleReprocessDeferredWebhooks(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/admin/usage/reconcile") {
    return handlers.handleReconcileUsageRefunds(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/admin/sessions/cleanup") {
    return handlers.handleCleanupExpiredSessions(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/admin/memory-hygiene") {
    return handlers.handleMemoryHygiene(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/admin/memory-retention") {
    return handlers.handleMemoryRetention(request, env, supabase, requestId, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/billing/health") {
    return handlers.handleAdminBillingHealth(request, env, supabase, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/founder/phase1") {
    return handlers.handleFounderPhase1Metrics(request, env, supabase, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/import") {
    return handlers.handleImport(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/connectors/settings") {
    return handlers.handleGetConnectorSettings(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "PATCH" && url.pathname === "/v1/connectors/settings") {
    return handlers.handlePatchConnectorSettings(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "GET" && url.pathname === "/v1/evals/sets") {
    return handlers.handleListEvalSets(request, env, supabase, auditCtx, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/evals/sets") {
    return handlers.handleCreateEvalSet(request, env, supabase, auditCtx, handlerDeps);
  }

  const evalSetIdMatch = url.pathname.match(/^\/v1\/evals\/sets\/([^/]+)$/);
  if (evalSetIdMatch) {
    const evalSetId = decodeURIComponent(evalSetIdMatch[1]).trim();
    if (evalSetId.startsWith("=") || !UUID_RE.test(evalSetId)) {
      return jsonResponse(
        { error: { code: "BAD_REQUEST", message: "eval_set_id must be a valid UUID" } },
        400,
      );
    }
    if (request.method === "DELETE") {
      return handlers.handleDeleteEvalSet(request, env, supabase, evalSetId, auditCtx, handlerDeps);
    }
  }

  if (request.method === "GET" && url.pathname === "/v1/evals/items") {
    return handlers.handleListEvalItems(request, env, supabase, url, auditCtx, handlerDeps);
  }

  if (request.method === "POST" && url.pathname === "/v1/evals/items") {
    return handlers.handleCreateEvalItem(request, env, supabase, auditCtx, handlerDeps);
  }

  const evalItemIdMatch = url.pathname.match(/^\/v1\/evals\/items\/([^/]+)$/);
  if (evalItemIdMatch) {
    const evalItemId = decodeURIComponent(evalItemIdMatch[1]).trim();
    if (evalItemId.startsWith("=") || !UUID_RE.test(evalItemId)) {
      return jsonResponse(
        { error: { code: "BAD_REQUEST", message: "eval_item_id must be a valid UUID" } },
        400,
      );
    }
    if (request.method === "DELETE") {
      return handlers.handleDeleteEvalItem(request, env, supabase, evalItemId, auditCtx, handlerDeps);
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/evals/run") {
    return handlers.handleRunEvalSet(request, env, supabase, auditCtx, requestId, handlerDeps);
  }

  return null;
}
