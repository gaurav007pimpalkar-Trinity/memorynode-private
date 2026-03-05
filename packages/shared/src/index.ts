export type WorkspaceId = string;
export type MemoryId = string;

export interface ApiError {
  code: string;
  message: string;
  status?: number;
}

export interface HealthResponse {
  status: "ok";
}

/** Recognized memory type tags for categorization. */
export type MemoryType = "fact" | "preference" | "event" | "note";

/** Search strategy selector. "hybrid" (default) uses vector+keyword fusion. */
export type SearchMode = "hybrid" | "vector" | "keyword";

export interface AddMemoryRequest {
  userId: string;
  namespace?: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** Optional type tag for categorization. */
  memory_type?: MemoryType;
  /** When true, runs a lightweight LLM extraction to create child fact/preference memories. */
  extract?: boolean;
}

export interface AddMemoryResponse {
  memory_id: MemoryId;
  chunks: number;
}

export interface SearchRequest {
  user_id: string;
  namespace?: string;
  query: string;
  top_k?: number;
  page?: number;
  page_size?: number;
  filters?: {
    metadata?: Record<string, string | number | boolean>;
    start_time?: string;
    end_time?: string;
    /** Filter by memory type(s). Single value or array (OR semantics). */
    memory_type?: MemoryType | MemoryType[];
    /** Metadata match mode: "and" (default) requires all pairs, "or" requires any. */
    filter_mode?: "and" | "or";
  };
  /** Search strategy: "hybrid" (default), "vector", or "keyword". */
  search_mode?: SearchMode;
  /** Minimum relevance score (0–1). Results below this threshold are dropped. This is a ranking-derived score, not a raw cosine similarity. */
  min_score?: number;
}

export interface SearchResult {
  chunk_id: string;
  memory_id: MemoryId;
  chunk_index: number;
  text: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  page?: number;
  page_size?: number;
  total?: number;
  has_more?: boolean;
}

export interface ContextResponse {
  context_text: string;
  citations: Array<{
    i: number;
    chunk_id: string;
    memory_id: MemoryId;
    chunk_index: number;
  }>;
  page?: number;
  page_size?: number;
  total?: number;
  has_more?: boolean;
}

// Memory listing / CRUD
export interface MemoryRecord {
  id: MemoryId;
  user_id: string;
  namespace: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
  memory_type?: MemoryType | null;
  source_memory_id?: MemoryId | null;
}

export interface ListMemoriesResponse {
  results: MemoryRecord[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
}

export interface GetMemoryResponse extends MemoryRecord {}

export interface DeleteMemoryResponse {
  deleted: boolean;
  id: MemoryId;
}

export interface ExportResponse {
  artifact_base64: string;
  bytes: number;
  sha256: string;
}

export interface ImportRequest {
  artifact_base64: string;
  mode?: "upsert" | "skip_existing" | "error_on_conflict" | "replace_ids" | "replace_all";
}

export interface ImportResponse {
  imported_memories: number;
  imported_chunks: number;
}

export interface UsageTodayResponse {
  day: string;
  writes: number;
  reads: number;
  embeds: number;
  limits: {
    writes: number;
    reads: number;
    embeds: number;
  };
}

export interface CreateWorkspaceResponse {
  workspace_id: WorkspaceId;
  name: string;
}

export interface CreateApiKeyResponse {
  api_key: string;
  api_key_id: string;
  workspace_id: WorkspaceId;
  name: string;
}

export interface ListApiKeysResponse {
  api_keys: Array<{
    id: string;
    workspace_id: WorkspaceId;
    name: string;
    created_at: string;
    revoked_at: string | null;
  }>;
}

export interface RevokeApiKeyResponse {
  revoked: boolean;
}

// Plans & limits (single source of truth)
export type { PlanId, Plan, PlanLimits, UsageCaps } from "./plans.js";
export {
  PLANS_BY_ID,
  CHECKOUT_PLAN_IDS,
  RATE_LIMIT_RPM_DEFAULT,
  RATE_LIMIT_RPM_NEW_KEY,
  TOKENS_PER_EMBED_ASSUMED,
  getPlan,
  getFreeCaps,
  getLimitsForPlanCode,
  embedsCapFromEmbedTokens,
  getUsageCapsForPlanCode,
  getWorkspaceRpmForPlanCode,
} from "./plans.js";
