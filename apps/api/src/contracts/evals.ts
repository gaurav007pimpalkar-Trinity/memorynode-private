import { z } from "zod";
import { MAX_QUERY_CHARS, MAX_TOPK } from "../limits.js";
import { SEARCH_MODES } from "./search.js";
import { OwnerTypeInputSchema } from "./entity.js";

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
  user_id: z.string().min(1).optional(),
  owner_id: z.string().min(1).optional(),
  owner_type: OwnerTypeInputSchema.optional(),
  /** @deprecated use owner_id */
  entity_id: z.string().min(1).optional(),
  /** @deprecated use owner_type */
  entity_type: OwnerTypeInputSchema.optional(),
  namespace: z.string().optional(),
  top_k: z.number().int().min(1).max(MAX_TOPK).optional(),
  search_mode: z.enum(SEARCH_MODES).optional(),
  min_score: z.number().min(0).max(1).optional(),
}).superRefine((value, ctx) => {
  const userId = value.user_id?.trim() ?? "";
  const ownerId = value.owner_id?.trim() ?? "";
  const entityId = value.entity_id?.trim() ?? "";
  const ids = [userId, ownerId, entityId].filter(Boolean);
  if (ids.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "user_id, owner_id, or entity_id is required",
      path: ["user_id"],
    });
  }
  const resolved = ids[0] ?? "";
  if (ids.some((id) => id !== resolved)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "user_id, owner_id, and entity_id must match when provided together",
      path: ["owner_id"],
    });
  }
}).transform((value) => {
  const resolvedId = (value.user_id?.trim() || value.owner_id?.trim() || value.entity_id?.trim()) as string;
  const ownerType = (value.owner_type ?? value.entity_type ?? "user") as "user" | "team" | "app";
  return {
    ...value,
    user_id: resolvedId,
    owner_id: resolvedId,
    owner_type: ownerType,
  };
});

export type EvalSetCreatePayload = z.infer<typeof EvalSetCreateSchema>;
export type EvalItemCreatePayload = z.infer<typeof EvalItemCreateSchema>;
export type EvalRunPayload = z.infer<typeof EvalRunSchema>;
