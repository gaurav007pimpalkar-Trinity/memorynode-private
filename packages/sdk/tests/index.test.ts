import { describe, expect, it, beforeEach, vi } from "vitest";
import { MemoryNodeClient } from "../src/index.js";

const okResponse = (data: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => data,
  } as Response);

describe("MemoryNodeClient request mapping", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    // @ts-expect-error test double
    global.fetch = fetchMock;
  });

  it("maps camelCase options to snake_case wire for search", async () => {
    fetchMock.mockReturnValue(
      okResponse({ results: [], page: 2, page_size: 5, total: 0, has_more: false }),
    );
    const client = new MemoryNodeClient({ apiKey: "test-key" });

    await client.search({
      userId: "u1",
      query: "hello",
      page: 2,
      pageSize: 5,
      metadata: { topic: "ai" },
      startTime: "2024-01-01T00:00:00Z",
      endTime: "2024-02-01T00:00:00Z",
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.user_id).toBe("u1");
    expect(body.page).toBe(2);
    expect(body.page_size).toBe(5);
    expect(body.filters.start_time).toBe("2024-01-01T00:00:00Z");
    expect(body.filters.metadata.topic).toBe("ai");
  });

  it("maps camelCase options to snake_case wire for context", async () => {
    fetchMock.mockReturnValue(
      okResponse({ context_text: "", citations: [], page: 1, page_size: 8, total: 0, has_more: false }),
    );
    const client = new MemoryNodeClient({ apiKey: "test-key" });

    await client.context({
      userId: "u1",
      query: "hello",
      pageSize: 8,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.page_size).toBe(8);
    expect(body.top_k).toBeUndefined();
  });

  it("omits filters when none are provided", async () => {
    fetchMock.mockReturnValue(okResponse({ results: [] }));
    const client = new MemoryNodeClient({ apiKey: "test-key" });
    await client.search({ userId: "u1", query: "hello" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.filters).toBeUndefined();
  });

  it("listMemories expects results key in response", async () => {
    fetchMock.mockReturnValue(
      okResponse({ results: [{ id: "m1" }], page: 1, page_size: 1, total: 1, has_more: false }),
    );
    const client = new MemoryNodeClient({ apiKey: "test-key" });
    const resp = await client.listMemories();
    expect(resp.results?.length).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("posts artifact payload when using importMemories", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ imported_memories: 1, imported_chunks: 2 }),
      } as Response),
    );

    const client = new MemoryNodeClient({ apiKey: "test-key" });
    const data = await client.importMemories("artifact-b64", "upsert");
    expect(data.imported_memories).toBe(1);
    expect(data.imported_chunks).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string)).toContain("/v1/import");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.artifact_base64).toBe("artifact-b64");
    expect(body.mode).toBe("upsert");
  });

  it("parses API error shape { error: { code, message } } and throws MemoryNodeApiError", async () => {
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        json: async () => ({ error: { code: "rate_limited", message: "Rate limit exceeded" } }),
      } as Response),
    );

    const client = new MemoryNodeClient({ apiKey: "test-key" });
    const { MemoryNodeApiError } = await import("../src/index.js");

    try {
      await client.search({ userId: "u1", query: "x" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryNodeApiError);
      expect((e as InstanceType<typeof MemoryNodeApiError>).code).toBe("rate_limited");
      expect((e as InstanceType<typeof MemoryNodeApiError>).message).toBe("Rate limit exceeded");
      expect((e as InstanceType<typeof MemoryNodeApiError>).status).toBe(429);
    }
  });

  it("throws MISSING_API_KEY when no apiKey and calling protected endpoint", async () => {
    const client = new MemoryNodeClient({ baseUrl: "https://api.example.com" });
    const { MemoryNodeApiError } = await import("../src/index.js");

    try {
      await client.addMemory({ userId: "u1", text: "x" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryNodeApiError);
      expect((e as InstanceType<typeof MemoryNodeApiError>).code).toBe("MISSING_API_KEY");
    }
  });

  it("allows health() without apiKey", async () => {
    fetchMock.mockReturnValue(okResponse({ status: "ok" }));
    const client = new MemoryNodeClient();
    await client.health();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("passes abort signal into fetch init", async () => {
    fetchMock.mockReturnValue(okResponse({ results: [] }));
    const ac = new AbortController();
    const client = new MemoryNodeClient({ apiKey: "test-key", signal: ac.signal, timeoutMs: 0 });
    await client.search({ userId: "u1", query: "hello" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).signal).toBe(ac.signal);
  });

  it("maps fetch AbortError to REQUEST_ABORTED", async () => {
    const abortErr = new Error("The user aborted a request.");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);
    const { MemoryNodeApiError } = await import("../src/index.js");
    const client = new MemoryNodeClient({ apiKey: "test-key", timeoutMs: 0 });
    await expect(client.search({ userId: "u1", query: "hello" })).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
  });

  it("retries retryable 5xx for search then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: { code: "SERVICE_UNAVAILABLE", message: "try later" } }),
      } as Response)
      .mockResolvedValueOnce(okResponse({ results: [], page: 1, page_size: 10, total: 0, has_more: false }));

    const client = new MemoryNodeClient({ apiKey: "test-key", maxRetries: 1, retryBaseMs: 1 });
    const out = await client.search({ userId: "u1", query: "retry me" });
    expect(Array.isArray(out.results)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable 4xx for search", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: { code: "BAD_REQUEST", message: "invalid" } }),
    } as Response);

    const client = new MemoryNodeClient({ apiKey: "test-key", maxRetries: 2, retryBaseMs: 1 });
    await expect(client.search({ userId: "u1", query: "bad" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient network error then succeeds", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(okResponse({ status: "ok" }));

    const client = new MemoryNodeClient({ maxRetries: 1, retryBaseMs: 1 });
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
