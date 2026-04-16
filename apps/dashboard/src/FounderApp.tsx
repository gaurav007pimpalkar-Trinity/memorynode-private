import { useEffect, useMemo, useState } from "react";
import { adminGet, apiEnvError, userFacingErrorMessage } from "./apiClient";
import { isFounderPath } from "./appSurface";

const CONSOLE_BASE_URL = (import.meta.env.VITE_CONSOLE_BASE_URL as string | undefined)?.trim() || "https://console.memorynode.ai";

type FounderPhase1Summary = {
  api_uptime_pct: number;
  http_5xx_rate_pct: number;
  search_latency_p95_ms: number | null;
  zero_result_rate_pct: number;
  active_workspaces: number;
  activation_rate_pct: number;
  retention_7d_pct: number;
  counts: {
    requests: number;
    failures_5xx: number;
    searches: number;
    zero_result_searches: number;
    new_workspaces: number;
    activated_workspaces: number;
    retention_cohort: number;
    retained_workspaces: number;
  };
};

type FounderPhase1Response = {
  generated_at: string;
  range: "24h" | "7d" | "30d";
  current: FounderPhase1Summary;
  previous: FounderPhase1Summary;
};

function FounderShell({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="shell">{children}</div>;
}

function FounderPanel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">{title}</div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function FounderApp(): JSX.Element {
  const missingEnv = useMemo(() => {
    const errs: string[] = [];
    if (apiEnvError) errs.push(apiEnvError);
    return errs;
  }, []);

  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");
  const [adminTokenInput, setAdminTokenInput] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [data, setData] = useState<FounderPhase1Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isFounderPath(window.location.pathname)) return;
    window.history.replaceState({}, "", "/founder");
  }, []);

  const saveToken = () => {
    const trimmed = adminTokenInput.trim();
    if (!trimmed) {
      setAdminToken("");
      return;
    }
    setAdminToken(trimmed);
    setAdminTokenInput(trimmed);
  };

  const clearToken = () => {
    setAdminToken("");
    setAdminTokenInput("");
    setData(null);
    setError(null);
  };

  useEffect(() => {
    if (!adminToken.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void adminGet<FounderPhase1Response>(`/v1/admin/founder/phase1?range=${encodeURIComponent(range)}`, adminToken.trim())
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(userFacingErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range, adminToken]);

  if (missingEnv.length > 0) {
    return (
      <FounderShell>
        <FounderPanel title="Configuration error">
          <ul className="muted small">
            {missingEnv.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className="muted small">Set `VITE_API_BASE_URL` so the founder dashboard can reach the API.</div>
        </FounderPanel>
      </FounderShell>
    );
  }

  const fmtPct = (value: number) => `${value.toFixed(1)}%`;
  const deltaText = (current: number | null, previous: number | null, suffix = "", decimals = 1) => {
    if (current == null || previous == null) return "No previous window";
    const diff = current - previous;
    const sign = diff > 0 ? "+" : "";
    return `${sign}${diff.toFixed(decimals)}${suffix} vs previous`;
  };

  const current = data?.current;
  const previous = data?.previous;
  const cards = current ? [
    {
      label: "API Uptime",
      value: fmtPct(current.api_uptime_pct),
      detail: `${current.counts.requests.toLocaleString("en-US")} requests`,
      delta: deltaText(current.api_uptime_pct, previous?.api_uptime_pct ?? null, "%"),
    },
    {
      label: "5xx Rate",
      value: fmtPct(current.http_5xx_rate_pct),
      detail: `${current.counts.failures_5xx.toLocaleString("en-US")} failed requests`,
      delta: deltaText(current.http_5xx_rate_pct, previous?.http_5xx_rate_pct ?? null, "%"),
    },
    {
      label: "Search Latency P95",
      value: current.search_latency_p95_ms == null ? "No data" : `${Math.round(current.search_latency_p95_ms)} ms`,
      detail: `${current.counts.searches.toLocaleString("en-US")} searches`,
      delta: deltaText(current.search_latency_p95_ms, previous?.search_latency_p95_ms ?? null, " ms", 0),
    },
    {
      label: "Zero-Result Rate",
      value: fmtPct(current.zero_result_rate_pct),
      detail: `${current.counts.zero_result_searches.toLocaleString("en-US")} zero-result searches`,
      delta: deltaText(current.zero_result_rate_pct, previous?.zero_result_rate_pct ?? null, "%"),
    },
    {
      label: "Active Workspaces",
      value: current.active_workspaces.toLocaleString("en-US"),
      detail: "Distinct workspaces with activity",
      delta: deltaText(current.active_workspaces, previous?.active_workspaces ?? null, "", 0),
    },
    {
      label: "Activation Rate",
      value: fmtPct(current.activation_rate_pct),
      detail: `${current.counts.activated_workspaces}/${current.counts.new_workspaces} newly created workspaces activated`,
      delta: deltaText(current.activation_rate_pct, previous?.activation_rate_pct ?? null, "%"),
    },
    {
      label: "7-Day Retention",
      value: fmtPct(current.retention_7d_pct),
      detail: `${current.counts.retained_workspaces}/${current.counts.retention_cohort} retained cohort`,
      delta: deltaText(current.retention_7d_pct, previous?.retention_7d_pct ?? null, "%"),
    },
  ] : [];

  return (
    <FounderShell>
      <div className="overview-page">
        <div className="overview-page-head">
          <div>
            <h1 className="overview-page-title">Founder Dashboard</h1>
            <p className="muted small">Phase 1 metrics on the dedicated founder app surface.</p>
          </div>
          <div className="row">
            <a className="ghost" href={CONSOLE_BASE_URL}>Open customer console</a>
          </div>
        </div>

        <FounderPanel title="Founder Access">
          <div className="row">
            <input
              type="password"
              value={adminTokenInput}
              onChange={(e) => setAdminTokenInput(e.target.value)}
              placeholder="Enter founder admin token"
            />
            <button type="button" onClick={saveToken} disabled={!adminTokenInput.trim()}>Use token</button>
            <button className="ghost" type="button" onClick={clearToken}>Clear</button>
          </div>
          <div className="muted small">
            Founder metrics live at <code>/founder</code>. The token stays in memory only and is cleared on refresh or tab close.
          </div>
        </FounderPanel>

        <div className="timeframe-toggle" role="group" aria-label="Founder KPI range">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "timeframe-btn timeframe-btn--active" : "timeframe-btn"}
              onClick={() => setRange(r)}
              disabled={!adminToken.trim()}
            >
              {r}
            </button>
          ))}
        </div>

        {error && <div className="badge">{error}</div>}
        {!adminToken.trim() && <div className="badge">Enter a valid admin token to load founder metrics.</div>}
        {loading && <FounderPanel title="Loading">Fetching founder metrics…</FounderPanel>}

        {!loading && data && (
          <>
            <p className="overview-range-hint muted small">
              Showing <strong>{data.range}</strong> against the previous matching window. Generated at{" "}
              {new Date(data.generated_at).toLocaleString()}.
            </p>
            <div className="overview-cards overview-cards--hero">
              {cards.map((card) => (
                <div key={card.label} className="metric-card">
                  <div className="muted small">{card.label}</div>
                  <div className="metric-value">{card.value}</div>
                  <div className="muted small">{card.detail}</div>
                  <div className="muted small">{card.delta}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </FounderShell>
  );
}
