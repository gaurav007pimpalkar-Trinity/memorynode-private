import { useCallback, useEffect, useState } from "react";
import { apiGet, dashboardApiGet, dashboardApiPost, userFacingErrorMessage } from "../apiClient";
import { API_PATHS } from "../config/apiPaths";
import type { InviteRow } from "../types";

function seatCapForPlan(planCode: string | null | undefined): number {
  const normalized = (planCode ?? "launch").toLowerCase();
  if (normalized === "launch" || normalized === "build" || normalized === "pro" || normalized === "solo") {
    return 1;
  }
  if (normalized === "deploy" || normalized === "scale" || normalized === "team") {
    return 10;
  }
  if (normalized === "scale_plus") {
    return 25;
  }
  return 10;
}

export function MembersView({ workspaceId, currentUserId }: { workspaceId: string; currentUserId: string }) {
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
      dashboardApiGet<{ members: Array<{ user_id: string; role: string; created_at: string }> }>(
        `${API_PATHS.dashboard.members}?workspace_id=${encodeURIComponent(workspaceId)}`,
      ),
      dashboardApiGet<{ invites: InviteRow[] }>(
        `${API_PATHS.dashboard.invites}?workspace_id=${encodeURIComponent(workspaceId)}`,
      ),
    ])
      .then(([mem, inv]) => {
        setMembers(mem.members ?? []);
        setInvites(inv.invites ?? []);
      })
      .catch((err: unknown) => {
        setError(userFacingErrorMessage(err));
      })
      .finally(() => setLoading(false));
  }, [workspaceId]);

  const loadSeatCap = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const billing = await apiGet<{ effective_plan?: string; plan?: string }>(API_PATHS.billing.status);
      const plan = billing.effective_plan ?? billing.plan ?? "launch";
      setEffectivePlan(plan);
      setSeatCap(seatCapForPlan(plan));
    } catch {
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
    try {
      await dashboardApiPost<{
        id: string;
        workspace_id: string;
        email: string;
        role: string;
        expires_at: string | null;
      }>(API_PATHS.dashboard.invites, {
        workspace_id: workspaceId,
        email: newEmail.trim(),
        role: inviteRole,
      });
      setNewEmail("");
      load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await dashboardApiPost<{ revoked: boolean }>(API_PATHS.dashboard.revokeInvite, { invite_id: id });
      load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const updateRole = async (userId: string, role: string) => {
    setBusy(true);
    setError(null);
    try {
      await dashboardApiPost<{ updated: boolean }>(API_PATHS.dashboard.updateMemberRole, {
        workspace_id: workspaceId,
        user_id: userId,
        role,
      });
      load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      await dashboardApiPost<{ removed: boolean }>(API_PATHS.dashboard.removeMember, {
        workspace_id: workspaceId,
        user_id: userId,
      });
      load();
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) return null;

  return (
    <div className="panel mt-md">
      <div className="panel-head">Members & Invites</div>
      <div className="row-space">
        <span className="muted small">Plan: {effectivePlan}</span>
        <span className="badge badge--accent">
          Seats used: {members.length}/{seatCap}
        </span>
      </div>
      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? (
        <div className="ds-inline-loading" role="status">
          <span className="ds-spinner" aria-hidden />
          Loading…
        </div>
      ) : null}

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
              {i.accepted_at ? <span className="badge">Accepted</span> : null}
              {i.revoked_at ? <span className="badge">Revoked</span> : null}
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

