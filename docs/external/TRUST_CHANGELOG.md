# Trust Changelog

Security and operational improvements by date. Updated on each meaningful trust/ops release.

---

## 2026-02-14

- **Phase 3 Observability:** Status page live; SLO definitions (28-day rolling, Appendix A); error budget policy; INCIDENT_PROCESS with severity taxonomy S0–S3; saved queries and health view; alert rules (machine-readable).
- **Trust entry point:** `docs/TRUST.md` created linking to SECURITY, INCIDENT_PROCESS, OBSERVABILITY, ALERTS, OPERATIONS.

---

## Earlier (Phase 0)

- Session tokens moved to httpOnly cookies; no long-lived keys in browser.
- CSRF protection (SameSite + Origin/Referer + CSRF token) on mutating calls.
- CSP and security headers on dashboard.
- Dashboard Session Design documented; rotation and revoke; API key metadata (last_used_at, last_used_ip).
- Error boundary; dashboard tests; CI gates G1–G5; no localhost fallback in prod.
