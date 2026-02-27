# MemoryNode Operational Guide

**A personal operating manual for the solo founder or non-technical CTO**

This guide helps you understand how the system behaves, what to check when things feel wrong, and how to stay calm and oriented when running or maintaining MemoryNode on your own. It does not replace detailed runbooks or incident procedures; it gives you the big picture and enough context to make good decisions under pressure.

---

## Who this guide is for and how to use it

This guide is written for:

- **Solo founders** who are responsible for running and maintaining the system alone.
- **CEOs or non-technical CTOs** who understand business and product but do not work at the code level.

**How to use it:**

- Read **“How the system works”** and **“What healthy looks like”** once so you have a mental model.
- Use **“Before releasing”** and **“After a release”** every time you ship changes or go live.
- When something feels off, start with **“When something seems off”** and **“Handling minor issues”**.
- If the situation is serious, use **“Handling major incidents”** to stay oriented; then hand off to your incident and rollback procedures (or an engineer) with confidence.

You do not need to memorize commands or config. The goal is to know *what* is happening, *why* it matters, and *what to check first*.

---

## How the system works (at a high level)

MemoryNode has three main parts that users and you interact with:

1. **The API** — The service that handles everything: storing and searching memories, checking usage, and (if you use it) processing payments. It runs on Cloudflare Workers and talks to your database and (for search quality) to an external embedding service. When we say “the API is up,” we mean this service is responding and can read and write data.

2. **The dashboard** — The web app where users sign up, create workspaces, create API keys, and browse their memories. Users never put their API key in the dashboard; they log in with email or GitHub, and the dashboard talks to the API on their behalf. The dashboard must be deployed and reachable (e.g. at your main app URL) for a normal user experience.

3. **The database** — Where all persistent data lives: memories, workspaces, API keys, usage, and (if billing is on) payment-related state. The API is only truly “ready” when it can reach the database. A simple “readiness” check that hits the database is available for load balancers or platforms; if that check fails, the API should not receive traffic until the database is back.

**What users do (normal flow):** Sign up → create or pick a workspace → create an API key (shown once) → store memories via the API or dashboard → run searches. Success means they complete this path; you can track that with activation events (e.g. first ingest, first search) if you have product analytics.

**Billing (if enabled):** Payments are handled by PayU. When a customer pays, PayU sends a “webhook” (a callback) to your API. The API checks that the callback is genuine, then updates the customer’s plan and limits. If something goes wrong with that callback (e.g. wrong credentials or a missing mapping), payments can be “deferred” until you fix the cause and replay or reprocess. There is a dedicated billing runbook for that; this guide only tells you when to think “billing” and where to look.

**Plans and limits:** Users are on plans (e.g. Launch, Build, Deploy, Scale). Each plan has daily limits (writes, reads, embedding usage). When a user hits a limit, the API returns a “cap exceeded” response and stops that type of work until the next day (or until they upgrade). Rate limiting also applies: each API key has a maximum number of requests per minute; new keys are stricter for the first day or two to reduce abuse.

---

## What “healthy” looks like day to day

**Healthy** means:

- **The API responds** — Requests are being handled; you see a steady flow of completed requests in your logs or monitoring.
- **Most requests succeed** — The vast majority of responses are successful (2xx). A small number of client errors (4xx) or “rate limited” (429) is normal; a sudden spike in server errors (5xx) is not.
- **Latency is normal** — Requests (including search and embedding) complete within expected times. Your observability docs define what “normal” is (e.g. p95 under a few hundred milliseconds for the API, a bit higher for search and embeds).
- **The database is reachable** — The API can read and write to the database. If you use a readiness endpoint that checks the database, it should return “ready.”
- **Billing (if on):** PayU callbacks are received, verified, and processed. You see “webhook processed” (or similar) in logs after payments. There is no growing backlog of “deferred” or “failed” webhooks, and no repeated “signature invalid” or “workspace not found” errors.

**What to look at first:** Your monitoring or log dashboard should give you a single “health” view: request rate, error rate (especially 5xx), latency, and (if billing is on) webhook flow and any backlog. If all of those are green, the system is healthy. If any turn red, that’s your starting point (see “When something seems off”).

