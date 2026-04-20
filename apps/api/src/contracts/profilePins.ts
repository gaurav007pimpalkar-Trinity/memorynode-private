/**
 * PATCH /v1/profile/pins — replace pinned set (metadata.pinned) for a scoped user/namespace (max 10 memory IDs).
 */

import { z } from "zod";
import { OwnerTypeInputSchema } from "./entity.js";

export const ProfilePinsPatchSchema = z
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
    memory_ids: z.array(z.string().uuid()).max(10),
  })
  .superRefine((value, ctx) => {
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
    return {
      ...value,
      userId: resolvedId,
      user_id: resolvedId,
      owner_id: resolvedId,
      owner_type: ownerType,
      namespace: value.containerTag?.trim() || value.namespace?.trim() || value.scope?.trim() || "default",
    };
  });

export type ProfilePinsPatchPayload = z.infer<typeof ProfilePinsPatchSchema>;
