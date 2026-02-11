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
} as const;

type FetchEnv = Parameters<(typeof api)["fetch"]>[1];

describe("per-route body size limits", () => {
  it("blocks oversized search payloads with 413", async () => {
    const big = "x".repeat(250_001); // > SEARCH_MAX_BODY_BYTES (200 KB)
    const res = await api.fetch(
      new Request("http://localhost/v1/search", { method: "POST", body: big }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("x-request-id")).toEqual(expect.any(String));
    const json = (await res.json()) as { request_id?: string; error: { code: string } };
    expect(json.error.code).toBe("payload_too_large");
    expect(json.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("blocks oversized memory ingest payloads with 413", async () => {
    const big = "y".repeat(1_100_000); // > MEMORIES_MAX_BODY_BYTES (1 MB)
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", { method: "POST", body: big }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("payload_too_large");
  });

  it("blocks oversized multipart ingest payloads with 413", async () => {
    const form = new FormData();
    form.set("blob", "z".repeat(1_100_000));
    const res = await api.fetch(
      new Request("http://localhost/v1/memories", { method: "POST", body: form }),
      baseEnv as unknown as FetchEnv,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("x-request-id")).toEqual(expect.any(String));
    const json = (await res.json()) as { request_id?: string; error: { code: string } };
    expect(json.error.code).toBe("payload_too_large");
    expect(json.request_id).toBe(res.headers.get("x-request-id"));
  });
});
