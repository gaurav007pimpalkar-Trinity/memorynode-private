import { Component, useCallback, useEffect, useMemo, useState } from "react";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { ApiKeyRow, InviteRow, MemoryRow, UsageRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import { apiEnvError, apiGet, apiPost, ensureDashboardSession, dashboardLogout, setOnUnauthorized, userFacingErrorMessage } from "./apiClient";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "./memorySearch";

type Tab = "workspaces" | "keys" | "memories" | "usage" | "retrieval" | "activation" | "settings";

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "workspaces", label: "Workspaces" },
  { key: "keys", label: "API Keys" },
  { key: "memories", label: "Memory Browser" },
  { key: "usage", label: "Usage" },
  { key: "retrieval", label: "Retrieval" },
  { key: "activation", label: "Activation" },
  { key: "settings", label: "Settings" },
];
const tabsRequiringWorkspace: Tab[] = ["keys", "memories", "usage", "retrieval", "activation"];

const activationEvents: Array<{ key: string; label: string }> = [
  { key: "api_key_created", label: "API key created" },
  { key: "first_ingest_success", label: "First ingest success" },
  { key: "first_search_success", label: "First search success" },
  { key: "first_context_success", label: "First context success" },
  { key: "cap_exceeded", label: "Cap exceeded" },
  { key: "checkout_started", label: "Checkout started" },
  { key: "upgrade_activated", label: "Upgrade activated" },
];

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
  const [tab, setTab] = useState<Tab>("workspaces");
  const [workspaceId, setWorkspaceId] = useState(() => loadWorkspaceId());
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [firstApiKeyCreated, setFirstApiKeyCreated] = useState(false);
  const [firstSearchCompleted, setFirstSearchCompleted] = useState(false);
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
      { key: "search", label: "Run your first memory search", done: firstSearchCompleted },
    ],
    [workspaceReady, workspaceClaim, firstApiKeyCreated, firstSearchCompleted],
  );
  const completedSteps = onboardingSteps.filter((step) => step.done).length;

  useEffect(() => {
    if (celebrationShown) return;
    if (firstApiKeyCreated && firstSearchCompleted) {
      setCelebrationShown(true);
      setCelebrationMessage("Great job - your workspace is live. You created an API key and completed your first memory search.");
    }
  }, [firstApiKeyCreated, firstSearchCompleted, celebrationShown]);

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
    return (
      <Shell>
        <Panel title="Sign in">
          <AuthPanel />
        </Panel>
      </Shell>
    );
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
          <div className="logo">MemoryNode Dashboard</div>
          <div className="muted small">Signed in as {userEmail}</div>
        </div>
        <div className="top-actions">
          <a
            href="https://github.com/gaurav007pimpalkar-Trinity/memorynode"
            target="_blank"
            rel="noopener noreferrer"
            className="muted small"
          >
            Get started with the MemoryNode SDK
          </a>
          <span className="muted small">Session active</span>
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

      <Panel title="Getting started">
        <div className="row-space">
          <div className="muted small">Follow these steps to unlock the full dashboard experience.</div>
          <span className="badge">
            {completedSteps}/{onboardingSteps.length} complete
          </span>
        </div>
        <div className="list">
          {onboardingSteps.map((step, index) => (
            <div key={step.key} className={step.done ? "card onboarding-step done" : "card onboarding-step"}>
              <div className="row-space">
                <strong>
                  {step.done ? "✓" : index + 1}. {step.label}
                </strong>
                <span className="muted small">{step.done ? "Done" : "Pending"}</span>
              </div>
            </div>
          ))}
        </div>
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

      <ErrorBoundary onBack={() => setTab("workspaces")}>
      <div className="grid">
        <Panel title="Your workspace">
          <p className="muted small">
            Choose a workspace once, then set it to unlock Usage, Retrieval, and Billing actions.
          </p>
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

        {tab === "workspaces" && (
          <WorkspacesView
            workspaceId={workspaceClaim || workspaceId}
            sessionUserId={session.user.id}
            onSelectWorkspace={(id) => {
              setWorkspaceId(id);
              persistWorkspaceId(id);
              setAlert("Workspace selected. Click Set Workspace to activate all workspace-scoped tabs.");
            }}
          />
        )}
        {tab === "keys" && (
          <ApiKeysView
            workspaceId={workspaceClaim || workspaceId}
            onApiKeyCreated={() => {
              if (!firstApiKeyCreated) setFirstApiKeyCreated(true);
            }}
          />
        )}
        {tab === "memories" && (
          <MemoryView
            userId={session.user.id}
            workspaceId={effectiveWorkspaceId}
            onSearchCompleted={() => {
              if (!firstSearchCompleted) setFirstSearchCompleted(true);
            }}
          />
        )}
        {tab === "usage" && <UsageView workspaceId={effectiveWorkspaceId} />}
        {tab === "retrieval" && <RetrievalView userId={session.user.id} workspaceId={effectiveWorkspaceId} />}
        {tab === "activation" && <ActivationView workspaceId={workspaceClaim || workspaceId} />}
        {tab === "settings" && <SettingsView session={session} workspaceId={effectiveWorkspaceId} />}
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

  return (
    <div className="stack">
      <button onClick={github}>Continue with GitHub</button>
      <div className="muted small">or</div>
      <label className="field">
        <span>Email for magic link</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </label>
      <button onClick={magic} disabled={!email || busy}>
        {busy ? "Sending…" : "Send magic link"}
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

function UsageView({ workspaceId }: { workspaceId: string }) {
  const [usage, setUsage] = useState<UsageRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspaceId?.trim()) {
    return (
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

  return (
    <Panel title="Usage">
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
    </Panel>
  );
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

  useEffect(() => {
    load();
  }, [load]);

  const createInvite = async () => {
    if (!workspaceId || !newEmail.trim()) return;
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
