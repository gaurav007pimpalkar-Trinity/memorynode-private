import type { MemoryType } from "../contracts/index.js";

export type PriorityTier = "cold" | "warm" | "hot" | "critical";
export type ConflictState = "none" | "candidate" | "resolved" | "superseded";

export interface IntelligenceScoreInput {
  text: string;
  memoryType?: MemoryType;
  importance?: number;
  extractionConfidence?: number;
  sourceWeight?: number;
  noveltyScore?: number;
}

export interface IntelligenceScoreResult {
  confidence: number;
  sourceWeight: number;
  priorityScore: number;
  priorityTier: PriorityTier;
  shouldAutoPin: boolean;
}

const MEMORY_TYPE_BASE_PRIORITY: Record<MemoryType, number> = {
  fact: 0.65,
  preference: 0.7,
  event: 0.55,
  note: 0.4,
  task: 0.68,
  correction: 0.8,
  pin: 0.9,
  summary: 0.72,
};

export function normalizeTextForMemoryKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function semanticFingerprintFromText(text: string): string {
  const normalized = normalizeTextForMemoryKey(text).replace(/[^\w\s]/g, "");
  const tokens = normalized.split(" ").filter((t) => t.length > 2).slice(0, 24);
  return `v1:${tokens.join("|")}`;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

export function estimateNoveltyScore(text: string, recentNormalizedTexts: string[]): number {
  const key = normalizeTextForMemoryKey(text);
  if (!key) return 0;
  if (recentNormalizedTexts.includes(key)) return 0;

  const tokens = new Set(key.split(" ").filter(Boolean));
  if (tokens.size === 0) return 0.1;
  let bestOverlap = 0;
  for (const prev of recentNormalizedTexts) {
    const prevTokens = new Set(prev.split(" ").filter(Boolean));
    let overlap = 0;
    for (const token of tokens) {
      if (prevTokens.has(token)) overlap++;
    }
    const denom = Math.max(tokens.size + prevTokens.size - overlap, 1);
    const jaccard = overlap / denom;
    if (jaccard > bestOverlap) bestOverlap = jaccard;
  }
  return clamp01(1 - bestOverlap);
}

export function deriveSourceWeight(metadata?: Record<string, unknown>): number {
  const raw = metadata?.source_weight;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0.25, Math.min(2, raw));
  }
  const source = typeof metadata?.source === "string" ? metadata.source.toLowerCase() : "";
  if (source.includes("system") || source.includes("webhook")) return 1.2;
  if (source.includes("import")) return 0.9;
  if (source.includes("agent")) return 1.05;
  return 1;
}

export function deriveConfidence(input: {
  text: string;
  memoryType?: MemoryType;
  extractionConfidence?: number;
  metadata?: Record<string, unknown>;
}): number {
  const explicit = input.metadata?.confidence;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return clamp01(explicit);
  }
  const baseByType = input.memoryType ? MEMORY_TYPE_BASE_PRIORITY[input.memoryType] ?? 0.45 : 0.45;
  const textLenBoost = Math.min(input.text.trim().length / 220, 0.2);
  const extraction = typeof input.extractionConfidence === "number" ? clamp01(input.extractionConfidence) : 0.5;
  return clamp01(baseByType * 0.45 + extraction * 0.4 + textLenBoost * 0.15);
}

export function priorityTierFromScore(priorityScore: number): PriorityTier {
  if (priorityScore >= 0.85) return "critical";
  if (priorityScore >= 0.67) return "hot";
  if (priorityScore >= 0.45) return "warm";
  return "cold";
}

export function computeIntelligenceScore(input: IntelligenceScoreInput): IntelligenceScoreResult {
  const memoryType = input.memoryType ?? "note";
  const confidence = deriveConfidence({
    text: input.text,
    memoryType,
    extractionConfidence: input.extractionConfidence,
  });
  const sourceWeight = Math.max(0.25, Math.min(2, input.sourceWeight ?? 1));
  const noveltyScore = clamp01(input.noveltyScore ?? 0.5);
  const importance = Math.max(0.01, Math.min(100, input.importance ?? 1));
  const importanceScore = clamp01(Math.log10(importance + 1));
  const typeBase = MEMORY_TYPE_BASE_PRIORITY[memoryType] ?? 0.45;
  const priorityScore = clamp01(
    typeBase * 0.4
      + confidence * 0.25
      + noveltyScore * 0.15
      + importanceScore * 0.1
      + clamp01((sourceWeight - 0.25) / 1.75) * 0.1,
  );
  const priorityTier = priorityTierFromScore(priorityScore);
  const shouldAutoPin = (priorityTier === "critical" || priorityScore >= 0.82) && confidence >= 0.62;
  return {
    confidence,
    sourceWeight,
    priorityScore,
    priorityTier,
    shouldAutoPin,
  };
}

export interface ExtractedCandidate {
  text: string;
  memory_type: MemoryType;
  confidence?: number;
}

function looksLikePreference(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(i|user)\s+(like|love|prefer|hate|dislike|always|never)\b/.test(t);
}

function looksLikeEvent(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(yesterday|today|tomorrow|last|next|visited|met|attended|shipped|deployed)\b/.test(t);
}

export function deterministicExtractFallback(text: string): ExtractedCandidate[] {
  const lines = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
  const out: ExtractedCandidate[] = [];
  for (const line of lines) {
    let memory_type: MemoryType = "fact";
    if (looksLikePreference(line)) memory_type = "preference";
    else if (looksLikeEvent(line)) memory_type = "event";
    out.push({
      text: line,
      memory_type,
      confidence: memory_type === "fact" ? 0.55 : 0.65,
    });
    if (out.length >= 8) break;
  }
  return out;
}

export function normalizeExtractedCandidates(items: unknown[]): ExtractedCandidate[] {
  const validTypes: MemoryType[] = ["fact", "preference", "event", "note", "task", "correction", "pin", "summary"];
  const out: ExtractedCandidate[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const text = typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text.trim()
      : "";
    if (text.length < 8) continue;
    const memoryTypeRaw = (item as { memory_type?: unknown }).memory_type;
    const memory_type = typeof memoryTypeRaw === "string" && validTypes.includes(memoryTypeRaw as MemoryType)
      ? (memoryTypeRaw as MemoryType)
      : (looksLikePreference(text) ? "preference" : (looksLikeEvent(text) ? "event" : "fact"));
    const confidenceRaw = (item as { confidence?: unknown }).confidence;
    const confidence = typeof confidenceRaw === "number" ? clamp01(confidenceRaw) : undefined;
    out.push({ text, memory_type, ...(confidence !== undefined ? { confidence } : {}) });
    if (out.length >= 10) break;
  }
  return out;
}
