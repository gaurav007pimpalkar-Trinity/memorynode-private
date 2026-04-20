import { describe, expect, it, vi } from "vitest";
import {
  buildPaletteSectionRows,
  commandByIdMap,
  filterCommandsByQuery,
  loadRecentCommandIds,
  pushRecentCommandId,
  scorePaletteMatch,
} from "../src/consoleCommandPalette";
import type { PaletteCommand } from "../src/consoleCommandPalette";

function makeCmd(overrides: Partial<PaletteCommand> & Pick<PaletteCommand, "id" | "label" | "group">): PaletteCommand {
  return {
    description: undefined,
    keywords: undefined,
    locked: false,
    execute: () => {},
    ...overrides,
  };
}

describe("consoleCommandPalette", () => {
  it("scorePaletteMatch prioritizes exact label", () => {
    const a = makeCmd({ id: "1", group: "action", label: "Open Memory Lab" });
    const q = "open memory lab";
    expect(scorePaletteMatch(q, a)).toBeGreaterThan(scorePaletteMatch("mem", a));
  });

  it("filterCommandsByQuery caps at 10 and sorts", () => {
    const many: PaletteCommand[] = Array.from({ length: 20 }, (_, i) =>
      makeCmd({
        id: `n-${i}`,
        group: "navigation",
        label: `Page ${i}`,
        execute: () => {},
      }),
    );
    const out = filterCommandsByQuery(many, "page");
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it("buildPaletteSectionRows lists Recent then Actions then Navigation when query empty", () => {
    const cmds: PaletteCommand[] = [
      makeCmd({ id: "action-memory-lab", group: "action", label: "Open Memory Lab", execute: () => {} }),
      makeCmd({ id: "nav-overview", group: "navigation", label: "Home", execute: () => {} }),
    ];
    const { rows } = buildPaletteSectionRows("", cmds, { recentIds: ["action-memory-lab"] });
    expect(rows[0]).toMatchObject({ kind: "section", title: "Recent" });
    expect(rows.some((r) => r.kind === "section" && r.title === "Actions")).toBe(true);
    expect(rows.some((r) => r.kind === "section" && r.title === "Navigation")).toBe(true);
  });

  it("pushRecentCommandId dedupes and caps", () => {
    const mem: Record<string, string> = {};
    const ls = {
      getItem: (k: string) => (k in mem ? mem[k] : null),
      setItem: (k: string, v: string) => {
        mem[k] = v;
      },
      removeItem: (k: string) => {
        delete mem[k];
      },
      clear: () => {
        for (const k of Object.keys(mem)) delete mem[k];
      },
      get length() {
        return Object.keys(mem).length;
      },
      key: (i: number) => Object.keys(mem)[i] ?? null,
    } as Storage;
    vi.stubGlobal("localStorage", ls);
    try {
      pushRecentCommandId("a");
      pushRecentCommandId("b");
      pushRecentCommandId("a");
      expect(loadRecentCommandIds()).toEqual(["a", "b"]);
      for (let i = 0; i < 10; i++) pushRecentCommandId(`x${i}`);
      expect(loadRecentCommandIds().length).toBeLessThanOrEqual(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("commandByIdMap resolves recent entries", () => {
    const a = makeCmd({ id: "action-memory-lab", group: "action", label: "Lab", execute: () => {} });
    const m = commandByIdMap([a]);
    expect(m.get("action-memory-lab")?.label).toBe("Lab");
  });
});
