/**
 * Tenant safety: require workspace_id for scoped Supabase access.
 * Fail fast if missing to prevent cross-tenant leakage.
 */

import { createHttpError } from "./http.js";

/**
 * Asserts workspaceId is a non-empty string. Throws 400 BAD_REQUEST if missing.
 * Use at the start of handlers that must be workspace-scoped.
 */
export function requireWorkspaceId(workspaceId: string | undefined | null): asserts workspaceId is string {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw createHttpError(400, "BAD_REQUEST", "workspace_id required for this operation");
  }
}
