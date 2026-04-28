import { getOrComputeLlmCache } from "../cache/llmCache.js";

export type QueryIntent =
  | "factual"
  | "preference"
  | "task"
  | "exploratory"
  | "irrelevant";

const FALLBACK_INTENT: { intent: QueryIntent; confidence: number } = {
  intent: "factual",
  confidence: 0.5,
};

const INTENTS = new Set<QueryIntent>([
  "factual",
  "preference",
  "task",
  "exploratory",
  "irrelevant",
]);

type RuntimeConfig = {
  apiKey: string;
  model: string;
};

const runtimeConfig: RuntimeConfig = {
  apiKey: "",
  model: "gpt-4o-mini",
};

const CACHE_TTL_MS = 8 * 60_000;

function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function coerceIntentResult(input: unknown): { intent: QueryIntent; confidence: number } | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const rawIntent = typeof obj.intent === "string" ? obj.intent : "";
  if (!INTENTS.has(rawIntent as QueryIntent)) return null;

  const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;

  return {
    intent: rawIntent as QueryIntent,
    confidence,
  };
}

export function setIntentClassifierConfig(config: {
  openaiApiKey?: string;
  model?: string;
}): void {
  const apiKey = typeof config.openaiApiKey === "string" ? config.openaiApiKey.trim() : "";
  if (apiKey) runtimeConfig.apiKey = apiKey;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model) runtimeConfig.model = model;
}

export async function classifyIntent(query: string): Promise<{
  intent: QueryIntent;
  confidence: number;
  cached?: boolean;
}> {
  const normalizedQuery = (query ?? "").toString().trim();
  if (!normalizedQuery) return FALLBACK_INTENT;
  if (normalizedQuery.length < 3) return FALLBACK_INTENT;

  const cacheKey = normalizeQueryKey(normalizedQuery);
  const llmCacheKey = `intent|${runtimeConfig.model}|${cacheKey}`;

  if (!runtimeConfig.apiKey) return FALLBACK_INTENT;
  try {
    const value = await getOrComputeLlmCache(llmCacheKey, (v) => {
      if (v.intent === "factual") return 15 * 60_000;
      if (v.intent === "preference") return 10 * 60_000;
      if (v.intent === "exploratory") return 5 * 60_000;
      return CACHE_TTL_MS;
    }, async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500);
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${runtimeConfig.apiKey}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: runtimeConfig.model,
            temperature: 0,
            max_tokens: 70,
            messages: [
              {
                role: "system",
                content:
                  "Classify user query intent for memory retrieval. Return STRICT JSON only with keys: intent, confidence. " +
                  "Allowed intent values: factual, preference, task, exploratory, irrelevant. " +
                  "confidence must be a number from 0 to 1. No prose, no markdown.",
              },
              {
                role: "user",
                content: normalizedQuery.slice(0, 200),
              },
            ],
          }),
        });
        if (!response.ok) return FALLBACK_INTENT;
        const json = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content ?? "";
        const candidate = extractFirstJsonObject(content);
        if (!candidate) return FALLBACK_INTENT;
        const parsed = JSON.parse(candidate);
        return coerceIntentResult(parsed) ?? FALLBACK_INTENT;
      } finally {
        clearTimeout(timeoutId);
      }
    });
    return { ...value, cached: true };
  } catch {
    return FALLBACK_INTENT;
  }
}
