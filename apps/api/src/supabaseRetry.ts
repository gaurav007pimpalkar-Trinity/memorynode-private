/**
 * Retry helper for transient Supabase/Postgres failures (connection, timeout, 5xx).
 * Use for critical path: auth salt lookup, session read/write, /ready probe.
 */

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_DELAYS_MS = [300, 700];

function isRetryable(err: unknown): boolean {
  const msg = typeof (err as Error)?.message === "string" ? (err as Error).message.toLowerCase() : "";
  const code = typeof (err as { code?: string })?.code === "string" ? (err as { code: string }).code : "";
  if (
    msg.includes("fetch") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("connection") ||
    msg.includes("503") ||
    msg.includes("502") ||
    msg.includes("504") ||
    msg.includes("network") ||
    code === "PGRST301" ||
    code === "PGRST999"
  ) {
    return true;
  }
  return false;
}

/**
 * Run an async function and retry on transient failure. Uses exponential-style delays.
 */
export async function withSupabaseRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; delaysMs?: number[] },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delaysMs = options?.delaysMs ?? DEFAULT_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delayMs = delaysMs[attempt] ?? 500;
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Run a Supabase-style query (returns { data, error }) and retry when error is retryable.
 * Use when the client returns { data, error } instead of throwing.
 */
export async function withSupabaseQueryRetry<T, E>(
  fn: () => Promise<{ data: T; error: E | null }>,
  options?: { maxRetries?: number; delaysMs?: number[] },
): Promise<{ data: T; error: E | null }> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delaysMs = options?.delaysMs ?? DEFAULT_DELAYS_MS;
  let lastResult: { data: T; error: E | null };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await fn();
    lastResult = result;
    if (!result.error) return result;
    if (attempt < maxRetries && isRetryable(result.error as unknown)) {
      const delayMs = delaysMs[attempt] ?? 500;
      await new Promise((r) => setTimeout(r, delayMs));
    } else {
      return result;
    }
  }
  return lastResult!;
}
