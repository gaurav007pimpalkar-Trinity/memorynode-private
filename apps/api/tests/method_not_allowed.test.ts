import { describe, expect, it } from "vitest";
import api from "../src/index.js";
import { makeRateLimitDoStub } from "./helpers/rate_limit_do.js";

const rateDo = makeRateLimitDoStub();
const baseEnv = {
  RATE_LIMIT_DO: rateDo,
  SUPABASE_URL: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  OPENAI_API_KEY: "",
  API_KEY_SALT: "s",
  MASTER_ADMIN_TOKEN: "",
  SUPABASE_MODE: "stub", // so unknown path can reach 404 without CONFIG_ERROR
} as const;

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

describe("405 Method Not Allowed (known paths)", () => {
  it("POST /healthz returns 405 with Allow: GET", async () => {
    const res = await api.fetch(
      new Request("http://localhost/healthz", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    const json = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(json.error?.code).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.get("x-request-id")).toEqual(expect.any(String));
  });

  it("GET /v1/search returns 405 with Allow: POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/search", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("POST /v1/search/history returns 405 with Allow: GET", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/search/history", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("GET /v1/search/replay returns 405 with Allow: POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/search/replay", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("PATCH /v1/evals/sets returns 405 with Allow: GET, POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/evals/sets", { method: "PATCH" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("POST /v1/evals/sets/<uuid> returns 405 with Allow: DELETE", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/evals/sets/00000000-0000-4000-8000-000000000001", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("DELETE");
  });

  it("GET /v1/context/feedback returns 405 with Allow: POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/context/feedback", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("PATCH /v1/memories returns 405 with Allow: GET, POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", { method: "PATCH" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, POST");
  });

  it("POST /v1/memories/<uuid> returns 405 with Allow: GET, DELETE", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/memories/00000000-0000-0000-0000-000000000001", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, DELETE");
  });

  it("GET /v1/billing/checkout returns 405 with Allow: POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/billing/checkout", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("POST /v1/pruning/metrics returns 405 with Allow: GET", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/pruning/metrics", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("POST /v1/audit/log returns 405 with Allow: GET", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/audit/log", { method: "POST" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("GET /v1/explain/answer returns 405 with Allow: POST", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/explain/answer", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("unknown path returns 404 not 405", async () => {
    const res = await api.fetch(
      new Request("http://localhost/v1/unknown", { method: "GET" }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Allow")).toBeNull();
    const json = (await res.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("NOT_FOUND");
  });
});
