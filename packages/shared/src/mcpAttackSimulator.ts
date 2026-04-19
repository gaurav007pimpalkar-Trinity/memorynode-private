import { McpPolicyEngine, estimateCost, type McpErrorCode, type PolicyInput, type PolicyScope } from "./mcpPolicy.js";

export type AttackType =
  | "loop_spam"
  | "paraphrase_drift"
  | "fragmented_cost_attack"
  | "replay_attempts"
  | "cache_abuse"
  | "mixed_attack";

export type AttackSimulationConfig = {
  attackType: AttackType;
  steps: number;
  startMs?: number;
  scope?: PolicyScope;
  policy?: McpPolicyEngine;
};

export type AttackFailure = {
  step: number;
  reason: McpErrorCode | "unknown";
  action_id: PolicyInput["actionId"];
  message: string;
};

export type AttackSimulationReport = {
  attack_type: AttackType;
  total_calls: number;
  accepted: number;
  rejected: number;
  total_cost_estimate: number;
  policy_triggers: Record<string, number>;
  failures: AttackFailure[];
};

const DEFAULT_SCOPE: PolicyScope = {
  workspaceId: "sim-workspace",
  keyId: "sim-key",
  userId: "sim-user",
  namespace: "sim-namespace",
  sessionId: "sim-session",
};

const DRIFT_QUERIES = [
  "what color theme does user prefer",
  "tell me user preferred color theme",
  "which theme color does the user like",
  "what visual style does the user usually choose",
  "which look and feel does user pick most",
  "describe the design vibe user prefers",
];

function baseInput(scope: PolicyScope, nowMs: number): Omit<PolicyInput, "actionId"> {
  return {
    scope,
    nowMs,
  };
}

function buildStep(attackType: AttackType, scope: PolicyScope, i: number, nowMs: number): PolicyInput {
  const base = baseInput(scope, nowMs);
  if (attackType === "loop_spam") {
    return {
      ...base,
      actionId: "recall",
      queryText: "repeat loop query about user preference",
      topK: 4,
    };
  }
  if (attackType === "paraphrase_drift") {
    return {
      ...base,
      actionId: "recall",
      queryText: DRIFT_QUERIES[i % DRIFT_QUERIES.length],
      topK: 4,
    };
  }
  if (attackType === "fragmented_cost_attack") {
    return {
      ...base,
      actionId: i % 2 === 0 ? "context" : "recall",
      queryText: `fragmented request ${i} ${"q".repeat(48 + (i % 7) * 10)}`,
      topK: 8,
      includeProfile: i % 3 !== 0,
    };
  }
  if (attackType === "replay_attempts") {
    const nonce = i < 2 ? "reused-nonce" : `nonce-${Math.floor(i / 3)}`;
    return {
      ...base,
      actionId: "memory.forget",
      contentText: `forget target text ${i}`,
      nonce,
      timestampMs: nowMs,
    };
  }
  if (attackType === "cache_abuse") {
    const noisySuffix = i % 4 === 0 ? `x${i}` : `${i % 2}`;
    return {
      ...base,
      actionId: "context",
      queryText: `cache abuse probe ${noisySuffix}`,
      topK: 3 + (i % 3),
    };
  }

  const cycle: AttackType[] = ["loop_spam", "fragmented_cost_attack", "replay_attempts", "paraphrase_drift", "cache_abuse"];
  return buildStep(cycle[i % cycle.length], scope, i, nowMs);
}

export function runAttackSimulation(config: AttackSimulationConfig): AttackSimulationReport {
  const policy = config.policy ?? new McpPolicyEngine();
  const scope = config.scope ?? DEFAULT_SCOPE;
  const startMs = config.startMs ?? 1_000;

  const report: AttackSimulationReport = {
    attack_type: config.attackType,
    total_calls: config.steps,
    accepted: 0,
    rejected: 0,
    total_cost_estimate: 0,
    policy_triggers: {},
    failures: [],
  };

  for (let i = 0; i < config.steps; i++) {
    const nowMs = startMs + i * 250;
    const input = buildStep(config.attackType, scope, i, nowMs);
    report.total_cost_estimate += estimateCost(input).totalTokens;
    const decision = policy.evaluate(input);
    if (decision.status === "deny") {
      report.rejected += 1;
      const trigger = decision.reasonCode ?? "unknown";
      report.policy_triggers[trigger] = (report.policy_triggers[trigger] ?? 0) + 1;
      report.failures.push({
        step: i + 1,
        reason: trigger,
        action_id: input.actionId,
        message: decision.message ?? "Request denied by policy.",
      });
      continue;
    }

    report.accepted += 1;
    if (decision.status === "degrade") {
      report.policy_triggers.degrade = (report.policy_triggers.degrade ?? 0) + 1;
    }
    policy.complete(input);
  }

  return report;
}
