import { getOrComputeLlmCache, getLlmCache, makeLlmCacheKey, setLlmCache } from "../cache/llmCache.js";

export type MemoryChunk = {
  id: string;
  text: string;
  importance?: number | null;
  timestamp?: string | null;
};

type RerankConfig = {
  apiKey: string;
  model: string;
};

const MAX_RERANK_CANDIDATES = 15;
const FALLBACK_MAX_TEXT_CHARS = 360;
const RERANK_CACHE_TTL_MS = 6 * 60_000;

const rerankConfig: RerankConfig = {
  apiKey: "",
  model: "gpt-4o-mini",
};

export function setRerankerConfig(config: {
  openaiApiKey?: string;
  model?: string;
}): void {
  const key = typeof config.openaiApiKey === "string" ? config.openaiApiKey.trim() : "";
  if (key) rerankConfig.apiKey = key;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model) rerankConfig.model = model;
}

function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function truncateText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= FALLBACK_MAX_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, FALLBACK_MAX_TEXT_CHARS - 1)}...`;
}

function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").slice(0, 200);
}

function mergedRankedIds(returnedIds: string[], originalIds: string[]): string[] {
  const validReturned = returnedIds.filter((id) => originalIds.includes(id));
  return validReturned.concat(originalIds.filter((id) => !validReturned.includes(id)));
}

export async function rerankMemories<T extends MemoryChunk>(input: {
  query: string;
  candidates: T[];
}): Promise<T[]> {
  const query = (input.query ?? "").toString().trim();
  if (!query) return input.candidates;
  if (!Array.isArray(input.candidates) || input.candidates.length <= 1) return input.candidates;

  const topCandidates = input.candidates.slice(0, MAX_RERANK_CANDIDATES);
  const originalIds = topCandidates.map((c) => c.id);
  const candidates = [...topCandidates].sort(() => Math.random() - 0.5);
  if (!rerankConfig.apiKey) return input.candidates;
  const cacheKey = makeLlmCacheKey([
    "rerank",
    rerankConfig.model,
    normalizeQuery(query),
    ...originalIds,
  ]);
  const cachedIds = getLlmCache<string[]>(cacheKey);
  if (cachedIds && cachedIds.length > 0) {
    const finalOrderIds = mergedRankedIds(cachedIds, originalIds);
    const byId = new Map<string, T>(topCandidates.map((c) => [c.id, c]));
    const rerankedTop = finalOrderIds.map((id) => byId.get(id)).filter((v): v is T => Boolean(v));
    const suffix = input.candidates.slice(topCandidates.length);
    return [...rerankedTop, ...suffix];
  }

  const compact = candidates.map((c) => ({
    id: c.id,
    text: truncateText(c.text ?? ""),
    importance: c.importance ?? null,
    timestamp: c.timestamp ?? null,
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const rankedIds = await getOrComputeLlmCache<string[]>(cacheKey, RERANK_CACHE_TTL_MS, async () => {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${rerankConfig.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: rerankConfig.model,
          temperature: 0,
          max_tokens: 180,
          messages: [
            {
              role: "system",
              content:
                "You rerank memory chunks for relevance. Return STRICT JSON only with key ranked_ids (array of ids). " +
                "Use only provided ids. Most useful first. No prose or markdown.",
            },
            {
              role: "user",
              content: JSON.stringify({
                query: normalizeQuery(query),
                candidates: compact,
              }),
            },
          ],
        }),
      });
      if (!response.ok) return [];
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "";
      const candidateJson = extractFirstJsonObject(content);
      if (!candidateJson) return [];
      const parsed = JSON.parse(candidateJson) as { ranked_ids?: unknown };
      return Array.isArray(parsed.ranked_ids)
        ? parsed.ranked_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
    });
    if (rankedIds.length === 0) return input.candidates;
    const finalOrderIds = mergedRankedIds(rankedIds, originalIds);
    setLlmCache(cacheKey, finalOrderIds, RERANK_CACHE_TTL_MS);
    const byId = new Map<string, T>(topCandidates.map((c) => [c.id, c]));
    const rerankedTop = finalOrderIds.map((id) => byId.get(id)).filter((v): v is T => Boolean(v));
    const suffix = input.candidates.slice(topCandidates.length);
    return [...rerankedTop, ...suffix];
  } catch {
    return input.candidates;
  } finally {
    clearTimeout(timeoutId);
  }
}
