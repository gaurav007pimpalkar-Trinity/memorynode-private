import type { SupabaseClient } from "@supabase/supabase-js";

export type MemoryFeedback = {
  query: string;
  retrieved_memory_ids: string[];
  final_response: string;
  user_feedback?: "positive" | "negative";
  latency_ms: number;
};

export type LearnedAdjustment = {
  query_pattern: string;
  preferred_strategy?: "broad" | "focused" | "recent-first" | "important-first" | "hybrid";
  ideal_top_k?: number;
  min_score_delta?: number;
  low_importance_penalty?: boolean;
  positive_count?: number;
  negative_count?: number;
  total_feedback?: number;
};

let defaultClient: SupabaseClient | null = null;
let defaultWorkspaceId = "";
let defaultRequestId = "";

export function setFeedbackRuntime(config: {
  supabase: SupabaseClient;
  workspaceId: string;
  requestId?: string;
}): void {
  defaultClient = config.supabase;
  defaultWorkspaceId = config.workspaceId;
  defaultRequestId = config.requestId ?? "";
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "to", "for", "of", "in", "on", "at", "with",
  "and", "or", "but", "be", "been", "being", "have", "has", "had", "i", "me", "my", "you", "your",
]);

function normalizePattern(query: string): string {
  const expanded = query
    .toLowerCase()
    .replace(/what's/g, "what is")
    .replace(/i'm/g, "i am")
    .replace(/can't/g, "cannot")
    .replace(/n't/g, " not")
    .replace(/favorite/g, "fav");
  const tokens = expanded
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return tokens.join(" ").slice(0, 220);
}

function normalizeMemoryIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 200);
}

function coerceLatencyMs(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

function clampTopK(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(3, Math.min(20, Math.floor(n)));
}

function clampMinScoreDelta(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-0.2, Math.min(0.3, n));
}

function signalWeight(feedback: "positive" | "negative", latencyMs: number): number {
  const latency = Math.max(0, latencyMs);
  if (feedback === "positive") {
    if (latency <= 900) return 1.35;
    if (latency <= 1600) return 1.15;
    return 1;
  }
  if (latency >= 3000) return 1.45;
  if (latency >= 1800) return 1.2;
  return 1;
}

function adjustmentMeetsActivationThreshold(raw: { positive: number; negative: number }): boolean {
  const total = raw.positive + raw.negative;
  if (total < 5) return false;
  if (raw.positive < 2 && raw.negative < 2) return false;
  return true;
}

function decayStrengthFactor(lastUpdatedAt?: string | null): number {
  if (!lastUpdatedAt) return 1;
  const t = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (Date.now() - t) / (1000 * 60 * 60 * 24));
  if (ageDays <= 7) return 1;
  return Math.max(0.2, 1 - (ageDays - 7) * 0.08);
}

export async function recordFeedback(feedback: MemoryFeedback): Promise<void> {
  if (!defaultClient || !defaultWorkspaceId) return;
  await recordFeedbackWithClient(defaultClient, defaultWorkspaceId, defaultRequestId, feedback);
}

export async function recordFeedbackWithClient(
  supabase: SupabaseClient,
  workspaceId: string,
  requestId: string,
  feedback: MemoryFeedback,
): Promise<void> {
  const query = String(feedback.query ?? "").trim();
  if (!query) return;
  const queryPattern = normalizePattern(query);
  const retrievedMemoryIds = normalizeMemoryIds(feedback.retrieved_memory_ids ?? []);
  const responseText = String(feedback.final_response ?? "").trim().slice(0, 8000);
  const userFeedback = feedback.user_feedback;
  const latencyMs = coerceLatencyMs(feedback.latency_ms);

  try {
    const insertBuilder = supabase.from("memory_feedback");
    if (typeof (insertBuilder as { insert?: unknown }).insert !== "function") return;
    const insert = await insertBuilder.insert({
      workspace_id: workspaceId,
      request_id: requestId || null,
      query,
      query_pattern: queryPattern,
      retrieved_memory_ids: retrievedMemoryIds,
      response: responseText,
      feedback: userFeedback ?? null,
      latency_ms: latencyMs,
    }).select("id").maybeSingle();
    if (insert.error) return;
  } catch {
    return;
  }

  if (!userFeedback) return;
  await applyFeedbackAdjustment(supabase, workspaceId, queryPattern, userFeedback, {
    fallbackTopK: clampTopK(retrievedMemoryIds.length) ?? 8,
    latencyMs,
  });
}

export async function updateFeedbackByRequestId(
  supabase: SupabaseClient,
  workspaceId: string,
  requestId: string,
  userFeedback: "positive" | "negative",
): Promise<boolean> {
  const rid = requestId.trim();
  if (!rid) return false;
  const lookup = await supabase
    .from("memory_feedback")
    .select("id, query_pattern, retrieved_memory_ids, latency_ms")
    .eq("workspace_id", workspaceId)
    .eq("request_id", rid)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookup.error || !lookup.data) return false;

  const update = await supabase
    .from("memory_feedback")
    .update({ feedback: userFeedback })
    .eq("workspace_id", workspaceId)
    .eq("id", String((lookup.data as { id?: unknown }).id ?? ""));
  if (update.error) return false;

  const pattern = String((lookup.data as { query_pattern?: unknown }).query_pattern ?? "").trim();
  const memoryIds = Array.isArray((lookup.data as { retrieved_memory_ids?: unknown }).retrieved_memory_ids)
    ? ((lookup.data as { retrieved_memory_ids: unknown[] }).retrieved_memory_ids.map((v) => String(v)).filter(Boolean))
    : [];
  await applyFeedbackAdjustment(supabase, workspaceId, pattern, userFeedback, {
    fallbackTopK: clampTopK(memoryIds.length) ?? 8,
    latencyMs: Number((lookup.data as { latency_ms?: unknown }).latency_ms ?? 0),
  });
  return true;
}

