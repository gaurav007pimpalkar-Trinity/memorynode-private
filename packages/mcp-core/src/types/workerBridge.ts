/**
 * Structural types mirroring apps/api worker auth/env surfaces so mcp-core does not import apps/api
 * (avoids composite project / rootDir conflicts). Keep aligned when AuthContext or env usage changes.
 */

import type { ProductPlanId } from "@memorynodeai/shared";

/** Mirrors {@link import("../../../../apps/api/src/auth.js").AuthContext} — duplicate until shared extraction. */
export interface HostedAuthContext {
  workspaceId: string;
  keyHash: string;
  apiKeyId?: string;
  scopedContainerTag?: string | null;
  plan: "pro" | "team";
  /** Product tier for gates and UX (maps DB plan row via `productPlanFromWorkspacePlan`). */
  productPlan: ProductPlanId;
  planStatus?: "trialing" | "active" | "past_due" | "canceled";
  /** Mirrors workspace.trial once auth loads trial columns (PLAN §6). */
  trial?: boolean;
  /** ISO 8601 trial end when `trial` is true. */
  trialExpiresAt?: string | null;
  keyCreatedAt?: string | null;
}

/** Env keys read by hosted MCP internal JSON bridge today — widen as handlers move into services. */
export type HostedWorkerEnv = {
  MCP_INTERNAL_SECRET?: string;
  MCP_DEPRECATION_PHASE?: string;
};
