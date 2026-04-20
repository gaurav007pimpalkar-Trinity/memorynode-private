import { describe, expect, it } from "vitest";
import { IngestPayloadSchema } from "../src/contracts/index.js";
import { MemoryWebhookIngestSchema } from "../src/contracts/index.js";

describe("IngestPayloadSchema", () => {
  it("accepts memory kind", () => {
    const r = IngestPayloadSchema.safeParse({
      kind: "memory",
      body: { userId: "u1", text: "hello world" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts bundle kind", () => {
    const r = IngestPayloadSchema.safeParse({
      kind: "bundle",
      body: { artifact_base64: "e30=" },
    });
    expect(r.success).toBe(true);
  });
});

describe("MemoryWebhookIngestSchema", () => {
  it("requires workspace_id with memory fields", () => {
    const r = MemoryWebhookIngestSchema.safeParse({
      workspace_id: "00000000-0000-4000-8000-000000000001",
      userId: "u1",
      text: "x",
    });
    expect(r.success).toBe(true);
  });
});
