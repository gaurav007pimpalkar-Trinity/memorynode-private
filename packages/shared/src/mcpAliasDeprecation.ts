export type DeprecationPhase = "allow" | "warn" | "block";

export type AliasDecision = {
  blocked: boolean;
  warning?: {
    warning: "deprecated_tool";
    use: string;
  };
};

export function normalizeDeprecationPhase(input?: string): DeprecationPhase {
  const value = (input ?? "allow").toLowerCase();
  if (value === "warn" || value === "block") return value;
  return "allow";
}

export function resolveAliasDecision(phase: DeprecationPhase, canonical: string): AliasDecision {
  if (phase === "block") return { blocked: true };
  if (phase === "warn") return { blocked: false, warning: { warning: "deprecated_tool", use: canonical } };
  return { blocked: false };
}
