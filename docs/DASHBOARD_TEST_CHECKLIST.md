# Dashboard Manual Test Checklist (GA hardening)

- Env guard: remove one of `VITE_SUPABASE_URL` or `VITE_API_BASE_URL` and start dev server → see in-app config error panel listing the missing vars.
- API key guard: clear localStorage `mn_api_key` and reload → “Set API Key” panel appears; entering non-`mn_` key shows validation message.
- Auth/session: sign out → login panel shown; sign back in → dashboard renders.
- API error handling:
  - Use an invalid API key and hit “Usage” → error badge shows 401-style message with retry.
  - Turn off network and trigger Search → error badge + Retry button; app does not crash.
- Loading states: while searching/usage/billing calls in-flight, buttons show “Searching…”/disabled.
