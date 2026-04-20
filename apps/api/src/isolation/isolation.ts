import { createHash } from "node:crypto";
import { getOrCreateSubject, type IsolationSubjectType } from "./subjectRegistry.js";

export const SHARED_APP_USER_ID = "shared_app";
export const SHARED_SCOPE = "shared";

export type IsolationRoutingMode =
  | "derived"
  | "explicit"
  | "scoped_key"
  | "shared_default"
  | "fallback_derived";

export interface IsolationInput {
  userId?: string | null;
  user_id?: string | null;
  scope?: string | null;
  namespace?: string | null;
  containerTag?: string | null;
}

export interface IsolationOptions {
  scopedContainerTag?: string | null;
}

export interface ResolvedIsolation {
  ownerId: string;
  scope: string;
  subjectType: IsolationSubjectType;
  containerTag: string;
  routingMode: IsolationRoutingMode;
  scopeOverridden: boolean;
  conflictDetected: boolean;
  fallbackUsed: boolean;
  explanation: string;
}

function normalizeText(raw: unknown, fallback = ""): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeScope(raw: unknown): string {
  const normalized = normalizeText(raw, "default")
    .slice(0, 96)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

function shortType(subjectType: IsolationSubjectType): string {
  if (subjectType === "user") return "u";
  if (subjectType === "agent") return "a";
  if (subjectType === "thread") return "t";
  if (subjectType === "session") return "s";
  return "app";
}

function compactHash(input: string, length = 20): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

/**
 * Stable internal identifier format:
 * st:<subjectType>|sid:<stableSubjectIdHash>|sc:<scope>
 * Subject id comes from subject registry, decoupling storage key from mutable user-facing ids.
 */
export function buildTag(input: {
  subjectId: string;
  subjectType: IsolationSubjectType;
  scope: string;
}): string {
  const st = shortType(input.subjectType);
  const sid = compactHash(input.subjectId, 20);
  const sc = normalizeScope(input.scope);
  return `st:${st}|sid:${sid}|sc:${sc}`;
}

function fallbackTag(subjectType: IsolationSubjectType, subjectKey: string, scope: string): string {
  const st = shortType(subjectType);
  const sid = compactHash(`${subjectType}|${subjectKey}|${scope}`, 20);
  const sc = normalizeScope(scope);
  return `fb:${st}|sid:${sid}|sc:${sc}`;
}

export function resolveIsolation(input: IsolationInput, options: IsolationOptions = {}): ResolvedIsolation {
  const explicitContainerTag = normalizeText(input.containerTag, "");
  const requestedUserId = normalizeText(input.userId ?? input.user_id, "");
  const scope = normalizeScope(input.scope ?? input.namespace ?? "default");
  const scopedContainerTag = normalizeText(options.scopedContainerTag, "");

  const subjectType: IsolationSubjectType = requestedUserId ? "user" : "app";
  const ownerId = requestedUserId || SHARED_APP_USER_ID;

  if (scopedContainerTag) {
    return {
      ownerId,
      scope,
      subjectType,
      containerTag: scopedContainerTag,
      routingMode: "scoped_key",
      scopeOverridden: Boolean(explicitContainerTag && explicitContainerTag !== scopedContainerTag),
      conflictDetected: Boolean(explicitContainerTag && explicitContainerTag !== scopedContainerTag),
      fallbackUsed: false,
      explanation: "Scoped API key enforced container routing.",
    };
  }

  if (explicitContainerTag) {
    return {
      ownerId,
      scope,
      subjectType,
      containerTag: explicitContainerTag,
      routingMode: "explicit",
      scopeOverridden: false,
      conflictDetected: Boolean(requestedUserId),
      fallbackUsed: false,
      explanation: "Explicit containerTag override was applied.",
    };
  }

  if (!requestedUserId) {
    return {
      ownerId: SHARED_APP_USER_ID,
      scope: SHARED_SCOPE,
      subjectType: "app",
      containerTag: "st:app|sid:shared_app|sc:shared",
      routingMode: "shared_default",
      scopeOverridden: false,
      conflictDetected: false,
      fallbackUsed: false,
      explanation: "Missing userId routes to shared app bucket.",
    };
  }

  try {
    const subject = getOrCreateSubject(subjectType, requestedUserId);
    return {
      ownerId,
      scope,
      subjectType,
      containerTag: buildTag({
        subjectId: subject.subjectId,
        subjectType: subject.subjectType,
        scope,
      }),
      routingMode: "derived",
      scopeOverridden: false,
      conflictDetected: false,
      fallbackUsed: false,
      explanation: "Using userId + scope to derive stable isolation key.",
    };
  } catch {
    return {
      ownerId,
      scope,
      subjectType,
      containerTag: fallbackTag(subjectType, requestedUserId, scope),
      routingMode: "fallback_derived",
      scopeOverridden: false,
      conflictDetected: false,
      fallbackUsed: true,
      explanation: "Registry unavailable; deterministic fallback routing applied.",
    };
  }
}

