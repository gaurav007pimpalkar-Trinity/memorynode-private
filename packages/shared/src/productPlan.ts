/**
 * Target product tiers (docs/PLAN.md §6). Workspace `plan` column may still store `free`/`pro`/`team`
 * until migrations rename rows; use {@link productPlanFromWorkspacePlan} for policy and gates.
 */
export type ProductPlanId = "indie" | "studio" | "team";

/** Maps current `workspaces.plan` strings to product tiers until DB stores indie/studio/team directly. */
export function productPlanFromWorkspacePlan(raw: string | null | undefined): ProductPlanId {
  const p = (raw ?? "").trim().toLowerCase();
  if (p === "team") return "team";
  if (p === "free") return "indie";
  return "studio";
}
