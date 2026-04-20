import { normalizePathname } from "./appSurface";

/** Console pages synced with the URL (react-router). */
export type Tab =
  | "overview"
  | "continuity"
  | "assistant_memory"
  | "memories"
  | "usage"
  | "import"
  | "api_keys"
  | "mcp"
  | "connectors"
  | "workspaces"
  | "billing";

/** Tabs that need a connected project before they load real data. */
export const tabsRequiringWorkspace: Tab[] = [
  "continuity",
  "assistant_memory",
  "memories",
  "usage",
  "import",
  "api_keys",
  "mcp",
  "connectors",
  "workspaces",
  "billing",
];

export type SidebarNavEntry = { tab: Tab; label: string; showLock?: boolean };

export type SidebarGroup = { section: string; entries: SidebarNavEntry[] };

/**
 * Primary workflow: Memory Lab (`/lab`). Continuity & Assistant stay as routes only (Home playbooks).
 * Future nested lab routes (e.g. `/lab/context`) can be added behind the same `memories` tab + child paths — not wired yet.
 */
export const UNIFIED_SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    section: "Home",
    entries: [{ tab: "overview", label: "Home" }],
  },
  {
    section: "Memory",
    entries: [{ tab: "memories", label: "Memory Lab" }],
  },
  {
    section: "Integrations",
    entries: [
      { tab: "mcp", label: "MCP" },
      { tab: "connectors", label: "Connectors" },
    ],
  },
  {
    section: "Import",
    entries: [{ tab: "import", label: "Import" }],
  },
  {
    section: "Account",
    entries: [
      { tab: "api_keys", label: "API Keys" },
      { tab: "usage", label: "Usage" },
      { tab: "billing", label: "Billing" },
      { tab: "workspaces", label: "Projects" },
    ],
  },
];

const TAB_TO_PATH: Record<Tab, string> = {
  overview: "/",
  continuity: "/continuity",
  assistant_memory: "/assistant",
  memories: "/lab",
  import: "/import",
  api_keys: "/api-keys",
  mcp: "/mcp",
  connectors: "/connectors",
  usage: "/usage",
  workspaces: "/projects",
  billing: "/billing",
};

const PATH_TO_TAB = new Map<string, Tab>(
  [
    ["/", "overview"],
    ["/overview", "overview"],
    ["/continuity", "continuity"],
    ["/assistant", "assistant_memory"],
    ["/lab", "memories"],
    ["/memories", "memories"],
    ["/import", "import"],
    ["/api-keys", "api_keys"],
    ["/mcp", "mcp"],
    ["/connectors", "connectors"],
    ["/usage", "usage"],
    ["/projects", "workspaces"],
    ["/billing", "billing"],
  ].map(([path, tab]) => [path, tab] as [string, Tab]),
);

export function pathForTab(tab: Tab): string {
  return TAB_TO_PATH[tab];
}

export function tabFromPath(pathname: string): Tab | null {
  const p = normalizePathname(pathname);
  return PATH_TO_TAB.get(p) ?? null;
}
