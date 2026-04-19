/**
 * API key admin handlers (create, list, revoke). Phase 4: Worker split (IMPROVEMENT_PLAN.md).
 * Dependencies injected via ApiKeysHandlerDeps to avoid circular dependency with index.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import { getRouteRateLimitMax } from "../limits.js";
import {
  CreateApiKeySchema,
  RevokeApiKeySchema,
  parseWithSchema,
} from "../contracts/index.js";

export interface ApiKeysHandlerDeps extends HandlerDeps {
  safeParseJson: <T>(request: Request) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  requireAdmin: (request: Request, env: Env) => Promise<{ token: string }>;
  rateLimit: (
    keyHash: string,
    env: Env,
    auth?: { keyCreatedAt?: string | null },
    explicitLimit?: number,
  ) => Promise<{ allowed: boolean; headers: Record<string, string> }>;
  generateApiKey: () => string;
  getApiKeySalt: (env: Env, supabase: SupabaseClient) => Promise<{ salt: string }>;
  hashApiKey: (rawKey: string, salt: string) => Promise<string>;
  emitProductEvent: (
    supabase: SupabaseClient,
    eventName: string,
    ctx: Record<string, unknown>,
    props?: Record<string, unknown>,
  ) => Promise<void>;
  /** Optional: for stub Supabase, register raw key so authenticate can resolve workspace (index provides this). */
  setStubApiKeyIfPresent?: (
    supabase: SupabaseClient,
    rawKey: string,
    workspaceId: string,
  ) => void;
}

export function createApiKeysHandlers(
  requestDeps: ApiKeysHandlerDeps,
  defaultDeps: ApiKeysHandlerDeps,
): {
  handleCreateApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListApiKeys: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleRevokeApiKey: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateApiKey(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as ApiKeysHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env, undefined, getRouteRateLimitMax(env, "admin"));
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const body = await parseWithSchema(CreateApiKeySchema, request);
      if (!body.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: body.error,
              ...(body.details ? { details: body.details } : {}),
            },
          },
          400,
          rate.headers,
        );
      }
      const maxActiveKeysRaw = Number(env.MAX_ACTIVE_API_KEYS ?? "10");
      const maxActiveKeys = Number.isFinite(maxActiveKeysRaw) && maxActiveKeysRaw > 0
        ? Math.floor(maxActiveKeysRaw)
        : 10;
      const activeCountResult = await supabase
        .from("api_keys")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", body.data.workspace_id)
        .is("revoked_at", null);
      if (activeCountResult.error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: activeCountResult.error.message ?? "Failed to validate api key cap" } },
          500,
          rate.headers,
        );
      }
      const activeCount = activeCountResult.count ?? 0;
      if (activeCount >= maxActiveKeys) {
        return jsonResponse(
          {
            error: {
              code: "PLAN_LIMIT_EXCEEDED",
              message: `Active API key limit reached (${maxActiveKeys}) for this workspace`,
              limit: "active_api_keys",
              used: activeCount,
              cap: maxActiveKeys,
            },
          },
          402,
          rate.headers,
        );
      }

      const rawKey = d.generateApiKey();
      const saltOutcome = await d.getApiKeySalt(env, supabase);
      const keyHash = await d.hashApiKey(rawKey, saltOutcome.salt);
      const authDebugEnabled =
        (env.AUTH_DEBUG ?? "").trim() === "1" &&
        (env.ENVIRONMENT ?? env.NODE_ENV ?? "dev").toLowerCase() === "dev";
      if (authDebugEnabled) {
        console.info("auth_debug_create", { created: true });
      }

      const { data, error } = await supabase
        .from("api_keys")
        .insert({
          workspace_id: body.data.workspace_id,
          name: body.data.name,
          scoped_container_tag: body.data.scoped_container_tag ?? null,
          key_hash: keyHash,
          key_prefix: rawKey.split("_").slice(0, 2).join("_"),
          key_last4: rawKey.slice(-4),
        })
        .select("id, workspace_id, name, scoped_container_tag, key_prefix, key_last4, created_at, revoked_at")
        .single();

      if (error || !data) {
        const rawMessage = error?.message ?? "Failed to create api key";
        const hint =
          rawMessage.toLowerCase().includes("api key") || rawMessage.toLowerCase().includes("invalid")
            ? " Check Worker env: SUPABASE_SERVICE_ROLE_KEY must be the service_role key (not anon). SUPABASE_URL must match the same project."
            : "";
        return jsonResponse(
          {
            error: {
              code: "DB_ERROR",
              message: rawMessage + hint,
              ...(error?.code && { details: { supabase_code: error.code } }),
            },
          },
          500,
          rate.headers,
        );
      }

      if (d.setStubApiKeyIfPresent) {
        d.setStubApiKeyIfPresent(supabase, rawKey, body.data.workspace_id);
      }

      void d.emitProductEvent(
        supabase,
        "api_key_created",
        { workspaceId: data.workspace_id as string, route: "/v1/api-keys", method: "POST", status: 200 },
        { key_prefix: (data as { key_prefix?: string }).key_prefix ?? "mn_live" },
      );

      return jsonResponse(
        { api_key: rawKey, api_key_id: data.id, workspace_id: data.workspace_id, name: data.name },
        200,
        rate.headers,
      );
    },

    async handleListApiKeys(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as ApiKeysHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env, undefined, getRouteRateLimitMax(env, "admin"));
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const url = new URL(request.url);
      const workspaceId = url.searchParams.get("workspace_id");
      if (!workspaceId) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "workspace_id is required" } },
          400,
          rate.headers,
        );
      }

      const { data, error } = await supabase
        .from("api_keys")
        .select("id, workspace_id, name, scoped_container_tag, created_at, revoked_at, key_prefix, key_last4, last_used_at, last_used_ip")
        .eq("workspace_id", workspaceId);

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to list api keys" } },
          500,
          rate.headers,
        );
      }

      const masked =
        data?.map((k) => ({
          id: k.id,
          workspace_id: k.workspace_id,
          name: k.name,
          scoped_container_tag: (k as { scoped_container_tag?: string | null }).scoped_container_tag ?? null,
          created_at: k.created_at,
          revoked_at: k.revoked_at,
          key_prefix: (k as { key_prefix?: string }).key_prefix ?? "mn_live",
          key_last4: (k as { key_last4?: string }).key_last4 ?? "****",
          last_used_at: (k as { last_used_at?: string }).last_used_at ?? null,
          last_used_ip: (k as { last_used_ip?: string | null }).last_used_ip ?? null,
        })) ?? [];

      return jsonResponse({ api_keys: masked }, 200, rate.headers);
    },

    async handleRevokeApiKey(request, env, supabase, deps?) {
      const d = (deps ?? defaultDeps) as ApiKeysHandlerDeps;
      const { jsonResponse } = d;
      const { token } = await d.requireAdmin(request, env);
      const rate = await d.rateLimit(`admin:${token}`, env, undefined, getRouteRateLimitMax(env, "admin"));
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }

      const body = await parseWithSchema(RevokeApiKeySchema, request);
      if (!body.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: body.error,
              ...(body.details ? { details: body.details } : {}),
            },
          },
          400,
          rate.headers,
        );
      }

      const { error } = await supabase
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", body.data.api_key_id);

      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Failed to revoke api key" } },
          500,
          rate.headers,
        );
      }

      return jsonResponse({ revoked: true }, 200, rate.headers);
    },
  };
}
