import { describe, expect, it } from "vitest";
import { resolveIsolation } from "../src/isolation/isolation.js";

describe("resolveIsolation", () => {
  it("derives stable container tags for same logical input", () => {
    const rest = resolveIsolation({ userId: "user_123", scope: "support" });
    const mcp = resolveIsolation({ user_id: "user_123", namespace: "support" });
    const retry = resolveIsolation({ userId: "user_123", scope: "support" });

    expect(rest.containerTag).toBe(mcp.containerTag);
    expect(retry.containerTag).toBe(rest.containerTag);
    expect(rest.routingMode).toBe("derived");
  });

  it("uses shared bucket when user id is missing", () => {
    const resolved = resolveIsolation({});
    expect(resolved.routingMode).toBe("shared_default");
    expect(resolved.ownerId).toBe("shared_app");
  });

  it("enforces scoped key over explicit or derived routing", () => {
    const resolved = resolveIsolation(
      {
        userId: "user_123",
        scope: "support",
        containerTag: "explicit-tag",
      },
      { scopedContainerTag: "locked-tag" },
    );
    expect(resolved.containerTag).toBe("locked-tag");
    expect(resolved.routingMode).toBe("scoped_key");
    expect(resolved.scopeOverridden).toBe(true);
  });
});

