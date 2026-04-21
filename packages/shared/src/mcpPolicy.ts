export const MCP_POLICY_VERSION = "2026-04-19.1";

export type McpActionId =
  | "memory.save"
  | "memory.forget"
  | "memory.confirm_forget"
  | "memory.read"
  | "memory.delete"
  | "memory.conversation_save"
  | "ingest.dispatch"
  | "eval.run"
  | "usage.today"
  | "audit.log.list"
  | "billing.status"
  | "billing.checkout.create"
  | "billing.portal.create"
  | "connector.settings.get"
  | "connector.settings.update"
  | "recall"
  | "context"
  | "whoAmI";

export type PolicyDecisionStatus = "allow" | "deny" | "degrade" | "needs_confirmation";

export type McpErrorCode =
  | "rate_limit_exceeded"
  | "loop_detected"
  | "loop_detected_drift"
  | "cost_exceeded"
  | "cost_exceeded_session"
  | "weak_signal"
  | "unauthorized_scope"
  | "session_expired"
  | "confirmation_required"
  | "replay_detected";

export type PolicyScope = {
  workspaceId: string;
  keyId: string;
  userId: string;
  namespace: string;
  sessionId: string;
};

export type PolicyInput = {
  actionId: McpActionId;
  scope: PolicyScope;
  nowMs: number;
  queryText?: string;
  contentText?: string;
  topK?: number;
  includeProfile?: boolean;
  nonce?: string;
  timestampMs?: number;
};

export type CostBudget = {
  max_input_tokens: number;
  max_output_tokens: number;
  max_total_tokens: number;
};

export type CostEstimate = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type PolicyDecision = {
  status: PolicyDecisionStatus;
  reasonCode?: McpErrorCode;
  message?: string;
  retryAfterSec?: number;
  degradeLevel?: "reduce_top_k" | "disable_profile" | "disable_extraction";
  appliedTopK?: number;
  decisionId: string;
  estimatedTokens?: number;
  budget?: CostBudget;
  costDecision?: "allow" | "degrade" | "deny";
  loopConfidence?: number;
  matchedWindow?: string[];
  noveltyScore?: number;
  driftScore?: number;
  sessionWindowTokens?: number;
  sessionWindowRemaining?: number;
  truncateInstruction?: { max_output_tokens: number };
};

type LimitsConfig = {
  sessionWindowMs: number;
  keyWindowMs: number;
  scopeWindowMs: number;
  sessionTotalCalls: number;
  sessionRecallCalls: number;
  sessionWriteCalls: number;
  keyReadCalls: number;
  keyWriteCalls: number;
  scopeWriteCalls: number;
  scopeForgetCalls: number;
  scopeWriteBurstLimit: number;
  scopeWriteBurstWindowMs: number;
  similarityThreshold: number;
  noveltyThreshold: number;
  idempotencyThreshold: number;
  loopWindowMs: number;
  loopThreshold: number;
  replayWindowMs: number;
  perTurnCostBudget: number;
  maxInFlightPerKey: number;
  maxInFlightPerScope: number;
  maxActionWindow: number;
  maxNonceEntries: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxTokensPerSessionWindow: number;
  sessionBudgetWindowMs: number;
  driftSimilarityThreshold: number;
  driftScoreThreshold: number;
  driftDecayHalfLifeMs: number;
};

export type PolicyHooks = {
  beforePolicy?: (input: PolicyInput) => void;
  afterPolicy?: (input: PolicyInput, decision: PolicyDecision, latencyMs: number) => void;
  afterExecution?: (args: {
    actionId: McpActionId;
    decision: PolicyDecisionStatus;
    reason?: McpErrorCode;
    latencyMs: number;
    sessionId: string;
    scores?: { similarity?: number; novelty?: number };
  }) => void;
};

export type PolicyMetricsSnapshot = {
  decisions: Record<string, number>;
  rejections: number;
  loopTriggers: number;
  writeAccepted: number;
  writeRejected: number;
  latenciesMs: number[];
};

