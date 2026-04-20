import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, userFacingErrorMessage } from "../apiClient";
import { DeveloperNextSteps } from "../DeveloperNextSteps";

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

export function OverviewView({
  workspaceReady,
  sessionReady,
  hasApiKey,
  onQuickSetup,
}: {
  workspaceReady: boolean;
  sessionReady: boolean;
  hasApiKey: boolean;
  onQuickSetup: () => void;
}): JSX.Element {
  const navigate = useNavigate();
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
      label: "Memory rows",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.documents ?? 0),
    },
    {
      label: "Chunks indexed",
      value: !workspaceReady || !sessionReady ? dash : loading ? "…" : fmt(stats?.memories ?? 0),
    },
    {
      label: "Read Operations",
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
        <h1 className="overview-page-title">Home</h1>
        <div className="timeframe-toggle" role="group" aria-label="Time range">
          {(["1d", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "timeframe-btn timeframe-btn--active" : "timeframe-btn"}
              onClick={() => setRange(r)}
              disabled={!workspaceReady || !sessionReady}
              title={!workspaceReady ? "Connect a project to load metrics." : undefined}
            >
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>
      <p className="overview-range-hint muted small">
        Counts for <strong>{range === "all" ? "all time" : range}</strong>
        {!workspaceReady || !sessionReady
          ? " — set a project to load live numbers."
          : " — numbers update for this selected time range."}
      </p>
      {error ? (
        <div className="alert alert--error" role="alert">
          {error}
        </div>
      ) : null}
      {workspaceReady && sessionReady ? <DeveloperNextSteps hasApiKey={hasApiKey} /> : null}
      {workspaceReady && sessionReady && stats && !loading && stats.documents === 0 && stats.search_requests === 0 ? (
        <div className="overview-empty-api-hint muted small" role="status">
          No API traffic in this range yet. Follow <strong>Next: ship memory</strong> above, open{" "}
          <a href="https://docs.memorynode.ai/quickstart" target="_blank" rel="noopener noreferrer">
            Quickstart
          </a>
          , or try an <strong>Example</strong> below.
        </div>
      ) : null}
      <div className="overview-cards overview-cards--hero">
        {workspaceReady && sessionReady && loading ? (
          <>
            {[1, 2, 3, 4].map((k) => (
              <div key={k} className="metric-card metric-card--skeleton">
                <div className="skeleton skeleton--line short" aria-hidden />
                <div className="skeleton skeleton--line hero" aria-hidden />
              </div>
            ))}
          </>
        ) : (
          cards.map((card) => (
            <div key={card.label} className="metric-card">
              <div className="muted small">{card.label}</div>
              <div className="metric-value">{card.value}</div>
            </div>
          ))
        )}
      </div>

      <h2 className="overview-explore-title">Try MemoryNode</h2>
      <p className="muted small mt-sm">Examples — optional guided demos.</p>
      <div className="explore-grid">
        <button
          type="button"
          className="explore-tile"
          disabled={!workspaceReady || !sessionReady}
          title={
            !workspaceReady || !sessionReady ? "Connect a project in Get started to open examples." : undefined
          }
          onClick={() => navigate("/continuity")}
        >
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 12h16M12 4v16" strokeLinecap="round" />
              <circle cx="12" cy="12" r="8" />
            </svg>
          </span>
          <span className="explore-tile-title">Continuity demo</span>
          <span className="explore-tile-desc muted small">Remember a user across sessions (SaaS-style walkthrough).</span>
        </button>
        <button
          type="button"
          className="explore-tile"
          disabled={!workspaceReady || !sessionReady}
          title={
            !workspaceReady || !sessionReady ? "Connect a project in Get started to open examples." : undefined
          }
          onClick={() => navigate("/assistant")}
        >
          <OverviewChevron />
          <span className="explore-tile-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 3a7 7 0 0 1 7 7v3H5v-3a7 7 0 0 1 7-7z" />
              <path d="M8 21h8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="explore-tile-title">Assistant demo</span>
          <span className="explore-tile-desc muted small">No-code assistant flow — connect tools and recall context.</span>
        </button>
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
          <span className="explore-tile-desc muted small">
            Opens API Keys when your project is connected — then verify with Memory Lab.
          </span>
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
          <span className="explore-tile-title">Quickstart</span>
          <span className="explore-tile-desc muted small">See MemoryNode in action with a copy-paste guide.</span>
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