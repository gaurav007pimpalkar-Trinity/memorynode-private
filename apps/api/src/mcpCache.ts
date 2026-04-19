export type McpCacheTool = "recall" | "context";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  scopeKey: string;
};

type CacheStats = {
  hit: number;
  miss: number;
  evict: number;
  invalidate: number;
};

export class McpResponseCache {
  private readonly ttlByTool: Record<McpCacheTool, number>;
  private readonly maxSize: number;
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly scopeVersion = new Map<string, number>();
  private readonly stats: CacheStats = { hit: 0, miss: 0, evict: 0, invalidate: 0 };

  constructor(args?: { maxSize?: number; ttlByTool?: Partial<Record<McpCacheTool, number>> }) {
    this.maxSize = args?.maxSize ?? 300;
    this.ttlByTool = {
      recall: args?.ttlByTool?.recall ?? 15_000,
      context: args?.ttlByTool?.context ?? 8_000,
    };
  }

  makeKey(args: { tool: McpCacheTool; scope: string; query: string; policyVersion: string }): string {
    const version = this.scopeVersion.get(args.scope) ?? 0;
    return `${args.tool}:${args.scope}:${hash(args.query)}:${args.policyVersion}:v${version}`;
  }

  async getOrCompute<T>(
    key: string,
    args: { tool: McpCacheTool; scope: string },
    compute: () => Promise<T>,
  ): Promise<{ value: T; cacheHit: boolean }> {
    const hit = this.get<T>(key);
    if (hit != null) {
      this.stats.hit += 1;
      return { value: hit, cacheHit: true };
    }
    this.stats.miss += 1;
    const existing = this.inFlight.get(key);
    if (existing) {
      const value = (await existing) as T;
      return { value, cacheHit: false };
    }
    const promise = compute()
      .then((value) => {
        this.set(key, value, args.tool, args.scope);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return { value: (await promise) as T, cacheHit: false };
  }

  invalidateScope(scope: string): void {
    const current = this.scopeVersion.get(scope) ?? 0;
    this.scopeVersion.set(scope, current + 1);
    for (const key of this.store.keys()) {
      const entry = this.store.get(key);
      if (!entry) continue;
      if (entry.scopeKey === scope) {
        this.store.delete(key);
        this.stats.invalidate += 1;
      }
    }
  }

  invalidateRelated(scope: string, targetHashes: string[]): void {
    this.invalidateScope(scope);
    if (targetHashes.length === 0) return;
    const hashSet = new Set(targetHashes);
    for (const key of this.store.keys()) {
      if (!key.includes(`:${scope}:`)) continue;
      for (const h of hashSet) {
        if (key.includes(`:${h}:`)) {
          this.store.delete(key);
          this.stats.invalidate += 1;
          break;
        }
      }
    }
  }

  snapshot(): CacheStats {
    return { ...this.stats };
  }

  private get<T>(key: string): T | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    this.touch(key, hit);
    return hit.value as T;
  }

  private set<T>(key: string, value: T, tool: McpCacheTool, scope: string): void {
    const ttl = this.ttlByTool[tool];
    this.store.set(key, { value, expiresAt: Date.now() + ttl, scopeKey: scope });
    this.touch(key, this.store.get(key)!);
    this.evictIfNeeded();
  }

  private touch(key: string, value: CacheEntry<unknown>): void {
    this.store.delete(key);
    this.store.set(key, value);
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (!oldest) break;
      this.store.delete(oldest);
      this.stats.evict += 1;
    }
  }
}

export function hash(input: string): string {
  return input
    .split("")
    .reduce((acc, ch) => ((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381)
    .toString(16);
}
