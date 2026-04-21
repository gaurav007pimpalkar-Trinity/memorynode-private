export { MemoryNodeApiError } from "./errors.js";
import { MemoryNodeApiError } from "./errors.js";

import type {
  AddConversationMemoryRequest,
  AddMemoryRequest,
  AddMemoryResponse,
  ContextExplainResponse,
  ContextResponse,
  ContextFeedbackRequest,
  ContextFeedbackResponse,
  CreateApiKeyResponse,
  CreateWorkspaceResponse,
  DeleteMemoryResponse,
  DeleteEvalItemResponse,
  DeleteEvalSetResponse,
  EvalRunResponse,
  ImportRequest,
  ImportResponse,
  IngestRequest,
  IngestResponse,
  GetMemoryResponse,
  HealthResponse,
  ListApiKeysResponse,
  ListEvalItemsResponse,
  ListEvalSetsResponse,
  SearchHistoryResponse,
  ListMemoriesResponse,
  ReplaySearchResponse,
  RevokeApiKeyResponse,
  SearchRequest,
  SearchResponse,
  UsageTodayResponse,
  AuditLogListResponse,
  CreateEvalSetResponse,
  CreateEvalItemResponse,
  ExplainAnswerRequest,
  ExplainAnswerResponse,
  PruningMetricsResponse,
} from "@memorynodeai/shared";
import type { MemoryType, SearchMode, RetrievalProfile } from "@memorynodeai/shared";

/** Re-export for consumers who want to type API errors without importing from @memorynodeai/shared. */
export type { ApiError } from "@memorynodeai/shared";

import { InternalRestTransport } from "./internal-rest.js";
import { MemoryNodeMcpTransport } from "./mcp-transport.js";

export { resolveMcpUrl, MemoryNodeMcpTransport } from "./mcp-transport.js";

const DEFAULT_TIMEOUT_MS = 60_000;
type OwnerType = "user" | "team" | "app";
type OwnerScopedSearchRequest = SearchRequest & {
  owner_id?: string;
  owner_type?: OwnerType;
  entity_id?: string;
  entity_type?: OwnerType;
};
type AddMemoryInput = Omit<AddMemoryRequest, "userId"> & {
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
};

type AddConversationMemoryInput = Omit<AddConversationMemoryRequest, "userId"> & {
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  entityId?: string;
  entityType?: OwnerType | "agent";
};

export interface MemoryNodeClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** Per-request timeout in ms (default 60s). Set to 0 to disable (not recommended in production). */
  timeoutMs?: number;
  /** Optional cancellation signal (combined with timeout when both apply). */
  signal?: AbortSignal;
  /** Retry attempts for retryable failures (default 2). */
  maxRetries?: number;
  /** Base backoff in ms for retries (default 200ms). */
  retryBaseMs?: number;
  /**
   * Transport strategy (Sprint 2 — docs/PLAN.md §7 S2).
   * - `mcp` — `search` uses hosted MCP Streamable HTTP (`search` tool) when possible.
   * - `rest` — legacy direct REST only (backward-compatible, default for deterministic tests).
   * - `hybrid` — MCP search for simple queries; REST when filters/explain/pagination require it or MCP fails.
   */
  transport?: "mcp" | "rest" | "hybrid";
}

// SDK-facing options (camelCase). Wire format stays snake_case per shared types.
export interface SearchOptions {
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  namespace?: string;
  query: string;
  topK?: number;
  page?: number;
  pageSize?: number;
  metadata?: Record<string, string | number | boolean>;
  startTime?: string;
  endTime?: string;
  /** Filter by memory type(s). Single value or array (OR semantics). */
  memoryType?: MemoryType | MemoryType[];
  /** Metadata match mode: "and" (default) or "or". */
  filterMode?: "and" | "or";
  /** Search strategy: "hybrid" (default), "vector", or "keyword". */
  searchMode?: SearchMode;
  /** Minimum relevance score (0–1). Results below are dropped. */
  minScore?: number;
  /** Include ranking explain payload in each search result. */
  explain?: boolean;
  retrievalProfile?: RetrievalProfile;
}

