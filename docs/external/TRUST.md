# MemoryNode Trust & Security

**Trust entry point** — links to security, operations, and compliance documentation.

---

## Security & Compliance

| Document | Description |
|----------|-------------|
| [SECURITY.md](../SECURITY.md) | Auth, RLS, session design, no long-lived keys in browser, audit logging, secret rotation |
| [Identity and tenancy](../internal/README.md#identity-and-tenancy) | Identity model, workspace → API key scope, enforcement map (in internal README) |

---

## Operations & Reliability

| Document | Description |
|----------|-------------|
| [INCIDENT_PROCESS.md](../INCIDENT_PROCESS.md) | Severity taxonomy (S0–S3), postmortem template, error budget policy |
| [OBSERVABILITY.md](../internal/OBSERVABILITY.md) | SLO definitions, golden metrics, health view, performance & tuning |
| [ALERTS.md](../internal/ALERTS.md) | Alert rules, triage playbooks |
| [OPERATIONS.md](../OPERATIONS.md) | Secrets inventory, rollback, incident checklist |

---

## Status & SLOs

- **Status page:** [status.memorynode.ai](https://status.memorynode.ai) (or your deployed status URL)
- **SLO targets:** See [OBSERVABILITY.md](../internal/OBSERVABILITY.md) §4 and §4.1

---

## Data & Audit

| Document | Description |
|----------|-------------|
| [DATA_RETENTION.md](./DATA_RETENTION.md) | Data deletion, retention policy, audit trail |

---

## Trust changelog (merged from TRUST_CHANGELOG.md)

Security and operational improvements by date. Updated on each meaningful trust/ops release.

### 2026-02-14

- **Phase 3 Observability:** Status page live; SLO definitions (28-day rolling, Appendix A); error budget policy; INCIDENT_PROCESS with severity taxonomy S0–S3; saved queries and health view; alert rules (machine-readable).
- **Trust entry point:** TRUST.md created linking to SECURITY, INCIDENT_PROCESS, OBSERVABILITY, ALERTS, OPERATIONS.

### Earlier (Phase 0)

- Session tokens moved to httpOnly cookies; no long-lived keys in browser.
- CSRF protection (SameSite + Origin/Referer + CSRF token) on mutating calls.
- CSP and security headers on dashboard.
- Dashboard Session Design documented; rotation and revoke; API key metadata (last_used_at, last_used_ip).
- Error boundary; dashboard tests; CI gates G1–G5; no localhost fallback in prod.
