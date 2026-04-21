import { describe, expect, it } from "vitest";
import { productPlanFromWorkspacePlan } from "../src/productPlan.js";

describe("productPlanFromWorkspacePlan", () => {
  it("maps DB plan strings to indie | studio | team", () => {
    expect(productPlanFromWorkspacePlan("team")).toBe("team");
    expect(productPlanFromWorkspacePlan("free")).toBe("indie");
    expect(productPlanFromWorkspacePlan("pro")).toBe("studio");
    expect(productPlanFromWorkspacePlan("")).toBe("studio");
    expect(productPlanFromWorkspacePlan(undefined)).toBe("studio");
  });
});
