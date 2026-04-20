/**
 * POST /v1/webhooks/memory — workspace_id + same fields as POST /v1/memories (HMAC verified separately).
 */

import { z } from "zod";
import { MemoryInsertSchema } from "./memories.js";

export const MemoryWebhookIngestSchema = MemoryInsertSchema.and(
  z.object({
    workspace_id: z.string().uuid(),
  }),
);

export type MemoryWebhookIngestPayload = z.infer<typeof MemoryWebhookIngestSchema>;
