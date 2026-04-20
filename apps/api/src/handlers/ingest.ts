/**
 * POST /v1/ingest — thin dispatcher over memory / conversation / import flows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import type { HandlerDeps } from "../router.js";
import { IngestPayloadSchema, parseWithSchema } from "../contracts/index.js";

export interface IngestHandlerDeps extends HandlerDeps {
  handleCreateMemory: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleCreateConversation: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
  handleImport: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
}

export function createIngestHandlers(forward: IngestHandlerDeps): {
  handleIngest: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleIngest(request, env, supabase, auditCtx, requestId = "", deps?) {
      const { jsonResponse } = (deps ?? forward) as IngestHandlerDeps;
      const parseResult = await parseWithSchema(IngestPayloadSchema, request);
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
        );
      }
      const data = parseResult.data;
      const base = new URL(request.url);

      if (data.kind === "memory") {
        const forwarded = new Request(new URL("/v1/memories", base).toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(data.body),
        });
        return forward.handleCreateMemory(forwarded, env, supabase, auditCtx, requestId, deps);
      }

      if (data.kind === "conversation") {
        const forwarded = new Request(new URL("/v1/memories/conversation", base).toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(data.body),
        });
        return forward.handleCreateConversation(forwarded, env, supabase, auditCtx, requestId, deps);
      }

      if (data.kind === "document") {
        const body = {
          ...data.body,
          chunk_profile: data.body.chunk_profile ?? ("document" as const),
        };
        const forwarded = new Request(new URL("/v1/memories", base).toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        });
        return forward.handleCreateMemory(forwarded, env, supabase, auditCtx, requestId, deps);
      }

      const forwarded = new Request(new URL("/v1/import", base).toString(), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(data.body),
      });
      return forward.handleImport(forwarded, env, supabase, auditCtx, requestId, deps);
    },
  };
}
