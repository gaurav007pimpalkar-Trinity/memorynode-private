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

  it("requests binary export when using exportMemoriesZip", async () => {
    const bytes = new TextEncoder().encode("zip-bytes");
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      } as Response),
    );

    const client = new MemoryNodeClient({ apiKey: "test-key" });
    const data = await client.exportMemoriesZip();
    expect(data).toEqual(bytes);
    const [url, init] = fetchMock.mock.calls[0];
    expect((url as string)).toContain("format=zip");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.accept).toBe("application/zip");
  });
});
