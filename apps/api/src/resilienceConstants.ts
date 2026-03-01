/**
 * Centralized resilience constants: retries, timeouts, circuit breaker.
 * Single source of truth to avoid magic numbers across workerApp and handlers.
 */

/** Max retry attempts (total requests = 1 + this value). */
export const RETRY_MAX_ATTEMPTS = 2;

/** Supabase retry delays (ms) per attempt. */
export const SUPABASE_RETRY_DELAYS_MS = [300, 700];

/** OpenAI embed retry delays (ms) per attempt. */
export const OPENAI_EMBED_RETRY_DELAYS_MS = [500, 1000];

/** OpenAI extraction / PayU verify retry delays (ms); slightly longer backoff. */
export const OPENAI_EXTRACT_RETRY_DELAYS_MS = [500, 1500];
export const PAYU_VERIFY_RETRY_DELAYS_MS = [500, 1500];

/** Request timeout for OpenAI embeddings (ms). */
export const EMBED_REQUEST_TIMEOUT_MS = 30_000;

/** Request timeout for OpenAI chat (extraction) (ms). */
export const EXTRACT_REQUEST_TIMEOUT_MS = 15_000;

/** PayU verify request timeout (ms). */
export const PAYU_VERIFY_TIMEOUT_MS = 10_000;

/** Circuit breaker: open after this many consecutive failures in the window. */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/** Circuit breaker: count failures within this window (ms). */
export const CIRCUIT_BREAKER_WINDOW_MS = 60_000;

/** Circuit breaker: stay open for this duration (ms) before allowing a probe. */
export const CIRCUIT_BREAKER_OPEN_MS = 60_000;
