import { describe, expect, it } from "vitest";
import { McpResponseCache } from "../src/mcpCache.js";

describe("McpResponseCache", () => {
  it("hits and misses deterministically", async () => {
    const cache = new McpResponseCache({ maxSize: 5, ttlByTool: { recall: 1000, context: 1000 } });
    const key = cache.makeKey({ tool: "recall", scope: "w:u:n", query: "abc", policyVersion: "v1" });
    const a = await cache.getOrCompute(key, { tool: "recall", scope: "w:u:n" }, async () => "x");
    const b = await cache.getOrCompute(key, { tool: "recall", scope: "w:u:n" }, async () => "y");
    expect(a.value).toBe("x");
    expect(b.value).toBe("x");
    expect(b.cacheHit).toBe(true);
  });

  it("enforces LRU eviction order", async () => {
    const cache = new McpResponseCache({ maxSize: 2, ttlByTool: { recall: 5000, context: 5000 } });
    const k1 = cache.makeKey({ tool: "recall", scope: "s", query: "1", policyVersion: "v1" });
    const k2 = cache.makeKey({ tool: "recall", scope: "s", query: "2", policyVersion: "v1" });
    const k3 = cache.makeKey({ tool: "recall", scope: "s", query: "3", policyVersion: "v1" });
    await cache.getOrCompute(k1, { tool: "recall", scope: "s" }, async () => "a");
    await cache.getOrCompute(k2, { tool: "recall", scope: "s" }, async () => "b");
    await cache.getOrCompute(k3, { tool: "recall", scope: "s" }, async () => "c");
    const r1 = await cache.getOrCompute(k1, { tool: "recall", scope: "s" }, async () => "new-a");
    expect(r1.value).toBe("new-a");
    expect(cache.snapshot().evict).toBeGreaterThan(0);
  });

  it("invalidates scope after write operations", async () => {
    const cache = new McpResponseCache({ maxSize: 10 });
    const key = cache.makeKey({ tool: "context", scope: "w:u:n", query: "hello", policyVersion: "v1" });
    await cache.getOrCompute(key, { tool: "context", scope: "w:u:n" }, async () => ({ ok: true }));
    cache.invalidateScope("w:u:n");
    const out = await cache.getOrCompute(key, { tool: "context", scope: "w:u:n" }, async () => ({ ok: false }));
    expect(out.value).toEqual({ ok: false });
    expect(cache.snapshot().invalidate).toBeGreaterThan(0);
  });

  it("coalesces concurrent in-flight requests", async () => {
    const cache = new McpResponseCache({ maxSize: 10 });
    const key = cache.makeKey({ tool: "recall", scope: "w:u:n", query: "parallel", policyVersion: "v1" });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return "v";
    };
    const [a, b] = await Promise.all([
      cache.getOrCompute(key, { tool: "recall", scope: "w:u:n" }, compute),
      cache.getOrCompute(key, { tool: "recall", scope: "w:u:n" }, compute),
    ]);
    expect(a.value).toBe("v");
    expect(b.value).toBe("v");
    expect(calls).toBe(1);
  });
});
