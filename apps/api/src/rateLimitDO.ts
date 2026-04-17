import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./limits.js";

type Bucket = { count: number; windowStart: number };
type ConcurrencyLeases = { leases: Record<string, number> };
type RateLimitEnv = {
  RATE_LIMIT_MAX?: string;
  RATE_LIMIT_WINDOW_MS?: string;
};

export class RateLimitDO {
  state: DurableObjectState;
  env: RateLimitEnv;
  constructor(state: DurableObjectState, env: RateLimitEnv = {}) {
    this.state = state;
    this.env = env;
  }

  private resolveLimit(): number {
    const parsed = Number(this.env.RATE_LIMIT_MAX ?? RATE_LIMIT_MAX);
    if (!Number.isFinite(parsed) || parsed <= 0) return RATE_LIMIT_MAX;
    return Math.floor(parsed);
  }

  private resolveWindowMs(): number {
    const parsed = Number(this.env.RATE_LIMIT_WINDOW_MS ?? RATE_LIMIT_WINDOW_MS);
    if (!Number.isFinite(parsed) || parsed <= 0) return RATE_LIMIT_WINDOW_MS;
    return Math.floor(parsed);
  }

  async fetch(request: Request): Promise<Response> {
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (typeof this.state.blockConcurrencyWhile === "function") {
        return this.state.blockConcurrencyWhile(fn);
      }
      return fn();
    };

    let requestLimit: number | undefined;
    let action = "rate_limit";
    let leaseTtlMs = 30_000;
    let leaseToken: string | undefined;
    try {
      const body = (await request.json()) as {
        limit?: number;
        action?: string;
        ttl_ms?: number;
        token?: string;
      } | null;
      if (body && typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0) {
        requestLimit = Math.floor(body.limit);
      }
      if (body && typeof body.action === "string" && body.action.trim().length > 0) {
        action = body.action.trim().toLowerCase();
      }
      if (body && typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms) && body.ttl_ms > 0) {
        leaseTtlMs = Math.max(1_000, Math.min(120_000, Math.floor(body.ttl_ms)));
      }
      if (body && typeof body.token === "string" && body.token.trim().length > 0) {
        leaseToken = body.token.trim();
      }
    } catch {
      /* no body or invalid JSON: use env default */
    }

    return withLock(async () => {
      const now = Date.now();
      if (action === "concurrency_acquire") {
        const limit = requestLimit ?? this.resolveLimit();
        const state = ((await this.state.storage.get<ConcurrencyLeases>("concurrency_leases")) as ConcurrencyLeases | null) ?? { leases: {} };
        for (const [token, expiresAt] of Object.entries(state.leases)) {
          if (!Number.isFinite(expiresAt) || expiresAt <= now) delete state.leases[token];
        }
        const activeCount = Object.keys(state.leases).length;
        if (activeCount >= limit) {
          await this.state.storage.put("concurrency_leases", state);
          return new Response(
            JSON.stringify({
              allowed: false,
              count: activeCount,
              limit,
              retry_after: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const token = leaseToken ?? crypto.randomUUID();
        state.leases[token] = now + leaseTtlMs;
        const count = Object.keys(state.leases).length;
        await this.state.storage.put("concurrency_leases", state);
        return new Response(
          JSON.stringify({
            allowed: true,
            count,
            limit,
            token,
            retry_after: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (action === "concurrency_release") {
        const state = ((await this.state.storage.get<ConcurrencyLeases>("concurrency_leases")) as ConcurrencyLeases | null) ?? { leases: {} };
        for (const [token, expiresAt] of Object.entries(state.leases)) {
          if (!Number.isFinite(expiresAt) || expiresAt <= now) delete state.leases[token];
        }
        const token = leaseToken ?? "";
        const released = token.length > 0 && token in state.leases;
        if (released) delete state.leases[token];
        const count = Object.keys(state.leases).length;
        await this.state.storage.put("concurrency_leases", state);
        return new Response(
          JSON.stringify({
            released,
            count,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      const limit = requestLimit ?? this.resolveLimit();
      const windowMs = this.resolveWindowMs();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const staleBefore = windowStart - windowMs * 2;

      let stored = ((await this.state.storage.get<Bucket>("bucket")) as Bucket | null) ?? null;
      if (stored && stored.windowStart < staleBefore) {
        await this.state.storage.delete("bucket");
        stored = null;
      }
      const bucket: Bucket = stored && stored.windowStart === windowStart ? stored : { count: 0, windowStart };
      bucket.count += 1;

      await this.state.storage.put("bucket", bucket);

      const allowed = bucket.count <= limit;
      const resetSec = Math.floor((windowStart + windowMs) / 1000);
      return new Response(
        JSON.stringify({
          allowed,
          count: bucket.count,
          limit,
          reset: resetSec,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }
}
