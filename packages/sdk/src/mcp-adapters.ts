import type { SearchResponse } from "@memorynodeai/shared";

/** MCP `search` / `recall` tool structured payload (subset). */
export type McpSearchStructured = {
  status?: string;
  results?: Array<{
    memory_id: string;
    chunk_id?: string;
    chunk_index?: number;
    text: string;
    score: number;
  }>;
  meta?: Record<string, unknown>;
};

export function adaptMcpSearchToSearchResponse(structured: unknown): SearchResponse {
  const sc = structured as McpSearchStructured;
  const results = Array.isArray(sc.results)
    ? sc.results.map((r) => ({
        chunk_id: typeof r.chunk_id === "string" ? r.chunk_id : "",
        memory_id: r.memory_id,
        chunk_index: typeof r.chunk_index === "number" ? r.chunk_index : 0,
        text: r.text,
        score: r.score,
      }))
    : [];
  return {
    results,
    page: 1,
    page_size: results.length,
    total: results.length,
    has_more: false,
  };
}
