/**
 * Zod schemas for search/context API. Phase 5 (Option A). Source of truth for POST /v1/search and POST /v1/context.
 */

import { z } from "zod";
import { MAX_QUERY_CHARS, MAX_TOPK } from "../limits.js";

export const MEMORY_TYPES = ["fact", "preference", "event", "note"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SEARCH_MODES = ["hybrid", "vector", "keyword"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const memoryTypeEnum = z.enum(MEMORY_TYPES);

const metadataValue = z.union([z.string(), z.number(), z.boolean()]);
const filtersSchema = z
  .object({
    metadata: z.record(z.string(), metadataValue).optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    /** Filter by memory type(s). Single value or array (OR semantics). */
    memory_type: z.union([memoryTypeEnum, z.array(memoryTypeEnum).min(1)]).optional(),
    /** Metadata match mode: "and" requires all pairs to match, "or" requires any. Default "and". */
    filter_mode: z.enum(["and", "or"]).optional(),
  })
  .optional();

export const SearchPayloadSchema = z.object({
  user_id: z.string().min(1, "user_id is required"),
  namespace: z.string().optional(),
  query: z.string().min(1, "query is required").max(MAX_QUERY_CHARS, `query exceeds ${MAX_QUERY_CHARS} chars`),
  top_k: z.number().int().min(1).max(MAX_TOPK).optional(),
  page: z.number().int().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  filters: filtersSchema,
  explain: z.boolean().optional(),
  /** Search strategy: "hybrid" (default) uses vector+keyword fusion, "vector" is semantic only, "keyword" is text-match only. */
  search_mode: z.enum(SEARCH_MODES).optional(),
  /** Minimum relevance score (0–1). Results below this threshold are dropped. This is a ranking-derived score, not a raw cosine similarity. */
  min_score: z.number().min(0).max(1).optional(),
});

export type SearchPayload = z.infer<typeof SearchPayloadSchema>;
