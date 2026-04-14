import { Component, useCallback, useEffect, useMemo, useState } from "react";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { ApiKeyRow, InviteRow, MemoryRow, UsageRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import { apiEnvError, apiGet, apiPost, ensureDashboardSession, dashboardLogout, setOnUnauthorized, userFacingErrorMessage } from "./apiClient";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "./memorySearch";

type Tab =
  | "overview"
  | "documents"
  | "container_tags"
  | "requests"
  | "insights"
  | "import"
  | "api_keys"
  | "agents"
  | "plugins"
  | "team"
  | "billing";

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "documents", label: "Documents" },
  { key: "container_tags", label: "Container Tags" },
  { key: "requests", label: "Requests" },
  { key: "insights", label: "User Insights" },
  { key: "import", label: "Import" },
  { key: "api_keys", label: "API Keys" },
  { key: "agents", label: "Agents" },
  { key: "plugins", label: "Plugins" },
  { key: "team", label: "Team" },
  { key: "billing", label: "Billing" },
];
const tabsRequiringWorkspace: Tab[] = ["documents", "container_tags", "requests", "import", "api_keys", "team", "billing"];

const activationEvents: Array<{ key: string; label: string }> = [
  { key: "api_key_created", label: "API key created" },
  { key: "first_ingest_success", label: "First ingest success" },
  { key: "first_search_success", label: "First search success" },
  { key: "first_context_success", label: "First context success" },
  { key: "cap_exceeded", label: "Cap exceeded" },
  { key: "checkout_started", label: "Checkout started" },
  { key: "upgrade_activated", label: "Upgrade activated" },
];

