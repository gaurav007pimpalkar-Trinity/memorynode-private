/**
 * Circuit breaker for "openai" and "supabase".
 * When env.CIRCUIT_BREAKER_DO is set, state is shared across all Worker isolates via a Durable Object.
 * When not set (e.g. tests or dev), falls back to in-memory per-isolate state.
 */

import type { Env } from "./env.js";
import { logger } from "./logger.js";
import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_WINDOW_MS,
  CIRCUIT_BREAKER_OPEN_MS,
} from "./resilienceConstants.js";
import {
  circuitBreakerDOIsOpen,
  circuitBreakerDORecordSuccess,
  circuitBreakerDORecordFailure,
} from "./circuitBreakerDO.js";

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
  if (now - s.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
    s.failures = 0;
    s.windowStart = now;
  }
  return s;
}

export function isOpen(name: CircuitName): boolean {
  const s = getState(name);
  const now = Date.now();
  if (s.openUntil > now) return true;
  return false;
}

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

export function recordFailure(name: CircuitName): void {
  const s = getState(name);
  s.failures += 1;
  const now = Date.now();
  if (s.failures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    s.openUntil = now + CIRCUIT_BREAKER_OPEN_MS;
    logger.info({
      event: "circuit_breaker_open",
      circuit: name,
      failures: s.failures,
      open_until_ms: CIRCUIT_BREAKER_OPEN_MS,
    });
  }
}

/**
 * Run fn; if circuit is open, throw immediately. On success call recordSuccess; on failure call recordFailure.
 * When env.CIRCUIT_BREAKER_DO is provided, uses shared DO state so all isolates see the same open/closed state.
 */
export async function withCircuitBreaker<T>(
  name: CircuitName,
  fn: () => Promise<T>,
  env?: Env,
): Promise<T> {
  const useDO = env?.CIRCUIT_BREAKER_DO && typeof env.CIRCUIT_BREAKER_DO.get === "function";

  if (useDO && env.CIRCUIT_BREAKER_DO) {
    const doNamespace = env.CIRCUIT_BREAKER_DO;
    const open = await circuitBreakerDOIsOpen(doNamespace, name);
    if (open) throw new Error(`CIRCUIT_OPEN:${name}`);
    try {
      const result = await fn();
      await circuitBreakerDORecordSuccess(doNamespace, name);
      return result;
    } catch (err) {
      await circuitBreakerDORecordFailure(doNamespace, name);
      throw err;
    }
  }

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
