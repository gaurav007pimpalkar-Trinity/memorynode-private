const apiBaseFromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined;
const API_BASE_URL = apiBaseFromEnv ?? "http://127.0.0.1:8787";
const KEY_STORAGE = "mn_api_key";
export const apiEnvError = !apiBaseFromEnv ? "Missing VITE_API_BASE_URL" : null;

export function saveApiKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}

export function loadApiKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? "";
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

type ApiError = { error: { code: string; message: string } };

export class ApiClientError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, API_BASE_URL).toString(), init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = (json as ApiError | null)?.error;
    throw new ApiClientError(res.status, err?.code, err?.message ?? `Request failed: ${res.status}`);
  }
  return (json as T) ?? ({} as T);
}

export async function apiPost<T>(path: string, body: unknown = {}, apiKey: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

export async function apiGet<T>(path: string, apiKey: string): Promise<T> {
  return fetchJson<T>(path, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
  });
}
