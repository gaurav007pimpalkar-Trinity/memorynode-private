import { z } from "zod";

export const OWNER_TYPES = ["user", "team", "app"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];
export const OwnerTypeSchema = z.enum(OWNER_TYPES);
export const OwnerTypeInputSchema = z.enum(["user", "team", "app", "agent"]).transform((value) =>
  value === "agent" ? "app" : value
);
export const ENTITY_TYPES = OWNER_TYPES;
export type EntityType = OwnerType;
export const EntityTypeSchema = OwnerTypeSchema;

export type OwnerIdentityInput = {
  user_id?: string;
  owner_id?: string;
  owner_type?: OwnerType | "agent";
  entity_id?: string;
  entity_type?: EntityType | "agent";
};

export type OwnerIdentity = {
  user_id: string;
  owner_id: string;
  owner_type: OwnerType;
  entity_id: string;
  entity_type: EntityType;
};

export function normalizeOwnerIdentity(
  input: OwnerIdentityInput,
  fieldName = "user_id, owner_id, or entity_id",
): OwnerIdentity {
  const userId = typeof input.user_id === "string" ? input.user_id.trim() : "";
  const ownerId = typeof input.owner_id === "string" ? input.owner_id.trim() : "";
  const entityId = typeof input.entity_id === "string" ? input.entity_id.trim() : "";
  const normalizedOwnerType = input.owner_type && input.owner_type === "agent" ? "app" : input.owner_type;
  const normalizedEntityType = input.entity_type && input.entity_type === "agent" ? "app" : input.entity_type;
  const ownerType = normalizedOwnerType ?? normalizedEntityType ?? "user";
  const ids = [userId, ownerId, entityId].filter(Boolean);
  const resolvedId = ids[0] ?? "";

  if (!resolvedId) {
    throw new Error(`${fieldName} is required`);
  }
  if (ids.some((id) => id !== resolvedId)) {
    throw new Error("user_id, owner_id, and entity_id must match when provided together");
  }
  return {
    user_id: resolvedId,
    owner_id: resolvedId,
    owner_type: ownerType,
    entity_id: resolvedId,
    entity_type: ownerType,
  };
}

