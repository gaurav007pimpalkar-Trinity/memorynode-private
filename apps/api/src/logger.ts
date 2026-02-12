type LogPrimitive = string | number | boolean | null;
type LogValue = LogPrimitive | LogValue[] | { [key: string]: LogValue };

const REDACTED_VALUE = "***REDACTED***";

const SECRET_KEYS = [
  "authorization",
  "x-api-key",
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "private_key",
  "master_admin_token",
  "openai_api_key",
  "supabase_service_role_key",
  "payu_merchant_key",
  "payu_merchant_salt",
  "payu_webhook_secret",
];

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\brk_[A-Za-z0-9_-]{8,}\b/g,
  /\bwhsec_[A-Za-z0-9_-]{8,}\b/g,
  /\bmn_live_[A-Za-z0-9_-]{10,}\b/g,
  /\bmn_a[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/\-=]{8,}\b/gi,
];

function isSecretKey(keyHint?: string): boolean {
  if (!keyHint) return false;
  const lowered = keyHint.toLowerCase();
  return SECRET_KEYS.some((k) => lowered.includes(k));
}

function hasSecretPattern(value: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
}

function redactString(value: string, keyHint?: string): string {
  if (isSecretKey(keyHint) || hasSecretPattern(value)) {
    return REDACTED_VALUE;
  }
  return value;
}

export function redact(value: unknown, keyHint?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value, keyHint);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const redacted: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(obj)) {
      if (isSecretKey(key)) {
        redacted[key] = REDACTED_VALUE;
      } else {
        redacted[key] = redact(inner, key);
      }
    }
    return redacted;
  }

  return REDACTED_VALUE;
}

function normalizeError(err: unknown): { name?: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: String(redact(err.message, "message") ?? "Unknown error"),
      ...(err.stack ? { stack: String(redact(err.stack, "stack")) } : {}),
    };
  }
  if (typeof err === "string") {
    return { message: String(redact(err, "message") ?? "Unknown error") };
  }
  try {
    return { message: JSON.stringify(redact(err)) };
  } catch {
    return { message: "Unknown error" };
  }
}

function emit(level: "info" | "error", payload: Record<string, unknown>): void {
  const safePayload = redact(payload) as LogValue;
  const line = JSON.stringify(safePayload);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

type InfoPayload = {
  event: string;
  request_id?: string | null;
  [key: string]: unknown;
};

type ErrorPayload = {
  event: string;
  request_id?: string | null;
  err?: unknown;
  [key: string]: unknown;
};

export const logger = {
  info(payload: InfoPayload): void {
    const { event, ...fields } = payload;
    emit("info", {
      level: "info",
      ts: new Date().toISOString(),
      event_name: event,
      ...fields,
    });
  },
  error(payload: ErrorPayload): void {
    const { event, err, ...fields } = payload;
    emit("error", {
      level: "error",
      ts: new Date().toISOString(),
      event_name: event,
      ...fields,
      ...(err !== undefined ? { error: normalizeError(err) } : {}),
    });
  },
};
