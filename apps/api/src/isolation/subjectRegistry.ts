import { createHash } from "node:crypto";

export type IsolationSubjectType = "user" | "agent" | "thread" | "session" | "app";

export interface SubjectRecord {
  subjectId: string;
  subjectType: IsolationSubjectType;
  subjectKey: string;
}

const subjectCache = new Map<string, SubjectRecord>();

function normalizeSubjectType(subjectType: string): IsolationSubjectType {
  const normalized = subjectType.trim().toLowerCase();
  if (normalized === "agent") return "agent";
  if (normalized === "thread") return "thread";
  if (normalized === "session") return "session";
  if (normalized === "app") return "app";
  return "user";
}

function normalizeSubjectKey(subjectKey: string): string {
  const trimmed = subjectKey.trim();
  if (!trimmed) return "default";
  return trimmed;
}

function makeCacheKey(subjectType: IsolationSubjectType, subjectKey: string): string {
  return `${subjectType}:${subjectKey}`;
}

function stableSubjectId(subjectType: IsolationSubjectType, subjectKey: string): string {
  const digest = createHash("sha256").update(`${subjectType}|${subjectKey}`).digest("hex");
  return digest.slice(0, 26);
}

/**
 * Registry contract: returns stable subject ids and enforces uniqueness on (subjectType, subjectKey).
 * In this worker implementation, determinism provides uniqueness and stability without external state.
 */
export function getOrCreateSubject(subjectType: string, subjectKey: string): SubjectRecord {
  const normalizedType = normalizeSubjectType(subjectType);
  const normalizedKey = normalizeSubjectKey(subjectKey);
  const cacheKey = makeCacheKey(normalizedType, normalizedKey);
  const existing = subjectCache.get(cacheKey);
  if (existing) return existing;

  const created: SubjectRecord = {
    subjectId: stableSubjectId(normalizedType, normalizedKey),
    subjectType: normalizedType,
    subjectKey: normalizedKey,
  };
  subjectCache.set(cacheKey, created);
  return created;
}

