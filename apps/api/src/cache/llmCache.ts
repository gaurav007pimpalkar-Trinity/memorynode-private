type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, { promise: Promise<unknown>; startedAt: number }>();
let cacheDisabled = false;

const metrics = {
  lookups: 0,
  hits: 0,
  misses: 0,
  inFlightShared: 0,
  computes: 0,
};

export function setLlmCacheDisabled(disabled: boolean): void {
  cacheDisabled = disabled;
}

export function getLlmCacheMetrics(): {
  lookups: number;
  hits: number;
  misses: number;
  inFlightShared: number;
  computes: number;
} {
  return { ...metrics };
}

export function getLlmCache<T>(key: string): T | null {
  metrics.lookups += 1;
  if (cacheDisabled) {
    metrics.misses += 1;
    console.log("LLM cache miss:", key);
    return null;
  }
  const hit = store.get(key);
  if (!hit) {
    metrics.misses += 1;
    console.log("LLM cache miss:", key);
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    metrics.misses += 1;
    console.log("LLM cache miss:", key);
    return null;
  }
  metrics.hits += 1;
  console.log("LLM cache hit:", key);
  return hit.value as T;
}

export function setLlmCache<T>(key: string, value: T, ttlMs: number): void {
  if (cacheDisabled) return;
  const safeTtl = Math.max(30_000, Math.min(15 * 60_000, Math.floor(ttlMs)));
  store.set(key, {
    value,
    expiresAt: Date.now() + safeTtl,
  });
}

export function makeLlmCacheKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .map((p) => (p == null ? "" : String(p)))
    .join("|")
    .slice(0, 1200);
}

export async function getOrComputeLlmCache<T>(
  key: string,
  ttlMs: number | ((value: T) => number),
  compute: () => Promise<T>,
  options?: { inFlightMaxMs?: number },
): Promise<T> {
  if (cacheDisabled) {
    metrics.computes += 1;
    return compute();
  }
  const cached = getLlmCache<T>(key);
  if (cached != null) return cached;
  const inFlightMaxMs = Math.max(1000, Math.min(15_000, Number(options?.inFlightMaxMs ?? 7000)));
  const existing = inFlight.get(key) as { promise: Promise<T>; startedAt: number } | undefined;
  if (existing && (Date.now() - existing.startedAt) <= inFlightMaxMs) {
    metrics.inFlightShared += 1;
    return existing.promise;
  }
  metrics.computes += 1;
  const task = (async () => {
    try {
      const value = await compute();
      const resolvedTtl = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
      setLlmCache(key, value, resolvedTtl);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, { promise: task, startedAt: Date.now() });
  return task;
}
