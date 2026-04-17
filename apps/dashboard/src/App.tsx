import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { ApiKeyRow, InviteRow, MemoryRow, UsageRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import { apiEnvError, apiGet, apiPost, ensureDashboardSession, dashboardLogout, setOnUnauthorized, userFacingErrorMessage } from "./apiClient";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "./memorySearch";

type Tab =
  | "overview"
  | "memories"
  | "usage"
  | "import"
  | "api_keys"
  | "mcp"
  | "team"
  | "billing";

const tabsRequiringWorkspace: Tab[] = ["memories", "usage", "import", "api_keys", "team", "billing"];

type SidebarNavEntry = { tab: Tab; label: string; showLock?: boolean };

type SidebarGroup = { section: string; entries: SidebarNavEntry[] };

const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    section: "Build",
    entries: [
      { tab: "overview", label: "Overview" },
      { tab: "memories", label: "Memories" },
      { tab: "usage", label: "Usage" },
      { tab: "import", label: "Import (Paid)" },
      { tab: "api_keys", label: "API Access" },
      { tab: "mcp", label: "MCP" },
    ],
  },
  {
    section: "Account",
    entries: [
      { tab: "team", label: "Team" },
      { tab: "billing", label: "Billing" },
    ],
  },
];

const SIDEBAR_COMMANDS: Array<{ tab: Tab; label: string; section: string }> = SIDEBAR_GROUPS.flatMap((g) =>
  g.entries.map((e) => ({ tab: e.tab, label: e.label, section: g.section })),
);

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
  void fetch("http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "aa3f1d" },
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
          setAlert("We selected your latest workspace so you can continue.");
          return;
        }

        const { data: created, error: createError } = await supabase.rpc("create_workspace", { p_name: "My Workspace" });
        if (createError) throw createError;
        const createdWorkspaceId = (created?.[0] as { workspace_id?: string } | undefined)?.workspace_id?.trim() ?? "";
        if (!createdWorkspaceId || cancelled) return;
        setWorkspaceId(createdWorkspaceId);
        persistWorkspaceId(createdWorkspaceId);
        setAlert("Your first workspace is ready. You're good to go.");
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
      setSessionError("Session expired or access denied. Please sign in again or select workspace.");
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

  const onboardingSteps = useMemo(
    () => [
      { key: "workspace", label: "Pick your workspace", done: workspaceReady },
      { key: "workspace-bind", label: "Connect this browser", done: Boolean(workspaceClaim?.trim() || workspaceId.trim()) },
      { key: "api-key", label: "Create your first API key", done: firstApiKeyCreated },
      { key: "team", label: "Invite a teammate (optional)", done: false },
    ],
    [workspaceReady, workspaceClaim, workspaceId, firstApiKeyCreated],
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
    if (!q) return SIDEBAR_COMMANDS;
    return SIDEBAR_COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q) ||
        `${c.section} ${c.label}`.toLowerCase().includes(q),
    );
  }, [paletteQuery]);

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
      setCelebrationMessage("Great job - your workspace is live. Your first API key is ready.");
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
                      title={locked ? "Finish workspace setup to open this page." : c.label}
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
          {SIDEBAR_GROUPS.map((g) => (
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
                      title={locked ? "Finish workspace setup to open this section." : entry.label}
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
              {workspaceReady
                ? "Workspace connected"
                : "Finish setup below to unlock all sections"}
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
                  <span>Workspace ID (optional)</span>
                  <input
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    placeholder="Paste an existing workspace ID"
                  />
                </label>
                <div className="row">
                  <button type="button" onClick={saveWorkspaceId} disabled={!workspaceId || workspaceSaving}>
                    {workspaceSaving ? "Connecting…" : "Connect workspace"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setWorkspaceId(loadWorkspaceId())}>
                    Use last saved workspace
                  </button>
                </div>
                {alert && <div className="badge">{alert}</div>}
                <div className="muted small">Current workspace: {workspaceClaim || workspaceId || "Not selected yet"}</div>
                {workspaceReady && (
                  <details className="console-advanced-details">
                    <summary className="muted small">Advanced details</summary>
                    <div className="muted small mt-sm">Workspace ID: {effectiveWorkspaceId}</div>
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
                  onQuickSetup={() => {
                    setOnboardingCollapsed(false);
                    selectTab("team");
                  }}
                />
              )}
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
              {tab === "team" && (
                <WorkspacesView
                  workspaceId={workspaceClaim || workspaceId}
                  sessionUserId={session.user.id}
                  onSelectWorkspace={(id) => {
                    setWorkspaceId(id);
                    persistWorkspaceId(id);
                    setAlert("Workspace selected. Click Connect workspace to finish.");
                  }}
                />
              )}
              {tab === "billing" && <BillingConsoleView workspaceId={effectiveWorkspaceId} />}
            </div>
          </ErrorBoundary>
        </div>
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
            <h1>Your AI memory layer awaits</h1>
            <p className="muted">Sign in to continue building context-aware products with persistent memory.</p>
            <AuthPanel />
            <p className="auth-terms muted small">By continuing, you agree to our Terms and Privacy Policy.</p>
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
  onQuickSetup,
}: {
  workspaceReady: boolean;
  sessionReady: boolean;
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
      label: "Documents",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.documents ?? 0),
    },
    {
      label: "Memories",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.memories ?? 0),
    },
    {
      label: "Search Requests",
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
          ? " — set a workspace to load live numbers."
          : " — numbers update for this selected time range."}
      </p>
      {error && (
        <div className="badge" role="alert">
          {error}
        </div>
      )}
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
          <span className="explore-tile-title">Live demo</span>
          <span className="explore-tile-desc muted small">See MemoryNode in action in the quickstart.</span>
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

