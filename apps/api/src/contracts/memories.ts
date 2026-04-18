/**
 * Zod schemas for memory API. Phase 5 (Option A). Source of truth for POST /v1/memories.
 */

import { z } from "zod";
import { MAX_TEXT_CHARS } from "../limits.js";
import { MEMORY_TYPES } from "./search.js";

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
  user_id: z.string().min(1, "user_id is required"),
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
});

export type MemoryInsertPayload = z.infer<typeof MemoryInsertSchema>;
