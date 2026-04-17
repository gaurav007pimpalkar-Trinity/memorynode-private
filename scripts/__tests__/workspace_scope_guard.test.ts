import { describe, expect, it } from "vitest";
import { scanWorkspaceScopeViolations } from "../lib/workspace_scope_guard.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function withTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, content, "utf8");
  return file;
}

describe("workspace_scope_guard", () => {
  it("flags unscoped SELECT on tenant table", () => {
    const file = withTempFile('await supabase.from("memories").select("*");');
    const violations = scanWorkspaceScopeViolations({ files: [file] });
    expect(violations.length).toBe(1);
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it("allows scoped SELECT with workspace_id filter", () => {
    const file = withTempFile('await supabase.from("memories").select("*").eq("workspace_id", auth.workspaceId);');
    const violations = scanWorkspaceScopeViolations({ files: [file] });
    expect(violations.length).toBe(0);
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it("allows INSERT when workspace_id field is present", () => {
    const file = withTempFile('await supabase.from("memory_chunks").insert({ workspace_id: auth.workspaceId, text: "x" });');
    const violations = scanWorkspaceScopeViolations({ files: [file] });
    expect(violations.length).toBe(0);
    rmSync(dirname(file), { recursive: true, force: true });
  });
});
