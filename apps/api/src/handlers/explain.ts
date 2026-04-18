import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import {
  acquireWorkspaceConcurrencySlot,
  authenticate,
  rateLimit,
  releaseWorkspaceConcurrencySlot,
} from "../auth.js";
import { getRouteRateLimitMax } from "../limits.js";
import type { HandlerDeps } from "../router.js";
import { ExplainAnswerSchema, parseWithSchema } from "../contracts/index.js";
import { requireWorkspaceId } from "../supabaseScoped.js";
import type { SearchHandlerDeps } from "./search.js";

export type ExplainHandlerDeps = SearchHandlerDeps;

async function answerWithStub(question: string, context: string): Promise<string> {
  const clip = context.replace(/\s+/g, " ").trim().slice(0, 800);
  return `(stub) For "${question.slice(0, 120)}": use the supplied context. Preview: ${clip.slice(0, 400)}${clip.length > 400 ? "…" : ""}`;
}

async function answerWithOpenAI(question: string, context: string, env: Env): Promise<string> {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 512,
      messages: [
        {
          role: "system",
          content:
            "You answer strictly from the provided context. If the context is insufficient, say what is missing in one sentence.",
        },
        { role: "user", content: `Question:\n${question}\n\nContext:\n${context}` },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim() || "(empty model response)";
}

export function createExplainHandlers(
  requestDeps: ExplainHandlerDeps,
  defaultDeps: ExplainHandlerDeps,
): {
  handleExplainAnswer: (
    request: Request,
    env: Env,
    supabase: SupabaseClient,
    auditCtx: { workspaceId?: string; apiKeyId?: string },
    requestId: string,
    deps?: HandlerDeps,
  ) => Promise<Response>;
} {
  return {
    async handleExplainAnswer(request, env, supabase, auditCtx, requestId = "", deps?) {
      const d = (deps ?? defaultDeps) as ExplainHandlerDeps;
      const { jsonResponse } = d;
      const auth = await authenticate(request, env, supabase, auditCtx);
      requireWorkspaceId(auth.workspaceId);
      const quota = await d.resolveQuotaForWorkspace(auth, supabase);
      if (quota.blocked) {
        return jsonResponse(
          {
            error: {
              code: quota.errorCode ?? "ENTITLEMENT_REQUIRED",
              message: quota.message ?? "No active paid entitlement found. Start a plan to continue.",
              upgrade_required: true,
              effective_plan: "launch",
            },
            upgrade_url: (env as { PUBLIC_APP_URL?: string }).PUBLIC_APP_URL
              ? `${(env as { PUBLIC_APP_URL: string }).PUBLIC_APP_URL}/billing`
              : undefined,
          },
          402,
        );
      }
      const rate = await rateLimit(auth.keyHash, env, auth, getRouteRateLimitMax(env, "explain", auth.keyCreatedAt));
      if (!rate.allowed) {
        return jsonResponse({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429, rate.headers);
      }
      const wsRpm = quota.planLimits.workspace_rpm ?? 120;
      const wsRate = await d.rateLimitWorkspace(auth.workspaceId, wsRpm, env);
      if (!wsRate.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace rate limit exceeded" } },
          429,
          { ...rate.headers, ...wsRate.headers },
        );
      }
      const rateHeaders = { ...rate.headers, ...wsRate.headers };

      const parseResult = await parseWithSchema(ExplainAnswerSchema, request);
      if (!parseResult.ok) {
        return jsonResponse(
          { error: { code: "BAD_REQUEST", message: parseResult.error, ...(parseResult.details ? { details: parseResult.details } : {}) } },
          400,
          rateHeaders,
        );
      }

      const concurrency = await acquireWorkspaceConcurrencySlot(auth.workspaceId, env);
      if (!concurrency.allowed) {
        return jsonResponse(
          { error: { code: "rate_limited", message: "Workspace in-flight concurrency limit exceeded" } },
          429,
          { ...rate.headers, ...concurrency.headers },
        );
      }
      const concurrencyHeaders = { ...rate.headers, ...concurrency.headers };
      try {
        const today = d.todayUtc();
        const reserve = await d.reserveQuotaAndMaybeRespond(
          quota,
          supabase,
          auth.workspaceId,
          today,
          {
            writesDelta: 0,
            readsDelta: 1,
            embedsDelta: 0,
            embedTokensDelta: 0,
            extractionCallsDelta: 0,
          },
          concurrencyHeaders,
          env,
          jsonResponse,
          { route: "/v1/explain/answer", requestId },
        );
        if (reserve.response) return reserve.response;
        const reservationId = reserve.reservationId;

        const embeddingsMode = (env.EMBEDDINGS_MODE ?? "openai").trim().toLowerCase();
        const useStub = embeddingsMode === "stub" || !env.OPENAI_API_KEY;
        let answer: string;
        try {
          answer = useStub
            ? await answerWithStub(parseResult.data.question, parseResult.data.context)
            : await answerWithOpenAI(parseResult.data.question, parseResult.data.context, env);
        } catch (err) {
          if (reservationId) {
            await d.markUsageReservationRefundPending(
              supabase,
              reservationId,
              err instanceof Error ? err.message : String(err),
            );
          }
          throw err;
        }
        if (reservationId) await d.markUsageReservationCommitted(supabase, reservationId);

        void d.emitProductEvent(
          supabase,
          "explain_answer_served",
          {
            workspaceId: auth.workspaceId,
            requestId,
            route: "/v1/explain/answer",
            method: "POST",
            status: 200,
            effectivePlan: d.effectivePlan(auth.plan, auth.planStatus),
            planStatus: auth.planStatus,
          },
          { stub: useStub, question_chars: parseResult.data.question.length, context_chars: parseResult.data.context.length },
        );

        return jsonResponse({ answer }, 200, concurrencyHeaders);
      } finally {
        await releaseWorkspaceConcurrencySlot(auth.workspaceId, concurrency.leaseToken, env);
      }
    },
  };
}
