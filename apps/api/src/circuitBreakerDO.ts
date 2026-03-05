/**
 * Durable Object for shared circuit breaker state across all Worker isolates.
 * A single DO instance (idFromName("circuit-breaker")) holds state for "openai" and "supabase"
 * so that when one isolate opens the circuit, all isolates see it open.
 */

import { logger } from "./logger.js";
import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_WINDOW_MS,
  CIRCUIT_BREAKER_OPEN_MS,
} from "./resilienceConstants.js";

export type CircuitName = "openai" | "supabase";

type CircuitState = {
  failures: number;
  windowStart: number;
  openUntil: number;
};

const DEFAULT_STATE: CircuitState = {
  failures: 0,
  windowStart: 0,
  openUntil: 0,
};

export class CircuitBreakerDO {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private storageKey(name: CircuitName): string {
    return `cb:${name}`;
  }

  private async getCircuitState(name: CircuitName): Promise<CircuitState> {
    const raw = await this.state.storage.get<CircuitState>(this.storageKey(name));
    const now = Date.now();
    if (!raw) return { ...DEFAULT_STATE, windowStart: now };
    const s = raw as CircuitState;
    if (now - s.windowStart > CIRCUIT_BREAKER_WINDOW_MS) {
      return { failures: 0, windowStart: now, openUntil: 0 };
    }
    return s;
  }

  private async putCircuitState(name: CircuitName, s: CircuitState): Promise<void> {
    await this.state.storage.put(this.storageKey(name), s);
  }

  async fetch(request: Request): Promise<Response> {
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (typeof this.state.blockConcurrencyWhile === "function") {
        return this.state.blockConcurrencyWhile(fn);
      }
      return fn();
    };

    let body: { action?: string; name?: CircuitName } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
    }

    const action = body.action;
    const name = body.name;
    if (name !== "openai" && name !== "supabase") {
      return new Response(JSON.stringify({ error: "invalid_circuit_name" }), { status: 400 });
    }

    if (action === "isOpen") {
      return withLock(async () => {
        const s = await this.getCircuitState(name);
        const open = s.openUntil > Date.now();
        return new Response(JSON.stringify({ open }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    }

    if (action === "recordSuccess") {
      return withLock(async () => {
        const now = Date.now();
        await this.putCircuitState(name, { failures: 0, windowStart: now, openUntil: 0 });
        logger.info({ event: "circuit_breaker_closed", circuit: name });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    }

    if (action === "recordFailure") {
      return withLock(async () => {
        const s = await this.getCircuitState(name);
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
        await this.putCircuitState(name, s);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    }

    return new Response(JSON.stringify({ error: "invalid_action" }), { status: 400 });
  }
}

const CIRCUIT_BREAKER_DO_NAME = "circuit-breaker";

/** Get the singleton DO id for the circuit breaker (shared across all isolates). */
export function getCircuitBreakerDoId(doNamespace: DurableObjectNamespace): DurableObjectId {
  return (doNamespace as { idFromName(name: string): DurableObjectId }).idFromName(CIRCUIT_BREAKER_DO_NAME);
}

export async function circuitBreakerDOIsOpen(
  doNamespace: DurableObjectNamespace,
  name: CircuitName,
): Promise<boolean> {
  const id = getCircuitBreakerDoId(doNamespace);
  const stub = doNamespace.get(id);
  const res = await stub.fetch("https://internal/cb", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "isOpen", name }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { open?: boolean };
  return data.open === true;
}

export async function circuitBreakerDORecordSuccess(
  doNamespace: DurableObjectNamespace,
  name: CircuitName,
): Promise<void> {
  const id = getCircuitBreakerDoId(doNamespace);
  const stub = doNamespace.get(id);
  await stub.fetch("https://internal/cb", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "recordSuccess", name }),
  });
}

export async function circuitBreakerDORecordFailure(
  doNamespace: DurableObjectNamespace,
  name: CircuitName,
): Promise<void> {
  const id = getCircuitBreakerDoId(doNamespace);
  const stub = doNamespace.get(id);
  await stub.fetch("https://internal/cb", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "recordFailure", name }),
  });
}
