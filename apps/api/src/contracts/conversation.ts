/**
 * POST /v1/memories/conversation — transcript or structured messages → same storage as POST /v1/memories.
 */

import { z } from "zod";
import { MAX_TEXT_CHARS } from "../limits.js";
import { MEMORY_TYPES } from "./search.js";
import { CHUNK_PROFILES } from "./memories.js";
import { OwnerTypeInputSchema } from "./entity.js";

const CONVERSATION_ROLES = ["user", "assistant", "system", "tool"] as const;

const ConversationMessageSchema = z.object({
  role: z.enum(CONVERSATION_ROLES),
  content: z.string().min(1).max(24_000),
  at: z.string().optional(),
});

export const ConversationInsertSchema = z
  .object({
    userId: z.string().min(1).optional(),
    user_id: z.string().min(1).optional(),
    owner_id: z.string().min(1).optional(),
    owner_type: OwnerTypeInputSchema.optional(),
    entity_id: z.string().min(1).optional(),
    entity_type: OwnerTypeInputSchema.optional(),
    scope: z.string().optional(),
    namespace: z.string().optional(),
    containerTag: z.string().optional(),
    messages: z.array(ConversationMessageSchema).max(200).optional(),
    transcript: z.string().max(MAX_TEXT_CHARS).optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    memory_type: z.enum(MEMORY_TYPES).optional(),
    importance: z.number().min(0.01).max(100).optional(),
    chunk_profile: z.enum(CHUNK_PROFILES).optional(),
    extract: z.boolean().default(true),
    effective_at: z.string().optional(),
    replaces_memory_id: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const hasTranscript = Boolean(value.transcript?.trim());
    const hasMessages = Array.isArray(value.messages) && value.messages.length > 0;
    if (!hasTranscript && !hasMessages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide non-empty transcript or at least one message",
        path: ["messages"],
      });
    }
    const userId = value.userId?.trim() ?? value.user_id?.trim() ?? "";
    const ownerId = value.owner_id?.trim() ?? "";
    const entityId = value.entity_id?.trim() ?? "";
    const ids = [userId, ownerId, entityId].filter(Boolean);
    const resolved = ids[0] ?? "";
    if (ids.some((id) => id !== resolved)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "user_id, owner_id, and entity_id must match when provided together",
        path: ["owner_id"],
      });
    }
    if (value.effective_at?.trim()) {
      const t = Date.parse(value.effective_at.trim());
      if (!Number.isFinite(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "effective_at must be a valid ISO 8601 datetime",
          path: ["effective_at"],
        });
      }
    }
  })
  .transform((value) => {
    const resolvedId = (
      value.userId?.trim() ||
      value.user_id?.trim() ||
      value.owner_id?.trim() ||
      value.entity_id?.trim() ||
      "shared_app"
    ) as string;
    const ownerType = (value.owner_type ?? value.entity_type ?? "user") as "user" | "team" | "app";
    const transcript = value.transcript?.trim() ?? "";
    const lines: string[] = [];
    if (value.messages && value.messages.length > 0) {
      for (const m of value.messages) {
        const stamp = m.at ? `[${m.at}] ` : "";
        lines.push(`${stamp}${m.role}: ${m.content}`);
      }
    }
    const fromMessages = lines.join("\n\n");
    const text = transcript || fromMessages;
    return {
      ...value,
      user_id: resolvedId,
      owner_id: resolvedId,
      owner_type: ownerType,
      namespace: value.containerTag?.trim() || value.namespace?.trim() || value.scope?.trim() || "default",
      text,
    };
  });

export type ConversationInsertPayload = z.infer<typeof ConversationInsertSchema>;

export function formatConversationForStorage(payload: ConversationInsertPayload): string {
  return payload.text;
}
