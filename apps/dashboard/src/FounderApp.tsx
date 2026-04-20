import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DashboardBuildFooter } from "./DashboardBuildFooter";
import { adminGet, apiEnvError, userFacingErrorMessage } from "./apiClient";
import { isFounderPath } from "./appSurface";
import { relativeBarPercents } from "./founderChartHelpers";

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
  return <div className="shell shell--founder">{children}</div>;
}

function FounderPanel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-head">{title}</div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function FounderMetricCompare({
  label,
  currentFmt,
  previousFmt,
  detail,
  delta,
  barCurrent,
  barPrevious,
  showBars,
}: {
  label: string;
  currentFmt: string;
  previousFmt: string;
  detail: string;
  delta: string;
  barCurrent: number;
  barPrevious: number;
  showBars: boolean;
}): JSX.Element {
  const pcts = showBars ? relativeBarPercents(barCurrent, barPrevious) : null;

  return (
    <div className="founder-chart-card">
      <div className="founder-chart-card__label">{label}</div>
      <div className="founder-chart-card__nums">
        <span className="founder-num-current">{currentFmt}</span>
        <span className="founder-num-prev muted">Previous window: {previousFmt}</span>
      </div>
      <div className="muted small founder-chart-card__detail">{detail}</div>
      <div className="muted small founder-chart-card__delta">{delta}</div>
      {showBars && pcts && (
        <div className="founder-chart-bars">
          <div className="founder-chart-bar-row">
            <span>Previous</span>
            <div className="founder-chart-bar-track">
              <div
                className="founder-chart-bar-fill founder-chart-bar-fill--prev"
                style={{ width: `${pcts.previousPct}%` }}
              />
            </div>
          </div>
          <div className="founder-chart-bar-row">
            <span>Current</span>
            <div className="founder-chart-bar-track">
              <div
                className="founder-chart-bar-fill founder-chart-bar-fill--cur"
                style={{ width: `${pcts.currentPct}%` }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function FounderApp(): JSX.Element {
  const missingEnv = useMemo(() => {
    const errs: string[] = [];
    if (apiEnvError) errs.push(apiEnvError);
    return errs;
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreenActive, setFullscreenActive] = useState(false);

  const syncFullscreen = useCallback(() => {
    setFullscreenActive(Boolean(document.fullscreenElement));
  }, []);

  useEffect(() => {
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, [syncFullscreen]);

  const toggleFullscreen = useCallback(async () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) {
        const anyEl = el as HTMLElement & { webkitRequestFullscreen?: () => void };
        if (typeof anyEl.requestFullscreen === "function") {
          await anyEl.requestFullscreen();
        } else if (typeof anyEl.webkitRequestFullscreen === "function") {
          anyEl.webkitRequestFullscreen();
        }
      } else {
        const doc = document as Document & { webkitExitFullscreen?: () => void };
        if (typeof document.exitFullscreen === "function") {
          await document.exitFullscreen();
        } else if (typeof doc.webkitExitFullscreen === "function") {
          doc.webkitExitFullscreen();
        }
      }
    } catch {
      /* user denied or unsupported */
    }
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

  const fmtPct = (value: number) => `${value.toFixed(1)}%`;
  const deltaText = (current: number | null, previous: number | null, suffix = "", decimals = 1) => {
    if (current == null || previous == null) return "No previous window";
    const diff = current - previous;
    const sign = diff > 0 ? "+" : "";
    return `${sign}${diff.toFixed(decimals)}${suffix} vs previous`;
  };

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

  const current = data?.current;
  const previous = data?.previous;

  return (
    <FounderShell>
      <div ref={rootRef} className="founder-root">
        <div className="overview-page">
          <div className="overview-page-head">
            <div>
              <h1 className="overview-page-title">Founder Dashboard</h1>
              <p className="muted small">Phase 1 metrics: current window vs previous window (not a full time history).</p>
            </div>
            <div className="founder-hero-actions">
              <button type="button" className="ghost" onClick={() => void toggleFullscreen()}>
                {fullscreenActive ? "Exit fullscreen" : "Enter fullscreen"}
              </button>
              <a className="ghost" href={CONSOLE_BASE_URL}>
                Open customer console
              </a>
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
              <button type="button" onClick={saveToken} disabled={!adminTokenInput.trim()}>
                Use token
              </button>
              <button className="ghost" type="button" onClick={clearToken}>
                Clear
              </button>
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

          {error ? (
            <div className="alert alert--error" role="alert">
              {error}
            </div>
          ) : null}
          {!adminToken.trim() ? (
            <div className="alert alert--warning" role="status">
              Enter a valid admin token to load founder metrics.
            </div>
          ) : null}
          {loading && <FounderPanel title="Loading">Fetching founder metrics…</FounderPanel>}

          {!loading && data && current && previous && (
            <>
              <p className="overview-range-hint muted small">
                Showing <strong>{data.range}</strong> against the previous matching window. Generated at{" "}
                {new Date(data.generated_at).toLocaleString()}.
              </p>

              <div className="founder-layout">
                <div>
                  <h2 className="founder-col-title">Reliability & search</h2>
                  <FounderMetricCompare
                    label="API Uptime"
                    currentFmt={fmtPct(current.api_uptime_pct)}
                    previousFmt={fmtPct(previous.api_uptime_pct)}
                    detail={`${current.counts.requests.toLocaleString("en-US")} requests`}
                    delta={deltaText(current.api_uptime_pct, previous.api_uptime_pct, "%")}
                    barCurrent={current.api_uptime_pct}
                    barPrevious={previous.api_uptime_pct}
                    showBars
                  />
                  <FounderMetricCompare
                    label="5xx rate"
                    currentFmt={fmtPct(current.http_5xx_rate_pct)}
                    previousFmt={fmtPct(previous.http_5xx_rate_pct)}
                    detail={`${current.counts.failures_5xx.toLocaleString("en-US")} failed requests`}
                    delta={deltaText(current.http_5xx_rate_pct, previous.http_5xx_rate_pct, "%")}
                    barCurrent={current.http_5xx_rate_pct}
                    barPrevious={previous.http_5xx_rate_pct}
                    showBars
                  />
                  {current.search_latency_p95_ms != null || previous.search_latency_p95_ms != null ? (
                    <FounderMetricCompare
                      label="Search latency P95"
                      currentFmt={
                        current.search_latency_p95_ms == null ? "No data" : `${Math.round(current.search_latency_p95_ms)} ms`
                      }
                      previousFmt={
                        previous.search_latency_p95_ms == null
                          ? "No data"
                          : `${Math.round(previous.search_latency_p95_ms)} ms`
                      }
                      detail={`${current.counts.searches.toLocaleString("en-US")} searches`}
                      delta={deltaText(current.search_latency_p95_ms, previous.search_latency_p95_ms, " ms", 0)}
                      barCurrent={current.search_latency_p95_ms ?? 0}
                      barPrevious={previous.search_latency_p95_ms ?? 0}
                      showBars={current.search_latency_p95_ms != null || previous.search_latency_p95_ms != null}
                    />
                  ) : (
                    <div className="founder-chart-card">
                      <div className="founder-chart-card__label">Search latency P95</div>
                      <div className="founder-chart-card__nums">
                        <span className="founder-num-current">No data</span>
                      </div>
                      <div className="muted small founder-chart-card__detail">
                        {current.counts.searches.toLocaleString("en-US")} searches
                      </div>
                    </div>
                  )}
                  <FounderMetricCompare
                    label="Zero-result rate"
                    currentFmt={fmtPct(current.zero_result_rate_pct)}
                    previousFmt={fmtPct(previous.zero_result_rate_pct)}
                    detail={`${current.counts.zero_result_searches.toLocaleString("en-US")} zero-result searches`}
                    delta={deltaText(current.zero_result_rate_pct, previous.zero_result_rate_pct, "%")}
                    barCurrent={current.zero_result_rate_pct}
                    barPrevious={previous.zero_result_rate_pct}
                    showBars
                  />
                </div>

                <div>
                  <h2 className="founder-col-title">Growth & retention</h2>
                  <FounderMetricCompare
                    label="Active workspaces"
                    currentFmt={current.active_workspaces.toLocaleString("en-US")}
                    previousFmt={previous.active_workspaces.toLocaleString("en-US")}
                    detail="Distinct workspaces with activity"
                    delta={deltaText(current.active_workspaces, previous.active_workspaces, "", 0)}
                    barCurrent={current.active_workspaces}
                    barPrevious={previous.active_workspaces}
                    showBars
                  />
                  <FounderMetricCompare
                    label="Activation rate"
                    currentFmt={fmtPct(current.activation_rate_pct)}
                    previousFmt={fmtPct(previous.activation_rate_pct)}
                    detail={`${current.counts.activated_workspaces}/${current.counts.new_workspaces} newly created workspaces activated`}
                    delta={deltaText(current.activation_rate_pct, previous.activation_rate_pct, "%")}
                    barCurrent={current.activation_rate_pct}
                    barPrevious={previous.activation_rate_pct}
                    showBars
                  />
                  <FounderMetricCompare
                    label="7-day retention"
                    currentFmt={fmtPct(current.retention_7d_pct)}
                    previousFmt={fmtPct(previous.retention_7d_pct)}
                    detail={`${current.counts.retained_workspaces}/${current.counts.retention_cohort} retained cohort`}
                    delta={deltaText(current.retention_7d_pct, previous.retention_7d_pct, "%")}
                    barCurrent={current.retention_7d_pct}
                    barPrevious={previous.retention_7d_pct}
                    showBars
                  />
                </div>
              </div>
            </>
          )}
          <DashboardBuildFooter placement="founder" />
        </div>
      </div>
    </FounderShell>
  );
}
