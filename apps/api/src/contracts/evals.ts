import { z } from "zod";
import { MAX_QUERY_CHARS, MAX_TOPK } from "../limits.js";
import { SEARCH_MODES } from "./search.js";

export const EvalSetCreateSchema = z.object({
  name: z.string().min(1, "name is required").max(120, "name must be <= 120 chars"),
});

export const EvalItemCreateSchema = z.object({
  eval_set_id: z.string().uuid("eval_set_id must be a UUID"),
  query: z.string().min(1, "query is required").max(MAX_QUERY_CHARS, `query exceeds ${MAX_QUERY_CHARS} chars`),
  expected_memory_ids: z.array(z.string().uuid("expected_memory_ids must contain UUIDs")).default([]),
});

export const EvalRunSchema = z.object({
  eval_set_id: z.string().uuid("eval_set_id must be a UUID"),
  user_id: z.string().min(1, "user_id is required"),
  namespace: z.string().optional(),
  top_k: z.number().int().min(1).max(MAX_TOPK).optional(),
  search_mode: z.enum(SEARCH_MODES).optional(),
  min_score: z.number().min(0).max(1).optional(),
});

export type EvalSetCreatePayload = z.infer<typeof EvalSetCreateSchema>;
export type EvalItemCreatePayload = z.infer<typeof EvalItemCreateSchema>;
export type EvalRunPayload = z.infer<typeof EvalRunSchema>;
