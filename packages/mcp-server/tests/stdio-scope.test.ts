import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStdioScope } from "../src/stdioScope.js";

describe("resolveStdioScope", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env = { ...prev };
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("uses MEMORYNODE_USER_ID and default namespace from MEMORYNODE_CONTAINER_TAG", () => {
    process.env.MEMORYNODE_USER_ID = "alice";
    process.env.MEMORYNODE_CONTAINER_TAG = "proj-a";
    delete process.env.MEMORYNODE_SCOPED_CONTAINER_TAG;
    expect(resolveStdioScope(null)).toEqual({ user_id: "alice", namespace: "proj-a" });
  });

  it("lets containerTag override namespace when no scoped pin", () => {
    process.env.MEMORYNODE_USER_ID = "default";
    process.env.MEMORYNODE_CONTAINER_TAG = "proj-a";
    delete process.env.MEMORYNODE_SCOPED_CONTAINER_TAG;
    expect(resolveStdioScope("proj-b")).toEqual({ user_id: "default", namespace: "proj-b" });
  });

  it("pins namespace when MEMORYNODE_SCOPED_CONTAINER_TAG is set (hosted-style)", () => {
    process.env.MEMORYNODE_USER_ID = "u1";
    process.env.MEMORYNODE_CONTAINER_TAG = "ignored-when-pinned";
    process.env.MEMORYNODE_SCOPED_CONTAINER_TAG = "pinned-ns";
    expect(resolveStdioScope("other")).toEqual({ user_id: "u1", namespace: "pinned-ns" });
  });
});
