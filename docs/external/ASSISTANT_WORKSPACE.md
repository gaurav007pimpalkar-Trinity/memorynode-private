# Assistant Workspace (Phase 3)

Assistant Workspace is the no-code layer on top of the same Memory Engine.

## What you can do now

- Remember something for a specific `userId`
- Ask what the assistant knows about that user
- Review recent memories
- Optionally update or forget a memory from secondary actions

## Quick flow (under 2 minutes)

1. Open the dashboard and switch to **Assistant Workspace**.
2. Open **Assistant**.
3. Top section (**Remember something**):
   - set `userId` (example: `user_123`)
   - add memory text
   - click **Remember something**
4. Middle section (**Ask / Recall**):
   - ask a question
   - click **What do you know about me?**
5. Bottom section (**Recent memories**):
   - confirm remembered items appear
   - use **More options** for **Update this** or **Forget this**

## Scope boundaries

- Uses existing APIs only (`/v1/memories`, `/v1/context`).
- Does not introduce a second backend engine.
- Operational/policy controls stay outside the assistant’s primary flow.

Legacy aliases (`user_id`, `namespace`) remain supported for compatibility.