function seatCapForPlan(planCode: string | null | undefined): number {
  const normalized = (planCode ?? "free").toLowerCase();
  if (normalized === "launch" || normalized === "build" || normalized === "free" || normalized === "pro" || normalized === "solo") {
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
    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
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

  useEffect(() => {
    if (!session?.access_token || !effectiveWorkspaceId?.trim()) {
      setSessionReady(false);
      return;
    }
    let cancelled = false;
    setSessionError(null);
    // #region agent log
    fetch('http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aa3f1d'},body:JSON.stringify({sessionId:'aa3f1d',runId:'pre-fix',hypothesisId:'H4',location:'apps/dashboard/src/App.tsx:134',message:'ensureDashboardSession start',data:{hasAccessToken:Boolean(session?.access_token),workspaceIdLength:effectiveWorkspaceId.trim().length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    ensureDashboardSession(session.access_token, effectiveWorkspaceId)
      .then(() => {
        // #region agent log
        fetch('http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aa3f1d'},body:JSON.stringify({sessionId:'aa3f1d',runId:'pre-fix',hypothesisId:'H4',location:'apps/dashboard/src/App.tsx:138',message:'ensureDashboardSession success',data:{workspaceIdLength:effectiveWorkspaceId.trim().length},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!cancelled) setSessionReady(true);
      })
      .catch((err: unknown) => {
        // #region agent log
        fetch('http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aa3f1d'},body:JSON.stringify({sessionId:'aa3f1d',runId:'pre-fix',hypothesisId:'H4',location:'apps/dashboard/src/App.tsx:143',message:'ensureDashboardSession failed',data:{errorMessage:err instanceof Error?err.message:String(err)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!cancelled) {
          setSessionReady(false);
          setSessionError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session?.access_token, effectiveWorkspaceId]);

  useEffect(() => {
    setOnUnauthorized(() => {
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
      setAlert("Workspace is set. Your dashboard tabs are now fully active.");
    }
    setWorkspaceSaving(false);
  };

  const onboardingSteps = useMemo(
    () => [
      { key: "workspace", label: "Create or select a workspace", done: workspaceReady },
      { key: "workspace-bind", label: "Set workspace in your session", done: Boolean(workspaceClaim?.trim()) },
      { key: "api-key", label: "Create your first API key", done: firstApiKeyCreated },
      { key: "team", label: "Invite your team member(s)", done: false },
    ],
    [workspaceReady, workspaceClaim, firstApiKeyCreated],
  );
  const completedSteps = onboardingSteps.filter((step) => step.done).length;

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

  return (
    <Shell>
      <header className="topbar">
        <div>
          <div className="logo">MemoryNode Console</div>
          <div className="muted small">Signed in as {userEmail}</div>
        </div>
        <div className="top-actions">
          <a
            href="https://docs.memorynode.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="muted small"
          >
            DOCS
          </a>
          <a
            href="https://support.memorynode.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="muted small"
          >
            SUPPORT
          </a>
          <button className="ghost" onClick={async () => { await dashboardLogout(); await supabase.auth.signOut(); }}>
            Sign out
          </button>
        </div>
      </header>

      {celebrationMessage && (
        <div className="celebration-toast" role="status" aria-live="polite">
          <strong>Milestone unlocked</strong>
          <span>{celebrationMessage}</span>
          <button className="ghost" onClick={() => setCelebrationMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      <Panel title="Quick setup">
        <div className="row-space">
          <div className="muted small">Select a workspace once to unlock console modules.</div>
          <span className="badge">
            {completedSteps}/{onboardingSteps.length} complete
          </span>
        </div>
        <label className="field">
          <span>Workspace ID</span>
          <input
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            placeholder="UUID"
          />
        </label>
        <div className="row">
          <button onClick={saveWorkspaceId} disabled={!workspaceId || workspaceSaving}>
            {workspaceSaving ? "Setting workspace…" : "Set Workspace"}
          </button>
          <button className="ghost" onClick={() => setWorkspaceId(loadWorkspaceId())}>
            Use Last Workspace
          </button>
        </div>
        {alert && <div className="badge">{alert}</div>}
        <div className="muted small">Current workspace: {workspaceClaim || "No workspace selected yet"}</div>
      </Panel>

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab active" : "tab"}
            disabled={!workspaceReady && tabsRequiringWorkspace.includes(t.key)}
            onClick={() => setTab(t.key)}
            title={!workspaceReady && tabsRequiringWorkspace.includes(t.key) ? "Set your workspace first to unlock this tab." : t.label}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <ErrorBoundary onBack={() => setTab("overview")}>
      <div className="grid">
        {tab === "overview" && (
          <OverviewView />
        )}
        {tab === "documents" && (
          <DocumentsView />
        )}
        {tab === "container_tags" && (
          <ContainerTagsView />
        )}
        {tab === "requests" && (
          <RequestsView workspaceId={effectiveWorkspaceId} />
        )}
        {tab === "insights" && (
          <InsightsView />
        )}
        {tab === "import" && (
          <ImportView />
        )}
        {tab === "api_keys" && (
          <ApiKeysView
            workspaceId={workspaceClaim || workspaceId}
            onApiKeyCreated={() => {
              if (!firstApiKeyCreated) setFirstApiKeyCreated(true);
            }}
          />
        )}
        {tab === "agents" && (
          <AgentsView />
        )}
        {tab === "plugins" && (
          <PluginsView />
        )}
        {tab === "team" && (
          <WorkspacesView
            workspaceId={workspaceClaim || workspaceId}
            sessionUserId={session.user.id}
            onSelectWorkspace={(id) => {
              setWorkspaceId(id);
              persistWorkspaceId(id);
              setAlert("Workspace selected. Click Set Workspace to activate console sections.");
            }}
          />
        )}
        {tab === "billing" && <BillingConsoleView workspaceId={effectiveWorkspaceId} />}
      </div>
      </ErrorBoundary>
    </Shell>
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
  const showcaseCompanies = ["Nexora", "Bluepine", "Aptly", "Composio", "Pocket", "Cluely"];
  return (
    <div className="auth-layout">
      <section className="auth-left">
        <div className="auth-card">
          <h1>Your memory layer awaits</h1>
          <p className="muted">Sign in or create an account to get started.</p>
          <AuthPanel />
          <p className="auth-terms muted small">By continuing, you agree to our Terms and Privacy Policy.</p>
        </div>
      </section>
      <section className="auth-right">
        <div className="auth-image" />
        <div className="auth-brands">
          <div className="auth-brands-title">USED BY COMPANIES YOU (AND WE) LOVE</div>
          <div className="brand-grid">
            {showcaseCompanies.map((company) => (
              <div key={company} className="brand-pill">
                {company}
              </div>
            ))}
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

function OverviewView() {
  const cards = [
    { label: "Documents", value: "0" },
    { label: "Memories", value: "0" },
    { label: "Search Requests", value: "0" },
    { label: "Container Tags", value: "0" },
    { label: "Connectors", value: "0" },
  ];

  return (
    <Panel title="Overview">
      <div className="overview-cards">
        {cards.map((card) => (
          <div key={card.label} className="metric-card">
            <div className="muted small">{card.label}</div>
            <div className="metric-value">{card.value}</div>
          </div>
        ))}
      </div>
      <div className="overview-quick-links">
        <a className="card muted small" href="https://docs.memorynode.ai" target="_blank" rel="noopener noreferrer">
          Documentation
        </a>
        <a className="card muted small" href="https://docs.memorynode.ai/quickstart" target="_blank" rel="noopener noreferrer">
          Quick Setup
        </a>
        <a className="card muted small" href="https://docs.memorynode.ai/playground" target="_blank" rel="noopener noreferrer">
          Playground
        </a>
      </div>
    </Panel>
  );
}

function DocumentsView() {
  return (
    <Panel title="Documents">
      <EmptyState title="No documents yet" subtitle="Import data or add documents via the API to get started." />
    </Panel>
  );
}

function ContainerTagsView() {
  return (
    <Panel title="Container Tags">
      <EmptyState title="No container tags yet" subtitle="Import data or add documents via the API to get started." />
    </Panel>
  );
}

function RequestsView({ workspaceId }: { workspaceId: string }) {
  return (
    <Panel title="Requests">
      <div className="row">
        <button className="tab active">30d</button>
        <button className="tab">All</button>
      </div>
      {workspaceId ? (
        <UsageView workspaceId={workspaceId} embedded />
      ) : (
        <EmptyState title="No requests yet" subtitle="API requests will appear here once you start making calls." />
      )}
    </Panel>
  );
}

function InsightsView() {
  return (
    <Panel title="User Insights">
      <EmptyState title="Available on Scale" subtitle="Upgrade in Billing to unlock AI-powered user insights." />
      <button>Upgrade</button>
    </Panel>
  );
}

function ImportView() {
  const [url, setUrl] = useState("");
  const [tag, setTag] = useState("");

  return (
    <Panel title="Import">
      <div className="dropzone muted small">Drop files here or click to browse (TXT, PDF, PNG, JPG, MP4)</div>
      <label className="field">
        <span>Add URL</span>
        <div className="row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" />
          <button className="ghost" disabled={!url.trim()}>Add</button>
        </div>
      </label>
      <label className="field">
        <span>Container Tag (optional)</span>
        <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Search or create tags…" />
      </label>
      <button disabled>Import 0 items</button>
    </Panel>
  );
}

function AgentsView() {
  return (
    <Panel title="Agents">
      <EmptyState title="No agents connected" subtitle="Install the CLI and run login to connect an agent." />
    </Panel>
  );
}

function PluginsView() {
  return (
    <Panel title="Plugins">
      <EmptyState title="Plugins require paid plan" subtitle="Connect external tools to enhance your workflow." />
      <button>Upgrade</button>
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
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const magic = async () => {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    setMessage(error ? error.message : "Magic link sent (check your inbox)");
  };

  const github = async () => {
    await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo: window.location.origin } });
  };

  const google = async () => {
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  };

  return (
    <div className="auth-form">
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" />
      <button className="auth-provider-btn auth-magic-btn" onClick={magic} disabled={!email || busy}>
        <span className="provider-icon" aria-hidden="true">
          <MagicLinkIcon />
        </span>
        {busy ? "Sending magic link..." : "Send magic link"}
      </button>
      <div className="auth-divider">OR</div>
      <button className="auth-provider-btn auth-google-btn" onClick={google}>
        <span className="provider-icon" aria-hidden="true">
          <GoogleIcon />
        </span>
        Continue with Google
      </button>
      <button className="auth-provider-btn auth-github-btn" onClick={github}>
        <span className="provider-icon" aria-hidden="true">
          <GitHubIcon />
        </span>
        Continue with GitHub
      </button>
      {message && <div className="badge">{message}</div>}
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
    <Panel title="Workspaces">
      <p className="muted small">
        Creation and listing are RLS-safe: membership is required. New workspaces automatically add you as <b>owner</b>.
      </p>
      <div className="row">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New workspace name" />
        <button onClick={create} disabled={!newName.trim()}>
          Create workspace
        </button>
      </div>
      {loading && <div>Loading…</div>}
      {error && <div className="badge">{error}</div>}
      <ul className="list">
        {list.map((w) => (
          <li key={w.id} className="card">
            <div className="row-space">
              <div>
                <strong>{w.name}</strong>
                <div className="muted small">{w.id}</div>
              </div>
              <div className="row">
                <span className="badge">{w.role}</span>
                <button className="ghost" onClick={() => {
                  // #region agent log
                  fetch('http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aa3f1d'},body:JSON.stringify({sessionId:'aa3f1d',runId:'pre-fix',hypothesisId:'H1',location:'apps/dashboard/src/App.tsx:425',message:'set workspace clicked',data:{selectedWorkspaceId:w.id,currentWorkspaceId:workspaceId},timestamp:Date.now()})}).catch(()=>{});
                  // #endregion
                  onSelectWorkspace(w.id);
                }}>
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
    <Panel title="API Keys">
      {!workspaceId && <div className="muted small">Set a workspace to load keys.</div>}
      <div className="row">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Key name (e.g., cli-dev)"
        />
        <button disabled={!workspaceId || !newName.trim() || creating} onClick={createKey}>
          {creating ? "Creating…" : "Create key"}
        </button>
      </div>
      {loading && <div>Loading…</div>}
      {error && <div className="badge">{error}</div>}
      {!loading && keys.length === 0 && <div className="muted small">No keys found.</div>}
      <ul className="list">
        {keys.map((k) => (
          <li key={k.id} className="card">
            <div className="row-space">
              <div>
                <strong>{k.name}</strong>{" "}
                <span className="muted small">
                  {k.key_prefix ?? "mn_live"}…{k.key_last4 ?? "****"}
                </span>
                <div className="muted small">Created {new Date(k.created_at).toLocaleString()}</div>
                {k.last_used_at && (
                  <div className="muted small">
                    Last used {new Date(k.last_used_at).toLocaleString()}
                    {k.last_used_ip ? ` from ${k.last_used_ip}` : ""}
                  </div>
                )}
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
            <h3>Save your API key</h3>
            <p className="muted small">This is shown only once. Copy and store it securely.</p>
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

function MemoryView({
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
          query: query || "",
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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

function RetrievalView({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  const [evalSets, setEvalSets] = useState<Array<{ id: string; name: string; created_at: string }>>([]);
  const [history, setHistory] = useState<Array<{ id: string; query: string; created_at: string }>>([]);
  const [newEvalName, setNewEvalName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<{ summary: { avg_precision_at_k: number; avg_recall: number }; count: number } | null>(null);
  const [replayResult, setReplayResult] = useState<{ previous: { total: number }; current: { total: number } } | null>(null);
  const [runningEvalId, setRunningEvalId] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);

  if (!workspaceId?.trim()) {
    return (
      <Panel title="Retrieval Quality">
        <div className="badge">Set your workspace first to use eval sets and replay history.</div>
        <div className="muted small">After setting a workspace, run a search and enable “Save to history”.</div>
      </Panel>
    );
  }

  const loadEvalSets = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ eval_sets: Array<{ id: string; name: string; created_at: string }> }>("/v1/eval/sets");
      setEvalSets(res.eval_sets ?? []);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ history: Array<{ id: string; query: string; created_at: string }> }>("/v1/search/history?limit=20");
      setHistory(res.history ?? []);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const createEvalSet = async () => {
    if (!newEvalName.trim()) return;
    setError(null);
    try {
      await apiPost("/v1/eval/sets", { name: newEvalName.trim() });
      setNewEvalName("");
      loadEvalSets();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    }
  };

  const runEval = async (evalSetId: string) => {
    setRunningEvalId(evalSetId);
    setEvalResult(null);
    setError(null);
    try {
      const res = await apiPost<{ summary: { avg_precision_at_k: number; avg_recall: number; count: number }; items?: unknown[] }>(
        "/v1/eval/run",
        { eval_set_id: evalSetId, user_id: userId },
      );
      setEvalResult({
        summary: res.summary,
        count: res.summary?.count ?? (res.items?.length ?? 0),
      });
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setRunningEvalId(null);
    }
  };

  const replay = async (queryId: string) => {
    setReplayingId(queryId);
    setReplayResult(null);
    setError(null);
    try {
      const res = await apiPost<{ previous: { total: number }; current: { total: number } }>("/v1/search/replay", {
        query_id: queryId,
      });
      setReplayResult({ previous: res.previous ?? { total: 0 }, current: res.current ?? { total: 0 } });
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setReplayingId(null);
    }
  };

  useEffect(() => {
    void loadEvalSets();
    void loadHistory();
  }, []);

  return (
    <Panel title="Retrieval Quality (Phase 5)">
      <p className="muted small">
        Eval sets and search history. Use Memory Browser with <code>X-Save-History: true</code> to save searches for replay. See{" "}
        docs/RETRIEVAL_COCKPIT_DEMO.md
        .
      </p>
      {error && (
        <div className="badge">
          {error}
          <button className="ghost" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <h4>Eval sets</h4>
      <div className="row">
        <input value={newEvalName} onChange={(e) => setNewEvalName(e.target.value)} placeholder="New eval set name" />
        <button onClick={createEvalSet} disabled={!newEvalName.trim()}>
          Create
        </button>
      </div>
      <ul className="list">
        {evalSets.map((s) => (
          <li key={s.id} className="card">
            <div className="row-space">
              <div>
                <strong>{s.name}</strong>
                <div className="muted small">{new Date(s.created_at).toLocaleString()}</div>
              </div>
              <button onClick={() => runEval(s.id)} disabled={!!runningEvalId}>
                {runningEvalId === s.id ? "Running…" : "Run eval"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {evalResult && (
        <div className="badge">
          Avg precision@k: {evalResult.summary.avg_precision_at_k.toFixed(3)} · Avg recall: {evalResult.summary.avg_recall.toFixed(3)} · Items: {evalResult.count}
        </div>
      )}

      <h4>Search history</h4>
      <button className="ghost" onClick={loadHistory} disabled={loading}>
        Refresh
      </button>
      <ul className="list">
        {history.map((h) => (
          <li key={h.id} className="card">
            <div className="row-space">
              <div>
                <div className="muted small">{h.query.slice(0, 80)}{h.query.length > 80 ? "…" : ""}</div>
                <div className="muted small">{new Date(h.created_at).toLocaleString()}</div>
              </div>
              <button onClick={() => replay(h.id)} disabled={!!replayingId}>
                {replayingId === h.id ? "Replaying…" : "Replay"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {history.length === 0 && !loading && <div className="muted small">No saved searches. Add X-Save-History: true to search requests.</div>}
      {replayResult && (
        <div className="badge">
          Previous: {replayResult.previous.total} results · Current: {replayResult.current.total} results
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
  }, []);

  const content = (
    <>
      <div className="muted small">Using session (workspace-scoped).</div>
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
          </div>
        </div>
      )}
      {!loading && !usage && !error && <div className="muted small">No usage yet.</div>}
    </>
  );
  return embedded ? content : <Panel title="Usage">{content}</Panel>;
}

function ActivationView({ workspaceId }: { workspaceId: string }) {
  const [range, setRange] = useState<"24h" | "7d">("24h");
  const [rows, setRows] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setRows({});
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const days = range === "24h" ? 1 : 7;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("activation_counts", { p_workspace_id: workspaceId, p_days: days });
        if (error) {
          setError(error.message);
          setRows({});
          return;
        }
        const map: Record<string, number> = {};
        (data as Array<{ event_name: string; count: number }> | null)?.forEach((row) => {
          map[row.event_name] = Number(row.count ?? 0);
        });
        setRows(map);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setRows({});
      } finally {
        setLoading(false);
      }
    })();
  }, [workspaceId, range]);

  return (
    <Panel title="Activation (workspace-scoped)">
      {!workspaceId && <div className="muted small">Select a workspace to see activation signals.</div>}
      {workspaceId && (
        <>
          <div className="row">
            <button className={range === "24h" ? "tab active" : "tab"} onClick={() => setRange("24h")}>
              Last 24h
            </button>
            <button className={range === "7d" ? "tab active" : "tab"} onClick={() => setRange("7d")}>
              Last 7d
            </button>
          </div>
          {loading && <div>Loading…</div>}
          {error && <div className="badge">{error}</div>}
          <ul className="list">
            {activationEvents.map((evt) => (
              <li key={evt.key} className="row-space card">
                <div>
                  <strong>{evt.label}</strong>
                  <div className="muted small">{evt.key}</div>
                </div>
                <div className="badge">{rows[evt.key] ?? 0}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
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
          <div className="badge">{status?.effective_plan ?? status?.plan ?? "free"}</div>
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

function SettingsView({ session, workspaceId }: { session: Session; workspaceId: string }) {
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
        // #region agent log
        fetch('http://127.0.0.1:7420/ingest/253793e2-9a0d-4620-b251-39382727da68',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'aa3f1d'},body:JSON.stringify({sessionId:'aa3f1d',runId:'pre-fix',hypothesisId:'H2',location:'apps/dashboard/src/App.tsx:1198',message:'members and invites query settled',data:{memberError:mem.error?.message??null,inviteError:inv.error?.message??null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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
      const plan = billing.effective_plan ?? billing.plan ?? "free";
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
