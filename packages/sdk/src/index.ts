import type {
  AddMemoryRequest,
  AddMemoryResponse,
  ApiError,
  ContextResponse,
  CreateApiKeyResponse,
  CreateWorkspaceResponse,
  DeleteMemoryResponse,
  ImportRequest,
  ImportResponse,
  GetMemoryResponse,
  HealthResponse,
  ListApiKeysResponse,
  ListMemoriesResponse,
  RevokeApiKeyResponse,
  SearchRequest,
  SearchResponse,
  UsageTodayResponse,
} from "@memorynodeai/shared";
import type { MemoryType, SearchMode } from "@memorynodeai/shared";

/** Re-export for consumers who want to type API errors without importing from @memorynodeai/shared. */
export type { ApiError };

export interface MemoryNodeClientOptions {
  baseUrl?: string;
  apiKey?: string;
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
}

export interface ListMemoriesOptions {
  page?: number;
  pageSize?: number;
  namespace?: string;
  userId?: string;
  /** Filter by memory type: fact, preference, event, or note. */
  memoryType?: MemoryType;
  metadata?: Record<string, string | number | boolean>;
  startTime?: string;
  endTime?: string;
}

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

  constructor(options: MemoryNodeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.apiKey = options.apiKey;
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
    if (input.extract === true) body.extract = true;
    return this.request<AddMemoryResponse>("/v1/memories", { method: "POST", body });
  }

  async search(input: SearchOptions): Promise<SearchResponse> {
    return this.request<SearchResponse>("/v1/search", {
      method: "POST",
      body: this.toWireSearch(input),
    });
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

  private async request<T>(path: string, init: { method: string; body?: unknown; adminToken?: string }): Promise<T> {
    const isPublicHealth = path === "/healthz" || path.startsWith("/healthz?");
    if (!init.adminToken && this.apiKey === undefined && !isPublicHealth) {
      throw new MemoryNodeApiError("MISSING_API_KEY", "API key is required for this request. Pass apiKey in constructor or use adminToken for admin endpoints.", undefined);
    }

    const response = await fetch(new URL(path, this.baseUrl).toString(), {
      method: init.method,
      headers: this.buildHeaders(init.adminToken),
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) {
      throw await this.toApiError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
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
