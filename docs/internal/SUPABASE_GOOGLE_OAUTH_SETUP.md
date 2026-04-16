# Supabase Google OAuth (console only)

Use this when **Continue with Google** fails with Supabase `400` / `validation_failed` and **`Unsupported provider: provider is not enabled`**, or when redirects are rejected.

The customer console calls `signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })` from `apps/dashboard/src/App.tsx`. Production uses `https://console.memorynode.ai` as `redirect_to`.

The founder app on `https://app.memorynode.ai/founder` does not use Supabase login; it stays admin-token protected.

---

## 1. Enable Google in Supabase

1. Open the **same** Supabase project as `VITE_SUPABASE_URL` on Cloudflare Pages (production console).
2. **Authentication** → **Providers** → **Google**.
3. Turn the provider **ON**.
4. Paste **Client ID** and **Client Secret** from Google Cloud (see section 2).

---

## 2. Google Cloud OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → **Create credentials** → **OAuth client ID** (or use an existing Web client).
2. Application type: **Web application**.
3. **Authorized redirect URIs** — add Supabase’s callback **exactly** as shown in Supabase (under Google provider), typically:

   `https://<project-ref>.supabase.co/auth/v1/callback`

   Replace `<project-ref>` with your project reference from the Supabase project URL.

4. Save. Copy **Client ID** and **Client secret** into Supabase (step 1).

---

## 3. Redirect / Site URL allowlist

1. Supabase → **Authentication** → **URL Configuration**.
2. Ensure **Site URL** is appropriate (e.g. `https://console.memorynode.ai` for production, or your primary app URL).
3. Under **Redirect URLs**, add:

   - `https://console.memorynode.ai`
   - `http://localhost:5173` and/or `http://localhost:4173` if you test OAuth locally (match the port you use).

If Supabase returns **`redirect_to is not allowed`**, the value sent by the app is not in this list — add the exact origin (no trailing slash unless you use it consistently).

---

## 4. End-to-end verification

1. Deploy or use production: open `https://console.memorynode.ai` (or local with matching redirect URL in Supabase).
2. Click **Continue with Google**.
3. Expected: browser goes to **Google consent**, not a JSON error page.
4. After consent: redirect back to the console origin; session should be established.

**If the UI shows an error** (e.g. after recent dashboard changes): read the message — common cases:

| Symptom / message | Action |
|-------------------|--------|
| `Unsupported provider: provider is not enabled` | Enable Google provider in Supabase (section 1). |
| `redirect_to is not allowed` | Add exact `redirect_to` origin to **Redirect URLs** (section 3). |
| `invalid_client` | Fix Client ID/Secret pair in Supabase vs Google Cloud. |
| Google “redirect_uri_mismatch” | Add `https://<ref>.supabase.co/auth/v1/callback` in Google Cloud (section 2). |

---

## Related

- Console deploy: [DASHBOARD_DEPLOY.md](./DASHBOARD_DEPLOY.md)
