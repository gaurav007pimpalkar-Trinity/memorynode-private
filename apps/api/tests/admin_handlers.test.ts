/**
 * Admin endpoints: require admin token, session cleanup, billing health, webhook reprocess validation.
 * Control-plane ingress requires `x-internal-secret` === `CONTROL_PLANE_SECRET` on all gated paths.
 */

import { describe, expect, it } from "vitest";
import controlPlane from "../src/controlPlaneWorker.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();
type FetchEnv = Parameters<(typeof controlPlane)["fetch"]>[1];

const CP_SECRET = "control-plane-test-secret-32chars!!";

const baseEnv: Record<string, unknown> = {
  RATE_LIMIT_DO: rateDo,
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "s",
  MASTER_ADMIN_TOKEN: "admin-token-123",
  ENVIRONMENT: "dev",
  CONTROL_PLANE_SECRET: CP_SECRET,
  /** Tests issue many control-plane admin calls in one file; keep above default cp-admin gate. */
  RATE_LIMIT_CONTROL_PLANE_ADMIN_MAX: "500",
};

function withInternalSecret(init: RequestInit & { url: string }): Request {
  const { url, ...rest } = init;
  const headers = new Headers(rest.headers ?? undefined);
  headers.set("x-internal-secret", CP_SECRET);
  return new Request(url, { ...rest, headers });
}

describe("Control-plane: x-internal-secret gate", () => {
  it("returns 401 when secret header is missing on GET /v1/admin", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      new Request("http://localhost/v1/admin/founder/phase1?range=7d", {
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe("UNAUTHORIZED");
    expect(String(json.error?.message)).toMatch(/Missing x-internal-secret/i);
  });

  it("returns 403 when secret header does not match on GET /v1/admin", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      new Request("http://localhost/v1/admin/founder/phase1?range=7d", {
        headers: {
          "x-internal-secret": "wrong-secret-value-not-matching!!",
          "x-admin-token": "admin-token-123",
        },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error?.code).toBe("PERMISSION_DENIED");
  });

  it("returns 503 when CONTROL_PLANE_SECRET is unset on a gated path", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub", CONTROL_PLANE_SECRET: "" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/admin/sessions/cleanup",
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error?.code).toBe("CONFIG_ERROR");
  });
});

describe("Admin: require admin token", () => {
  it("GET /v1/admin/founder/phase1 returns 401 without x-admin-token", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/v1/admin/founder/phase1?range=7d",
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe("UNAUTHORIZED");
  });

  it("GET /v1/admin/founder/phase1 returns metrics with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/v1/admin/founder/phase1?range=7d",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.range).toBe("7d");
    expect(json).toHaveProperty("current");
    expect(json.current).toHaveProperty("api_uptime_pct");
    expect(json.current).toHaveProperty("http_5xx_rate_pct");
    expect(json.current).toHaveProperty("search_latency_p95_ms");
    expect(json.current).toHaveProperty("zero_result_rate_pct");
    expect(json.current).toHaveProperty("active_workspaces");
    expect(json.current).toHaveProperty("activation_rate_pct");
    expect(json.current).toHaveProperty("retention_7d_pct");
  });

  it("GET /v1/admin/billing/health returns 401 without x-admin-token", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({ url: "http://localhost/v1/admin/billing/health" }),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error?.code).toBe("UNAUTHORIZED");
  });

  it("GET /v1/admin/billing/health returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/v1/admin/billing/health",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("now");
    expect(json).toHaveProperty("db_connectivity");
    expect(json.db_connectivity).toHaveProperty("ok", true);
  });

  it("POST /admin/sessions/cleanup returns 401 without x-admin-token", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({ url: "http://localhost/admin/sessions/cleanup", method: "POST" }),
      env as FetchEnv,
    );
    expect(res.status).toBe(401);
  });

  it("POST /admin/sessions/cleanup returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/admin/sessions/cleanup",
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.deleted).toBe("number");
  });

  it("POST /admin/usage/reconcile returns 200 with valid x-admin-token (stub)", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/admin/usage/reconcile?limit=5",
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.scanned).toBe("number");
    expect(Array.isArray(json.results)).toBe(true);
  });

  it("POST /admin/webhooks/reprocess returns 400 when status is invalid", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const res = await controlPlane.fetch(
      withInternalSecret({
        url: "http://localhost/admin/webhooks/reprocess?status=invalid",
        method: "POST",
        headers: { "x-admin-token": "admin-token-123" },
      }),
      env as FetchEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error?.code).toBe("BAD_REQUEST");
    expect(String(json.error?.message)).toMatch(/status must be one of: deferred, failed, received, all_retryable/);
  });

  it("POST /admin/sessions/cleanup returns idempotent_replay on duplicate Idempotency-Key", async () => {
    const env = { ...baseEnv, SUPABASE_MODE: "stub" };
    const headers = new Headers({
      "x-internal-secret": CP_SECRET,
      "x-admin-token": "admin-token-123",
      "Idempotency-Key": "idem-cleanup-dedup-test-key-99",
    });
    const r1 = await controlPlane.fetch(
      new Request("http://localhost/admin/sessions/cleanup", { method: "POST", headers }),
      env as FetchEnv,
    );
    expect(r1.status).toBe(200);
    const r2 = await controlPlane.fetch(
      new Request("http://localhost/admin/sessions/cleanup", { method: "POST", headers }),
      env as FetchEnv,
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { idempotent_replay?: boolean };
    expect(j2.idempotent_replay).toBe(true);
  });
});
