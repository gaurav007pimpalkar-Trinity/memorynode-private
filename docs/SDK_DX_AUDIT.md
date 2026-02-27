# @memorynodeai/sdk — Developer Experience Audit

**Date:** 2026-02-28  
**Scope:** `packages/sdk` (v0.1.1) — constructor ergonomics, method naming, type safety, error handling, response shape consistency.  
**Constraint:** Suggestions must not break existing API for a minor/patch release unless explicitly labeled **BREAKING**.

**Implemented in this branch:** Error parsing fix (API `{ error: { code, message } }`), `MemoryNodeApiError` class, re-export of `ApiError`, and fail-fast for missing API key (with `/healthz` allowed without key). Tests added for error parsing and fail-fast.

---

## 1. Constructor ergonomics

**Current:** `new MemoryNodeClient(options?: MemoryNodeClientOptions)` with `baseUrl?: string`, `apiKey?: string`. Both optional; default baseUrl is `http://127.0.0.1:8787`.

**Strengths:**
- Single options object keeps constructor stable as new options are added.
- Sensible default for local development.
- Supports admin-only flows where every call passes `adminToken` (no apiKey needed).

**Friction:**
- Users can construct with no `apiKey` and call `addMemory()` / `search()` etc.; the request is sent without `Authorization` and fails with 401. No early validation or clear message.
- No convenience overload (e.g. `new MemoryNodeClient(apiKey: string)`) for the common case.

**Suggestions (non-breaking):**
- **Fail-fast:** In `request()`, when the call does not pass `adminToken` and `this.apiKey` is missing, throw a clear error (e.g. `MemoryNodeError` with code `MISSING_API_KEY`) before sending the request.
- **Docs:** In README/quickstart, show the minimal production setup: `baseUrl: "https://api.memorynode.ai"` and `apiKey: process.env.API_KEY`, and mention that omitting `apiKey` is only valid when using admin endpoints with `adminToken` per call.

**BREAKING (do not do in 0.1.x):**
- Requiring `apiKey` in the constructor would break admin-only usage.

---

## 2. Method naming clarity

**Current:** `addMemory`, `search`, `context`, `listMemories`, `getMemory`, `deleteMemory`, `exportMemories`, `exportMemoriesZip`, `importMemories`, `health`, `getUsageToday`, and admin: `createWorkspace`, `createApiKey`, `listApiKeys`, `revokeApiKey`.

**Assessment:** Naming is consistent and clear. Verb-first for actions (`add`, `search`, `list`, `get`, `delete`, `export`, `import`, `create`, `revoke`). No confusing abbreviations.

**Suggestions (non-breaking):**
- None required. Optional: add JSDoc one-liners for `health()` and `getUsageToday()` so they appear in IDE hover (e.g. “Check API health” and “Get today’s usage and limits for the current key”).

---

## 3. Type safety

**Strengths:**
- All request/response types come from `@memorynodeai/shared`; SDK uses them correctly.
- `SearchOptions` and `ListMemoriesOptions` are SDK-specific, camelCase, and map cleanly to wire format.
- `AddMemoryRequest` is passed through; optional fields (`memory_type`, `extract`) are handled explicitly in the body.

**Friction:**
- `ApiError` and response types are not re-exported from the SDK. Consumers must import from `@memorynodeai/shared` to type errors or responses.
- Thrown value is `ApiError & Error` (via `Object.assign(new Error(...), apiError)`), but there is no exported class or type guard, so users cannot safely narrow (e.g. `if (e instanceof MemoryNodeApiError)` or `if (isMemoryNodeError(e))`).

**Suggestions (non-breaking):**
- **Re-export** from SDK: `ApiError`, and optionally `SearchResult`, `MemoryRecord`, and other commonly used response shapes from `@memorynodeai/shared`, so a single import from `@memorynodeai/sdk` is enough for typical usage.
- **Add** a `MemoryNodeApiError` class that extends `Error` and has `code`, `message`, `status`. Throw this instead of a plain `Error`; it remains `instanceof Error`. Export it and document it so users can do `catch (e) { if (e instanceof MemoryNodeApiError) { ... e.code, e.status } }`.
- **Optional:** Export a type guard `isMemoryNodeApiError(e: unknown): e is MemoryNodeApiError` (or `ApiError & Error`).

---

## 4. Error handling

**Current:** All non-2xx responses throw. The SDK parses JSON and builds an object with `code`, `message`, `status` and assigns it onto `new Error(message)`.

**Critical bug (fix in 0.1.2):**  
The API returns errors in the shape `{ error: { code: string, message: string } }`. The SDK currently treats the response body as if it were flat (`parsed.code`, `parsed.message`). So `parsed.code` and `parsed.message` are undefined, and the thrown error always gets `code: "HTTP_ERROR"` and `message: response.statusText` (e.g. “Unauthorized”), losing the actual API `code` and `message`. This should be fixed by reading `body.error?.code`, `body.error?.message`, and using `response.status` for `status`.

