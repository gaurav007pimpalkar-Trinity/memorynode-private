/**
 * Typed edges between memories (POST/DELETE /v1/memories/:id/links).
 */

import { z } from "zod";

export const MEMORY_LINK_TYPES = ["related_to", "about_ticket", "same_topic"] as const;
export type MemoryLinkType = (typeof MEMORY_LINK_TYPES)[number];

export const MemoryLinkCreateSchema = z.object({
  to_memory_id: z.string().uuid(),
  link_type: z.enum(MEMORY_LINK_TYPES),
});

export type MemoryLinkCreatePayload = z.infer<typeof MemoryLinkCreateSchema>;
