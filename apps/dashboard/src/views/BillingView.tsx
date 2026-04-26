import { useState } from "react";
import { Panel } from "../components/Panel";
import { apiGet, apiPost, userFacingErrorMessage } from "../apiClient";
import { API_PATHS } from "../config/apiPaths";
import type { BillingReturnNotice } from "../consoleRoutes";
import type { UsageRow } from "../types";

export function BillingPlansView({ workspaceId }: { workspaceId: string }) {
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
      const res = await apiPost<{ url: string; method?: string; fields?: Record<string, string> }>(API_PATHS.billing.checkout, { plan });
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
      {message ? (
        <div
          className={`alert ${message.includes("Popup") ? "alert--warning" : "alert--error"}`}
          role="alert"
        >
          {message}
        </div>
      ) : null}
      {!workspaceId ? (
        <div className="alert alert--warning" role="status">
          Set your project first to checkout a plan.
        </div>
      ) : null}
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

export function BillingUsageView({ workspaceId, embedded = false }: { workspaceId: string; embedded?: boolean }) {
  const [usage, setUsage] = useState<UsageRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!workspaceId?.trim()) {
    const emptyWorkspace = (
      <div className="alert alert--warning" role="status">
        Set your project first to view usage and limits.
      </div>
    );
    return embedded ? emptyWorkspace : <Panel title="Usage">{emptyWorkspace}</Panel>;
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<UsageRow>(API_PATHS.usage.today);
      setUsage(res);
    } catch (err: unknown) {
      setError(userFacingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <>
      <div className="muted small">Using session (scoped to this project).</div>
      <div className="muted small">Enforcement: daily fair-use cap (hard) and billing-period cap (hard).</div>
      {loading ? (
        <div className="ds-inline-loading" role="status">
          <span className="ds-spinner" aria-hidden />
          Loading…
        </div>
      ) : null}
      {error ? (
        <div className="alert alert--error" role="alert">
          <div>{error}</div>
          <div className="row mt-sm">
            <button type="button" className="ghost" onClick={load} disabled={loading}>
              Retry
            </button>
          </div>
        </div>
      ) : null}
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

export function BillingView({
  workspaceId,
  returnNotice,
}: {
  workspaceId: string;
  returnNotice: BillingReturnNotice | null;
}) {
  const [billTab, setBillTab] = useState<"plans" | "usage">("plans");
  return (
    <Panel title="Billing">
      {returnNotice ? (
        <div className={`alert alert--${returnNotice.tone}`} role="status">
          {returnNotice.message}
        </div>
      ) : null}
      <nav className="tabs">
        <button className={billTab === "plans" ? "tab active" : "tab"} onClick={() => setBillTab("plans")}>Plans</button>
        <button className={billTab === "usage" ? "tab active" : "tab"} onClick={() => setBillTab("usage")}>Usage</button>
      </nav>
      {billTab === "plans" && <BillingPlansView workspaceId={workspaceId} />}
      {billTab === "usage" && <BillingUsageView workspaceId={workspaceId} embedded />}
    </Panel>
  );
}

