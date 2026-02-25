# Status Page Deployment

Public status page for MemoryNode.ai — operational status, SLO summary, and incident history.

---

## URL

- **Production:** `https://status.memorynode.ai` (or your configured subdomain)
- **Local:** `pnpm --filter @memorynode/status dev` → http://localhost:5173

---

## Deploy

### Vercel

```bash
cd apps/status
vercel --prod
```

Configure `status.memorynode.ai` as custom domain in Vercel project settings.

### Cloudflare Pages

```bash
pnpm --filter @memorynode/status build
# Deploy dist/ to Cloudflare Pages
```

1. Connect repo or upload `dist/`.
2. Build command: `pnpm --filter @memorynode/status build`
3. Output directory: `apps/status/dist`
4. Custom domain: `status.memorynode.ai`

---

## Updating Incident History

Edit `apps/status/public/incidents.json` and redeploy. Add entries:

```json
{
  "date": "YYYY-MM-DD",
  "title": "Brief title",
  "severity": "S0|S1|S2|S3",
  "status": "resolved|investigating",
  "description": "Optional details"
}
```

---

## Health Check

The status page fetches `https://api.memorynode.ai/healthz` to display operational status. Ensure CORS allows the status domain if needed.
