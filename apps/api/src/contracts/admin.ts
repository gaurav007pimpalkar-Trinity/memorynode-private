/**
 * Zod schemas for admin control-plane API payloads.
 * Source of truth for /v1/workspaces and /v1/api-keys* endpoints.
 */

import { z } from "zod";

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1, "name is required"),
  internal: z.boolean().optional(),
  entitlement_source: z.enum(["billing", "internal_grant"]).optional(),
  grant_reason: z.string().trim().min(3).max(200).optional(),
}).strict();
export type CreateWorkspacePayload = z.infer<typeof CreateWorkspaceSchema>;

export const CreateApiKeySchema = z.object({
  workspace_id: z.string().min(1, "workspace_id is required"),
  name: z.string().min(1, "name is required"),
  scoped_container_tag: z.string().max(128).optional(),
});
export type CreateApiKeyPayload = z.infer<typeof CreateApiKeySchema>;

export const RevokeApiKeySchema = z.object({
  api_key_id: z.string().min(1, "api_key_id is required"),
});
export type RevokeApiKeyPayload = z.infer<typeof RevokeApiKeySchema>;
