import { useEffect, useState } from "react";
import { Panel } from "../components/Panel";
import { dashboardApiGet, dashboardApiPost, userFacingErrorMessage } from "../apiClient";
import { API_PATHS } from "../config/apiPaths";
import { MN_CONSOLE_LAST_API_KEY_PLAINTEXT } from "../config/storageKeys";
import type { ApiKeyRow } from "../types";

export function ApiKeysView({
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
      const data = await dashboardApiGet<{ api_keys: ApiKeyRow[] }>(
        `${API_PATHS.dashboard.apiKeys}?workspace_id=${encodeURIComponent(workspaceId)}`,
      );
      setKeys(data.api_keys ?? []);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspaceId]);

  const createKey = async () => {
    if (!workspaceId || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const data = await dashboardApiPost<{
        api_key?: string | null;
        api_key_id?: string | null;
        workspace_id?: string;
        name?: string;
      }>(API_PATHS.dashboard.apiKeys, {
        workspace_id: workspaceId,
        name: newName.trim(),
      });
      if (data.api_key) {
        setPlaintextKey(data.api_key);
        try {
          sessionStorage.setItem(MN_CONSOLE_LAST_API_KEY_PLAINTEXT, data.api_key);
        } catch {
          /* ignore */
        }
        onApiKeyCreated();
      }
      setNewName("");
      await load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await dashboardApiPost<{ revoked: boolean }>(API_PATHS.dashboard.revokeApiKey, { api_key_id: id });
      await load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    }
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
      {loading ? (
        <div className="ds-inline-loading" role="status">
          <span className="ds-spinner" aria-hidden />
          Loading…
        </div>
      ) : null}
      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
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

