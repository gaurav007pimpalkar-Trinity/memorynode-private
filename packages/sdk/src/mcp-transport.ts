import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryNodeApiError } from "./errors.js";
import { adaptMcpSearchToSearchResponse } from "./mcp-adapters.js";
import type { SearchResponse } from "@memorynodeai/shared";

/** Streamable MCP URL on the Worker (`/v1/mcp` on API origin, `/mcp` on dedicated MCP hosts — same router). */
export function resolveMcpUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return new URL("mcp", `${trimmed}/`);
  return new URL("v1/mcp", `${trimmed}/`);
}

export type McpTransportOpenOptions = {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
};

/**
 * Holds one MCP Streamable HTTP session (`Client` + transport). Lazily connects on first use.
 *
 * Sprint S2 ships search via `search` tool; other SDK methods continue to use {@link InternalRestTransport} until P1 MCP coverage (see docs/PLAN.md).
 */
export class MemoryNodeMcpTransport {
  private client: Client | undefined;
  private connecting: Promise<void> | undefined;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly outerSignal?: AbortSignal;

  constructor(opts: McpTransportOpenOptions) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.outerSignal = opts.signal;
  }

  async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;

    const mcpUrl = resolveMcpUrl(this.baseUrl);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json, text/event-stream",
        },
        signal: this.outerSignal,
      },
    });

    const client = new Client({ name: "@memorynodeai/sdk", version: "1.0.0" });
    this.connecting = client.connect(transport).then(() => {
      this.client = client;
      this.connecting = undefined;
    });
    try {
      await this.connecting;
    } catch (e) {
      this.connecting = undefined;
      this.client = undefined;
      const msg = e instanceof Error ? e.message : String(e);
      throw new MemoryNodeApiError("MCP_CONNECT_FAILED", `MCP transport connection failed: ${msg}`, undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.close();
    } finally {
      this.client = undefined;
    }
  }

  /** Calls MCP tool `search` with arguments aligned to hosted registration (query, top_k, containerTag, includeProfile). */
  async searchTool(args: {
    query: string;
    top_k?: number;
    containerTag?: string;
    includeProfile?: boolean;
  }): Promise<SearchResponse> {
    await this.ensureConnected();
    const c = this.client;
    if (!c) throw new MemoryNodeApiError("MCP_NOT_CONNECTED", "MCP client not initialized", undefined);

    const result = await c.callTool({
      name: "search",
      arguments: {
        query: args.query,
        top_k: args.top_k ?? 10,
        ...(args.containerTag !== undefined ? { containerTag: args.containerTag } : {}),
        ...(args.includeProfile !== undefined ? { includeProfile: args.includeProfile } : {}),
      },
    });

    const structured =
      typeof result === "object" &&
      result !== null &&
      "structuredContent" in result &&
      (result as { structuredContent?: unknown }).structuredContent !== undefined
        ? (result as { structuredContent: unknown }).structuredContent
        : result;

    return adaptMcpSearchToSearchResponse(structured);
  }
}
