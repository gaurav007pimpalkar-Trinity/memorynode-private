import type { MergedBlock } from "../handlers/context.js";

export interface BudgetedBlock extends MergedBlock {
  estimated_tokens: number;
  value_density: number;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function budgetContextBlocks(
  blocks: MergedBlock[],
  args: {
    maxTokens: number;
    fallbackScore?: number;
    confidence?: number;
    priorityScore?: number;
  },
): BudgetedBlock[] {
  const maxTokens = Math.max(64, args.maxTokens);
  const fallbackScore = clamp(args.fallbackScore ?? 0.6, 0, 1);
  const confidence = clamp(args.confidence ?? 0.6, 0, 1);
  const priorityScore = clamp(args.priorityScore ?? 0.6, 0, 1);

  const scored = blocks.map((block, idx) => {
    const estimated_tokens = estimateTokens(block.text);
    const baselineRelevance = clamp(fallbackScore - idx * 0.03, 0.05, 1);
    const value = baselineRelevance * 0.6 + confidence * 0.2 + priorityScore * 0.2;
    return {
      ...block,
      estimated_tokens,
      value_density: value / estimated_tokens,
    };
  });

  scored.sort((a, b) => b.value_density - a.value_density);

  const out: BudgetedBlock[] = [];
  let used = 0;
  for (const block of scored) {
    if (used + block.estimated_tokens > maxTokens) continue;
    out.push(block);
    used += block.estimated_tokens;
    if (used >= maxTokens) break;
  }

  out.sort((a, b) => {
    const ai = blocks.findIndex((v) => v.chunk_ids[0] === a.chunk_ids[0]);
    const bi = blocks.findIndex((v) => v.chunk_ids[0] === b.chunk_ids[0]);
    return ai - bi;
  });

  return out;
}

export function applyCostAwareRetrievalCap(args: {
  requestedTopK?: number;
  requestedPageSize?: number;
  budgetPressure?: number;
}): { topK?: number; pageSize?: number } {
  const pressure = clamp(args.budgetPressure ?? 0, 0, 1);
  if (pressure <= 0.01) {
    return {
      topK: args.requestedTopK,
      pageSize: args.requestedPageSize,
    };
  }
  const ratio = clamp(1 - pressure * 0.5, 0.45, 1);
  const topK = args.requestedTopK != null ? Math.max(1, Math.floor(args.requestedTopK * ratio)) : undefined;
  const pageSize = args.requestedPageSize != null ? Math.max(1, Math.floor(args.requestedPageSize * ratio)) : undefined;
  return { topK, pageSize };
}
