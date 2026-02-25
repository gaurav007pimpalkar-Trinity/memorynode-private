# MemoryNode Incident Process

How we detect, triage, communicate, and resolve incidents. Linked from status page and Trust entry point.

---

## Severity Taxonomy (S0–S3)

| Severity | Definition | Example | Postmortem commitment |
|----------|------------|---------|------------------------|
| **S0** | Full outage: API or critical path unreachable | Healthz 5xx for >5 min; all requests failing | Required; within 48h |
| **S1** | Major degradation: >10% of requests failing or p99 >5s | Search down; 5xx spike on /v1/search | Required; within 72h |
| **S2** | Partial impact: single route or subset of users affected | Billing webhooks failing; one region slow | Required; within 5 days |
| **S3** | Minor: nuisance, workaround exists | Dashboard slow; non-critical 4xx increase | Optional; track in backlog |

**Postmortem required for:** Severity ≥ S2 (or all outages). S3 may be summarized in trust changelog.

---

## Postmortem Template

1. **What happened** — Timeline of detection → resolution.
2. **Impact** — Who was affected (tenants, routes); duration; error rates.
3. **Root cause** — Technical cause (no blame).
4. **Action items** — Fixes, mitigations, and prevention; owners and due dates.
5. **Follow-up** — Link to TRUST_CHANGELOG if public summary published.

---

## Detection

- **Alerts:** See `docs/ALERTS.md`. Alerts fire when thresholds (A1–E2) are breached.
- **Health view:** `docs/HEALTH_VIEW.md` — open in <2 min to assess.
- **Logs:** Cloudflare Workers Logs; filter by `event_name`, `request_id`.

---

## Triage

1. **Identify severity** (S0–S3).
2. **First action:** See `docs/ALERTS.md` §2 (Triage Playbooks) for each alert ID.
3. **Trace:** Use `x-request-id` from client → filter logs by `request_id`.

---

## Communication

- **Internal:** Slack/email to on-call and stakeholders.
- **External:** Update status page (see `docs/internal/STATUS_PAGE.md`). For S0/S1, post incident start and resolution.

---

## Resolution

1. **Mitigate** — Rollback, feature flag off, or hotfix.
2. **Verify** — Run `pnpm release:staging:validate` or prod smoke.
3. **Document** — Postmortem (template above); update TRUST_CHANGELOG if public.

---

## Error Budget Policy

When the **28-day rolling** error budget is exhausted (see `docs/OBSERVABILITY.md` § SLO definitions):

1. **Freeze** non-essential releases; focus on reliability.
2. **Communicate** to stakeholders (e.g. status page, email).
3. **Root-cause** the burn; add or tighten mitigations.
4. **Resume** normal release cadence only after budget recovers or policy exception.

Detailed math and window: `docs/OBSERVABILITY.md` Appendix A and § Error Budget.
