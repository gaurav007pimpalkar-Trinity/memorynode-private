/**
 * Zod schemas for memory API. Phase 5 (Option A). Source of truth for POST /v1/memories.
 */

import { z } from "zod";
import { MAX_TEXT_CHARS } from "../limits.js";
import { MEMORY_TYPES } from "./search.js";

export const MemoryInsertSchema = z.object({
  user_id: z.string().min(1, "user_id is required"),
  namespace: z.string().optional(),
  text: z.string().min(1, "text is required").max(MAX_TEXT_CHARS, `text exceeds ${MAX_TEXT_CHARS} chars`),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  /** Optional memory type tag for categorization. */
  memory_type: z.enum(MEMORY_TYPES).optional(),
  /** When true, runs a lightweight LLM extraction to create child fact/preference memories. */
  extract: z.boolean().optional(),
});

export type MemoryInsertPayload = z.infer<typeof MemoryInsertSchema>;
