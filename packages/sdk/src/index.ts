import type {
  AddMemoryRequest,
  AddMemoryResponse,
  ApiError,
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
export type { ApiError };

const DEFAULT_TIMEOUT_MS = 60_000;

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
}

// SDK-facing options (camelCase). Wire format stays snake_case per shared types.
export interface SearchOptions {
  userId: string;
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
  retrievalProfile?: RetrievalProfile;
}

export interface ListMemoriesOptions {
  page?: number;
  pageSize?: number;
  namespace?: string;
  userId?: string;
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
  userId: string;
  namespace?: string;
  topK?: number;
  searchMode?: SearchMode;
  minScore?: number;
}

export interface ContextFeedbackOptions extends ContextFeedbackRequest {}

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";

/** Thrown when the API returns an error or when the client is misconfigured (e.g. missing API key). */
export class MemoryNodeApiError extends Error implements ApiError {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "MemoryNodeApiError";
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, MemoryNodeApiError.prototype);
  }
}

export class MemoryNodeClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly outerSignal?: AbortSignal;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: MemoryNodeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.outerSignal = options.signal;
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.retryBaseMs = Math.max(50, Math.floor(options.retryBaseMs ?? 200));
  }

  /** Combines timeout, constructor signal, and per-call override (Node 20+ / modern runtimes). */
  private composeFetchSignal(override?: AbortSignal): AbortSignal | undefined {
    const parts: AbortSignal[] = [];
    if (this.timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      parts.push(AbortSignal.timeout(this.timeoutMs));
    }
    if (this.outerSignal) parts.push(this.outerSignal);
    if (override) parts.push(override);
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    if (typeof AbortSignal.any === "function") return AbortSignal.any(parts);
    return parts[0];
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const jitter = Math.floor(Math.random() * 50);
    const delay = this.retryBaseMs * Math.pow(2, attempt) + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private isRetryableRequest(method: string, path: string): boolean {
    const m = method.toUpperCase();
    if (m === "GET" || m === "DELETE") return true;
    if (m !== "POST") return false;
    return path === "/v1/search" ||
      path === "/v1/context" ||
      path === "/v1/evals/run" ||
      path === "/v1/context/feedback" ||
      path === "/v1/explain/answer" ||
      path.startsWith("/v1/search?");
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

  async addMemory(input: AddMemoryRequest): Promise<AddMemoryResponse> {
    const body: Record<string, unknown> = {
      user_id: input.userId,
      namespace: input.namespace,
      text: input.text,
      metadata: input.metadata,
    };
    if (input.memory_type) body.memory_type = input.memory_type;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.chunk_profile) body.chunk_profile = input.chunk_profile;
    if (input.extract === true) body.extract = true;
    return this.request<AddMemoryResponse>("/v1/memories", { method: "POST", body });
  }

  async search(input: SearchOptions): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", {
      method: "POST",
      body: this.toWireSearch(input),
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
    return this.request<EvalRunResponse>("/v1/evals/run", {
      method: "POST",
      body: {
        eval_set_id: input.evalSetId,
        user_id: input.userId,
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

  async listMemories(options: ListMemoriesOptions = {}): Promise<ListMemoriesResponse> {
    const url = new URL("/v1/memories", this.baseUrl);
    const page = options.page ?? 1;
    const pageSize = options.pageSize;
    url.searchParams.set("page", String(page));
    if (pageSize) url.searchParams.set("page_size", String(pageSize));
    if (options.namespace) url.searchParams.set("namespace", options.namespace);
    if (options.userId) url.searchParams.set("user_id", options.userId);
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

  private buildHeaders(adminToken?: string): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (adminToken) {
      headers["x-admin-token"] = adminToken;
    } else if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async request<T>(
    path: string,
    init: { method: string; body?: unknown; adminToken?: string; signal?: AbortSignal },
  ): Promise<T> {
    const isPublicHealth = path === "/healthz" || path.startsWith("/healthz?");
    if (!init.adminToken && this.apiKey === undefined && !isPublicHealth) {
      throw new MemoryNodeApiError("MISSING_API_KEY", "API key is required for this request. Pass apiKey in constructor or use adminToken for admin endpoints.", undefined);
    }

    const retryable = this.isRetryableRequest(init.method, path);
    const maxAttempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: MemoryNodeApiError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(new URL(path, this.baseUrl).toString(), {
          method: init.method,
          headers: this.buildHeaders(init.adminToken),
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: this.composeFetchSignal(init.signal),
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e?.name === "AbortError") {
          throw new MemoryNodeApiError("REQUEST_ABORTED", e.message || "Request aborted", undefined);
        }
        lastError = new MemoryNodeApiError("NETWORK_ERROR", e?.message || "Network request failed", undefined);
        if (attempt < maxAttempts - 1) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const apiErr = await this.toApiError(response);
        lastError = apiErr;
        if (attempt < maxAttempts - 1 && this.isRetryableStatus(response.status)) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw apiErr;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }
    throw lastError ?? new MemoryNodeApiError("HTTP_ERROR", "Request failed", undefined);
  }

  private async toApiError(response: Response): Promise<MemoryNodeApiError> {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // non-JSON or empty body
    }

    const err = body?.error;
    const code = typeof err?.code === "string" ? err.code : "HTTP_ERROR";
    const message = typeof err?.message === "string" ? err.message : response.statusText;
    const status = response.status;

    return new MemoryNodeApiError(code, message, status);
  }

  private toWireSearch(input: SearchOptions): SearchRequest {
    const hasFilters =
      input.metadata ||
      input.startTime ||
      input.endTime ||
      input.memoryType !== undefined ||
      input.filterMode;
    return {
      user_id: input.userId,
      namespace: input.namespace,
      query: input.query,
      top_k: input.topK,
      page: input.page,
      page_size: input.pageSize,
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
