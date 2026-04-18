# Start here (about 10 minutes)

**MemoryNode gives your AI long-term memory in three API calls:** `POST /v1/memories` → `POST /v1/search` → `POST /v1/context`.

MemoryNode is a **hosted API** that remembers your users: you **save** what they told you, **search** it later, and ask for **ready-to-paste context** for your AI. You need a browser (to copy your API key) and any way to send HTTPS requests — nothing to install on your computer for this path.

## Without memory vs with MemoryNode

| **Without memory** | **With MemoryNode** |
|--------------------|------------------------|
| Your AI tends to give **generic** answers — it forgets what this user said last week. | Your AI can **remember** user preferences and details and answer **personally**. |
| Every session feels like starting from zero. | The same **`user_id`** keeps a **durable thread** of what matters across sessions. |

## 1. Get an API key

1. Open your MemoryNode console and sign in.  
2. Create a workspace and an API key. Copy it once (it looks like `mn_live_...`).

**Base URL:** `https://api.memorynode.ai` (unless your team gave you another URL).

**Auth:** send your key on every request:

- `Authorization: Bearer <YOUR_API_KEY>` **or**
- `x-api-key: <YOUR_API_KEY>`

## 2. Save a memory

`POST /v1/memories`

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/memories" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","text":"User prefers dark mode"}'
```

Use the same `user_id` (and `namespace`, if you use one) when you search.

## 3. Search

`POST /v1/search`

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/search" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"theme preference","top_k":5}'
```

## 4. Prompt-ready context

`POST /v1/context` — like search, but the response includes `context_text` and `citations` you can paste into a system or user message.

```bash
curl -sS -X POST "https://api.memorynode.ai/v1/context" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-123","namespace":"myapp","query":"What do we know about theme preferences?"}'
```

## What this feels like

Your user asks:

> “What theme should I use for this customer?”

Your AI answers:

> “They prefer **dark mode**.”

That answer did not come from thin air — it came from **memory you stored earlier** when they told you how they like to work. That is the “aha”: your product stops sounding forgetful and starts sounding like it **knows** people.

## Smart memory (automatic)

MemoryNode quietly learns from the sentences you save, so later questions can pull the right details back — **you do not turn knobs or tune models for that**.

**Example:** you save one note:

```json
POST /v1/memories
{
  "user_id": "user-123",
  "text": "User prefers dark mode and lives in Mumbai"
}
```

Later, when you ask about this user (search or context), answers can reflect **their preferences and where they are** — automatically — without you hand-building a database of fields.

You can turn that off for a single write with `"extract": false` if you ever want only the exact text you sent.

If operational limits are ever hit, MemoryNode **still stores your note** and may skip optional smart processing until things catch up — your data is not silently dropped.

## Example: memory that remembers

**Step 1 — Store something once**

`POST /v1/memories` with a sentence the user cares about (see the curl in section 2).

**Step 2 — Ask again later**

`POST /v1/search` with a short question (`query`) about that topic. You should see the saved text come back when it matches.

**Step 3 — Give your model the recap**

`POST /v1/context` with the same `user_id` / `namespace` and a natural-language question. Put the returned `context_text` in your prompt so the model answers with **what you stored earlier** in mind.

## Defaults you can ignore at first

- Search already blends keyword and meaning-style matching for you — no algorithm pick list on day one.  
- A successful save returns **`"stored": true`** so you always know the note was kept. A small `extraction` field may appear in the JSON; you can ignore it until you care.  
- If you ever see a technical value like **`"embedding": "skipped_due_to_budget"`** in the response, read it simply as: **some advanced processing was skipped while limits were tight** — your text was still saved (`"stored": true`). Integrators keep the exact field; this is the human meaning.

## Next steps

- **Founder checklist (no repo):** [FOUNDER_PATH.md](./FOUNDER_PATH.md)  
- **Use MemoryNode from an AI editor:** [MCP.md](./MCP.md)

**Need more control?** → [Build mode](../build/README.md)

Full product boundaries: [../external/POSITIONING.md](../external/POSITIONING.md).