export interface ListMemoriesOptions {
  page?: number;
  pageSize?: number;
  namespace?: string;
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  /** Filter by memory type: fact, preference, event, note, or task. */
  memoryType?: MemoryType;
  metadata?: Record<string, string | number | boolean>;
  startTime?: string;
  endTime?: string;
}

export interface ReplaySearchOptions {
  queryId: string;
}

export interface CreateEvalSetOptions {
  name: string;
}

export interface CreateEvalItemOptions {
  evalSetId: string;
  query: string;
  expectedMemoryIds: string[];
}

export interface RunEvalSetOptions {
  evalSetId: string;
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  namespace?: string;
  topK?: number;
  searchMode?: SearchMode;
  minScore?: number;
}

export interface ContextFeedbackOptions extends ContextFeedbackRequest {}

export interface ContextExplainOptions {
  userId?: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  query: string;
  namespace?: string;
  topK?: number;
  page?: number;
  pageSize?: number;
  searchMode?: SearchMode;
  minScore?: number;
  retrievalProfile?: RetrievalProfile;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

export class MemoryNodeClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly outerSignal?: AbortSignal;
  private readonly transportMode: "mcp" | "rest" | "hybrid";
  private readonly rest: InternalRestTransport;
  private mcp?: MemoryNodeMcpTransport;

  constructor(options: MemoryNodeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey;
    this.outerSignal = options.signal;
    this.transportMode = options.transport ?? "hybrid";
    this.rest = new InternalRestTransport({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      outerSignal: options.signal,
      maxRetries: Math.max(0, Math.floor(options.maxRetries ?? 2)),
      retryBaseMs: Math.max(50, Math.floor(options.retryBaseMs ?? 200)),
    });
  }

  private async ensureMcp(): Promise<MemoryNodeMcpTransport> {
    if (!this.apiKey) {
      throw new MemoryNodeApiError("MISSING_API_KEY", "API key is required for MCP transport.", undefined);
    }
    if (!this.mcp) {
      this.mcp = new MemoryNodeMcpTransport({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        signal: this.outerSignal,
      });
    }
    await this.mcp.ensureConnected();
    return this.mcp;
  }

  private searchWireNeedsRestOnlyFeatures(wire: OwnerScopedSearchRequest): boolean {
    return Boolean(
      wire.filters ||
        wire.explain !== undefined ||
        wire.search_mode ||
        wire.min_score !== undefined ||
        wire.retrieval_profile ||
        wire.page !== undefined ||
        wire.page_size !== undefined,
    );
  }

  // -------- Admin helpers (require adminToken per call) --------
  async createWorkspace(name: string, adminToken: string): Promise<CreateWorkspaceResponse> {
    return this.request<CreateWorkspaceResponse>("/v1/workspaces", {
      method: "POST",
      body: { name },
      adminToken,
    });
  }

  async createApiKey(workspaceId: string, name: string, adminToken: string): Promise<CreateApiKeyResponse> {
    return this.request<CreateApiKeyResponse>("/v1/api-keys", {
      method: "POST",
      body: { workspace_id: workspaceId, name },
      adminToken,
    });
  }

  async listApiKeys(workspaceId: string, adminToken: string): Promise<ListApiKeysResponse> {
    const path = `/v1/api-keys?workspace_id=${encodeURIComponent(workspaceId)}`;
    return this.request<ListApiKeysResponse>(path, { method: "GET", adminToken });
  }

  async revokeApiKey(apiKeyId: string, adminToken: string): Promise<RevokeApiKeyResponse> {
    return this.request<RevokeApiKeyResponse>("/v1/api-keys/revoke", {
      method: "POST",
      body: { api_key_id: apiKeyId },
      adminToken,
    });
  }

  async getUsageToday(): Promise<UsageTodayResponse> {
    return this.request<UsageTodayResponse>("/v1/usage/today", { method: "GET" });
  }

  async listAuditLog(options?: { page?: number; limit?: number }): Promise<AuditLogListResponse> {
    const page = options?.page ?? 1;
    const limit = options?.limit ?? 50;
    const q = new URLSearchParams({ page: String(page), limit: String(limit) });
    return this.request<AuditLogListResponse>(`/v1/audit/log?${q.toString()}`, { method: "GET" });
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/healthz", { method: "GET" });
  }

