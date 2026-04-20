import { getApiBaseUrl } from "./apiClient";

/**
 * bash-friendly curl for POST JSON.
 *
 * Intentionally shows `Authorization: Bearer YOUR_API_KEY` — not browser cookies or CSRF — so integrators can
 * replay the **same JSON** from servers. The in-app client uses the dashboard session instead; behavior should
 * match when bodies and routes align (see `apiClient.ts` header comment).
 */
function escapeForDoubleQuotedShell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

/**
 * Bash-friendly curl for POST JSON (matches API docs: Bearer + JSON body).
 * Optional extra headers (e.g. `x-save-history`) are emitted when the dashboard sends them.
 */
export function buildCurlPostJson(path: string, body: unknown, extraHeaders?: Record<string, string>): string {
  const base = getApiBaseUrl().replace(/\/$/, "");
  const url = path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
  const json = JSON.stringify(body);
  const d = escapeForDoubleQuotedShell(json);
  const lines = [`curl -sS -X POST "${url}" \\`, `  -H "Authorization: Bearer YOUR_API_KEY" \\`];
  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) {
      lines.push(`  -H "${escapeForDoubleQuotedShell(key)}: ${escapeForDoubleQuotedShell(val)}" \\`);
    }
  }
  lines.push(`  -H "Content-Type: application/json" \\`, `  -d "${d}"`);
  return lines.join("\n");
}
