import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./limits.js";

type Bucket = { count: number; windowStart: number };

export class RateLimitDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(_request: Request): Promise<Response> {
    void _request;
    const now = Date.now();
    const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    const staleBefore = windowStart - RATE_LIMIT_WINDOW_MS * 2;

    let stored = ((await this.state.storage.get<Bucket>("bucket")) as Bucket | null) ?? null;
    if (stored && stored.windowStart < staleBefore) {
      await this.state.storage.delete("bucket");
      stored = null;
    }
    const bucket: Bucket = stored && stored.windowStart === windowStart ? stored : { count: 0, windowStart };
    bucket.count += 1;

    await this.state.storage.put("bucket", bucket);

    const allowed = bucket.count <= RATE_LIMIT_MAX;
    const resetSec = Math.floor((windowStart + RATE_LIMIT_WINDOW_MS) / 1000);
    return new Response(
      JSON.stringify({
        allowed,
        count: bucket.count,
        limit: RATE_LIMIT_MAX,
        reset: resetSec,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}
