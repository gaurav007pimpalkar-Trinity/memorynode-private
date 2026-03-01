/**
 * Episodes handler: POST /v1/episodes, GET /v1/episodes. Agent event log for temporal recall.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { authenticate, rateLimit } from "../auth.js";
import type { HandlerDeps } from "../router.js";
import {
  EpisodeInsertSchema,
  parseWithSchema,
  parseEpisodeListParams,
  type EpisodeInsertPayload,
} from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";

export function createEpisodeHandlers(
  _requestDeps: HandlerDeps,
  defaultDeps: HandlerDeps,
): {
  handleCreateEpisode: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleListEpisodes: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleCreateEpisode(request, env, supabase, auditCtx, _requestId = "", deps?) {
      const d = deps ?? defaultDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      const parseResult = await parseWithSchema(EpisodeInsertSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          {
            error: {
              code: "BAD_REQUEST",
              message: parseResult.error,
              ...(parseResult.details ? { details: parseResult.details } : {}),
            },
          },
          400,
          rate.headers,
        );
      }
      const body = parseResult.data as EpisodeInsertPayload;
      const { data, error } = await supabase
        .from("agent_episodes")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: body.user_id ?? null,
          session_id: body.session_id,
          event_type: body.event_type,
          tool_name: body.tool_name ?? null,
          input_summary: body.input_summary ?? null,
          output_summary: body.output_summary ?? null,
          metadata: body.metadata ?? {},
        })
        .select("id, created_at")
        .single();
      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "Insert failed" } },
          500,
          rate.headers,
        );
      }
      return jsonResponse(
        { id: data.id, created_at: data.created_at },
        201,
        rate.headers,
      );
    },

    async handleListEpisodes(request, env, supabase, auditCtx, deps?) {
      const d = deps ?? defaultDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const rate = await rateLimit(auth.keyHash, env, auth);
      if (!rate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Rate limit exceeded" } },
          429,
          rate.headers,
        );
      }
      const url = new URL(request.url);
      let session_id: string;
      let start_time: string | undefined;
      let end_time: string | undefined;
      let limit: number;
      try {
        const params = parseEpisodeListParams(url);
        session_id = params.session_id;
        start_time = params.start_time;
        end_time = params.end_time;
        limit = params.limit;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message } },
          400,
          rate.headers,
        );
      }
      if (start_time && end_time && new Date(start_time) > new Date(end_time)) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: "start_time must be before or equal to end_time" } },
          400,
          rate.headers,
        );
      }
      let query = supabase
        .from("agent_episodes")
        .select("id, user_id, session_id, event_type, tool_name, input_summary, output_summary, metadata, created_at")
        .eq("workspace_id", auth.workspaceId)
        .eq("session_id", session_id)
        .order("created_at", { ascending: false })
        .limit(limit + 1);
      if (start_time) query = query.gte("created_at", start_time);
      if (end_time) query = query.lte("created_at", end_time);
      const { data, error } = await query;
      if (error) {
        return jsonResponse(
          { error: { code: "DB_ERROR", message: error.message ?? "List failed" } },
          500,
          rate.headers,
        );
      }
      const results = (data ?? []).slice(0, limit);
      const has_more = (data ?? []).length > limit;
      return jsonResponse({ results, has_more }, 200, rate.headers);
    },
  };
}
