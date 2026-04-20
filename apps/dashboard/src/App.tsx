import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { ApiKeyRow, ConnectorSettingRow, InviteRow, MemoryRow, UsageRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import { apiDelete, apiEnvError, apiGet, apiPatch, apiPost, ensureDashboardSession, dashboardLogout, setOnUnauthorized, userFacingErrorMessage } from "./apiClient";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "./memorySearch";
import { DeveloperNextSteps } from "./DeveloperNextSteps";
import { DashboardBuildFooter } from "./DashboardBuildFooter";

type Tab =
  | "overview"
  | "continuity"
  | "assistant_home"
  | "assistant_connections"
  | "assistant_memory"
  | "assistant_settings"
  | "memories"
  | "usage"
  | "import"
  | "api_keys"
  | "mcp"
  | "connectors"
  | "workspaces"
  | "billing";

const tabsRequiringWorkspace: Tab[] = [
  "continuity",
  "assistant_home",
  "assistant_connections",
  "assistant_memory",
  "assistant_settings",
  "memories",
  "usage",
  "import",
  "api_keys",
  "connectors",
  "workspaces",
  "billing",
];

type SidebarNavEntry = { tab: Tab; label: string; showLock?: boolean };

type SidebarGroup = { section: string; entries: SidebarNavEntry[] };

type ConsoleSurface = "developer" | "saas" | "assistant";

const SURFACE_PREF_KEY = "mn_console_surface";

const DEVELOPER_SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    section: "Build",
    entries: [
      { tab: "overview", label: "Overview" },
      { tab: "memories", label: "Memory Browser" },
      { tab: "import", label: "Import" },
      { tab: "api_keys", label: "API Keys" },
      { tab: "mcp", label: "MCP Setup" },
      { tab: "connectors", label: "Connectors" },
      { tab: "usage", label: "Usage" },
    ],
  },
  {
    section: "Account",
    entries: [{ tab: "workspaces", label: "Projects" }],
  },
];

const SAAS_SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    section: "Operate",
    entries: [
      { tab: "overview", label: "Overview" },
      { tab: "continuity", label: "Continuity" },
      { tab: "usage", label: "Usage" },
      { tab: "workspaces", label: "Projects" },
      { tab: "billing", label: "Billing" },
    ],
  },
];

const ASSISTANT_SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    section: "Assistant Workspace",
    entries: [{ tab: "assistant_memory", label: "Assistant" }],
  },
];

function loadSurfacePreference(): ConsoleSurface {
  if (typeof window === "undefined") return "developer";
  const raw = window.localStorage.getItem(SURFACE_PREF_KEY);
  if (raw === "assistant") return "assistant";
  return raw === "saas" ? "saas" : "developer";
}

function persistSurfacePreference(surface: ConsoleSurface): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SURFACE_PREF_KEY, surface);
}

const SIDEBAR_GROUPS_BY_SURFACE: Record<ConsoleSurface, SidebarGroup[]> = {
  developer: DEVELOPER_SIDEBAR_GROUPS,
  saas: SAAS_SIDEBAR_GROUPS,
  assistant: ASSISTANT_SIDEBAR_GROUPS,
};

function defaultTabForSurface(surface: ConsoleSurface): Tab {
  const groups = SIDEBAR_GROUPS_BY_SURFACE[surface];
  return groups[0]?.entries[0]?.tab ?? "overview";
}

function nextAvailableTab(current: Tab, surface: ConsoleSurface): Tab {
  const groups = SIDEBAR_GROUPS_BY_SURFACE[surface];
  const allTabs = groups.flatMap((group) => group.entries.map((entry) => entry.tab));
  return allTabs.includes(current) ? current : defaultTabForSurface(surface);
}

const SURFACE_DESCRIPTIONS: Record<ConsoleSurface, string> = {
  developer: "API setup, memory debugging, and integration controls.",
  saas: "Run the user-memory continuity demo and verify returning users are remembered.",
  assistant: "No-code assistant flow to connect tools, remember context, and recall it later.",
};

const SIDEBAR_SURFACE_TITLES: Record<ConsoleSurface, string> = {
  developer: "Developer Console",
  saas: "SaaS Memory Console",
  assistant: "Assistant Workspace",
};

const SIDEBAR_SURFACE_SHORT: Record<ConsoleSurface, string> = {
  developer: "Developer",
  saas: "SaaS",
  assistant: "Assistant",
};

function seatCapForPlan(planCode: string | null | undefined): number {
  const normalized = (planCode ?? "launch").toLowerCase();
  if (normalized === "launch" || normalized === "build" || normalized === "pro" || normalized === "solo") {
    return 1;
  }
  if (normalized === "deploy" || normalized === "scale" || normalized === "team") {
    return 10;
  }
  // Legacy enterprise-like plans are tolerated for existing workspaces.
  if (normalized === "scale_plus") {
    return 25;
  }
  return 10;
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function userInitials(session: Session): string {
  const meta = session.user.user_metadata as Record<string, unknown> | undefined;
  const name = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  const email = session.user.email?.trim() ?? "";
  const source = name || email || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase().slice(0, 2);
  }
  return source.slice(0, 2).toUpperCase() || "??";
}

function workspaceSwitcherLabel(session: Session, effectiveWorkspaceId: string, userEmail: string): string {
  const meta = session.user.user_metadata as Record<string, unknown> | undefined;
  const name = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  if (name) return name;
  const local = userEmail.includes("@") ? userEmail.split("@")[0] : userEmail;
  return local || "Account";
}

function shortWorkspaceId(id: string): string {
  const t = id.trim();
  if (!t) return "";
  if (t.length <= 12) return t;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

function devLog(payload: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  const url = (import.meta.env.VITE_DEV_LOG_INGEST_URL ?? "").trim();
  if (!url) return;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

function LockIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M7 11V8a5 5 0 0 1 10 0v3" />
    </svg>
  );
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onBack?: () => void;
  fallbackTitle?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error): void {
    console.error("ErrorBoundary caught:", error);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleBack = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onBack?.();
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <Shell>
          <Panel title={this.props.fallbackTitle ?? "Something went wrong"}>
            <p className="muted small">An unexpected error occurred. You can retry or go back.</p>
            <div className="row">
              <button onClick={this.handleRetry}>Retry</button>
              <button className="ghost" onClick={this.handleBack}>
                Back
              </button>
            </div>
          </Panel>
        </Shell>
      );
    }
    return this.props.children;
  }
}

