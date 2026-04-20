import type { Tab } from "./consoleRoutes";

/** Semantic groups for the palette UI (Recent is derived from ids, not stored on commands). */
export type PaletteCommandGroup = "action" | "navigation";

export type PaletteCommand = {
  id: string;
  group: PaletteCommandGroup;
  label: string;
  description?: string;
  /** Extra tokens for fuzzy matching (not shown). */
  keywords?: string[];
  shortcut?: string;
  locked?: boolean;
  tab?: Tab;
  execute: () => void;
};

export type PaletteSectionRow =
  | { kind: "section"; title: string }
  | { kind: "cmd"; cmd: PaletteCommand; flatIndex: number };

/** Plaintext from last successful key creation (session only). Cleared on sign-out. */
export const SESSION_LAST_API_KEY_PLAINTEXT = "mn_console_last_api_key_plaintext";

const RECENT_STORAGE_KEY = "mn_cmd_palette_recent_v2";
const MAX_RECENT = 5;
const MAX_FILTERED = 10;

export function loadRecentCommandIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function pushRecentCommandId(id: string): void {
  try {
    const prev = loadRecentCommandIds();
    const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Score for filtering; higher is better; -1 = no match. */
export function scorePaletteMatch(query: string, cmd: Pick<PaletteCommand, "label" | "description" | "keywords">): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const hay = `${cmd.label} ${cmd.description ?? ""} ${(cmd.keywords ?? []).join(" ")}`.toLowerCase();
  const labelLower = cmd.label.toLowerCase();
  if (labelLower === q) return 10_000;
  if (hay === q) return 9_000;
  if (labelLower.startsWith(q)) return 5_000;
  if (hay.startsWith(q)) return 4_000;
  if (labelLower.includes(q)) return 2_000;
  if (hay.includes(q)) return 1_500;
  let hi = 0;
  for (const ch of q) {
    const idx = hay.indexOf(ch, hi);
    if (idx === -1) return -1;
    hi = idx + 1;
  }
  return 800 - Math.min(hi, 200);
}

export function filterCommandsByQuery(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim();
  if (!q) return commands;
  const scored = commands
    .map((cmd) => ({ cmd, score: scorePaletteMatch(q, cmd) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label));
  return scored.slice(0, MAX_FILTERED).map((x) => x.cmd);
}

export function commandByIdMap(commands: PaletteCommand[]): Map<string, PaletteCommand> {
  return new Map(commands.map((c) => [c.id, c]));
}

export type BuildPaletteSectionRowsOptions = {
  /** Override recent ids (for tests); defaults to localStorage-backed list. */
  recentIds?: string[];
};

/**
 * Build listbox rows: sections + commands with stable flat index for keyboard selection.
 */
export function buildPaletteSectionRows(
  query: string,
  commands: PaletteCommand[],
  options?: BuildPaletteSectionRowsOptions,
): { rows: PaletteSectionRow[]; flat: PaletteCommand[] } {
  const q = query.trim();
  const flat: PaletteCommand[] = [];
  const rows: PaletteSectionRow[] = [];

  const pushSection = (title: string) => {
    rows.push({ kind: "section", title });
  };

  const pushCmd = (cmd: PaletteCommand) => {
    const flatIndex = flat.length;
    flat.push(cmd);
    rows.push({ kind: "cmd", cmd, flatIndex });
  };

  if (q) {
    const filtered = filterCommandsByQuery(commands, q);
    if (filtered.length === 0) {
      return { rows, flat };
    }
    let lastGroup: PaletteCommandGroup | null = null;
    for (const cmd of filtered) {
      if (cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        pushSection(lastGroup === "action" ? "Actions" : "Navigation");
      }
      pushCmd(cmd);
    }
    return { rows, flat };
  }

  const recentIds = options?.recentIds ?? loadRecentCommandIds();
  const byId = commandByIdMap(commands);
  const recentCmds = recentIds.map((id) => byId.get(id)).filter((c): c is PaletteCommand => Boolean(c));

  const actions = commands.filter((c) => c.group === "action");
  const nav = commands.filter((c) => c.group === "navigation");

  if (recentCmds.length > 0) {
    pushSection("Recent");
    for (const cmd of recentCmds) pushCmd(cmd);
  }

  pushSection("Actions");
  for (const cmd of actions) pushCmd(cmd);

  pushSection("Navigation");
  for (const cmd of nav) pushCmd(cmd);

  return { rows, flat };
}
