/**
 * Console calls the Worker with the same route + JSON bodies as API docs.
 * Auth differs by design: in-app uses the dashboard session (cookies + CSRF); production uses API keys.
 * Curl snippets intentionally show Bearer YOUR_API_KEY — not browser cookies — so integrations stay copy-pasteable.
 */
export function DashboardSessionAuthNote({
  variant,
  id,
}: {
  /** "writes" — demos that POST memories/import; "lab" — Memory Lab retrieval tooling */
  variant: "writes" | "lab";
  /** Optional anchor id (use id="guardnote" on one write playground per product choice). */
  id?: string;
}): JSX.Element {
  if (variant === "writes") {
    return (
      <p id={id} className="dashboard-session-auth-note muted small mt-sm">
        <strong className="dashboard-session-auth-note__lead">Dashboard session:</strong> this uses your signed-in console
        session (JWT exchange + cookies; CSRF on writes), not <code className="small">Authorization: Bearer</code>. In production,
        use your API key with the same JSON body as{" "}
        <a href="https://docs.memorynode.ai" target="_blank" rel="noopener noreferrer">
          the docs
        </a>
        .
      </p>
    );
  }
  return (
    <div id={id} className="dashboard-session-auth-note muted small mt-sm panel--nested" role="note">
      <strong className="dashboard-session-auth-note__lead">Auth parity:</strong> bodies match{" "}
      <code className="small">POST /v1/search</code> and <code className="small">POST /v1/context</code> exactly. The browser sends your{" "}
      <strong>dashboard session</strong> (cookies); Copy as curl uses <code className="small">YOUR_API_KEY</code> so server-side replay
      matches field-for-field. Success responses expose <code className="small">x-request-id</code> below each curl block when the API sends it.
    </div>
  );
}
