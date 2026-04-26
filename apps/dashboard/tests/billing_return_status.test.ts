import { describe, expect, it } from "vitest";
import { billingReturnNoticeFromSearch, tabFromPath } from "../src/consoleRoutes";

describe("billing callback routing + status notice", () => {
  it("maps legacy /settings/billing callback path to billing tab", () => {
    expect(tabFromPath("/settings/billing")).toBe("billing");
  });

  it("returns success notice for status=success", () => {
    expect(billingReturnNoticeFromSearch("?status=success")).toEqual({
      tone: "success",
      message: "Payment successful. Your plan update is now being applied.",
    });
  });

  it("returns warning notice for canceled statuses", () => {
    expect(billingReturnNoticeFromSearch("?status=canceled")).toEqual({
      tone: "warning",
      message: "Checkout was canceled. You can resume billing upgrade anytime.",
    });
    expect(billingReturnNoticeFromSearch("?status=cancelled")).toEqual({
      tone: "warning",
      message: "Checkout was canceled. You can resume billing upgrade anytime.",
    });
  });

  it("returns error notice for failed statuses", () => {
    expect(billingReturnNoticeFromSearch("?status=failed")).toEqual({
      tone: "error",
      message: "Payment failed. Try again or contact support if this keeps happening.",
    });
  });

  it("ignores unknown or missing statuses", () => {
    expect(billingReturnNoticeFromSearch("?status=processing")).toBeNull();
    expect(billingReturnNoticeFromSearch("")).toBeNull();
  });
});
