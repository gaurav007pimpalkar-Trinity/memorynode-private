import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env.js";
import { createServiceRoleSupabaseClient } from "../dbClientFactory.js";
import { deleteMemoryCascade } from "../workerApp.js";
import { normalizeTextForMemoryKey, semanticFingerprintFromText } from "../memories/intelligence.js";

type CleanupMemoryRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  owner_id?: string | null;
  owner_type?: "user" | "team" | "app" | null;
  namespace: string;
  text: string;
  metadata?: Record<string, unknown> | null;
  memory_type?: string | null;
  importance?: number | null;
  retrieval_count?: number | null;
  created_at: string;
  duplicate_of?: string | null;
  canonical_hash?: string | null;
  semantic_fingerprint?: string | null;
};

type CleanupStats = {
  deleted_count: number;
  pending_delete_count: number;
  compressed_count: number;
  merged_count: number;
  kept_count: number;
  scanned_count: number;
  candidate_count: number;
};

const CANDIDATE_BATCH_SIZE = 150;
const MAX_DELETES_PER_RUN = 20;
const LOW_IMPORTANCE_THRESHOLD = 40;
const MEDIUM_IMPORTANCE_THRESHOLD = 70;
const LOW_RETRIEVAL_THRESHOLD = 3;
const LOW_RETRIEVAL_CANDIDATE_MAX = 5;
const OLD_MEMORY_DAYS = 30;
const RECENT_SAFETY_DAYS = 7;
const SUMMARY_VERY_OLD_DAYS = 180;
const COMPRESS_MIN_AGE_DAYS = 60;
const DELETE_SOFT_BUFFER_HOURS = 48;
const RECENT_ACCESS_GUARD_DAYS = 7;
const MIN_COMPRESS_TEXT_CHARS = 180;

let runtimeEnv: Env | null = null;
let runtimeWorkspaceIds: string[] = [];

export function setMemoryCleanupJobConfig(config: { env: Env }): void {
  runtimeEnv = config.env;
  const csv = String((config.env as Env & { MEMORY_CLEANUP_WORKSPACE_IDS?: string }).MEMORY_CLEANUP_WORKSPACE_IDS ?? "");
  runtimeWorkspaceIds = csv
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function ageDays(createdAt: string): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / (24 * 60 * 60 * 1000));
}

function isProtectedFromDelete(row: CleanupMemoryRow): boolean {
  const importance = Number(row.importance ?? 1);
  const days = ageDays(row.created_at);
  const type = (row.memory_type ?? "").toLowerCase();
  if (importance > 70) return true;
  if (days < RECENT_SAFETY_DAYS) return true;
  if (type === "summary" && days < SUMMARY_VERY_OLD_DAYS) return true;
  return false;
}

function normalizeImportance(v: number | null | undefined): number {
  if (!Number.isFinite(Number(v))) return 1;
  return Math.max(0.01, Math.min(100, Number(v)));
}

function normalizeRetrievalCount(v: number | null | undefined): number {
  if (!Number.isFinite(Number(v))) return 0;
  return Math.max(0, Number(v));
}

function parseMetadata(meta: unknown): Record<string, unknown> {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta as Record<string, unknown>;
  return {};
}

function pendingDeleteAt(meta: Record<string, unknown>): string | null {
  const at = meta._cleanup_pending_delete_at;
  return typeof at === "string" && at.trim() ? at.trim() : null;
}

function isSoftDeleteReady(meta: Record<string, unknown>): boolean {
  const at = pendingDeleteAt(meta);
  if (!at) return false;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms >= DELETE_SOFT_BUFFER_HOURS * 60 * 60 * 1000;
}

