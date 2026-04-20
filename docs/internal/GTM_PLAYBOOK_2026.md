# GTM playbook 2026 — MemoryNode

Internal playbook for distribution and messaging. Aligns with [external/POSITIONING.md](../external/POSITIONING.md).

## One-liner

**MemoryNode is reliable per-user memory for customer-facing AI — save, search, and ship without running vector search yourself.**

## Elevator (three sentences)

1. Chatbots and copilots fail when they **forget** the customer — MemoryNode stores facts and retrieves the right ones for each `userId`.
2. You integrate with **REST or MCP**; we run **hybrid search** and embeddings.
3. We are **narrow on purpose** — not a “sync every SaaS tool” platform — so setup stays fast and pricing stays understandable.

## Primary wedges

1. **Support / success agents** — ticket continuity ([recipe](../external/RECIPE_SUPPORT_AGENT.md)).
2. **SMB high-volume chat** — caps-aware ([recipe](../external/RECIPE_SMB_CHATBOT.md)).
3. **SaaS copilots** — tenant-safe ids ([recipe](../external/RECIPE_SAAS_COPILOT.md)).

## Agency one-pager (copy block)

**Problem:** Clients want AI that **remembers** users across sessions; teams do not want to run pgvector and embedding pipelines.

**Solution:** MemoryNode — `POST /v1/memories` then `POST /v1/context` with the same `userId` / `scope`.

**Integration:** 1) Get API key from [console.memorynode.ai](https://console.memorynode.ai). 2) Server-side only for keys. 3) Wire one insert + one context call per turn.

**Pricing / limits:** Point to live pricing on the website; mention cap errors for high-volume bots ([external README](../external/README.md)).

**Support:** Your operator contact + always attach `x-request-id` from API responses.

## Template and content checklist

- [ ] Record **3 Looms** (5 min each): support recipe, SaaS copilot, SMB caps — walk through curl or `examples/support-bot-minimal`.
- [ ] Publish **one GitHub template** or fork-friendly repo with env vars only.
- [ ] Post recipes in **5 communities** (Indie Hackers-style, local builder Slack/Telegram, Reddit r/SaaS or r/LangChain — follow each community’s rules).
- [ ] Open **3 PRs** to popular boilerplates (Next.js AI chat starters) adding optional MemoryNode env block — keep PRs minimal.

## Marketing site handoff (separate repo)

Use this block on the public marketing site; **CTA always goes to the console** for signup and keys.

**Hero headline:**  
Memory that your AI apps can actually use.

**Subhead:**  
Store facts per user, retrieve the right context for support bots, SaaS copilots, and chat — without running your own vector database.

**Three bullets:**

- **Per-user memory** — scoped by project and the ids you choose.
- **Hybrid search + prompt-ready context** — one API for save and retrieve.
- **Built for builders** — REST, TypeScript SDK, and MCP for tools.

**Primary CTA:** [Open console](https://console.memorynode.ai)  
**Secondary CTA:** [Quickstart](https://docs.memorynode.ai/quickstart) (or GitHub `docs/external/QUICKSTART.md` until docs site is synced)

**Trust strip:** Link “Security & data” to your hosted `/trust` or GitHub [TRUST.md](../external/TRUST.md).

## Weekly metrics (early stage)

Track manually if needed:

| Metric | Why |
|--------|-----|
| New projects with **>=1 memory write** in 7 days | Activation |
| New projects with **>=1 search or context** in 7 days | Real integration |
| **Support tickets** mentioning “first call” / 401 / CORS | Docs friction |
| **Inbound** demos or agency intros | Pipeline |
| **Docs clicks** from console “Next steps” | Onboarding funnel (if wired in analytics later) |

## Non-goals (recap)

Do not position as full **knowledge sync** or **enterprise graph** until the product matches; see [POSITIONING.md](../external/POSITIONING.md).
