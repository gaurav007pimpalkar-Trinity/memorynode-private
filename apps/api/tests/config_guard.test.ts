import api from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("config guard", () => {
  it("fails fast when RATE_LIMIT_DO binding is missing", async () => {
    const req = new Request("http://localhost/healthz", { method: "GET" });
    const env = {
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      OPENAI_API_KEY: "",
      API_KEY_SALT: "",
      MASTER_ADMIN_TOKEN: "",
      // RATE_LIMIT_DO intentionally omitted
    } as unknown as Record<string, unknown>;

    const res = await api.fetch(req, env);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("CONFIG_ERROR");
    expect(String(json.error.message)).toContain("RATE_LIMIT_DO");
  });
});
