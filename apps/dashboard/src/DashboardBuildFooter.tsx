import { useEffect, useState } from "react";

export type DashboardBuildFooterPlacement = "console" | "founder";

type VersionPayload = {
  gitSha?: string;
  surface?: string;
  builtAt?: string;
};

function formatShortSha(sha: string): string {
  const s = sha.trim();
  if (s.length <= 12) return s;
  return `${s.slice(0, 7)}…`;
}

/**
 * Fetches `/version.json` (emitted by the production Vite build) for support handoffs.
 * In dev, shows a static local line without fetching.
 */
export function DashboardBuildFooter({ placement }: { placement: DashboardBuildFooterPlacement }): JSX.Element {
  const [hoverTitle, setHoverTitle] = useState("");
  const [line, setLine] = useState("");

  useEffect(() => {
    if (import.meta.env.DEV) {
      setLine("Build · local dev");
      setHoverTitle("Run a production build to generate /version.json.");
      return;
    }
    let cancelled = false;
    void fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<VersionPayload>) : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (cancelled) return;
        const sha = (j.gitSha ?? "").trim();
        const surf = (j.surface ?? "").trim();
        const built = (j.builtAt ?? "").trim();
        if (!sha) {
          setLine("Build · version unavailable");
          setHoverTitle("version.json did not include gitSha.");
          return;
        }
        setLine(`Build · ${formatShortSha(sha)} · ${surf || "?"}`);
        setHoverTitle([sha, built ? `Built ${built}` : ""].filter(Boolean).join("\n"));
      })
      .catch(() => {
        if (!cancelled) {
          setLine("Build · could not load version.json");
          setHoverTitle("Check deploy or network. Support can still use git SHA from CI.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cls = placement === "console" ? "console-build-footer" : "founder-build-footer";
  return (
    <footer
      className={`${cls} muted small`}
      role="contentinfo"
      title={hoverTitle || undefined}
      aria-label={hoverTitle ? "Deployment build information" : undefined}
    >
      {line}
    </footer>
  );
}
