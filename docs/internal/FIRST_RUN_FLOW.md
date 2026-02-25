# First-Run Flow — Sign Up to First Search in <10 Minutes

Streamlined path for new users. Success = sign up → workspace → API key → ingest one memory → run one search.

---

## Flow (dashboard)

1. **Sign up** — GitHub OAuth or magic link via Supabase Auth.
2. **Create or select workspace** — Workspaces tab → "Create workspace" or pick existing.
3. **Get API key** — API Keys tab → "Create key" → copy plaintext (shown once). Store securely.
4. **Ingest one memory** — Use curl or your app; see QUICKSTART §7.
5. **Run one search** — Memory Browser tab or API.

---

## Success metrics

- **First-run success rate** — % of new signups who complete: workspace → key → ingest → search within 10 min.
- **Measurable via** — Activation events (`first_ingest_success`, `first_search_success`); optional in-app funnel tracking.

---

## In-app hints (optional)

- After signup: "Create a workspace to get started."
- After workspace: "Create an API key to call the API."
- After key: "Ingest a memory, then search in Memory Browser."

---

## Quickstart reference

| Step | Doc |
|------|-----|
| Clone, install, env | QUICKSTART §1–2 |
| Migrations | QUICKSTART §3 |
| Run API + dashboard | QUICKSTART §4–5 |
| Get API key (dashboard) | QUICKSTART §6 |
| Curl smoke (ingest, search) | QUICKSTART §7 |
