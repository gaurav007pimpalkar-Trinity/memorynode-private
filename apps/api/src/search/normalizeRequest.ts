/**
 * Search + list query normalization (shared by worker and tests).
 */

import { createHttpError } from "../http.js";
import { DEFAULT_TOPK, MAX_QUERY_CHARS, MAX_TOPK } from "../limits.js";
import { normalizeOwnerIdentity } from "../contracts/entity.js";
import { MEMORY_TYPES } from "../contracts/search.js";
import type { SearchPayload } from "../contracts/search.js";
import type { MemoryListParams } from "../handlers/memories.js";

export type MetadataFilter = Record<string, string | number | boolean>;

const DEFAULT_NAMESPACE = "default";
const MAX_PAGE_SIZE = 50;
const DEFAULT_LIST_PAGE_SIZE = 20;

export interface NormalizedSearchParams {
  user_id: string;
  owner_id: string;
  owner_type: "user" | "team" | "app";
  namespace: string;
  query: string;
  top_k: number;
  page: number;
  page_size: number;
  explain?: boolean;
  search_mode: "hybrid" | "vector" | "keyword";
  min_score?: number;
  retrieval_profile: "balanced" | "recall" | "precision";
  filters: {
    metadata?: MetadataFilter;
    start_time?: string;
    end_time?: string;
    memory_types?: string[];
    filter_mode: "and" | "or";
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseIsoTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(400, "BAD_REQUEST", "Invalid ISO timestamp for time filter");
  }
  return parsed.toISOString();
}