---

## Before releasing changes or going live

Before you push a new version to production (or before the very first time you take traffic):

1. **Run the release gate** — There is a single “gate” that runs checks (code quality, config, secrets, migrations, tests). It must pass on the commit you are releasing. If you have an engineer or script, they run it; if you are non-technical, ensure “the gate passed” before you approve a release.

2. **Use the go-live checklist** — There is a one-page checklist that covers: code and CI green, required secrets and production settings set in the hosting platform (not in the repo), database migrations run and verified on staging then production, deploy order (e.g. staging → production), dashboard deployed and a live security-headers check passed, and post go-live checks (e.g. health endpoint, logging and alerts, a test billing callback if billing is on, and optionally scheduling session cleanup). Do not skip items; they are there so you don’t miss a step.

3. **Use the go/no-go checklist** — A separate “prod ready” checklist covers: CI and quality, secrets and security checks, database safety (migrations and verification), release validation (staging and production), abuse and billing reliability (e.g. webhook tests and backlog monitoring), and operations readiness (tracing, rollback path, kill switches, backups). Every item should be green before you consider the release allowed.

4. **Confirm the dashboard and security** — Before real users hit the app, the dashboard must be deployed and a “G5” (or equivalent) check must confirm that the live dashboard URL serves the right security headers. That check is documented in the release runbook; someone with access runs it once before go-live.

Do not introduce new steps that are not already in these internal docs; follow the existing checklists and runbook. If you are not the person running commands, your job is to ensure the person who does has completed these steps and that you have a clear “we are ready” sign-off.

---

## After a release: what to double-check

Right after a release (same day):

1. **Health and readiness** — Confirm the main API health endpoint returns “ok” and that a request ID is present in the response. If you use a readiness check that hits the database, confirm it returns “ready” (or equivalent) so load balancers or platforms know the instance can serve traffic.

2. **Logging and alerts** — Ensure your log sink and alert rules are configured (as in your alerts and observability docs). Run the short “health checklist” (e.g. the 60-second checklist in observability) so you know how to open the health view and what “green” looks like.

3. **Billing (if enabled)** — Send a test PayU callback (or have PayU send one) and confirm in logs that the webhook was verified and processed. If anything fails, treat it as a minor billing issue and follow the billing runbook (see “Handling minor issues”).

4. **Session cleanup (recommended)** — If the dashboard uses server-side sessions, schedule a periodic cleanup of expired sessions (e.g. daily). The exact endpoint or job is in your operations docs; the point is to avoid unbounded growth of session data.

5. **Validation** — The release runbook defines validation commands for staging and production. Ensure someone ran the production validation after deploy and that it passed. If not, treat the release as incomplete until validation is green.

---

## When something seems off (early warning signs)

These are signals that something may be wrong. They are not a full incident response; they tell you *where* to look and *what* to care about first.

- **API slow or not responding** — Requests take much longer than usual or time out. *Check first:* Is the database reachable? Is the readiness (or health) endpoint still returning OK? Look at your health view: request rate, latency, and database-related metrics.

- **Many server errors (5xx)** — A noticeable share of requests return 5xx. *Check first:* Logs and health view for the same period. Look for database errors, config errors, or a dependency (e.g. embedding service) failing. If you have a rollback procedure, keep it in mind in case the cause is the last release.

- **Lots of “rate limited” or “cap exceeded”** — Many 429 or “cap exceeded” responses. *Check first:* Whether a single customer or key is driving the spike (abuse or misconfiguration) vs. a system-wide limit misconfiguration. Rate and cap behavior are documented in your internal docs; you may need an engineer to adjust limits or talk to the customer.

- **Billing: payments not reflecting, or support says “payment went through but plan didn’t update”** — *Check first:* Webhook logs. Look for “webhook received,” “webhook verified,” and “webhook processed.” If you see “signature invalid” or “workspace not found,” or a growing number of “deferred” or “failed” events, that’s a billing pipeline issue. Use the billing runbook: fix the root cause (e.g. credentials, mapping), then replay or reprocess as described there. Do not change billing state manually without following that runbook.