async function applyFeedbackAdjustment(
  supabase: SupabaseClient,
  workspaceId: string,
  queryPattern: string,
  feedback: "positive" | "negative",
  hints: { fallbackTopK: number; latencyMs: number },
): Promise<void> {
  if (!queryPattern) return;
  const current = await supabase
    .from("memory_learning_adjustments")
    .select("query_pattern, preferred_strategy, ideal_top_k, min_score_delta, low_importance_penalty, positive_count, negative_count")
    .eq("workspace_id", workspaceId)
    .eq("query_pattern", queryPattern)
    .maybeSingle();

  const row = (current.data ?? {}) as Record<string, unknown>;
  const weight = signalWeight(feedback, hints.latencyMs);
  const positiveCount = Number(row.positive_count ?? 0) + (feedback === "positive" ? weight : 0);
  const negativeCount = Number(row.negative_count ?? 0) + (feedback === "negative" ? weight : 0);
  const total = Math.max(positiveCount + negativeCount, 1);
  const negativity = negativeCount / total;
  const strategy = typeof row.preferred_strategy === "string" ? row.preferred_strategy : "hybrid";
  const existingTopK = clampTopK(row.ideal_top_k) ?? hints.fallbackTopK;
  const nextTopK = feedback === "positive"
    ? Math.max(3, Math.min(20, Math.round((existingTopK + hints.fallbackTopK) / 2)))
    : Math.max(3, Math.min(20, existingTopK - 1));
  const minScoreDelta = feedback === "negative"
    ? clampMinScoreDelta(Number(row.min_score_delta ?? 0) + 0.03 * weight) ?? 0.03
    : clampMinScoreDelta(Number(row.min_score_delta ?? 0) * (0.9 - Math.min(0.3, (weight - 1) * 0.2))) ?? 0;
  const lowImportancePenalty = feedback === "negative" ? true : (negativity >= 0.5);
  const nowIso = new Date().toISOString();

  const upsert = await supabase
    .from("memory_learning_adjustments")
    .upsert({
      workspace_id: workspaceId,
      query_pattern: queryPattern,
      preferred_strategy: strategy,
      ideal_top_k: nextTopK,
      min_score_delta: minScoreDelta,
      low_importance_penalty: lowImportancePenalty,
      positive_count: positiveCount,
      negative_count: negativeCount,
      last_feedback_at: nowIso,
      last_updated_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: "workspace_id,query_pattern" });
  if (upsert.error) return;

  try {
    await supabase.from("product_events").insert({
      workspace_id: workspaceId,
      event_name: "memory_feedback_signal",
      props: {
        query_pattern: queryPattern,
        feedback,
        signal_weight: weight,
        positive_count: positiveCount,
        negative_count: negativeCount,
        feedback_ratio_positive: positiveCount / Math.max(positiveCount + negativeCount, 1),
        feedback_ratio_negative: negativeCount / Math.max(positiveCount + negativeCount, 1),
      },
    });
  } catch {
    // best effort metrics only
  }
}

export async function getLearnedAdjustmentForQuery(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
): Promise<LearnedAdjustment | null> {
  const pattern = normalizePattern(query);
  if (!pattern) return null;
  let row:
    | { data: Record<string, unknown> | null; error: unknown }
    | null = null;
  try {
    const res = await supabase
      .from("memory_learning_adjustments")
      .select("query_pattern, preferred_strategy, ideal_top_k, min_score_delta, low_importance_penalty, positive_count, negative_count, last_feedback_at, last_updated_at")
      .eq("workspace_id", workspaceId)
      .eq("query_pattern", pattern)
      .maybeSingle();
    row = {
      data: (res.data as Record<string, unknown> | null) ?? null,
      error: res.error,
    };
  } catch {
    return null;
  }
  if (!row || row.error || !row.data) return null;
  const raw = row.data as Record<string, unknown>;
  const positive = Math.max(0, Number(raw.positive_count ?? 0));
  const negative = Math.max(0, Number(raw.negative_count ?? 0));
  if (!adjustmentMeetsActivationThreshold({ positive, negative })) return null;
  const decay = decayStrengthFactor(
    typeof raw.last_updated_at === "string" ? raw.last_updated_at : (
      typeof raw.last_feedback_at === "string" ? raw.last_feedback_at : null
    ),
  );
  const decayedMinScore = clampMinScoreDelta((Number(raw.min_score_delta ?? 0) || 0) * decay);
  const decayedTopK = clampTopK(Math.round((clampTopK(raw.ideal_top_k) ?? 8) * (0.85 + 0.15 * decay)));
  return {
    query_pattern: pattern,
    preferred_strategy: typeof raw.preferred_strategy === "string"
      ? raw.preferred_strategy as LearnedAdjustment["preferred_strategy"]
      : undefined,
    ideal_top_k: decayedTopK,
    min_score_delta: decayedMinScore,
    low_importance_penalty: raw.low_importance_penalty === true && decay >= 0.55,
    positive_count: positive,
    negative_count: negative,
    total_feedback: positive + negative,
  };
}
