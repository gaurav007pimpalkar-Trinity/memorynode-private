import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "../../src/limits.js";

type Bucket = { count: number; windowStart: number };
type LeaseMap = Map<string, number>;

export function makeRateLimitDoStub(limit = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  const buckets = new Map<string, Bucket>();
  const concurrency = new Map<string, LeaseMap>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      return {
        fetch: async (input: Request | string | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init);
          let useLimit = limit;
          let action = "rate_limit";
          let ttlMs = 30_000;
          let token: string | undefined;
          try {
            const body = (await req.json()) as {
              limit?: number;
              action?: string;
              ttl_ms?: number;
              token?: string;
            } | null;
            if (body && typeof body.action === "string" && body.action.trim().length > 0) {
              action = body.action.trim().toLowerCase();
            }
            if (body && typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0) {
              // Per-request limit from the Worker (e.g. workspace RPM) cannot exceed this stub's
              // configured ceiling — tests use a low ceiling while production sends a higher RPM.
              useLimit = Math.min(limit, Math.floor(body.limit));
            }
            if (body && typeof body.ttl_ms === "number" && Number.isFinite(body.ttl_ms) && body.ttl_ms > 0) {
              ttlMs = Math.max(1_000, Math.min(120_000, Math.floor(body.ttl_ms)));
            }
            if (body && typeof body.token === "string" && body.token.trim().length > 0) {
              token = body.token.trim();
            }
          } catch {
            /* ignore */
          }
          const now = Date.now();
          if (action === "concurrency_acquire") {
            const leases = concurrency.get(id) ?? new Map<string, number>();
            for (const [leaseToken, exp] of leases.entries()) {
              if (exp <= now) leases.delete(leaseToken);
            }
            if (leases.size >= useLimit) {
              concurrency.set(id, leases);
              return new Response(
                JSON.stringify({ allowed: false, count: leases.size, limit: useLimit, retry_after: 1 }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }
            const nextToken = token ?? `lease_${id}_${now}_${Math.random().toString(36).slice(2, 10)}`;
            leases.set(nextToken, now + ttlMs);
            concurrency.set(id, leases);
            return new Response(
              JSON.stringify({ allowed: true, count: leases.size, limit: useLimit, token: nextToken, retry_after: 0 }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (action === "concurrency_release") {
            const leases = concurrency.get(id) ?? new Map<string, number>();
            for (const [leaseToken, exp] of leases.entries()) {
              if (exp <= now) leases.delete(leaseToken);
            }
            const released = Boolean(token && leases.delete(token));
            concurrency.set(id, leases);
            return new Response(
              JSON.stringify({ released, count: leases.size }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
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
            JSON.stringify({ allowed: bucket.count <= useLimit, count: bucket.count, limit: useLimit, reset }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      };
    },
  };
}
