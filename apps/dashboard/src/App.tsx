import { useCallback, useEffect, useMemo, useState } from "react";
import { Session, type AuthChangeEvent } from "@supabase/supabase-js";
import { supabase, supabaseEnvError } from "./supabaseClient";
import { ApiKeyRow, InviteRow, MemoryRow, UsageRow } from "./types";
import { loadWorkspaceId, persistWorkspaceId } from "./state";
import { ApiClientError, apiEnvError, apiGet, apiPost, loadApiKey, maskKey, saveApiKey } from "./apiClient";

type Tab = "workspaces" | "keys" | "memories" | "usage" | "activation" | "settings";

const tabs: Array<{ key: Tab; label: string }> = [
  { key: "workspaces", label: "Workspaces" },
  { key: "keys", label: "API Keys" },
  { key: "memories", label: "Memory Browser" },
  { key: "usage", label: "Usage" },
  { key: "activation", label: "Activation" },
  { key: "settings", label: "Settings" },
];

const activationEvents: Array<{ key: string; label: string }> = [
  { key: "api_key_created", label: "API key created" },
  { key: "first_ingest_success", label: "First ingest success" },
  { key: "first_search_success", label: "First search success" },
  { key: "first_context_success", label: "First context success" },
  { key: "cap_exceeded", label: "Cap exceeded" },
  { key: "checkout_started", label: "Checkout started" },
  { key: "upgrade_activated", label: "Upgrade activated" },
];

const isApiKeyValid = (key: string): boolean => /^mn_/i.test((key ?? "").trim());

