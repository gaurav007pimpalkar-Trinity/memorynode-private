/**
 * Per-project Memory Lab identity for API subject user id + scope (namespace).
 * Stored as a single localStorage object: memorynode.identity = { [projectId]: { userId, scope } }.
 * Project id is the internal workspace UUID — never shown in UI as "workspace".
 */

export const MEMORY_NODE_IDENTITY_KEY = "memorynode.identity";

export type MemoryLabStoredIdentity = {
  subjectUserId: string;
  namespace: string;
};

type IdentityMap = Record<string, { userId?: string; scope?: string }>;

const LEGACY_PREFIX = "mn_memory_lab:";

function readMap(): IdentityMap {
  try {
    const raw = localStorage.getItem(MEMORY_NODE_IDENTITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as IdentityMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: IdentityMap): void {
  try {
    localStorage.setItem(MEMORY_NODE_IDENTITY_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Migrate legacy per-project key into the unified map, then remove legacy. */
function migrateLegacyProject(projectId: string, map: IdentityMap): IdentityMap {
  const legacyKey = `${LEGACY_PREFIX}${projectId.trim()}`;
  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Partial<{ subjectUserId?: string; namespace?: string }>;
    const next = { ...map };
    if (!next[projectId]?.userId && !next[projectId]?.scope) {
      next[projectId] = {
        userId: typeof parsed.subjectUserId === "string" ? parsed.subjectUserId : "",
        scope: typeof parsed.namespace === "string" ? parsed.namespace : "",
      };
      writeMap(next);
    }
    localStorage.removeItem(legacyKey);
    return next;
  } catch {
    return map;
  }
}

export function loadMemoryLabIdentity(projectId: string): MemoryLabStoredIdentity {
  if (!projectId?.trim()) return { subjectUserId: "", namespace: "" };
  const pid = projectId.trim();
  let map = readMap();
  map = migrateLegacyProject(pid, map);
  const row = map[pid];
  return {
    subjectUserId: typeof row?.userId === "string" ? row.userId : "",
    namespace: typeof row?.scope === "string" ? row.scope : "",
  };
}

export function persistMemoryLabIdentity(projectId: string, identity: MemoryLabStoredIdentity): void {
  if (!projectId?.trim()) return;
  const pid = projectId.trim();
  let map = readMap();
  map = migrateLegacyProject(pid, map);
  map[pid] = { userId: identity.subjectUserId, scope: identity.namespace };
  writeMap(map);
}
