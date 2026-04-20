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
  const snapshot = await supabase
    .from("memory_profiles")
    .select("profile")
    .eq("workspace_id", auth.workspaceId)
    .eq("container_tag", scope.namespace)
    .maybeSingle();
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
  const profileJson = (!snapshot.error ? snapshot.data?.profile : null) as
    | { summary?: { top_facts?: string[]; top_preferences?: string[] } }
    | null;
  const summaryTopFacts = Array.isArray(profileJson?.summary?.top_facts)
    ? profileJson?.summary?.top_facts.filter((v): v is string => typeof v === "string").slice(0, 4)
    : [];
  const summaryTopPrefs = Array.isArray(profileJson?.summary?.top_preferences)
    ? profileJson?.summary?.top_preferences.filter((v): v is string => typeof v === "string").slice(0, 4)
    : [];
  const summaryRowsFacts: ContextProfileRow[] = summaryTopFacts.map((text, idx) => ({
    memory_id: `profile-fact-${idx + 1}`,
    text: clipText(text, MAX_ITEM_CHARS),
    memory_type: "fact",
  }));
  const summaryRowsPrefs: ContextProfileRow[] = summaryTopPrefs.map((text, idx) => ({
    memory_id: `profile-pref-${idx + 1}`,
    text: clipText(text, MAX_ITEM_CHARS),
    memory_type: "preference",
  }));
  const mergedPinned = [...summaryRowsFacts, ...rowsToProfileRows(pinnedSorted, MAX_PINNED)];
  const mergedPrefs = [...summaryRowsPrefs, ...rowsToProfileRows(prefs.results, MAX_PREFS)];
  const dedupeRows = (rows: ContextProfileRow[], cap: number): ContextProfileRow[] => {
    const seen = new Set<string>();
    const out: ContextProfileRow[] = [];
    for (const row of rows) {
      const key = row.text.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= cap) break;
    }
    return out;
  };

  return {
    pinned_facts: dedupeRows(mergedPinned, MAX_PINNED),
    recent_notes: rowsToProfileRows(notes.results, MAX_NOTES),
    preferences: dedupeRows(mergedPrefs, MAX_PREFS),
  };
}
