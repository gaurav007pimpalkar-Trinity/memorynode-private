/** Thresholds for GET /v1/usage/today `cap_alerts` (daily fair-use vs caps). */

export type UsageCapAlertSeverity = "warning" | "critical";

export type UsageCapAlertResource =
  | "writes"
  | "reads"
  | "embeds"
  | "embed_tokens"
  | "extraction_calls"
  | "gen_tokens"
  | "storage";

export interface UsageCapAlert {
  resource: UsageCapAlertResource;
  severity: UsageCapAlertSeverity;
  used: number;
  cap: number;
  /** used / cap when cap > 0 */
  ratio: number;
}

const WARN = 0.8;
const CRIT = 0.95;

function roundRatio(r: number): number {
  return Math.round(r * 10_000) / 10_000;
}

function alertForDimension(
  used: number,
  cap: number,
  resource: UsageCapAlertResource,
): UsageCapAlert | null {
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const u = Number.isFinite(used) && used >= 0 ? used : 0;
  const ratio = u / cap;
  if (ratio >= 1 || ratio >= CRIT) {
    return { resource, severity: "critical", used: u, cap, ratio: roundRatio(ratio) };
  }
  if (ratio >= WARN) {
    return { resource, severity: "warning", used: u, cap, ratio: roundRatio(ratio) };
  }
  return null;
}

export interface ComputeUsageCapAlertsInput {
  writes: number;
  reads: number;
  embeds: number;
  embed_tokens: number;
  extraction_calls: number;
  gen_tokens: number;
  storage_bytes: number;
  caps: { writes: number; reads: number; embeds: number };
  embed_tokens_cap: number;
  extraction_calls_cap: number;
  gen_tokens_cap: number;
  storage_bytes_cap: number;
}

/** Composite posture for clients (dashboard, SDK) — derived from cap proximity + entitlement telemetry. */
export type OperationalMode = "normal" | "degraded" | "sleep";

const CORE_RESOURCES: UsageCapAlertResource[] = ["writes", "reads", "embeds"];

/**
 * - sleep: a core daily counter (writes/reads/embeds) is at or over the critical band — semantic/write paths may start failing soon.
 * - degraded: entitlement RPC degraded, or any cap warning, or non-core critical only.
 * - normal: otherwise.
 */
export function computeOperationalMode(input: {
  degradedEntitlements: boolean;
  capAlerts: UsageCapAlert[];
  /** Workspace entitlement is in billing grace with Launch-floored caps (see GET /v1/usage/today). */
  graceSoftDowngrade?: boolean;
}): OperationalMode {
  if (input.degradedEntitlements) return "degraded";
  if (input.graceSoftDowngrade) return "degraded";
  for (const a of input.capAlerts) {
    if (a.severity === "critical" && CORE_RESOURCES.includes(a.resource)) return "sleep";
  }
  if (input.capAlerts.length > 0) return "degraded";
  return "normal";
}

export function computeUsageCapAlerts(input: ComputeUsageCapAlertsInput): UsageCapAlert[] {
  const out: UsageCapAlert[] = [];
  const push = (a: UsageCapAlert | null) => {
    if (a) out.push(a);
  };
  push(alertForDimension(input.writes, input.caps.writes, "writes"));
  push(alertForDimension(input.reads, input.caps.reads, "reads"));
  push(alertForDimension(input.embeds, input.caps.embeds, "embeds"));
  push(alertForDimension(input.embed_tokens, input.embed_tokens_cap, "embed_tokens"));
  push(alertForDimension(input.extraction_calls, input.extraction_calls_cap, "extraction_calls"));
  push(alertForDimension(input.gen_tokens, input.gen_tokens_cap, "gen_tokens"));
  push(alertForDimension(input.storage_bytes, input.storage_bytes_cap, "storage"));
  out.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return a.resource.localeCompare(b.resource);
  });
  return out;
}
