import { classifyIntent, setIntentClassifierConfig } from "./intentClassifier.js";
import type { QueryIntent } from "./intentClassifier.js";
import { getOrComputeLlmCache } from "../cache/llmCache.js";

export type BrainDecision = {
  use_memory: boolean;
  strategy: "broad" | "focused" | "recent-first" | "important-first" | "hybrid";
  top_k: number;
  priorities: ("recency" | "importance" | "semantic")[];
  summarize_before_use: boolean;
  update_memory: boolean;
};

const FALLBACK_DECISION: BrainDecision = {
  use_memory: true,
  strategy: "hybrid",
  top_k: 8,
  priorities: ["semantic"],
  summarize_before_use: false,
  update_memory: true,
};

const STRATEGIES = new Set<BrainDecision["strategy"]>([
  "broad",
  "focused",
  "recent-first",
  "important-first",
  "hybrid",
]);

const PRIORITIES = new Set<BrainDecision["priorities"][number]>([
  "recency",
  "importance",
  "semantic",
]);
const BRAIN_CACHE_TTL_MS = 10 * 60_000;

function normalizeCacheQuery(query: string): string {
  return query.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function coerceBrainDecision(input: unknown): BrainDecision | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  const strategy = typeof obj.strategy === "string" ? obj.strategy : "";
  if (!STRATEGIES.has(strategy as BrainDecision["strategy"])) return null;

  const prioritiesRaw = Array.isArray(obj.priorities) ? obj.priorities : [];
  const priorities = prioritiesRaw
    .filter((v): v is BrainDecision["priorities"][number] => typeof v === "string" && PRIORITIES.has(v as BrainDecision["priorities"][number]));
  const dedupPriorities = [...new Set(priorities)];
  if (dedupPriorities.length === 0) dedupPriorities.push("semantic");

  const topKRaw = typeof obj.top_k === "number" ? obj.top_k : Number(obj.top_k);
  const topK = Number.isFinite(topKRaw) ? Math.max(0, Math.min(50, Math.floor(topKRaw))) : FALLBACK_DECISION.top_k;

  if (typeof obj.use_memory !== "boolean") return null;
  if (typeof obj.summarize_before_use !== "boolean") return null;
  if (typeof obj.update_memory !== "boolean") return null;

  return {
    use_memory: obj.use_memory,
    strategy: strategy as BrainDecision["strategy"],
    top_k: obj.use_memory ? Math.max(1, topK || FALLBACK_DECISION.top_k) : 0,
    priorities: dedupPriorities,
    summarize_before_use: obj.summarize_before_use,
    update_memory: obj.update_memory,
  };
}

function resolveApiKey(metadata?: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const m = metadata as Record<string, unknown>;
  const direct = m.openaiApiKey;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const legacy = m.OPENAI_API_KEY;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  const envLike = m.env as Record<string, unknown> | undefined;
  if (envLike && typeof envLike.OPENAI_API_KEY === "string" && envLike.OPENAI_API_KEY.trim()) {
    return envLike.OPENAI_API_KEY.trim();
  }
  return "";
}

function applyIntentOverrides(
  base: BrainDecision,
  intent: { intent: QueryIntent; confidence: number },
): BrainDecision {
  if (intent.confidence <= 0.7) return base;

  if (intent.intent === "irrelevant") {
    return {
      ...base,
      use_memory: false,
      top_k: 0,
      summarize_before_use: false,
      update_memory: false,
      priorities: ["semantic"],
    };
  }

  if (intent.intent === "factual") {
    return {
      ...base,
      strategy: "focused",
      priorities: base.priorities.includes("semantic") ? base.priorities : ["semantic", ...base.priorities],
    };
  }

  if (intent.intent === "preference") {
    return {
      ...base,
      strategy: "important-first",
      priorities: ["importance", "semantic"],
    };
  }

  if (intent.intent === "task") {
    return {
      ...base,
      strategy: "hybrid",
      top_k: Math.min(20, Math.max(base.top_k + 2, 8)),
      priorities: ["semantic", "importance"],
    };
  }

  return {
    ...base,
    strategy: "broad",
    priorities: ["semantic", "recency"],
  };
}

function deterministicDecisionFromIntent(intent: QueryIntent): BrainDecision {
  if (intent === "irrelevant") {
    return {
      use_memory: false,
      strategy: "focused",
      top_k: 0,
      priorities: ["semantic"],
      summarize_before_use: false,
      update_memory: false,
    };
  }
  if (intent === "factual") {
    return {
      use_memory: true,
      strategy: "focused",
      top_k: 8,
      priorities: ["semantic"],
      summarize_before_use: false,
      update_memory: true,
    };
  }
  if (intent === "preference") {
    return {
      use_memory: true,
      strategy: "important-first",
      top_k: 8,
      priorities: ["importance", "semantic"],
      summarize_before_use: false,
      update_memory: true,
    };
  }
  if (intent === "task") {
    return {
      use_memory: true,
      strategy: "hybrid",
      top_k: 10,
      priorities: ["semantic", "importance"],
      summarize_before_use: false,
      update_memory: true,
    };
  }
  return {
    use_memory: true,
    strategy: "broad",
    top_k: 10,
    priorities: ["semantic", "recency"],
    summarize_before_use: false,
    update_memory: true,
  };
}