export function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [workspaceId, setWorkspaceId] = useState(() => loadWorkspaceId());
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [firstApiKeyCreated, setFirstApiKeyCreated] = useState(false);
  const [celebrationShown, setCelebrationShown] = useState(false);
  const [celebrationMessage, setCelebrationMessage] = useState<string | null>(null);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [onboardingCollapsed, setOnboardingCollapsed] = useState(false);
  const [planBadge, setPlanBadge] = useState("LAUNCH");
  const consoleSearchRef = useRef<HTMLInputElement>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [surface, setSurface] = useState<ConsoleSurface>(() => loadSurfacePreference());
  const workspaceBootstrapAttemptedRef = useRef(false);

  const missingEnv = useMemo(() => {
    const errs: string[] = [];
    if (supabaseEnvError) errs.push(supabaseEnvError);
    if (apiEnvError) errs.push(apiEnvError);
    return errs;
  }, []);

  useEffect(() => {
    let mounted = true;
    if (supabaseEnvError) {
      setLoadingSession(false);
      setSession(null);
      return;
    }
    supabase.auth
      .getSession()
      .then(({ data }: { data: { session: Session | null } }) => {
        if (!mounted) return;
        setSession(data.session ?? null);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingSession(false);
      });
    const { data: sub } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, s: Session | null) => setSession(s));
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const userEmail = session?.user.email ?? "Unknown";

  const workspaceClaim = useMemo(() => {
    const claims = session?.user.user_metadata as Record<string, unknown> | undefined;
    const root = (session?.user as unknown as { workspace_id?: string })?.workspace_id;
    return (root as string) ?? (claims?.workspace_id as string) ?? "";
  }, [session]);
  const effectiveWorkspaceId = workspaceClaim || workspaceId;
  const workspaceReady = Boolean(effectiveWorkspaceId?.trim());

  // Non-negotiable invariants for safety:
  // 1) Workspace-gated tabs stay locked unless a workspace context exists.
  // 2) Dashboard session bootstrap always requires access token + workspace ID.
  // 3) Unauthorized responses clear local workspace context before retry.

  useEffect(() => {
    workspaceBootstrapAttemptedRef.current = false;
  }, [session?.user.id]);

  useEffect(() => {
    if (!session || workspaceReady || workspaceBootstrapAttemptedRef.current) return;
    workspaceBootstrapAttemptedRef.current = true;
    let cancelled = false;
    const bootstrapWorkspace = async () => {
      try {
        const { data: memberships, error: listError } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .order("created_at", { ascending: false })
          .limit(1);
        if (listError) throw listError;

        const existingWorkspaceId = (memberships?.[0] as { workspace_id?: string } | undefined)?.workspace_id?.trim() ?? "";
        if (existingWorkspaceId) {
          if (cancelled) return;
          setWorkspaceId(existingWorkspaceId);
          persistWorkspaceId(existingWorkspaceId);
          setAlert("We selected your latest project so you can continue.");
          return;
        }

        const { data: created, error: createError } = await supabase.rpc("create_workspace", { p_name: "My Project" });
        if (createError) throw createError;
        const createdWorkspaceId = (created?.[0] as { workspace_id?: string } | undefined)?.workspace_id?.trim() ?? "";
        if (!createdWorkspaceId || cancelled) return;
        setWorkspaceId(createdWorkspaceId);
        persistWorkspaceId(createdWorkspaceId);
        setAlert("Your first project is ready. You're good to go.");
      } catch {
        if (!cancelled) {
          setAlert("We couldn't finish setup automatically. You can complete it below.");
        }
      }
    };
    void bootstrapWorkspace();
    return () => {
      cancelled = true;
    };
  }, [session, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady) {
      setPlanBadge("FREE");
      return;
    }
    if (!sessionReady) return;
    let cancelled = false;
    void apiGet<{ effective_plan?: string; plan?: string }>("/v1/billing/status")
      .then((res) => {
        if (cancelled) return;
        const p = (res.effective_plan ?? res.plan ?? "launch").toString();
        setPlanBadge(p ? p.toUpperCase() : "FREE");
      })
      .catch(() => {
        if (!cancelled) setPlanBadge("FREE");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceReady, sessionReady, effectiveWorkspaceId]);

  useEffect(() => {
    if (!workspaceReady) setOnboardingCollapsed(false);
  }, [workspaceReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        consoleSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!session?.access_token || !effectiveWorkspaceId?.trim()) {
      setSessionReady(false);
      return;
    }
    let cancelled = false;
    setSessionError(null);
    devLog({
      sessionId: "aa3f1d",
      runId: "pre-fix",
      hypothesisId: "H4",
      location: "apps/dashboard/src/App.tsx:ensureDashboardSession",
      message: "ensureDashboardSession start",
      data: { hasAccessToken: Boolean(session?.access_token), workspaceIdLength: effectiveWorkspaceId.trim().length },
      timestamp: Date.now(),
    });
    ensureDashboardSession(session.access_token, effectiveWorkspaceId)
      .then(() => {
        devLog({
          sessionId: "aa3f1d",
          runId: "pre-fix",
          hypothesisId: "H4",
          location: "apps/dashboard/src/App.tsx:ensureDashboardSession",
          message: "ensureDashboardSession success",
          data: { workspaceIdLength: effectiveWorkspaceId.trim().length },
          timestamp: Date.now(),
        });
        if (!cancelled) setSessionReady(true);
      })
      .catch((err: unknown) => {
        devLog({
          sessionId: "aa3f1d",
          runId: "pre-fix",
          hypothesisId: "H4",
          location: "apps/dashboard/src/App.tsx:ensureDashboardSession",
          message: "ensureDashboardSession failed",
          data: { errorMessage: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        });
        if (!cancelled) {
          setSessionReady(false);
          setSessionError(userFacingErrorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, effectiveWorkspaceId]);

  useEffect(() => {
    setOnUnauthorized(() => {
      workspaceBootstrapAttemptedRef.current = false;
      setSessionReady(false);
      setSessionError("Session expired or access denied. Please sign in again or select project.");
      persistWorkspaceId("");
      setWorkspaceId("");
    });
    return () => setOnUnauthorized(null);
  }, []);

  const saveWorkspaceId = async () => {
    if (!workspaceId) return;
    setWorkspaceSaving(true);
    setAlert(null);
    const { error } = await supabase.auth.updateUser({ data: { workspace_id: workspaceId } });
    if (error) {
      setAlert(error.message);
    } else {
      persistWorkspaceId(workspaceId);
      await supabase.auth.refreshSession();
      setAlert("Workspace connected. All sections are now ready.");
    }
    setWorkspaceSaving(false);
  };

  useEffect(() => {
    persistSurfacePreference(surface);
    setTab((prev) => nextAvailableTab(prev, surface));
  }, [surface]);

  const sidebarGroups = useMemo(() => SIDEBAR_GROUPS_BY_SURFACE[surface], [surface]);
  const sidebarCommands = useMemo(
    () =>
      sidebarGroups.flatMap((g) =>
        g.entries.map((e) => ({ tab: e.tab, label: e.label, section: g.section })),
      ),
    [sidebarGroups],
  );

  const onboardingSteps = useMemo(
    () =>
      surface === "developer"
        ? [
            { key: "workspace", label: "Choose your project", done: workspaceReady },
            { key: "workspace-bind", label: "Connect this browser", done: Boolean(workspaceClaim?.trim() || workspaceId.trim()) },
            { key: "api-key", label: "Create your first API key", done: firstApiKeyCreated },
            { key: "team", label: "Invite collaborators (optional)", done: false },
          ]
        : surface === "assistant"
          ? [
              { key: "workspace", label: "Choose your project", done: workspaceReady },
              { key: "workspace-bind", label: "Connect this browser", done: Boolean(workspaceClaim?.trim() || workspaceId.trim()) },
              { key: "remember", label: "Remember something for a user", done: workspaceReady },
              { key: "recall", label: "Ask what the assistant knows", done: workspaceReady },
            ]
        : [
            { key: "workspace", label: "Choose your project", done: workspaceReady },
            { key: "workspace-bind", label: "Connect this browser", done: Boolean(workspaceClaim?.trim() || workspaceId.trim()) },
            { key: "usage", label: "Verify usage metrics", done: workspaceReady && sessionReady },
            { key: "billing", label: "Confirm plan and billing", done: planBadge !== "FREE" },
          ],
    [surface, workspaceReady, workspaceClaim, workspaceId, firstApiKeyCreated, sessionReady, planBadge],
  );
  const completedSteps = onboardingSteps.filter((step) => step.done).length;

  const selectTab = useCallback(
    (t: Tab) => {
      if (!workspaceReady && tabsRequiringWorkspace.includes(t)) return;
      setTab(t);
      setNavDrawerOpen(false);
    },
    [workspaceReady],
  );

  const paletteMatches = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return sidebarCommands;
    return sidebarCommands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q) ||
        `${c.section} ${c.label}`.toLowerCase().includes(q),
    );
  }, [paletteQuery, sidebarCommands]);

  useEffect(() => {
    setPaletteIndex((i) => {
      if (paletteMatches.length === 0) return 0;
      return Math.min(i, paletteMatches.length - 1);
    });
  }, [paletteMatches.length, paletteQuery]);

  const runPaletteSelect = useCallback(
    (t: Tab) => {
      if (!workspaceReady && tabsRequiringWorkspace.includes(t)) return;
      selectTab(t);
      setPaletteQuery("");
      setPaletteOpen(false);
      consoleSearchRef.current?.blur();
    },
    [workspaceReady, selectTab],
  );

  useEffect(() => {
    if (celebrationShown) return;
    if (firstApiKeyCreated && workspaceReady) {
      setCelebrationShown(true);
      setCelebrationMessage("Great job - your project is live. Your first API key is ready.");
    }
  }, [firstApiKeyCreated, workspaceReady, celebrationShown]);

  if (missingEnv.length > 0) {
    return (
      <Shell>
        <Panel title="Configuration error">
          <div className="badge">The dashboard is missing required environment variables.</div>
          <ul className="muted small">
            {missingEnv.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className="muted small">Set them in your Vite env (.env.local): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_BASE_URL.</div>
        </Panel>
      </Shell>
    );
  }

  if (loadingSession) return <Shell><Panel title="Loading">Checking session…</Panel></Shell>;

  if (!session) {
    return <AuthLanding />;
  }

  if (effectiveWorkspaceId && !sessionReady && !sessionError) {
    return (
      <Shell>
        <Panel title="Loading">Establishing session…</Panel>
      </Shell>
    );
  }
  if (effectiveWorkspaceId && sessionError) {
    return (
      <Shell>
        <Panel title="Session error">
          <div className="badge">{sessionError}</div>
          <div className="row">
            <button onClick={() => { setSessionError(null); setSessionReady(false); }}>
              Retry
            </button>
            <button className="ghost" onClick={() => supabase.auth.signOut()}>
              Sign out
            </button>
          </div>
        </Panel>
      </Shell>
    );
  }

  const switcherTitle = workspaceSwitcherLabel(session, effectiveWorkspaceId, userEmail);

  return (
    <div className={`console-root${navDrawerOpen ? " console-root--nav-drawer-open" : ""}`}>
      <aside className="console-sidebar" id="console-sidebar" aria-label="Console navigation">
        <div className="console-brand">
          <span className="console-brand-mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 2l2.2 6.8H21l-5.5 4 2.1 6.5L12 16.8 6.4 19.3l2.1-6.5L3 8.8h6.8L12 2z"
                fill="currentColor"
                opacity="0.9"
              />
            </svg>
          </span>
          <span className="console-brand-text">MemoryNode</span>
        </div>
        <div className="panel card">
          <div className="muted small">{SIDEBAR_SURFACE_TITLES[surface]}</div>
          <div className="row mt-sm">
            <button
              type="button"
              className={surface === "developer" ? "" : "ghost"}
              onClick={() => setSurface("developer")}
            >
              Developer
            </button>
            <button
              type="button"
              className={surface === "saas" ? "" : "ghost"}
              onClick={() => setSurface("saas")}
            >
              SaaS
            </button>
            <button
              type="button"
              className={surface === "assistant" ? "" : "ghost"}
              onClick={() => setSurface("assistant")}
            >
              Assistant
            </button>
          </div>
          <div className="muted small mt-sm">{SURFACE_DESCRIPTIONS[surface]}</div>
        </div>
        <div className={`console-search-wrap${paletteOpen ? " console-search-wrap--open" : ""}`}>
          <input
            ref={consoleSearchRef}
            type="search"
            className="console-search-input"
            placeholder="Jump to…"
            aria-label="Jump to page"
            aria-expanded={paletteOpen}
            aria-controls="console-command-list"
            autoComplete="off"
            value={paletteQuery}
            onChange={(e) => {
              setPaletteQuery(e.target.value);
              setPaletteOpen(true);
            }}
            onFocus={() => setPaletteOpen(true)}
            onBlur={() => {
              window.setTimeout(() => setPaletteOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPaletteIndex((i) => Math.min(Math.max(0, paletteMatches.length - 1), i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setPaletteIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                const pick = paletteMatches[paletteIndex];
                if (pick) {
                  e.preventDefault();
                  runPaletteSelect(pick.tab);
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                setPaletteOpen(false);
                setPaletteQuery("");
                consoleSearchRef.current?.blur();
              }
            }}
          />
          <kbd className="console-search-kbd">⌘K</kbd>
          {paletteOpen && (
            <div
              id="console-command-list"
              className="console-search-results"
              role="listbox"
              aria-label="Console pages"
              onMouseDown={(ev) => ev.preventDefault()}
            >
              {paletteMatches.length === 0 ? (
                <div className="console-search-empty muted small">No matching pages</div>
              ) : (
                paletteMatches.map((c, i) => {
                  const locked = !workspaceReady && tabsRequiringWorkspace.includes(c.tab);
                  return (
                    <button
                      key={`${c.section}-${c.tab}`}
                      type="button"
                      role="option"
                      aria-selected={i === paletteIndex}
                      className={
                        i === paletteIndex ? "console-search-item console-search-item--active" : "console-search-item"
                      }
                      disabled={locked}
                      title={locked ? "Finish project setup to open this page." : c.label}
                      onMouseEnter={() => setPaletteIndex(i)}
                      onClick={() => runPaletteSelect(c.tab)}
                    >
                      <span className="console-search-item-label">{c.label}</span>
                      <span className="console-search-item-section muted small">{c.section}</span>
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        <nav className="console-sidebar-nav">
          {sidebarGroups.map((g) => (
            <div key={g.section} className="console-nav-section">
              <div className="console-nav-section-label">{g.section}</div>
              <div className="console-nav-section-items">
                {g.entries.map((entry) => {
                  const locked = !workspaceReady && tabsRequiringWorkspace.includes(entry.tab);
                  return (
                    <button
                      key={entry.tab}
                      type="button"
                      className={tab === entry.tab ? "console-nav-item console-nav-item--active" : "console-nav-item"}
                      disabled={locked}
                      title={locked ? "Finish project setup to open this section." : entry.label}
                      onClick={() => selectTab(entry.tab)}
                    >
                      <span className="console-nav-item-label">{entry.label}</span>
                      {entry.showLock ? <LockIcon className="console-nav-lock" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <button
        type="button"
        className="console-sidebar-backdrop"
        aria-label="Close navigation"
        tabIndex={-1}
        onClick={() => setNavDrawerOpen(false)}
      />

      <div className="console-main-column">
        <header className="console-header">
          <button
            type="button"
            className="console-menu-toggle"
            aria-label="Open navigation"
            aria-expanded={navDrawerOpen}
            aria-controls="console-sidebar"
            onClick={() => setNavDrawerOpen((open) => !open)}
          >
            <span className="console-menu-bar" />
            <span className="console-menu-bar" />
            <span className="console-menu-bar" />
          </button>
          <div className="console-header-primary">
            <div className="console-header-workspace">
              <span className="console-header-name">{switcherTitle}</span>
              <span className="console-plan-badge">{planBadge}</span>
            </div>
            <div className="console-header-sub muted small">
              <strong>{SIDEBAR_SURFACE_SHORT[surface]} surface.</strong>{" "}
              {workspaceReady ? "Project connected." : "Finish setup below to unlock all sections."}
            </div>
          </div>
          <div className="console-header-actions">
            <a
              href="https://docs.memorynode.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="console-header-link"
            >
              Docs <span className="console-external" aria-hidden>↗</span>
            </a>
            <a
              href="https://support.memorynode.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="console-header-link"
            >
              Help
            </a>
            <button
              type="button"
              className="ghost console-header-signout"
              onClick={async () => {
                await dashboardLogout();
                await supabase.auth.signOut();
              }}
            >
              Sign out
            </button>
            <div className="console-avatar" title={userEmail}>
              {userInitials(session)}
            </div>
          </div>
        </header>

        <div className="console-scroll">
          {celebrationMessage && (
            <div className="celebration-toast console-celebration" role="status" aria-live="polite">
              <strong>Milestone unlocked</strong>
              <span>{celebrationMessage}</span>
              <button type="button" className="ghost" onClick={() => setCelebrationMessage(null)}>
                Dismiss
              </button>
            </div>
          )}

          {(!workspaceReady || !onboardingCollapsed) && (
            <section className="console-onboarding panel">
              <div className="panel-head row-space">
                <span>Get started</span>
                <span className="badge">
                  {completedSteps}/{onboardingSteps.length} complete
                </span>
              </div>
              <div className="panel-body">
                <div className="muted small">We keep setup short so you can start quickly.</div>
                <label className="field">
                  <span>Project ID (optional)</span>
                  <input
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder="Paste an existing project ID"
                  />
                </label>
                <div className="row">
                  <button type="button" onClick={saveWorkspaceId} disabled={!workspaceId || workspaceSaving}>
                    {workspaceSaving ? "Connecting…" : "Connect project"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setWorkspaceId(loadWorkspaceId())}>
                    Use last saved project
                  </button>
                </div>
                {alert && <div className="badge">{alert}</div>}
                <div className="muted small">Current project: {workspaceClaim || workspaceId || "Not selected yet"}</div>
                {workspaceReady && (
                  <details className="console-advanced-details">
                    <summary className="muted small">Advanced details</summary>
                    <div className="muted small mt-sm">Project ID: {effectiveWorkspaceId}</div>
                  </details>
                )}
                {workspaceReady && (
                  <button type="button" className="ghost console-onboarding-collapse" onClick={() => setOnboardingCollapsed(true)}>
                    Hide setup
                  </button>
                )}
              </div>
            </section>
          )}

          {workspaceReady && onboardingCollapsed && (
            <button type="button" className="console-onboarding-collapsed ghost" onClick={() => setOnboardingCollapsed(false)}>
              Setup complete · {shortWorkspaceId(effectiveWorkspaceId)} — Show setup
            </button>
          )}

          <ErrorBoundary onBack={() => setTab("overview")}>
            <div className="console-content grid">
              {tab === "overview" && (
                <OverviewView
                  workspaceReady={workspaceReady}
                  sessionReady={sessionReady}
                  hasApiKey={firstApiKeyCreated}
                  surface={surface}
                  onQuickSetup={() => {
                    setOnboardingCollapsed(false);
                    selectTab(surface === "developer" ? "api_keys" : surface === "saas" ? "workspaces" : "assistant_memory");
                  }}
                />
              )}
              {tab === "continuity" && <SaasContinuityView workspaceId={effectiveWorkspaceId} />}
              {tab === "assistant_memory" && <AssistantMemoryView />}
              {tab === "memories" && <MemoryBrowserView userId={session.user.id} workspaceId={effectiveWorkspaceId} onSearchCompleted={() => {}} />}
              {tab === "usage" && <RequestsView workspaceId={effectiveWorkspaceId} />}
              {tab === "import" && <ImportView isPaid={planBadge !== "FREE"} />}
              {tab === "api_keys" && (
                <ApiKeysView
                  workspaceId={workspaceClaim || workspaceId}
                  onApiKeyCreated={() => {
                    if (!firstApiKeyCreated) setFirstApiKeyCreated(true);
                  }}
                />
              )}
              {tab === "mcp" && <McpView />}
              {tab === "connectors" && <ConnectorSettingsView />}
              {tab === "workspaces" && (
                <WorkspacesView
                  workspaceId={workspaceClaim || workspaceId}
                  sessionUserId={session.user.id}
                  onSelectWorkspace={(id) => {
                    setWorkspaceId(id);
                    persistWorkspaceId(id);
                    setAlert("Project selected. Click Connect project to finish.");
                  }}
                />
              )}
              {tab === "billing" && <BillingConsoleView workspaceId={effectiveWorkspaceId} />}
            </div>
          </ErrorBoundary>
        </div>
        <DashboardBuildFooter placement="console" />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="shell">{children}</div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">{title}</div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function AuthLanding() {
  return (
    <div className="auth-layout">
      <section className="auth-stage">
        <div className="auth-showcase">
          <div className="auth-card">
            <div className="auth-chip">MemoryNode</div>
            <h1>Memory for customer-facing AI</h1>
            <p className="muted">
              Sign in to manage projects, API keys, and billing — so your support bots, chat apps, and copilots remember users without running vector search yourself.
            </p>
            <AuthPanel />
            <p className="auth-terms muted small">
              By continuing, you agree to our{" "}
              <a href="https://memorynode.ai/terms" target="_blank" rel="noopener noreferrer">
                Terms
              </a>{" "}
              and{" "}
              <a href="https://memorynode.ai/privacy" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p className="muted small">{subtitle}</p>
    </div>
  );
}

function OverviewChevron(): JSX.Element {
  return (
    <span className="explore-tile-chevron" aria-hidden>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 17L17 7M17 7H9M17 7V15" />
      </svg>
    </span>
  );
}

type OverviewStatsResponse = {
  range: string;
  documents: number;
  memories: number;
  search_requests: number;
  container_tags: number;
};

function OverviewView({
  workspaceReady,
  sessionReady,
  hasApiKey,
  surface,
  onQuickSetup,
}: {
  workspaceReady: boolean;
  sessionReady: boolean;
  hasApiKey: boolean;
  surface: ConsoleSurface;
  onQuickSetup: () => void;
}): JSX.Element {
  const [range, setRange] = useState<"1d" | "7d" | "30d" | "all">("all");
  const [stats, setStats] = useState<OverviewStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceReady || !sessionReady) {
      setStats(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiGet<OverviewStatsResponse>(`/v1/dashboard/overview-stats?range=${encodeURIComponent(range)}`)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(userFacingErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceReady, sessionReady, range]);

  const fmt = (n: number) => n.toLocaleString("en-US");
  const dash = "—";
  const cards = [
    {
      label: "Memories",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.documents ?? 0),
    },
    {
      label: "Indexed Chunks",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.memories ?? 0),
    },
    {
      label: "Read Operations",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.search_requests ?? 0),
    },
    {
      label: "Container Tags",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.container_tags ?? 0),
    },
  ];

  return (
    <div className="overview-page">
      <div className="overview-page-head">
        <h1 className="overview-page-title">Overview</h1>
        <div className="timeframe-toggle" role="group" aria-label="Time range">
          {(["1d", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "timeframe-btn timeframe-btn--active" : "timeframe-btn"}
              onClick={() => setRange(r)}
              disabled={!workspaceReady || !sessionReady}
              title={!workspaceReady ? "Set a workspace to load metrics." : undefined}
            >
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>
      <p className="overview-range-hint muted small">
        Counts for <strong>{range === "all" ? "all time" : range}</strong>
        {!workspaceReady || !sessionReady
          ? " — set a project to load live numbers."
          : " — numbers update for this selected time range."}
      </p>
      {error && (
        <div className="badge" role="alert">
          {error}
        </div>
      )}
      {surface === "developer" && workspaceReady && sessionReady ? <DeveloperNextSteps hasApiKey={hasApiKey} /> : null}
      {workspaceReady && sessionReady && stats && !loading && stats.memories === 0 && stats.search_requests === 0 ? (
        <div className="overview-empty-api-hint muted small" role="status">
          {surface === "developer" ? (
            <>
              No memory writes or reads in this range yet. Follow <strong>Next: ship memory</strong> above or open{" "}
              <a href="https://docs.memorynode.ai/quickstart" target="_blank" rel="noopener noreferrer">
                Quickstart
              </a>
              .
            </>
          ) : (
            <>
              No continuity activity in this range yet. Connect a project data source in <strong>Continuity</strong> and verify reads/writes from live traffic.
            </>
          )}
        </div>
      ) : null}
      <div className="overview-cards overview-cards--hero">
        {cards.map((card) => (
          <div key={card.label} className="metric-card">
            <div className="muted small">{card.label}</div>
            <div className="metric-value">{card.value}</div>
          </div>
        ))}
      </div>

      <h2 className="overview-explore-title">Start here</h2>
      <div className="explore-grid">
        <button type="button" className="explore-tile" onClick={onQuickSetup}>
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </span>
          <span className="explore-tile-title">Quick setup</span>
          <span className="explore-tile-desc muted small">Connect your workspace and unlock the console.</span>
        </button>
        <a
          className="explore-tile"
          href="https://docs.memorynode.ai/quickstart"
          target="_blank"
          rel="noopener noreferrer"
        >
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 5v14l11-7-11-7z" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="explore-tile-title">Quickstart</span>
          <span className="explore-tile-desc muted small">See MemoryNode in action with a copy-paste guide.</span>
        </a>
        <a
          className="explore-tile"
          href="https://docs.memorynode.ai/playground"
          target="_blank"
          rel="noopener noreferrer"
        >
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h6m12 0h-6M12 3a10 10 0 0 1 0 18" />
            </svg>
          </span>
          <span className="explore-tile-title">Playground</span>
          <span className="explore-tile-desc muted small">Test the API interactively.</span>
        </a>
        <a className="explore-tile" href="https://docs.memorynode.ai" target="_blank" rel="noopener noreferrer">
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M7 4h7l3 3v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
              <path d="M14 4v4h4M9 12h6M9 16h6" />
            </svg>
          </span>
          <span className="explore-tile-title">Documentation</span>
          <span className="explore-tile-desc muted small">Read the full API reference.</span>
        </a>
      </div>
    </div>
  );
}

function SaasContinuityView({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [userId, setUserId] = useState("user_123");
  const [memoryText, setMemoryText] = useState("User prefers dark mode");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [savedMemory, setSavedMemory] = useState<MemoryRow | null>(null);
  const [retrievedContext, setRetrievedContext] = useState<string>("");
  const [lastInteractionAt, setLastInteractionAt] = useState<string | null>(null);
  const [withoutMemoryResponse, setWithoutMemoryResponse] = useState(
    "Here are UI suggestions you can apply for this user.",
  );
  const [withMemoryResponse, setWithMemoryResponse] = useState("");

  const loadLastMemory = useCallback(async (targetUserId: string) => {
    const params = new URLSearchParams({
      user_id: targetUserId,
      namespace: "saas-demo",
      page: "1",
      page_size: "1",
    });
    const res = await apiGet<{ memories?: MemoryRow[] }>(`/v1/memories?${params.toString()}`);
    const latest = Array.isArray(res.memories) && res.memories.length > 0 ? res.memories[0] : null;
    setSavedMemory(latest);
  }, []);

  useEffect(() => {
    if (!workspaceId?.trim()) return;
    void loadLastMemory(userId.trim());
  }, [workspaceId, userId, loadLastMemory]);

  const runContinuityDemo = async () => {
    const normalizedUserId = userId.trim();
    const normalizedMemory = memoryText.trim();
    if (!normalizedUserId || !normalizedMemory) {
      setMessage("Enter both user_id and memory text.");
      return;
    }
    setBusy(true);
    setMessage(null);
    setRetrievedContext("");
    setLastInteractionAt(null);
    setWithMemoryResponse("");
    try {
      await apiPost<{ memory_id: string; stored: boolean }>("/v1/memories", {
        user_id: normalizedUserId,
        namespace: "saas-demo",
        text: normalizedMemory,
      });

      const context = await apiPost<{ context_text?: string }>("/v1/context", {
        user_id: normalizedUserId,
        namespace: "saas-demo",
        query: "What do we know about this user's preferences?",
      });
      const contextText = typeof context.context_text === "string" ? context.context_text : "";
      setRetrievedContext(contextText);
      setWithoutMemoryResponse("Here are UI suggestions you can apply for this user.");
      setWithMemoryResponse(
        contextText.trim().length > 0
          ? `Since this user context says "${normalizedMemory}", here are UI suggestions optimized for that preference.`
          : "No stored preference was found in context for this user.",
      );
      await loadLastMemory(normalizedUserId);
      const nowIso = new Date().toISOString();
      setLastInteractionAt(nowIso);
      setMessage("Continuity demo completed. Returning user context loaded.");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remembered = Boolean(savedMemory && retrievedContext.trim().length > 0);

  if (!workspaceId?.trim()) {
    return (
      <Panel title="Continuity">
        <div className="badge">Set your project first to run the continuity demo.</div>
      </Panel>
    );
  }

  return (
    <Panel title="Continuity">
      {message && <div className="badge">{message}</div>}
      <h3>Test User Memory Continuity</h3>
      <div className="muted small">Save memory for one user, simulate return, and confirm this user is remembered.</div>
      <label className="field">
        <span>User ID</span>
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_123" />
      </label>
      <label className="field">
        <span>Memory to store</span>
        <input value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="User prefers dark mode" />
      </label>
      <button disabled={busy || !userId.trim() || !memoryText.trim()} onClick={() => void runContinuityDemo()}>
        {busy ? "Running demo..." : "Run continuity demo"}
      </button>

      <div className="stack mt-lg">
        <h3>Per-user visibility</h3>
        <div className="card">
          <div className="muted small">Last memory for {userId.trim() || "user"}</div>
          <div>{savedMemory?.text ?? "No memory stored yet."}</div>
          <div className="muted small">
            Stored at: {savedMemory?.created_at ? new Date(savedMemory.created_at).toLocaleString() : "n/a"}
          </div>
        </div>
        <div className="card">
          <div className="muted small">Retrieved context (returning user simulation)</div>
          <div>{retrievedContext || "No context retrieved yet."}</div>
          <div className="muted small">
            Last interaction: {lastInteractionAt ? new Date(lastInteractionAt).toLocaleString() : "n/a"}
          </div>
        </div>
      </div>

      <div className="stack mt-lg">
        <h3>Before vs After Response</h3>
        <div className="card">
          <div className="muted small">Without memory</div>
          <div>{withoutMemoryResponse}</div>
        </div>
        <div className="card">
          <div className="muted small">With memory</div>
          <div>{withMemoryResponse || "Run the continuity demo to generate context-enhanced response."}</div>
          {withMemoryResponse ? (
            <div className="muted small mt-sm">Context improved using stored memory.</div>
          ) : null}
        </div>
      </div>

      <div className={remembered ? "badge" : "muted small"}>
        {remembered ? "This user was remembered." : "Run the demo to prove user memory continuity."}
      </div>
    </Panel>
  );
}

function AssistantMemoryView(): JSX.Element {
  const [userId, setUserId] = useState("user_123");
  const [rememberText, setRememberText] = useState("User likes concise answers.");
  const [recallQuery, setRecallQuery] = useState("How should I respond to this user?");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [contextText, setContextText] = useState("");
  const [lastInteractionAt, setLastInteractionAt] = useState<string | null>(null);
  const [memoryList, setMemoryList] = useState<MemoryRow[]>([]);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState("");

  const loadMemories = useCallback(async (targetUserId: string) => {
    const params = new URLSearchParams({
      user_id: targetUserId,
      namespace: "assistant-demo",
      page: "1",
      page_size: "5",
    });
    const res = await apiGet<{ memories?: MemoryRow[] }>(`/v1/memories?${params.toString()}`);
    const rows = Array.isArray(res.memories) ? res.memories : [];
    setMemoryList(rows);
  }, []);

  useEffect(() => {
    void loadMemories(userId.trim());
  }, [userId, loadMemories]);

  const remember = async () => {
    const targetUserId = userId.trim();
    const text = rememberText.trim();
    if (!targetUserId || !text) {
      setMessage("Enter userId and memory text first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiPost("/v1/memories", {
        userId: targetUserId,
        scope: "assistant-demo",
        text,
      });
      const retrieval = await apiPost<{ context_text?: string }>("/v1/context", {
        userId: targetUserId,
        scope: "assistant-demo",
        query: `What do we know about this user? ${text.slice(0, 120)}`,
      });
      setContextText(retrieval.context_text ?? "");
      await loadMemories(targetUserId);
      setLastInteractionAt(new Date().toISOString());
      setMessage("Memory saved and retrieved. Input -> stored -> recalled.");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const recall = async () => {
    const targetUserId = userId.trim();
    if (!targetUserId || !recallQuery.trim()) {
      setMessage("Enter userId and recall query first.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiPost<{ context_text?: string }>("/v1/context", {
        userId: targetUserId,
        scope: "assistant-demo",
        query: recallQuery.trim(),
      });
      setContextText(res.context_text ?? "");
      setLastInteractionAt(new Date().toISOString());
      await loadMemories(targetUserId);
      setMessage("Recall completed.");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteMemory = async (memoryId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await apiDelete(`/v1/memories/${encodeURIComponent(memoryId)}`);
      await loadMemories(userId.trim());
      setMessage("Memory deleted.");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (memory: MemoryRow) => {
    if (!editedText.trim()) {
      setMessage("Edited text cannot be empty.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiDelete(`/v1/memories/${encodeURIComponent(memory.id)}`);
      await apiPost("/v1/memories", {
        user_id: memory.user_id,
        namespace: memory.namespace,
        text: editedText.trim(),
      });
      await loadMemories(userId.trim());
      setEditingMemoryId(null);
      setEditedText("");
      setMessage("Memory updated.");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Memory Assistant">
      {message && <div className="badge">{message}</div>}
      <h3>Remember something</h3>
      <label className="field">
        <span>User ID</span>
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_123" />
      </label>
      <label className="field">
        <span>What should I remember?</span>
        <input value={rememberText} onChange={(e) => setRememberText(e.target.value)} placeholder="User likes concise answers." />
      </label>
      <button disabled={busy} onClick={() => void remember()}>
        {busy ? "Saving..." : "Remember something"}
      </button>

      <h3 className="mt-lg">Ask / Recall</h3>
      <label className="field mt-lg">
        <span>Ask something about this user</span>
        <input value={recallQuery} onChange={(e) => setRecallQuery(e.target.value)} placeholder="How should I respond to this user?" />
      </label>
      <button className="ghost" disabled={busy} onClick={() => void recall()}>
        {busy ? "Thinking..." : "What do you know about me?"}
      </button>

      <div className="card mt-lg">
        <div className="muted small">Assistant response</div>
        <div>{contextText || "Ask a question to see what the assistant remembers."}</div>
      </div>
      <div className="stack mt-lg">
        <h3>Recent memories</h3>
        {memoryList.length === 0 ? <div className="muted small">No memories for this user yet.</div> : null}
        {memoryList.map((memory) => (
          <div key={memory.id} className="card">
            {editingMemoryId === memory.id ? (
              <div className="stack">
                <textarea
                  rows={3}
                  aria-label="Edit memory text"
                  placeholder="Update remembered text"
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                />
                <div className="row">
                  <button disabled={busy} onClick={() => void saveEdit(memory)}>Save edit</button>
                  <button className="ghost" onClick={() => { setEditingMemoryId(null); setEditedText(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="row-space">
                <div>
                  <div>{memory.text}</div>
                  <div className="muted small">{new Date(memory.created_at).toLocaleString()}</div>
                  <div className="muted small">
                    Last interaction: {lastInteractionAt ? new Date(lastInteractionAt).toLocaleString() : "n/a"}
                  </div>
                </div>
                <details className="console-advanced-details">
                  <summary className="muted small">More options</summary>
                  <div className="row mt-sm">
                    <button
                      className="ghost"
                      onClick={() => {
                        setEditingMemoryId(memory.id);
                        setEditedText(memory.text);
                      }}
                    >
                      Update this
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void deleteMemory(memory.id)}>
                      Forget this
                    </button>
                  </div>
                </details>
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RequestsView({ workspaceId }: { workspaceId: string }) {
  return (
    <Panel title="Usage">
      {workspaceId ? (
        <UsageView workspaceId={workspaceId} embedded />
      ) : (
        <EmptyState title="No usage yet" subtitle="Usage events appear here once your app starts making API calls." />
      )}
    </Panel>
  );
}

function ImportView({ isPaid }: { isPaid: boolean }) {
  const [artifactBase64, setArtifactBase64] = useState("");
  const [mode, setMode] = useState<"upsert" | "skip_existing" | "error_on_conflict" | "replace_ids" | "replace_all">("upsert");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const runImport = async () => {
    if (!artifactBase64.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiPost<{ imported_memories: number; imported_chunks: number }>("/v1/import", {
        artifact_base64: artifactBase64.trim(),
        mode,
      });
      setMessage(`Imported ${res.imported_memories} memories and ${res.imported_chunks} chunks.`);
      setArtifactBase64("");
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Import Data">
      {!isPaid && (
        <div className="badge">
          Import is available on paid plans only. Upgrade in Billing to unlock it.
        </div>
      )}
      <div className="muted small">
        Import currently accepts a prepared base64 artifact payload and mode. File drop and URL import are not available in this console.
      </div>
      <label className="field">
        <span>Artifact (base64)</span>
        <textarea value={artifactBase64} onChange={(e) => setArtifactBase64(e.target.value)} rows={6} />
      </label>
      <label className="field">
        <span>Mode</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="upsert">upsert</option>
          <option value="skip_existing">skip_existing</option>
          <option value="error_on_conflict">error_on_conflict</option>
          <option value="replace_ids">replace_ids</option>
          <option value="replace_all">replace_all</option>
        </select>
      </label>
      <button disabled={!isPaid || !artifactBase64.trim() || busy} onClick={runImport}>
        {busy ? "Importing..." : "Run import"}
      </button>
      {message && <div className="badge">{message}</div>}
    </Panel>
  );
}

function ConnectorSettingsView() {
  const [rows, setRows] = useState<ConnectorSettingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiGet<{ settings: ConnectorSettingRow[] }>("/v1/connectors/settings");
      setRows(Array.isArray(res.settings) ? res.settings : []);
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ensureRow = (connectorId: string): ConnectorSettingRow => {
    const existing = rows.find((row) => row.connector_id === connectorId);
    if (existing) return existing;
    return {
      connector_id: connectorId,
      sync_enabled: true,
      capture_types: {
        pdf: true,
        docx: true,
        txt: true,
        md: true,
        html: true,
        csv: false,
        tsv: false,
        xlsx: false,
        pptx: false,
        eml: false,
        msg: false,
      },
      updated_at: new Date(0).toISOString(),
    };
  };

  const patch = async (connectorId: string, syncEnabled: boolean, captureTypes: Record<string, boolean>) => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await apiPatch<ConnectorSettingRow>("/v1/connectors/settings", {
        connector_id: connectorId,
        sync_enabled: syncEnabled,
        capture_types: captureTypes,
      });
      setRows((prev) => {
        const next = prev.filter((row) => row.connector_id !== connectorId);
        next.unshift(saved);
        return next;
      });
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const connectors = ["google_drive", "notion", "slack", "gmail", "onedrive"];
  const fileTypes = ["pdf", "docx", "txt", "md", "html", "csv", "tsv", "xlsx", "pptx", "eml", "msg"];

  return (
    <Panel title="Connector Capture Settings">
      <div className="muted small">Toggle sync per connector and choose which file types should be captured.</div>
      {message && <div className="badge">{message}</div>}
      {connectors.map((connectorId) => {
        const row = ensureRow(connectorId);
        return (
          <div key={connectorId} className="card">
            <div className="row">
              <strong>{connectorId}</strong>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void patch(connectorId, !row.sync_enabled, row.capture_types)}
              >
                {row.sync_enabled ? "Sync: ON" : "Sync: OFF"}
              </button>
            </div>
            <div className="grid-two">
              {fileTypes.map((typeKey) => (
                <label key={`${connectorId}:${typeKey}`} className="muted small row">
                  <input
                    type="checkbox"
                    checked={Boolean(row.capture_types?.[typeKey])}
                    onChange={(e) => {
                      const next = { ...(row.capture_types ?? {}), [typeKey]: e.target.checked };
                      void patch(connectorId, row.sync_enabled, next);
                    }}
                    disabled={busy || !row.sync_enabled}
                  />
                  <span>{typeKey.toUpperCase()}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <button className="ghost" onClick={() => void load()} disabled={busy}>
        {busy ? "Refreshing..." : "Refresh"}
      </button>
    </Panel>
  );
}

function McpView() {
  return (
    <Panel title="MCP Setup">
      <div className="muted small">Connect any MCP-compatible host to MemoryNode with the official MCP endpoint.</div>
      <code className="code-block">pnpm add @memorynodeai/mcp-server</code>
      <div className="muted small">Required env vars:</div>
      <code className="code-block">MEMORYNODE_API_KEY=mn_live_xxx{"\n"}MEMORYNODE_BASE_URL=https://api.memorynode.ai{"\n"}MEMORYNODE_CONTAINER_TAG=default</code>
      <div className="muted small">Supported clients: Claude Desktop, Cursor IDE, Windsurf, VS Code MCP extensions, Cline/Roo-Cline, and generic MCP clients.</div>
      <a className="ghost" href="https://docs.memorynode.ai/quickstart" target="_blank" rel="noopener noreferrer">
        Open quickstart
      </a>
    </Panel>
  );
}

function BillingConsoleView({ workspaceId }: { workspaceId: string }) {
  const [billTab, setBillTab] = useState<"plans" | "usage">("plans");
  return (
    <Panel title="Billing">
      <nav className="tabs">
        <button className={billTab === "plans" ? "tab active" : "tab"} onClick={() => setBillTab("plans")}>Plans</button>
        <button className={billTab === "usage" ? "tab active" : "tab"} onClick={() => setBillTab("usage")}>Usage</button>
      </nav>
      {billTab === "plans" && <PlansView workspaceId={workspaceId} />}
      {billTab === "usage" && <UsageView workspaceId={workspaceId} embedded />}
    </Panel>
  );
}

function PlansView({ workspaceId }: { workspaceId: string }) {
  const plans = [
    { id: "launch", label: "Solo Launch", price: "Rs 299 / 7 days", seats: "1 member" },
    { id: "build", label: "Solo Build", price: "Rs 499 / month", seats: "1 member" },
    { id: "deploy", label: "Team Deploy", price: "Rs 1999 / month", seats: "Up to 10 members" },
    { id: "scale", label: "Team Scale", price: "Rs 4999 / month", seats: "Up to 10 members" },
  ];
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const checkout = async (plan: string) => {
    if (!workspaceId) return;
    setLoadingPlan(plan);
    setMessage(null);
    try {
      const res = await apiPost<{ url: string; method?: string; fields?: Record<string, string> }>("/v1/billing/checkout", { plan });
      if ((res.method ?? "GET").toUpperCase() === "POST" && res.fields && Object.keys(res.fields).length > 0) {
        const target = window.open("", "_blank", "noopener");
        if (!target) {
          setMessage("Popup blocked by browser. Allow popups and try again.");
          return;
        }
        const html = `<!doctype html><html><body><form id="payu-form" method="POST" action="${res.url}">
${Object.entries(res.fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}" />`).join("\n")}
</form><script>document.getElementById("payu-form").submit();</script></body></html>`;
        target.document.write(html);
        target.document.close();
      } else {
        window.open(res.url, "_blank", "noopener");
      }
    } catch (err: unknown) {
      setMessage(userFacingErrorMessage(err));
    } finally {
      setLoadingPlan(null);
    }
  };

  return (
    <div className="list">
      {message && <div className="badge">{message}</div>}
      {!workspaceId && <div className="badge">Set your project first to checkout a plan.</div>}
      <div className="pricing-grid">
        {plans.map((plan) => (
          <div key={plan.id} className="card">
            <strong>{plan.label}</strong>
            <div>{plan.price}</div>
            <div className="muted small">{plan.seats}</div>
            <button disabled={!workspaceId || !!loadingPlan} onClick={() => checkout(plan.id)}>
              {loadingPlan === plan.id ? "Opening checkout..." : "Upgrade"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MagicLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 6.75A2.75 2.75 0 0 1 5.75 4h12.5A2.75 2.75 0 0 1 21 6.75v10.5A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75Zm2.06.13 6.29 4.7a1.1 1.1 0 0 0 1.3 0l6.29-4.7A1.24 1.24 0 0 0 18.25 6H5.75c-.26 0-.5.08-.69.22ZM19.5 8.55l-5.95 4.45a2.6 2.6 0 0 1-3.1 0L4.5 8.55v8.7c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25v-8.7Z"
      />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 533.5 544.3" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M533.5 278.4c0-17.4-1.6-34.1-4.7-50.2H272v95h147c-6.4 34.2-25.8 63.2-55 82.5v68h88.8c52-47.8 80.7-118.2 80.7-195.3Z"
      />
      <path
        fill="#34A853"
        d="M272 544.3c73.1 0 134.4-24.2 179.2-65.6l-88.8-68c-24.7 16.6-56.3 26.4-90.4 26.4-69.5 0-128.3-46.9-149.3-110l-70.8 54.4c44.6 88.7 136.5 148.8 220.1 148.8Z"
      />
      <path
        fill="#FBBC04"
        d="M122.7 327.1c-5.3-15.7-8.4-32.5-8.4-49.9 0-17.3 3-34.2 8.4-49.9l-70.8-54.4C34.5 206.3 24 240.2 24 277.2s10.5 70.9 27.9 104.3l70.8-54.4Z"
      />
      <path
        fill="#EA4335"
        d="M272 107.3c39.8 0 75.5 13.7 103.6 40.5l77.7-77.7C406.3 26.3 345 0 272 0 188.4 0 96.5 60.1 51.9 148.8l70.8 54.4c21-63.1 79.8-110 149.3-110Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 98 96" aria-hidden="true">
      <path
        fill="currentColor"
        d="M49 0C21.9 0 0 21.9 0 49c0 21.7 14.1 40.1 33.6 46.6 2.5.5 3.4-1.1 3.4-2.4 0-1.2 0-4.5-.1-8.8-13.7 3-16.6-6.6-16.6-6.6-2.2-5.7-5.5-7.2-5.5-7.2-4.5-3.1.3-3 .3-3 5 .3 7.6 5.1 7.6 5.1 4.4 7.6 11.6 5.4 14.4 4.1.5-3.2 1.7-5.4 3.1-6.7-10.9-1.2-22.4-5.4-22.4-24.3 0-5.4 1.9-9.8 5.1-13.2-.5-1.2-2.2-6.2.5-12.8 0 0 4.2-1.3 13.6 5a46.9 46.9 0 0 1 24.8 0c9.5-6.4 13.6-5 13.6-5 2.7 6.6 1 11.6.5 12.8 3.2 3.4 5.1 7.8 5.1 13.2 0 18.9-11.5 23-22.5 24.2 1.8 1.5 3.3 4.6 3.3 9.2 0 6.7-.1 12.1-.1 13.7 0 1.3.9 2.9 3.4 2.4C83.9 89.1 98 70.7 98 49 98 21.9 76.1 0 49 0Z"
      />
    </svg>
  );
}

function AuthPanel() {
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const sentResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sentResetTimer.current) {
        clearTimeout(sentResetTimer.current);
      }
    };
  }, []);

  const magic = async () => {
    if (sentResetTimer.current) {
      clearTimeout(sentResetTimer.current);
      sentResetTimer.current = null;
    }
    setBusy(true);
    setErrorMessage(null);
    setMagicSent(false);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setMagicSent(true);
    sentResetTimer.current = setTimeout(() => {
      setMagicSent(false);
      sentResetTimer.current = null;
    }, 3000);
  };

  const github = async () => {
    setBusy(true);
    setErrorMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      setErrorMessage(error.message);
    }
  };

  const google = async () => {
    setBusy(true);
    setErrorMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      setErrorMessage(error.message);
    }
  };

  return (
    <div className="auth-form">
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
      <button
        className={`auth-provider-btn auth-magic-btn${magicSent ? " sent" : ""}`}
        onClick={magic}
        disabled={!email || busy}
      >
        <span className="provider-icon" aria-hidden="true">
          <MagicLinkIcon />
        </span>
        {busy ? "Sending magic link..." : magicSent ? "Sent" : "Send magic link"}
      </button>
      <div className="auth-divider">OR</div>
      <button className="auth-provider-btn auth-google-btn" onClick={google} disabled={busy}>
        <span className="provider-icon" aria-hidden="true">
          <GoogleIcon />
        </span>
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
      <button className="auth-provider-btn auth-github-btn" onClick={github} disabled={busy}>
        <span className="provider-icon" aria-hidden="true">
          <GitHubIcon />
        </span>
        {busy ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {errorMessage && <div className="badge">{errorMessage}</div>}
    </div>
  );
}

function WorkspacesView({
  workspaceId,
  sessionUserId,
  onSelectWorkspace,
}: {
  workspaceId: string;
  sessionUserId: string;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  const [list, setList] = useState<{ id: string; name: string; role: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const hasWorkspaceSwitcher = list.length > 1;

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error } = await supabase
      .from("workspace_members")
      .select("workspace_id, role, workspaces(name)")
      .order("created_at", { ascending: false });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    const rows =
      data?.map((r) => ({
        id: r.workspace_id as string,
        name: (r as { workspaces?: { name?: string } }).workspaces?.name ?? "Unnamed",
        role: (r as { role?: string }).role ?? "member",
      })) ?? [];
    setList(rows);
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!newName.trim()) return;
    const { data, error } = await supabase.rpc("create_workspace", { p_name: newName.trim() });
    if (error) {
      setError(error.message);
      return;
    }
    setNewName("");
    if (data?.[0]?.workspace_id) {
      const createdWorkspaceId = data[0].workspace_id as string;
      setList([{ id: createdWorkspaceId, name: data[0].name as string, role: "owner" }, ...list]);
      onSelectWorkspace(createdWorkspaceId);
    } else {
      load();
    }
  };

  return (
    <Panel title="Projects">
      <p className="muted small">
        Create a project or pick one you already belong to.
      </p>
      <div className="row">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New project name" />
        <button onClick={create} disabled={!newName.trim()}>
          Create project
        </button>
      </div>
      {!hasWorkspaceSwitcher && list.length === 1 && (
        <div className="muted small">You have one project. Create another only if you need separate teams or environments.</div>
      )}
      {hasWorkspaceSwitcher && <div className="muted small">Switching appears because you now have multiple projects.</div>}
      {loading && <div>Loading…</div>}
      {error && <div className="badge">{error}</div>}
      <ul className="list">
        {list.map((w) => (
          <li key={w.id} className="card">
            <div className="row-space">
              <div>
                <strong>{w.name}</strong>
                <details className="console-advanced-details">
                  <summary className="muted small">Advanced details</summary>
                  <div className="muted small mt-sm">Project ID: {w.id}</div>
                </details>
              </div>
              <div className="row">
                <span className="badge">{w.role}</span>
                <button
                  className="ghost"
                  onClick={() => {
                    devLog({
                      sessionId: "aa3f1d",
                      runId: "pre-fix",
                      hypothesisId: "H1",
                      location: "apps/dashboard/src/App.tsx:workspace",
                      message: "set workspace clicked",
                      data: { selectedWorkspaceId: w.id, currentWorkspaceId: workspaceId },
                      timestamp: Date.now(),
                    });
                    onSelectWorkspace(w.id);
                  }}
                >
                  Use this project
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <RoutingPreviewCard />
      <MembersView workspaceId={workspaceId} currentUserId={sessionUserId} />
    </Panel>
  );
}

function RoutingPreviewCard(): JSX.Element {
  const [userId, setUserId] = useState("user_123");
  const [scope, setScope] = useState("default");
  const [preview, setPreview] = useState<{ routingMode: string; resolvedContainerTag: string; explanation: string }>({
    routingMode: "derived",
    resolvedContainerTag: "",
    explanation: "Using userId + scope -> internal isolation key.",
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const normalizedUserId = userId.trim();
      const normalizedScope = (scope.trim() || "default").toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 96) || "default";
      if (!normalizedUserId) {
        if (!cancelled) {
          setPreview({
            routingMode: "shared_default",
            resolvedContainerTag: "st:app|sid:shared_app|sc:shared",
            explanation: "No userId provided -> shared app bucket.",
          });
        }
        return;
      }

      const subjectId = (await sha256Hex(`user|${normalizedUserId}`)).slice(0, 26);
      const sid = (await sha256Hex(subjectId)).slice(0, 20);
      if (!cancelled) {
        setPreview({
          routingMode: "derived",
          resolvedContainerTag: `st:u|sid:${sid}|sc:${normalizedScope}`,
          explanation: "Using userId + scope -> internal isolation key.",
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [userId, scope]);

  return (
    <div className="card mt-lg">
      <strong>Memory Routing Preview</strong>
      <div className="muted small mt-sm">Preview how userId + scope map into an internal isolation key.</div>
      <div className="row mt-sm">
        <input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="user_123" aria-label="Routing preview userId" />
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="default" aria-label="Routing preview scope" />
      </div>
      <div className="muted small mt-sm">Mode: {preview.routingMode}</div>
      <div className="muted small">Scoped API keys override this derived route.</div>
      <code className="code-block">{preview.resolvedContainerTag}</code>
      <div className="muted small">{preview.explanation}</div>
    </div>
  );
}

function ApiKeysView({
  workspaceId,
  onApiKeyCreated,
}: {
  workspaceId: string;
  onApiKeyCreated: () => void;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await supabase.rpc("list_api_keys", { p_workspace_id: workspaceId });
      setKeys((data as ApiKeyRow[] | null) ?? []);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [workspaceId]);

  const createKey = async () => {
    if (!workspaceId || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { data, error } = await supabase.rpc("create_api_key", {
        p_name: newName.trim(),
        p_workspace_id: workspaceId,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? (data[0] as { api_key?: string }) : undefined;
      if (row?.api_key) {
        setPlaintextKey(row.api_key);
        onApiKeyCreated();
      }
      setNewName("");
      load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    const { error } = await supabase.rpc("revoke_api_key", { p_key_id: id });
    if (error) {
      setError(error.message);
      return;
    }
    load();
  };

  return (
    <Panel title="API Keys">
      {!workspaceId && <div className="muted small">Connect a project to load keys.</div>}
      <div className="muted small">Create an API key for your app. You can revoke keys anytime.</div>
      <div className="row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (for example, production-app)"
        />
        <button disabled={!workspaceId || !newName.trim() || creating} onClick={createKey}>
          {creating ? "Creating…" : "Create API key"}
        </button>
      </div>
      {loading && <div>Loading…</div>}
      {error && <div className="badge">{error}</div>}
      {!loading && keys.length === 0 && <div className="muted small">No keys yet.</div>}
      <ul className="list">
        {keys.map((k) => (
          <li key={k.id} className="card">
            <div className="row-space">
              <div>
                <strong>{k.name}</strong>
                <div className="muted small">Created {new Date(k.created_at).toLocaleString()}</div>
                {k.last_used_at && (
                  <div className="muted small">
                    Last used {new Date(k.last_used_at).toLocaleString()}
                    {k.last_used_ip ? ` from ${k.last_used_ip}` : ""}
                  </div>
                )}
                <details className="console-advanced-details mt-sm">
                  <summary className="muted small">Advanced details</summary>
                  <div className="muted small mt-sm">
                    Key preview: {k.key_prefix ?? "mn_live"}…{k.key_last4 ?? "****"}
                  </div>
                </details>
              </div>
              <div className="row">
                <span className="badge">{k.revoked_at ? "revoked" : "active"}</span>
                {!k.revoked_at && (
                  <button className="ghost" onClick={() => revoke(k.id)}>
                    Revoke
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {plaintextKey && (
        <div className="modal">
          <div className="modal-card">
            <h3>Save this key now</h3>
            <p className="muted small">For safety, we only show it once. Copy it to your secrets manager.</p>
            <code className="code-block">{plaintextKey}</code>
            <div className="row">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(plaintextKey);
                }}
              >
                Copy
              </button>
              <button className="ghost" onClick={() => setPlaintextKey(null)}>
                I saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

type RetrievalExplainPayload = {
  explain_requested: true;
  results: Array<{
    memory_id: string;
    chunk_id: string;
    chunk_index: number;
    score: number;
    _explain: unknown | null;
  }>;
};

function MemoryBrowserView({
  userId,
  workspaceId,
  onSearchCompleted,
}: {
  userId: string;
  workspaceId: string;
  onSearchCompleted: () => void;
}) {
  const [rows, setRows] = useState<MemorySearchRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [metadata, setMetadata] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [selected, setSelected] = useState<MemoryRow | null>(null);
  const [saveToHistory, setSaveToHistory] = useState(false);
  const [searchExplainEnabled, setSearchExplainEnabled] = useState(false);
  const [explainPayload, setExplainPayload] = useState<RetrievalExplainPayload | null>(null);
  const [historyRows, setHistoryRows] = useState<Array<{ id: string; query: string; created_at: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [replayLoadingId, setReplayLoadingId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<{
    query_id: string;
    previous: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
    current: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
  } | null>(null);
  const [evalSets, setEvalSets] = useState<Array<{ id: string; name: string; created_at: string }>>([]);
  const [selectedEvalSetId, setSelectedEvalSetId] = useState<string>("");
  const [newEvalSetName, setNewEvalSetName] = useState("");
  const [evalItems, setEvalItems] = useState<Array<{ id: string; query: string; expected_memory_ids: string[] }>>([]);
  const [newEvalQuery, setNewEvalQuery] = useState("");
  const [newEvalExpectedIds, setNewEvalExpectedIds] = useState("");
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalItemsLoading, setEvalItemsLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalRunLoading, setEvalRunLoading] = useState(false);
  const [evalRunResult, setEvalRunResult] = useState<{
    item_count: number;
    avg_precision_at_k: number;
    avg_recall: number;
    items: Array<{
      eval_item_id: string;
      query: string;
      precision_at_k: number;
      recall: number;
      matched_expected_memory_ids: string[];
    }>;
  } | null>(null);
  const [evalItemsPage, setEvalItemsPage] = useState(1);
  const [evalItemsPageSize] = useState(5);
  const [expectedIdsValidationError, setExpectedIdsValidationError] = useState<string | null>(null);
  const [feedbackTraceId, setFeedbackTraceId] = useState("");
  const [feedbackUsedIds, setFeedbackUsedIds] = useState("");
  const [feedbackUnusedIds, setFeedbackUnusedIds] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!workspaceId?.trim()) {
    return (
      <Panel title="Memory Browser">
        <div className="badge">Set your project first to search and open memories.</div>
        <div className="muted small">Tip: Choose a project in the Projects section, then click Use this project.</div>
      </Panel>
    );
  }

  const parseMetadata = (): Record<string, unknown> | undefined => {
    if (!metadata.trim()) return undefined;
    try {
      return JSON.parse(metadata);
    } catch {
      setError("Metadata filter must be valid JSON");
      return undefined;
    }
  };

  const search = async (resetPage = true, fetchPage?: number) => {
    if (!userId?.trim()) {
      setError("User context missing. Sign in again if this persists.");
      return;
    }
    const pageToUse = fetchPage ?? (resetPage ? 1 : page);
    if (resetPage) setPage(1);
    else setPage(pageToUse);
    setLoading(true);
    setError(null);
      try {
        const queryValue = query.trim();
        if (!queryValue) {
          setRows([]);
          setTotal(0);
          setHasMore(false);
          setExplainPayload(null);
          setError("Enter a search query to run semantic search.");
          return;
        }
        type SearchFilters = { metadata?: Record<string, unknown>; start_time?: string; end_time?: string };
        const body: {
          user_id: string;
          namespace?: string;
          query: string;
          page: number;
          page_size: number;
          explain?: boolean;
          filters?: SearchFilters;
        } = {
          user_id: userId,
          namespace: namespace || undefined,
          query: queryValue,
          page: pageToUse,
          page_size: pageSize,
        };
        if (searchExplainEnabled) body.explain = true;
      const filters = parseMetadata();
      if (filters) {
        body.filters = { metadata: filters };
      }
      if (start || end) {
        body.filters = body.filters || {};
        body.filters.start_time = start || undefined;
        body.filters.end_time = end || undefined;
      }

      const res = await apiPost<{ results: SearchApiResult[]; total?: number; has_more?: boolean }>(
        "/v1/search",
        body,
        saveToHistory ? { "x-save-history": "true" } : undefined,
      );
      const rawResults = res.results ?? [];
      const mappedRows = mapSearchResultsToRows(rawResults);
      setRows((prev) => (resetPage ? mappedRows : [...prev, ...mappedRows]));
      if (searchExplainEnabled) {
        const slice = rawResults.map((row) => ({
          memory_id: row.memory_id,
          chunk_id: row.chunk_id,
          chunk_index: row.chunk_index,
          score: row.score,
          _explain: row._explain ?? null,
        }));
        setExplainPayload((prev) => {
          if (resetPage) return { explain_requested: true, results: slice };
          const merged = [...(prev?.results ?? []), ...slice];
          return { explain_requested: true, results: merged };
        });
      } else {
        setExplainPayload(null);
      }
      setTotal(res.total ?? null);
      setHasMore(res.has_more ?? false);
      onSearchCompleted();
      if (saveToHistory) {
        void loadHistory();
      }
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = () => {
    void search(false, page + 1);
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await apiGet<{ history?: Array<{ id: string; query: string; created_at: string }> }>("/v1/search/history?limit=20");
      setHistoryRows(res.history ?? []);
    } catch (err: unknown) {
      setHistoryError(userFacingErrorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  const replayQuery = async (queryId: string) => {
    setReplayLoadingId(queryId);
    setReplayError(null);
    try {
      const res = await apiPost<{
        query_id: string;
        previous: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
        current: { results?: Array<{ chunk_id?: string; memory_id?: string; score?: number }> } | null;
      }>("/v1/search/replay", { query_id: queryId });
      setReplayResult(res);
      setFeedbackTraceId(res.query_id);
    } catch (err: unknown) {
      setReplayError(userFacingErrorMessage(err));
    } finally {
      setReplayLoadingId(null);
    }
  };

  const loadEvalSets = async () => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      const res = await apiGet<{ eval_sets?: Array<{ id: string; name: string; created_at: string }> }>("/v1/evals/sets");
      const sets = res.eval_sets ?? [];
      setEvalSets(sets);
      if (sets.length > 0 && !selectedEvalSetId) {
        setSelectedEvalSetId(sets[0].id);
      }
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const createEvalSet = async () => {
    if (!newEvalSetName.trim()) return;
    setEvalLoading(true);
    setEvalError(null);
    try {
      const res = await apiPost<{ eval_set?: { id: string; name: string; created_at: string } }>("/v1/evals/sets", {
        name: newEvalSetName.trim(),
      });
      setNewEvalSetName("");
      await loadEvalSets();
      if (res.eval_set?.id) setSelectedEvalSetId(res.eval_set.id);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const deleteEvalSet = async (id: string) => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      await apiDelete<{ deleted: boolean; id: string }>(`/v1/evals/sets/${encodeURIComponent(id)}`);
      if (selectedEvalSetId === id) setSelectedEvalSetId("");
      setEvalItems([]);
      setEvalRunResult(null);
      await loadEvalSets();
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalLoading(false);
    }
  };

  const loadEvalItems = async (evalSetId: string) => {
    if (!evalSetId) {
      setEvalItems([]);
      return;
    }
    setEvalItemsLoading(true);
    setEvalError(null);
    try {
      const res = await apiGet<{ eval_items?: Array<{ id: string; query: string; expected_memory_ids: string[] }> }>(
        `/v1/evals/items?eval_set_id=${encodeURIComponent(evalSetId)}`,
      );
      setEvalItems(res.eval_items ?? []);
      setEvalItemsPage(1);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const createEvalItem = async () => {
    if (!selectedEvalSetId || !newEvalQuery.trim()) return;
    setEvalItemsLoading(true);
    setEvalError(null);
    setExpectedIdsValidationError(null);
    try {
      const expectedIds = newEvalExpectedIds
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const invalidExpected = expectedIds.filter((id) => !uuidRe.test(id));
      if (invalidExpected.length > 0) {
        setExpectedIdsValidationError(`Invalid UUID(s): ${invalidExpected.slice(0, 3).join(", ")}${invalidExpected.length > 3 ? "…" : ""}`);
        return;
      }
      await apiPost<{ eval_item?: { id: string } }>("/v1/evals/items", {
        eval_set_id: selectedEvalSetId,
        query: newEvalQuery.trim(),
        expected_memory_ids: expectedIds,
      });
      setNewEvalQuery("");
      setNewEvalExpectedIds("");
      await loadEvalItems(selectedEvalSetId);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const exportEvalRunJson = () => {
    if (!evalRunResult) return;
    const blob = new Blob([JSON.stringify(evalRunResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `eval-run-${selectedEvalSetId || "set"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const submitContextFeedback = async () => {
    const traceId = feedbackTraceId.trim() || replayResult?.query_id;
    if (!traceId) {
      setFeedbackMessage("Trace ID is required.");
      return;
    }
    const parseCsv = (raw: string): string[] => raw.split(",").map((v) => v.trim()).filter(Boolean);
    setFeedbackBusy(true);
    setFeedbackMessage(null);
    try {
      await apiPost<{ accepted: boolean }>("/v1/context/feedback", {
        trace_id: traceId,
        query_id: replayResult?.query_id,
        chunk_ids_used: parseCsv(feedbackUsedIds),
        chunk_ids_unused: parseCsv(feedbackUnusedIds),
      });
      setFeedbackMessage("Feedback submitted.");
    } catch (err: unknown) {
      setFeedbackMessage(userFacingErrorMessage(err));
    } finally {
      setFeedbackBusy(false);
    }
  };

  const deleteEvalItem = async (id: string) => {
    if (!selectedEvalSetId) return;
    setEvalItemsLoading(true);
    setEvalError(null);
    try {
      await apiDelete<{ deleted: boolean; id: string }>(`/v1/evals/items/${encodeURIComponent(id)}`);
      await loadEvalItems(selectedEvalSetId);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalItemsLoading(false);
    }
  };

  const runEvalSet = async () => {
    if (!selectedEvalSetId) return;
    setEvalRunLoading(true);
    setEvalError(null);
    try {
      const res = await apiPost<{
        item_count: number;
        avg_precision_at_k: number;
        avg_recall: number;
        items: Array<{
          eval_item_id: string;
          query: string;
          precision_at_k: number;
          recall: number;
          matched_expected_memory_ids: string[];
        }>;
      }>("/v1/evals/run", {
        eval_set_id: selectedEvalSetId,
        user_id: userId,
        namespace: namespace || undefined,
        top_k: 5,
        search_mode: "hybrid",
      });
      setEvalRunResult(res);
    } catch (err: unknown) {
      setEvalError(userFacingErrorMessage(err));
    } finally {
      setEvalRunLoading(false);
    }
  };

  useEffect(() => {
    void loadEvalSets();
  }, []);

  useEffect(() => {
    if (!selectedEvalSetId) return;
    void loadEvalItems(selectedEvalSetId);
  }, [selectedEvalSetId]);

  useEffect(() => {
    setEvalItemsPage((p) => Math.min(Math.max(1, p), Math.max(1, Math.ceil(evalItems.length / evalItemsPageSize))));
  }, [evalItems, evalItemsPageSize]);

  const replayPrevIds = useMemo(
    () => new Set((replayResult?.previous?.results ?? []).map((r) => r.chunk_id).filter((id): id is string => Boolean(id))),
    [replayResult],
  );
  const replayCurrIds = useMemo(
    () => new Set((replayResult?.current?.results ?? []).map((r) => r.chunk_id).filter((id): id is string => Boolean(id))),
    [replayResult],
  );
  const replayAdded = useMemo(() => Array.from(replayCurrIds).filter((id) => !replayPrevIds.has(id)), [replayCurrIds, replayPrevIds]);
  const replayRemoved = useMemo(() => Array.from(replayPrevIds).filter((id) => !replayCurrIds.has(id)), [replayCurrIds, replayPrevIds]);
  const replayUnchanged = useMemo(() => Array.from(replayCurrIds).filter((id) => replayPrevIds.has(id)), [replayCurrIds, replayPrevIds]);
  const evalItemsTotalPages = Math.max(1, Math.ceil(evalItems.length / evalItemsPageSize));
  const pagedEvalItems = useMemo(
    () => evalItems.slice((evalItemsPage - 1) * evalItemsPageSize, evalItemsPage * evalItemsPageSize),
    [evalItems, evalItemsPage, evalItemsPageSize],
  );

  const openMemory = async (id: string) => {
    try {
      const res = await apiGet<MemoryRow>(`/v1/memories/${id}`);
      setSelected(res);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    }
  };

  return (
    <Panel title="Memory Browser">
      <div className="muted small">Using session (workspace-scoped).</div>
      <div className="row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search query" />
        <input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="Namespace/project" />
      </div>
      <div className="row">
        <input value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder='Metadata JSON {"tag":"x"}' />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} title="Start date" />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} title="End date" />
      </div>
      <div className="row">
        <label>
          <input type="checkbox" checked={saveToHistory} onChange={(e) => setSaveToHistory(e.target.checked)} />
          Save to history (for replay)
        </label>
        <label title="Adds explain: true to the search request and shows structured trace JSON when present">
          <input type="checkbox" checked={searchExplainEnabled} onChange={(e) => setSearchExplainEnabled(e.target.checked)} />
          Retrieval explain (debug)
        </label>
        <button onClick={() => search(true)} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        <button
          className="ghost"
          onClick={() => {
            setRows([]);
            setTotal(null);
            setHasMore(false);
            setExplainPayload(null);
          }}
        >
          Clear
        </button>
        <button className="ghost" onClick={loadHistory} disabled={historyLoading}>
          {historyLoading ? "Loading history…" : "Load history"}
        </button>
      </div>
      {error && (
        <div className="badge">
          {error}
          <div>
            <button className="ghost" onClick={() => search(true)} disabled={loading}>
              Retry
            </button>
          </div>
        </div>
      )}
      {rows.length === 0 && !loading && <div className="muted small">No results.</div>}
      <div className="list">
        {rows.map((r) => (
          <div key={r.key} className="card clickable" onClick={() => openMemory(r.memoryId)}>
            <div className="row-space">
              <strong>Memory {r.memoryId.slice(0, 8)}…</strong>
              <span className="muted small">Chunk #{r.chunkIndex}</span>
            </div>
            <div className="muted small">
              Score: {r.score.toFixed(3)} · Chunk: <code>{r.chunkId}</code>
              {searchExplainEnabled && r.explain != null && (
                <span className="muted small"> · trace</span>
              )}
            </div>
            <p>{r.text.slice(0, 240)}</p>
          </div>
        ))}
      </div>
      {searchExplainEnabled && explainPayload != null && (
        <div className="panel mt-md">
          <div className="panel-head">Retrieval explain (_explain)</div>
          <div className="panel-body">
            <pre className="code-block">{JSON.stringify(explainPayload, null, 2)}</pre>
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <>
          {total != null && (
            <div className="muted small">
              {rows.length} of {total} result{total !== 1 ? "s" : ""}.
            </div>
          )}
          <button
            className="ghost"
            onClick={loadMore}
            disabled={loading || !hasMore || (total != null && rows.length >= total)}
          >
            {loading ? "Loading…" : !hasMore || (total != null && rows.length >= total) ? "No more results" : "Load more"}
          </button>
        </>
      )}

      <div className="panel mt-md">
        <div className="panel-head">Retrieval history and replay</div>
        <div className="panel-body">
          {historyError && <div className="badge">{historyError}</div>}
          {historyRows.length === 0 && !historyLoading && (
            <div className="muted small">
              No saved history yet. Enable “Save to history” before searching, then click Load history.
            </div>
          )}
          <ul className="list">
            {historyRows.map((h) => (
              <li key={h.id} className="card">
                <div className="row-space">
                  <div>
                    <strong>{h.query || "(empty query)"}</strong>
                    <div className="muted small">{new Date(h.created_at).toLocaleString()}</div>
                  </div>
                  <button className="ghost" onClick={() => replayQuery(h.id)} disabled={replayLoadingId === h.id}>
                    {replayLoadingId === h.id ? "Replaying…" : "Replay"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {replayError && <div className="badge">{replayError}</div>}
          {replayResult && (
            <div className="card">
              <strong>Replay diff</strong>
              <div className="muted small">Query ID: <code>{replayResult.query_id}</code></div>
              <div className="muted small">
                Previous results: {replayResult.previous?.results?.length ?? 0} · Current results: {replayResult.current?.results?.length ?? 0}
              </div>
              <div className="mt-sm">
                <div className="muted small">
                  Added chunks: {replayAdded.length} · Removed chunks: {replayRemoved.length} · Unchanged: {replayUnchanged.length}
                </div>
                {replayAdded.length > 0 && (
                  <div className="muted small">
                    Added: {replayAdded.slice(0, 5).map((id) => id.slice(0, 8)).join(", ")}{replayAdded.length > 5 ? "…" : ""}
                  </div>
                )}
                {replayRemoved.length > 0 && (
                  <div className="muted small">
                    Removed: {replayRemoved.slice(0, 5).map((id) => id.slice(0, 8)).join(", ")}{replayRemoved.length > 5 ? "…" : ""}
                  </div>
                )}
                <div className="row mt-sm">
                  <input
                    value={feedbackTraceId}
                    onChange={(e) => setFeedbackTraceId(e.target.value)}
                    placeholder="Trace ID (defaults to replay query ID)"
                  />
                  <button className="ghost" onClick={() => setFeedbackTraceId(replayResult.query_id)}>
                    Use replay ID
                  </button>
                </div>
                <div className="row mt-sm">
                  <input
                    value={feedbackUsedIds}
                    onChange={(e) => setFeedbackUsedIds(e.target.value)}
                    placeholder="Used chunk IDs (comma-separated)"
                  />
                  <input
                    value={feedbackUnusedIds}
                    onChange={(e) => setFeedbackUnusedIds(e.target.value)}
                    placeholder="Unused chunk IDs (comma-separated)"
                  />
                  <button onClick={submitContextFeedback} disabled={feedbackBusy}>
                    {feedbackBusy ? "Submitting…" : "Submit feedback"}
                  </button>
                </div>
                {feedbackMessage && <div className="muted small">{feedbackMessage}</div>}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel mt-md">
        <div className="panel-head">Eval sets and runs</div>
        <div className="panel-body">
          <div className="row">
            <input
              value={newEvalSetName}
              onChange={(e) => setNewEvalSetName(e.target.value)}
              placeholder="New eval set name"
            />
            <button onClick={createEvalSet} disabled={evalLoading || !newEvalSetName.trim()}>
              {evalLoading ? "Saving…" : "Create set"}
            </button>
            <button className="ghost" onClick={loadEvalSets} disabled={evalLoading}>
              Refresh sets
            </button>
          </div>
          {evalError && <div className="badge">{evalError}</div>}
          <ul className="list">
            {evalSets.map((s) => (
              <li key={s.id} className="card">
                <div className="row-space">
                  <div>
                    <strong>{s.name}</strong>
                    <div className="muted small">{new Date(s.created_at).toLocaleString()}</div>
                  </div>
                  <div className="row">
                    <button
                      className={selectedEvalSetId === s.id ? "" : "ghost"}
                      onClick={() => {
                        setSelectedEvalSetId(s.id);
                        setEvalRunResult(null);
                      }}
                    >
                      {selectedEvalSetId === s.id ? "Selected" : "Use"}
                    </button>
                    <button className="ghost" onClick={() => deleteEvalSet(s.id)} disabled={evalLoading}>
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {selectedEvalSetId && (
            <>
              <div className="row mt-sm">
                <input
                  value={newEvalQuery}
                  onChange={(e) => setNewEvalQuery(e.target.value)}
                  placeholder="Eval query"
                />
                <input
                  value={newEvalExpectedIds}
                  onChange={(e) => setNewEvalExpectedIds(e.target.value)}
                  placeholder="Expected memory IDs (comma-separated UUIDs)"
                />
                <button onClick={createEvalItem} disabled={evalItemsLoading || !newEvalQuery.trim()}>
                  {evalItemsLoading ? "Saving…" : "Add item"}
                </button>
              </div>
              {expectedIdsValidationError && <div className="badge">{expectedIdsValidationError}</div>}
              <div className="row mt-sm">
                <button onClick={runEvalSet} disabled={evalRunLoading || evalItems.length === 0}>
                  {evalRunLoading ? "Running…" : "Run eval set"}
                </button>
              </div>
              {evalItemsLoading && <div className="muted small">Loading eval items…</div>}
              <ul className="list">
                {pagedEvalItems.map((item) => (
                  <li key={item.id} className="card">
                    <div className="row-space">
                      <div>
                        <strong>{item.query}</strong>
                        <div className="muted small">
                          Expected IDs: {item.expected_memory_ids?.length ?? 0}
                        </div>
                      </div>
                      <button className="ghost" onClick={() => deleteEvalItem(item.id)} disabled={evalItemsLoading}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {evalItems.length > 0 && (
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setEvalItemsPage((p) => Math.max(1, p - 1))}
                    disabled={evalItemsPage <= 1}
                  >
                    Prev
                  </button>
                  <span className="muted small">Page {evalItemsPage} / {evalItemsTotalPages}</span>
                  <button
                    className="ghost"
                    onClick={() => setEvalItemsPage((p) => Math.min(evalItemsTotalPages, p + 1))}
                    disabled={evalItemsPage >= evalItemsTotalPages}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}

          {evalRunResult && (
            <div className="card mt-sm">
              <strong>Eval run result</strong>
              <div className="muted small">
                Items: {evalRunResult.item_count} · Avg Precision@k: {evalRunResult.avg_precision_at_k.toFixed(3)} · Avg Recall: {evalRunResult.avg_recall.toFixed(3)}
              </div>
              <div className="row mt-sm">
                <button className="ghost" onClick={exportEvalRunJson}>Export JSON</button>
              </div>
              <ul className="list">
                {evalRunResult.items.slice(0, 10).map((item) => (
                  <li key={item.eval_item_id} className="card">
                    <div className="row-space">
                      <span>{item.query}</span>
                      <span className="muted small">
                        P@k {item.precision_at_k.toFixed(3)} · R {item.recall.toFixed(3)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="modal" onClick={() => setSelected(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Memory {selected.id}</h3>
            <div className="muted small">Created {new Date(selected.created_at).toLocaleString()}</div>
            {(selected.memory_type != null && selected.memory_type !== "") && (
              <div className="muted small">Type: <span className="badge">{selected.memory_type}</span></div>
            )}
            {(selected.source_memory_id != null && selected.source_memory_id !== "") && (
              <div className="muted small">Source memory: <code>{selected.source_memory_id}</code></div>
            )}
            <pre className="code-block">{selected.text}</pre>
            <div className="muted small">Metadata: {JSON.stringify(selected.metadata)}</div>
            <button className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function UsageView({ workspaceId, embedded = false }: { workspaceId: string; embedded?: boolean }) {
  const [usage, setUsage] = useState<UsageRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspaceId?.trim()) {
    return embedded ? <div className="badge">Set your project first to view usage and limits.</div> : (
      <Panel title="Usage">
        <div className="badge">Set your project first to view usage and limits.</div>
      </Panel>
    );
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<UsageRow>("/v1/usage/today");
      setUsage(res);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspaceId]);

  const content = (
    <>
      <div className="muted small">Using session (workspace-scoped).</div>
      <div className="muted small">Enforcement: daily fair-use cap (hard) and billing-period cap (hard).</div>
      {loading && <div>Loading…</div>}
      {error && (
        <div className="badge">
          {error}
          <div>
            <button className="ghost" onClick={load} disabled={loading}>
              Retry
            </button>
          </div>
        </div>
      )}
      {usage && (
        <div className="list">
          {usage.cap_alerts && usage.cap_alerts.length > 0 && (
            <div className="card mt-sm">
              <strong className="small">Usage caps</strong>
              <ul className="muted small usage-cap-alert-list">
                {usage.cap_alerts.map((a) => (
                  <li key={`${a.resource}-${a.severity}`}>
                    <span className="badge">{a.severity}</span> {a.resource}: {a.used} / {a.cap} (
                    {Math.round(a.ratio * 100)}% of daily cap)
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <div className="row-space">
              <strong>{usage.day}</strong>
              {usage.plan && <span className="badge">{usage.plan}</span>}
              {usage.operational_mode && usage.operational_mode !== "normal" && (
                <span className="badge">{usage.operational_mode}</span>
              )}
            </div>
            <div className="row-space">
              <span>Writes</span>
              <span>
                {usage.writes} / {usage.limits?.writes ?? "?"}
              </span>
            </div>
            <div className="row-space">
              <span>Reads</span>
              <span>
                {usage.reads} / {usage.limits?.reads ?? "?"}
              </span>
            </div>
            <div className="row-space">
              <span>Embeds</span>
              <span>
                {usage.embeds} / {usage.limits?.embeds ?? "?"}
              </span>
            </div>
            {(usage as { period?: { start?: string | null; end?: string | null } }).period && (
              <div className="muted small mt-sm">
                Billing period: {(usage as { period?: { start?: string | null } }).period?.start ?? "n/a"} to {(usage as { period?: { end?: string | null } }).period?.end ?? "n/a"}
              </div>
            )}
          </div>
        </div>
      )}
      {!loading && !usage && !error && <div className="muted small">No usage yet.</div>}
    </>
  );
  return embedded ? content : <Panel title="Usage">{content}</Panel>;
}

function MembersView({ workspaceId, currentUserId }: { workspaceId: string; currentUserId: string }) {
  const [members, setMembers] = useState<Array<{ user_id: string; role: string; created_at: string }>>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [seatCap, setSeatCap] = useState<number>(10);
  const [effectivePlan, setEffectivePlan] = useState<string>("team");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin" | "owner">("member");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      supabase
        .from("workspace_members")
        .select("user_id, role, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false }),
      supabase
        .from("workspace_invites")
        .select("id, workspace_id, email, role, created_at, expires_at, accepted_at, revoked_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false }),
    ])
      .then(([mem, inv]) => {
        devLog({
          sessionId: "aa3f1d",
          runId: "pre-fix",
          hypothesisId: "H2",
          location: "apps/dashboard/src/App.tsx:members",
          message: "members and invites query settled",
          data: { memberError: mem.error?.message ?? null, inviteError: inv.error?.message ?? null },
          timestamp: Date.now(),
        });
        const nextError = mem.error?.message ?? inv.error?.message ?? null;
        if (nextError) setError(nextError);
        setMembers(mem.data ?? []);
        setInvites(inv.data as InviteRow[] ?? []);
      })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const loadSeatCap = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const billing = await apiGet<{ effective_plan?: string; plan?: string }>("/v1/billing/status");
      const plan = billing.effective_plan ?? billing.plan ?? "launch";
      setEffectivePlan(plan);
      setSeatCap(seatCapForPlan(plan));
    } catch {
      // Keep fallback seat cap when billing status is unavailable.
      setEffectivePlan("team");
      setSeatCap(10);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
    void loadSeatCap();
  }, [load, loadSeatCap]);

  const createInvite = async () => {
    if (!workspaceId || !newEmail.trim()) return;
    const currentSeats = members.length + invites.filter((invite) => !invite.accepted_at && !invite.revoked_at).length;
    if (currentSeats >= seatCap) {
      setError(`Seat cap reached for ${effectivePlan} plan (${seatCap} seats). Upgrade to add more members.`);
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc("create_invite", {
      p_workspace_id: workspaceId,
      p_email: newEmail.trim(),
      p_role: inviteRole,
    });
    if (error) setError(error.message);
    setNewEmail("");
    setBusy(false);
    load();
  };

  const revokeInvite = async (id: string) => {
    setBusy(true);
    await supabase.rpc("revoke_invite", { p_invite_id: id });
    setBusy(false);
    load();
  };

  const updateRole = async (userId: string, role: string) => {
    setBusy(true);
    const { error } = await supabase.rpc("update_member_role", {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_role: role,
    });
    if (error) setError(error.message);
    setBusy(false);
    load();
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    const { error } = await supabase.rpc("remove_member", {
      p_workspace_id: workspaceId,
      p_user_id: userId,
    });
    if (error) setError(error.message);
    setBusy(false);
    load();
  };

  if (!workspaceId) return null;

  return (
    <div className="panel mt-md">
      <div className="panel-head">Members & Invites</div>
      <div className="row-space">
        <span className="muted small">Plan: {effectivePlan}</span>
        <span className="badge">
          Seats used: {members.length}/{seatCap}
        </span>
      </div>
      {error && <div className="badge">{error}</div>}
      {loading && <div>Loading…</div>}

      <div className="stack">
        <div className="row">
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="invitee@example.com"
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)} title="Invite role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
          <button onClick={createInvite} disabled={!newEmail.trim() || busy}>
            {busy ? "Saving…" : "Send invite"}
          </button>
        </div>
        <div className="muted small">
          Pending invites count toward seat limits. Solo plans allow 1 member. Team plans allow up to 10 members.
        </div>
      </div>

      <div className="muted small mt-sm">Members</div>
      {!loading && members.length === 0 && <div className="muted small">No members found.</div>}
      <ul className="list">
        {members.map((m) => (
          <li key={`${m.user_id}-${m.role}`} className="row-space card">
            <div>
              <strong>{m.user_id}</strong>
              <div className="muted small">{new Date(m.created_at).toLocaleString()}</div>
            </div>
            <div className="row">
              <select
                value={m.role}
                onChange={(e) => updateRole(m.user_id, e.target.value)}
                disabled={busy}
                title="Member role"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
              <button
                className="ghost"
                onClick={() => removeMember(m.user_id)}
                disabled={busy || m.user_id === currentUserId}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="muted small mt-md">Pending invites</div>
      {invites.length === 0 && <div className="muted small">No invites.</div>}
      <ul className="list">
        {invites.map((i) => (
          <li key={i.id} className="row-space card">
            <div>
              <strong>{i.email}</strong> <span className="badge">{i.role}</span>
              <div className="muted small">Expires {new Date(i.expires_at).toLocaleString()}</div>
              {i.accepted_at && <div className="badge">Accepted</div>}
              {i.revoked_at && <div className="badge">Revoked</div>}
            </div>
            {!i.accepted_at && !i.revoked_at && (
              <button className="ghost" onClick={() => revokeInvite(i.id)} disabled={busy}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
