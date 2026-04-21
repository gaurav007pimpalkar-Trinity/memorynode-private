import type { InternalCreditsBreakdown } from "./plans.js";
import type { PiiHintKind } from "./piiHints.js";

export type WorkspaceId = string;
export type MemoryId = string;

export interface ApiError {
  code: string;
  message: string;
  status?: number;
}

export interface HealthResponse {
  status: "ok";
  version?: string;
  build_version?: string;
  stage?: string;
  git_sha?: string;
  embedding_model?: string;
}

/** Recognized memory type tags for categorization (includes task for actionable items). */
export type MemoryType = "fact" | "preference" | "event" | "note" | "task" | "correction" | "pin";

/** Search strategy selector. "hybrid" (default) uses vector+keyword fusion. */
export type SearchMode = "hybrid" | "vector" | "keyword";

/** Search ranking preset (adjusts default min_score thresholds server-side). */
export type RetrievalProfile = "balanced" | "recall" | "precision";

/** Ingest chunking preset (paragraph-aware splitter on the worker). */
export type ChunkProfile = "balanced" | "dense" | "document";
export type OwnerType = "user" | "team" | "app";

export interface AddMemoryRequest {
  userId: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  namespace?: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** Optional ranking multiplier for search (default 1). */
  importance?: number;
  /** Optional type tag for categorization. */
  memory_type?: MemoryType;
  /** Chunking preset for long text before embedding (default balanced). */
  chunk_profile?: ChunkProfile;
  /** When true, runs a lightweight LLM extraction to create child fact/preference memories. */
  extract?: boolean;
  /** ISO 8601: memory becomes retrievable at this time (default now). */
  effective_at?: string;
  /** Supersedes an existing memory (marks it duplicate_of the new row). */
  replaces_memory_id?: string;
  /** Optional ingest idempotency key for repeat-safe writes. */
  idempotency_key?: string;
}

export type ConversationRole = "user" | "assistant" | "system" | "tool";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  /** Optional timestamp label stored in the formatted transcript. */
  at?: string;
}

/** Body for POST /v1/memories/conversation — same outcome as POST /v1/memories after normalization. */
export interface AddConversationMemoryRequest {
  userId: string;
  ownerId?: string;
  ownerType?: OwnerType;
  /** @deprecated use ownerId */
  entityId?: string;
  /** @deprecated use ownerType */
  entityType?: OwnerType | "agent";
  namespace?: string;
  messages?: ConversationMessage[];
  transcript?: string;
  metadata?: Record<string, unknown>;
  memory_type?: MemoryType;
  importance?: number;
  chunk_profile?: ChunkProfile;
  extract?: boolean;
  effective_at?: string;
  replaces_memory_id?: string;
  idempotency_key?: string;
}

export type AddConversationMemoryResponse = AddMemoryResponse;

export interface AddMemoryResponse {
  memory_id: MemoryId;
  stored: true;
  /** Present when `replaces_memory_id` was sent on create. */
  superseded_memory_id?: MemoryId;
  chunks?: number;
  embedding?: "skipped_due_to_budget";
  extraction: {
    status: "run" | "degraded" | "skipped";
    reason?:
      | "user_disabled"
      | "low_importance"
      | "plan_limit"
      | "entitlement_degraded"
      | "budget_limit"
      | "extraction_error"
      | "none";
    error?: string;
  };
  /** Present when `x-safety-pii-scan: 1` was sent on the request and hints were found. */
  safety?: { pii_hints: PiiHintKind[] };
  /** Exact or near duplicate was detected and existing memory reused. */
  deduped?: boolean;
  /** Optional intelligence attributes for observability/debugging. */
  intelligence?: {
    canonical_hash?: string;
    confidence?: number;
    source_weight?: number;
    priority_score?: number;
    priority_tier?: "cold" | "warm" | "hot" | "critical";
    auto_pinned?: boolean;
    conflict_state?: "none" | "candidate" | "resolved" | "superseded";
  };
}

export interface SearchRequest {
  user_id: string;
  owner_id?: string;
  owner_type?: OwnerType;
  /** @deprecated use owner_id */
  entity_id?: string;
  /** @deprecated use owner_type */
  entity_type?: OwnerType;
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
  explain?: boolean;
  /** Search strategy: "hybrid" (default), "vector", or "keyword". */
  search_mode?: SearchMode;
  /** Minimum relevance score (0–1). Results below this threshold are dropped. This is a ranking-derived score, not a raw cosine similarity. */
  min_score?: number;
  retrieval_profile?: RetrievalProfile;
}

