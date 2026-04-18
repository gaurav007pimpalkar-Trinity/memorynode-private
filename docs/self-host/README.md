# Self-host / run the repo (Mode 3 — advanced)

**You do not need this for most products.** If you only call the hosted API, stay in **[Start here (Mode 1)](../start-here/README.md)**. If you need filters, SDK, and OpenAPI on the hosted API, use **[Build mode (Mode 2)](../build/README.md)** first.

This section is for **infra engineers**, contributors, or teams operating a **private** deployment.

You will work with:

- Cloudflare Wrangler (local Worker dev and deploy)
- Supabase (Postgres + auth)
- SQL migrations and secrets

That complexity is **intentionally kept out** of the default developer path.

**Next:** [LOCAL_DEV.md](./LOCAL_DEV.md) — environment variables, stub embeddings, and a minimal local loop.
