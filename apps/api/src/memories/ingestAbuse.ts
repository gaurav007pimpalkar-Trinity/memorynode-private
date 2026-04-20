import type { SupabaseClient } from "@supabase/supabase-js";

export type IngestDecision = "allow" | "throttle" | "reject" | "flag";

export interface IngestAbuseInput {
  workspaceId: string;
  userId: string;
  namespace: string;
  canonicalHash: string;
  semanticFingerprint: string;
  idempotencyKey?: string;
  textLength: number;
}

export interface IngestAbuseResult {
  decision: IngestDecision;
  reason?: string;
  existingMemoryId?: string;
}

export async function evaluateIngestAbuse(
  supabase: SupabaseClient,
  input: IngestAbuseInput,
): Promise<IngestAbuseResult> {
  const lastFiveMinutesIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let eventsRes: { error: unknown; data: unknown };
  let exactMatchRes: { error: unknown; data: unknown };
  try {
    eventsRes = await (supabase
      .from("ingest_control_events")
      .select("id,decision,canonical_hash,idempotency_key,metadata,created_at")
      .eq("workspace_id", input.workspaceId)
      .eq("user_id", input.userId)
      .eq("namespace", input.namespace)
      .gte("created_at", lastFiveMinutesIso)
      .order("created_at", { ascending: false })
      .limit(120) as unknown as Promise<{ error: unknown; data: unknown }>);
  } catch {
    eventsRes = { error: null, data: null };
  }
  try {
    exactMatchRes = await (supabase
      .from("memories")
      .select("id,created_at")
      .eq("workspace_id", input.workspaceId)
      .eq("user_id", input.userId)
      .eq("namespace", input.namespace)
      .eq("canonical_hash", input.canonicalHash)
      .is("duplicate_of", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() as unknown as Promise<{ error: unknown; data: unknown }>);
  } catch {
    exactMatchRes = { error: null, data: null };
  }

  if (!eventsRes.error && Array.isArray(eventsRes.data)) {
    const events = eventsRes.data as Array<{
      decision: IngestDecision;
      canonical_hash?: string | null;
      idempotency_key?: string | null;
    }>;
    const repeatedCanonical = events.filter((e) => e.canonical_hash === input.canonicalHash).length;
    const totalRecent = events.length;
    if (input.idempotencyKey && events.some((e) => e.idempotency_key === input.idempotencyKey)) {
      const existingMemoryId = !exactMatchRes.error && exactMatchRes.data
        ? String((exactMatchRes.data as { id?: string }).id ?? "")
        : undefined;
      return { decision: "reject", reason: "idempotency_replay", ...(existingMemoryId ? { existingMemoryId } : {}) };
    }
    if (repeatedCanonical >= 5) {
      return { decision: "reject", reason: "repeated_duplicate_writes" };
    }
    if (totalRecent >= 80) {
      return { decision: "throttle", reason: "burst_write_rate" };
    }
    if (totalRecent >= 50) {
      return { decision: "flag", reason: "abnormal_write_pattern" };
    }
  }

  const exactRow = exactMatchRes.data as { id?: string } | null;
  if (!exactMatchRes.error && exactRow?.id) {
    return { decision: "allow", reason: "exact_duplicate_exists", existingMemoryId: String(exactRow.id) };
  }

  return { decision: "allow" };
}

export async function writeIngestControlEvent(
  supabase: SupabaseClient,
  args: IngestAbuseInput & {
    decision: IngestDecision;
    eventType: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await supabase
    .from("ingest_control_events")
    .insert({
      workspace_id: args.workspaceId,
      user_id: args.userId,
      namespace: args.namespace,
      canonical_hash: args.canonicalHash,
      semantic_fingerprint: args.semanticFingerprint,
      idempotency_key: args.idempotencyKey ?? null,
      event_type: args.eventType,
      decision: args.decision,
      metadata: args.metadata ?? {},
    });
}
