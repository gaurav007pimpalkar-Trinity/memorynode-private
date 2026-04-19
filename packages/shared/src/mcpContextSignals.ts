export type RecallStrength = "weak" | "medium" | "strong";

function normalize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((x) => x.length > 1);
}

function pairSimilarity(a: string, b: string): number {
  const ta = new Set(normalize(a));
  const tb = new Set(normalize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const token of ta) {
    if (tb.has(token)) hit += 1;
  }
  const union = ta.size + tb.size - hit;
  return union <= 0 ? 0 : hit / union;
}

function redundancyPenalty(memoryTexts: string[]): number {
  if (memoryTexts.length < 2) return 0;
  let pairs = 0;
  let sum = 0;
  for (let i = 0; i < memoryTexts.length; i++) {
    for (let j = i + 1; j < memoryTexts.length; j++) {
      pairs += 1;
      sum += pairSimilarity(memoryTexts[i], memoryTexts[j]);
    }
  }
  if (pairs === 0) return 0;
  return Math.min(1, Math.max(0, sum / pairs));
}

export function deriveContextSignals(args: {
  topScore: number;
  secondScore: number;
  sourceCount: number;
  totalSourceCount?: number;
  memoryTexts?: string[];
  truncated: boolean;
}): {
  confidence: number;
  source_count: number;
  truncated: boolean;
  recall_strength: RecallStrength;
  diversity_score: number;
  redundancy_penalty: number;
  integrity_score: number;
} {
  const baseConfidence = Math.min(1, Math.max(0, args.topScore / 0.08));
  const scoreGap = Math.max(0, args.topScore - args.secondScore);
  const totalSourceCount = Math.max(args.sourceCount, args.totalSourceCount ?? args.sourceCount);
  const diversityScore = totalSourceCount <= 0 ? 0 : Math.min(1, Math.max(0, args.sourceCount / totalSourceCount));
  const redundancy = redundancyPenalty(args.memoryTexts ?? []);
  const integrityScore = Math.min(1, Math.max(0, diversityScore * (1 - redundancy * 0.7)));
  const confidence = Math.min(1, Math.max(0, baseConfidence * (0.5 + integrityScore * 0.5)));
  let recallStrength: RecallStrength = "weak";
  if (confidence >= 0.75 && scoreGap >= 0.1) recallStrength = "strong";
  else if (confidence >= 0.4) recallStrength = "medium";
  if (integrityScore < 0.35) recallStrength = "weak";
  else if (integrityScore < 0.55 && recallStrength === "strong") recallStrength = "medium";
  return {
    confidence,
    source_count: Math.max(0, args.sourceCount),
    truncated: args.truncated,
    recall_strength: recallStrength,
    diversity_score: diversityScore,
    redundancy_penalty: redundancy,
    integrity_score: integrityScore,
  };
}