function cleanMetadataFilter(raw?: Record<string, unknown> | MetadataFilter): MetadataFilter | undefined {
  if (!raw) return undefined;
  const cleaned: MetadataFilter = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === null || typeof val === "undefined") continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      cleaned[key] = val;
    } else {
      throw createHttpError(400, "BAD_REQUEST", "Metadata filter values must be primitives");
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function normalizeSearchPayload(payload: SearchPayload): NormalizedSearchParams {
  let owner: ReturnType<typeof normalizeOwnerIdentity>;
  try {
    owner = normalizeOwnerIdentity(payload, "owner_id (or user_id/entity_id)");
  } catch (err) {
    throw createHttpError(400, "BAD_REQUEST", err instanceof Error ? err.message : String(err));
  }
  const user_id = owner.user_id;
  const query = payload.query;
  if (!query) throw createHttpError(400, "BAD_REQUEST", "query is required");
  if (query.length > MAX_QUERY_CHARS) {
    throw createHttpError(400, "BAD_REQUEST", `query exceeds ${MAX_QUERY_CHARS} chars`);
  }

  const namespace = (payload.namespace ?? DEFAULT_NAMESPACE).trim() || DEFAULT_NAMESPACE;
  const top_k = clamp(payload.top_k ?? DEFAULT_TOPK, 1, MAX_TOPK);
  const page = clamp(payload.page ?? 1, 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(payload.page_size ?? top_k, 1, MAX_PAGE_SIZE);

  const metadata = cleanMetadataFilter(payload.filters?.metadata);
  const start_time = parseIsoTimestamp(payload.filters?.start_time);
  const end_time = parseIsoTimestamp(payload.filters?.end_time);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  const rawMemoryType = payload.filters?.memory_type;
  const memory_types: string[] | undefined = rawMemoryType
    ? (Array.isArray(rawMemoryType) ? rawMemoryType : [rawMemoryType])
    : undefined;

  const filter_mode = payload.filters?.filter_mode ?? "and";
  const search_mode = payload.search_mode ?? "hybrid";
  const rawProfile = payload.retrieval_profile;
  const retrieval_profile: "balanced" | "recall" | "precision" =
    rawProfile === "recall" || rawProfile === "precision" || rawProfile === "balanced" ? rawProfile : "balanced";

  let min_score =
    payload.min_score != null && payload.min_score >= 0 && payload.min_score <= 1 ? payload.min_score : undefined;
  if (retrieval_profile === "recall") {
    if (min_score === undefined) min_score = 0.08;
    else min_score = Math.min(min_score, 0.2);
  } else if (retrieval_profile === "precision") {
    if (min_score === undefined) min_score = 0.32;
    else min_score = Math.max(min_score, 0.25);
  }

  return {
    user_id,
    owner_id: owner.owner_id,
    owner_type: owner.owner_type,
    query,
    namespace,
    top_k,
    page,
    page_size,
    explain: payload.explain === true,
    search_mode,
    min_score,
    retrieval_profile,
    filters: {
      metadata,
      start_time,
      end_time,
      memory_types,
      filter_mode,
    },
  };
}

export function normalizeMemoryListParams(url: URL): MemoryListParams {
  const page = clamp(Number(url.searchParams.get("page") ?? 1), 1, Number.MAX_SAFE_INTEGER);
  const page_size = clamp(
    Number(url.searchParams.get("page_size") ?? DEFAULT_LIST_PAGE_SIZE),
    1,
    MAX_PAGE_SIZE,
  );
  const namespace = url.searchParams.get("namespace") ?? undefined;
  const rawUserId = url.searchParams.get("user_id") ?? undefined;
  const rawOwnerId = url.searchParams.get("owner_id") ?? undefined;
  const rawEntityId = url.searchParams.get("entity_id") ?? undefined;
  const rawOwnerType = url.searchParams.get("owner_type") ?? undefined;
  const rawEntityType = url.searchParams.get("entity_type") ?? undefined;
  const user_id = rawUserId ?? rawOwnerId ?? rawEntityId;
  const candidateIds = [rawUserId, rawOwnerId, rawEntityId].filter((v): v is string => Boolean(v && v.trim()));
  const resolvedCandidateId = candidateIds[0] ?? "";
  if (candidateIds.some((id) => id !== resolvedCandidateId)) {
    throw createHttpError(400, "BAD_REQUEST", "user_id, owner_id, and entity_id must match when provided together");
  }
  let owner_type: "user" | "team" | "app" | undefined;
  const normalizedOwnerType = rawOwnerType?.trim().toLowerCase();
  const normalizedEntityType = rawEntityType?.trim().toLowerCase();
  const typeCandidate = normalizedOwnerType ?? normalizedEntityType;
  if (typeCandidate) {
    if (typeCandidate !== "user" && typeCandidate !== "team" && typeCandidate !== "app" && typeCandidate !== "agent") {
      throw createHttpError(400, "BAD_REQUEST", "owner_type must be one of: user, team, app");
    }
    owner_type = (typeCandidate === "agent" ? "app" : typeCandidate) as "user" | "team" | "app";
  }

  let metadata: MetadataFilter | undefined;
  const metadataRaw = url.searchParams.get("metadata");
  if (metadataRaw) {
    try {
      const parsed = JSON.parse(decodeURIComponent(metadataRaw)) as Record<string, unknown>;
      metadata = cleanMetadataFilter(parsed);
    } catch {
      throw createHttpError(400, "BAD_REQUEST", "metadata must be valid JSON object");
    }
  }

  const start_time = parseIsoTimestamp(url.searchParams.get("start_time") ?? undefined);
  const end_time = parseIsoTimestamp(url.searchParams.get("end_time") ?? undefined);
  if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
    throw createHttpError(400, "BAD_REQUEST", "start_time must be before or equal to end_time");
  }

  const memory_type = url.searchParams.get("memory_type")?.trim() || undefined;
  const allowedMemoryTypes = MEMORY_TYPES as readonly string[];
  if (memory_type && !allowedMemoryTypes.includes(memory_type)) {
    throw createHttpError(
      400,
      "BAD_REQUEST",
      `memory_type must be one of: ${MEMORY_TYPES.join(", ")}`,
    );
  }

  return {
    page,
    page_size,
    namespace: namespace || undefined,
    user_id: user_id || undefined,
    owner_id: user_id || undefined,
    owner_type,
    memory_type,
    filters: { metadata, start_time, end_time },
  };
}