function clipText(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}...`;
}

function buildCompressedText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const sentences = cleaned
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) return clipText(cleaned, 260);
  const head = sentences.slice(0, 2).join(". ");
  return clipText(head, 260);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function insertCompressedMemory(
  supabase: SupabaseClient,
  source: CleanupMemoryRow,
  compressedText: string,
): Promise<string | null> {
  const ownerId = source.owner_id ?? source.user_id;
  const ownerType = source.owner_type ?? "user";
  const canonicalHash = await sha256Hex(
    `${source.workspace_id}:${source.user_id}:${source.namespace}:compressed:${normalizeTextForMemoryKey(compressedText)}`,
  );
  const insert = await supabase
    .from("memories")
    .insert({
      workspace_id: source.workspace_id,
      user_id: source.user_id,
      owner_id: ownerId,
      owner_type: ownerType,
      namespace: source.namespace,
      text: compressedText,
      memory_type: "compressed",
      importance: Math.max(25, Math.min(55, normalizeImportance(source.importance) * 0.8)),
      metadata: {
        source: "memory_cleanup_compress",
        compressed_from_memory_id: source.id,
        original_memory_type: source.memory_type ?? "note",
      },
      canonical_hash: canonicalHash,
      semantic_fingerprint: semanticFingerprintFromText(compressedText),
    })
    .select("id")
    .single();
  if (insert.error || !insert.data) return null;
  return String((insert.data as { id?: unknown }).id ?? "");
}

async function archiveAsSuperseded(
  supabase: SupabaseClient,
  source: CleanupMemoryRow,
  replacementId: string,
): Promise<void> {
  const currentMeta = source.metadata ?? {};
  await supabase
    .from("memories")
    .update({
      duplicate_of: replacementId,
      conflict_state: "superseded",
      last_conflict_at: new Date().toISOString(),
      metadata: {
        ...currentMeta,
        _archived: true,
        _archived_at: new Date().toISOString(),
        _cleanup_action: "superseded",
      },
    })
    .eq("workspace_id", source.workspace_id)
    .eq("id", source.id)
    .is("duplicate_of", null);
}

async function markPendingDelete(
  supabase: SupabaseClient,
  row: CleanupMemoryRow,
): Promise<boolean> {
  const meta = parseMetadata(row.metadata);
  const nextMeta = {
    ...meta,
    _cleanup_pending_delete: true,
    _cleanup_pending_delete_at: new Date().toISOString(),
    _cleanup_action: "pending_delete",
  };
  const result = await supabase
    .from("memories")
    .update({ metadata: nextMeta })
    .eq("workspace_id", row.workspace_id)
    .eq("id", row.id)
    .is("duplicate_of", null);
  return !result.error;
}

async function fetchRecentlyAccessedMemoryIds(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryIds: string[],
): Promise<Set<string>> {
  const recent = new Set<string>();
  if (memoryIds.length === 0) return recent;
  const cutoffIso = daysAgoIso(RECENT_ACCESS_GUARD_DAYS);
  const rows = await supabase
    .from("memory_chunks")
    .select("memory_id,last_accessed_at")
    .eq("workspace_id", workspaceId)
    .in("memory_id", memoryIds)
    .gte("last_accessed_at", cutoffIso);
  if (!Array.isArray(rows.data)) return recent;
  for (const row of rows.data) {
    const id = String((row as { memory_id?: unknown }).memory_id ?? "");
    if (id) recent.add(id);
  }
  return recent;
}

function isOverCompressionRisk(row: CleanupMemoryRow): boolean {
  const type = (row.memory_type ?? "").toLowerCase();
  if (type === "compressed") return true;
  const text = row.text?.trim() ?? "";
  if (text.length < MIN_COMPRESS_TEXT_CHARS) return true;
  const meta = parseMetadata(row.metadata);
  if (meta.compressed_from_memory_id != null) return true;
  return false;
}

async function persistCleanupAnalytics(
  supabase: SupabaseClient,
  stats: CleanupStats,
): Promise<void> {
  const deleteRate = stats.candidate_count > 0 ? stats.deleted_count / stats.candidate_count : 0;
  try {
    await supabase.from("product_events").insert({
      workspace_id: null,
      event_name: "memory_cleanup_run",
      props: {
        deleted_count: stats.deleted_count,
        pending_delete_count: stats.pending_delete_count,
        compressed_count: stats.compressed_count,
        merged_count: stats.merged_count,
        kept_count: stats.kept_count,
        scanned_count: stats.scanned_count,
        candidate_count: stats.candidate_count,
        cleanup_delete_rate: deleteRate,
      },
    });
  } catch {
    // best effort analytics only
  }
}

type DuplicateGroupMap = Map<string, CleanupMemoryRow[]>;

function duplicateKeyForRow(row: CleanupMemoryRow): string {
  const canonical = typeof row.canonical_hash === "string" ? row.canonical_hash.trim() : "";
  if (canonical) return `canonical:${canonical}`;
  const semantic = typeof row.semantic_fingerprint === "string" ? row.semantic_fingerprint.trim() : "";
  if (semantic) return `semantic:${semantic}`;
  return "";
}

function buildDuplicateGroups(rows: CleanupMemoryRow[]): DuplicateGroupMap {
  const groups = new Map<string, CleanupMemoryRow[]>();
  for (const row of rows) {
    const key = duplicateKeyForRow(row);
    if (!key) continue;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  for (const [key, vals] of groups.entries()) {
    if (vals.length < 2) groups.delete(key);
  }
  return groups;
}

function pickMergeWinner(group: CleanupMemoryRow[]): CleanupMemoryRow {
  return [...group].sort((a, b) => {
    const imp = normalizeImportance(b.importance) - normalizeImportance(a.importance);
    if (Math.abs(imp) > 1e-8) return imp;
    const rc = normalizeRetrievalCount(b.retrieval_count) - normalizeRetrievalCount(a.retrieval_count);
    if (Math.abs(rc) > 1e-8) return rc;
    return String(b.created_at).localeCompare(String(a.created_at));
  })[0];
}

async function mergeDuplicateGroup(
  supabase: SupabaseClient,
  group: CleanupMemoryRow[],
): Promise<boolean> {
  if (group.length < 2) return false;
  const winner = pickMergeWinner(group);
  const mergedText = clipText(
    group
      .map((row) => row.text)
      .filter((t) => typeof t === "string" && t.trim().length > 0)
      .join("\n\n"),
    1600,
  );
  if (!mergedText) return false;

  const ownerId = winner.owner_id ?? winner.user_id;
  const ownerType = winner.owner_type ?? "user";
  const mergedCanonicalHash = await sha256Hex(
    `${winner.workspace_id}:${winner.user_id}:${winner.namespace}:${winner.memory_type ?? "note"}:${normalizeTextForMemoryKey(mergedText)}`,
  );
  const insert = await supabase
    .from("memories")
    .insert({
      workspace_id: winner.workspace_id,
      user_id: winner.user_id,
      owner_id: ownerId,
      owner_type: ownerType,
      namespace: winner.namespace,
      text: mergedText,
      memory_type: winner.memory_type ?? "note",
      importance: normalizeImportance(winner.importance),
      metadata: {
        source: "memory_cleanup_merge",
        merged_from_memory_ids: group.map((row) => row.id),
      },
      canonical_hash: mergedCanonicalHash,
      semantic_fingerprint: semanticFingerprintFromText(mergedText),
    })
    .select("id")
    .single();
  if (insert.error || !insert.data) return false;
  const mergedId = String((insert.data as { id?: unknown }).id ?? "");
  if (!mergedId) return false;

  const sourceIds = group.map((row) => row.id);
  await supabase
    .from("memories")
    .update({
      duplicate_of: mergedId,
      conflict_state: "superseded",
      last_conflict_at: new Date().toISOString(),
    })
    .eq("workspace_id", winner.workspace_id)
    .in("id", sourceIds)
    .is("duplicate_of", null);
  return true;
}

async function fetchCleanupCandidates(supabase: SupabaseClient, workspaceId: string): Promise<CleanupMemoryRow[]> {
  const oldCutoffIso = daysAgoIso(OLD_MEMORY_DAYS);
  const q = await supabase
    .from("memories")
    .select(
      "id,workspace_id,user_id,owner_id,owner_type,namespace,text,metadata,memory_type,importance,retrieval_count,created_at,duplicate_of,canonical_hash,semantic_fingerprint",
    )
    .eq("workspace_id", workspaceId)
    .is("duplicate_of", null)
    .lt("created_at", oldCutoffIso)
    .lt("importance", MEDIUM_IMPORTANCE_THRESHOLD)
    .lt("retrieval_count", LOW_RETRIEVAL_CANDIDATE_MAX)
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_BATCH_SIZE);
  if (q.error || !Array.isArray(q.data)) return [];
  return q.data as CleanupMemoryRow[];
}

export async function runMemoryCleanupJob(): Promise<void> {
  const stats: CleanupStats = {
    deleted_count: 0,
    pending_delete_count: 0,
    compressed_count: 0,
    merged_count: 0,
    kept_count: 0,
    scanned_count: 0,
    candidate_count: 0,
  };
  if (!runtimeEnv) {
    console.log("Memory cleanup run:", { ...stats, skipped: "missing_runtime_env" });
    return;
  }

  const supabase = createServiceRoleSupabaseClient(runtimeEnv);
  const workspaceIds = [...runtimeWorkspaceIds];
  if (workspaceIds.length === 0) {
    const trace = {
      memory_cleanup: {
        deleted: stats.deleted_count,
        compressed: stats.compressed_count,
        merged: stats.merged_count,
      },
    };
    console.log("Memory cleanup run:", { ...stats, trace });
    return;
  }
  let deletesUsed = 0;
  for (const workspaceId of workspaceIds) {
    const candidates = await fetchCleanupCandidates(supabase, workspaceId);
    stats.candidate_count += candidates.length;
    stats.scanned_count += candidates.length;
    if (candidates.length === 0) continue;

    const handledIds = new Set<string>();
    const recentlyAccessedIds = await fetchRecentlyAccessedMemoryIds(
      supabase,
      workspaceId,
      candidates.map((row) => row.id),
    );
    const duplicateGroups = buildDuplicateGroups(candidates);
    for (const group of duplicateGroups.values()) {
      const merged = await mergeDuplicateGroup(supabase, group);
      if (merged) {
        stats.merged_count += 1;
        for (const row of group) handledIds.add(row.id);
      } else {
        stats.kept_count += group.length;
      }
    }

    for (const row of candidates) {
      if (handledIds.has(row.id)) continue;

      const rowAgeDays = ageDays(row.created_at);
      const importance = normalizeImportance(row.importance);
      const retrievalCount = normalizeRetrievalCount(row.retrieval_count);
      const lowImportance = importance < LOW_IMPORTANCE_THRESHOLD;
      const lowUsage = retrievalCount < LOW_RETRIEVAL_THRESHOLD;
      const oldEnough = rowAgeDays >= OLD_MEMORY_DAYS;
      const mediumImportance = importance >= LOW_IMPORTANCE_THRESHOLD && importance <= MEDIUM_IMPORTANCE_THRESHOLD;
      const recentlyAccessed = recentlyAccessedIds.has(row.id);
      const rowMeta = parseMetadata(row.metadata);
      const hasPendingDelete = rowMeta._cleanup_pending_delete === true || pendingDeleteAt(rowMeta) != null;

      if (
        lowImportance &&
        lowUsage &&
        oldEnough &&
        deletesUsed < MAX_DELETES_PER_RUN &&
        !isProtectedFromDelete(row) &&
        !recentlyAccessed
      ) {
        try {
          if (hasPendingDelete && isSoftDeleteReady(rowMeta)) {
            const deleted = await deleteMemoryCascade(supabase, row.workspace_id, row.id);
            if (deleted) {
              deletesUsed += 1;
              stats.deleted_count += 1;
              handledIds.add(row.id);
              continue;
            }
          } else if (!hasPendingDelete) {
            const marked = await markPendingDelete(supabase, row);
            if (marked) {
              stats.pending_delete_count += 1;
              handledIds.add(row.id);
              continue;
            }
          }
        } catch {
          // best-effort cleanup; keep on errors
        }
      }

      if (mediumImportance && rowAgeDays >= COMPRESS_MIN_AGE_DAYS && !isOverCompressionRisk(row)) {
        const compressedText = buildCompressedText(row.text);
        if (compressedText) {
          const newCompressedId = await insertCompressedMemory(supabase, row, compressedText);
          if (newCompressedId) {
            await archiveAsSuperseded(supabase, row, newCompressedId);
            stats.compressed_count += 1;
            handledIds.add(row.id);
            continue;
          }
        }
      }

      stats.kept_count += 1;
    }
  }

  const trace = {
    memory_cleanup: {
      deleted: stats.deleted_count,
      compressed: stats.compressed_count,
      merged: stats.merged_count,
      cleanup_delete_rate: stats.candidate_count > 0 ? stats.deleted_count / stats.candidate_count : 0,
    },
  };
  await persistCleanupAnalytics(supabase, stats);
  console.log("Memory cleanup run:", { ...stats, trace });
}
