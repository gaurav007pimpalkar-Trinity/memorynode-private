/**
 * Shared Supabase mock factory for tests.
 * Provides typed in-memory mock builders that replace inline `makeSupabase()` in test files.
 *
 * Phase 7: typed mocks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------- Row types (minimal, matching DB schema) ----------

export interface WorkspaceRow {
  id: string;
  plan: "free" | "pro" | "team";
  plan_status: "free" | "trialing" | "active" | "past_due" | "canceled";
  trial?: boolean;
  trial_expires_at?: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_provider: string;
  payu_txn_id: string | null;
  payu_payment_id: string | null;
  payu_last_status: string | null;
  payu_last_event_id: string | null;
  payu_last_event_created: number | null;
}

export interface UsageRow {
  writes: number;
  reads: number;
  embeds: number;
}

// ---------- Builder options ----------

export interface MockSupabaseOptions {
  /** Workspace plan (default "free") */
  plan?: WorkspaceRow["plan"];
  /** Workspace plan status (default "free") */
  plan_status?: WorkspaceRow["plan_status"];
  /** Override individual workspace fields */
  workspace?: Partial<WorkspaceRow>;
  /** Starting usage counts (default all 0) */
  usage?: UsageRow;
}

// ---------- Simple Supabase mock ----------

/**
 * Lightweight Supabase mock suitable for non-billing tests (memories, search, usage, etc.).
 * Supports: `api_keys`, `workspaces`, `usage_daily`, `memories`, `memory_chunks`,
 * `product_events`, `app_settings`.
 *
 * For billing tests with PayU webhook/transaction stores, use the more specialized
 * `makeSupabase()` in `billing.test.ts` or build on top of this.
 */
export function makeSimpleSupabase(options?: MockSupabaseOptions) {
  const workspace: WorkspaceRow = {
    id: options?.workspace?.id ?? "ws1",
    plan: options?.plan ?? options?.workspace?.plan ?? "free",
    plan_status: options?.plan_status ?? options?.workspace?.plan_status ?? "free",
    current_period_end: options?.workspace?.current_period_end ?? null,
    cancel_at_period_end: options?.workspace?.cancel_at_period_end ?? false,
    billing_provider: options?.workspace?.billing_provider ?? "payu",
    payu_txn_id: options?.workspace?.payu_txn_id ?? null,
    payu_payment_id: options?.workspace?.payu_payment_id ?? null,
    payu_last_status: options?.workspace?.payu_last_status ?? null,
    payu_last_event_id: options?.workspace?.payu_last_event_id ?? null,
    payu_last_event_created: options?.workspace?.payu_last_event_created ?? null,
    trial: options?.workspace?.trial ?? false,
    trial_expires_at: options?.workspace?.trial_expires_at ?? null,
  };

  const usage: UsageRow = options?.usage ?? { writes: 0, reads: 0, embeds: 0 };

  const client = {
    /** Exposed for test assertions */
    _workspace: workspace,
    _usage: usage,

    from(table: string) {
      if (table === "app_settings") {
        return {
          select: () => ({
            limit: () => ({
              single: async () => ({ data: { api_key_salt: "salt" }, error: null }),
            }),
          }),
        };
      }

      if (table === "api_keys") {
        const builder: Record<string, unknown> = {
          eq: () => builder,
          is: () => builder,
          single: async () => ({
            data: {
              id: "k1",
              workspace_id: workspace.id,
              workspaces: {
                plan: workspace.plan,
                plan_status: workspace.plan_status,
                trial: workspace.trial ?? false,
                trial_expires_at: workspace.trial_expires_at ?? null,
              },
            },
            error: null,
          }),
        };
        return { select: () => builder };
      }

      if (table === "workspaces") {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: workspace, error: null }),
          single: async () => ({ data: workspace, error: null }),
          limit: async () => ({ data: [{ id: workspace.id }], error: null }),
          update: (fields: Partial<WorkspaceRow>) => ({
            eq: () => {
              Object.assign(workspace, fields);
              return { data: [workspace], error: null };
            },
          }),
        };
        return builder;
      }

      if (table === "usage_daily") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: usage, error: null }),
              }),
            }),
          }),
        };
      }

      if (table === "memories") {
        return {
          insert: () => ({
            select: () => ({ single: async () => ({ data: {}, error: null }) }),
          }),
        };
      }

      if (table === "memory_chunks") {
        return { insert: () => ({ error: null }) };
      }

      if (table === "product_events") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
          insert: () => ({ error: null }),
        };
      }

      // Fallback: no-op builder
      const noop: Record<string, unknown> = {
        select: () => noop,
        eq: () => noop,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return noop;
    },

    rpc(name: string, args?: Record<string, unknown>) {
      if (name === "get_api_key_salt") {
        return Promise.resolve({ data: "salt", error: null });
      }
      if (name === "authenticate_api_key") {
        return Promise.resolve({
          data: [{
            api_key_id: "k1",
            workspace_id: workspace.id,
            key_created_at: new Date().toISOString(),
            plan: workspace.plan,
            plan_status: workspace.plan_status,
            trial: workspace.trial ?? false,
            trial_expires_at: workspace.trial_expires_at ?? null,
          }],
          error: null,
        });
      }
      if (name === "touch_api_key_usage") {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "bump_usage_rpc" || name === "bump_usage") {
        return {
          data: {
            workspace_id: args?.p_workspace_id ?? workspace.id,
            day: args?.p_day ?? "",
            writes: 0,
            reads: 0,
            embeds: 0,
          },
          error: null,
        };
      }
      if (name === "match_chunks_vector" || name === "match_chunks_text") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
  };

  return client as typeof client & SupabaseClient;
}
