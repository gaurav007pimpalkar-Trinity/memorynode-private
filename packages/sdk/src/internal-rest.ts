import { MemoryNodeApiError } from "./errors.js";

export type RestTransportOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  outerSignal?: AbortSignal;
  maxRetries: number;
  retryBaseMs: number;
};

/**
 * Internal JSON REST bridge — used when MCP tools cannot express the full request yet (see Sprint S5 parity).
 * Not part of the public SDK contract surface; MemoryNodeClient delegates here only.
 */
export class InternalRestTransport {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly outerSignal?: AbortSignal;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(opts: RestTransportOptions) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs;
    this.outerSignal = opts.outerSignal;
    this.maxRetries = opts.maxRetries;
    this.retryBaseMs = opts.retryBaseMs;
  }

  composeFetchSignal(override?: AbortSignal): AbortSignal | undefined {
    const parts: AbortSignal[] = [];
    if (this.timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      parts.push(AbortSignal.timeout(this.timeoutMs));
    }
    if (this.outerSignal) parts.push(this.outerSignal);
    if (override) parts.push(override);
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    if (typeof AbortSignal.any === "function") return AbortSignal.any(parts);
    return parts[0];
  }

  async waitBeforeRetry(attempt: number): Promise<void> {
    const jitter = Math.floor(Math.random() * 50);
    const delay = this.retryBaseMs * Math.pow(2, attempt) + jitter;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  isRetryableRequest(method: string, path: string): boolean {
    const m = method.toUpperCase();
    if (m === "GET" || m === "DELETE") return true;
    if (m !== "POST") return false;
    return (
      path === "/v1/search" ||
      path === "/v1/context" ||
      path === "/v1/evals/run" ||
      path === "/v1/context/feedback" ||
      path === "/v1/explain/answer" ||
      path.startsWith("/v1/search?")
    );
  }

  buildHeaders(adminToken?: string): HeadersInit {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (adminToken) {
      headers["x-admin-token"] = adminToken;
    } else if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async request<T>(
    path: string,
    init: { method: string; body?: unknown; adminToken?: string; signal?: AbortSignal },
  ): Promise<T> {
    const isPublicHealth = path === "/healthz" || path.startsWith("/healthz?");
    if (!init.adminToken && this.apiKey === undefined && !isPublicHealth) {
      throw new MemoryNodeApiError(
        "MISSING_API_KEY",
        "API key is required for this request. Pass apiKey in constructor or use adminToken for admin endpoints.",
        undefined,
      );
    }

    const retryable = this.isRetryableRequest(init.method, path);
    const maxAttempts = retryable ? this.maxRetries + 1 : 1;
    let lastError: MemoryNodeApiError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await fetch(new URL(path, this.baseUrl).toString(), {
          method: init.method,
          headers: this.buildHeaders(init.adminToken),
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: this.composeFetchSignal(init.signal),
        });
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e?.name === "AbortError") {
          throw new MemoryNodeApiError("REQUEST_ABORTED", e.message || "Request aborted", undefined);
        }
        lastError = new MemoryNodeApiError("NETWORK_ERROR", e?.message || "Network request failed", undefined);
        if (attempt < maxAttempts - 1) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const apiErr = await this.toApiError(response);
        lastError = apiErr;
        if (attempt < maxAttempts - 1 && this.isRetryableStatus(response.status)) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw apiErr;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }
    throw lastError ?? new MemoryNodeApiError("HTTP_ERROR", "Request failed", undefined);
  }

  async toApiError(response: Response): Promise<MemoryNodeApiError> {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // non-JSON or empty body
    }

    const err = body?.error;
    const code = typeof err?.code === "string" ? err.code : "HTTP_ERROR";
    const message = typeof err?.message === "string" ? err.message : response.statusText;
    const status = response.status;

    return new MemoryNodeApiError(code, message, status);
  }
}
