## ℹ️ Supporting Documentation

This document is a guide.  
For exact API behavior, refer to:
- `docs/external/API_USAGE.md`
- `docs/external/openapi.yaml` (run `pnpm openapi:gen` to regenerate)

---

# Security Policy

## Never commit secrets

- Never commit API keys, tokens, service-role credentials, or private key material.
- Store production/staging secrets in Cloudflare Dashboard Worker secrets, or set via:
  - `wrangler secret put <NAME>`
- Keep local-only values in untracked local env files.

## Local secret files are ignored

The repository ignores local secret/temp files, including:

- `key.json`
- `ws.json`
- `gate.env`
- `staging_verify_output.txt`
- `staged_files.txt`
- `*.env` and `*.env.*` (except `*.example`)
- `.wrangler*`
- `apps/api/.wrangler*`
- `apps/api/.wrangler-dryrun/`
- `apps/api/_wrangler_out/`
- `*.BACKUP.*`
- `_local_backup/`

## Secret scan guardrails

- Local pre-commit style check:
  - `pnpm secrets:check`
- Full tracked-file check:
  - `pnpm secrets:check:tracked`
- CI runs the same scanner on every push/pull_request and fails on matches.
- Scanner output is redacted and never prints full secret values.
- Rotation runbook + incident checklist: `docs/SECURITY.md`
