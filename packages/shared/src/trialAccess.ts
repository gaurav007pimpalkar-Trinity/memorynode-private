/**
 * Trial eligibility for write paths (REST + MCP). Reads stay allowed after trial end.
 * Aligns with `workspaces.trial` + `workspaces.trial_expires_at` from auth.
 */

export function trialExpiredBlocksWrites(auth: {
  trial?: boolean;
  trialExpiresAt?: string | null;
}): boolean {
  if (auth.trial !== true) return false;
  const raw = auth.trialExpiresAt;
  if (raw == null || typeof raw !== "string" || raw.trim() === "") return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}
