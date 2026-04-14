/**
 * MemoryNode MCP Server (Phase 3). Thin HTTP adapter: no Supabase, no business logic.
 * Exposes memory_search, memory_insert tools and memory://search?q=... resource via stdio.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Env (throw at startup if missing) ---
const MEMORYNODE_API_KEY = process.env.MEMORYNODE_API_KEY;
const MEMORYNODE_BASE_URL = process.env.MEMORYNODE_BASE_URL;
const MEMORYNODE_USER_ID = process.env.MEMORYNODE_USER_ID ?? "default";
const MEMORYNODE_NAMESPACE = process.env.MEMORYNODE_NAMESPACE ?? "default";

if (!MEMORYNODE_API_KEY || typeof MEMORYNODE_API_KEY !== "string" || !MEMORYNODE_API_KEY.trim()) {
  console.error("MEMORYNODE_API_KEY is required. Set it in your environment or .env.");
  process.exit(1);
}
if (!MEMORYNODE_BASE_URL || typeof MEMORYNODE_BASE_URL !== "string" || !MEMORYNODE_BASE_URL.trim()) {
  console.error("MEMORYNODE_BASE_URL is required (e.g. https://api.memorynode.ai). Set it in your environment or .env.");
  process.exit(1);
}

const baseUrl = MEMORYNODE_BASE_URL.replace(/\/$/, "");
const apiKey = MEMORYNODE_API_KEY.trim();

// --- REST helpers ---
type RestFetchOptions = {
  method: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
};

function mapRestStatusToMcpCode(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return "internal_error";
}

async function restFetch(
  path: string,
  init: RestFetchOptions
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = await res.text();
  }
  if (!res.ok) {
    const errMsg =
      typeof data === "object" && data && "error" in (data as { error?: { message?: string } })
        ? (data as { error: { message?: string } }).error?.message
        : String(data);
    return { ok: false, status: res.status, error: errMsg };
  }
  return { ok: true, status: res.status, data };
}

// --- Search (shared) ---
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_LIMIT_DEFAULT = 5;

function formatSearchResults(results: Array<{ text?: string; score?: number }>): string {
  return results
    .map((r, i) => {
      const score = typeof r.score === "number" ? r.score.toFixed(2) : "—";
      const content = typeof r.text === "string" ? r.text : "";
      return `Result ${i + 1}\nScore: ${score}\nContent: ${content}\n`;
    })
    .join("\n");
}

function formatSearchResultsMarkdown(results: Array<{ text?: string; score?: number }>): string {
  return results
    .map((r, i) => {
      const score = typeof r.score === "number" ? r.score.toFixed(2) : "—";
      const content = typeof r.text === "string" ? r.text : "";
      return `## Result ${i + 1}\n**Score:** ${score}\n\n${content}\n`;
    })
    .join("\n");
}

async function doSearch(query: string, limit: number): Promise<string> {
  const out = await restFetch("/v1/search", {
    method: "POST",
    body: {
      user_id: MEMORYNODE_USER_ID,
      namespace: MEMORYNODE_NAMESPACE,
      query: query.trim(),
      top_k: limit,
    },
  });
  if (!out.ok) {
    const code = mapRestStatusToMcpCode(out.status);
    throw new Error(JSON.stringify({ code, message: out.error ?? "Search failed" }));
  }
  const results = Array.isArray((out.data as { results?: unknown[] })?.results)
    ? (out.data as { results: Array<{ text?: string; score?: number }> }).results
    : [];
  return formatSearchResults(results);
}

// --- Insert ---
const INSERT_CONTENT_MAX = 10_000;
const METADATA_STRINGIFIED_MAX = 5 * 1024; // 5KB

async function doInsert(content: string, metadata?: Record<string, unknown>): Promise<void> {
  if (metadata !== undefined) {
    const str = JSON.stringify(metadata);
    if (str.length > METADATA_STRINGIFIED_MAX) {
      throw new Error(
        JSON.stringify({
          code: "invalid_request",
          message: "metadata stringified exceeds 5KB",
        })
      );
    }
  }
  const body: Record<string, unknown> = {
    user_id: MEMORYNODE_USER_ID,
    namespace: MEMORYNODE_NAMESPACE,
    text: content,
  };
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }
  const out = await restFetch("/v1/memories", {
    method: "POST",
    body,
  });
  if (!out.ok) {
    const code = mapRestStatusToMcpCode(out.status);
    throw new Error(JSON.stringify({ code, message: out.error ?? "Insert failed" }));
  }
}

async function doContext(query: string, limit: number): Promise<string> {
  const out = await restFetch("/v1/context", {
    method: "POST",
    body: {
      user_id: MEMORYNODE_USER_ID,
      namespace: MEMORYNODE_NAMESPACE,
      query: query.trim(),
      top_k: limit,
    },
  });
  if (!out.ok) {
    const code = mapRestStatusToMcpCode(out.status);
    throw new Error(JSON.stringify({ code, message: out.error ?? "Context failed" }));
  }
  const data = (out.data ?? {}) as { context_text?: string; citations?: Array<{ text?: string }> };
  const context = typeof data.context_text === "string" ? data.context_text.trim() : "";
  if (context) return context;
  const citations = Array.isArray(data.citations) ? data.citations : [];
  return citations
    .map((c, i) => `Result ${i + 1}: ${typeof c.text === "string" ? c.text : ""}`)
    .join("\n")
    .trim();
}

// --- MCP server ---
const server = new McpServer(
  {
    name: "memorynode-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Tool: memory_search
server.registerTool(
  "memory_search",
  {
    description: "Search persistent memory using semantic + recency-aware ranking.",
    inputSchema: {
      query: z.string().min(1).describe("Search query (required)"),
      limit: z.number().int().min(SEARCH_LIMIT_MIN).max(SEARCH_LIMIT_MAX).optional().default(SEARCH_LIMIT_DEFAULT).describe("Max results (default 5, max 20)"),
    },
  },
  async ({ query, limit }) => {
    const limitVal = limit ?? SEARCH_LIMIT_DEFAULT;
    const capped = Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, limitVal));
    const text = await doSearch(query, capped);
    return { content: [{ type: "text" as const, text }] };
  }
);

server.registerTool(
  "memory_context",
  {
    description: "Build prompt-ready context text from persistent memory.",
    inputSchema: {
      query: z.string().min(1).describe("Context query (required)"),
      limit: z.number().int().min(SEARCH_LIMIT_MIN).max(SEARCH_LIMIT_MAX).optional().default(SEARCH_LIMIT_DEFAULT).describe("Max snippets (default 5, max 20)"),
    },
  },
  async ({ query, limit }) => {
    const limitVal = limit ?? SEARCH_LIMIT_DEFAULT;
    const capped = Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, limitVal));
    const text = await doContext(query, capped);
    return { content: [{ type: "text" as const, text: text || "No context found." }] };
  }
);

// Tool: memory_insert
server.registerTool(
  "memory_insert",
  {
    description: "Store new persistent memory entry.",
    inputSchema: {
      content: z.string().min(1).max(INSERT_CONTENT_MAX).describe("Memory content (required, max 10,000 chars)"),
      metadata: z.record(z.unknown()).optional().describe("Optional JSON-serializable metadata (stringified max 5KB)"),
    },
  },
  async ({ content, metadata }) => {
    await doInsert(content, metadata);
    return { content: [{ type: "text" as const, text: "Memory stored successfully." }] };
  }
);

// Resource: memory://search?q=...
server.registerResource(
  "memory-search",
  new ResourceTemplate("memory://search{?q}", { list: undefined }),
  { description: "Semantic search over persistent memory. Use URI memory://search?q=... with query param q." },
  async (uri) => {
    const q = uri.searchParams.get("q");
    if (q === null || q === undefined || String(q).trim() === "") {
      throw new Error(JSON.stringify({ code: "invalid_request", message: "Missing required query param: q" }));
    }
    const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, SEARCH_LIMIT_DEFAULT));
    const out = await restFetch("/v1/search", {
      method: "POST",
      body: {
        user_id: MEMORYNODE_USER_ID,
        namespace: MEMORYNODE_NAMESPACE,
        query: String(q).trim(),
        top_k: limit,
      },
    });
    if (!out.ok) {
      const code = mapRestStatusToMcpCode(out.status);
      throw new Error(JSON.stringify({ code, message: out.error ?? "Search failed" }));
    }
    const results = Array.isArray((out.data as { results?: unknown[] })?.results)
      ? (out.data as { results: Array<{ text?: string; score?: number }> }).results
      : [];
    const markdown = formatSearchResultsMarkdown(results);
    return {
      contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: markdown }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