export function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [tab, setTab] = useState<Tab>("workspaces");
  const [workspaceId, setWorkspaceId] = useState(() => loadWorkspaceId());
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState(loadApiKey());
  const apiKeyValid = isApiKeyValid(apiKey);

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
      setAlert("Workspace saved to JWT; RLS will scope queries.");
    }
    setWorkspaceSaving(false);
  };

  const updateApiKey = (value: string) => {
    setApiKey(value);
    saveApiKey(value);
  };

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

  if (!apiKeyValid) {
    return (
      <Shell>
        <ApiKeyPanel apiKey={apiKey} onChange={updateApiKey} />
        <Panel title="Action required">
          <div className="badge">Set a valid MemoryNode API key to use the dashboard features.</div>
          <div className="muted small">Expected format: starts with <code>mn_</code> (e.g., mn_live_...)</div>
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
          <button className="ghost" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="grid">
        <Panel title="Workspace scope">
          <p className="muted small">
            RLS is enforced via your JWT claim <code>workspace_id</code>. Set it below (stored in user metadata +
            local storage).
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
              {workspaceSaving ? "Saving…" : "Save & refresh token"}
            </button>
            <button className="ghost" onClick={() => setWorkspaceId(loadWorkspaceId())}>
              Load from local storage
            </button>
          </div>
          {alert && <div className="badge">{alert}</div>}
          <div className="muted small">Current claim: {workspaceClaim || "not set"}</div>
        </Panel>

        <ApiKeyPanel apiKey={apiKey} onChange={updateApiKey} />

        {tab === "workspaces" && (
          <WorkspacesView workspaceId={workspaceClaim || workspaceId} sessionUserId={session.user.id} />
        )}
        {tab === "keys" && <ApiKeysView workspaceId={workspaceClaim || workspaceId} />}
        {tab === "memories" && <MemoryView apiKey={apiKey} />}
        {tab === "usage" && <UsageView apiKey={apiKey} />}
        {tab === "activation" && <ActivationView workspaceId={workspaceClaim || workspaceId} />}
        {tab === "settings" && <SettingsView session={session} apiKey={apiKey} />}
      </div>
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

function ApiKeyPanel({ apiKey, onChange }: { apiKey: string; onChange: (val: string) => void }) {
  return (
    <Panel title="API key (Worker API)">
      <p className="muted small">
        Used for search, usage, and billing calls to the Worker API. Stored in your browser only.
      </p>
      <div className="row">
        <input
          value={apiKey}
          onChange={(e) => onChange(e.target.value)}
          placeholder="mn_live_..."
        />
        <span className="muted small">{maskKey(apiKey)}</span>
        <button className="ghost" onClick={() => onChange("")}>
          Clear
        </button>
      </div>
      {!isApiKeyValid(apiKey) && (
        <div className="badge">Enter a key starting with mn_ (e.g., mn_live_...)</div>
      )}
    </Panel>
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

function WorkspacesView({ workspaceId, sessionUserId }: { workspaceId: string; sessionUserId: string }) {
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
      setList([{ id: data[0].workspace_id as string, name: data[0].name as string, role: "owner" }, ...list]);
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
                <button className="ghost" onClick={() => persistWorkspaceId(w.id)}>
                  Set as current
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

function ApiKeysView({ workspaceId }: { workspaceId: string }) {
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
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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
      }
      setNewName("");
      load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await supabase.rpc("revoke_api_key", { p_key_id: id });
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

function MemoryView({ apiKey }: { apiKey: string }) {
  const [rows, setRows] = useState<MemoryRow[]>([]);
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

  const parseMetadata = (): Record<string, unknown> | undefined => {
    if (!metadata.trim()) return undefined;
    try {
      return JSON.parse(metadata);
    } catch {
      setError("Metadata filter must be valid JSON");
      return undefined;
    }
  };

  const search = async (resetPage = true) => {
    if (!isApiKeyValid(apiKey)) {
      setError("Set a valid API key (mn_ prefix)");
      return;
    }
    if (resetPage) setPage(1);
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
          user_id: "dash-user",
          namespace: namespace || undefined,
          query: query || "",
          page: resetPage ? 1 : page,
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

      const res = await apiPost<{ results: MemoryRow[] }>(
        "/v1/search",
        body,
        apiKey,
      );
      setRows(resetPage ? res.results : [...rows, ...res.results]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = () => {
    setPage((p) => p + 1);
    void search(false);
  };

  const openMemory = async (id: string) => {
    if (!isApiKeyValid(apiKey)) return;
    try {
      const res = await apiGet<MemoryRow>(`/v1/memories/${id}`, apiKey);
      setSelected(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  return (
    <Panel title="Memory Browser">
      <div className="muted small">Using API key: {maskKey(apiKey) || "not set"} (edit in API key panel).</div>
      <div className="row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search query" />
        <input value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="Namespace/project" />
      </div>
      <div className="row">
        <input value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder='Metadata JSON {"tag":"x"}' />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div className="row">
        <button onClick={() => search(true)} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
        <button className="ghost" onClick={() => setRows([])}>
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
          <div key={r.id} className="card" onClick={() => openMemory(r.id)} style={{ cursor: "pointer" }}>
            <div className="row-space">
              <strong>{r.namespace}</strong>
              <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
            </div>
            <div className="muted small">Score: {r.score ?? "n/a"}</div>
            <p>{r.text.slice(0, 240)}</p>
            <div className="muted small">{JSON.stringify(r.metadata)}</div>
          </div>
        ))}
      </div>
      {rows.length > 0 && (
        <button className="ghost" onClick={loadMore} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}

      {selected && (
        <div className="modal" onClick={() => setSelected(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Memory {selected.id}</h3>
            <div className="muted small">Created {new Date(selected.created_at).toLocaleString()}</div>
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

function UsageView({ apiKey }: { apiKey: string }) {
  const [usage, setUsage] = useState<UsageRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!isApiKeyValid(apiKey)) {
      setError("Set a valid API key");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<UsageRow>("/v1/usage/today", apiKey);
      setUsage(res);
    } catch (err: unknown) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) setError("Missing/invalid API key");
        else if (err.status === 402) setError("Over daily cap");
        else if (err.status === 429) setError("Rate limited");
        else setError(err.message);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [apiKey]);

  return (
    <Panel title="Usage">
      <div className="muted small">Using API key: {maskKey(apiKey) || "not set"} (edit in API key panel).</div>
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
          {loading && <div>Loadingâ€¦</div>}
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

function BillingView({ apiKey }: { apiKey: string }) {
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

  const load = async () => {
    if (!isApiKeyValid(apiKey)) {
      setError("API key required to load billing");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{
        plan: string;
        plan_status: string;
        effective_plan: string;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
      }>("/v1/billing/status", apiKey);
      setStatus(res);
      setBanner(null);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) setError("API key required");
        else setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const openCheckout = async () => {
    if (!isApiKeyValid(apiKey)) {
      setError("API key required");
      return;
    }
    setError(null);
    try {
      const res = await apiPost<{ url: string }>("/v1/billing/checkout", {}, apiKey);
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openPortal = async () => {
    if (!isApiKeyValid(apiKey)) {
      setError("API key required");
      return;
    }
    setError(null);
    try {
      const res = await apiPost<{ url: string }>("/v1/billing/portal", {}, apiKey);
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === "BILLING_NOT_SETUP") setError("Upgrade first, then manage billing");
        else setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    void load();
  }, [apiKey]);

  const renewal =
    status?.current_period_end != null
      ? new Date(status.current_period_end).toLocaleString()
      : "not set";

  return (
    <div className="stack" style={{ marginTop: 16 }}>
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
          Upgrade to Pro
        </button>
        <button className="ghost" onClick={openPortal} disabled={loading}>
          Manage billing
        </button>
        <button className="ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>
    </div>
  );
}

function SettingsView({ session, apiKey }: { session: Session; apiKey: string }) {
  return (
    <Panel title="Settings">
      <div className="muted small">User ID: {session.user.id}</div>
      <div className="muted small">Role: {session.user.role}</div>
      <div className="muted small">Issued: {new Date(session.user.created_at).toLocaleString()}</div>
      <div className="muted small">
        Claims: <code>{JSON.stringify(session.user.user_metadata)}</code>
      </div>
      <BillingView apiKey={apiKey} />
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
        if (mem.error) setError(mem.error.message);
        if (inv.error) setError(inv.error?.message ?? null);
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
    <div className="panel" style={{ marginTop: 12 }}>
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
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
          <button onClick={createInvite} disabled={!newEmail.trim() || busy}>
            {busy ? "Saving…" : "Send invite"}
          </button>
        </div>
      </div>

      <div className="muted small" style={{ marginTop: 8 }}>Members</div>
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

      <div className="muted small" style={{ marginTop: 12 }}>Pending invites</div>
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
