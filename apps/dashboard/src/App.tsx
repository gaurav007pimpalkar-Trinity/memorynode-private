import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { buildPaletteSectionRows, pushRecentCommandId, type PaletteCommand } from "./consoleCommandPalette";
import {
  billingReturnNoticeFromSearch,
  pathForTab,
  tabFromPath,
  tabsRequiringWorkspace,
  UNIFIED_SIDEBAR_GROUPS,
  type BillingReturnNotice,
  type Tab,
} from "./consoleRoutes";
import { ConnectorSettingRow, MemoryRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import {
  apiDelete,
  apiEnvError,
  apiGet,
  apiPatch,
  apiPost,
  dashboardApiGet,
  dashboardApiPost,
  ensureDashboardSession,
  dashboardLogout,
  setOnUnauthorized,
  userFacingErrorMessage,
} from "./apiClient";
import { API_PATHS } from "./config/apiPaths";
import { MN_CONSOLE_LAST_API_KEY_PLAINTEXT } from "./config/storageKeys";
import { ROUTES } from "./config/routes";
import { DashboardBuildFooter } from "./DashboardBuildFooter";
import { EmptyState } from "./components/EmptyState";
import { Panel, Shell } from "./components/Panel";
import { LoginScreen } from "./components/auth/LoginScreen";
import { DashboardSessionAuthNote } from "./components/DashboardSessionAuthNote";
import { OverviewView } from "./views/OverviewView";
import { MemoryLabView } from "./views/MemoryLabView";
import { ImportView } from "./views/ImportView";
import { BillingUsageView, BillingView } from "./views/BillingView";
import { WorkspacesView as WorkspacesPanel } from "./views/WorkspacesView";
import { ApiKeysView as ApiKeysPanel } from "./views/ApiKeysView";

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
  const location = useLocation();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
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
  const [labSearchDone, setLabSearchDone] = useState(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem("mn_lab_search_done") === "1";
  });
  const consoleSearchRef = useRef<HTMLInputElement>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const workspaceBootstrapAttemptedRef = useRef(false);

  const resolvedTab = tabFromPath(location.pathname);
  const billingReturnNotice = useMemo(() => {
    if (resolvedTab !== "billing") return null;
    return billingReturnNoticeFromSearch(location.search);
  }, [resolvedTab, location.search]);

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
        const accessToken = session.access_token?.trim() ?? "";
        if (!accessToken) throw new Error("missing_access_token");
        const boot = await dashboardApiPost<{ workspace_id?: string; name?: string; created?: boolean }>(
          API_PATHS.dashboard.bootstrap,
          { access_token: accessToken, workspace_name: "My Project" },
        );
        const createdWorkspaceId = (boot.workspace_id ?? "").trim();
        if (!createdWorkspaceId || cancelled) return;
        setWorkspaceId(createdWorkspaceId);
        persistWorkspaceId(createdWorkspaceId);
        setAlert(boot.created ? "Your first project is ready. You're good to go." : "We selected your latest project so you can continue.");
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
    void apiGet<{ effective_plan?: string; plan?: string }>(API_PATHS.billing.status)
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
      setSessionError("Session expired or access denied. Please sign in again or connect a project in Get started.");
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
      setAlert("Project connected. All sections are now ready.");
    }
    setWorkspaceSaving(false);
  };

  const sidebarGroups = useMemo(() => UNIFIED_SIDEBAR_GROUPS, []);
  const sidebarCommands = useMemo(
    () =>
      sidebarGroups.flatMap((g) =>
        g.entries.map((e) => ({ tab: e.tab, label: e.label, section: g.section })),
      ),
    [sidebarGroups],
  );

  const onMemoryLabCriteriaMet = useCallback(() => {
    try {
      sessionStorage.setItem("mn_lab_search_done", "1");
    } catch {
      /* ignore */
    }
    setLabSearchDone(true);
  }, []);

  const onboardingSteps = useMemo(
    () => [
      { key: "api-key", label: "Create an API key", done: firstApiKeyCreated },
      { key: "lab", label: "Test memory in Memory Lab", done: labSearchDone },
      { key: "ship", label: "Use it in your app", done: false },
    ],
    [firstApiKeyCreated, labSearchDone],
  );
  const completedSteps = onboardingSteps.filter((step) => step.done).length;

  const selectTab = useCallback(
    (t: Tab) => {
      if (!workspaceReady && tabsRequiringWorkspace.includes(t)) return;
      navigate(pathForTab(t));
      setNavDrawerOpen(false);
    },
    [workspaceReady, navigate],
  );

  useEffect(() => {
    if (resolvedTab === null) return;
    if (workspaceReady) return;
    if (!tabsRequiringWorkspace.includes(resolvedTab)) return;
    navigate("/", { replace: true });
  }, [workspaceReady, resolvedTab, navigate]);

  const closeCommandPalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery("");
    consoleSearchRef.current?.blur();
  }, []);

  const paletteCommands = useMemo((): PaletteCommand[] => {
    const workspaceIdStr = effectiveWorkspaceId?.trim() ?? "";
    const navLocked = (t: Tab) => !workspaceReady && tabsRequiringWorkspace.includes(t);

    const navigation: PaletteCommand[] = sidebarCommands.map((c) => ({
      id: `nav-${c.tab}`,
      group: "navigation" as const,
      label: c.label,
      description: c.section,
      keywords: [c.section, c.label, pathForTab(c.tab).replace(/^\//, "")],
      locked: navLocked(c.tab),
      tab: c.tab,
      execute: () => {
        if (navLocked(c.tab)) return;
        selectTab(c.tab);
      },
    }));

    const actions: PaletteCommand[] = [
      {
        id: "action-memory-lab",
        group: "action",
        label: "Open Memory Lab",
        description: "Semantic search, context probe, retrieval explain",
        keywords: ["lab", "search", "memory", "debug", "memories"],
        locked: navLocked("memories"),
        tab: "memories",
        execute: () => {
          if (navLocked("memories")) return;
          selectTab("memories");
        },
      },
      {
        id: "action-create-api-key",
        group: "action",
        label: "Create API key",
        description: "Open API Keys — add a server key for your app",
        keywords: ["key", "token", "auth", "api-keys", "secrets"],
        locked: navLocked("api_keys"),
        tab: "api_keys",
        execute: () => {
          if (navLocked("api_keys")) return;
          selectTab("api_keys");
        },
      },
      {
        id: "action-copy-project-id",
        group: "action",
        label: "Copy project ID",
        description: workspaceIdStr ? `Current project · ${workspaceIdStr.slice(0, 8)}…` : "Connect a project first",
        keywords: ["workspace", "uuid", "project", "id", "clipboard"],
        locked: !workspaceIdStr,
        execute: () => {
          if (!workspaceIdStr) return;
          void navigator.clipboard.writeText(workspaceIdStr);
          setAlert("Project ID copied to clipboard.");
        },
      },
      {
        id: "action-copy-api-key",
        group: "action",
        label: "Copy latest API key",
        description: "Uses the last key shown after creation (this session only)",
        keywords: ["clipboard", "secret", "mn_live", "token"],
        locked: false,
        execute: () => {
          try {
            const key = sessionStorage.getItem(MN_CONSOLE_LAST_API_KEY_PLAINTEXT)?.trim();
            if (key) {
              void navigator.clipboard.writeText(key);
              setAlert("API key copied to clipboard.");
            } else {
              setAlert("No key in this session — create one on API Keys (copy it from the one-time modal).");
            }
          } catch {
            setAlert("Could not copy — check browser permissions.");
          }
        },
      },
      {
        id: "action-goto-usage",
        group: "action",
        label: "Go to Usage",
        description: "Reads, writes, embed limits",
        keywords: ["billing", "quota", "metrics", "consumption"],
        locked: navLocked("usage"),
        tab: "usage",
        execute: () => {
          if (navLocked("usage")) return;
          selectTab("usage");
        },
      },
      {
        id: "action-goto-import",
        group: "action",
        label: "Open Import",
        description: "Bulk load memories",
        keywords: ["upload", "migrate", "json", "base64"],
        locked: navLocked("import"),
        tab: "import",
        execute: () => {
          if (navLocked("import")) return;
          selectTab("import");
        },
      },
      {
        id: "action-goto-billing",
        group: "action",
        label: "Open Billing",
        description: "Plan and invoices",
        keywords: ["plan", "invoice", "subscription", "payment"],
        locked: navLocked("billing"),
        tab: "billing",
        execute: () => {
          if (navLocked("billing")) return;
          selectTab("billing");
        },
      },
    ];

    return [...actions, ...navigation];
  }, [effectiveWorkspaceId, workspaceReady, sidebarCommands, selectTab]);

  const { rows: paletteRows, flat: paletteFlat } = useMemo(
    () => buildPaletteSectionRows(paletteQuery, paletteCommands),
    [paletteQuery, paletteCommands],
  );

  useEffect(() => {
    setPaletteIndex((i) => {
      if (paletteFlat.length === 0) return 0;
      return Math.min(i, paletteFlat.length - 1);
    });
  }, [paletteFlat.length, paletteQuery]);

  const runPaletteCommand = useCallback(
    (cmd: PaletteCommand) => {
      if (cmd.locked) return;
      pushRecentCommandId(cmd.id);
      cmd.execute();
      closeCommandPalette();
    },
    [closeCommandPalette],
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
          <div className="alert alert--error" role="alert">
            The dashboard is missing required environment variables.
          </div>
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
          <div className="alert alert--error" role="alert">
            {sessionError}
          </div>
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

  if (resolvedTab === null) {
    return <Navigate to="/" replace />;
  }

  const tab = resolvedTab;
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
          <div className="muted small">Memory Lab first</div>
          <div className="muted small mt-sm">
            Search and debug production memory from one place. Integrations, usage, and billing support your rollout.
          </div>
        </div>
        <div className={`console-search-wrap${paletteOpen ? " console-search-wrap--open" : ""}`}>
          <input
            ref={consoleSearchRef}
            type="search"
            className="console-search-input"
            placeholder="Commands and pages…"
            aria-label="Command palette"
            aria-expanded={paletteOpen}
            aria-controls="cmdgroups"
            aria-activedescendant={paletteFlat[paletteIndex] ? `palette-cmd-${paletteFlat[paletteIndex].id}` : undefined}
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
                setPaletteIndex((i) => Math.min(Math.max(0, paletteFlat.length - 1), i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setPaletteIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                const pick = paletteFlat[paletteIndex];
                if (pick) {
                  e.preventDefault();
                  runPaletteCommand(pick);
                }
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeCommandPalette();
              }
            }}
          />
          <kbd className="console-search-kbd">⌘K</kbd>
          {paletteOpen && (
            <div
              id="cmdgroups"
              className="console-search-results"
              role="listbox"
              aria-label="Commands and navigation"
              onMouseDown={(ev) => ev.preventDefault()}
            >
              {paletteFlat.length === 0 ? (
                <div className="console-search-empty muted small">No matching commands</div>
              ) : (
                paletteRows.map((row, ri) =>
                  row.kind === "section" ? (
                    <div
                      key={`palette-sec-${row.title}-${ri}`}
                      id={`cmdgroups-${row.title.toLowerCase().replace(/\s+/g, "-")}`}
                      className="console-search-group-label"
                      role="presentation"
                    >
                      {row.title}
                    </div>
                  ) : (
                    <button
                      key={row.cmd.id}
                      id={`palette-cmd-${row.cmd.id}`}
                      type="button"
                      role="option"
                      aria-selected={row.flatIndex === paletteIndex}
                      className={
                        row.flatIndex === paletteIndex ? "console-search-item console-search-item--active" : "console-search-item"
                      }
                      disabled={row.cmd.locked}
                      title={
                        row.cmd.locked
                          ? row.cmd.id === "action-copy-project-id"
                            ? "Connect a project to copy its ID."
                            : "Finish Get started (connect a project) to unlock this destination."
                          : `${row.cmd.label}${row.cmd.description ? ` · ${row.cmd.description}` : ""}`
                      }
                      onMouseEnter={() => setPaletteIndex(row.flatIndex)}
                      onClick={() => runPaletteCommand(row.cmd)}
                    >
                      <span className="console-search-item-row">
                        <span className="console-search-item-label">{row.cmd.label}</span>
                        {row.cmd.shortcut ? (
                          <kbd className="console-search-item-shortcut">{row.cmd.shortcut}</kbd>
                        ) : null}
                      </span>
                      {row.cmd.description ? (
                        <span className="console-search-item-desc muted small">{row.cmd.description}</span>
                      ) : null}
                    </button>
                  )
                )
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
                  if (locked) {
                    return (
                      <button
                        key={entry.tab}
                        type="button"
                        className="console-nav-item"
                        disabled
                        title="Finish project setup to open this section."
                      >
                        <span className="console-nav-item-label">{entry.label}</span>
                        {entry.showLock ? <LockIcon className="console-nav-lock" /> : null}
                      </button>
                    );
                  }
                  return (
                    <NavLink
                      key={entry.tab}
                      to={pathForTab(entry.tab)}
                      end={entry.tab === "overview"}
                      className={
                        tab === entry.tab ? "console-nav-item console-nav-item--active" : "console-nav-item"
                      }
                      onClick={() => setNavDrawerOpen(false)}
                    >
                      <span className="console-nav-item-label">{entry.label}</span>
                      {entry.showLock ? <LockIcon className="console-nav-lock" /> : null}
                    </NavLink>
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
                try {
                  sessionStorage.removeItem(MN_CONSOLE_LAST_API_KEY_PLAINTEXT);
                } catch {
                  /* ignore */
                }
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
                <span className="badge badge--accent">
                  {completedSteps}/{onboardingSteps.length} complete
                </span>
              </div>
              <div className="panel-body">
                <div className="muted small">Outcome-driven — ship memory in three steps.</div>
                <ol className="muted small mt-sm">
                  {onboardingSteps.map((s, i) => (
                    <li key={s.key}>
                      <strong>{i + 1}.</strong> {s.label}
                      {s.done ? <span className="muted small"> — done</span> : null}
                    </li>
                  ))}
                </ol>
                <label className="field">
                  <span>Advanced — link another project</span>
                  <input
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder="Paste the value from your team or backup"
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
                {alert != null && alert !== "" ? (
                  <div className="alert alert--info" role="status">
                    {alert}
                  </div>
                ) : null}
                <div className="muted small">
                  {workspaceReady ? "Project connected for this browser." : "No project linked yet — we’ll create or pick one automatically when possible."}
                </div>
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
              Setup complete — Show setup
            </button>
          )}

          <ErrorBoundary onBack={() => navigate("/")}>
            <div className="console-content grid">
              {tab === "overview" && (
                <OverviewView
                  workspaceReady={workspaceReady}
                  sessionReady={sessionReady}
                  hasApiKey={firstApiKeyCreated}
                  onQuickSetup={() => {
                    setOnboardingCollapsed(false);
                    if (workspaceReady) navigate(ROUTES.apiKeys);
                  }}
                />
              )}
              {tab === "continuity" && <SaasContinuityView workspaceId={effectiveWorkspaceId} />}
              {tab === "assistant_memory" && <AssistantMemoryView />}
              {tab === "memories" && (
                <MemoryLabView workspaceId={effectiveWorkspaceId} onLabCriteriaMet={onMemoryLabCriteriaMet} />
              )}
              {tab === "usage" && <RequestsView workspaceId={effectiveWorkspaceId} />}
              {tab === "import" && <ImportView isPaid={planBadge !== "FREE"} />}
              {tab === "api_keys" && (
                <ApiKeysPanel
                  workspaceId={workspaceClaim || workspaceId}
                  onApiKeyCreated={() => {
                    if (!firstApiKeyCreated) setFirstApiKeyCreated(true);
                  }}
                />
              )}
              {tab === "mcp" && <McpView />}
              {tab === "connectors" && <ConnectorSettingsView />}
              {tab === "workspaces" && (
                <WorkspacesPanel
                  workspaceId={workspaceClaim || workspaceId}
                  sessionUserId={session.user.id}
                  onSelectWorkspace={(id) => {
                    setWorkspaceId(id);
                    persistWorkspaceId(id);
                    setAlert("Project selected. Click Connect project to finish.");
                  }}
                />
              )}
              {tab === "billing" && <BillingView workspaceId={effectiveWorkspaceId} returnNotice={billingReturnNotice} />}
            </div>
          </ErrorBoundary>
        </div>
        <DashboardBuildFooter placement="console" />
      </div>
    </div>
  );
}


function AuthLanding() {
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

  const onChangeEmail = () => {
    if (sentResetTimer.current) {
      clearTimeout(sentResetTimer.current);
      sentResetTimer.current = null;
    }
    setMagicSent(false);
    setErrorMessage(null);
  };

  return (
    <LoginScreen
      email={email}
      onEmailChange={setEmail}
      busy={busy}
      errorMessage={errorMessage}
      magicSent={magicSent}
      onMagic={magic}
      onGoogle={google}
      onGithub={github}
      onChangeEmail={onChangeEmail}
    />
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
      await apiPost<{ memory_id: string; stored: boolean }>(API_PATHS.memories.create, {
        user_id: normalizedUserId,
        namespace: "saas-demo",
        text: normalizedMemory,
      });

      const context = await apiPost<{ context_text?: string }>(API_PATHS.context.resolve, {
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
        <div className="mb-sm">
          <span className="badge badge--accent">Example</span>
        </div>
        <div className="alert alert--warning" role="status">
          Set your project first to run the continuity demo.
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Continuity">
      <div className="mb-sm">
        <span className="badge badge--accent">Example</span>
      </div>
      <DashboardSessionAuthNote variant="writes" />
      {message ? (
        <div
          className={`alert ${message.startsWith("Continuity demo completed") ? "alert--success" : "alert--error"}`}
          role="status"
        >
          {message}
        </div>
      ) : null}
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

      <div className={remembered ? "badge badge--accent" : "muted small"}>
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
      await apiPost(API_PATHS.memories.create, {
        userId: targetUserId,
        scope: "assistant-demo",
        text,
      });
      const retrieval = await apiPost<{ context_text?: string }>(API_PATHS.context.resolve, {
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
      const res = await apiPost<{ context_text?: string }>(API_PATHS.context.resolve, {
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
      await apiPost(API_PATHS.memories.create, {
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
      <div className="mb-sm">
        <span className="badge badge--accent">Example</span>
      </div>
      <DashboardSessionAuthNote variant="writes" />
      {message ? (
        <div
          className={`alert ${
            /Enter |cannot be empty/i.test(message)
              ? "alert--warning"
              : /Memory saved|Recall completed|Memory updated|^Memory deleted/i.test(message)
                ? "alert--success"
                : "alert--error"
          }`}
          role="status"
        >
          {message}
        </div>
      ) : null}
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
        <BillingUsageView workspaceId={workspaceId} embedded />
      ) : (
        <EmptyState title="No usage yet" subtitle="Usage events appear here once your app starts making API calls." />
      )}
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
      const res = await apiGet<{ settings: ConnectorSettingRow[] }>(API_PATHS.connectors.settings);
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
      const saved = await apiPatch<ConnectorSettingRow>(API_PATHS.connectors.settings, {
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
      {message ? (
        <div className="alert" role="status">
          {message}
        </div>
      ) : null}
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

