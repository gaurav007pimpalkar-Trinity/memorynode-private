/**
 * Lightweight in-memory circuit breaker (no external infra).
 * Per-dependency: separate state for "openai" and "supabase".
 * Does not persist across deploys.
 */

import { logger } from "./logger.js";
import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_WINDOW_MS,
  CIRCUIT_BREAKER_OPEN_MS,
} from "./resilienceConstants.js";

export type CircuitName = "openai" | "supabase";

type State = {
  failures: number;
  windowStart: number;
  openUntil: number;
};

const state: Map<CircuitName, State> = new Map();

function getState(name: CircuitName): State {
  let s = state.get(name);
  const now = Date.now();
  if (!s) {
    s = { failures: 0, windowStart: now, openUntil: 0 };
    state.set(name, s);
  }
  // Reset failure count if outside current window
  if (now - s.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    s.failures = 0;
    s.windowStart = now;
  }
  return s;
}

/**
 * Returns true if the circuit is open (requests should fail fast with 503).
 */
export function isOpen(name: CircuitName): boolean {
  const s = getState(name);
  const now = Date.now();
  if (s.openUntil > now) return true;
  return false;
}

/**
 * Record a success. Resets failure count and closes the circuit if it was open (probe succeeded).
 */
export function recordSuccess(name: CircuitName): void {
  const s = state.get(name);
  if (!s) return;
  s.failures = 0;
  s.windowStart = Date.now();
  if (s.openUntil > Date.now()) {
    s.openUntil = 0;
    logger.info({ event: "circuit_breaker_closed", circuit: name });
  }
}

/**
 * Record a failure. May open the circuit if threshold reached.
 */
export function recordFailure(name: CircuitName): void {
  const s = getState(name);
  s.failures += 1;
  const now = Date.now();
  if (s.failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    s.openUntil = now + CIRCUIT_BREAKER_OPEN_MS;
    logger.warn({
      event: "circuit_breaker_open",
      circuit: name,
      failures: s.failures,
      open_until_ms: CIRCUIT_BREAKER_OPEN_MS,
    });
  }
}

/**
 * Run fn; if circuit is open, throw immediately. On success call recordSuccess; on failure call recordFailure.
 */
export async function withCircuitBreaker<T>(
  name: CircuitName,
  fn: () => Promise<T>,
): Promise<T> {
  if (isOpen(name)) {
    throw new Error(`CIRCUIT_OPEN:${name}`);
  }
  try {
    const result = await fn();
    recordSuccess(name);
    return result;
  } catch (err) {
    recordFailure(name);
    throw err;
  }
}