function RequestsView({ workspaceId }: { workspaceId: string }) {
  return (
    <Panel title="Usage">
      {workspaceId ? (
        <UsageView workspaceId={workspaceId} embedded />
      ) : (
        <EmptyState title="No requests yet" subtitle="API requests will appear here once you start making calls." />
      )}
    </Panel>
  );
}

function ImportView({ isPaid }: { isPaid: boolean }) {
  const [url, setUrl] = useState("");
  const [tag, setTag] = useState("");
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
      <div className="dropzone muted small">Drop files here or click to browse (TXT, PDF, PNG, JPG, MP4)</div>
      <label className="field">
        <span>Add URL</span>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" />
          <button className="ghost" disabled={!url.trim() || !isPaid}>Add</button>
        </div>
      </label>
      <label className="field">
        <span>Container Tag (optional)</span>
        <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Search or create tags..." />
      </label>
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

function McpView() {
  return (
    <Panel title="MCP Setup">
      <div className="muted small">Connect your agent host to MemoryNode with the official MCP server.</div>
      <code className="code-block">pnpm add @memorynodeai/mcp-server</code>
      <div className="muted small">Required env vars:</div>
      <code className="code-block">MEMORYNODE_API_KEY=mn_live_xxx{"\n"}MEMORYNODE_BASE_URL=https://api.memorynode.ai{"\n"}MEMORYNODE_USER_ID=user-123{"\n"}MEMORYNODE_NAMESPACE=default</code>
      <a className="ghost" href="https://docs.memorynode.ai/quickstart" target="_blank" rel="noopener noreferrer">
        Open quickstart
      </a>
    </Panel>
  );
}

function BillingConsoleView({ workspaceId }: { workspaceId: string }) {
  const [billTab, setBillTab] = useState<"plans" | "usage" | "invoices">("plans");
  return (
    <Panel title="Billing">
      <nav className="tabs">
        <button className={billTab === "plans" ? "tab active" : "tab"} onClick={() => setBillTab("plans")}>Plans</button>
        <button className={billTab === "usage" ? "tab active" : "tab"} onClick={() => setBillTab("usage")}>Usage</button>
        <button className={billTab === "invoices" ? "tab active" : "tab"} onClick={() => setBillTab("invoices")}>Invoices</button>
      </nav>
      {billTab === "plans" && <PlansView workspaceId={workspaceId} />}
      {billTab === "usage" && <UsageView workspaceId={workspaceId} embedded />}
      {billTab === "invoices" && <InvoicesView />}
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
      {!workspaceId && <div className="badge">Set your workspace first to checkout a plan.</div>}
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

function InvoicesView() {
  return <EmptyState title="No invoices yet" subtitle="Invoices appear here once you have an active paid subscription." />;
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
    <Panel title="Workspace & Team">
      <p className="muted small">
        Create a workspace or pick one you already belong to.
      </p>
      <div className="row">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New workspace name" />
        <button onClick={create} disabled={!newName.trim()}>
          Create workspace
        </button>
      </div>
      {!hasWorkspaceSwitcher && list.length === 1 && (
        <div className="muted small">You have one workspace. Create another only if you need separate teams or environments.</div>
      )}
      {hasWorkspaceSwitcher && <div className="muted small">Switching appears because you now have multiple workspaces.</div>}
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
                  <div className="muted small mt-sm">Workspace ID: {w.id}</div>
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
                  Use this workspace
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <MembersView workspaceId={workspaceId} currentUserId={sessionUserId} />
    </Panel>
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
    <Panel title="API Access">
      {!workspaceId && <div className="muted small">Connect a workspace to load keys.</div>}
      <div className="muted small">Create an access key for your app. You can revoke keys anytime.</div>
      <div className="row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (for example, production-app)"
        />
        <button disabled={!workspaceId || !newName.trim() || creating} onClick={createKey}>
          {creating ? "Creating…" : "Create access key"}
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

  if (!workspaceId?.trim()) {
    return (
      <Panel title="Memory Browser">
        <div className="badge">Set your workspace first to search and open memories.</div>
        <div className="muted small">Tip: Choose a workspace in the Workspaces tab, then click Set Workspace.</div>
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
          filters?: SearchFilters;
        } = {
          user_id: userId,
          namespace: namespace || undefined,
          query: queryValue,
          page: pageToUse,
          page_size: pageSize,
        };
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
      const mappedRows = mapSearchResultsToRows(res.results ?? []);
      setRows((prev) => (resetPage ? mappedRows : [...prev, ...mappedRows]));
      setTotal(res.total ?? null);
      setHasMore(res.has_more ?? false);
      onSearchCompleted();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = () => {
    void search(false, page + 1);
  };

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
        <button onClick={() => search(true)} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        <button className="ghost" onClick={() => { setRows([]); setTotal(null); setHasMore(false); }}>
          Clear
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
            </div>
            <p>{r.text.slice(0, 240)}</p>
          </div>
        ))}
      </div>
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
    return embedded ? <div className="badge">Set your workspace first to view usage and limits.</div> : (
      <Panel title="Usage">
        <div className="badge">Set your workspace first to view usage and limits.</div>
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
          <div className="card">
            <div className="row-space">
              <strong>{usage.day}</strong>
              {usage.plan && <span className="badge">{usage.plan}</span>}
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

function BillingView({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<{
    plan: string;
    plan_status: string;
    effective_plan: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(() => {
    const qs = new URLSearchParams(window.location.search);
    const flag = qs.get("status");
    if (flag === "success") return "Payment successful. Refreshing status…";
    if (flag === "canceled") return "Checkout canceled";
    return null;
  });

  if (!workspaceId?.trim()) {
    return (
      <div className="stack mt-lg">
        <div className="badge">Set your workspace first to load billing status and checkout options.</div>
      </div>
    );
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{
        plan: string;
        plan_status: string;
        effective_plan: string;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
      }>("/v1/billing/status");
      setStatus(res);
      setBanner(null);
    } catch (err) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const openCheckout = async () => {
    setError(null);
    try {
      const res = await apiPost<{
        url: string;
        method?: string;
        fields?: Record<string, string>;
      }>("/v1/billing/checkout", {});

      if ((res.method ?? "GET").toUpperCase() === "POST" && res.fields && Object.keys(res.fields).length > 0) {
        const target = window.open("", "_blank", "noopener");
        if (!target) {
          setError("Popup blocked by browser. Allow popups and try again.");
          return;
        }
        const html = `<!doctype html><html><body><form id="payu-form" method="POST" action="${res.url}">
${Object.entries(res.fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}" />`)
    .join("\n")}
</form><script>document.getElementById("payu-form").submit();</script></body></html>`;
        target.document.write(html);
        target.document.close();
      } else {
        window.open(res.url, "_blank", "noopener");
      }
    } catch (err) {
      setError(userFacingErrorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const renewal =
    status?.current_period_end != null
      ? new Date(status.current_period_end).toLocaleString()
      : "not set";

  return (
    <div className="stack mt-lg">
      {banner && <div className="badge">{banner}</div>}
      {error && <div className="badge">{error}</div>}
      <div className="row-space">
        <div>
          <div className="muted small">Plan</div>
          <div className="badge">{status?.effective_plan ?? status?.plan ?? "launch"}</div>
        </div>
        <div>
          <div className="muted small">Status</div>
          <div>{status?.plan_status ?? "unknown"}</div>
        </div>
        <div>
          <div className="muted small">Renews</div>
          <div>{renewal}</div>
        </div>
      </div>
      <div className="row">
        <button onClick={openCheckout} disabled={loading}>
          Upgrade plan (PayU)
        </button>
        <button className="ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
    </div>
  );
}

function _SettingsView({ session, workspaceId }: { session: Session; workspaceId: string }) {
  return (
    <Panel title="Settings">
      <div className="muted small">User ID: {session.user.id}</div>
      <div className="muted small">Role: {session.user.role}</div>
      <div className="muted small">Issued: {new Date(session.user.created_at).toLocaleString()}</div>
      <details>
        <summary className="muted small">Developer details</summary>
        <div className="muted small mt-sm">
          Claims: <code>{JSON.stringify(session.user.user_metadata)}</code>
        </div>
      </details>
      <BillingView workspaceId={workspaceId} />
    </Panel>
  );
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
