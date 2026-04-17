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

/**
 * Runtime tenant guard for row payloads fetched with service-role access.
 * Use after SELECT queries that include workspace_id in selected columns.
 */
export function assertRowsWorkspaceScoped(
  rows: Array<Record<string, unknown>>,
  workspaceId: string,
  context: string,
): void {
  requireWorkspaceId(workspaceId);
  for (const row of rows) {
    const rowWorkspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
    if (rowWorkspaceId !== workspaceId) {
      throw createHttpError(
        500,
        "TENANT_SCOPE_VIOLATION",
        `Workspace scope violation in ${context}`,
      );
    }
  }
}
