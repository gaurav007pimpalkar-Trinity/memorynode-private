import { z } from "zod";

export const DashboardBootstrapSchema = z.object({
  access_token: z.string().trim().min(1, "access_token is required"),
  workspace_name: z.string().trim().min(1).optional(),
}).strict();
export type DashboardBootstrapPayload = z.infer<typeof DashboardBootstrapSchema>;

export const DashboardCreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
}).strict();
export type DashboardCreateWorkspacePayload = z.infer<typeof DashboardCreateWorkspaceSchema>;

export const DashboardCreateApiKeySchema = z.object({
  workspace_id: z.string().uuid("workspace_id must be a valid UUID"),
  name: z.string().trim().min(1, "name is required"),
}).strict();
export type DashboardCreateApiKeyPayload = z.infer<typeof DashboardCreateApiKeySchema>;

export const DashboardRevokeApiKeySchema = z.object({
  api_key_id: z.string().uuid("api_key_id must be a valid UUID"),
}).strict();
export type DashboardRevokeApiKeyPayload = z.infer<typeof DashboardRevokeApiKeySchema>;

export const DashboardCreateInviteSchema = z.object({
  workspace_id: z.string().uuid("workspace_id must be a valid UUID"),
  email: z.string().trim().email("email must be valid"),
  role: z.enum(["member", "admin", "owner"]),
}).strict();
export type DashboardCreateInvitePayload = z.infer<typeof DashboardCreateInviteSchema>;

export const DashboardRevokeInviteSchema = z.object({
  invite_id: z.string().uuid("invite_id must be a valid UUID"),
}).strict();
export type DashboardRevokeInvitePayload = z.infer<typeof DashboardRevokeInviteSchema>;

export const DashboardUpdateMemberRoleSchema = z.object({
  workspace_id: z.string().uuid("workspace_id must be a valid UUID"),
  user_id: z.string().uuid("user_id must be a valid UUID"),
  role: z.enum(["member", "admin", "owner"]),
}).strict();
export type DashboardUpdateMemberRolePayload = z.infer<typeof DashboardUpdateMemberRoleSchema>;

export const DashboardRemoveMemberSchema = z.object({
  workspace_id: z.string().uuid("workspace_id must be a valid UUID"),
  user_id: z.string().uuid("user_id must be a valid UUID"),
}).strict();
export type DashboardRemoveMemberPayload = z.infer<typeof DashboardRemoveMemberSchema>;
