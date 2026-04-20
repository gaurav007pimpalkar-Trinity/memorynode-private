/**
 * POST /v1/ingest — single entry point dispatching to memory, conversation, document-as-text, or ZIP import.
 */

import { z } from "zod";
import { MemoryInsertSchema } from "./memories.js";
import { ConversationInsertSchema } from "./conversation.js";
import { ImportPayloadSchema } from "./import.js";

export const IngestPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), body: MemoryInsertSchema }),
  z.object({ kind: z.literal("conversation"), body: ConversationInsertSchema }),
  z.object({ kind: z.literal("document"), body: MemoryInsertSchema }),
  z.object({ kind: z.literal("bundle"), body: ImportPayloadSchema }),
]);

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
