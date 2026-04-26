import { useEffect, useState } from "react";
import { Panel } from "../components/Panel";
import { dashboardApiGet, dashboardApiPost, userFacingErrorMessage } from "../apiClient";
import { API_PATHS } from "../config/apiPaths";
import { MembersView } from "./MembersView";

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

export function WorkspacesView({
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
    try {
      const data = await dashboardApiGet<{
        workspaces: Array<{ id: string; name: string; role: string }>;
      }>(API_PATHS.dashboard.workspaces);
      setList(data.workspaces ?? []);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    if (!newName.trim()) return;
    setError(null);
    try {
      const data = await dashboardApiPost<{ workspace_id: string; name?: string }>(
        API_PATHS.dashboard.workspaces,
        { name: newName.trim() },
      );
      setNewName("");
      if (data.workspace_id) {
        const createdWorkspaceId = data.workspace_id;
        setList([{ id: createdWorkspaceId, name: data.name ?? newName.trim(), role: "owner" }, ...list]);
        onSelectWorkspace(createdWorkspaceId);
      } else {
        await load();
      }
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
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

