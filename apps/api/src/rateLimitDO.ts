import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./limits.js";

type Bucket = { count: number; windowStart: number };
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

  async fetch(_request: Request): Promise<Response> {
    void _request;
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (typeof this.state.blockConcurrencyWhile === "function") {
        return this.state.blockConcurrencyWhile(fn);
      }
      return fn();
    };

    return withLock(async () => {
      const limit = this.resolveLimit();
      const windowMs = this.resolveWindowMs();
      const now = Date.now();
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
