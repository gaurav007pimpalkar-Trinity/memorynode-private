# MemoryNode

**Reliable per-user memory for customer-facing AI** — save what matters, retrieve it when your app needs it. See **[POSITIONING.md](./POSITIONING.md)** for ICP, promise, and non-goals.

---

## What this product is

MemoryNode gives your AI app a place to remember. You send in facts, preferences, or snippets of conversation; when your chatbot or assistant needs context, you ask in plain language and get back the right memories, formatted and ready to use. No need to build or run your own search or storage pipeline — we handle that so you can focus on your product.

---

## What you can do with it

- **Store memories** — Send user facts, preferences, or conversation snippets. You choose how to scope them (e.g. by user and optional namespace).
- **Search** — Ask a question in natural language; get the most relevant memories back. Use the same user and namespace you used when storing.
- **Get context for prompts** — One call returns formatted context and citations, ready to drop into your AI prompt.
- **See usage** — Check how much you’ve used and your plan limits via the API or dashboard (daily fair-use cap and billing-period cap are both enforced as hard limits).
- **Clear cap errors** — API returns `daily_cap_exceeded` for fair-use daily cap and `monthly_cap_exceeded` for billing-period cap so apps can guide users correctly.
- **Export and import** — Take a copy of your memories for backup or to move them elsewhere.

You use the **API** (with an API key) or the **TypeScript SDK**. The **dashboard** is where you sign up, create workspaces, create and revoke API keys, and upgrade your plan.

**REST vs MCP:** Use **REST** (or the SDK) from your app servers. Use **MCP** when AI tools/editors should call memory over the Model Context Protocol — see **[MCP_SERVER.md](../MCP_SERVER.md)**.

---

## Who it’s for

- **Support and success copilots** — [Support-style recipe](./RECIPE_SUPPORT_AGENT.md).
- **SaaS in-app assistants** — [Copilot recipe](./RECIPE_SAAS_COPILOT.md).
- **SMB / high-volume chat** — [Chatbot recipe](./RECIPE_SMB_CHATBOT.md); handle caps and rate limits in your UX.

---

## How to get started

1. **[Quickstart](./QUICKSTART.md)** — zero to first memory in minutes.
2. **Recipes** — [support](./RECIPE_SUPPORT_AGENT.md) · [SaaS copilot](./RECIPE_SAAS_COPILOT.md) · [SMB](./RECIPE_SMB_CHATBOT.md).
3. **Runnable demo** — [examples/support-bot-minimal](../../examples/support-bot-minimal/README.md) in this repo.

SDK and source: **[MemoryNode SDK](https://github.com/gaurav007pimpalkar-Trinity/memorynode)**.

---

## Trust and audiences

- **[Trust](./TRUST.md)** · **[Data retention](../DATA_RETENTION.md)** · **[Security](../SECURITY.md)**
- **[US vs India audiences](./AUDIENCES_US_IN.md)** — same product, different proof order.

---

## API access

MemoryNode is API-first. All core actions — store, search, context, usage, export, import — are available over the API and via the TypeScript SDK. For request shapes, examples, and error handling: **[API usage](./API_USAGE.md)**.

---
