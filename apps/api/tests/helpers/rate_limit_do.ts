import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../../src/limits.js";

type Bucket = { count: number; windowStart: number };

export function makeRateLimitDoStub(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  const buckets = new Map<string, Bucket>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      return {
        fetch: async () => {
          const now = Date.now();
          const windowStart = Math.floor(now / windowMs) * windowMs;
          const bucket = buckets.get(id) ?? { count: 0, windowStart };
          if (bucket.windowStart !== windowStart) {
            bucket.windowStart = windowStart;
            bucket.count = 0;
          }
          bucket.count += 1;
          buckets.set(id, bucket);
          const reset = Math.floor((bucket.windowStart + windowMs) / 1000);
          return new Response(
            JSON.stringify({ allowed: bucket.count <= limit, count: bucket.count, limit, reset }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      };
    },
  };
}