const DEFAULTS: LimitsConfig = {
  sessionWindowMs: 10 * 60_000,
  keyWindowMs: 60 * 60_000,
  scopeWindowMs: 60 * 60_000,
  sessionTotalCalls: 40,
  sessionRecallCalls: 12,
  sessionWriteCalls: 6,
  keyReadCalls: 300,
  keyWriteCalls: 60,
  scopeWriteCalls: 20,
  scopeForgetCalls: 10,
  scopeWriteBurstLimit: 2,
  scopeWriteBurstWindowMs: 30_000,
  similarityThreshold: 0.92,
  noveltyThreshold: 0.95,
  idempotencyThreshold: 0.97,
  loopWindowMs: 120_000,
  loopThreshold: 3,
  replayWindowMs: 60_000,
  perTurnCostBudget: 100,
  maxInFlightPerKey: 6,
  maxInFlightPerScope: 3,
  maxActionWindow: 10,
  maxNonceEntries: 5000,
  maxInputTokens: 1200,
  maxOutputTokens: 2200,
  maxTotalTokens: 2800,
  maxTokensPerSessionWindow: 9000,
  sessionBudgetWindowMs: 60_000,
  driftSimilarityThreshold: 0.72,
  driftScoreThreshold: 1.6,
  driftDecayHalfLifeMs: 60_000,
};

type TimelineEntry = { at: number; value: string; vector: Map<string, number> };
type TokenEvent = { at: number; tokens: number };
type DriftState = { score: number; lastAt: number };

type ConfirmationRecord = {
  token: string;
  expiresAt: number;
  scopeKey: string;
  action: McpActionId;
  memoryId: string;
};

function scopeKey(scope: PolicyScope): string {
  return `${scope.workspaceId}:${scope.userId}:${scope.namespace}`;
}

function sessionKey(scope: PolicyScope): string {
  return `${scope.workspaceId}:${scope.keyId}:${scope.sessionId}`;
}

function actionIsWrite(action: McpActionId): boolean {
  return (
    action === "memory.save" ||
    action === "memory.forget" ||
    action === "memory.confirm_forget" ||
    action === "memory.delete" ||
    action === "memory.conversation_save" ||
    action === "ingest.dispatch" ||
    action === "eval.run" ||
    action === "billing.checkout.create" ||
    action === "billing.portal.create" ||
    action === "connector.settings.update"
  );
}

