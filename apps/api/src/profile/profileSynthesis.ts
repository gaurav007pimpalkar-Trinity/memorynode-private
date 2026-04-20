import type { SupabaseClient } from "@supabase/supabase-js";

interface ProfileMemoryRow {
  id: string;
  text: string;
  memory_type: string | null;
  confidence: number | null;
  priority_score: number | null;
  conflict_state: string | null;
  source_memory_id: string | null;
}

function trimProfileLine(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 220 ? `${t.slice(0, 219)}…` : t;
}

function sorted(rows: ProfileMemoryRow[]): ProfileMemoryRow[] {
  return [...rows].sort((a, b) => {
    const scoreA = Number(a.priority_score ?? 0.5) * 0.7 + Number(a.confidence ?? 0.5) * 0.3;
    const scoreB = Number(b.priority_score ?? 0.5) * 0.7 + Number(b.confidence ?? 0.5) * 0.3;
    return scoreB - scoreA;
  });
}

export async function updateProfileSnapshot(
  supabase: SupabaseClient,
  args: {
    workspaceId: string;
    containerTag: string;
    userId: string;
  },
): Promise<void> {
  const q = await supabase
    .from("memories")
    .select("id,text,memory_type,confidence,priority_score,conflict_state,source_memory_id")
    .eq("workspace_id", args.workspaceId)
    .eq("user_id", args.userId)
    .eq("namespace", args.containerTag)
    .is("duplicate_of", null)
    .order("created_at", { ascending: false })
    .limit(220);
  if (q.error || !Array.isArray(q.data)) return;

  const rows = (q.data as ProfileMemoryRow[])
    .filter((r) => r.source_memory_id == null)
    .filter((r) => (r.conflict_state ?? "none") !== "superseded");

  const facts = sorted(rows.filter((r) => r.memory_type === "fact")).slice(0, 15).map((r) => trimProfileLine(r.text));
  const preferences = sorted(rows.filter((r) => r.memory_type === "preference")).slice(0, 15).map((r) => trimProfileLine(r.text));
  const events = sorted(rows.filter((r) => r.memory_type === "event")).slice(0, 12).map((r) => trimProfileLine(r.text));
  const tasks = sorted(rows.filter((r) => r.memory_type === "task")).slice(0, 10).map((r) => trimProfileLine(r.text));

  const confidenceAvg = rows.length > 0
    ? rows.reduce((acc, row) => acc + Number(row.confidence ?? 0.5), 0) / rows.length
    : 0;

  const profile = {
    generated_at: new Date().toISOString(),
    memory_count: rows.length,
    facts,
    preferences,
    events,
    tasks,
    summary: {
      top_facts: facts.slice(0, 5),
      top_preferences: preferences.slice(0, 5),
      active_tasks: tasks.slice(0, 5),
    },
  };

  await supabase
    .from("memory_profiles")
    .upsert(
      {
        workspace_id: args.workspaceId,
        container_tag: args.containerTag,
        profile,
        confidence: confidenceAvg,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,container_tag" },
    );
}