**Suggestions (non-breaking after fixing the above):**
- Parse API error shape: `const body = await response.json(); const err = body?.error; code = err?.code ?? "HTTP_ERROR"; message = err?.message ?? response.statusText; status = response.status`.
- Export `ApiError` and/or `MemoryNodeApiError` and document recommended catch pattern in README.
- Optionally include `response.headers` or retry hints on the error object if the API adds them later (non-breaking addition).

---

## 5. Response shape consistency

**Current:** Request options use **camelCase** (e.g. `userId`, `pageSize`, `memoryType`). Response types from shared (and thus the API) use **snake_case** (e.g. `memory_id`, `user_id`, `created_at`, `has_more`). The SDK does not transform responses; it returns the API shape.

**Assessment:** Consistent within itself (all responses snake_case). Asymmetry (camel in, snake out) is a common DX complaint but is acceptable for 0.1.x if documented.

**Suggestions (non-breaking):**
- **Document** in README that responses match the API and use snake_case (e.g. `memory_id`, `chunk_id`), and point to shared types or API docs for full shapes.
- **BREAKING (reserve for 0.2.0 or 1.0.0):** Option or default to camelCasing response keys (e.g. `memoryId`, `userId`) for a more JavaScript-idiomatic experience; would require a new option or a major if made the default.

---

## 6. Other improvements (non-breaking)

- **importMemories:** Accept `Uint8Array` or `ArrayBuffer` in addition to base64 string; encode to base64 inside the SDK. Overload: `importMemories(artifact: string | Uint8Array | ArrayBuffer, mode?: ImportRequest["mode"])`. Reduces friction for binary-first callers.
- **README:** Add a short “Error handling” section showing catch + `code`/`message`/`status` and, once available, `MemoryNodeApiError` / `isMemoryNodeApiError`.
- **JSDoc:** Add `@throws` for methods that use the API key (e.g. “Throws when the API returns an error or when the API key is missing and no admin token is provided”).

---

## 7. Summary table

| Area                 | Score (1–10) | Notes                                                                 |
|----------------------|-------------|-----------------------------------------------------------------------|
| Constructor ergonomics | 6          | Flexible but easy to misconfigure; add fail-fast and docs.           |
| Method naming        | 9           | Clear and consistent.                                                 |
| Type safety          | 7           | Good use of shared types; missing re-exports and error type guard.   |
| Error handling       | 4           | Bug: API error shape not parsed; error type not exported.             |
| Response consistency | 7           | Consistent snake_case; document; camelCase is a future enhancement.  |

**Overall DX score: 6.5 / 10** — Solid base and naming, but error handling (parsing + typability) and constructor clarity hold it back. Fixing the error parsing and exporting error types would bring this to ~7.5 without breaking changes.

---

## 8. Suggested changes (ordered)

### Must fix (patch/minor)

1. **Fix error parsing** — Read `response.json()` as `{ error?: { code?, message? } }` and set `code`, `message`, `status` on the thrown error. Non-breaking; correct behavior.
2. **Re-export `ApiError`** from the SDK (from shared). Non-breaking.
3. **Fail-fast when API key is missing** — In `request()`, if `!init.adminToken && !this.apiKey`, throw a clear error (e.g. code `MISSING_API_KEY`) before `fetch`. Non-breaking for correct usage; only affects misconfigured clients.

### Should do (minor)

4. **Introduce and throw `MemoryNodeApiError`** (extends `Error`, has `code`, `message`, `status`). Export it. Non-breaking; thrown object remains `instanceof Error`.
5. **Re-export commonly used types** from shared (e.g. `SearchResult`, `MemoryRecord`, `AddMemoryRequest`) so one import from `@memorynodeai/sdk` suffices. Non-breaking.
6. **README:** Add “Error handling” and “Response shape (snake_case)” and production setup note. Non-breaking.

### Nice to have (minor)

7. **JSDoc** for `health()`, `getUsageToday()`, and `@throws` where relevant. Non-breaking.
8. **importMemories** overload accepting `Uint8Array | ArrayBuffer` and encoding to base64 internally. Non-breaking.

### Breaking (do not ship in 0.1.x)

- Requiring `apiKey` in the constructor.
- Changing response shape to camelCase by default (reserve for 0.2.0+).
- Changing or removing any existing method signature or option name.

---

## 9. Version recommendation

- **Release as 0.1.2** with:
  - Error parsing fix (API `{ error: { code, message } }`).
  - Re-export of `ApiError` and optional `MemoryNodeApiError` + fail-fast.
  - Re-exports of shared types and README/JSDoc updates as above.

All of the suggested improvements above are backward-compatible. No intentional breaking changes are recommended for this release.

- **Use 0.2.0** only if you later introduce a breaking change (e.g. camelCase responses by default, or changing/removing a public method or option). For the current set of suggestions, **0.1.2** is appropriate.

---

**Conclusion:** Implement the must-fix and should-do items, then release **0.1.2**. Reserve breaking or response-shape changes for **0.2.0** or **1.0.0**.
