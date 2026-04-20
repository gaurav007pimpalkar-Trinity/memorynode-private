## ⚠️ Internal Operational Document

This document may not reflect real-time production state.  
Always verify against actual infrastructure (Cloudflare, Supabase, etc.).

---

# MemoryNode API (Cloudflare Worker)

Canonical Wrangler v4 commands for this package:

```bash
# from repo root
pnpm --filter ./apps/api dev
pnpm --filter ./apps/api build
pnpm --filter ./apps/api deploy:staging
pnpm --filter ./apps/api deploy:production
pnpm load:smoke
```

Equivalent commands from `apps/api` directly:

```bash
pnpm dev
pnpm build
pnpm deploy:staging
pnpm deploy:production
```

Notes:
- `build` runs `wrangler deploy --env staging --dry-run` to validate Worker bundling/config without publishing.
- Deploy scripts use explicit environments: `--env staging` and `--env production`.
- No global Wrangler install is required; commands resolve Wrangler from repo dependencies via `pnpm exec`.
- Never commit real secrets in `wrangler.toml`, `.dev.vars*`, or `.env*`; configure secrets in Cloudflare (Dashboard or `wrangler secret put`). CI enforces this across top-level and env-specific Wrangler vars blocks.
- Abuse protection responses:
  - Rate limiting returns `429` with `{ "error": { "code": "rate_limited" }, "request_id": "..." }` and `Retry-After`.
  - Oversized payloads return `413` with `{ "error": { "code": "payload_too_large" }, "request_id": "..." }`.
- Local limiter smoke:
  - Start API in one terminal: `pnpm --filter ./apps/api dev`
  - Run burst check in another: `pnpm load:smoke`