  async addMemory(input: AddMemoryInput): Promise<AddMemoryResponse> {
    const { userId, ownerId, ownerType } = this.resolveOwnerIdentity(
      input.userId,
      input.ownerId,
      input.ownerType,
      input.entityId,
      input.entityType,
    );
    const body: Record<string, unknown> = {
      user_id: userId,
      owner_id: ownerId,
      owner_type: ownerType,
      entity_id: ownerId,
      entity_type: ownerType,
      namespace: input.namespace,
      text: input.text,
      metadata: input.metadata,
    };
    if (input.memory_type) body.memory_type = input.memory_type;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.chunk_profile) body.chunk_profile = input.chunk_profile;
    if (input.extract === true) body.extract = true;
    if (input.effective_at) body.effective_at = input.effective_at;
    if (input.replaces_memory_id) body.replaces_memory_id = input.replaces_memory_id;
    return this.request<AddMemoryResponse>("/v1/memories", { method: "POST", body });
  }

  async addConversationMemory(input: AddConversationMemoryInput): Promise<AddMemoryResponse> {
    const { userId, ownerId, ownerType } = this.resolveOwnerIdentity(
      input.userId,
      input.ownerId,
      input.ownerType,
      input.entityId,
      input.entityType,
    );
    const body: Record<string, unknown> = {
      user_id: userId,
      owner_id: ownerId,
      owner_type: ownerType,
      entity_id: ownerId,
      entity_type: ownerType,
      namespace: input.namespace,
      metadata: input.metadata,
    };
    if (input.messages && input.messages.length > 0) body.messages = input.messages;
    if (input.transcript?.trim()) body.transcript = input.transcript.trim();
    if (input.memory_type) body.memory_type = input.memory_type;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.chunk_profile) body.chunk_profile = input.chunk_profile;
    if (input.extract === true) body.extract = true;
    if (input.effective_at) body.effective_at = input.effective_at;
    if (input.replaces_memory_id) body.replaces_memory_id = input.replaces_memory_id;
    return this.request<AddMemoryResponse>("/v1/memories/conversation", { method: "POST", body });
  }

  async ingest(input: IngestRequest): Promise<IngestResponse> {
    return this.request<IngestResponse>("/v1/ingest", { method: "POST", body: input });
  }

  async search(input: SearchOptions): Promise<SearchResponse> {
    const wire = this.toWireSearch(input);
    const tryMcp =
      this.transportMode !== "rest" &&
      !this.searchWireNeedsRestOnlyFeatures(wire) &&
      this.apiKey !== undefined;

    if (tryMcp) {
      try {
        const mcp = await this.ensureMcp();
        return await mcp.searchTool({
          query: input.query,
          top_k: wire.top_k ?? input.topK ?? 10,
          containerTag: wire.namespace ?? input.namespace,
          includeProfile: true,
        });
      } catch (e) {
        if (this.transportMode === "mcp") throw e;
      }
    }

    return this.request<SearchResponse>("/v1/search", {
      method: "POST",
      body: wire,
    });
  }

  async listSearchHistory(limit = 20): Promise<SearchHistoryResponse> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 20;
    return this.request<SearchHistoryResponse>(`/v1/search/history?limit=${safeLimit}`, { method: "GET" });
  }

  async replaySearch(input: ReplaySearchOptions): Promise<ReplaySearchResponse> {
    return this.request<ReplaySearchResponse>("/v1/search/replay", {
      method: "POST",
      body: { query_id: input.queryId },
    });
  }

  async listEvalSets(): Promise<ListEvalSetsResponse> {
    return this.request<ListEvalSetsResponse>("/v1/evals/sets", { method: "GET" });
  }

  async createEvalSet(input: CreateEvalSetOptions): Promise<CreateEvalSetResponse> {
    return this.request<CreateEvalSetResponse>("/v1/evals/sets", {
      method: "POST",
      body: { name: input.name },
    });
  }

  async deleteEvalSet(evalSetId: string): Promise<DeleteEvalSetResponse> {
    return this.request<DeleteEvalSetResponse>(`/v1/evals/sets/${encodeURIComponent(evalSetId)}`, { method: "DELETE" });
  }

  async listEvalItems(evalSetId: string): Promise<ListEvalItemsResponse> {
    return this.request<ListEvalItemsResponse>(`/v1/evals/items?eval_set_id=${encodeURIComponent(evalSetId)}`, { method: "GET" });
  }

  async createEvalItem(input: CreateEvalItemOptions): Promise<CreateEvalItemResponse> {
    return this.request<CreateEvalItemResponse>("/v1/evals/items", {
      method: "POST",
      body: {
        eval_set_id: input.evalSetId,
        query: input.query,
        expected_memory_ids: input.expectedMemoryIds,
      },
    });
  }

  async deleteEvalItem(evalItemId: string): Promise<DeleteEvalItemResponse> {
    return this.request<DeleteEvalItemResponse>(`/v1/evals/items/${encodeURIComponent(evalItemId)}`, { method: "DELETE" });
  }

  async runEvalSet(input: RunEvalSetOptions): Promise<EvalRunResponse> {
    const { userId, ownerId, ownerType } = this.resolveOwnerIdentity(
      input.userId,
      input.ownerId,
      input.ownerType,
      input.entityId,
      input.entityType,
    );
    return this.request<EvalRunResponse>("/v1/evals/run", {
      method: "POST",
      body: {
        eval_set_id: input.evalSetId,
        user_id: userId,
        owner_id: ownerId,
        owner_type: ownerType,
        entity_id: ownerId,
        entity_type: ownerType,
        namespace: input.namespace,
        top_k: input.topK,
        search_mode: input.searchMode,
        min_score: input.minScore,
      },
    });
  }

  async sendContextFeedback(input: ContextFeedbackOptions): Promise<ContextFeedbackResponse> {
    return this.request<ContextFeedbackResponse>("/v1/context/feedback", {
      method: "POST",
      body: input,
    });
  }

  async getPruningMetrics(): Promise<PruningMetricsResponse> {
    return this.request<PruningMetricsResponse>("/v1/pruning/metrics", { method: "GET" });
  }

  async explainAnswer(input: ExplainAnswerRequest): Promise<ExplainAnswerResponse> {
    return this.request<ExplainAnswerResponse>("/v1/explain/answer", { method: "POST", body: input });
  }

  async context(input: SearchOptions): Promise<ContextResponse> {
    return this.request<ContextResponse>("/v1/context", {
      method: "POST",
      body: this.toWireSearch(input),
    });
  }

  async contextExplain(input: ContextExplainOptions): Promise<ContextExplainResponse> {
    const { userId, ownerId, ownerType } = this.resolveOwnerIdentity(
      input.userId,
      input.ownerId,
      input.ownerType,
      input.entityId,
      input.entityType,
    );
    const q = new URLSearchParams({
      user_id: userId,
      query: input.query,
    });
    q.set("owner_id", ownerId);
    q.set("owner_type", ownerType);
    q.set("entity_id", ownerId);
    q.set("entity_type", ownerType);
    if (input.namespace) q.set("namespace", input.namespace);
    if (input.topK !== undefined) q.set("top_k", String(input.topK));
    if (input.page !== undefined) q.set("page", String(input.page));
    if (input.pageSize !== undefined) q.set("page_size", String(input.pageSize));
    if (input.searchMode) q.set("search_mode", input.searchMode);
    if (input.minScore !== undefined) q.set("min_score", String(input.minScore));
    if (input.retrievalProfile) q.set("retrieval_profile", input.retrievalProfile);
    return this.request<ContextExplainResponse>(`/v1/context/explain?${q.toString()}`, { method: "GET" });
  }

  async listMemories(options: ListMemoriesOptions = {}): Promise<ListMemoriesResponse> {
    const url = new URL("/v1/memories", this.baseUrl);
    const page = options.page ?? 1;
    const pageSize = options.pageSize;
    url.searchParams.set("page", String(page));
    if (pageSize) url.searchParams.set("page_size", String(pageSize));
    if (options.namespace) url.searchParams.set("namespace", options.namespace);
    if (options.userId) url.searchParams.set("user_id", options.userId);
    const ownerId = options.ownerId ?? options.entityId;
    const ownerType = this.normalizeOwnerType(options.ownerType ?? options.entityType);
    if (ownerId) {
      url.searchParams.set("owner_id", ownerId);
      url.searchParams.set("entity_id", ownerId);
    }
    if (ownerType) {
      url.searchParams.set("owner_type", ownerType);
      url.searchParams.set("entity_type", ownerType);
    }
    if (options.memoryType) url.searchParams.set("memory_type", options.memoryType);
    if (options.startTime) url.searchParams.set("start_time", options.startTime);
    if (options.endTime) url.searchParams.set("end_time", options.endTime);
    if (options.metadata) url.searchParams.set("metadata", JSON.stringify(options.metadata));

    return this.request<ListMemoriesResponse>(url.pathname + url.search, { method: "GET" });
  }

  async getMemory(id: string): Promise<GetMemoryResponse> {
    return this.request<GetMemoryResponse>(`/v1/memories/${encodeURIComponent(id)}`, { method: "GET" });
  }

  async deleteMemory(id: string): Promise<DeleteMemoryResponse> {
    return this.request<DeleteMemoryResponse>(`/v1/memories/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async importMemories(artifactBase64: string, mode?: ImportRequest["mode"]): Promise<ImportResponse> {
    return this.request<ImportResponse>("/v1/import", {
      method: "POST",
      body: mode ? { artifact_base64: artifactBase64, mode } : { artifact_base64: artifactBase64 },
    });
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; adminToken?: string; signal?: AbortSignal },
  ): Promise<T> {
    return this.rest.request<T>(path, init);
  }

  private normalizeOwnerType(value: OwnerType | "agent" | undefined): OwnerType | undefined {
    if (!value) return undefined;
    return value === "agent" ? "app" : value;
  }

  private resolveOwnerIdentity(
    userId: string | undefined,
    ownerId: string | undefined,
    ownerType: OwnerType | undefined,
    entityId: string | undefined,
    entityType: OwnerType | "agent" | undefined,
  ): { userId: string; ownerId: string; ownerType: OwnerType } {
    const normalizedUserId = userId?.trim() ?? "";
    const normalizedOwnerId = ownerId?.trim() ?? "";
    const normalizedEntityId = entityId?.trim() ?? "";
    const ids = [normalizedUserId, normalizedOwnerId, normalizedEntityId].filter(Boolean);
    if (ids.length === 0) {
      throw new MemoryNodeApiError(
        "MISSING_OWNER_ID",
        "Provide userId, ownerId, or entityId for owner-scoped requests.",
        undefined,
      );
    }
    const resolvedId = ids[0] ?? "";
    if (ids.some((id) => id !== resolvedId)) {
      throw new MemoryNodeApiError(
        "INVALID_OWNER_ID",
        "userId, ownerId, and entityId must match when provided together.",
        undefined,
      );
    }
    const normalizedOwnerType = this.normalizeOwnerType(ownerType ?? entityType) ?? "user";
    return {
      userId: resolvedId,
      ownerId: resolvedId,
      ownerType: normalizedOwnerType,
    };
  }

  private toWireSearch(input: SearchOptions): OwnerScopedSearchRequest {
    const { userId, ownerId, ownerType } = this.resolveOwnerIdentity(
      input.userId,
      input.ownerId,
      input.ownerType,
      input.entityId,
      input.entityType,
    );
    const hasFilters =
      input.metadata ||
      input.startTime ||
      input.endTime ||
      input.memoryType !== undefined ||
      input.filterMode;
    return {
      user_id: userId,
      owner_id: ownerId,
      owner_type: ownerType,
      entity_id: ownerId,
      entity_type: ownerType,
      namespace: input.namespace,
      query: input.query,
      top_k: input.topK,
      page: input.page,
      page_size: input.pageSize,
      explain: input.explain,
      search_mode: input.searchMode,
      min_score: input.minScore,
      retrieval_profile: input.retrievalProfile,
      filters: hasFilters
        ? {
            metadata: input.metadata,
            start_time: input.startTime,
            end_time: input.endTime,
            memory_type: input.memoryType,
            filter_mode: input.filterMode,
          }
        : undefined,
    };
  }
}
