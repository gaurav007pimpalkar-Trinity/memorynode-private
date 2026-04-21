import {
  policyDeniedError,
  type McpActionId,
  type PolicyDecision,
  type PolicyScope,
} from "@memorynodeai/shared";

export function formatDeniedForTool(actionId: McpActionId, scope: PolicyScope, decision: PolicyDecision) {
  const denied = policyDeniedError({
    code: decision.reasonCode ?? "rate_limit_exceeded",
    message: decision.message ?? "Request denied by policy.",
    retryAfterSec: decision.retryAfterSec,
    actionId,
    scope,
    details: {
      ...(typeof decision.estimatedTokens === "number" ? { estimated_tokens: decision.estimatedTokens } : {}),
      ...(decision.budget ? { budget: decision.budget.max_total_tokens } : {}),
      ...(decision.budget ? { budget_tokens: decision.budget } : {}),
      ...(decision.costDecision ? { cost_decision: decision.costDecision } : {}),
      ...(decision.loopConfidence != null ? { confidence: decision.loopConfidence } : {}),
      ...(decision.matchedWindow ? { matched_window: decision.matchedWindow } : {}),
    },
  });
  return {
    content: [{ type: "text" as const, text: denied.error.message }],
    structuredContent: denied,
    isError: true,
  };
}

export function toolError(code: string, message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: {
      error: {
        code,
        message,
        details: details ?? {},
      },
    },
    isError: true,
  };
}