export type MemoryBrainOutcome = {
  decision: BrainDecision;
  intent: { intent: QueryIntent; confidence: number };
  path?: "hot" | "cold";
};

function applyLearnedAdjustment(
  base: BrainDecision,
  learned?: {
    preferred_strategy?: BrainDecision["strategy"];
    ideal_top_k?: number;
    positive_count?: number;
    negative_count?: number;
  } | null,
): BrainDecision {
  if (!learned) return base;
  const positive = Math.max(0, Number(learned.positive_count ?? 0));
  const negative = Math.max(0, Number(learned.negative_count ?? 0));
  const total = positive + negative;
  if (total < 2) return base;
  const strategy = learned.preferred_strategy && STRATEGIES.has(learned.preferred_strategy)
    ? learned.preferred_strategy
    : base.strategy;
  const topKRaw = Number(learned.ideal_top_k ?? base.top_k);
  const topK = Number.isFinite(topKRaw) ? Math.max(3, Math.min(20, Math.floor(topKRaw))) : base.top_k;
  return {
    ...base,
    strategy,
    top_k: topK,
  };
}

export async function decideMemoryStrategy(input: {
  query: string;
  metadata?: Record<string, unknown>;
}): Promise<BrainDecision> {
  const out = await decideMemoryStrategyWithIntent(input);
  return out.decision;
}

export async function decideMemoryStrategyWithIntent(input: {
  query: string;
  metadata?: Record<string, unknown>;
}): Promise<MemoryBrainOutcome> {
  const query = normalizeCacheQuery((input.query ?? "").toString().trim());
  if (!query) {
    return {
      decision: { ...FALLBACK_DECISION, update_memory: false },
      intent: { intent: "factual", confidence: 0.5 },
    };
  }

  const apiKey = resolveApiKey(input.metadata);
  const enableIntent = String(input.metadata?.enable_intent ?? "true").toLowerCase() !== "false";
  const enableBrain = String(input.metadata?.enable_brain ?? "true").toLowerCase() !== "false";
  const learnedAdjustment = input.metadata?.learned_adjustment as
    | {
      preferred_strategy?: BrainDecision["strategy"];
      ideal_top_k?: number;
      positive_count?: number;
      negative_count?: number;
    }
    | undefined;
  const model =
    typeof input.metadata?.model === "string" && input.metadata.model.trim().length > 0
      ? input.metadata.model.trim()
      : "gpt-4o-mini";
  let intent: { intent: QueryIntent; confidence: number } = { intent: "factual", confidence: 0.5 };
  if (enableIntent) {
    setIntentClassifierConfig({ openaiApiKey: apiKey, model });
    intent = await classifyIntent(query);
  }
  if (intent.confidence > 0.85) {
    return {
      decision: applyLearnedAdjustment(deterministicDecisionFromIntent(intent.intent), learnedAdjustment),
      intent,
      path: "hot",
    };
  }

  if (!apiKey) {
    return {
      decision: applyLearnedAdjustment(applyIntentOverrides(FALLBACK_DECISION, intent), learnedAdjustment),
      intent,
      path: "hot",
    };
  }
  if (!enableBrain) {
    return {
      decision: applyLearnedAdjustment(applyIntentOverrides(FALLBACK_DECISION, intent), learnedAdjustment),
      intent,
      path: "hot",
    };
  }

  const brainCacheKey = `brain|${model}|${query}|${intent.intent}|${intent.confidence.toFixed(2)}|${learnedAdjustment?.preferred_strategy ?? ""}|${Number(learnedAdjustment?.ideal_top_k ?? 0)}`;


  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const decision = await getOrComputeLlmCache(brainCacheKey, BRAIN_CACHE_TTL_MS, async () => {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 220,
          messages: [
            {
              role: "system",
              content:
                "You are the Memory Brain. Return STRICT JSON only with keys: use_memory, strategy, top_k, priorities, summarize_before_use, update_memory. " +
                "Allowed strategy: broad|focused|recent-first|important-first|hybrid. " +
                "Allowed priorities values: recency|importance|semantic. " +
                "No markdown, no prose, no code fences.",
            },
            {
              role: "user",
              content: JSON.stringify({
                query,
                intent,
                metadata: null,
              }),
            },
          ],
        }),
      });
      if (!response.ok) return FALLBACK_DECISION;
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "";
      const candidate = extractFirstJsonObject(content);
      if (!candidate) return FALLBACK_DECISION;
      const parsed = JSON.parse(candidate);
      return coerceBrainDecision(parsed) ?? FALLBACK_DECISION;
    });
    return {
      decision: applyLearnedAdjustment(applyIntentOverrides(decision, intent), learnedAdjustment),
      intent,
      path: "cold",
    };
  } catch {
    return {
      decision: applyLearnedAdjustment(applyIntentOverrides(FALLBACK_DECISION, intent), learnedAdjustment),
      intent,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
