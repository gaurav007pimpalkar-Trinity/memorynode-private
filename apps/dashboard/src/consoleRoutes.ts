import { normalizePathname } from "./appSurface";
import { ROUTES } from "./config/routes";

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
export type BillingReturnNotice = {
  tone: "success" | "warning" | "error";
  message: string;
};

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
  overview: ROUTES.overview,
  continuity: ROUTES.continuity,
  assistant_memory: ROUTES.assistant,
  memories: ROUTES.lab,
  import: ROUTES.import,
  api_keys: ROUTES.apiKeys,
  mcp: ROUTES.mcp,
  connectors: ROUTES.connectors,
  usage: ROUTES.usage,
  workspaces: ROUTES.projects,
  billing: ROUTES.billing,
};

const PATH_TO_TAB = new Map<string, Tab>(
  [
    [ROUTES.overview, "overview"],
    [ROUTES.overviewAlias, "overview"],
    [ROUTES.continuity, "continuity"],
    [ROUTES.assistant, "assistant_memory"],
    [ROUTES.lab, "memories"],
    [ROUTES.memoriesAlias, "memories"],
    [ROUTES.import, "import"],
    [ROUTES.apiKeys, "api_keys"],
    [ROUTES.mcp, "mcp"],
    [ROUTES.connectors, "connectors"],
    [ROUTES.usage, "usage"],
    [ROUTES.projects, "workspaces"],
    [ROUTES.billing, "billing"],
    // Backward compatibility for older billing callback paths.
    [ROUTES.legacyBilling, "billing"],
  ].map(([path, tab]) => [path, tab] as [string, Tab]),
);

export function pathForTab(tab: Tab): string {
  return TAB_TO_PATH[tab];
}

export function tabFromPath(pathname: string): Tab | null {
  const p = normalizePathname(pathname);
  return PATH_TO_TAB.get(p) ?? null;
}

export function billingReturnNoticeFromSearch(search: string): BillingReturnNotice | null {
  const normalized = search.startsWith("?") ? search.slice(1) : search;
  const status = new URLSearchParams(normalized).get("status")?.trim().toLowerCase();
  if (!status) return null;

  if (status === "success") {
    return {
      tone: "success",
      message: "Payment successful. Your plan update is now being applied.",
    };
  }
  if (status === "canceled" || status === "cancelled" || status === "cancel") {
    return {
      tone: "warning",
      message: "Checkout was canceled. You can resume billing upgrade anytime.",
    };
  }
  if (status === "failed" || status === "error") {
    return {
      tone: "error",
      message: "Payment failed. Try again or contact support if this keeps happening.",
    };
  }
  return null;
}
