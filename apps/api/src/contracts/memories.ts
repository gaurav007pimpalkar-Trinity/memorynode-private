/**
 * Zod schemas for memory API — source of truth for POST /v1/memories.
 */

import { z } from "zod";
import { MAX_TEXT_CHARS } from "../limits.js";
import { MEMORY_TYPES } from "./search.js";
import { OwnerTypeInputSchema } from "./entity.js";

/** Chunking preset for POST /v1/memories (paragraph-aware splitter in worker). */
export const CHUNK_PROFILES = ["balanced", "dense", "document"] as const;
export type ChunkProfile = (typeof CHUNK_PROFILES)[number];

export function chunkParamsForProfile(profile: ChunkProfile | undefined): { chunkSize: number; overlap: number } {
  switch (profile) {
    case "dense":
      return { chunkSize: 400, overlap: 80 };
    case "document":
      return { chunkSize: 1200, overlap: 150 };
    default:
      return { chunkSize: 800, overlap: 100 };
  }
}

export const MemoryInsertSchema = z.object({
  user_id: z.string().min(1).optional(),
  owner_id: z.string().min(1).optional(),
  owner_type: OwnerTypeInputSchema.optional(),
  /** @deprecated use owner_id */
  entity_id: z.string().min(1).optional(),
  /** @deprecated use owner_type */
  entity_type: OwnerTypeInputSchema.optional(),
  namespace: z.string().optional(),
  text: z.string().min(1, "text is required").max(MAX_TEXT_CHARS, `text exceeds ${MAX_TEXT_CHARS} chars`),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** Optional retrieval ranking multiplier (default 1). Applied in vector/text match RPCs. */
  importance: z.number().min(0.01).max(100).optional(),
  /** Optional memory type tag for categorization. */
  memory_type: z.enum(MEMORY_TYPES).optional(),
  /** Chunking preset for long text before embedding (default balanced). */
  chunk_profile: z.enum(CHUNK_PROFILES).optional(),
  /**
   * When true (default), runs a lightweight LLM extraction to create child fact/preference memories.
   * Set to false to store only the parent memory without extraction.
   */
  extract: z.boolean().default(true),
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

export type MemoryInsertPayload = z.infer<typeof MemoryInsertSchema>;
