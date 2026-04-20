/**
 * Small, fixed-shape profile bundled with POST /v1/context (pinned, recent notes, preferences).
 * Uses list_memories_scoped via performListMemories — no extra SQL migrations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "../auth.js";
import type { ListOutcome, MemoryListParams } from "../handlers/memories.js";

export type ContextProfileRow = {
  memory_id: string;
  text: string;
  memory_type?: string | null;
};

export type BoundedContextProfile = {
  pinned_facts: ContextProfileRow[];
  recent_notes: ContextProfileRow[];
  preferences: ContextProfileRow[];
};

const MAX_ITEM_CHARS = 280;
const MAX_PROFILE_JSON_CHARS = 4000;
const MAX_PINNED = 10;
const MAX_NOTES = 5;
const MAX_PREFS = 8;

function clipText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function isParentMemory(row: ListOutcome["results"][number]): boolean {
  return row.source_memory_id == null;
}

function rowsToProfileRows(rows: ListOutcome["results"][number][], cap: number): ContextProfileRow[] {
  const out: ContextProfileRow[] = [];
  let budget = MAX_PROFILE_JSON_CHARS;
  for (const r of rows) {
    if (!isParentMemory(r) || !r.text?.trim()) continue;
    const text = clipText(r.text, MAX_ITEM_CHARS);
    const entryLen = text.length + 80;
    if (entryLen > budget || out.length >= cap) break;
    budget -= entryLen;
    out.push({ memory_id: r.id, text, memory_type: r.memory_type ?? null });
  }
  return out;
}

export async function fetchBoundedContextProfile(
  performList: (auth: AuthContext, params: MemoryListParams, supabase: SupabaseClient) => Promise<ListOutcome>,
  auth: AuthContext,
  supabase: SupabaseClient,
  scope: { user_id: string; namespace: string },
): Promise<BoundedContextProfile> {
  const base = (partial: Partial<MemoryListParams>): MemoryListParams => ({
    page: 1,
    page_size: partial.page_size ?? 20,
    namespace: scope.namespace,
    user_id: scope.user_id,
    memory_type: partial.memory_type,
    filters: partial.filters ?? {},
  });

  const [pinnedMeta, pinnedType, notes, prefs] = await Promise.all([
    performList(auth, base({ page_size: 14, filters: { metadata: { pinned: true } } }), supabase),
    performList(auth, base({ page_size: 14, memory_type: "pin" }), supabase),
    performList(auth, base({ page_size: MAX_NOTES + 2, memory_type: "note" }), supabase),
    performList(auth, base({ page_size: MAX_PREFS + 2, memory_type: "preference" }), supabase),
  ]);

  const pinnedMap = new Map<string, ListOutcome["results"][number]>();
  for (const row of [...pinnedMeta.results, ...pinnedType.results]) {
    if (!isParentMemory(row)) continue;
    if (!pinnedMap.has(row.id)) pinnedMap.set(row.id, row);
  }
  const pinnedSorted = [...pinnedMap.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return {
    pinned_facts: rowsToProfileRows(pinnedSorted, MAX_PINNED),
    recent_notes: rowsToProfileRows(notes.results, MAX_NOTES),
    preferences: rowsToProfileRows(prefs.results, MAX_PREFS),
  };
}