- **Dashboard not loading or “session expired” for everyone** — *Check first:* Is the dashboard deployment up? Is the API up and accepting dashboard requests? Are allowed origins set correctly for production? If the dashboard and API are up but users still cannot use it, it may be a config or auth issue; your operations or security docs describe where to look.

- **“Database check failed” or readiness returns “not ready”** — The API cannot reach the database. *Check first:* Database availability and connectivity from the API’s network. Do not send traffic to that API instance until the database is back and readiness is green again.

---

## Handling minor issues safely

**Minor** means: no large outage, no data loss, no security breach. Examples: a few failed webhooks, one customer hitting rate limits, or a brief latency spike that recovers.

- **Stay calm** — Use the “early warning signs” section to decide what to check first. Open your health view and logs; confirm what is red and what is still green.

- **One thing at a time** — Fix or investigate one area (e.g. “billing webhooks” or “this customer’s rate limit”) before changing something else. Do not toggle multiple “kill switches” or config options at once unless your runbook explicitly says so.

- **Billing issues** — Follow the billing runbook only. It explains how payments are verified, how events are stored, and when it is safe to replay or reprocess. Do not guess; do not manually edit billing state. If you are non-technical, have someone who has access run the runbook steps and report back.

- **Rate or cap issues** — If a single customer is hitting limits, it may be expected (they need to upgrade or slow down). If the whole system is rate-limiting too aggressively, that’s a config change (documented in your internal docs); an engineer should make it, then redeploy and re-validate.

- **Document what you did** — Note what you observed, what you changed (if anything), and whether the issue cleared. That helps the next time and helps if the issue turns out to be part of a larger incident.

---

## Handling major incidents without panic

**Major** means: significant outage, many users affected, possible data or security impact, or you are not sure and need to assume the worst.

- **Prioritize stability and users** — The goal is to stop the bleeding and restore a good state, not to fix every root cause in the first minutes. It’s okay to roll back a release or to turn off a feature (using documented “kill switches”) while you figure out what happened.

- **Use your existing procedures** — You have incident and rollback procedures (in your operations and release runbooks). Do not invent new ones on the spot. Follow them: who does what, how to roll back to the previous version, how to confirm the rollback worked (e.g. health and readiness checks, validation), and when to involve others.

- **One decision at a time** — Decide the next single step: e.g. “roll back now,” “disable billing webhooks for now,” or “escalate to [person/team].” Then do that step and reassess. Avoid changing many things at once.

- **Communicate simply** — If users or stakeholders need to know, keep messages short and factual: what’s affected, what you’re doing, and when you’ll update again. If you have a status page, use it.

- **After the incident** — When the system is stable, you can do a proper review: what happened, what you did, and what to change (process, config, or code) so it doesn’t happen again. Your incident process doc describes severity levels and postmortem expectations; use it.

This guide does not replace those procedures. It is here so you stay oriented: you know that there *is* a rollback path, that there *are* kill switches, and that the right move is to follow the documented process rather than to improvise under stress.

---

## Summary

- **Normal operation:** API, dashboard, and database work together; users can sign up, create keys, store and search memories; if billing is on, PayU callbacks are verified and processed.
- **Healthy:** Request flow is steady, errors are mostly client-side or expected, latency is normal, database is reachable, and (if applicable) webhooks are processing with no growing backlog.
- **Before release:** Run the release gate, complete the go-live and go/no-go checklists, and confirm dashboard and security checks.
- **After release:** Check health and readiness, logging and alerts, a test billing callback if relevant, session cleanup, and validation.
- **When something seems off:** Use early warning signs to choose what to check first (API, database, billing, dashboard, readiness); then use the right runbook (billing, observability, operations) without guessing.
- **Minor issues:** Investigate and fix one area at a time; for billing, follow the billing runbook only; document what you did.
- **Major incidents:** Prioritize stability; follow existing incident and rollback procedures; make one decision at a time; communicate simply; do a proper review afterward.

This document is your high-level map. The detailed steps, commands, and thresholds live in the internal runbooks and checklists (release runbook, go-live checklist, prod ready checklist, billing runbook, observability, alerts, operations). Use this guide to know *when* to open which of those and to stay calm and decisive when you do.
