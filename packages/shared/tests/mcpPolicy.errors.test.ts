import { describe, expect, it } from "vitest";
import { policyDeniedError, type McpErrorCode } from "../src/mcpPolicy.js";

const codes: McpErrorCode[] = [
  "rate_limit_exceeded",
  "loop_detected",
  "loop_detected_drift",
  "cost_exceeded",
  "cost_exceeded_session",
  "weak_signal",
  "unauthorized_scope",
  "session_expired",
  "confirmation_required",
  "replay_detected",
];

describe("policyDeniedError schema", () => {
  it("uses single error envelope for all canonical codes", () => {
    const rows = codes.map((code) =>
      policyDeniedError({
        code,
        message: `${code} message`,
        actionId: "recall",
        scope: {
          workspaceId: "w1",
          keyId: "k1",
          userId: "u1",
          namespace: "n1",
          sessionId: "s1",
        },
      }),
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        error: {
          code: expect.any(String),
          message: expect.any(String),
          details: expect.any(Object),
        },
      });
      expect((row as { status?: string }).status).toBeUndefined();
    }
    expect(rows).toMatchSnapshot();
  });
});
