import type { SupabaseClient } from "@supabase/supabase-js";
import type { MemoryType } from "../contracts/index.js";
import { normalizeTextForMemoryKey } from "./intelligence.js";

export interface ConflictCandidate {
  id: string;
  text: string;
  created_at: string;
  confidence?: number | null;
  source_weight?: number | null;
  memory_type?: string | null;
  duplicate_of?: string | null;
}

export interface ConflictResolutionInput {
  workspaceId: string;
  userId: string;
  namespace: string;
  newMemoryId: string;
  newText: string;
  memoryType?: MemoryType;
  confidence: number;
  sourceWeight: number;
}

export interface ConflictResolutionOutcome {
  hasConflict: boolean;
  winnerMemoryId?: string;
  loserMemoryId?: string;
  reason?: string;
}

function parsePreferencePolarity(text: string): { topic: string; polarity: 1 | -1 } | null {
  const normalized = normalizeTextForMemoryKey(text);
  const patterns: Array<{ re: RegExp; polarity: 1 | -1 }> = [
    { re: /\b(?:i|user)\s+(?:love|like|prefer)\s+(.+)/, polarity: 1 },
    { re: /\b(?:i|user)\s+(?:hate|dislike|avoid)\s+(.+)/, polarity: -1 },
    { re: /\b(?:i|user)\s+am\s+allergic\s+to\s+(.+)/, polarity: -1 },
  ];
  for (const p of patterns) {
    const m = normalized.match(p.re);
    if (!m) continue;
    const topic = m[1].replace(/\b(and|but)\b.*/, "").trim();
    if (!topic) continue;
    return { topic, polarity: p.polarity };
  }
  return null;
}

function parseFactPolarity(text: string): { topic: string; polarity: 1 | -1 } | null {
  const normalized = normalizeTextForMemoryKey(text);
  const explicitNot = normalized.match(/\b(?:user|i)\s+(?:is|am|has)\s+not\s+(.+)/);
  if (explicitNot) return { topic: explicitNot[1].trim(), polarity: -1 };
  const explicitIs = normalized.match(/\b(?:user|i)\s+(?:is|am|has)\s+(.+)/);
  if (explicitIs) return { topic: explicitIs[1].trim(), polarity: 1 };
  return null;
}

function detectConflict(textA: string, typeA: string | null | undefined, textB: string, typeB: string | null | undefined): boolean {
  const ta = (typeA ?? "note").toLowerCase();
  const tb = (typeB ?? "note").toLowerCase();
  if (ta !== tb) return false;
  if (ta === "preference") {
    const a = parsePreferencePolarity(textA);
    const b = parsePreferencePolarity(textB);
    return !!a && !!b && a.topic === b.topic && a.polarity !== b.polarity;
  }
  if (ta === "fact") {
    const a = parseFactPolarity(textA);
    const b = parseFactPolarity(textB);
    return !!a && !!b && a.topic === b.topic && a.polarity !== b.polarity;
  }
  return false;
}

function winnerScore(args: {
  createdAt: string;
  confidence: number;
  sourceWeight: number;
}): number {
  const recencySeconds = Date.parse(args.createdAt) / 1000;
  return recencySeconds * 0.000001 + args.confidence * 0.8 + Math.max(0.25, Math.min(2, args.sourceWeight)) * 0.2;
}

export async function detectAndResolveConflict(
  supabase: SupabaseClient,
  input: ConflictResolutionInput,
): Promise<ConflictResolutionOutcome> {
  const { data, error } = await supabase
    .from("memories")
    .select("id,text,created_at,confidence,source_weight,memory_type,duplicate_of")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId)
    .eq("namespace", input.namespace)
    .is("duplicate_of", null)
    .neq("id", input.newMemoryId)
    .order("created_at", { ascending: false })
    .limit(60);

  if (error || !Array.isArray(data)) {
    return { hasConflict: false };
  }

  const candidate = (data as ConflictCandidate[]).find((row) =>
    detectConflict(input.newText, input.memoryType, row.text, row.memory_type),
  );
  if (!candidate) return { hasConflict: false };

  const newScore = winnerScore({
    createdAt: new Date().toISOString(),
    confidence: input.confidence,
    sourceWeight: input.sourceWeight,
  });
  const oldScore = winnerScore({
    createdAt: candidate.created_at,
    confidence: Number(candidate.confidence ?? 0.5),
    sourceWeight: Number(candidate.source_weight ?? 1),
  });

  const winnerMemoryId = newScore >= oldScore ? input.newMemoryId : candidate.id;
  const loserMemoryId = winnerMemoryId === input.newMemoryId ? candidate.id : input.newMemoryId;
  const reason = newScore >= oldScore
    ? "new_memory_outweighed_existing_by_recency_confidence_source"
    : "existing_memory_retained_by_recency_confidence_source";

  await supabase
    .from("memories")
    .update({
      conflict_state: "resolved",
      last_conflict_at: new Date().toISOString(),
    })
    .in("id", [winnerMemoryId, loserMemoryId])
    .eq("workspace_id", input.workspaceId);

  await supabase
    .from("memories")
    .update({
      duplicate_of: winnerMemoryId,
      conflict_state: "superseded",
      last_conflict_at: new Date().toISOString(),
    })
    .eq("workspace_id", input.workspaceId)
    .eq("id", loserMemoryId)
    .is("duplicate_of", null);

  await supabase
    .from("memory_conflicts")
    .insert({
      workspace_id: input.workspaceId,
      winner_memory_id: winnerMemoryId,
      loser_memory_id: loserMemoryId,
      decision_reason: reason,
      features: {
        method: "deterministic_recency_confidence_source",
        new_confidence: input.confidence,
        new_source_weight: input.sourceWeight,
        old_confidence: Number(candidate.confidence ?? 0.5),
        old_source_weight: Number(candidate.source_weight ?? 1),
      },
      resolved_at: new Date().toISOString(),
    });

  return {
    hasConflict: true,
    winnerMemoryId,
    loserMemoryId,
    reason,
  };
}

export async function createMemoryRevision(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    memoryId: string;
    text: string;
    metadata: Record<string, unknown>;
    reason?: string;
    source?: string;
  },
): Promise<void> {
  const { data } = await supabase
    .from("memory_revisions")
    .select("revision_no")
    .eq("workspace_id", args.workspaceId)
    .eq("memory_id", args.memoryId)
    .order("revision_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextRevision = Number((data as { revision_no?: number } | null)?.revision_no ?? 0) + 1;

  await supabase
    .from("memory_revisions")
    .insert({
      workspace_id: args.workspaceId,
      memory_id: args.memoryId,
      revision_no: nextRevision,
      text: args.text,
      metadata: args.metadata,
      reason: args.reason ?? null,
      source: args.source ?? null,
    });
}
