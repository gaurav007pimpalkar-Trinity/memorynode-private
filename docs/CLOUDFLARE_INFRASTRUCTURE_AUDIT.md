# Cloudflare Infrastructure Audit Report

**Date:** 2026-02-27T13:53:34.122Z
**Method:** Cloudflare API with CLOUDFLARE_API_TOKEN.
**Important:** No resources were modified or deleted. Analysis only.

---

## SECTION 1 — ZONES

### 1.1 All zones

| Name | Status | Plan | Nameservers | Zone ID |
| --- | --- | --- | --- | --- |
| memorynode.ai | active | Free Website | asa.ns.cloudflare.com, louis.ns.cloudflare.com | 26922e392eab038eca50583890db901f |

## SECTION 2 — DNS RECORDS

### Zone: memorynode.ai (26922e392eab038eca50583890db901f)

| Type | Name | Content | Proxied | TTL |
| --- | --- | --- | --- | --- |
| CNAME | _6f4e87c705679f4c4d5d0871c43ee844.memorynode.ai | c8d478bee9c5656206b125d0ec87de10.f6682a9ce0afb77d3418c0aec22… | false | 1 |
| CNAME | api-staging.memorynode.ai | memorynode-api-staging.gaurav007pimpalkar.workers.dev | true | 1 |
| CNAME | memorynode.ai | memorynode-website.pages.dev | true | 1 |
| CNAME | worker.memorynode.ai | gaurav007pimpalkar.workers.dev | true | 1 |
| CNAME | www.memorynode.ai | memorynode-website.pages.dev | true | 1 |
| MX | memorynode.ai | eforward3.registrar-servers.com | false | 1 |
| MX | memorynode.ai | eforward2.registrar-servers.com | false | 1 |
| MX | memorynode.ai | eforward1.registrar-servers.com | false | 1 |
| MX | memorynode.ai | eforward4.registrar-servers.com | false | 1 |
| MX | memorynode.ai | eforward5.registrar-servers.com | false | 1 |
| NS | memorynode.ai | dns2.registrar-servers.com | false | 1 |
| NS | memorynode.ai | dns1.registrar-servers.com | false | 1 |
| TXT | memorynode.ai | "v=spf1 include:spf.efwd.registrar-servers.com ~all" | false | 1 |
| AAAA | api.memorynode.ai | 100:: | true | 1 |

### 2.1 DNS issues identified

| Zone | Issue | Detail |
| --- | --- | --- |
| memorynode.ai | Duplicate record | MX memorynode.ai |
| memorynode.ai | Duplicate record | MX memorynode.ai |
| memorynode.ai | Duplicate record | MX memorynode.ai |
| memorynode.ai | Duplicate record | MX memorynode.ai |
| memorynode.ai | Duplicate record | NS memorynode.ai |
| memorynode.ai | CNAME to possible non-existent Worker | worker.memorynode.ai → gaurav007pimpalkar.workers.dev |

## SECTION 3 — WORKERS

### 3.1 Worker scripts

| Script name | Last modified |
| --- | --- |
| memorynode-api | — |
| memorynode-api-staging | — |

### 3.2 Routes per zone

**memorynode.ai:**

| Pattern | Worker script | Route ID |
| --- | --- | --- |
| api-staging.memorynode.ai/* | memorynode-api-staging | 5a4726eb06934ba091fef40fd9e31eb4 |

### 3.3 Workers with no zone routes

- memorynode-api

### 3.4 Bindings (from Worker details)

*Binding details may not be exposed by API; check dashboard or wrangler.toml.*

## SECTION 4 — STORAGE

### 4.1 D1 databases

*None or API error.*

### 4.2 Queues

*None.*

## SECTION 5 — PAGES

| Project | Custom domains | Git repo | Last deployment |
| --- | --- | --- | --- |
| memorynode | memorynode.pages.dev | MemoryNode | 2026-02-27T12:09:02 |
| memorynode-website | memorynode-website.pages.dev, memorynode.ai, www.memorynode.ai | MemoryNode_website | 2026-02-15T12:23:05 |

### 5.1 Pages without custom domains

- memorynode

## SECTION 6 — ROUTE GRAPH

```
Domain → DNS → Worker/Page → Storage
────────────────────────────────────
memorynode.ai api-staging.memorynode.ai/* → Worker: memorynode-api-staging
api-staging.memorynode.ai (CNAME) → Worker: memorynode-api-staging
memorynode.ai (CNAME) → Pages: memorynode-website.pages.dev
worker.memorynode.ai (CNAME) → Worker: gaurav007pimpalkar
www.memorynode.ai (CNAME) → Pages: memorynode-website.pages.dev
```

## SECTION 7 — CLEANUP CANDIDATES

| Resource | Type | Classification | Notes |
|----------|------|-----------------|-------|
| memorynode.ai | Zone | REQUIRED | Primary zone |
| memorynode-api | Worker | NEEDS REVIEW | No zone route |
| memorynode-api-staging | Worker | REQUIRED | Has route |
| memorynode | Pages | ACTIVE BUT NON-CRITICAL |
| memorynode-website | Pages | ACTIVE BUT NON-CRITICAL |

**Classifications:** REQUIRED | ACTIVE BUT NON-CRITICAL | ORPHANED | MISCONFIGURED | NEEDS REVIEW. Do not delete based on this report alone; verify in dashboard.

---

## SECTION 8 — URL CHECK & FOLLOW-UP (2026-02-27)

### 8.1 URL check summary

| URL | Status | Notes |
|-----|--------|--------|
| https://api.memorynode.ai/healthz | 200 | OK |
| https://api.memorynode.ai/ready | 404 | See recommendations below |
| https://api-staging.memorynode.ai/healthz | 200 | OK |
| https://app.memorynode.ai | 200 | OK |
| https://memorynode.ai, https://www.memorynode.ai | 200 / 301 | OK |
| memorynode-api*.workers.dev/healthz | 200 | OK |
| memorynode-website.pages.dev | 200 | OK |
| memorynode.pages.dev | 522 | Origin unreachable (Cloudflare) |

### 8.2 Follow-up recommendations (priority order) — executed

1. **Ignore `/ready`** — Accepted. No change unless a load balancer or readiness probe requires it.
2. **Status page** — Removed. The status app (`apps/status`) has been deleted from the repo.
3. **Fix or delete the `memorynode` Pages project** — Script added; run locally to delete (see below).

### 8.3 Execute cleanup: memorynode Pages project

**Option A — Script (recommended)**

A script uses the Cloudflare API to show status and optionally delete the project:

```bash
# Show project status (no delete)
node scripts/cloudflare_pages_cleanup.mjs

# Delete the project (requires CLOUDFLARE_API_TOKEN in .env or env)
DELETE_MEMORYNODE_PAGES=1 node scripts/cloudflare_pages_cleanup.mjs
```

Ensure `CLOUDFLARE_API_TOKEN` is set (e.g. in repo root `.env` or environment). The token must have Cloudflare Pages edit/delete permission.

**Option B — Dashboard**

1. Cloudflare Dashboard → **Workers & Pages** → **Pages**.
2. Open project **memorynode** → **Deployments** to see latest status (build was failing → 522).
3. If unused: **Settings** → delete project. If this project serves `app.memorynode.ai`, fix the build instead (dashboard is live at app.memorynode.ai from another host, so safe to delete this Pages project).

