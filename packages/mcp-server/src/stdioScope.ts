/** Scope resolution for stdio MCP — isolated for unit tests without booting the server. */

function sanitizeScopePart(raw: string | null, max: number, fallback: string): string {
  if (!raw || !raw.trim()) return fallback;
  const t = raw.trim().slice(0, max);
  const cleaned = t.replace(/[^-a-zA-Z0-9_.:]/g, "_");
  return cleaned.length > 0 ? cleaned : fallback;
}

export function resolveStdioScope(containerTag?: string | null): { user_id: string; namespace: string } {
  const userId = (process.env.MEMORYNODE_USER_ID ?? "default").trim() || "default";
  const defaultNs =
    (process.env.MEMORYNODE_CONTAINER_TAG ?? process.env.MEMORYNODE_NAMESPACE ?? "default").trim() || "default";
  let namespace = sanitizeScopePart(containerTag ?? null, 128, defaultNs);
  const scopedRaw = (process.env.MEMORYNODE_SCOPED_CONTAINER_TAG ?? "").trim();
  const scopedTag = sanitizeScopePart(scopedRaw || null, 128, "");
  if (scopedTag) namespace = scopedTag;
  return { user_id: userId, namespace };
}