export interface SearchResult {
  chunk_id: string;
  memory_id: MemoryId;
  chunk_index: number;
  text: string;
  score: number;
  _explain?: {
    rrf_score: number;
    match_sources: Array<"vector" | "text">;
    vector_score?: number;
    text_score?: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  page?: number;
  page_size?: number;
  total?: number;
  has_more?: boolean;
  retrieval_trace?: Record<string, unknown>;
}

export interface SearchHistoryEntry {
  id: string;
  query: string;
  params: Record<string, unknown>;
  created_at: string;
  retrieval_trace?: Record<string, unknown> | null;
}

export interface SearchHistoryResponse {
  history: SearchHistoryEntry[];
}

export interface ReplaySearchResponse {
  query_id: string;
  previous: unknown;
  current: SearchResponse;
}

export interface EvalSet {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface EvalItem {
  id: string;
  eval_set_id: string;
  query: string;
  expected_memory_ids: string[];
  created_at: string;
}

export interface ListEvalSetsResponse {
  eval_sets: EvalSet[];
}

export interface CreateEvalSetResponse {
  eval_set: EvalSet;
}

export interface DeleteEvalSetResponse {
  deleted: boolean;
  id: string;
}

export interface ListEvalItemsResponse {
  eval_items: EvalItem[];
}

export interface CreateEvalItemResponse {
  eval_item: EvalItem;
}

export interface DeleteEvalItemResponse {
  deleted: boolean;
  id: string;
}

export interface EvalRunItemResult {
  eval_item_id: string;
  query: string;
  expected_memory_ids: string[];
  matched_expected_memory_ids: string[];
  precision_at_k: number;
  recall: number;
}

export interface EvalRunResponse {
  eval_set_id: string;
  item_count: number;
  avg_precision_at_k: number;
  avg_recall: number;
  items: EvalRunItemResult[];
}

export interface ContextFeedbackRequest {
  trace_id: string;
  query_id?: string;
  /** Optional eval set id for learning-loop correlation. */
  eval_set_id?: string;
  chunk_ids_used?: string[];
  chunk_ids_unused?: string[];
}

export interface ContextFeedbackResponse {
  accepted: boolean;
}

export interface ExplainAnswerRequest {
  question: string;
  context: string;
}

export interface ExplainAnswerResponse {
  answer: string;
}

export interface PruningMetricsResponse {
  memories_total: number;
  memories_marked_duplicate: number;
  memory_chunks_total: number;
}

export interface ContextProfileFact {
  memory_id: MemoryId;
  text: string;
  memory_type?: string | null;
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
  context_blocks?: number;
  /** Bounded profile facts (pinned, recent notes, preferences) when the worker supports it. */
  profile?: {
    pinned_facts: ContextProfileFact[];
    recent_notes: ContextProfileFact[];
    preferences: ContextProfileFact[];
  };
  /** One-hop linked memories from top context hits (strict caps on the worker). */
  linked_memories?: Array<{
    memory_id: MemoryId;
    text: string;
    link_type: string;
    from_memory_id: MemoryId;
  }>;
}

export interface ContextExplainResult {
  rank: number;
  memory_id: MemoryId;
  chunk_id: string;
  chunk_index: number;
  text: string;
  scores: {
    relevance_score: number;
    recency_score: number;
    importance_score: number;
    final_score: number;
  };
  ordering_explanation: string;
}

export interface ContextExplainResponse {
  query: {
    user_id: string;
    owner_id?: string;
    owner_type?: OwnerType;
    entity_id?: string;
    entity_type?: OwnerType;
    namespace: string | null;
    query: string;
    top_k: number | null;
    search_mode: SearchMode;
    min_score: number | null;
    retrieval_profile: RetrievalProfile | null;
  };
  memories_retrieved: Array<{ memory_id: MemoryId; text: string }>;
  chunk_ids_used: string[];
  results: ContextExplainResult[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

// Memory listing / CRUD
export interface MemoryRecord {
  id: MemoryId;
  user_id: string;
  owner_id?: string;
  owner_type?: OwnerType;
  namespace: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
  memory_type?: MemoryType | null;
  source_memory_id?: MemoryId | null;
  importance?: number;
  retrieval_count?: number;
  confidence?: number;
  source_weight?: number;
  priority_score?: number;
  priority_tier?: "cold" | "warm" | "hot" | "critical";
  pinned_auto?: boolean;
  conflict_state?: "none" | "candidate" | "resolved" | "superseded";
  last_conflict_at?: string | null;
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

export type IngestKind = "memory" | "conversation" | "document" | "bundle";

/** Wire shape for POST /v1/ingest (discriminated by `kind`). */
export type IngestRequest =
  | { kind: "memory"; body: AddMemoryRequest }
  | { kind: "conversation"; body: AddConversationMemoryRequest }
  | { kind: "document"; body: AddMemoryRequest }
  | { kind: "bundle"; body: ImportRequest };

export type IngestResponse = AddMemoryResponse | ImportResponse;

export interface AuditLogEntry {
  id: string;
  route: string;
  method: string;
  status: number;
  bytes_in: number;
  bytes_out: number;
  latency_ms: number;
  ip_hash: string;
  api_key_id: string | null;
  created_at: string;
}

export interface AuditLogListResponse {
  entries: AuditLogEntry[];
  page: number;
  limit: number;
  has_more: boolean;
}

export interface UsageTodayResponse {
  day: string;
  writes: number;
  reads: number;
  embeds: number;
  extraction_calls?: number;
  embed_tokens?: number;
  gen_tokens?: number;
  storage_bytes?: number;
  limits: {
    writes: number;
    reads: number;
    embeds: number;
  };
  limits_v3?: {
    included_writes: number;
    included_reads: number;
    included_embed_tokens: number;
    included_gen_tokens: number;
    included_storage_gb: number;
  };
  internal_credits?: {
    model: "v1";
    used_total: number;
    used_breakdown: InternalCreditsBreakdown;
    included_total: number;
    included_breakdown: InternalCreditsBreakdown;
  };
  semantics?: "dual_hard";
  period?: {
    start: string | null;
    end: string | null;
    daily_cap: "hard";
    monthly_cap: "hard";
  };
  /** Non-empty when any daily counter is near or over its cap (polling surface for UI / automation). */
  cap_alerts?: import("./capAlerts.js").UsageCapAlert[];
  /** Derived posture: sleep = core caps critical; degraded = warnings or entitlement read degradation. */
  operational_mode?: import("./capAlerts.js").OperationalMode;
  /** True when entitlement row is `grace`: paid plan label kept, daily caps floored toward Launch. */
  grace_soft_downgrade?: boolean;
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

export type { ProductPlanId } from "./productPlan.js";
export { productPlanFromWorkspacePlan } from "./productPlan.js";

// Plans & limits (single source of truth)
export type {
  PlanId,
  Plan,
  PlanLimits,
  UsageCaps,
  InternalCreditsInput,
  InternalCreditsBreakdown,
} from "./plans.js";
export {
  PLANS_BY_ID,
  CHECKOUT_PLAN_IDS,
  RATE_LIMIT_RPM_DEFAULT,
  RATE_LIMIT_RPM_NEW_KEY,
  TOKENS_PER_EMBED_ASSUMED,
  INTERNAL_CREDIT_WEIGHTS,
  getPlan,
  getDefaultCaps,
  getLimitsForPlanCode,
  embedsCapFromEmbedTokens,
  getUsageCapsForPlanCode,
  minUsageCaps,
  applyLaunchFloorToPlanLimits,
  getWorkspaceRpmForPlanCode,
  computeInternalCredits,
  computePlanIncludedInternalCredits,
} from "./plans.js";

export type {
  CostModelInput,
  CostModelOptions,
  CreditsBreakdown,
} from "./costModel.js";

export {
  COST_MODEL_VERSION,
  COST_MODEL_CONSTANTS,
  CREDIT_WEIGHTS,
  computeCredits,
  estimateCostInr,
} from "./costModel.js";

export type { UsageCapAlert, UsageCapAlertResource, UsageCapAlertSeverity, OperationalMode } from "./capAlerts.js";
export { computeUsageCapAlerts, computeOperationalMode } from "./capAlerts.js";

export type { PiiHintKind } from "./piiHints.js";
export { detectPiiHints } from "./piiHints.js";

export type {
  McpActionId,
  PolicyDecisionStatus,
  McpErrorCode,
  PolicyScope,
  PolicyInput,
  CostBudget,
  CostEstimate,
  PolicyHooks,
  PolicyMetricsSnapshot,
  PolicyDecision,
  PolicyDeniedError,
} from "./mcpPolicy.js";
export { MCP_POLICY_VERSION, McpPolicyEngine, policyDeniedError, estimateCost } from "./mcpPolicy.js";
export type { DeprecationPhase, AliasDecision } from "./mcpAliasDeprecation.js";
export { normalizeDeprecationPhase, resolveAliasDecision } from "./mcpAliasDeprecation.js";
export type { RecallStrength } from "./mcpContextSignals.js";
export { deriveContextSignals } from "./mcpContextSignals.js";
export type { AttackType, AttackFailure, AttackSimulationConfig, AttackSimulationReport } from "./mcpAttackSimulator.js";
export { runAttackSimulation } from "./mcpAttackSimulator.js";

export { trialExpiredBlocksWrites } from "./trialAccess.js";
