/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { emitAuditLog } from "../src/index.js";

describe("audit log insertion", () => {
  it("writes row with salted ip hash", async () => {
    const rows: any[] = [];
    const supabase = {
      from: () => ({
        insert: (data: any) => {
          rows.push(data);
          return { error: null };
        },
      }),
    };
    const req = new Request("http://localhost/v1/healthz", { headers: { "user-agent": "ua" } });
    const res = new Response("ok", { status: 200, headers: { "content-length": "2" } });
    await emitAuditLog(
      req,
      res,
      Date.now() - 5,
      "1.1.1.1",
      { AUDIT_IP_SALT: "s1" } as any,
      supabase as any,
      {
        workspaceId: "ws1",
        apiKeyId: "k1",
      },
      "req-1",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].workspace_id).toBe("ws1");
    expect(rows[0].api_key_id).toBe("k1");
    expect(rows[0].status).toBe(200);
    expect(rows[0].ip_hash).toBeDefined();
  });

  it("ip_hash changes with salt", async () => {
    const hashes: string[] = [];
    const supabase = {
      from: () => ({
        insert: (data: any) => {
          hashes.push(data.ip_hash);
          return { error: null };
        },
      }),
    };
    const req = new Request("http://localhost/v1/healthz");
    const res = new Response("ok", { status: 200 });
    await emitAuditLog(req, res, Date.now(), "1.1.1.1", { AUDIT_IP_SALT: "a" } as any, supabase as any, {}, "req-2");
    await emitAuditLog(req, res, Date.now(), "1.1.1.1", { AUDIT_IP_SALT: "b" } as any, supabase as any, {}, "req-3");
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("redacts secrets from console log and audit payload", async () => {
    const rows: any[] = [];
    const supabase = {
      from: () => ({
        insert: (data: any) => {
          rows.push(data);
          return { error: null };
        },
      }),
    };
    const req = new Request("http://localhost/v1/healthz", {
      headers: { authorization: "Bearer sk-abcdef123456" },
      method: "POST",
      body: "secret-body-text",
    });
    const res = new Response("ok", { status: 200 });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await emitAuditLog(req, res, Date.now(), "1.1.1.1", { AUDIT_IP_SALT: "s" } as any, supabase as any, {}, "req-4");

    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged.includes("sk-abcdef123456")).toBe(false);
    expect(rows.some((r) => JSON.stringify(r).includes("authorization"))).toBe(false);
    consoleSpy.mockRestore();
  });
});