function actionIsRead(action: McpActionId): boolean {
  return (
    action === "recall" ||
    action === "context" ||
    action === "memory.read" ||
    action === "usage.today" ||
    action === "audit.log.list" ||
    action === "billing.status" ||
    action === "connector.settings.get"
  );
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(input: string): string[] {
  return normalizeText(input).split(" ").filter((x) => x.length > 1);
}

function tokenSet(text: string): Set<string> {
  return new Set(words(text));
}

function tokenVector(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words(text)) out.set(w, (out.get(w) ?? 0) + 1);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const token of a) {
    if (b.has(token)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  return union <= 0 ? 0 : intersect / union;
}

function cosineFromTf(a: string, b: string): number {
  const aw = words(a);
  const bw = words(b);
  if (aw.length === 0 || bw.length === 0) return 0;
  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  for (const w of aw) freqA.set(w, (freqA.get(w) ?? 0) + 1);
  for (const w of bw) freqB.set(w, (freqB.get(w) ?? 0) + 1);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of freqA.values()) normA += v * v;
  for (const v of freqB.values()) normB += v * v;
  for (const [w, v] of freqA.entries()) {
    const bv = freqB.get(w) ?? 0;
    dot += v * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return dot / denom;
}

function cosineFromVectors(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  for (const [k, av] of a.entries()) {
    const bv = b.get(k) ?? 0;
    dot += av * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return dot / denom;
}

function centroidVector(rows: TimelineEntry[]): Map<string, number> {
  const sum = new Map<string, number>();
  if (rows.length === 0) return sum;
  for (const row of rows) {
    for (const [k, v] of row.vector.entries()) {
      sum.set(k, (sum.get(k) ?? 0) + v);
    }
  }
  const inv = 1 / rows.length;
  for (const [k, v] of sum.entries()) sum.set(k, v * inv);
  return sum;
}

function hashToken(input: string): string {
  return input
    .split("")
    .reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381)
    .toString(16)
    .slice(0, 8);
}

function pushTime(map: Map<string, number[]>, key: string, now: number): number[] {
  const arr = map.get(key) ?? [];
  arr.push(now);
  map.set(key, arr);
  return arr;
}

function pruneTimes(entries: number[], now: number, windowMs: number): number[] {
  return entries.filter((t) => now - t <= windowMs);
}

export function estimateCost(input: PolicyInput): CostEstimate {
  const text = `${normalizeText(input.queryText ?? "")} ${normalizeText(input.contentText ?? "")}`.trim();
  const inputTokens = Math.ceil(Math.max(1, text.length) / 4);
  const topK = Math.max(1, Math.min(20, input.topK ?? 5));
  let outputTokens = 64;
  if (input.actionId === "memory.save") outputTokens = 96;
  if (input.actionId === "memory.forget" || input.actionId === "memory.confirm_forget") outputTokens = 128;
  if (input.actionId === "memory.read") outputTokens = 140;
  if (input.actionId === "memory.delete") outputTokens = 96;
  if (input.actionId === "memory.conversation_save") outputTokens = 160;
  if (input.actionId === "ingest.dispatch") outputTokens = 200;
  if (input.actionId === "eval.run") outputTokens = 420;
  if (input.actionId === "usage.today") outputTokens = 110;
  if (input.actionId === "audit.log.list") outputTokens = 240;
  if (input.actionId === "billing.status") outputTokens = 130;
  if (input.actionId === "billing.checkout.create") outputTokens = 280;
  if (input.actionId === "billing.portal.create") outputTokens = 120;
  if (input.actionId === "connector.settings.get") outputTokens = 120;
  if (input.actionId === "connector.settings.update") outputTokens = 90;
  if (input.actionId === "recall") outputTokens = 180 + topK * 220 + (input.includeProfile === false ? 0 : 120);
  if (input.actionId === "context") outputTokens = 220 + topK * 320;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export class McpPolicyEngine {
  private readonly limits: LimitsConfig;
  private readonly sessionCalls = new Map<string, number[]>();
  private readonly sessionReads = new Map<string, number[]>();
  private readonly sessionWrites = new Map<string, number[]>();
  private readonly keyReads = new Map<string, number[]>();
  private readonly keyWrites = new Map<string, number[]>();
  private readonly scopeWrites = new Map<string, number[]>();
  private readonly scopeForgets = new Map<string, number[]>();
  private readonly loopHistory = new Map<string, TimelineEntry[]>();
  private readonly replayCache = new Map<string, number>();
  private readonly replayQueue: Array<{ key: string; at: number }> = [];
  private readonly writeHistory = new Map<string, TimelineEntry[]>();
  private readonly sessionTokenUsage = new Map<string, TokenEvent[]>();
  private readonly loopDriftState = new Map<string, DriftState>();
  private readonly inFlightKey = new Map<string, number>();
  private readonly inFlightScope = new Map<string, number>();
  private readonly confirmationTokens = new Map<string, ConfirmationRecord>();
  private readonly hooks?: PolicyHooks;
  private readonly metrics: PolicyMetricsSnapshot = {
    decisions: {},
    rejections: 0,
    loopTriggers: 0,
    writeAccepted: 0,
    writeRejected: 0,
    latenciesMs: [],
  };

  constructor(config?: Partial<LimitsConfig>, hooks?: PolicyHooks) {
    this.limits = { ...DEFAULTS, ...(config ?? {}) };
    this.hooks = hooks;
  }

  evaluate(input: PolicyInput): PolicyDecision {
    const start = Date.now();
    this.hooks?.beforePolicy?.(input);
    const now = input.nowMs;
    const scopeId = scopeKey(input.scope);
    const sessId = sessionKey(input.scope);
    const keyId = `${input.scope.workspaceId}:${input.scope.keyId}`;
    const decisionId = crypto.randomUUID();

    if (actionIsWrite(input.actionId)) {
      const replayDecision = this.checkReplay(input, decisionId);
      if (replayDecision) return this.finalizeDecision(input, replayDecision, start);
    }

    const sessionCalls = pruneTimes(this.sessionCalls.get(sessId) ?? [], now, this.limits.sessionWindowMs);
    if (sessionCalls.length >= this.limits.sessionTotalCalls) {
      return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Session tool-call cap reached."), start);
    }

    if (actionIsRead(input.actionId)) {
      const reads = pruneTimes(this.sessionReads.get(sessId) ?? [], now, this.limits.sessionWindowMs);
      if (reads.length >= this.limits.sessionRecallCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Session read cap reached."), start);
      }
      const keyReads = pruneTimes(this.keyReads.get(keyId) ?? [], now, this.limits.keyWindowMs);
      if (keyReads.length >= this.limits.keyReadCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "API key read cap reached."), start);
      }
    }

    if (actionIsWrite(input.actionId)) {
      const writes = pruneTimes(this.sessionWrites.get(sessId) ?? [], now, this.limits.sessionWindowMs);
      if (writes.length >= this.limits.sessionWriteCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Session write cap reached."), start);
      }
      const keyWrites = pruneTimes(this.keyWrites.get(keyId) ?? [], now, this.limits.keyWindowMs);
      if (keyWrites.length >= this.limits.keyWriteCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "API key write cap reached."), start);
      }
    }

    if (input.actionId === "memory.save" || input.actionId === "memory.conversation_save") {
      const writes = pruneTimes(this.scopeWrites.get(scopeId) ?? [], now, this.limits.scopeWindowMs);
      if (writes.length >= this.limits.scopeWriteCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Scope write cap reached."), start);
      }
      const burst = writes.filter((t) => now - t <= this.limits.scopeWriteBurstWindowMs);
      if (burst.length >= this.limits.scopeWriteBurstLimit) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Scope write burst limit reached."), start);
      }
      const content = input.contentText ?? "";
      if (normalizeText(content).length < 20) {
        return this.finalizeDecision(input, this.deny(decisionId, "weak_signal", "Write rejected: low signal content."), start);
      }
      const novelty = this.checkNovelty(scopeId, content, now);
      if (!novelty.ok) {
        return this.finalizeDecision(input, this.deny(decisionId, "weak_signal", "Write rejected: near-duplicate content.", undefined, {
          noveltyScore: novelty.score,
        }), start);
      }
    }

    if (input.actionId === "memory.forget" || input.actionId === "memory.delete") {
      const forgets = pruneTimes(this.scopeForgets.get(scopeId) ?? [], now, this.limits.scopeWindowMs);
      if (forgets.length >= this.limits.scopeForgetCalls) {
        return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Scope forget cap reached."), start);
      }
    }

    const estimate = estimateCost(input);
    const sessionTokenEvents = (this.sessionTokenUsage.get(sessId) ?? []).filter(
      (event) => now - event.at <= this.limits.sessionBudgetWindowMs,
    );
    const sessionTokensUsed = sessionTokenEvents.reduce((sum, event) => sum + event.tokens, 0);
    if (sessionTokensUsed + estimate.totalTokens > this.limits.maxTokensPerSessionWindow) {
      return this.finalizeDecision(
        input,
        this.deny(decisionId, "cost_exceeded_session", "Session token budget exceeded.", undefined, {
          estimatedTokens: estimate.totalTokens,
          sessionWindowTokens: sessionTokensUsed,
          sessionWindowRemaining: Math.max(0, this.limits.maxTokensPerSessionWindow - sessionTokensUsed),
          costDecision: "deny",
        }),
        start,
      );
    }
    this.sessionTokenUsage.set(sessId, sessionTokenEvents);

    const budget: CostBudget = {
      max_input_tokens: this.limits.maxInputTokens,
      max_output_tokens: this.limits.maxOutputTokens,
      max_total_tokens: this.limits.maxTotalTokens,
    };
    const costInfo = { estimatedTokens: estimate.totalTokens, budget };
    const exceedsInput = estimate.inputTokens > budget.max_input_tokens;
    const exceedsOutput = estimate.outputTokens > budget.max_output_tokens;
    const exceedsTotal = estimate.totalTokens > budget.max_total_tokens;
    const slightlyAbove = estimate.totalTokens <= Math.floor(budget.max_total_tokens * 1.15);
    if (exceedsInput || exceedsOutput || exceedsTotal) {
      if (input.actionId === "context" && slightlyAbove) {
        const appliedTopK = Math.max(1, Math.min(input.topK ?? 5, Math.floor((input.topK ?? 5) / 2) || 1));
        return this.finalizeDecision(input, {
          status: "degrade",
          decisionId,
          degradeLevel: "reduce_top_k",
          appliedTopK,
          costDecision: "degrade",
          ...costInfo,
          truncateInstruction: { max_output_tokens: budget.max_output_tokens },
        }, start);
      }
      return this.finalizeDecision(input, this.deny(decisionId, "cost_exceeded", "Request exceeds token budget.", undefined, {
        ...costInfo,
        sessionWindowTokens: sessionTokensUsed,
        sessionWindowRemaining: Math.max(
          0,
          this.limits.maxTokensPerSessionWindow - (sessionTokensUsed + estimate.totalTokens),
        ),
        costDecision: "deny",
      }), start);
    }

    if (input.actionId === "recall" || input.actionId === "context") {
      const loop = this.checkLoop(scopeId, input.queryText ?? "", now, decisionId);
      if (loop) return this.finalizeDecision(input, loop, start);
    }

    const plannedCost = estimate.totalTokens / 50;
    if (plannedCost > this.limits.perTurnCostBudget) {
      return this.finalizeDecision(input, this.deny(decisionId, "cost_exceeded", "Request exceeds per-turn cost budget.", undefined, {
        ...costInfo,
        sessionWindowTokens: sessionTokensUsed,
        sessionWindowRemaining: Math.max(
          0,
          this.limits.maxTokensPerSessionWindow - (sessionTokensUsed + estimate.totalTokens),
        ),
        costDecision: "deny",
      }), start);
    }
    let degradeLevel: PolicyDecision["degradeLevel"] | undefined;
    let appliedTopK = input.topK;
    if (plannedCost > this.limits.perTurnCostBudget * 0.7 && (input.actionId === "recall" || input.actionId === "context")) {
      degradeLevel = "reduce_top_k";
      appliedTopK = Math.min(3, Math.max(1, input.topK ?? 5));
    }

    const currentInFlightKey = this.inFlightKey.get(keyId) ?? 0;
    if (currentInFlightKey >= this.limits.maxInFlightPerKey) {
      return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "API key concurrency limit exceeded."), start);
    }
    const currentInFlightScope = this.inFlightScope.get(scopeId) ?? 0;
    if (currentInFlightScope >= this.limits.maxInFlightPerScope) {
      return this.finalizeDecision(input, this.deny(decisionId, "rate_limit_exceeded", "Scope concurrency limit exceeded."), start);
    }

    // commit counters for accepted request
    this.sessionCalls.set(sessId, pushTime(this.sessionCalls, sessId, now));
    if (actionIsRead(input.actionId)) {
      this.sessionReads.set(sessId, pushTime(this.sessionReads, sessId, now));
      this.keyReads.set(keyId, pushTime(this.keyReads, keyId, now));
    }
    if (actionIsWrite(input.actionId)) {
      this.sessionWrites.set(sessId, pushTime(this.sessionWrites, sessId, now));
      this.keyWrites.set(keyId, pushTime(this.keyWrites, keyId, now));
    }
    if (input.actionId === "memory.save" || input.actionId === "memory.conversation_save") {
      this.scopeWrites.set(scopeId, pushTime(this.scopeWrites, scopeId, now));
      this.pushWriteHistory(scopeId, input.contentText ?? "", now);
    }
    if (input.actionId === "memory.forget" || input.actionId === "memory.delete") {
      this.scopeForgets.set(scopeId, pushTime(this.scopeForgets, scopeId, now));
    }
    this.inFlightKey.set(keyId, currentInFlightKey + 1);
    this.inFlightScope.set(scopeId, currentInFlightScope + 1);
    this.sessionTokenUsage.set(sessId, [...sessionTokenEvents, { at: now, tokens: estimate.totalTokens }]);

    return this.finalizeDecision(input, {
      status: degradeLevel ? "degrade" : "allow",
      decisionId,
      degradeLevel,
      appliedTopK,
      estimatedTokens: estimate.totalTokens,
      budget,
      costDecision: degradeLevel ? "degrade" : "allow",
      sessionWindowTokens: sessionTokensUsed + estimate.totalTokens,
      sessionWindowRemaining: Math.max(
        0,
        this.limits.maxTokensPerSessionWindow - (sessionTokensUsed + estimate.totalTokens),
      ),
    }, start);
  }

  complete(input: PolicyInput): void {
    const scopeId = scopeKey(input.scope);
    const keyId = `${input.scope.workspaceId}:${input.scope.keyId}`;
    const keyCount = this.inFlightKey.get(keyId) ?? 0;
    const scopeCount = this.inFlightScope.get(scopeId) ?? 0;
    this.inFlightKey.set(keyId, Math.max(0, keyCount - 1));
    this.inFlightScope.set(scopeId, Math.max(0, scopeCount - 1));
  }

  recordExecution(args: {
    actionId: McpActionId;
    decision: PolicyDecisionStatus;
    reason?: McpErrorCode;
    latencyMs: number;
    sessionId: string;
    scores?: { similarity?: number; novelty?: number };
  }): void {
    this.hooks?.afterExecution?.(args);
  }

  getMetrics(): PolicyMetricsSnapshot {
    return {
      decisions: { ...this.metrics.decisions },
      rejections: this.metrics.rejections,
      loopTriggers: this.metrics.loopTriggers,
      writeAccepted: this.metrics.writeAccepted,
      writeRejected: this.metrics.writeRejected,
      latenciesMs: [...this.metrics.latenciesMs],
    };
  }

  issueConfirmationToken(input: PolicyInput, memoryId: string, ttlMs = 180_000): ConfirmationRecord {
    const token = crypto.randomUUID();
    const rec: ConfirmationRecord = {
      token,
      expiresAt: input.nowMs + ttlMs,
      scopeKey: scopeKey(input.scope),
      action: "memory.confirm_forget",
      memoryId,
    };
    this.confirmationTokens.set(token, rec);
    return rec;
  }

  consumeConfirmationToken(input: PolicyInput, token: string, memoryId?: string): PolicyDecision {
    const decisionId = crypto.randomUUID();
    const rec = this.confirmationTokens.get(token);
    if (!rec) return this.deny(decisionId, "confirmation_required", "Invalid confirmation token.");
    if (rec.expiresAt < input.nowMs) {
      this.confirmationTokens.delete(token);
      return this.deny(decisionId, "confirmation_required", "Confirmation token expired.");
    }
    if (rec.scopeKey !== scopeKey(input.scope)) {
      return this.deny(decisionId, "unauthorized_scope", "Confirmation token scope mismatch.");
    }
    if (memoryId && rec.memoryId !== memoryId) {
      return this.deny(decisionId, "confirmation_required", "Confirmation token memory mismatch.");
    }
    this.confirmationTokens.delete(token);
    return { status: "allow", decisionId };
  }

  private checkReplay(input: PolicyInput, decisionId: string): PolicyDecision | null {
    if (!input.nonce || !input.timestampMs) {
      return this.deny(decisionId, "replay_detected", "nonce and timestamp are required for write actions.");
    }
    const now = input.nowMs;
    if (Math.abs(now - input.timestampMs) > this.limits.replayWindowMs) {
      return this.deny(decisionId, "replay_detected", "timestamp is outside replay window.");
    }
    this.gcReplay(now);
    const nonceKey = `${input.scope.workspaceId}:${input.scope.keyId}:${input.scope.sessionId}:${input.nonce}`;
    const seenAt = this.replayCache.get(nonceKey);
    if (seenAt && now - seenAt <= this.limits.replayWindowMs) {
      return this.deny(decisionId, "replay_detected", "nonce already used.");
    }
    this.replayCache.set(nonceKey, now);
    this.replayQueue.push({ key: nonceKey, at: now });
    if (this.replayQueue.length > this.limits.maxNonceEntries) {
      const drop = this.replayQueue.shift();
      if (drop) this.replayCache.delete(drop.key);
    }
    return null;
  }

  private gcReplay(now: number): void {
    while (this.replayQueue.length > 0) {
      const first = this.replayQueue[0];
      if (now - first.at <= this.limits.replayWindowMs) break;
      this.replayQueue.shift();
      const seen = this.replayCache.get(first.key);
      if (seen && seen <= first.at) this.replayCache.delete(first.key);
    }
  }

  private checkLoop(scopeId: string, query: string, now: number, decisionId: string): PolicyDecision | null {
    const normalized = normalizeText(query);
    if (!normalized) return null;
    const history = (this.loopHistory.get(scopeId) ?? [])
      .filter((r) => now - r.at <= this.limits.loopWindowMs)
      .slice(-this.limits.maxActionWindow);
    const qSet = tokenSet(normalized);
    const qVector = tokenVector(normalized);
    let similar = 0;
    let maxSimilarity = 0;
    const matchedWindow: string[] = [];
    let centroidSimilarity = 0;
    for (const row of history) {
      const lexical = jaccard(qSet, tokenSet(row.value));
      if (lexical < 0.3) continue;
      const semantic = cosineFromVectors(qVector, row.vector);
      if (semantic >= this.limits.similarityThreshold) {
        similar += 1;
        matchedWindow.push(hashToken(row.value));
      }
      if (semantic > maxSimilarity) maxSimilarity = semantic;
    }
    const centroid = centroidVector(history);
    if (centroid.size > 0) {
      centroidSimilarity = cosineFromVectors(qVector, centroid);
      if (centroidSimilarity > maxSimilarity) maxSimilarity = centroidSimilarity;
    }
    const driftState = this.loopDriftState.get(scopeId);
    const lastScore = driftState?.score ?? 0;
    const decayFactor =
      driftState == null
        ? 1
        : Math.pow(0.5, Math.max(0, now - driftState.lastAt) / Math.max(1, this.limits.driftDecayHalfLifeMs));
    const decayedScore = lastScore * decayFactor;
    const driftIncrement =
      history.length >= 2 && centroidSimilarity >= this.limits.driftSimilarityThreshold
        ? centroidSimilarity - this.limits.driftSimilarityThreshold
        : 0;
    const driftScore = decayedScore + driftIncrement;
    this.loopDriftState.set(scopeId, { score: driftScore, lastAt: now });
    history.push({ at: now, value: normalized, vector: qVector });
    if (history.length > this.limits.maxActionWindow) history.shift();
    this.loopHistory.set(scopeId, history);
    if (similar >= this.limits.loopThreshold - 1) {
      return this.deny(decisionId, "loop_detected", "Repeated similar queries detected.", 30, {
        loopConfidence: Math.min(1, Math.max(maxSimilarity, similar / this.limits.loopThreshold)),
        matchedWindow: matchedWindow.slice(0, 5),
      });
    }
    if (history.length >= 2 && maxSimilarity >= this.limits.similarityThreshold && centroidSimilarity >= this.limits.similarityThreshold * 0.9) {
      return this.deny(decisionId, "loop_detected", "Loop pattern detected.", 30, {
        loopConfidence: maxSimilarity,
        matchedWindow: matchedWindow.slice(0, 5),
      });
    }
    if (history.length >= 3 && driftScore >= this.limits.driftScoreThreshold) {
      return this.deny(decisionId, "loop_detected_drift", "Drift loop pattern detected.", 30, {
        loopConfidence: Math.min(1, driftScore / this.limits.driftScoreThreshold),
        matchedWindow: matchedWindow.slice(0, 5),
        driftScore,
      });
    }
    return null;
  }

  private checkNovelty(scopeId: string, content: string, now: number): { ok: boolean; score: number } {
    const history = (this.writeHistory.get(scopeId) ?? []).filter((r) => now - r.at <= this.limits.scopeWindowMs);
    const normalized = normalizeText(content);
    let maxScore = 0;
    for (const row of history) {
      const semantic = cosineFromTf(normalized, row.value);
      if (semantic > maxScore) maxScore = semantic;
      if (semantic >= this.limits.noveltyThreshold) return { ok: false, score: semantic };
    }
    return { ok: true, score: maxScore };
  }

  private pushWriteHistory(scopeId: string, content: string, now: number): void {
    const history = (this.writeHistory.get(scopeId) ?? []).filter((r) => now - r.at <= this.limits.scopeWindowMs);
    const value = normalizeText(content);
    history.push({ at: now, value, vector: tokenVector(value) });
    this.writeHistory.set(scopeId, history);
  }

  private deny(
    decisionId: string,
    reasonCode: McpErrorCode,
    message: string,
    retryAfterSec?: number,
    extras?: Partial<PolicyDecision>,
  ): PolicyDecision {
    return { status: "deny", decisionId, reasonCode, message, retryAfterSec, ...(extras ?? {}) };
  }

  private finalizeDecision(input: PolicyInput, decision: PolicyDecision, startedAt: number): PolicyDecision {
    const latency = Math.max(0, Date.now() - startedAt);
    const statusKey = decision.status;
    this.metrics.decisions[statusKey] = (this.metrics.decisions[statusKey] ?? 0) + 1;
    if (decision.status === "deny") this.metrics.rejections += 1;
    if (decision.reasonCode === "loop_detected" || decision.reasonCode === "loop_detected_drift") this.metrics.loopTriggers += 1;
    if (input.actionId === "memory.save") {
      if (decision.status === "deny") this.metrics.writeRejected += 1;
      else this.metrics.writeAccepted += 1;
    }
    if (this.metrics.latenciesMs.length >= 200) this.metrics.latenciesMs.shift();
    this.metrics.latenciesMs.push(latency);
    this.hooks?.afterPolicy?.(input, decision, latency);
    return decision;
  }
}

export type PolicyDeniedError = {
  error: {
    code: McpErrorCode;
    message: string;
    details: Record<string, unknown>;
  };
};

export function policyDeniedError(args: {
  code: McpErrorCode;
  message: string;
  actionId: McpActionId;
  scope: PolicyScope;
  retryAfterSec?: number;
  details?: Record<string, unknown>;
}): PolicyDeniedError {
  const scopeHash = `${args.scope.workspaceId}:${args.scope.userId}:${args.scope.namespace}`
    .split("")
    .reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381)
    .toString(16)
    .slice(0, 16);
  return {
    error: {
      code: args.code,
      message: args.message,
      details: {
        ...(typeof args.retryAfterSec === "number" ? { retry_after_s: args.retryAfterSec } : {}),
        policy_version: MCP_POLICY_VERSION,
        action_id: args.actionId,
        scope_hash: scopeHash,
        ...(args.details ?? {}),
      },
    },
  };
}
